// `verify-mat`：清单 == 差异集 · 物化树 == 清单 · `materialize-precision`。
// 出处：架构 § 8.5 的第二条验证性质 · "失败处理" · § 8.15 的指标口径 · § 9.6 物化行的出账。
//
// 三样东西，各有各的来源，这是这条命令的全部要点：
//
//   **清单**　从 `M0` 的 `mat/*` 事件重放（`manifest.ts`）——它是**物化器自己的说法**。
//   **差异集**　把视图的上层逐条与 base 比内容与 mode（§ 8.5："base 与视图之间内容不同的路径"）
//              ——它**不经过物化器**，是从真源那一侧算出来的。
//   **落地集**　从盘上的落地根枚举出来（`overlayfs` 档就是 `find upper`，§ 8.5 那句"枚举而非
//              diff"）——它**不经过日志**，是从文件系统这一侧读出来的。
//
// 三个来源两两独立，所以"两两相等"不是自己跟自己比：值钱的是**它们不相等**的时候。
//
// **差异集的候选集是"视图的上层"，不是整棵树。** 依据是视图的构造：一个路径上的内容 = 上层
// 有它就取上层，没有就取 base（§ 8.3）。于是"视图与 base 不同"只可能发生在上层有入口的那些
// 路径上——一次子树删除在上层留的是一条墓碑（`d`），底下的孩子**不进集合**：它们在视图的路径
// 空间里已经不存在了，而一条墓碑就是"这儿没有了"的完整表达（overlay 那一条 whiteout 也正好是
// 一个路径上的一个条目）。这也让这条命令是 O(改动数)，不是 O(树)。
//
// **为什么分子取盘、分母取内容。** § 8.15 的 `materialize-precision` 是"物化触碰文件数 / 实际
// 变更文件数"。分母要按**内容**算（base 与视图之间），不能按账本算——按账本算的话两边同源，
// 比值恒等于 1，抓不住"重写整棵树"这类失效（§ 8.5）。分子取盘：`upper` 里多出来的一条就会
// 出现在"只有落地有"那一栏里。
//
// **它只读，而且不修。** § 8.5 把 `diff-stat` 与 `verify-mat` 并列写成只读，失败处理那一句
// 是"删除重建，不尝试修复"——修不是这条命令的事，它只把不等报出来。
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Log } from '../log/events.ts'
import type { Roots } from '../roots/contract.ts'
import type { AbsPath, AgentId, CommitId, ForkStrategy, RelPath, ViewRev } from '../terms.ts'
import { diskEntry, hashOfState, portEntry, sameEntry } from './land.ts'
import type { EntryState, ViewReads } from './land.ts'
import { manifestPayload, matState } from './manifest.ts'

/** 视图的上层那一条，**只有读**。与 `M2` 的 `SnapEntry` 结构上相容，但不是它的第二份定义。 */
export type UpperRow =
  | { readonly path: RelPath; readonly kind: 'file' | 'symlink' }
  | { readonly path: RelPath; readonly kind: 'tombstone' }

/** 物化那一侧的读口：`ViewReads` 加上"我自己的上层有哪几条"。 */
export interface MatViewReads extends ViewReads {
  upper(): readonly UpperRow[]
}

export class VerifyRefused extends Error {
  readonly why: string

  constructor(why: string) {
    super(why)
    this.name = 'VerifyRefused'
    this.why = why
  }
}

export interface VerifyDeps {
  readonly roots: Roots
  readonly log: Log
  /** 视图，**载到清单那个 rev 为止**——物化树对应的是那一刻。 */
  readonly view: MatViewReads
  /** 底那一侧：`mat/fork` 记的那个提交（`mat/fork.base`）。**不是视图此刻的 base**：那个随提交前移。 */
  readonly base: ViewReads
}

/** 一边的读数：路径与内容哈希（`''` = 这条路径在视图里没有了）。 */
export interface Side {
  readonly paths: readonly RelPath[]
  readonly hashes: readonly string[]
}

export interface VerifyResult {
  readonly agent: AgentId
  readonly rev: ViewRev
  readonly base: CommitId
  readonly strategy: ForkStrategy
  readonly manifest: Side
  readonly diff: Side
  readonly landed: Side
  /** 清单有、差异集没有。 */
  readonly onlyManifest: readonly RelPath[]
  /** 差异集有、清单没有。 */
  readonly onlyDiff: readonly RelPath[]
  /** 落地根有、清单没有（`upper` 里多出来的一条，含"与底其实一样"的陈条）。 */
  readonly onlyLanded: readonly RelPath[]
  /** 清单有、落地根没有。 */
  readonly missing: readonly RelPath[]
  /** 两边都有、内容对不上。 */
  readonly mismatch: readonly RelPath[]
  /** 落地集 / 差异集。差异集为空时是 `null`（分母是 0，比值没有意义）。 */
  readonly precision: number | null
  /** 三样两两相等，一个不差。 */
  readonly ok: boolean
  readonly ms: number
}

