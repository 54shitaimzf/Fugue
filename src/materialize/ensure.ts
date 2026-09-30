// `ensure`：把视图的 delta 落到物化树里，返回合并树。出处：架构 § 8.5 的 `Materializer.ensure` ·
// 那一节"挂载的生命周期" · § 8.1 的 `mat/sync` 事件。
//
// 一次 `ensure` 五步，次序是硬的：
//
//   1. **问清单**（`manifest.ts`）：从日志重放 `mat/*`，拿到 fork 过没有 · 哪一档 · 落到哪个 rev。
//      没 fork 过就拒绝并指路——delta 没有地方落。
//   2. **卸**（overlayfs 档且挂着时）。§ 8.5 的第一条机制约束：挂载期间不得从外部改 `upper`。
//   3. **落**（`land.ts`）：落在 `upper`（overlayfs）或 `merged`（另两档）。**只碰 delta 说到的
//      路径**，没变的一条都不动——承重性质（未变文件的 mtime/inode/内容逐字节不变）就落在这里。
//   4. **挂回**。**"挂载只包围执行"**，所以 delta 落完就把树挂回去；这一步是幂等的（已经挂着就
//      什么都不做），于是"合并树被卸掉了"这一类现场，重跑一条 `fugue ensure` 就补齐——不必先
//      `dispose` 再 `fork`。
//   5. **落 `mat/sync`**：`from` · `to` · 清单全貌 · 耗时。清单是派生数据，不单独持久化
//      （§ 8.5），它只活在这条事件里。
//
// **第 3 步与第 5 步之间失败，日志会落在盘后面**（delta 落了，事件没落）。这是有意选的次序：
// 下一次 `ensure` 会把同一批 delta 再对一遍，盘上已经对的那几条落进 `untouched`，事件补上。
// 反过来（先落事件后落盘）失败的话，日志会声称一批改动已经物化而盘上没有——那是**谎**，
// 而且没有一条路能发现它。
//
// **幂等**（§ 8.5："已最新则空操作"）：目标 rev 就是已经落到的那个，那就不卸不落不写事件，只把
// 挂载态补齐。**往回走不是一条路**（§ 9.6 那张表里没有"回退"），所以 `upTo` 比已落的 rev 小时
// 原样拒绝，不当作"重放一遍"。
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Delta } from '../delta.ts'
import type { Log } from '../log/events.ts'
import type { Roots } from '../roots/contract.ts'
import type { AbsPath, AgentId, ForkStrategy, RelPath, ViewRev } from '../terms.ts'
import { ensureFacts } from './capability.ts'
import type { PlatformFacts } from './capability.ts'
import { DEFAULT_MATERIALIZE } from './contract.ts'
import type { MaterializeOptions } from './contract.ts'
import { landDeltas } from './land.ts'
import type { LandResult, ViewReads } from './land.ts'
import { manifestMap, manifestPayload, matState } from './manifest.ts'
import type { MatState } from './manifest.ts'
import { MountError, isMounted, makeWhiteout, mountOverlayReady, unmountOverlay } from './mount.ts'
import type { MountMode, OverlaySpec } from './mount.ts'
import { ensureToolchain } from './toolchain.ts'

/** 这一档现在落不了地。**不是异常，是一次有由头的拒绝**——由头原样带给调用点（与 `ForkRefused` 同一个形状）。 */
export class EnsureRefused extends Error {
  readonly why: string

  constructor(why: string) {
    super(why)
    this.name = 'EnsureRefused'
    this.why = why
  }
}

export interface EnsureDeps {
  readonly roots: Roots
  readonly log: Log
  /** 工作区根：平台事实的缓存住在 `<root>/.fugue/config`（§ 15.3.a）。 */
  readonly root: string
  /**
   * 视图那一侧要的四样：变更序列 · 两条读 · 它的修订点 · 它的墓碑。
   *
   * **不是 import 来的**（§ 8.3：三个模块只共享 `Delta`），由调用点注入——`View` 结构上就满足它。
   * `tombstones` 只给落地判"一条 whiteout 打不开"那一支用（`land.ts` 的 `refuseReopen`）。
   */
  readonly view: ViewReads & {
    readonly rev: ViewRev
    deltasSince(from: ViewRev): Delta[]
    tombstones(): readonly RelPath[]
  }
  /**
   * base 提交那一份的读口（`mat/fork.base`）。**清单的口径问的是它，不是工作树**：§ 8.5 说的是
   * "base 与视图之间内容不同的路径"，而真实工作树可能被人手改过（§ 8.4：这一步不做检测）。
   * 两个混用会出一个假红，见 `land.ts` 文件头第六条。
   */
  readonly base: ViewReads
  /**
   * 物化的选项。**§ 8.5 的 `Materializer.ensure(a, upTo)` 不收它**：它在构造这一份物化时就定了，
   * 所以它住在这里，不住在签名上。
   */
  readonly opt?: MaterializeOptions
  /**
   * 调用点已经读过一次清单就递进来。**`matState` 是 O(整份日志)**（它要找到最后一条 `mat/fork`），
   * 而 `ensure` 与 `verify-mat` 都要它——读两遍不会更对。
   */
  readonly state?: MatState
  /**
   * 声明目录（架构 § 8.6 第 1 步）：**在卸载态于 `upper` 里预建**——它们同时充当 bwrap 的
   * 挂载点，而目标不在树里时 bwrap 当场失败（实测 `Can't chdir to --bind`）。
   * 只有 `fugue run` 知道该声明什么；`fugue ensure` 自己不带它。
   */
  readonly declared?: readonly RelPath[]
}

