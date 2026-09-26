// `fork`：把 base 那棵树物化出来，返回合并树。出处：架构 § 8.5 的 `Materializer.fork` ·
// § 8.4 的四个根 · § 8.1 的 `mat/fork` 事件。
//
// 一次 `fork` 就只有四步：
//
//   1. **先卸后删，再重建四个坐标**——§ 8.5 的失败处理是"删除重建"，它是派生且可弃的，
//      不尝试修复。先卸后删是硬顺序（见 `mount.ts`）。
//   2. **要一份平台事实，选一档**（`capability.ts`）。点名的档不可用 → 拒绝；没点名就退档。
//   3. **底就位**：`overlayfs` 档什么都不铺，把真实工作树挂进来（§ 8.4：不复制、不搬运，
//      于是 fork 的代价与仓库规模无关）——**挂上之后把那两条工作区自己的本子遮掉**（见
//      `maskWorkspaceState`）；另两档把底真的铺一份（`lay.ts`），那两档由 `skip` 直接不铺。
//   4. **落 `mat/fork`**。`paths` 恒为空——**清单记的是变化，不是铺设**（§ 8.5）：
//      底是真实工作树，`fork` 什么都没"铺"过，本 agent 的改动由 `mat/sync` 逐次带上。
//
// **`base` 只记不验。** `fork` 不拿它去比对真实工作树——§ 8.4 把话说死了："手改真实工作树
// 会漏进物化树：那一步不做检测，检测在合并之前"。所以 `base` 是这份底的**标签**，不是一个
// 被核过的前提。
//
// **`verify-mat` 也不核它**（V4）：核它要比"物化树在 base 的路径空间里等于不等于 base"，那是
// 一整棵树、每一条一次 git 读。V4 核的是另外三样——清单 · 差异集 · 落地根（`verify.ts`），
// 而上层之外的底它看不见。
//
// **于是对齐 base 与工作树是调用点的责任**，这一句写在 CLI 的 `fork` 用法文案里。不齐时的症状
// 是**静默的**：物化树里本 agent 没碰过的那些路径给的是工作树的内容，构建跑的是另一份代码而不
// 报错。查它要一整棵树的读（§ 8.2 的批量读能把它压到一次进程的量级，但接口上仍要一个新方法），
// 而 § 8.4 把这一步判给合并之前——所以它是 S7 那一侧的事，不是这里的。
//
// **运行期挂不上 ≠ 探针说挂不上。** 前者是这次调用失败了，后者是这一档不成立：真挂失败时
// 把缓存重探一次（缓存说挂得动而真挂不上，说明缓存错了），按新事实重新选档再试一次。
// **唯一的例外是重探之后还是同一档同一门路**——那说明退无可退，原样把错误抛出去。
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Log } from '../log/events.ts'
import type { Roots } from '../roots/contract.ts'
import type { AbsPath, AgentId, CommitId, ForkStrategy } from '../terms.ts'
import { chooseStrategy, ensureFacts } from './capability.ts'
import type { Choice, PlatformFacts } from './capability.ts'
import { DEFAULT_MATERIALIZE } from './contract.ts'
import type { MaterializeOptions } from './contract.ts'
import { WORKSPACE_STATE } from './diffstat.ts'
import { LayError, layTree } from './lay.ts'
import type { LayResult } from './lay.ts'
import { clearMaterialization, makeWhiteout, mountOverlayReady } from './mount.ts'
import type { MountMode, OverlaySpec } from './mount.ts'

/** 这一档现在不成立。**不是异常，是一次有由头的拒绝**——由头原样带给调用点。 */
export class ForkRefused extends Error {
  readonly why: string

  constructor(why: string) {
    super(why)
    this.name = 'ForkRefused'
    this.why = why
  }
}

export interface ForkDeps {
  readonly roots: Roots
  readonly log: Log
  /** 工作区根：平台事实的缓存住在 `<root>/.fugue/config`（§ 15.3.a）。 */
  readonly root: string
}

export interface ForkResult {
  readonly agent: AgentId
  readonly base: CommitId
  readonly strategy: ForkStrategy
  readonly mount: MountMode | null
  readonly merged: AbsPath
  /** overlayfs 档什么都不铺，所以是 `null`；另两档给铺了多少条目。 */
  readonly laid: LayResult | null
  readonly ms: number
  readonly why: string
  readonly facts: PlatformFacts
}

/** 四个坐标的物化部分。`cache` 不在这里：它是 M5 的（§ 8.6），`fork` 不碰。 */
function partsOf(roots: Roots, a: AgentId): { upper: AbsPath; merged: AbsPath; temp: AbsPath } {
  return { upper: roots.scratchRoot(a), merged: roots.mergedRoot(a), temp: roots.tempRoot(a) }
}

function wipe(roots: Roots, a: AgentId): { upper: AbsPath; merged: AbsPath; temp: AbsPath } {
  const p = partsOf(roots, a)
  clearMaterialization(p.merged, [p.upper, p.merged, p.temp])
  for (const d of [p.upper, p.merged, p.temp]) mkdirSync(d, { recursive: true })
  return p
}

