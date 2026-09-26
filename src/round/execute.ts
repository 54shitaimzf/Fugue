// 一个完整轮次：**拆分 → 并行 → 合并 → 验收**（架构 § 20 S7 的可用性那一句）。出处：
// § 8.13 的状态图（每一步都是一条转移）· § 8.14 的七步 · § 8.12 的第一次预检 ·
// PLAN § 5.7 的 A8 行与"收口四样"第一条。
//
// **这一份是接线，不是机制。** 它把前面七份按架构那张图的顺序串起来：
//
//   `startRound`（A4：钉底 · 造契约 · 预检 · 发契约 · 起分支）
//     → 每个 agent 一格（模型那一侧今天是打桩的，见下面那条"打桩"）
//     → `mergeGate`（A2 的第二个调用点：合并前兜底，报出即拒）
//     → `fold`（A5：逐路折叠，冲突就停下）
//     → `mergeDrift`（A7 · A10：HEAD 动了，或盘上与**目标树**不同的路径 → 拒）
//     → `verify`（A6：跑在物化出来的那棵树上）
//     → `commitThenAdvance`（A6：通过才定格 + 推进；没过 → 真实工作树一个字节不动）
//
// **打桩在哪里，说清楚。** 这一步的"每个 agent 干一格活"今天是**打桩**的：真模型要 S8
// （PLAN § 5.7 的"不在这一站里的"第一行）。打桩的形状是 `stub` —— 一个收契约、给一个提交的
// 函数。**它与真模型的差别只有"谁来改那棵树"**：契约 · 分支 · 提交 · 折叠 · 验收全都不变，
// 所以这一条命令从打桩换到真模型时，动的只有 `stub` 那一个参数。
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Log } from '../log/events.ts'
import type { Roots } from '../roots/contract.ts'
import type { Truth } from '../truth/contract.ts'
import type { AgentId, BranchId, CommitId, ContractId, RelPath, RoundId, WriterId } from '../terms.ts'
import type { Built, Intent, SplitAssignment } from '../contract/build.ts'
import type { Contract } from '../contract/types.ts'
import { mergeGate, precheck } from '../contract/precheck.ts'
import { mergeDrift } from '../merge/drift.ts'
import type { DriftVerdict } from '../merge/drift.ts'
import { conflictCount, conflictTreeEntries, fold, refold } from '../merge/merge.ts'
import type { FoldOutcome } from '../merge/merge.ts'
import { commitThenAdvance, entriesOf, verify } from '../merge/accept.ts'
import type { AdvanceResult, AssertionRunSpec, VerifyReport } from '../merge/accept.ts'
import { refFor } from '../identity.ts'
import { startRound } from './start.ts'
import type { RoundStart, RoundStartDeps } from './start.ts'
import { RETRY_DEFAULT, step } from './machine.ts'
import type { Cause, RoundState } from './machine.ts'
import { baseFor, lowerAt } from '../view/lower.ts'
import { loadView } from '../view/view.ts'
import type { View } from '../view/contract.ts'
import type { AgentDriver, DriverAsk } from './driver.ts'
import type { ModelDecl } from '../model/contract.ts'
import type { CallModel, ToolExecutor } from '../runtime/step.ts'
import type { AssembleState } from '../assemble/sources.ts'
import type { ToolEntry } from '../tools/catalog.ts'

/** 这一层自己的失败：某一步拒了（预检 · 漂移 · 冲突解不掉 · 验收不过）。**话原样带给调用点。** */
export class RoundRunError extends Error {
  /** 拒在哪一步。**给报告与走查用**：`planning` · `drift` · `merge` · `accept`。 */
  readonly at: string

  constructor(at: string, why: string) {
    super(why)
    this.name = 'RoundRunError'
    this.at = at
  }
}

/**
 * 模型那一侧今天长什么样：**一份打桩**。它收一份契约与它的底，给一个提交。
 *
 * 打桩的形状定在这里（而不是在 CLI 里）是因为它是这一条命令的一个**参数**：换成真模型时，
 * 换的是这个函数，其余一个字不动（架构 § 14.1 的 `SpawnKit` 那七步里的"跑"那一段）。
 */
