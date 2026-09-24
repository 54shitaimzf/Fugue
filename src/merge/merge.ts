// M13 合并：逐路折叠与冲突环。出处：架构 § 8.14 的 1–3 步 · § 8.2 硬约束 4（`mergeTree` 只吃两个
// base，多于两个由调用方逐路折叠）· § 8.2 的"非零一律不给 tree"（那棵有毒的树在类型上取不到）·
// § 8.12 那张值域持有者表的最后两行（`base` 归 `M1` · `conflictPaths` 归 `M13`）·
// PLAN § 5.7 的 A5 行。
//
// **折叠的形状由站前读数（A0 的第三节）定死**：`merge-tree --write-tree` 的入参是**两个提交**，
// 三个 base 直接退 129，而它**不建提交**。所以 N 路折叠是：
//
//   折一次 → 拿到一棵树 → **落一个提交**（不然下一折没有 base 可指）→ 拿那个提交当下一折的入参
//
// 拿那棵树直接当 base 会被 `git merge-tree` 拒（A0 的读数里量过）。于是折叠的每一步都会在对象
// 库里留下一个提交——**这是这一站唯一一处"为了能继续而落的提交"**，它们的父是折过的两路，不
// 挂在任何 ref 上（悬空对象）。`Collecting` 的 gc 屏障要不要顺手收它们，落地在这份代码上再定。
//
// **冲突环的四步**（架构 § 8.14 的第 2 步）：冲突 → 物化冲突树 → `resolve` 契约 → 回收 → 回到折叠。
// 这一份做的是"物化冲突树"与"拿 `resolve` 契约接着折"这两件；`resolve` 契约的**构造**归 `M11`
// （A1 的 `build`），回收归 `M6`（S4 已交付的 `reclaim`），调用点把它们串起来。
//
// **冲突那一支的判据是退出码，不是"拿到了 tree"。** `merge-tree` 冲突时照样写出一棵带冲突标记的
// 树，而 `Truth.mergeTree` 的返回类型让它在类型上取不到（§ 8.2）——这一份因此**没有一条路**能把
// 那棵有毒的树当成合并结果用下去。
import type { Conflict } from '../truth/contract.ts'
import type { Truth } from '../truth/contract.ts'
import type { BlobId, CommitId, RelPath, TreeId } from '../terms.ts'
import type { TreeEntry } from '../entries.ts'

/** 这一层自己的失败：折叠表不成立 · `resolve` 契约与实际冲突集对不上 · 解决后的树没变。 */
export class MergeError extends Error {}

/** 折一次的结果。**冲突那一边没有 tree**——这是 § 8.2 那句话在类型上的样子。 */
export type FoldStep =
  | { readonly ok: true; readonly tree: TreeId; readonly commit: CommitId }
  | { readonly ok: false; readonly conflicts: readonly Conflict[] }

/**
 * 冲突树的物化：**冲突的三个 stage 各取一份字节**，拼成一份给人和模型看的正文。
 *
 * 形状是 `<<<<<<< 底` / `=======` / `>>>>>>> 这一路`，与 git 自己那套一样——理由不是好看：
 * 解决冲突的人（或模型）要能一眼分出三段，而"第 1 段是底、第 2 段是一路、第 3 段是另一路"
 * 这个次序是 `git merge-tree` 的输出次序（`ConflictStage.stage` 就是它）。
 *
 * **它只物化字面量，不做判断。** 谁与谁冲突 · 该留哪一段，是解决者的事；这一份的产出就是
 * 那三段原文拼起来的东西。
 */
export interface ConflictMaterial {
  readonly path: RelPath
  /** 三段各自的内容（`stage` 1 · 2 · 3；缺哪一段就是空串）。 */
  readonly stages: readonly { readonly stage: 1 | 2 | 3; readonly bytes: Uint8Array }[]
  /** 拼好的正文：给人看的、也进视图的那一份。 */
  readonly body: Uint8Array
}

function textOf(bytes: Uint8Array | null): string {
  if (bytes === null) return ''
  return new TextDecoder().decode(bytes)
}

/** 把一份冲突拼成带标记的正文。**次序照 `stage`**，不重排。 */
export function materializeConflict(c: Conflict, stageBytes: readonly (Uint8Array | null)[]): ConflictMaterial {
  const stages = c.stages.map((s, i) => ({ stage: s.stage, bytes: stageBytes[i] ?? new Uint8Array() }))
  const parts: string[] = []
  const at = (stage: 1 | 2 | 3): string => textOf(stages.find((s) => s.stage === stage)?.bytes ?? null)
  parts.push(`<<<<<<< ${c.path}（底）`)
  parts.push(at(1))
  parts.push('=======')
  parts.push(at(2))
  parts.push('>>>>>>> 这一路')
  if (c.stages.some((s) => s.stage === 3)) {
    parts.push('=======')
    parts.push(at(3))
    parts.push('>>>>>>> 另一路')
  }
  return { path: c.path, stages, body: new TextEncoder().encode(parts.join('\n')) }
}