export async function fork(
  deps: ForkDeps,
  agent: AgentId,
  base: CommitId,
  opt: MaterializeOptions = DEFAULT_MATERIALIZE,
): Promise<ForkResult> {
  const { roots } = deps
  if (!existsSync(roots.realRoot)) {
    throw new ForkRefused(`真实工作树不在：${roots.realRoot}\n底就是它（§ 8.4），没有它就没有可挂的东西。`)
  }
  const started = performance.now()
  const dry = partsOf(roots, agent)
  // 探针要一块自己的地方，而选档可能拒绝——所以这一趟只动 `tmp`，不动已经铺好的那一份。
  mkdirSync(dry.temp, { recursive: true })
  const scratch = join(dry.temp, 'probe')
  let facts = await ensureFacts(deps.root, roots.realRoot, scratch)
  let chosen = chooseStrategy(facts, opt)
  if (!chosen.ok) throw new ForkRefused(chosen.why)

  let p = wipe(roots, agent)
  let laid: LayResult | null
  try {
    laid = applyOnce(chosen.choice, roots, p, opt, facts)
  } catch (err) {
    const fresh = await ensureFacts(deps.root, roots.realRoot, scratch, true)
    const again = chooseStrategy(fresh, opt)
    const same =
      again.ok &&
      again.choice.strategy === chosen.choice.strategy &&
      again.choice.mount === chosen.choice.mount
    if (same || !again.ok) throw err
    facts = fresh
    chosen = again
    p = wipe(roots, agent)
    laid = applyOnce(chosen.choice, roots, p, opt, facts)
  }

  const ms = Math.round(performance.now() - started)
  await deps.log.append(agent, {
    t: 'mat/fork',
    agent,
    base,
    strategy: chosen.choice.strategy,
    paths: [],
    hashes: [],
    ms,
  })
  return {
    agent,
    base,
    strategy: chosen.choice.strategy,
    mount: chosen.choice.mount,
    merged: p.merged,
    laid,
    ms,
    why: chosen.choice.why,
    facts,
  }
}

/** 底就位。三档的差别**只在这一处**：挂进来，还是铺一份。 */
function applyOnce(
  choice: Choice,
  roots: Roots,
  p: { upper: AbsPath; merged: AbsPath; temp: AbsPath },
  opt: MaterializeOptions,
  facts: PlatformFacts,
): LayResult | null {
  if (choice.strategy === 'overlayfs') {
    if (choice.mount === null) throw new Error('内部不一致：overlayfs 档没有报出挂载门路')
    const spec: OverlaySpec = { lower: roots.realRoot, upper: p.upper, work: join(p.temp, 'work'), merged: p.merged }
    mountOverlayReady(spec, choice.mount)
    maskWorkspaceState(roots.realRoot, p.upper, facts.whiteout)
    return null
  }
  try {
    return layTree(roots.realRoot, p.merged, {
      readOnly: opt.readOnlyPaths ?? [],
      preserveMtime: opt.preserveMtime,
      skip: WORKSPACE_STATE,
    })
  } catch (err) {
    if (err instanceof LayError) {
      throw new LayError(err.path, `${err.message.split('：').slice(1).join('：')}（底：${roots.realRoot}）`)
    }
    throw err
  }
}

/**
 * **合并视图那一侧**：`WORKSPACE_STATE`（`.git` · `.fugue`）那两条名字在三档上都要取不到。
 *
 * 铺树那两档走 `layTree` 的 `skip`（顶层不铺那两条）；`overlayfs` 档的底是把真实工作树**整个
 * 挂进来**（§ 8.4：不复制、不搬运），没有"铺"这一步——所以要在挂上之后给那两条名字各造一条
 * **whiteout**（字符设备 0:0）。它就是 overlayfs 眼里的"这儿没有"，与 `land.ts` 落删除走的是
 * 同一条门路；`capability.ts` 的 `whiteout` 那一档已经在探它（造不出来的机器上 overlayfs 这一档
 * 本来就不成立：删除落不了地），所以这里不问"造不造得出"，只问底下有没有那两条。
 *
 * **只遮底下真有的那两条。** 底里没有的，造一条 whiteout 是往 `upper` 里多留一条墓碑——而
 * `upper` 是"这一格改了什么"的落地根（`verify.ts` 与 `reclaim.ts` 都在枚举它）。口径与
 * `skip` 一致：跳的是"工作区自己的本子这两条名字"，不是"盘上有没有"。
 *
 * **代价如实记**（PLAN § 5.12 序 11）：格内 `git` 从此取不到仓库——它今天读到的是真实工作树那
 * 一份。要给模型一份 git 是另一件事（借一份只读的、或者格内自己 `git init`），不归这一格。
 */
function maskWorkspaceState(realRoot: AbsPath, upper: AbsPath, mode: MountMode | null): void {
  // 选档那一处已经把"造不造得出 whiteout"问过了（`capability.ts`：造不动就没有 overlayfs 这一
  // 档）。走到这儿还是 `null`，说明档与事实对不上——那是程序错，不是环境问题。
  if (mode === null) throw new Error('内部不一致：overlayfs 档没有报出造 whiteout 的门路')
  for (const name of WORKSPACE_STATE) {
    if (!existsSync(join(realRoot, name))) continue
    makeWhiteout(join(upper, name), mode)
  }
}
