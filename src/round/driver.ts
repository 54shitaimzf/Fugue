// 真驱动：**一个 agent 干完它那一格**（把 `B4` 的循环 · `B5` 的工具面 · `B6` 的预算与交接接进
// 轮次里那一趟）。出处：架构 § 14.1（`SpawnKit` 那七步里的"跑"那一段 —— **换的是"跑"这一个
// 函数，其余一个字不动**）· § 14.2（六步与三档）· § 8.13.a（接续）· § 9.6（`checkpoint`（模型侧）
// 与 `fugue commit`（人侧）是同一个操作的两个名字）· PLAN § 5.8 的 `B7.5`。
//
// **`Stub` 那道缝的形状一个字节不动**（`run(agent, contract, base, hint?) → CommitId`）：这一份
// 只给出它的第二个实现。`runRound` 那一份不认识这里的任何东西——它拿到的是同一个函数类型。
//
// **打桩与真驱动差在哪，一句话**：打桩直接算一棵树出来交给 `M1`；真驱动**先让视图拿到那份产出
// （或者让模型自己写进去），再走 `M2` 的 `view/write` 与 § 9.6 的 `checkpoint()`**。所以真驱动
// 那一趟的日志里有 `view/*` 与 `ckpt/commit`，而当驱动是"模型"时还有每一步的 `llm/call` ——
// **三个一线指标的源就在那一串事件里**（`B7` 的读数）。
import type { Log, LogReader, LogSeq } from '../log/events.ts'
import type { Truth } from '../truth/contract.ts'
import type { View } from '../view/contract.ts'
import { loadView } from '../view/view.ts'
import { lowerFor } from '../view/lower.ts'
import { createToolHost } from '../tools/host.ts'
import { createToolExecutor } from '../capability/dispatch.ts'
import { createRoots } from '../roots/roots.ts'
import type { Roots } from '../roots/contract.ts'
import type { ToolEntry } from '../tools/catalog.ts'
import type { TreeEntry } from '../entries.ts'
import type { AgentId, CommitId, ContractId, RelPath, WriterId } from '../terms.ts'
import type { Contract } from '../contract/types.ts'
import { checkpoint } from '../checkpoint.ts'
import { snapshotOf } from '../view/snapshot.ts'
import type { Stub } from './execute.ts'
import { HarnessError, createRuntime } from '../runtime/step.ts'
import type { AgentHandle, CallModel, StepResult, ToolExecutor } from '../runtime/step.ts'
import { planBudget } from '../runtime/budget.ts'
import { assemble } from '../assemble/assemble.ts'
import { sourcesFor } from '../assemble/sources.ts'
import type { Prefix } from '../assemble/contract.ts'
import { handoffAt, successorOf } from '../runtime/restart.ts'
import type { ModelDecl } from '../model/contract.ts'
import type { AssembleState } from '../assemble/sources.ts'

/**
 * 一次"干一格"要什么。**它比 `Stub` 多的是"这一趟怎么跑"那一半**：模型怎么调 · 工具怎么执行 ·
 * 预算按哪份声明算 · 装配状态长什么样。**不多的是判断**：该不该干、干成什么样算数，都不在这里。
 */