export interface ResolveHint {
  /** 那几条冲突路径。 */
  readonly conflictPaths: readonly RelPath[]
  /**
   * **下一折要折进来的那一路。**
   *
   * 为什么它在这一份提示里：折叠是**逐路**的，撞上冲突时手上那个累积提交（`folded`）是
   * "已经折好的那几路与底"的合并结果，而下一折会把 `rest[0]` 与它再合一次。所以解决那一笔
   * 只要让冲突路径上的内容**收敛到 `rest[0]` 那一侧**，下一折的逐文件比对就什么都看不到——
   * 折得下去。目标取另一侧（`folded`）的话下一折照样报同一个冲突（`rest[0]` 相对底的改动还在，
   * 而 `folded` 里那一条与它不同）——**这是逐路折叠这条路的真实形状**，不是这一份的取舍。
   */
  readonly nextBranch: CommitId
}

/**
 * 打桩那一份的形状（**S7 定下的接缝**：收一份契约、一个底、一句提示，给一个提交）。
 *
 * `B7.5` 之后 `runRound` 收的不是它，是 `AgentDriver`（一个函数）——这一份由 `stubDriver()`
 * 包一层。**包而不是改**：这一份是 S7 · CLI · 走查三处都指着的形状，多一个参数也是改形状；
 * 而"换成真模型时换的是哪一个函数、其余一个字不动"这句话，靠的就是那个函数类型。
 */
export interface Stub {
  /** 一个 agent 干完它那一格，给一个提交。`hint` 是"冲突要往哪边收"（只有解决那一格有）。 */
  run(agent: AgentId, contract: Contract, base: CommitId, hint?: ResolveHint): Promise<CommitId>
}

/** 一次轮次跑完之后的全部读数。**它是"A8 收口"那条命令的返回值**，也是走查印的东西。 */
export interface RoundRun {
  readonly round: RoundId
  readonly base: CommitId
  readonly started: RoundStart
  /** 每个 agent 交的那个提交（按契约顺序）。 */
  readonly work: Readonly<Record<ContractId, CommitId>>
  readonly precheckPlanning: number
  readonly precheckMerge: { readonly ok: boolean; readonly count: number }
  readonly drift: DriftVerdict | null
  readonly fold: FoldOutcome
  /** 冲突那一档才有：物化出来的冲突树（那份 `TreeEntry[]`）。 */
  readonly conflictTree: { readonly paths: readonly RelPath[]; readonly entries: number } | null
  readonly report: VerifyReport
  readonly advanced: AdvanceResult | null
  /**
   * 走到的最后一个状态。
   *
   * **通过那一档的终点是 `Rebuilding`，不是 `Committed`**：这一份的第七步在定格之后还要把真实
   * 工作树推进到目标树（架构 § 8.14 的 `Committed ──advanced──> Rebuilding`），而状态机的两步
   * 都落了 `round/state`。所以"这一轮通过了"的判据是 `report.ok` 与 `advanced !== null`，
   * 不是这个栏等于 `Committed`。没过那一档回 `Working`（还有回边额度）或 `Aborted`。
   */
  readonly state: RoundState
}