/** 一次折叠的中间状态。**冲突不是失败**——它是折叠停下来的那个位置（架构 § 8.14 第 2 步）。 */
export type FoldOutcome =
  | {
      readonly kind: 'folded'
      /** 折完之后的那个提交。 */
      readonly commit: CommitId
      readonly tree: TreeId
      /** 折了几次（N 条分支折 N−1 次）。 */
      readonly steps: number
    }
  | {
      readonly kind: 'conflict'
      /** 折到这一步停下来的那个提交（已经折好的那几路）。 */
      readonly folded: CommitId
      /** 还没折进去的那几路。 */
      readonly rest: readonly CommitId[]
      readonly conflicts: readonly Conflict[]
      readonly attempts: number
    }

export interface FoldDeps {
  readonly truth: Truth
  /** 落中间提交时用的信息。**它是折叠的记账，不是叙事**——所以由调用方给（走查里带轮次号）。 */
  readonly msgOf?: (step: number) => string
  /**
   * 折了一次之后的记账口：**`merge/attempt` 那一条事件在这里落下**（架构 § 8.1 的
   * `merge/attempt { round, branches, conflicts }`）。
   *
   * **为什么不写在 `fold` 自己里**：这一份不认识日志（它的入参里没有 `Log`），而"折了几次 ·
   * 撞了几条路径"是这个函数唯一知道的两件事——交给调用点，它一处就能把事件落全。
   * `conflicts` 数的是**路径条数**（架构 § 8.1 的 `conflicts: number`），A8 的打回读数读的就是它。
   */
  readonly onAttempt?: (a: { readonly step: number; readonly branches: readonly CommitId[]; readonly conflicts: number }) => Promise<void> | void
}

/**
 * 逐路折叠：`commits[0]` 是起点，其余每一路折一次。
 *
 * **第一步不是"折"**：一条分支的情况（`commits.length === 1`）折 0 次，结果就是它本身。
 * 这就是 PLAN § 5.7 说的地板第一档——"两条分支直合"是 N=2 时表长为 1 的那个特例，
 * **走的是同一条代码路径**，不是另写一遍。
 */
export async function fold(deps: FoldDeps, commits: readonly CommitId[]): Promise<FoldOutcome> {
  if (commits.length === 0) throw new MergeError('折叠表是空的：一路都没有，没有可折的东西')
  let acc = commits[0]
  let steps = 0
  let attempts = 0
  for (let i = 1; i < commits.length; i++) {
    attempts++
    const merged = await deps.truth.mergeTree([acc, commits[i]])
    if ('conflicts' in merged) {
      await deps.onAttempt?.({ step: i, branches: [acc, commits[i]], conflicts: conflictCount(merged.conflicts) })
      return { kind: 'conflict', folded: acc, rest: commits.slice(i), conflicts: merged.conflicts, attempts }
    }
    await deps.onAttempt?.({ step: i, branches: [acc, commits[i]], conflicts: 0 })
    // **落一个提交**：`merge-tree` 不建提交，而下一折的入参必须是提交（A0 第三节的读数）。
    const msg = deps.msgOf?.(i) ?? `fold step ${i}`
    acc = await deps.truth.commit(merged.tree, [acc, commits[i]], msg)
    steps++
  }
  const tree = await treeOfCommit(deps.truth, acc)
  return { kind: 'folded', commit: acc, tree, steps }
}

/** 一个提交的 tree id。**只此一处**：折叠与验收都要问"这个提交的树是什么"。 */
export async function treeOfCommit(truth: Truth, commit: CommitId): Promise<TreeId> {
  // `Truth` 没有"给我这个提交的 tree"那一条（§ 8.2 的签名里没有），所以从根列一遍再问。
  // 这不是绕路：`statAt` 对目录给的就是那个目录的对象标识，而根目录永远存在（空树也在）。
  const root = await truth.statAt(commit, '')
  if (root === null || root.kind !== 'dir') {
    throw new MergeError(`这个提交的根不是一个目录（${commit}）：${root === null ? '根不存在' : root.kind}`)
  }
  return root.id as TreeId
}

