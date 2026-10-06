// 工具的那道缝的产品实现：**视图 + 围栏 + 真源**接成一份 `ToolHost`。出处：架构 § 8.9 那四条
// 推论各自的落点（`M4.ensure` · `M3.Roots.resolveVirtual` · `M7.confine` · `M6` 反向通道）·
// § 8.10 的工具目录 · § 9.6（`checkpoint` 与 `fugue commit` 是同一个操作）。
//
// **为什么这一份住在 `src/tools/` 而不是住在命令行里**：工具面的实现只该有一处。"围栏怎么过 ·
// 写落成哪种 delta · 提交走哪条路"这三件事在命令行那一面已经有过一次（`fugue write` ·
// `fugue commit`），模型侧那一面照抄一遍就是第二处——两处漂移的表现是"同一次写，模型与人得到
// 两个结果"，而那不报错。`checkpoint.ts` 顶部那条理由逐字适用于这里。
//
// **它不认识模型、不认识线协议。** 上一层的接线归 `capability/dispatch.ts`。
import { spawn } from 'node:child_process'
import type { Log } from '../log/events.ts'
import type { Truth } from '../truth/contract.ts'
import type { TreeEntry } from '../entries.ts'
import { normMode } from '../delta.ts'
import type { Delta } from '../delta.ts'
import type { AgentId, BlobId, CommitId, RelPath, ViewRev, WriterId } from '../terms.ts'
import type { Denied as FenceDenied, Roots } from '../roots/contract.ts'
import { applyEdit } from '../view/edit.ts'
import { snapshotOf } from '../view/snapshot.ts'
import type { View } from '../view/contract.ts'
import { checkpoint } from '../checkpoint.ts'
import type { RunReply } from './execute.ts'
import type { ActionAsk, AskItem, DenyAsk, EditRaw, PlanAsk, RunAsk, TodoItem, ToolHost, ToolListing } from './execute.ts'
import { refuse } from './execute.ts'
import { shellArgv } from './argv.ts'
// **清单缓存**：`walk()` 的实现与它的键（视图代）都住这一份，宿主只接线（见 `walk-cache.ts`）。
import { createWalk, walkRowsOf } from './walk-cache.ts'
// **查询接线那一份计划**（本站）：按模式收窄这一趟要读的路径。它住在 `src/search/`，不进冻结面。
import { createPlanner } from '../search/plan.ts'
import type { Planner } from '../search/plan.ts'
// **构建触发器**（本站的缺省档那一半）：盘上没有工件就按闸建一份，建不建 · 建哪一档 · 为什么没建
// 全在那一份里。这一层只决定"接不接上"（HostOptions.indexBuild 那一栏）。
import { createTrigger } from '../search/trigger.ts'
import { digestOf } from '../runtime/restart.ts'
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ForkStrategy } from '../terms.ts'
import type { ForkResult } from '../materialize/fork.ts'
import { ensure } from '../materialize/ensure.ts'
import type { EnsureResult } from '../materialize/ensure.ts'
import { matState } from '../materialize/manifest.ts'
import { statOrNull } from '../materialize/diffstat.ts'
import type { MatState } from '../materialize/manifest.ts'
import type { RefHead } from '../round/head.ts'
import { isMounted, unmountOverlay } from '../materialize/mount.ts'
import { matParts } from '../roots/paths.ts'
import { lowerAt } from '../view/lower.ts'
import type { Reclaim, DeclaredSet } from '../execute/reclaim.ts'
import type { AbsPath } from '../terms.ts'

/** 走多远就停。**两条都是必须的**：软链穿过去就绕开了路径围栏（§ 8.4 的 `through-symlink`），
 * 而不封顶的深树能把一步走成挂死。 */
const MAX_DEPTH = 24
const MAX_ROWS = 5000

/** 落日志与提交要的那一半（读与写视图那一半在 `view` 里）。 */
export interface HostActions {
  readonly writer: WriterId
  readonly log: Log
  readonly truth: Truth
  /**
   * **这一格的 ref 此刻在哪儿**（`round/head.ts` 的 `RefHead`）。
   *
   * 它同时是这次提交的 parent 与 CAS 的期望（`checkpoint.ts` 的 `expectedOld` 那一栏）。
   * **以前这里是写死的 `View.base`**：模型一格之内调两次 `checkpoint`，第二次就撞 CAS
   * （PLAN § 5.16）——所以它换成这一格的缓存，而缓存的来源是这一格自己的日志重放。
   * 提交成功之后由这一份自己同步（`head.commit`），与收尾的 `commitView` 读的是同一份。
   */
  readonly head: RefHead
}

/**
 * 一次执行要的那三样：命令行 · cwd · **子进程的环境**。`env` 不给 = 继承宿主那份（P1a 起
 * round 那一路由调用方交一份 `envFor()` 的产物进来——宿主环境从此不整份进沙箱）。
 */
export interface CommandPlan {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
}