const sideOf = (m: ReadonlyMap<RelPath, string>): Side => manifestPayload(m)

/** 落地根里的叶子（`overlayfs` 档的 `upper`）：普通文件 · 软链 · whiteout。**白名单之外的不算**。 */
function landRootLeaves(upper: AbsPath): Map<RelPath, string> {
  const out = new Map<RelPath, string>()
  const walk = (rel: RelPath): void => {
    for (const name of readdirSync(rel === '' ? upper : join(upper, rel))) {
      const child = rel === '' ? name : `${rel}/${name}`
      if (lstatSync(join(upper, child)).isDirectory()) walk(child)
      else out.set(child, hashOfState(diskEntry(join(upper, child), child)))
    }
  }
  walk('')
  return out
}

export async function verifyMat(deps: VerifyDeps, agent: AgentId): Promise<VerifyResult> {
  const started = performance.now()
  const st = await matState(deps.log, agent)
  if (!st.forked || st.base === null || st.strategy === null) {
    throw new VerifyRefused(
      '这个 agent 还没铺过物化树：没有清单可以核\n先 fugue fork <base> 铺一棵（§ 8.5 的调用点：执行前 · 合并验收 · 冲突解决）。',
    )
  }
  const overlay = st.strategy === 'overlayfs'
  const upper = deps.roots.scratchRoot(agent)
  const merged = deps.roots.mergedRoot(agent)
  const manifest = new Map<RelPath, string>()
  st.paths.forEach((p, i) => manifest.set(p, st.hashes[i] ?? ''))

  // 一 · 差异集：视图的上层逐条与 base 比。**base 那一侧是 `mat/fork` 记的那个提交。**
  const diff = new Map<RelPath, string>()
  for (const row of deps.view.upper()) {
    const v = await portEntry(deps.view, row.path)
    const b = await portEntry(deps.base, row.path)
    if (!sameEntry(v, b)) diff.set(row.path, hashOfState(v))
  }

  // 二 · 落地集：盘上那一侧。
  const landed = new Map<RelPath, string>()
  if (overlay) {
    for (const [p, h] of landRootLeaves(upper)) landed.set(p, h)
  } else {
    // 另两档没有独立的落地根（`merged` 本身就是那份树，`upper` 是空的），所以候选只有清单那些
    // 路径——判据仍是**盘上那条与 base 比**：与 base 一样的说明这一条其实没落地。
    for (const p of manifest.keys()) {
      const d = diskEntry(join(merged, p), p)
      const b = await portEntry(deps.base, p)
      if (!sameEntry(d, b)) landed.set(p, hashOfState(d))
    }
  }

  const onlyManifest = [...manifest.keys()].filter((p) => !diff.has(p)).sort()
  const onlyDiff = [...diff.keys()].filter((p) => !manifest.has(p)).sort()
  const onlyLanded = [...landed.keys()].filter((p) => !manifest.has(p)).sort()
  const missing = [...manifest.keys()].filter((p) => !landed.has(p)).sort()
  const mismatch = [...manifest.keys()]
    .filter((p) => landed.has(p) && landed.get(p) !== manifest.get(p))
    .sort()
  const precision = diff.size === 0 ? null : landed.size / diff.size
  const ok =
    onlyManifest.length === 0 &&
    onlyDiff.length === 0 &&
    onlyLanded.length === 0 &&
    missing.length === 0 &&
    mismatch.length === 0

  return {
    agent,
    rev: st.rev,
    base: st.base,
    strategy: st.strategy,
    manifest: sideOf(manifest),
    diff: sideOf(diff),
    landed: sideOf(landed),
    onlyManifest,
    onlyDiff,
    onlyLanded,
    missing,
    mismatch,
    precision,
    ok,
    ms: Math.round(performance.now() - started),
  }
}

/** 落地根里那一条此刻的样子（`--json` 与测试要看，读盘不猜）。 */
export function entryAt(root: AbsPath, rel: RelPath): EntryState | null {
  return diskEntry(join(root, rel), rel)
}