/**
 * 把一份 `resolve` 的产出接着折完。
 *
 * `resolved` 是解决者在**冲突树**上改完之后落的那个提交（它就是这个函数要折进去的那一路），
 * `outcome` 是上一次折叠停下来的位置。**折进去之前先核一件事**：`resolve` 契约的
 * `conflictPaths` 必须与实际冲突集**恰好相等**——解决错文件比冲突更贵（架构 § 8.14 第 3 步的
 * 那一条）。解决了别的文件、或漏了一个，都在这里当场拒。
 */
export async function refold(
  deps: FoldDeps,
  outcome: Extract<FoldOutcome, { kind: 'conflict' }>,
  resolved: CommitId,
  declaredPaths: readonly RelPath[],
): Promise<FoldOutcome> {
  const actual = [...new Set(outcome.conflicts.map((c) => c.path))].sort()
  const declared = [...new Set(declaredPaths)].sort()
  if (actual.join('\n') !== declared.join('\n')) {
    const missing = actual.filter((p) => !declared.includes(p))
    const extra = declared.filter((p) => !actual.includes(p))
    throw new MergeError(
      `resolve 契约的 conflictPaths 与实际冲突集对不上——解决错文件比冲突更贵（架构 § 8.14 第 3 步）\n` +
        `  实际冲突：${actual.join(' · ') || '（一条都没有）'}\n` +
        `  契约声明：${declared.join(' · ') || '（一条都没有）'}\n` +
        (missing.length > 0 ? `  漏了：${missing.join(' · ')}\n` : '') +
        (extra.length > 0 ? `  多报了：${extra.join(' · ')}\n` : ''),
    )
  }
  return fold(deps, [outcome.folded, resolved, ...outcome.rest])
}

/**
 * 把冲突树物化到一棵树里：**冲突的每一条路径**在 `base` 那棵树上被换成拼好的正文。
 *
 * 它是 § 8.14 第 2 步里"物化冲突树"那一步的**值**那一半：给出一份 `TreeEntry[]`，调用方拿它
 * `putTree` + `commit`（或 `M6` 的回收把它落进视图）。这一份不落盘、不建提交——那是调用点的事。
 */
export async function conflictTreeEntries(
  truth: Truth,
  base: CommitId,
  conflicts: readonly Conflict[],
): Promise<{ readonly entries: readonly TreeEntry[]; readonly materials: readonly ConflictMaterial[] }> {
  const materials: ConflictMaterial[] = []
  for (const c of conflicts) {
    // 冲突的 `ConflictStage.id` 本身就是对象标识——**它已经是一份字节的指针**，不必再去哪棵树里找。
    const stageBytes = await Promise.all(c.stages.map((s) => truth.getBlob(s.id as BlobId)))
    materials.push(materializeConflict(c, stageBytes))
  }
  const bodies = new Map<RelPath, Uint8Array>()
  for (const m of materials) bodies.set(m.path, m.body)
  const entries = await flatEntries(truth, base)
  const out: TreeEntry[] = []
  for (const e of entries) {
    const body = bodies.get(e.name)
    if (body === undefined) {
      out.push(e)
      continue
    }
    const id = await truth.putBlob(body)
    out.push({ name: e.name, mode: 0o100644, id })
    bodies.delete(e.name)
  }
  // 冲突路径在 `base` 那棵树上不存在（两边各自新建了同一个文件）时，上面那一圈补不上它。
  for (const [path, body] of bodies) {
    const id = await truth.putBlob(body)
    out.push({ name: path, mode: 0o100644, id })
  }
  return { entries: out, materials }
}

/** 一棵树摊平成 `TreeEntry[]`（`putTree` 收的就是这个形状，`entries.ts` 的文件头写了为什么）。 */
async function flatEntries(truth: Truth, commit: CommitId): Promise<TreeEntry[]> {
  const out: TreeEntry[] = []
  const walk = async (dir: RelPath): Promise<void> => {
    for (const e of await truth.listAt(commit, dir)) {
      const p = dir === '' ? e.name : `${dir}/${e.name}`
      if (e.kind === 'dir') await walk(p)
      else out.push({ name: p, mode: e.mode, id: e.id })
    }
  }
  await walk('')
  return out
}

/**
 * 冲突路径集：`merge/attempt` 的 `conflicts` 那一栏数的是**路径条数**，不是 stage 条数
 * （架构 § 8.1：`conflicts: number`）。这一处把它算出来——A8 的打回读数读的就是它。
 */
export function conflictCount(conflicts: readonly Conflict[]): number {
  return new Set(conflicts.map((c) => c.path)).size
}