export interface HostOptions {
  /**
   * 起一个进程要什么：命令行 · cwd · 环境 · 超时。**怎么关起来归调用方**（`M7` 包命令行 · `M5` 起进程）。
   *
   * 可以返回一个承诺：包命令行那一步要读这一格的策略值（那一层在不在场），而策略值现探。
   */
  readonly commandFor?: (ask: RunAsk) => CommandPlan | Promise<CommandPlan>
  /**
   * 一个具名动作怎么跑（P3b1 归真）：**动作名 → 命令行 · cwd · 环境**，与 `commandFor` 对
   * `bash` 的关系同一形状——宿主不认识配置与策略，解析归调用方（`round/driver.ts` 那一份
   * `readBinding` + `envFor` + `confine`）。`extra` 是模型追加到绑定 argv 尾上的那几个参数。
   *
   * 名字没绑 → 实现抛 `BindingError`（那一句自带 actions 键的指路），宿主把它降成被拒的回执。
   * **没接这一层的宿主拒并指路，不降级成"把名字当命令跑"**——那正是这一格删掉的半接线。
   */
  readonly actionFor?: (ask: ActionAsk) => CommandPlan | Promise<CommandPlan>
  /** 没有它这一份宿主只能读：写与提交会改视图，而视图的每一次变更都要落日志（§ 9.3 的顺序）。 */
  readonly actions?: HostActions
  /**
   * **工件那一档**（本站的缺省翻转）：缺省是**开**——查询路按需把工件建出来（`trigger.ts` 那条闸与
   * 它的账），于是缺省运行模式下查询自己按档派发（稀疏与未命中走索引 · 密集走扫描早停），
   * 不要求显式打开。
   *
   * 给 `false` 就是今天的形态：**查询路只消费、不生产**——盘上没有工件就回扫描（显式口
   * `openOrRebuild` 照旧在）。那是对照与退化用的口："索引在场与缺席"那两态、地板那一档，以及
   * 本就量纯扫描的那些夹具与基准脚本。
   */
  readonly indexBuild?: boolean
  /**
   * **这一格的写入面**（架构 § 8.9 那条反向通道的声明集）。W8 起它是**契约的写入面**
   * （`contract/types.ts` 的 `declaredSetOf`），由调用点递进来——不开新配置面。
   *
   * 给了它，执行类工具跑完就把声明集内的差异从物化根读回视图（`collect`），并把集外的改动
   * 记一条 `mat/reclaim`。**没给就是“这条反向通道没接上”**：`bash` 跑得起来，产出却留在物化树里不进视图。
   */
  readonly ownedPaths?: readonly RelPath[]
  /**
   * 回收那一份（`M6`）。**由调用点装配**：它要的减数（清单 · 落点 · 树敞开与否）都是
   * 这一格的机制事实，而宿主不该知道怎么探它们。
   */
  readonly reclaim?: Reclaim
  /**
   * **在哪一棵树上执行**（执行面）。不给就没有物化：执行类工具跑在 `roots.toReal('')` 上——
   * 那是 W8 之前的形状，夹具与单测照旧走它。
   */
  readonly execRoot?: {
    readonly log: Log
    /** 这一格是哪个 writer（视图与物化都按它索引）。 */
    readonly writer: WriterId
    /** `base` 那一份的读口：`ensure` 要拿它当 delta 的下层（`mat/fork.base`）。 */
    readonly truth: Truth
    readonly base: CommitId | null
    readonly forkOf: (parts: { upper: AbsPath; merged: AbsPath; temp: AbsPath }) => Promise<ForkResult>
    /** 每次问答完执行面之后的那一下（**给调用点记账用**）。 */
    readonly onState?: (r: { readonly root: string; readonly strategy: ForkStrategy | null }) => void
    /**
     * **把"命令跑完之后那棵树上还有没有这一条路径"这条读口交出去**（回写那一支的删除判据
     * 要它）。
     *
     * **它交出去的是一份快照，不是一个活的问句**：`merged` 挂着的时候它就是命令跑完之后那棵
     * 树的全貌，而 `afterRun()` 的第一件事就是卸载——卸载之后那里只剩一个空挂载点，
     * `existsSync` 一律为假，删除那一支于是把整棵声明树报成 `delete`（本地实测撞到过）。
     * 所以宿主先把声明的那几棵子树**枚举成一份集合**，再把"查集合"这件事交出去。
     */
    readonly onTreeNow?: (probe: (rel: RelPath) => Promise<boolean>) => void
    /**
     * **这一趟落下去的清单**（`ensure` 的 `manifest`），每次同步之后交出去。
     *
     * 回收那一侧要它当减数：`upper` 里本来就有东西（`ensure` 把视图的 delta
     * 落在那儿），“子进程改了什么”只能是“枚举到的 − 清单里的”（架构 § 8.7）。
     * 少这一减，第二趟运行会把上一趟的产出当成越声明（**本地实测撞到过**）。
     */
    readonly onSync?: (manifest: readonly RelPath[]) => void
  }
}