export interface RoundRunDeps extends Omit<RoundStartDeps, 'log'> {
  readonly log: Log
  /**
   * 某个 agent 自己的日志口。**`ckpt/commit` 是那个 agent 自己落的**（§ 8.1 的事件里 `agent`
   * 那一栏就是它），而持轮者那条句柄握着 `round` 的栅栏——一次命令一个 writer（`hold.ts` 那条
   * 禁令要防的是"同一个 writer 的序号被两个进程领到"）。
   *
   * **一个 agent 一个口，这个口由调用方持有**：同一个 agent 在一轮里会被要两次（视图铺在它那条
   * 分支上一次 · 真驱动那一趟一次），而 `holdWriter` 是**开一次取一次锁**——同一个 writer 开第二个
   * 口就是"已经有写者"。所以这一栏必须是**记住过的那个口**（调用方那一侧按 agent 记忆），
   * 而关它也是调用方的事（`closeAgentLogs`）——`runRound` 自己不关别人手上的口。
   */
  readonly logOf: (a: AgentId) => Log
  /**
   * 这一轮开过的那些 agent 日志口，由调用方在轮次结束后关掉（**可选**：夹具与单测可以不关）。
   * 与 `logOf` 配对：`runRound` 只借不还。
   */
  readonly closeAgentLogs?: () => Promise<void>
  /**
   * **干一格的那一个函数**（S7 定下的接缝，形状不动：`run(agent, contract, base, hint?) → CommitId`）。
   *
   * 打桩那一档给 `stubDriver(stub)`；真驱动那一档给 `realDriver({ deliver })`（`B7.5`）。**两者在
   * 这一份眼里没有区别**——它只调那一个函数。
   */
  readonly stub: AgentDriver
  /** `AgentDriver` 那一份 ask 要的那几样（**打桩那一档一个都不读**）。 */
  readonly driver?: DriverSupport
  /** 验收要跑的那几条（已经包好的命令行）。**按契约给**：`contractOf` 给哪几份就跑哪几条。 */
  readonly specsOf: (c: Contract, agent: AgentId) => readonly AssertionRunSpec[]
  /** 要不要在合并前判漂移（缺省判）。判的时候用的是**轮次开始时那份基线**。 */
  readonly checkDrift?: boolean
  /**
   * `Verifying → Working` 那条回边还允许走几次（架构 § 8.13 图上那两条分叉：没通过 ∧ 未超界 → 回
   * `Working` · 没通过 ∧ 超界 → `Aborted`）。**不给就走 `RETRY_DEFAULT`（1）**：没通过回一次，
   * 第二遍还不过才判这一轮失败。
   *
   * 这一条命令今天**不真的重跑失败的那几支**（重跑要重新派发，归 A4 起头那一段），所以它判的是
   * "这一次没通过之后该往哪条边走"——走回边的次数就是打回读数的第二个数。
   */
  readonly retriesLeft?: number
  /**
   * **这一格最多走几步**（`driver.ts` 的 `driveOnce` 按它停）。
   *
   * 它是**花钱的那道上界**：`--live` 下每一步是一次真调用。**不给就是不设**——上界由人给，
   * 不由我们兜底（`runtime/step.ts` 那一段）；写进「我的任务」的那个数与这里停下来用的那个数
   * 同源，而"第一次真跑最多花多少"这件事在命令面上能设——第一次联网验证就是按它压到个位数跑的。
   */
  readonly maxSteps?: number
  /**
   * 到了预算触发点要不要交接（缺省要——`B6` 的停机纪律是"先停"）。给 `false` 就是"用完就停"那一档。
   */
  readonly handoff?: boolean
  /**
   * 合并前那一档预检的严宽。**缺省 `false`：报出即拒**（`mergeGate`——合并是不可逆点，兜底那
   * 一侧 fail-closed，架构 § 8.12 的第二次预检）。给 `true` 就把它拉平到 `Planning` 那一档：
   * **报出来、照发**。
   *
   * 这一档存在的理由是走查：两份契约的写入面相交时（`Planning` 那一档的口径是报出照发），
   * 硬那一档会先拦住合并，于是"折叠里真撞出一次冲突"这件事走不到。拉平之后，真冲突由 `fold`
   * 当场报出——**没有任何东西被静默**，只是同一件事报在哪一步。
   */
  readonly softMergeGate?: boolean
  /**
   * 合并之前那一下（**给走查用**）：轮次中有人手改了工作树时，那一次改动要落在"基线取完之后、
   * 漂移检之前"这个窗口里。缺省什么都不做——真轮次里那个窗口是用户自己的手。
   */
  readonly beforeMerge?: () => Promise<void> | void
  /**
   * **折叠跑完、漂移检跑之前**的那一下（**给走查用**）：拿到了这一趟的目标树（折出来的那个提交），
   * 而盘上一个字节都还没动。走查用它把目标树里某条路径的字节抄到盘上——那是"用户手里那份恰好
   * 就是合并算出来的结果"那一档（A10 的断言 ③）。缺省什么都不做。
   */
  readonly afterFold?: (target: CommitId) => Promise<void> | void
  /** 漂移检跑完之后的读数口（**原始读数**：HEAD 动没动 · 脏路径 · 要写的路径 · 相交的那几条）。 */
  readonly onDrift?: (d: DriftVerdict) => void
}

/**
 * 真驱动那一条路要多带的那几样。**不给就是打桩那一档**（`DriverAsk` 里那些可选栏一个都不读）。
 *
 * 它为什么是 `RoundRunDeps` 上的一个可选栏而不是塞进 `AgentDriver`：`AgentDriver` 是**那道缝**
 * （S7 定下的，形状不动），而这几样是"这一轮拿什么去跑"——装配状态 · 公布的工具目录 · 模型声明 ·
 * 两个接缝。**它们由调用方按 agent 记忆**（`state` 与 `handle` 都收一个 agent 名）：每一条分支
 * 的坐标各是各的，所以"整轮一份"会在第二个 agent 上给出第一个的状态。
 */