export interface DriverAsk {
  readonly agent: AgentId
  readonly contract: Contract
  readonly base: CommitId
  /** 冲突那一格才有（与 `Stub.run` 那一个参数同一个意思）。 */
  readonly hint?: { readonly conflictPaths: readonly RelPath[]; readonly nextBranch: CommitId }
  /**
   * **这一格的视图与日志怎么开**（真驱动要用；打桩那一份不读它——`Stub` 那道缝里没有它）。
   *
   * 为什么不直接收一个 `View`：轮次那一份视图是**持轮者**的（`round` 那条分支），而这一格的
   * 产出要落在**它自己那条分支**上（`refs/heads/<agent>`，`startRound` 第 4 步定的）。写进轮次
   * 那一份视图的话，折叠会把它当成持轮者的改动——**每一条分支的底相同、改动各是各的**，这条
   * 界线不能糊。
   */
  readonly openView: () => Promise<View>
  /** 这一格的日志口（**每落一条开一个口、落完就关**：一次命令一个 writer 那条纪律）。 */
  readonly logOf: () => Log
  readonly truth: Truth
  readonly writer: WriterId
  /** 公布给模型的工具目录（`B5` 的 `announce` 那一份）。 */
  readonly tools?: readonly ToolEntry[]
  /** 这一格的工作树根（沙箱与围栏的落点；不给就只写视图，不起进程）。 */
  readonly roots?: Roots
  /**
   * 怎么调模型。**不给就是"没有驱动"**：这一趟当场报出来（**不静默地交一个空提交**）。
   * 夹具那一档给 `wireCall`（`B3` 的传输）；真模型那一档给同一份东西，只是目标指向真端点。
   */
  readonly call?: CallModel
  /** 怎么执行一次工具调用（`B5` 的 `createToolExecutor`）。 */
  readonly execute?: ToolExecutor
  /** 第一步的装配状态（与 `Stub` 那一侧同一份形状）。 */
  readonly state: AssembleState
  readonly handle: AgentHandle
  /** 预算按哪份声明算（`B6` 的三个数）。 */
  readonly decl: ModelDecl
  /** 这一步的上限（**步数到顶就停**，`B6` 的地板那一档）。 */
  readonly maxSteps?: number
  /** 到了触发点要不要交接（缺省要——`B6` 的停机纪律是"先停"）。 */
  readonly handoff?: boolean
}

/**
 * **真驱动那道缝。** 与 `Stub` 同一个签名，只是多收一个"怎么跑"。
 *
 * 为什么不让 `Stub` 自己多收一个参数：`Stub` 是 S7 定下的接缝，`runRound` · CLI · 走查三处都
 * 指着它的形状。**多一个可选参数也是改形状**，而这一份的目的正是"换实现不动调用点"。
 */
export type AgentDriver = (ask: DriverAsk) => Promise<CommitId>

/** 一次"干一格"的回执（读数用：跑了几步 · 交了什么 · 交接了几次）。 */
export interface DriverResult {
  readonly commit: CommitId
  readonly steps: number
  readonly commits: readonly LogSeq[]
  readonly handoffs: readonly string[]
  readonly stopped: string
}

/** 驱动不在时那句统一的话。**它要说清"缺的是哪一样"与"为什么不能装作干完了"。** */
export function noDriver(agent: AgentId, c: ContractId): HarnessError {
  return new HarnessError(
    'no-driver',
    `${agent} 这一格（${c}）没有接上驱动：模型怎么调 · 工具怎么执行这两样都没给。` +
      '打桩那一档给的是 `stubDriver()`；真驱动要 `call`（`B3` 的传输）与 `execute`（`B5` 的工具面）。' +
      '**这一趟不交空提交**——交一个空提交会被后面的验收当成"干完了"。',
  )
}

/**
 * 一次提交：把视图此刻那一份折叠成条目表，走 § 9.6 那份 `checkpoint()`。
 *
 * **它与 `fugue commit` 是同一个操作**（同一份 `checkpoint()` · 同一条 `ckpt/commit`），所以
 * "模型侧的检查点"与"人侧的提交"在日志里长得一样——这正是 § 9.6 那句话要的形状。
 */
export async function commitView(i: {
  readonly view: View
  readonly log: Log
  readonly truth: Truth
  readonly writer: WriterId
  readonly expectedOld: CommitId | null
  readonly msg: string
}): Promise<{ readonly commit: CommitId; readonly seq: LogSeq; readonly entries: number }> {
  const entries: TreeEntry[] = await snapshotOf(i.view)
  const r = await checkpoint({
    log: i.log,
    truth: i.truth,
    writer: i.writer,
    entries,
    rev: i.view.rev,
    msg: i.msg,
    expectedOld: i.expectedOld,
  })
  return { commit: r.commit, seq: r.seq, entries: r.entries }
}

/** 契约那一句人读的话（提交信息与交接都用它）。 */
function goalOf(c: Contract): string {
  if (c.kind === 'implement') return c.goal
  if (c.kind === 'resolve') return c.goal ?? `解 ${c.conflictPaths.length} 条冲突`
  return `查清 ${c.question}`
}