export interface EnsureResult {
  readonly agent: AgentId
  readonly from: ViewRev
  readonly to: ViewRev
  readonly strategy: ForkStrategy
  readonly merged: AbsPath
  readonly upper: AbsPath
  /** 真正动过盘的路径。 */
  readonly landed: readonly RelPath[]
  /** 视图要它变、而盘上已经是对的——没动盘（含"写回原内容"那一条）。 */
  readonly untouched: readonly RelPath[]
  readonly whiteouts: number
  readonly pruned: number
  /** 这一趟预建的挂载点：声明要绑、而树里本来没有的那些目录（架构 § 8.6 第 1 步）。 */
  readonly prepared: readonly RelPath[]
  /** 落地之后清单的条数。**§ 9.7 的 `mat/sync.touched` 就是它**（进度事件不带清单本身）。 */
  readonly touched: number
  /**
   * 落地之后清单的**路径表**（排序过的那一份，条数就是 `touched`）。
   *
   * 上面那个数答不了"是哪些"，而有一处要的正是那些：`fugue run` 的反向通道要拿它当减数——
   * `upper` 里本来就有东西（这一趟落下去的 delta 就是），"子进程改了什么"只能是"枚举到的
   * 减去清单里的"（§ 8.7 的 `collect`）。少这一减，第二趟运行会把上一趟的产出当成越声明。
   */
  readonly manifest: readonly RelPath[]
  /** 已最新：没有 delta 要落，也没写事件。 */
  readonly noop: boolean
  readonly ms: number
  /** 只有 overlayfs 档探了平台事实（另两档不挂载，不问）。 */
  readonly facts: PlatformFacts | null
}