export interface DriverSupport {
  /**
   * 这一步的装配状态。**收契约**（B 区那几段照契约填，而契约是 `startRound` 造的）。
   */
  readonly state: (agent: AgentId, contract: Contract) => AssembleState
  /** 这一格的句柄（分支 · 契约 · 模型 · 目标）。同样收契约（理由同上）。 */
  readonly handle: (agent: AgentId, contract: Contract) => DriverAsk['handle']
  readonly decl: ModelDecl
  readonly call?: CallModel
  readonly execute?: ToolExecutor
  readonly tools?: readonly ToolEntry[]
}

/**
 * 跑一个完整的轮次。**每一步都留下读数**：预检报了几对 · 漂移判了什么 · 折了几步 · 三档各几条。
 *
 * 顺序是承重的，逐条指得出出处：
 *   1. `startRound` —— 钉底 · 造契约 · `Planning` 预检 · 发契约 · 起分支（架构 § 8.13 的三步）
 *   2. 每个 agent 一格（打桩）
 *   3. **合并前兜底预检**（架构 § 8.12：第二次预检，报出即拒——合并是不可逆点）
 *   4. `fold` —— 逐路折叠（A5）；**冲突就停在冲突环的第一步**
 *   5. **漂移检**（架构 § 8.14 的 C7：HEAD 动了，或盘上与目标树不同的路径 → 拒）——判据的另一边
 *      是第 4 步折出来的那棵树，所以它落在这里；它仍然在物化之前（**盘上一个字节都没动**）
 *   6. `verify` —— 跑在物化出来的那棵树上（A6）
 *   7. `commitThenAdvance` —— 通过才定格 + 推进（A6 那句"顺序即不变量"）
 */
/**
 * 一格的那一份 ask。
 *
 * **它把该给的一次给足**：`deps.driver` 在就是真驱动那一档（`call` · `execute` · `decl` ·
 * `handle` 都从那儿来），不在就是打桩那一档（`stubDriver` 只读 `agent` · `contract` · `base` ·
 * `hint` 四栏）。**两种情况下这个对象都是完整的**——一处 `if`，不散在调用点上。
 */
async function askOf(deps: RoundRunDeps, c: Contract, agent: AgentId, base: CommitId): Promise<DriverAsk> {
  const support = deps.driver
  if (support === undefined) {
    // 打桩那一档：给一份形状完整但内容为空的 ask（`stubDriver` 一个字节都不读它们）。
    const empty = {} as unknown as AssembleState
    return {
      agent,
      contract: c,
      base,
      openView: async () => loadView(deps.logOf(agent), agent as WriterId, { lower: lowerAt(deps.truth, base) }),
      logOf: () => deps.logOf(agent),
      truth: deps.truth,
      writer: agent as WriterId,
      state: empty,
      handle: { agent, state: empty } as unknown as DriverAsk['handle'],
      decl: {} as ModelDecl,
    }
  }
  return {
    agent,
    contract: c,
    base,
    openView: () => openAgentView(deps, agent, base),
    logOf: () => deps.logOf(agent),
    truth: deps.truth,
    writer: agent as WriterId,
    roots: deps.roots,
    state: support.state(agent, c),
    handle: support.handle(agent, c),
    decl: support.decl,
    ...(support.tools === undefined ? {} : { tools: support.tools }),
    ...(support.call === undefined ? {} : { call: support.call }),
    ...(support.execute === undefined ? {} : { execute: support.execute }),
    // 两个数列：**它们是"这一趟最多花多少"的那两道闸**，缺省时 `driveOnce` 自己那份缺省说了算。
    ...(deps.maxSteps === undefined ? {} : { maxSteps: deps.maxSteps }),
    ...(deps.handoff === undefined ? {} : { handoff: deps.handoff }),
  }
}

/** 这一格自己的视图（铺在它自己那条分支上：`refs/heads/<agent>`）。 */
async function openAgentView(deps: RoundRunDeps, agent: AgentId, base: CommitId): Promise<View> {
  const log = deps.logOf(agent)
  return loadView(log, agent as WriterId, { lower: lowerAt(deps.truth, base) })
}