/**
 * 真驱动：**装配 → 调用 → 工具 → 落日志 → 下一步**，到收敛或到预算为止，然后提交。
 *
 * **它做的四件事**（顺序是承重的）：
 *   1. 交给运行时跑（`createRuntime().run`，上限 `maxSteps`）——`B4` 的六步在这里面；
 *   2. 每一步之前看一次预算（`B6` 的三个数）：**到了触发点就写交接**，然后把状态交给后继
 *      （`successorOf`），接着跑；
 *   3. 跑完之后**提交**（`commitView` → `checkpoint()`）：视图此刻那一份就是这一格的产出；
 *   4. 把读数交回去（几步 · 交接几次 · 为什么停）——**走查要看它**，而 `Stub` 那道缝里没有它
 *      （所以它落在 `driverResultOf` 那一份旁证里，不塞进 `Stub` 的返回值）。
 *
 * **它不认识合并、不认识验收**：那些是 `runRound` 的事。这一份只管"这一格怎么干完"。
 */
export interface RealDriverOptions {
  readonly onResult?: (agent: AgentId, r: DriverResult) => void
  /**
   * 这一格的产出由谁写进视图。**缺省：用 `B5` 那一把工具面写**（与模型自己调 `write` 那条路
   * 逐字节同一条：`view/write` 那一条事件照落）。
   *
   * 它是一道口而不是一个实现，因为"这一格该产出什么"是**契约**的事（`deliverables` 与
   * `ownedPaths`），而"谁来写"是这一层的事。真模型那一档这份产出由模型自己写，这个口就不给。
   */
  readonly deliver?: (view: View, contract: Contract, agent: AgentId) => Promise<readonly RelPath[]>
}

export function realDriver(opts: RealDriverOptions = {}): AgentDriver {
  return async (ask: DriverAsk): Promise<CommitId> => {
    const r = await runAgentOnce(ask, opts)
    opts.onResult?.(ask.agent, r)
    return r.commit
  }
}

/** 真驱动那一趟的全部动作。**导出它是为了让它能被单独驱动**（断言 ③ 要走着看交接）。 */
export async function runAgentOnce(ask: DriverAsk, opts: RealDriverOptions = {}): Promise<DriverResult> {
  const { agent, contract, base, truth, writer } = ask
  if (ask.call === undefined) throw noDriver(agent, contract.id)
  // **日志口与视图由调用方给**（`round/execute.ts` 一处开：一个 writer 一个口——`hold.ts` 那道
  // 栅栏要防的是"同一个 writer 的序号被两个进程领到"，两条路各开一次就会撞上它）。
  const log = ask.logOf()
  const view = await ask.openView()
  const r = await driveOnce(ask, opts, log, view)
  // **"为什么停"落进这一格自己的日志**（第 5 批 · 疑点 2）：`DriverResult.stopped` 原先只有
  // `onResult` 那一个出口，而壳调用 `realDriver()` 时没接它——那句话于是出了这一层就没了，
  // 命令面只剩"验收：通过 1"。落成一条事件之后，"这一格到底干完没有"在日志里查得到
  // （**验收仍然是唯一的判据**，这一条是旁证）。
  await log.append(writer, { t: 'agent/stop', agent, steps: r.steps, stopped: r.stopped, handoffs: r.handoffs.length })
  return r
}