export async function ensure(deps: EnsureDeps, agent: AgentId, upTo: ViewRev): Promise<EnsureResult> {
  const started = performance.now()
  const { roots } = deps
  const opt = deps.opt ?? DEFAULT_MATERIALIZE
  const st = deps.state ?? (await matState(deps.log, agent))
  if (!st.forked || st.base === null || st.strategy === null) {
    throw new EnsureRefused(
      '这个 agent 还没铺过物化树：delta 没有地方落\n先 fugue fork <base> 铺一棵（§ 8.5 的调用点：执行前 · 合并验收 · 冲突解决）。',
    )
  }
  if (upTo < st.rev) {
    throw new EnsureRefused(
      `物化已经落到 rev ${st.rev}，而 --to ${upTo} 比它早\n§ 9.6 那张表里没有"回退"这条路：要旧的那一棵就重新 fork。`,
    )
  }
  if (upTo > deps.view.rev) {
    throw new EnsureRefused(
      `要落到 rev ${upTo}，而视图此刻只到 rev ${deps.view.rev}\n` +
        `这个号还不是一个修订点——落一个不存在的号进 mat/sync，"清单落到哪儿了"从此说不准（而回退不是一条路，§ 9.6）。`,
    )
  }
  const upper = roots.scratchRoot(agent)
  const merged = roots.mergedRoot(agent)
  const temp = roots.tempRoot(agent)
  const overlay = st.strategy === 'overlayfs'
  const target = overlay ? upper : merged
  if (!existsSync(target)) {
    throw new EnsureRefused(
      `物化树不在：${target}\n它是派生的——§ 8.5 的失败处理是"删除重建，不修复"：fugue fork <base> 重铺一棵。`,
    )
  }

  // 工具链读数（P3a）：趁物化补一遍缓存——投影只读缓存，前缀那一步不跑子进程。
  await ensureToolchain(deps.root)
  let facts: PlatformFacts | null = null
  let spec: OverlaySpec | null = null
  if (overlay) {
    spec = { lower: roots.realRoot, upper, work: join(temp, 'work'), merged }
    facts = await ensureFacts(deps.root, roots.realRoot, join(temp, 'probe'))
    if (facts.overlayfs === null) {
      throw new EnsureRefused(
        `这一档现在挂不动（${facts.overlayfsNote}）\ndelta 落在 upper 里，而合并树要挂起来才看得见——挂不上就落了个看不见的东西。`,
      )
    }
    if (facts.whiteout === null) {
      throw new EnsureRefused(`whiteout 造不出来（${facts.whiteoutNote}）\n删除要它才落得了地（§ 8.5）。`)
    }
  }
  const whiteoutMode = facts === null ? null : facts.whiteout

  // **已最新就是空操作**：不卸 · 不落 · 不写事件。挂载态仍然补齐（上面那段）。
  //
  // **"两个号不同"不等于"有东西要落"**：刚 fork 的树里水位是 0，而视图的 delta 都挂在
  // rev ≥ 1 上（`record()` 从 `cur + 1` 起）——那一趟一条都落不下去。不把这一档摘出来，
  // 第一条只读的 `bash` 就会凭空写一条**空的** `mat/sync`（`from === to`），判据 ⑥ 那条读数
  // （"视图没动就不落"）当场失效（本地实测撞到过）。
  const deltas = upTo > st.rev ? deps.view.deltasSince(st.rev) : []
  const dirty = deltas.length > 0
  // 声明目录里树里还没有的那些。**它写的是 `upper`，而写 `upper` 只能在卸载态**（§ 8.5），
  // 所以它与"有 delta 要落"共用同一个卸载窗口——两条都不需要时，一个字节都不碰。
  const missing = (deps.declared ?? []).filter((rel) => !existsSync(join(merged, rel)))
  let out: LandResult = { manifest: manifestMap(st), landed: [], untouched: [], whiteouts: 0, pruned: 0 }
  const prepared: RelPath[] = []
  if (dirty || missing.length > 0) {
    if (overlay) unmountOverlay(merged)
    try {
      if (dirty) {
        out = await landDeltas(
          {
            target,
            lower: roots.realRoot,
            base: deps.base,
            overlay,
            whiteout:
              whiteoutMode === null ? null : (abs: AbsPath) => makeWhiteout(abs, whiteoutMode as MountMode),
            pruneEmptyDirs: opt.pruneEmptyDirs,
            view: deps.view,
          },
          manifestMap(st),
          deltas,
        )
      }
      for (const rel of missing) {
        mkdirSync(join(target, rel), { recursive: true })
        prepared.push(rel)
      }
    } catch (err) {
      // 落不完也要把树挂回去：**半落的 delta 不影响下一次 ensure**（它会重对一遍），而树不挂着
      // 就什么都跑不了。
      if (overlay && spec !== null && facts !== null) await mountBack(deps, agent, spec, facts)
      throw err
    }
  }
  if (overlay && spec !== null && facts !== null) facts = await mountBack(deps, agent, spec, facts)

  const payload = manifestPayload(out.manifest)
  const ms = Math.round(performance.now() - started)
  if (dirty) {
    await deps.log.append(agent, {
      t: 'mat/sync',
      agent,
      from: st.rev,
      to: upTo,
      paths: payload.paths,
      hashes: payload.hashes,
      ms,
    })
  }
  return {
    agent,
    from: st.rev,
    to: upTo,
    strategy: st.strategy,
    merged,
    upper,
    landed: out.landed,
    untouched: out.untouched,
    whiteouts: out.whiteouts,
    pruned: out.pruned,
    prepared,
    touched: payload.paths.length,
    manifest: payload.paths,
    noop: !dirty,
    ms,
    facts,
  }
}

/**
 * 挂回合并树。**幂等**：已经挂着就什么都不做——所以"挂载态被弄坏了"这一类现场，重跑一条
 * `ensure` 就补齐，不必先 `dispose` 再 `fork`。
 *
 * 挂不上时把平台事实重探一次再试（缓存说挂得动而真挂不上，说明缓存错了）：与 `fork` 同一个
 * 道理、同一条退路。重探之后还是同一门路，就把错误原样抛出去——**但要说清 delta 已经落了**，
 * 否则读到的人会以为这一条命令什么都没干。
 */
async function mountBack(
  deps: EnsureDeps,
  agent: AgentId,
  spec: OverlaySpec,
  facts: PlatformFacts,
): Promise<PlatformFacts> {
  const mode = facts.overlayfs
  if (mode === null) throw new EnsureRefused(`这一档现在挂不动（${facts.overlayfsNote}）`)
  if (isMounted(spec.merged)) return facts
  try {
    mountOverlayReady(spec, mode)
    return facts
  } catch (err) {
    if (!(err instanceof MountError)) throw err
    const fresh = await ensureFacts(deps.root, deps.roots.realRoot, join(deps.roots.tempRoot(agent), 'probe'), true)
    if (fresh.overlayfs !== null && fresh.overlayfs !== mode) {
      mountOverlayReady(spec, fresh.overlayfs)
      return fresh
    }
    throw new MountError(
      'overlay 挂不回去（delta 已经落好了；再跑一次 ensure 会把挂载补齐）',
      err.argv,
      err.status,
      err.stderr,
    )
  }
}