export async function runRound(deps: RoundRunDeps): Promise<RoundRun> {
  const { roots, truth, log, round } = deps

  // 一 · 起头。**不再取盘上那份基线**（A10）：判据换成"目标树 vs 盘上"之后，基线那一侧读的是
  // 轮次开始时钉住的那个底本身——它由 `M1` 拿着，不需要在盘上扫一遍。
  const started = await startRound(deps)

  // 二 · 每个 agent 一格。契约按顺序，底是钉住的那一个——**每条分支的底相同**，所以一个 agent
  // 交上来的提交可以直接拿去折（它的父是 base）。
  const work: Record<ContractId, CommitId> = {}
  for (const c of started.built.contracts) {
    const agent = c.agent as AgentId
    const commit = await deps.stub(await askOf(deps, c, agent, started.base))
    work[c.id] = commit
    // **真驱动自己落 `ckpt/commit`**（它走的是 § 9.6 那份 `checkpoint()`）；打桩那一份只算一棵树，
    // 所以它那一条由这里补。**两条路的交接面就是这一个函数**（`AgentDriver`）。
    if (deps.driver === undefined) {
      await withAgentLog(deps.logOf, agent, (l) =>
        l.append(agent as WriterId, { t: 'ckpt/commit', agent, commit, rev: 1, msg: `（打桩）${c.id}` }),
      )
    }
  }

  // 三 · 合并前那一次预检：**兜底那一侧报出即拒**（架构 § 8.12 的第二次预检）。
  const mergeCheck = mergeGate(started.built.contracts)
  if (!mergeCheck.ok && deps.softMergeGate !== true) {
    throw new RoundRunError('merge', `合并前的写入集预检不放行：\n  ${mergeCheck.result.lines.join('\n  ')}`)
  }

  // 四 · 折叠之前的两件事：兜底预检的读数与两条记账。
  const foldable = started.built.contracts
    .filter((c) => c.kind !== 'investigate')
    .map((c) => work[c.id] as CommitId)
  // 折之前先记一笔尝试：`merge/attempt` 记的是"这次合并撞了几条路径"，而冲突那一档的最后一次
  // 尝试在下面（撞上时）单独落一条——两条各是各的读数。
  await log.append('round', { t: 'merge/attempt', round, branches: [] as never, conflicts: 0 })
  // **轮次中的手改**：走查要量"手改一条会被这次合并覆盖的路径 → 拒"，而手改必须发生在
  // **轮次开始之后、漂移检之前**。这一处是那个位置的唯一入口（缺省什么都不做）。
  if (deps.beforeMerge !== undefined) await deps.beforeMerge()

  // 五 · 逐路折叠（A5）。一路的情况折 0 次（地板那一档）——`fold` 里那一圈从 i=1 起就是这个意思。
  const folded = await fold({ truth, msgOf: (i) => `${round} 折叠第 ${i} 步` }, foldable)
  let outcome: FoldOutcome = folded
  let conflictTree: RoundRun['conflictTree'] = null
  let resolvedContract: Contract | null = null
  if (outcome.kind === 'conflict') {
    // 冲突环的第一步：物化冲突树，把它交给"解决者"（打桩那一侧）。**这一份不替它判该留哪一段。**
    const { entries } = await conflictTreeEntries(truth, outcome.folded, outcome.conflicts)
    conflictTree = { paths: outcome.conflicts.map((c) => c.path), entries: entries.length }
    // 给解决者的那一份契约值：**它不进 `contract/issue`**（那是 A4 发出去的那四份），它是"折到
    // 这一步才知道"的那一份——`conflictPaths` 就是实际冲突集，`base` 是冲突报告给的那棵树
    // （架构 § 8.12 那张表的最后两行）。解决完它要跟着重折，所以也进 `work`。
    resolvedContract = resolveContractOf(started.built.contracts, outcome.conflicts.map((c) => c.path), outcome.folded)
    const nextBranch = outcome.rest[0]
    if (nextBranch === undefined) throw new RoundRunError('merge', '撞上冲突却没有下一折——折叠表不成立')
    const resolvedAgent = resolvedContract.agent as AgentId
    const resolved = await deps.stub({
      ...(await askOf(deps, resolvedContract, resolvedAgent, outcome.folded)),
      hint: { conflictPaths: outcome.conflicts.map((c) => c.path), nextBranch },
    })
    work[resolvedContract.id] = resolved
    if (deps.driver === undefined) {
      await withAgentLog(deps.logOf, resolvedContract.agent as AgentId, (l) =>
        l.append(resolvedContract.agent as WriterId, {
          t: 'ckpt/commit',
          agent: resolvedContract.agent as AgentId,
          commit: resolved,
          rev: 1,
          msg: `（打桩·解冲突）${resolvedContract.id}`,
        }),
      )
    }
    await log.append('round', {
      t: 'merge/attempt',
      round,
      branches: foldable as never,
      conflicts: conflictCount(outcome.conflicts),
    })
    outcome = await refold(
      { truth, msgOf: (i) => `${round} 重折第 ${i} 步` },
      outcome,
      resolved,
      outcome.conflicts.map((c) => c.path),
    )
    if (outcome.kind === 'conflict') {
      throw new RoundRunError(
        'merge',
        `重折之后仍然冲突：${outcome.conflicts.map((c) => c.path).join(' · ')}（冲突环一轮没解掉）`,
      )
    }
  }

  // 五之二 · 漂移检（A7 · A10）。**判据是"目标树 vs 盘上"，所以它落在折叠之后**——目标树就是
  // 刚折出来的那个提交。这一档 fail-closed：物化不可逆。
  //
  // **为什么不在折叠之前判**：折叠之前手上只有各条分支的写入面（那一份反推出来的"合并要写"），
  // 而它算漏两处（A9 量到：只被删的路径不在里头；底已经带着合并结果时它整个是空的）。目标树要等
  // 折完才有，而它一处就把两处补齐了。折叠只往对象库里落中间提交，盘上一个字节都不动。
  if (deps.afterFold !== undefined) await deps.afterFold(outcome.commit)
  let drift: DriftVerdict | null = null
  if (deps.checkDrift !== false) {
    drift = await mergeDrift({ truth, realRoot: roots.realRoot, base: started.base, target: outcome.commit })
    // **三条读数原样报出来**：判据的两边（这次合并动到哪些 · 盘上与目标树不同的那些）都要看得见，
    // 否则拒了也说不清是哪一边。它走 `onDrift`（CLI 把它接到 stderr）。
    deps.onDrift?.(drift)
    if (!drift.ok) throw new RoundRunError('drift', drift.say)
  }

  // 六 · 验收：**跑在物化出来的那棵树上**（架构 § 8.14 第 5 步）。
  const matDir = mkdtempSync(join(tmpdir(), 'fugue-round-verify-'))
  try {
    await materializeCommit(truth, outcome.commit, matDir)
    const specs: AssertionRunSpec[] = []
    for (const c of started.built.contracts) specs.push(...deps.specsOf(c, c.agent as AgentId))
    // 冲突解决那一份也要验：它是这一轮里真的干了活的一份，跳过它等于验收少了一条。
    if (resolvedContract !== null) specs.push(...deps.specsOf(resolvedContract, resolvedContract.agent as AgentId))
    const report = verify(matDir, specs)

    // 七 · 通过才定格 + 推进（A6）。没过时 `commitThenAdvance` 提前返回——**真实工作树一个字节不动**。
    const accepted = await commitThenAdvance({
      truth,
      realRoot: roots.realRoot,
      tree: matDir,
      specs,
      commit: outcome.commit,
      // **定格之后主线要挪到新提交**：不然工作树是新树、主线还指着轮次开始时的底，
      // 下一轮读到的底就是旧的（走查量到过）。CAS 钉在轮次开始时的那个底上。
      ref: refFor('round'),
      refExpectedOld: started.base,
    })

    // 状态机那两步（A3）：**通过 → Committed；没过 → 回 Working 或 Aborted**。判决来自 `machine.ts`。
    // **回边还是超界**：`retriesLeft` 由调用方给（`--retry <n>`），不给就是 `RETRY_DEFAULT`（1）
    // ——"没通过就回一次"。这一档进 `round/state`，A8 的第二个数数的就是这条回边。
    const retriesLeft = deps.retriesLeft ?? RETRY_DEFAULT
    let state: RoundState = 'Verifying'
    if (accepted.report.ok) {
      state = step(state, 'verdict-pass')
      state = step(state, 'advanced')
    } else {
      const cause: Cause = retriesLeft > 0 ? 'verdict-fail' : 'retry-exceeded'
      state = step(state, cause, cause === 'verdict-fail' ? { retryLeft: true } : {})
    }
    await log.append('round', { t: 'round/state', round, from: 'Verifying', to: state })
    if (accepted.commit !== undefined) {
      await log.append('round', {
        t: 'merge/accept',
        round,
        commit: accepted.commit,
        assertions: accepted.report.results.map((r) => ({ assertion: r.assertion, verdict: r.verdict })),
      })
    }

    return {
      round,
      base: started.base,
      started,
      work,
      precheckPlanning: started.precheck.intersections.length,
      precheckMerge: { ok: mergeCheck.ok, count: mergeCheck.result.intersections.length },
      drift,
      fold: outcome,
      conflictTree,
      report: accepted.report,
      advanced: accepted.advanced ?? null,
      state,
    }
  } finally {
    rmSync(matDir, { recursive: true, force: true })
  }
}