async function driveOnce(ask: DriverAsk, opts: RealDriverOptions, log: Log, view: View): Promise<DriverResult> {
  const { agent, contract, base, truth, writer } = ask

  const maxSteps = ask.maxSteps ?? 64
  // **这一格的工具面**：围栏用这一格的根（`roots`），写走这一格的视图。
  const roots = ask.roots ?? createRoots(process.cwd())
  const host = createToolHost(view, roots, {
    actions: { writer, log, truth, expectedOld: base },
  })
  const execute =
    ask.execute ??
    createToolExecutor({
      logOf: () => log,
      host,
      fenceOf: (raw, cwd) => {
        const got = roots.resolveVirtual(raw, cwd as RelPath)
        return got.ok ? { ok: true as const, value: got.value } : { ok: false as const, error: got.error }
      },
      ensureOf: () => Promise.resolve(),
    })
  const runtime = createRuntime({
    logOf: () => log,
    call: ask.call as CallModel,
    execute,
    ...(ask.tools === undefined ? {} : { tools: ask.tools }),
  })
  // **产出先写进视图**（契约那几样），再让循环跑：循环负责"说话与调工具"，产出这件事归契约。
  if (opts.deliver !== undefined) await opts.deliver(view, contract, agent)

  const commits: LogSeq[] = []
  const handoffs: string[] = []
  let handle: AgentHandle = { ...ask.handle, agent, state: ask.state }
  let steps = 0
  let handedOff = false
  let stopped = '收敛'
  // **起手那一下也交一次**：这一格干完之后视图里那一份就是产出，而"提交"这件事在循环外面
  // （循环只管说话与调工具）。**顺序与架构 § 9.3 那三步一致**：视图先有内容，再走 `checkpoint()`。
  for (;;) {
    const budget = planBudget({
      decl: ask.decl,
      prefix: prefixOf(handle),
      tools: 0,
      seed: Buffer.byteLength(goalOf(contract), 'utf8'),
      handoff: 0,
    })
    if (budget.kind === 'stop') {
      stopped = budget.why
      break
    }
    const r: StepResult = await runtime.step(handle, new AbortController().signal)
    steps += 1
    if (r.outcome.kind === 'failed') {
      // **失败要报出来**：它不是"干完了"。`why` 是短分类（`cut-stream` · `max-tokens` · …）。
      stopped = `${r.outcome.error.why}：${r.outcome.error.message}`
      break
    }
    handle = { ...handle, state: r.next }
    if (r.outcome.kind === 'done') break
    // **交一次就够**（缺省只交一次）：触发点是一个数，而"这一格该不该换人"不是每一步都重新判的
    // ——反复交接会把同一格切成三四段，而每一段都要重读一遍 Zone A + Zone B。
    if (!handedOff && budget.kind === 'restart' && ask.handoff !== false) {
      // 交接：写一条 `agent/handoff`，把状态交给后继（同一分支上换一个 `AgentId`）。
      const successor = `${agent}-${steps + 1}`
      const out = await handoffAt({
        log,
        writer,
        agent,
        successor: successor as AgentId,
        contract: contract.id,
        branch: handle.branch,
        goal: goalOf(contract),
        state: handle.state,
        coord: handle.coord,
        plan: budget,
        commands: [],
      })
      handoffs.push(out.prompt)
      handedOff = true
      handle = { ...handle, state: successorOf(handle.state, out.prompt, handle.coord) }
    }
    if (steps >= maxSteps) {
      stopped = `步数到顶（${maxSteps}）`
      break
    }
  }


  const committed = await commitView({
    view,
    log,
    truth,
    writer,
    expectedOld: base,
    msg: `（${agent}）${goalOf(contract)}`,
  })
  commits.push(committed.seq)
  return { commit: committed.commit, steps, commits, handoffs, stopped }
}

/**
 * 这一步要发出去的那份前缀（**真装配**，与 `runtime/step.ts` 里那一步同一条路：`assemble` 是
 * 纯函数，再算一次不碰任何状态）。
 *
 * **不用估的**：`B7.5` 的预算判据要与 `B6` 的读数对得上，而"估一个三区"会让触发点偏掉——
 * 偏差不报错，只是交接早一步或晚一步。
 */
function prefixOf(h: AgentHandle): Prefix {
  return assemble({ protocol: h.protocol, model: h.model, segments: sourcesFor(h.protocol, h.state, h.coord) })
}

/**
 * 打桩那一份的驱动形状（**给走查与单测用**）：把 `Stub` 包成 `AgentDriver`。
 *
 * 它为什么存在：`Stub` 那道缝与 `AgentDriver` 收的不是同一组参数（前者没有 `view` · `log` ·
 * `call` · `execute`）。包一层比改 `Stub` 好——**S7 定下的形状不动**。
 */
export function stubDriver(stub: Stub): AgentDriver {
  return (ask) => stub.run(ask.agent, ask.contract, ask.base, ask.hint)
}