/**
 * `actions.truth` 上那道"一次批量把这几条 blob 取回来"的缝，**有才用**。
 *
 * 判据是运行时那一问：真源那一层是 `TruthHandle` 时它有 `prefetchBlobs`，而**冻结的 `Truth`
 * 契约（架构 § 8.2）一个字不动**——加方法只落在句柄层（先例 `stats()`/`close()`）。夹具里那些
 * 不带这一栏的假体在这里拿到 `undefined`，预取于是缺席，grep 退回逐文件读。
 */
function prefetchOf(truth: Truth | undefined): ((ids: readonly BlobId[]) => Promise<void>) | undefined {
  const fn = (truth as unknown as { prefetchBlobs?: unknown } | undefined)?.prefetchBlobs
  if (typeof fn !== 'function') return undefined
  return (ids) => (fn as (ids: readonly BlobId[]) => Promise<void>).call(truth, ids)
}

/**
 * **一趟预取最多先取回多少字节 = 缓存容量的一半**（人批的定稿规格）。
 *
 * 为什么是一半：预取的字节回来之后要**留在**缓存里等到真被读——`BlobLru` 是按字节封顶的 LRU，
 * 装不下的从最旧那一头挤掉。一趟预取要是能取满整个容量，它自己就能把缓存转一圈：先取的那几条
 * 在真被读之前就被自己挤走，取回来等于白取（0.3.1 那张账在 1 MiB 那一档上量到的负收益）。
 * 留一半给这一趟真在读的那几份与下一批，挤占就不会发生在本趟自己身上。
 *
 * **代价是覆盖不全**：一趟只覆盖到预算满为止，这一窗剩下的路径交给按需读那一趟（那就是“预取
 * 缺席”那条地板，只是慢），下一窗重新起一批。容量 0 在这里就是预算 0 = 一条都不取。
 */
export function prefetchBudgetOf(cacheBytes: number): number {
  return Math.floor(cacheBytes / 2)
}

/**
 * 真源那一层的取字节口（构建触发器要它：**索引不自己存原文**）。冻结的 `Truth` 契约一个字不动
 * ——`getBlob` 本来就是它的一栏。没接真源（夹具档与单测里那几份宿主）就是 `undefined`：
 * 触发器据此不建，查询照旧扫描（机制缺席只是慢，不是坏掉）。
 */
function blobReaderOf(truth: Truth | undefined): ((id: BlobId) => Promise<Uint8Array>) | undefined {
  if (truth === undefined) return undefined
  return (id) => truth.getBlob(id)
}

/**
 * 真源那一层报的 blob 缓存容量。**冻结的 `Truth` 契约一个字不动**：`stats()` 与 `prefetchBlobs`
 * 一样只落在句柄层（`TruthHandle`），所以这里与 `prefetchOf` 同一形状地探一次。
 *
 * 问不到容量那一档预算就是 0（这一趟不预取）：两栏都在句柄层，夹具里那几份假体都没有；
 * **不猜一个容量出来**——猜大了会挤占，猜小了白付结构化开销，而少预取只是慢。
 */
function cacheBytesOf(truth: Truth | undefined): number {
  const stats = (truth as unknown as { stats?: unknown } | undefined)?.stats
  if (typeof stats !== 'function') return 0
  const got = (stats as () => { readonly blobCacheBytes?: unknown }).call(truth) as { readonly blobCacheBytes?: unknown }
  const bytes = got?.blobCacheBytes
  return typeof bytes === 'number' && bytes >= 0 ? bytes : 0
}

/**
 * 一份 `ToolHost`。
 *
 * `view` 是读与写的唯一去处（写走 `view/edit.ts` 那一份：blob → 日志 → 内存，顺序在那儿）；
 * `roots` 只用来过围栏——**它不拼物理路径**：这一档里文件的字节住在视图的上层，不在物化出来的
 * 那棵树上（`B6` 把"执行前物化"接上时，`bash` 那一条才真的落在树里）。
 */
/**
 * 装配起来的那一份宿主：冻结的 `ToolHost` ＋ **句柄层多出来的那一栏**。
 *
 * `searchPlan` 是查询接线的落点：按模式给出"这一趟可能命中的路径"，`tools/execute.ts` 那一趟
 * 读它、照它跳过不可能命中的文件（答案照旧在原卷上逐行验出来，索引只指路）。**它不是
 * `ToolHost` 的一栏**——那张面冻结着；加方法只落在句柄层、由 `execute.ts` 运行时探一次，与
 * `truth.prefetchBlobs` · `stats()` 同一条先例（本文件 `prefetchOf` 就是那么探的）。
 */
export interface WiredToolHost extends ToolHost {
  readonly searchPlan: Planner
}