/** 用某个 agent 那个口落一条。**口不在这里开，也不在这里关**（见 `logOf` 那一栏：一个 agent
 * 一个口，持有者是调用方）。 */
async function withAgentLog<T>(logOf: (a: AgentId) => Log, a: AgentId, fn: (l: Log) => Promise<T>): Promise<T> {
  return await fn(logOf(a))
}

/** 冲突时给"解决者"的那份契约值。**它不是构造器造的那一份**（那一份要提前知道冲突），
 * 而是"折到这一步才知道"的那一份——所以形状照 `resolve` 变体给，`conflictPaths` 就是实际冲突集。 */
function resolveContractOf(contracts: readonly Contract[], conflictPaths: readonly RelPath[], base: CommitId): Contract {
  const first = contracts[0]
  return {
    kind: 'resolve',
    id: `${first?.id ?? 'r1'}#resolve`,
    agent: (first?.agent ?? 'round') as AgentId,
    branch: (first?.branch ?? 'agent/round/0') as BranchId,
    goal: `解掉这些路径上的冲突：${conflictPaths.join(' · ')}`,
    base,
    conflictPaths: [...conflictPaths],
    assertions: first === undefined || first.kind === 'investigate' ? [] : [...first.assertions],
  }
}

/**
 * 把一个提交的条目落到一个目录里（**验收跑在哪棵树上**）。**它不是 `advance`**：
 * `advance` 推的是真实工作树、还要算差异与删多余；这一处只是"把这棵树铺出来给验收跑"。
 */