export function createToolHost(view: View, roots: Roots, opts: HostOptions = {}): WiredToolHost {
  const parts = opts.actions

  async function deny(d: DenyAsk): Promise<void> {
    // 没有日志口就不记（夹具档与单测里那几份宿主就是这样）——但**有口就一定要记**：
    // "模型看见它为什么不行"与"日志里有一次拒"是同一件事的两个面，不该只发生一半。
    if (parts === undefined) return
    await parts.log.append(parts.writer, {
      t: 'bound/deny',
      agent: view.id,
      path: d.path,
      space: d.space,
      rule: d.rule,
    })
  }

  /** 过一道围栏。**这是 `M3` 的 `resolveVirtual` 被工具面调到的唯一一处**（架构 § 8.4）。 */
  async function fence(
    raw: string,
    cwd: string,
  ): Promise<{ readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string }> {
    const got = roots.resolveVirtual(raw, cwd as RelPath)
    if (got.ok) return { ok: true, value: got.value }
    const d: FenceDenied = got.error
    await deny(refuse(`fence:${d.kind}`, d.message, d.raw, 'virtual'))
    return { ok: false, message: d.message }
  }

  /** 一次变更落下去（`view/edit.ts` 那一份：blob → 日志 → 内存。校验在追加之前，在那儿）。 */
  async function change(d: Delta): Promise<{ readonly rev: number; readonly changed: boolean }> {
    if (parts === undefined) {
      throw new Error(
        '这一份宿主没有接上日志：写会改视图，而视图的每一次变更都要先落日志（架构 § 9.3 的顺序）——请给 options.actions。',
      )
    }
    const r = await applyEdit({ view, truth: parts.truth, log: parts.log, writer: parts.writer }, d)
    return { rev: r.rev, changed: r.changed }
  }

  async function writeBytesOf(rel: string, bytes: Uint8Array): Promise<{ readonly rev: number }> {
    const path = rel as RelPath
    // 新增还是改写**只有视图答得对**（`View.kindOf`：只看上层——下层会随 base 前移而变）。
    const kind = view.kindOf(path)
    const d: Delta =
      kind === 'add'
        ? { kind: 'add', path, bytes, mode: normMode(0o100644) }
        : { kind: 'modify', path, bytes, mode: normMode(0o100644) }
    const r = await change(d)
    return { rev: r.rev }
  }

  async function readBytesOf(rel: string): Promise<{ readonly bytes: Uint8Array; readonly mode: number } | null> {
    const path = rel as RelPath
    const meta = await view.stat(path)
    // 只读文件：目录与软链不给字节（给出去的必须是"那个文件的字节"，不是它的形状）。
    if (meta === null || meta.kind !== 'file') return null
    const bytes = await view.read(path)
    if (bytes === null) return null
    return { bytes, mode: normMode(meta.mode) }
  }


  /**
   * **把这几条路径的内容先取回一层来**（这一站加的）。id 从 `view.stat` 拿（`EntryMeta.id` 就是

   * 那个 blob）——info 小表热了之后这一步是内存操作，一次收集、一次批量。
   *
   * **没有真源（夹具档）就是缺席**：这里直接返回，grep 退回逐文件读。
   */
  async function prefetchNow(paths: readonly string[]): Promise<void> {
    const blobs = prefetchOf(opts.actions?.truth)
    if (blobs === undefined) return
    // **这一趟先取多少字节是由缓存容量算出来的**（`prefetchBudgetOf`），不是由这一窗有多少条算出来的。
    const budget = prefetchBudgetOf(cacheBytesOf(opts.actions?.truth))
    const metas = await Promise.all(
      paths.map(async (rel) => {
        try {
          return await view.stat(rel as RelPath)
        } catch {
          // 路径形状不对（或视图那一层不认这一条）——预取是提示，跳过它，读那一侧照旧会报。
          return null
        }
      }),
    )
    const out: BlobId[] = []
    let planned = 0
    for (const meta of metas) {
      const id = meta === null || meta.kind !== 'file' ? undefined : meta.id
      if (id === undefined || id === null || id === '') continue
      // **预算在这儿生效**：加起来过了半个缓存就跳过这一条（跳过而不是停——后面小份的还能进这一批），
      // 剩下的交给读那一趟按需取。
      if (planned + meta.size > budget) continue
      planned += meta.size
      out.push(id as BlobId)
    }
    // 一条都没排上就不发这一趟（容量 0 那条地板也走这里）。
    if (out.length === 0) return
    await blobs(out)
  }

  /**
   * 走一遍树。**走法与它的缓存归 `walk-cache.ts`**，键是这份视图的代（`view.rev`）：同代连发的
   * `glob`/`grep` 不再重走清单，而视图一动（`write` · `rename` · `chmod` · `remove` · 执行回写）
   * 就是新的一代——深度 · 条数 · 软链不跟三条语义逐字照旧（同一份视图缓存前后给出的清单相同）。
   */
  const walk = createWalk(view, { depth: MAX_DEPTH, rows: MAX_ROWS })

  /**
   * 查询接线那一份计划（`src/search/plan.ts`）：索引住 `<root>/.fugue/idx/`，视图那一份 id 与
   * 字节数取自走树缓存——**同一个 `view.list` 的行，不为一次查询再枚举一遍视图**。
   */
  const searchPlan = createPlanner({
    root: roots.realRoot,
    rowsOf: walkRowsOf,
    // **缺省翻转的落点**：`openOrRebuild` 是显式口，这一行把它接到查询路上——"建不建 · 建哪一档 ·
    // 为什么没建"归 `trigger.ts`（一条字节闸 + 一笔账）。`indexBuild: false` 就是今天的形态。
    ensureIndex:
      opts.indexBuild === false
        ? undefined
        : createTrigger({ root: roots.realRoot, readBlob: blobReaderOf(opts.actions?.truth) }),
  })

  // ── 执行面（W8：视图是读面，物化根是执行面）──────────────────────────
  //
  // **账不新开：起跑重放一次，格内只缓存。** 物化那一侧从 `mat/*` 事件重放出 `forked · rev · 清单`
  // （`matState`，“物化读日志、不写日志”）；这一格是唯一的写者，每次自己写完之后同步它。
  // 缓存里的 `rev` 与清单就是“物化落到哪儿了”那一份事实——不是第二处状态。
  let mat: { parts: { upper: AbsPath; merged: AbsPath; temp: AbsPath }; state: MatState } | null = null

  /**

  /**
   * 视图在这一条声明路径下**动过**什么——回写那一支里删除那一条的源一。
   */
  function writtenNow(rel: RelPath): { readonly paths: readonly RelPath[]; readonly dead: ReadonlySet<RelPath> } {
    const out: RelPath[] = []
    const dead = new Set<RelPath>()
    for (const e of view.state().upper) {
      if (e.path !== rel && !e.path.startsWith(rel + '/')) continue
      if (e.kind === 'tombstone') dead.add(e.path)
      else out.push(e.path)
    }
    return { paths: [...out, ...dead].sort(), dead }
  }

  /**
   * **执行面在哪儿**（`ToolHost.execCwd`）。第一次被问到时才 fork——纯 `write`/`read` 的格
   * 不付这份钱；之后每次把视图此刻的 delta 铺过去（rev 没变就是 `noop`）。
   */
  async function execCwd(): Promise<{ readonly root: string; readonly strategy: ForkStrategy | null }> {
    const cfg = opts.execRoot
    if (cfg === undefined) return { root: roots.toReal('' as RelPath), strategy: null }
    const tell = (r: { readonly root: string; readonly strategy: ForkStrategy | null }) => {
      cfg.onState?.(r)
      return r
    }
    if (mat === null) {
      const me = view.id as unknown as AgentId
      const st = await matState(cfg.log, me)
      const where = matParts(roots.realRoot, me)
      mat = { parts: where, state: st }
      if (!st.forked) {
        const r = await cfg.forkOf(where)
        mat.state = { forked: true, base: r.base, strategy: r.strategy, rev: 0, paths: [], hashes: [] }
        return tell({ root: where.merged, strategy: r.strategy })
      }
    }
    // **`now` 就是宿主手里这一份视图，不另开一份。** 原先这里 `loadView` 重放日志另拿一份：
    // 那一份的 `rev` 是"这一格历史上写过几次"（全量重放，与"树铺到哪儿了"无关），而回写那一侧
    // （`afterRun` → `collect` → `applyEdit`）读的是**这一份**。两份视图分家的后果是实测出来的：
    // 同格内 `write tail.txt` → `bash rm tail.txt`，同步点把 `write` 那条 delta 又落回树里
    // （`rm` 留下的白洞被它覆盖），回写报不出删除，收尾提交把模型已经删掉的那一份又交上去
    // ——正是 W8 判据 ④ 说的那条静默错。
    const now = view
    const out = await syncTo(now, view.rev)
    return tell({ root: mat.parts.merged, strategy: out.strategy })
  }

  /** 把视图的 delta 落到物化树（`M4.ensure`），并同步格内那份缓存。 */
  async function syncTo(now: View, upTo: ViewRev): Promise<EnsureResult> {
    const cfg = opts.execRoot
    if (cfg === undefined || mat === null) throw new Error('这一份宿主没有接上执行面：execRoot 没给。')
    const out = await ensure(
      {
        roots,
        log: cfg.log,
        root: roots.realRoot,
        view: {
          stat: (p) => now.stat(p),
          read: (p) => now.read(p),
          // **`rev` 报的是"这份视图此刻在哪个号"**：`ensure` 那一条断言问的就是它
          // （`upTo > deps.view.rev` 拒的是"落一个还不存在的号"，§ 9.6）。delta 的基点不在
          // 这里——`ensure` 拿 `st.rev`（`mat.state.rev`）当基点。
          //
          // **报错过一次**：报成"树已同步到哪"（一个与视图无关的水位）时，刚 fork 的树会把
          // 视图此刻的号判成"还不存在"，整条 `bash` 当场退成被拒的结果（本地探针实测）。
          rev: view.rev,
          deltasSince: (from) => now.diff(from),
          tombstones: () => now.state().upper.filter((e) => e.kind === 'tombstone').map((e) => e.path),
        },
        base: lowerAt(cfg.truth, mat.state.base),
        state: mat.state,
      },
      now.id as unknown as AgentId,
      upTo,
    )
    mat.state = {
      forked: true,
      base: mat.state.base,
      strategy: out.strategy,
      rev: out.to,
      paths: [...out.manifest],
      hashes: [],
    }
    cfg.onSync?.(out.manifest)
    return out
  }

  /**
   * 把一棵子树里的**叶子**收进集合（相对根给路径）。
   *
   * 与上面那个走视图的 `walk()` 不是一件事：这一份读的是**真实的物化树**（`merged`），
   * 只在卸载之前那一小段时间里问得动。深与宽都封顶（同一组常数）：它是探针，不是遍历产品。
   */
  function leavesUnder(abs: string, prefix: RelPath, into: Set<RelPath>, depth: number): void {
    if (depth > MAX_DEPTH || into.size >= MAX_ROWS) return
    let rows: string[]
    try {
      rows = readdirSync(abs)
    } catch {
      return
    }
    for (const name of rows.sort()) {
      if (into.size >= MAX_ROWS) return
      const next = join(abs, name)
      const rel = `${prefix}/${name}` as RelPath
      const st = lstatSync(next, { throwIfNoEntry: false })
      if (st === undefined || st === null) continue
      if (st.isDirectory()) leavesUnder(next, rel, into, depth + 1)
      else into.add(rel)
    }
  }

  /** 子进程的工作目录：**相对 cwd 拼到执行根上**。空串是根。 */
  function execWorkdir(exec: string, cwd: string): string {
    return cwd === '' ? exec : join(exec, cwd)
  }

  /** 旧格（没有物化）那一条路：视图内的路径 → 真实工作区里的落点。 */
  function workdirOf(cwd: string): string {
    return roots.toReal(cwd as RelPath)
  }

  async function runWith(
    ask: RunAsk,
    userArgv: readonly string[],
    cwd: string,
    /** 命令行已由别的路解析好（动作那一条，P3b1）：直接用它，跳过 `commandFor`。 */
    plan?: CommandPlan,
  ): Promise<RunReply> {
    const timeoutMs = ask.timeoutMs
    const exec = (await execCwd()).root
    const t0 = Date.now()
    let made: CommandPlan | undefined = plan
    try {
      if (made === undefined) made = await opts.commandFor?.(ask)
    } catch (err) {
      const why = (err as Error).message
      await afterRun()
      return { exit: 1, ms: Date.now() - t0, denied: true, stdout: '', stderr: why }
    }
    const argv = made?.argv ?? userArgv
    const workdir = opts.execRoot === undefined ? (made?.cwd ?? workdirOf(cwd)) : execWorkdir(exec, cwd)
    let stdout = ''
    let stderr = ''
    let exit = 1
    let timedOut = false
    await new Promise<void>((done) => {
      // **env 给了就用它**（P1a 起 round 那一路交的是 envFor 的产物：基线 + 坐标 + 注入）；
      // 不给（`undefined`）就继承宿主那份——宿主路径上没人交它，行为不变。
      const child = spawn(argv[0] ?? '/bin/sh', argv.slice(1), {
        cwd: workdir,
        env: made?.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let timer: NodeJS.Timeout | null = null
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (s: string) => {
        stdout += s
      })
      child.stderr.on('data', (s: string) => {
        stderr += s
      })
      child.on('error', (e: Error) => {
        stderr += `${e.message}\n`
        done()
      })
      child.on('close', (code: number | null) => {
        exit = code ?? 1
        if (timer !== null) clearTimeout(timer)
        done()
      })
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeoutMs)
      }
    })
    const reply: RunReply = {
      exit,
      ms: Date.now() - t0,
      denied: false,
      stdout,
      stderr: (timedOut ? `超过 ${timeoutMs} 毫秒被掉\n` : '') + stderr,
    }
    await afterRun()
    return reply
  }

  /**
   * 这一格的声明集：`reclaim.declare()` 给的那两栏 + **这一格自己补的两个口**。
   *
   * 补这两个口的地方只有一处（`declaredNow()`，下面那个函数），所以这里把"两栏都给全"写进类型
   * ——`DeclaredSet` 把那两栏写成可选，那是为 `createReclaim().declare()` 那种**裸声明集**留的
   * （`cli/cmd/execute.ts` 那一侧走的就是裸的那一份）。类型写全了，消费点就不必再判"它有没有"
   * ——原先那一判的假支正是 清障批 ④ 撤掉的那一处。
   */
  type FilledDeclaredSet = DeclaredSet & {
    readonly isDeclared: (rel: RelPath) => readonly RelPath[]
    readonly isTombstone: (p: RelPath) => boolean
  }

  /**
   * 这一格的声明集：**跑之前 `declare`，跑完 `collect`**——两个调用，中间的 `ensure` 不管它。
   */
  function declaredNow(): FilledDeclaredSet | null {
    const re = opts.reclaim
    if (re === undefined || opts.ownedPaths === undefined) return null
    const set = re.declare(view.id as unknown as AgentId, opts.ownedPaths)
    return {
      ...set,
      isDeclared: (rel) => writtenNow(rel).paths,
      isTombstone: (p) => view.state().upper.some((e) => e.kind === 'tombstone' && e.path === p),
    }
  }

  /**
   * **执行之后那一下**：把物化树里、声明集内的差异读回视图。
   */
  async function afterRun(): Promise<void> {
    const re = opts.reclaim
    const cfg = opts.execRoot
    const declared = declaredNow()
    if (re === undefined || cfg === undefined || mat === null || declared === null) return
    // **先把"树上还有没有它"这份快照照下来，再卸载**：`merged` 挂着的时候它就是命令跑完之后
    // 那棵树的全貌（底里继承来的与这一趟写下来的都在里面）；卸下来之后它只剩一个空挂载点，
    // 那一刻再问就一律是"不在"了。照的是**声明的那几棵子树**（别处不归这一支管，也没必要走）。
    const inTree = new Set<RelPath>()
    for (const rel of opts.ownedPaths ?? []) {
      const where = join(mat.parts.merged, rel)
      // 同一条口径（`statOrNull`）：声明的那条路径的祖先不是目录时，它就不在。
      const st = statOrNull(where)
      if (st === null) continue
      inTree.add(rel)
      if (st.isDirectory()) leavesUnder(where, rel, inTree, 0)
    }
    cfg.onTreeNow?.(async (rel) => inTree.has(rel))
    if (mat.parts.merged !== '' && isMounted(mat.parts.merged)) unmountOverlay(mat.parts.merged)
    const outside = await re.undeclared(view.id as unknown as AgentId, declared)
    if (outside.length > 0 && parts !== undefined) {
      await parts.log.append(parts.writer, {
        t: 'mat/reclaim',
        agent: view.id,
        declared: [...declared.paths],
        changed: [...outside],
      })
    }
    const deltas = await re.collect(view.id as unknown as AgentId, declared)
    for (const d of deltas) {
      // **已经落过的那一条跳过**：一条 `delete` 只在视图里还**有**它的时候才是一次真的变更。
      //
      // 两种情形都走这一条，而它们都不该再 `applyEdit` 一次：
      //   · **已经是墓碑**（本格的 `bash rm` 已经落过一次）；
      //   · **视图里压根没有它**（先删、随后又在同名路径下建了目录那一类）。
      // 不跳的话，`applyEdit` 会当场报“删除 `<p>`：这个路径不存在”（本地实测撞到的就是它）。
      if (d.kind === 'delete') {
        // **这里原先有一个"没有 `isTombstone` 就自己重算一遍"的兜底**（清障批 ④ 撤了）：
        // `declaredNow()` 是这段里 `declared` 唯一的来源，而它两个口一起给（`FilledDeclaredSet`
        // 就是把这件事写进类型的地方）——所以那一支按构造不可达，它只是把 `:470` 那个 lambda
        // 逐字重算了一遍。留着它的效果是让读的人以为这里有两种声明集。
        if (declared.isTombstone(d.path) || (await view.stat(d.path)) === null) continue
      }
      // 逐条走 `view/edit.ts` 那一份（blob → 日志 → 内存）——与 `write` 工具逐字节同一条路，
      // 所以“后写的赢”是结构，不是断言：最后落在视图里的那一版就是收尾提交的那一版。
      await applyEdit({ view, truth: cfg.truth, log: cfg.log, writer: cfg.writer }, d)
    }
  }
  return {
    readBytes: readBytesOf,
    execCwd,
    writeBytes: writeBytesOf,

    async edit(rel, raw: EditRaw) {
      // **替换按"整串恰好出现一次"判。** 0 次与 2 次都拒（拒的话说清是哪种），因为"猜他想改
      // 哪一处"是静默的错误；公布的 `replace_all` 为真时 2 次就是"每一处都换掉"。架构 § 8.10
      // 只给了 `edit` 这个工具名，没定匹配语义——所以缺省取最保守的那一格。
      //
      // **改名与改权限不在这里**：目录（公布面）从没有过 `to`/`mode`，而公布面 = 绑定面。
      // 那两件事的入口在视图那一层与命令行（`fugue rename` / `fugue chmod`），不经过模型。
      const got = await readBytesOf(rel)
      if (got === null) throw new Error(`视图里没有这个文件：${rel}`)
      const before = Buffer.from(got.bytes).toString('utf8')
      const at = before.indexOf(raw.find)
      if (at === -1) {
        throw new Error(`没有找到要被替换的那段文本（${raw.find.length} 个字符）——用 write 写一整份，或者把 old_string 写成原样的那一段。`)
      }
      if (!raw.all && before.indexOf(raw.find, at + raw.find.length) !== -1) {
        throw new Error(`那段文本在 ${rel} 里出现了不止一次——edit 一次只改一处：把 old_string 写到只匹配那一处，或者给 replace_all。`)
      }
      const after = raw.all
        ? before.split(raw.find).join(raw.replace)
        : before.slice(0, at) + raw.replace + before.slice(at + raw.find.length)
      const r = await writeBytesOf(rel, new Uint8Array(Buffer.from(after, 'utf8')))
      return { rev: r.rev, changed: true }
    },

    async list(dir) {
      const rows = await view.list(dir as RelPath)
      return rows.map(
        (r): ToolListing => ({
          name: r.name,
          kind: r.kind === 'file' ? 'file' : r.kind === 'dir' ? 'dir' : r.kind === 'symlink' ? 'symlink' : 'other',
          size: r.size,
        }),
      )
    },

    walk,
    prefetch: prefetchNow,
    searchPlan,

    async run(ask: RunAsk) {

      return runWith(ask, shellArgv(ask.command), ask.cwd)
    },

    async runAction(ask: ActionAsk) {
      // **归真（P3b1）**：动作名不是 shell 命令。命令行 · cwd · env 由调用方那一层按工作区配置
      // 里的绑定解析（`opts.actionFor`）——`extra` 追加到绑定的 argv 尾上，cwd 用绑定的。
      //
      // **回写与 bash 同一条反向通道**（W8 起；原先这里写着「没接上」——那是过期的话）：`runWith`
      // 尾上的 `afterRun()` 用 `opts.ownedPaths`（格内=契约的写入面）declare→collect→applyEdit，
      // 把物化树里声明集内的差异写回视图。动作声明的 `outputs` 由门上的跨字段检查保证 ⊆
      // ownedPaths，于是产出随契约面回视图、进提交；声明集外的写只报（`mat/reclaim`）不进。
      // 绑定自己的 `outputs`/`cache` 声明集只在 `fugue run` 那一趟直接用（那边还把 cache 绑到
      // per-agent 缓存）；格内不绑 cache——格内增量构建是 TARGETS T15 的事。
      const resolve = opts.actionFor
      if (resolve === undefined) {
        return {
          exit: 1,
          ms: 0,
          denied: true,
          stdout: '',
          stderr:
            '这一份宿主没有接上动作的解析：run_action 要把名字按工作区配置里的绑定解析成命令行' +
            '（P3b1 起，动作名不再当 shell 命令跑）——请给 options.actionFor。',
        }
      }
      const t0 = Date.now()
      let made: CommandPlan
      try {
        made = await resolve(ask)
      } catch (err) {
        await afterRun()
        return { exit: 1, ms: Date.now() - t0, denied: true, stdout: '', stderr: (err as Error).message }
      }
      // 有执行面：workdir 由 `runWith` 拼（执行根 + 绑定的 cwd）；没有执行面（夹具档）就把
      // 绑定的相对 cwd 先翻成真实工作区里的落点——`runWith` 那一格的 `made.cwd` 是原样用的。
      const plan = opts.execRoot === undefined ? { ...made, cwd: workdirOf(made.cwd) } : made
      const asRun: RunAsk = { command: ask.action, cwd: plan.cwd, timeoutMs: null }
      return runWith(asRun, plan.argv, plan.cwd, plan)
    },

    async checkpoint(msg) {
      if (parts === undefined) {
        throw new Error('这一份宿主没有接上日志与真源：提交要落日志（架构 § 9.6）——请给 options.actions。')
      }
      const entries: TreeEntry[] = await snapshotOf(view)
      const r = await checkpoint({
        log: parts.log,
        truth: parts.truth,
        writer: parts.writer,
        entries,
        rev: view.rev,
        msg,
        expectedOld: parts.head.value,
      })
      // **成功之后同步缓存**：这一步之后这一格的 ref 就是这个提交——下一次 `checkpoint`
      // 与收尾的 `commitView` 都按它当 parent 与 CAS 期望（PLAN § 5.16 那条链）。
      // 只有 `checkpoint()` 成功返回才走到这里；撞 CAS 的那一条在里面抛，缓存不动。
      parts.head.commit(r.commit, r.seq)
      return { commit: String(r.commit) }
    },

    async askUser(asks: readonly AskItem[]) {
      if (parts === undefined) return
      const body = JSON.stringify({ questions: asks })
      await parts.log.append(parts.writer, { t: 'holder/ask', agent: view.id, digest: digestOf(body), body })
    },

    async declarePlan(ask: PlanAsk) {
      // 与 `deny` · `setTodos` 同一条规矩：没有日志口就不记，有口就一定记。
      if (parts === undefined) return
      const body = JSON.stringify(ask)
      await parts.log.append(parts.writer, { t: 'holder/plan', agent: view.id, digest: digestOf(body), body })
    },

    async setTodos(list: readonly TodoItem[]) {
      // 与 `deny` 同一条规矩：**没有日志口就不记**（夹具档与单测里那几份宿主），有口就一定记。
      if (parts === undefined) return { count: list.length }
      const body = JSON.stringify({ todos: list })
      await parts.log.append(parts.writer, { t: 'holder/todos', agent: view.id, digest: digestOf(body), body })
      return { count: list.length }
    },

    deny,
  }
}

/** 从 `<root>` 起一份真源与一份日志（模型侧那一面**不经过命令行**的一条路：`B5` 的断言 ⑤ 用它）。 */
export async function openHostParts(
  root: string,
  writer: WriterId,
): Promise<{
  readonly truth: Truth
  readonly log: Log & { readonly close: () => Promise<void> }
  readonly close: () => Promise<void>
}> {
  const { openLog } = await import('../log/log.ts')
  const { openTruth } = await import('../truth/truth.ts')
  const truth = openTruth(root)
  const log = openLog(root, { write: writer, sync: 'each' })
  return {
    truth,
    log,
    close: async () => {
      await log.close()
      await truth.close()
    },
  }
}