export async function materializeCommit(truth: Truth, commit: CommitId, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  for (const e of await entriesOf(truth, commit)) {
    const abs = join(dir, e.name)
    mkdirSync(join(abs, '..'), { recursive: true })
    const bytes = (await truth.getBlob(e.id as never)) as Uint8Array
    if (e.mode === 0o120000) {
      rmSync(abs, { force: true })
      symlinkSync(new TextDecoder().decode(bytes), abs)
      continue
    }
    writeFileSync(abs, bytes)
    chmodSync(abs, e.mode & 0o7777)
  }
}

/** 一个提交的冲突条数——`merge/attempt` 那条事件要它（A5 的 `onAttempt` 已经算过一遍）。 */
export function conflictsOf(o: Extract<FoldOutcome, { kind: 'conflict' }>): number {
  return conflictCount(o.conflicts)
}

/** 折起来的那个提交（`folded` 那一支）——给报告印。 */
export function commitOfOutcome(o: FoldOutcome): CommitId {
  return o.kind === 'folded' ? o.commit : o.folded
}

/** 预检那一条的读数（`Planning` 那一次与合并前那一次各一份）——**两处同一个函数**。 */
export function precheckOf(contracts: readonly Contract[]): { readonly count: number; readonly lines: readonly string[] } {
  const r = precheck(contracts)
  return { count: r.intersections.length, lines: r.lines }
}

/** 一个 agent 的分支头（走查与报告要印）。 */
export async function headOf(truth: Truth, agent: AgentId): Promise<CommitId | null> {
  return baseFor(truth, agent as WriterId)
}

/** 那个 agent 的分支 ref 名（印出来给人看）。 */
export function refOf(agent: AgentId): string {
  return refFor(agent as WriterId)
}

/** `Intent` 与 `SplitAssignment` 从这一份再导出一次：调用点（CLI）不必同时 import 两个模块。 */
export type { Intent, SplitAssignment, Built, Contract }
