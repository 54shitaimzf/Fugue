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
import type { Log, LogReader } from '../log/events.ts'
import type { Truth } from '../truth/contract.ts'
import type { View } from '../view/contract.ts'
import { loadView } from '../view/view.ts'
import { lowerFor } from '../view/lower.ts'
import { createToolHost } from '../tools/host.ts'
import type { CommandPlan } from '../tools/host.ts'
import { createToolExecutor } from '../capability/dispatch.ts'
import { shellArgv } from '../tools/argv.ts'
import { capReceipt } from '../tools/receipt.ts'
import { createRoots } from '../roots/roots.ts'
import type { Roots } from '../roots/contract.ts'
import type { ForkStrategy } from '../terms.ts'
import { fork } from '../materialize/fork.ts'
import { createReclaim } from '../execute/reclaim.ts'
import { readConfig } from '../config.ts'
import type { ConfigDoc } from '../config.ts'
import { probeLayers, resolvePolicy } from '../boundary/policy.ts'
import { cacheLayoutOf } from '../roots/coords.ts'
import { mkdirSync } from 'node:fs'
import type { Policy } from '../boundary/policy.ts'
import { confine, degradedArgv } from '../boundary/confine.ts'
import { envFor, portRangeOf, readBinding } from '../boundary/binding.ts'
import { declaredSetOf } from '../contract/types.ts'
import { refHeadOf } from './head.ts'
import type { RefHead } from './head.ts'
import type { ToolEntry } from '../tools/catalog.ts'
import type { TreeEntry } from '../entries.ts'
import type { AgentId, CommitId, ContractId, LogSeq, RefName, RelPath, WriterId } from '../terms.ts'
import type { ActionAsk, RunAsk } from '../tools/execute.ts'
import type { Contract } from '../contract/types.ts'
import { checkpoint } from '../checkpoint.ts'
import { snapshotOf } from '../view/snapshot.ts'
import type { Stub } from './execute.ts'
import { HarnessError, createRuntime } from '../runtime/step.ts'
import type { AgentHandle, CallModel, StepResult, ToolCallRequest, ToolExecutor, ToolResult } from '../runtime/step.ts'
import { planBudget } from '../runtime/budget.ts'
import { calibrate, ratioOf, truthOf } from '../runtime/calib.ts'
import { assemble } from '../assemble/assemble.ts'
import { sourcesFor, stepsLeftTail } from '../assemble/sources.ts'
import type { Prefix } from '../assemble/contract.ts'
import { handoffAt, successorOf } from '../runtime/restart.ts'
import { refFor } from '../identity.ts'
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
 *
 * **期望不写死**：`head` 是这一格的 ref 缓存（`round/head.ts`），parent 与 CAS 期望都从它读。
 * 收尾这一次提交接在**模型自己的 `checkpoint` 之后**，所以这一栏必须是那一刻的头，
 * 不是轮次开始时的 `base`（PLAN § 5.16）。缓存里没有（一个 agent 一个格，`head` 由这一格建）
 * 就先从日志重建一次——`commitView` 是这一格最后一个同步点，它不该靠"前面有人调过"。
 */
export async function commitView(i: {
  readonly view: View
  readonly log: Log
  readonly truth: Truth
  readonly writer: WriterId
  readonly head: RefHead
  readonly msg: string
  /**
   * **提交之前要不要从日志重建那个头**。缺省 `true`——这是唯一正确的值。
   *
   * `false` 只给「把期望钉死」这条负对照用（§ 5.16 判据 5）：它把这一刻的头冻住，于是
   * 「期望与 ref 的实际值不一致」这件事可以直接造出来。产品路径上没有人传 `false`：
   * 那一栏不是策略开关，是「缓存要不要向权威对齐」——对齐是这一格的正常状态。
   */
  readonly refresh?: boolean
  /**
   * 提交落在哪一条 ref 上。**由调用点给**（不是从 writer 推的）：`fugue commit`（人侧）提交到
   * 主线，夹具要把底落到某一条 agent 分支上——"这一份产出属于哪一支"是调用点知道的事。
   */
  readonly ref: RefName
}): Promise<{ readonly commit: CommitId; readonly seq: LogSeq; readonly entries: number }> {
  const entries: TreeEntry[] = await snapshotOf(i.view)
  // **从日志重建一次**（判据 4 的兑现点：缓存只是缓存，重放是权威）。这一步是幂等的：
  // 日志没动时它与缓存里的值逐字节相同，而日志动了（比如模型在两步之间提交过）它就把
  // 缓存拉回权威那一侧——所以"收尾接在模型的最后一次 checkpoint 之后"是结构，不是巧合。
  if (i.refresh !== false) await i.head.refresh()
  const r = await checkpoint({
    log: i.log,
    truth: i.truth,
    writer: i.writer,
    entries,
    rev: i.view.rev,
    msg: i.msg,
    expectedOld: i.head.value,
    ref: i.ref,
  })
  i.head.commit(r.commit, r.seq)
  return { commit: r.commit, seq: r.seq, entries: r.entries }
}

/**
 * **这一格的 ref 头**（`round/head.ts` 那份缓存），导出它是为了让它能被指着看。
 *
 * `driveOnce` 自己用的是同一个调用（起跑时一次）——这一处只是把那一次单独交出来。
 * 为什么要交出来：判据 4 是「**缓存只是缓存**」——那份缓存可以任意作废、从日志重建一次，
 * 后续行为逐字节相同。它的兑现要能看到`refresh()` 前后（见 PLAN § 5.16 判据 4）。
 */
export function openRefHead(log: LogReader, writer: WriterId, from: CommitId | null = null): Promise<RefHead> {
  return refHeadOf(log, writer, from)
}

/**
 * 契约那一句人读的话（提交信息与交接都用它），**导出它是为了让它能被指着看**。
 *
 * 为什么要交出来：0.2.2 的变异审计里 `c.kind` 那两处变体判断一直是 survivor——`driver.test.ts`
 * 归真档，而快档里没有文件执行它；`goal.test.ts` 起把这两行收进快档的判据里（照 `openRefHead`
 * 先例：单独交出来，调用处一处不动）。
 */
export function goalOf(c: Contract): string {
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

/**
 * 契约那一格念的**收工那半句**（`sources.ts` 的 `stepsLeftTail` 第三个参数）。
 *
 * **导出是给预算核账用的**：这一句追加在工具回执后面，所以搜索回执留给结果行的那个预算
 * 必须容得下它（`src/tools/search-receipt.ts` 的 `MAX_RUNTIME_TAIL_BYTES`，由
 * `search-stop.test.ts` 对着这两处真正的句子核一遍）。
 */
export const AGENT_LAND_NOW =
  'Land the deliverable(s) now and hand in — the harness runs the assertions, so spend what is left on the files rather than on verifying them.'

/**
 * **契约那一格的"还剩几步"**（收工口径的第三面 · 推到子 agent 那一档）。
 *
 * 与持轮者那一格（`plan.ts` 的 `holderFace`）**同一个数**（`ask.maxSteps`，也就是循环停下来用的
 * 那个）· **同一处减法**（`sources.ts` 的 `stepsLeftTail`），只有收工那半句不同。由头见那一份的
 * 注释：第十六趟案一 cap 16 第五趟，一格 16 步里 10 步在视图之外找编译器，工作第 5–6 步就做完了。
 *
 * **不给上界就原样交回去**（不包一层）：没有上界就没有"还剩几步"可言，而空壳只会让 `ToolExecutor`
 * 那张脸多一层看不出差别的东西。
 */
function withStepsLeft(inner: ToolExecutor, maxSteps?: number): ToolExecutor {
  if (maxSteps === undefined) return inner
  return {
    async execute(call: ToolCallRequest, h: AgentHandle): Promise<ToolResult> {
      const r = await inner.execute(call, h)
      const tail = stepsLeftTail(Number(h.state.step), maxSteps, AGENT_LAND_NOW)
      return tail === '' ? r : { ...r, output: capReceipt(r.output + tail) }
    },
  }
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

  // **不给就是不设上界**（用户的决策，见 `runtime/step.ts` 那一段）：`undefined` 一路传下去，
  // 循环里那条守卫因此不成立——这一格走到它自己收工，或人喊停。
  const maxSteps = ask.maxSteps
  // **这一格的工具面**：围栏用这一格的根（`roots`），写走这一格的视图。
  const roots = ask.roots ?? createRoots(process.cwd())
  const me = agent as unknown as AgentId
  const ownedPaths = declaredSetOf(contract)

  /**
   * **这一格的沙箱策略**：一件事实，一次探。
   *
   * 这一格的两件事（W8 的冻结点第 2 · 3 句）：
   *   · **档取 `workspace-write`**：树挂成**可写**（`--bind`），产出直接落在树自己那一侧
   *     ——`overlayfs` 档是 `upper`，另两档就是 `merged`。**不绑声明目录**：`--bind` 的挂载点
   *     必须在树里先存在，而"声明一条产出**文件**"（`a.ts`）是最常见的形状，bwrap 在只读树上
   *     建不出它（实测 `Can't mkdir /work/a.ts: Read-only file system`）。可写面仍然由声明集
   *     封住：**回写只收声明集内的差异**，而集外的改动由 `undeclared()` 如实报出来。
   *   · **`binding` 不给**（`undefined`）：这一格没有"动作绑定"这件事，只有一棵可写的树。
   *     `resolvePolicy` 从 `binding` 读的只是"哪些目录要挂进树里"（`declaredDirs`），而这一档
   *     不挂任何声明目录——给了它，声明里那条**产出文件**（`a.ts`）会被读成一条挂载点，于是
   *     第二层（`landlock`）每跑一条命令都落一句"这一条不在，没给它开口子：…/merged/a.ts"
   *     （本地实测：那一句进了模型的 C 区，`grep` 的读数因此变成一句假报错）。
   *     产出面仍然由契约给（`declaredSetOf` → `ownedPaths`），回写那一支读的是它。
   */
  /**
   * **这一趟的围栏记过没有**（每格只在第一次起子进程时记一次）。
   *
   * 由头（第十五趟样本盘 · 案一）：`bash` 是这一格伸出去的那只手，而"伸出去看得见什么"
   * 在日志里一个字都没有——账上于是分不开"模型自己解出来的"与"它翻到了我们自己的账本"
   * （那一趟 `case-1-1` 读到了 `$OUT` 下这一趟的验收结果与请求实录）。一条 `run/confined`
   * 记一份策略值（与 `fugue run` 那条**同一个形状 · 同一个 `Policy`**），够判这一件事。
   */
  let fenceWritten = false
  let policy: Policy | null = null
  let policyDoc: ConfigDoc | null = null
  const policyNow = async (): Promise<Policy> => {
    if (policy === null) {
      const probed = probeLayers(roots)
      const doc = await readConfig(roots.realRoot)
      policyDoc = doc
      policy = resolvePolicy({
        roots,
        agent: me,
        doc,
        // **档是 `workspace-write`：回写这条反向通道要的就是树可写。**
        // 架构 § 8.9 那条反向通道的形状是“产出经声明集回写视图”——子进程先得**写得进去**，回写才有东西可回；
        // `read-only` 那一档把整棵树按只读挂进 `/work`，于是 `bash rm` 与 `bash >` 当场撞
        // `Read-only file system`（本地实测读到的就是这一句）——删除那一支根本走不到。`confine()` 的
        // `writable` 读的就是 `policy.mode`，所以这一栏同时决定了树那一条用 `--bind` 还是 `--ro-bind`。
        // 边界照旧封着：声明集内的差异才回写（`ownedPaths`），集外的改动由 `undeclared()`
        // 如实报出一条 `mat/reclaim`（声明集外的写**进不了提交**）。
        mode: 'workspace-write',
        probed,
      })
    }
    return policy
  }

  /**
   * **端口片按"日志里 writer 的次序"切**（与 `fugue run` 同一算法，见 `cli/cmd/execute.ts` 那一段）：
   * 同一批 agent 的两次跑拿到同一片。一轮内算一次缓存住——`writers()` 是日志读数，每条命令
   * 现算太贵，而这一轮之内 writer 集合不会变。
   */
  let portIndex: number | null = null
  const portIndexOf = async (): Promise<number> => {
    if (portIndex === null) {
      const writers = (await log.writers()).slice().sort()
      const at = writers.indexOf(writer)
      portIndex = at < 0 ? writers.length : at
    }
    return portIndex
  }


  /**
   * **围栏重新在场**（W8 § 5.15.b 步骤二）：模型从此够不到真实工作区——`bwrap` 包命令行、
   * `--chdir` 指物化根、真实工作区不进挂载。
   *
   * 挂载层不在 PATH 时**不静默退成裸跑**（那正是"工作区是只读的"这句话靠模型听话的那一类
   * 病）：抛一句指路的话，`host.run` 把它降成一次被拒的结果——模型拿到的是实话，地板那一档
   * 说的是变慢，不是跑不起来。
   */
  async function commandFor(ask: RunAsk): Promise<{ readonly argv: readonly string[]; readonly cwd: string }> {
    // 先把执行面立起来（fork + 铺视图）：`bash` 的命令行要按这一格包，而回写那一支要的
    // 那两份机制事实也从这一步来。
    await host.execCwd()
    // **缓存那两处先建出来**（架构 § 8.6 第 2 步）：`HOME` 与 `XDG_CACHE_HOME` 是这一档要
    // 挂进沙箱的落点，而 `--bind` 的源必须先存在（实测 `Can't find source path`）。
    const cache = cacheLayoutOf(roots, me)
    mkdirSync(cache.home, { recursive: true })
    mkdirSync(cache.xdgCache, { recursive: true })
    const p = await policyNow()
    // **这一趟的围栏**：一层一条（见 `fenceWritten` 那一段）。读它的只有一处——判这一趟的
    // 读数能不能当证据（`tools/scenario/board-node.ts` 的 `fence`）。放在这里而不是构造这一份
    // 的时候：`policyNow()` 是现探的，而"这一格到底包成了哪一档"只有包的时候才知道。
    if (!fenceWritten) {
      fenceWritten = true
      await log.append(writer, {
        t: 'run/confined',
        agent: me,
        mode: p.mode,
        enforcement: p.enforcement,
        net: p.net,
        layers: p.layers,
        reach: p.reach.roRoots,
      })
    }
    // **两档各有各的包法**（与 `fugue run` 那条路逐字同一条纪律）：
    //   · 挂载层在场：`confine` 包成 `bwrap`——“看得见什么”由它管，真实工作区不进挂载；
    //   · 挂载层不在场：`degradedArgv` 退到第二层（Landlock）——“写得动什么”由内核管；
    //   · 两层都不在：交给命令自己（它退非零），并落一条 `bound/deny`——工作区那句话今天没有
    //     强制点，读者要看得见这件事（架构 § 15.7 的“如实报告，绝不夸大”）。
    const line = shellArgv(ask.command)
    const cwdRel = (ask.cwd === '' ? '' : ask.cwd) as RelPath
    // **子进程的环境也从这里交**（P1a：架构 § 14.4 那条 envRealize 挂账的 round 侧收口）——
    // 基线（`boundary.env` 三档，缺省 `core`）+ 本 agent 的坐标 + 端口片。这一路修之前是
    // `spawn` 不带 env 整份继承宿主：HOME 是宿主的家、凭据键在沙箱里读得到。bash 不是
    // "动作绑定"，那个替身只为 `envFor` 的形状（它只读 `binding.env`——坐标与网都来自策略值）。
    const env = envFor({
      agent: me,
      binding: { name: 'bash', argv: line, cwd: '', outputs: [], cache: [], env: {}, net: 'none' },
      injections: {},
      portIndex: await portIndexOf(),
      range: portRangeOf(policyDoc ?? {}),
      policy: p,
    })
    if (p.layers.includes('bwrap')) {
      return {
        // **cwd 由宿主拼**（`execWorkdir` = 执行根 + 归一后的 cwd），不从这里给：这里给的绝对
        // 落点是**沙箱里**那个坐标（`/work/<cwd>`），宿主拿它去 `spawn` 会撞上一棵不存在的树。
        cwd: '',
        argv: confine({
          roots,
          agent: me,
          argv: line,
          cwd: cwdRel,
          // 不绑声明目录（见上面那一栏）：树整个挂成可写，产出落在树自己那一侧。
          declared: [],
          env: {},
          policy: p,
        }).argv,
        env,
      }
    }
    if (p.layers.includes('landlock')) {
      // 第二层那一档：子进程就在宿主上跑，`spawn` 的 cwd 由宿主拼（与挂载档同一个形状）。
      return { cwd: '', argv: degradedArgv(line, { roots, policy: p }).argv, env }
    }
    // **这一条拒也要落进日志**：它没有子进程可言，`run/end` 那条路不会替它记。
    // （原先这里读的是 `parts`——那一栏在这一份里不存在，走到这一支就是一次 `ReferenceError`；
    //   而这一支只有"两层都没有"时才到，单测与走查都没撞到过它。日志口在这一层就是 `log`。）
    await log.append(writer, {
      t: 'bound/deny',
      agent: me,
      path: ask.command,
      space: 'physical',
      rule: 'confine:none',
    })
    throw new Error(
      `这一趟跑不了子进程：两层的围栏都不在场（${p.enforcement}），而执行类工具要跑在物化树里。` +
        '装回 bwrap 或让第二层（Landlock）可用再跑；在那之前这一步只能靠 read / write / edit / glob / grep。',
    )
  }

  /**
   * **一个具名动作怎么跑**（P3b1 归真）：`readBinding` 把名字解析成绑定——argv = 绑定的 argv +
   * 模型的 `extra` 追加到尾 · cwd 用绑定的 · env 经 `envFor` 一处拼（`binding.env` + 基线 +
   * 坐标 + 端口片）。**与 `fugue run` 同一条纪律**，差别只在落点：这一格的执行面是 `execCwd()`
   * 那棵树（不绑声明目录、产出落树那一侧，回写归 `afterRun` 的 `ownedPaths`——见 `commandFor`
   * 上面那一段），而 `run/confined` 记的还是这一格那一份策略值（同一个 `policyNow()`，与 `bash`
   * 共用「每格记一次」那一道）。
   *
   * 名字没绑 → `BindingError` 原样抛给宿主，降成被拒的回执（那一句自带 actions 键的指路）。
   * **绑定那一栏的 `net` 这一格不读**：策略值是每格一份（`policyNow` 缓存），动作级的 net 要求
   * 要等「按动作出策略」那一档——记在疑点清单，不在这一格顺手做。
   */
  async function actionFor(ask: ActionAsk): Promise<CommandPlan> {
    // 先暖 `policyDoc`（`policyNow` 顺带把配置读了）：绑定从它读，别让第一次的解析读到空的那份。
    const p = await policyNow()
    const b = readBinding(policyDoc ?? {}, ask.action)
    // 与 `commandFor` 同两步：执行面立起来 · 缓存那两处先建出来（绑定的落点要它们）。
    await host.execCwd()
    const cache = cacheLayoutOf(roots, me)
    mkdirSync(cache.home, { recursive: true })
    mkdirSync(cache.xdgCache, { recursive: true })
    if (!fenceWritten) {
      fenceWritten = true
      await log.append(writer, {
        t: 'run/confined',
        agent: me,
        mode: p.mode,
        enforcement: p.enforcement,
        net: p.net,
        layers: p.layers,
        reach: p.reach.roRoots,
      })
    }
    const argv = [...b.argv, ...ask.extra]
    const env = envFor({
      agent: me,
      binding: b,
      injections: {},
      portIndex: await portIndexOf(),
      range: portRangeOf(policyDoc ?? {}),
      policy: p,
    })
    if (p.layers.includes('bwrap')) {
      return {
        // cwd 由宿主拼（与 `commandFor` 同一条理由）：沙箱里那一份进 `--chdir`。
        cwd: '',
        argv: confine({
          roots,
          agent: me,
          argv,
          cwd: b.cwd as RelPath,
          // 不绑声明目录（`commandFor` 那一栏的理由）：树整个挂成可写，产出落在树自己那一侧。
          declared: [],
          env: {},
          policy: p,
        }).argv,
        env,
      }
    }
    if (p.layers.includes('landlock')) {
      // 第二层那一档：子进程就在宿主上跑，spawn 的 cwd 由宿主按绑定的那一份拼。
      return { cwd: b.cwd, argv: degradedArgv(argv, { roots, policy: p }).argv, env }
    }
    // 两层都不在：与 `commandFor` 同一句拒——记一条 `bound/deny`，让读者看得见这一格没有强制点。
    await log.append(writer, {
      t: 'bound/deny',
      agent: me,
      path: ask.action,
      space: 'physical',
      rule: 'confine:none',
    })
    throw new Error(
      `这一趟跑不了子进程：两层的围栏都不在场（${p.enforcement}），而执行类工具要跑在物化树里。` +
        '装回 bwrap 或让第二层（Landlock）可用再跑；在那之前这一步只能靠 read / write / edit / glob / grep。',
    )
  }

  /**
   * **账上那一行**（`run/start` 的 `argv`/`cwd`）：`run_action` 的命令行就是 `actionFor` 解析
   * 出来的那一份——`readBinding` 是配置的纯读，两处各调一次读的是同一份，不是第二处状态。
   * 名字没绑返回 `null`（`dispatch` 那一侧退回模型问的那句，拒的话随后就到）。
   */
  const argvOf = async (
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly argv: readonly string[]; readonly cwd: string } | null> => {
    if (tool !== 'run_action') return null
    const name = typeof args['action'] === 'string' ? (args['action'] as string) : null
    if (name === null) return null
    const raw = args['args']
    const extra = Array.isArray(raw) ? (raw as unknown[]).filter((x): x is string => typeof x === 'string') : []
    await policyNow()
    try {
      const b = readBinding(policyDoc ?? {}, name)
      return { argv: [...b.argv, ...extra], cwd: b.cwd }
    } catch {
      return null
    }
  }

  /**
   * 这一格物化到哪一档、挂没挂。**回写那一支要它们**（`landingOf` 看档 · `undeclared` 看有
   * 没有 `upper` 可枚举），而两样都由 `fork` / `ensure` 定、记在 `mat/*` 事件里——所以问一次
   * 执行面（`host.execCwd()`），它每次回答时顺手把它们记在这儿。
   *
   * 它们在这一份里是**闭包里的两个格**，不是第二处状态：值是 `fork` 当时的返回值，而
   * `createReclaim` 那两个栏是 getter——回收在 `collect` 那一刻读到的是**那一刻的事实**，
   * 而不是构造这一份时的空值。
   */
  let strategyNow: ForkStrategy | null = null

  /**
   * **这一格 ref 的头**（PLAN § 5.16 冻结点：起跑重放，格内只缓存）。
   *
   * 与物化那一半（`execRoot` 里宿主自己重放的 `matState`）同一个形状：这一格的日志里最后一条
   * `ckpt/commit` 就是它，一条都没有就是 `null`（新仓库）。工具面的 `checkpoint` 与收尾的
   * `commitView` **读的是同一份**——所以「不与第二个账本并存」这句话在这一层就是这一个变量。
   *
   * **`base` 那一栏不许省**：这一格的视图铺在 `base` 上，而 `base` 在日志里没有 `ckpt/commit`
   * （台子的底由 git 落 · `fugue branch` 也能把 ref 挪到别处）。日志重放只往上加这一格自己
   * 推的那几次——起错头的症状是每一次提交都撞 CAS（施工当场撞到过，见 `head.ts` 那一段）。
   */
  const head: RefHead = await refHeadOf(log, writer, base)
  /**
   * 这一格**已经落下去的清单**（`ensure` 每次同步后交出来的那份）。回收拿它当减数：
   * `upper` 里那几条是我们自己落的，不是子进程写的。**不新开账**：它就是那一次 `ensure` 的回执。
   */
  let manifestNow: readonly RelPath[] = []

  /**
   * **命令跑完之后那棵树上还有没有这一条路径**（`ReclaimDeps.treeNow` 的实现）。
   *
   * `null` = 宿主还没说过（那一档按"有"算：宁可不报删除，也不报一条假的）。宿主在**卸载之前**
   * 装它上来——`afterRun()` 的第一件事就是卸载，所以这一栏的寿命只有那一次 `collect`。
   */
  let treeNow: ((rel: RelPath) => Promise<boolean>) | null = null

  const host = createToolHost(view, roots, {
    actions: { writer, log, truth, head },
    commandFor,
    // **动作那一条（P3b1）**：与 `commandFor` 同一道缝——名字按绑定解析，不再当 shell 命令跑。
    actionFor,
    ownedPaths,
    reclaim: createReclaim({
      roots,
      // **落到哪一档由 `fork` 定**：回收只在 `collect` 那一刻读它，所以给一个 getter——
      // `createReclaim` 在那一刻才取值，"先 fork 再回收"这条次序因此成立。
      get strategy() {
        return strategyNow
      },
      // **清单取当刻那份**（`onSync` 每次同步后更新它）：回收在 `collect` 那一刻才读它。
      get manifest() {
        return manifestNow
      },
      // **落点看机制，不看档**：这一格**不绑声明目录**（见 `commandFor` 那一栏的理由），所以
      // 子进程写的字节落在**树自己那一侧**——`overlayfs` 档是 `upper`，另两档就是 `merged`；
      // `landingOf` 看 `strategy` 选那一处。这一栏因此是常量，但它照旧明写：换回"绑定那一侧"
      // 只改这一处。
      landing: 'tree' as const,
      // **树是敞开的**：`workspace-write` 那一档把整棵树挂成可写，集外的改动**内核不拒**——
      // 所以 `undeclared()` 必须查（它靠枚举 `upper` 兑现，而这一格跑的是 `overlayfs`）。
      treeOpen: true,
      // **哪一棵底绑在这里**（`base` = 这一格的 `mat/fork.base`）：视图铺在它上面，物化也是
      // 从它铺出来的，所以"底里有没有这条路径"问的就是它。M6 只拿这两条读，不读日志。
      statAt: (path) => truth.statAt(base, path),
      listAt: (dir) => truth.listAt(base, dir),
      // **删除那一支的源一**：视图在这一条声明路径下动过哪些（`view.state().upper` 里的活路径与墓碑），
      // 以及其中哪几条此刻已经是墓碑（那一条删除已经在视图里了，不重复报）。
      // 两栏都现算：回写会推视图的 rev，一次算完的答案下一趟就旧了。
      isDeclared: (rel) => {
        const out: RelPath[] = []
        for (const e of view.state().upper) {
          if (e.path !== rel && !e.path.startsWith(rel + '/')) continue
          out.push(e.path)
        }
        return out.sort()
      },
      isTombstone: (p) => view.state().upper.some((e) => e.kind === 'tombstone' && e.path === p),
      // **命令跑完之后那棵树上还有没有它**：宿主在卸载之前把这一条读口装上来
      // （`execRoot.onTreeNow`）——卸载之后 `merged` 只剩一个空挂载点，再问就晚了。
      treeNow: async (p) => (treeNow === null ? true : await treeNow(p)),
    }),
    execRoot: {
      log,
      writer,
      truth,
      base,
      // **`fork` 交回它选的那一档**（`parts` 与 `fork` 自己算的是同一组坐标，所以这里不用它）。
      forkOf: async (parts) => fork({ roots, log, root: roots.realRoot }, me, base),
      // 每一次问执行面都顺手把两份机制事实记下来（回写要用）。
      onState: (r) => {
        strategyNow = r.strategy
      },
      // **回写那一支的删除判据要它**（见 `treeNow` 那一栏）：宿主在卸载之前把读口装上。
      onTreeNow: (f) => {
        treeNow = f
      },
      onSync: (m) => {
        manifestNow = m
      },
    },
  })
  const execute =
    ask.execute ??
    createToolExecutor({
      logOf: () => log,
      host,
      // **账上那一行（P3b1）**：`run_action` 的 `run/start` 记绑定解析出来的 argv——与实际要
      // spawn 的是同一条；`bash` 那一格没接它，照旧 shell 那句。
      argvOf,
      fenceOf: (raw, cwd) => {
        const got = roots.resolveVirtual(raw, cwd as RelPath)
        return got.ok ? { ok: true as const, value: got.value } : { ok: false as const, error: got.error }
      },
      // **这一格的写入面**（`declaredSetOf(contract)`）：与上面 `ownedPaths` 那一栏**同一个值**
      // ——回收只收声明集内的产出，写也只许写声明集内。由头见 `DispatchDeps.writeScope`。
      writeScope: ownedPaths,
      ensureOf: () => Promise.resolve(),
    })
  // **这一格的"还剩几步"**：与持轮者那一格同一个数、同一处减法，收工那半句换成"把产物落下去"。
  const gated = withStepsLeft(execute, maxSteps)
  const runtime = createRuntime({
    logOf: () => log,
    call: ask.call as CallModel,
    execute: gated,
    ...(ask.tools === undefined ? {} : { tools: ask.tools }),
  })
  // **产出先写进视图**（契约那几样），再让循环跑：循环负责"说话与调工具"，产出这件事归契约。
  if (opts.deliver !== undefined) await opts.deliver(view, contract, agent)

  const commits: LogSeq[] = []
  const handoffs: string[] = []
  /** 这一格已经量到的那些比值（真 ÷ 估；每次调用最多加一份）。 */
  const ratios: number[] = []
  let handle: AgentHandle = { ...ask.handle, agent, state: ask.state }
  let steps = 0
  let handedOff = false
  let stopped = '收敛'
  // **起手那一下也交一次**：这一格干完之后视图里那一份就是产出，而"提交"这件事在循环外面
  // （循环只管说话与调工具）。**顺序与架构 § 9.3 那三步一致**：视图先有内容，再走 `checkpoint()`。
  for (;;) {
    // **这里不给工具目录那一段**（`tools: ''`）：循环这一层不认识目录，给了它等于把公布面绑进
    // 运行时。派发前那一份占用（`occupancyOf`）把目录算了进去，于是那一个是完整的一笔、这一个
    // 差了目录那一段。判"该不该交接"用的是这一笔，所以它偏松的一侧——而真读数会把这段差补回来
    // （用量里带着工具 schema，比值吸收的就是它）。
    const budget = planBudget({
      decl: ask.decl,
      prefix: prefixOf(handle),
      tools: '',
      seed: goalOf(contract),
      handoff: '',
      calib: calibrate(ratios),
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
    // **真读数修正下一次判**（架构 § 8.15 的 `usage` 是唯一权威）：这一趟的用量与刚才那一笔估账
    // 比一次。真读数在调用之后才有，所以它改的是下一步，不是当步；没有读数就不修。
    const ratio = ratioOf(truthOf(r.outcome.usage), budget.raw)
    if (ratio !== null) ratios.push(ratio)
    handle = { ...handle, state: r.next }
    if (r.outcome.kind === 'done') break
    // **交一次就够**（缺省只交一次）：触发点是一个数，而"这一格该不该换人"不是每一步都重新判的
    // ——反复交接会把同一格切成三四段，而每一段都要重读一遍 Zone A + Zone B。
    if (!handedOff && budget.kind === 'restart' && ask.handoff !== false) {
      // 交接：写一条 `agent/handoff`，把状态交给后继（同一分支上换一个 `AgentId`）。
      // 交接只有子 agent 那一格会走（持轮者那一格没有契约、也没有交接），所以坐标一定在——
      // 但类型上是 `| null`，这里当场说清"缺了它就没法给后继拼产物路径"（架构 § 8.11 的 B 区）。
      if (handle.coord === null) {
        throw new HarnessError('no-coord', '这一格没有坐标：交接要拿它给后继拼产物路径（架构 § 8.11）')
      }
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
      handle = { ...handle, state: successorOf(handle.state, out.prompt) }
    }
    if (maxSteps !== undefined && steps >= maxSteps) {
      stopped = `到了你给的上界（${maxSteps} 步）`
      break
    }
  }


  const committed = await commitView({
    view,
    log,
    truth,
    writer,
    head,
    msg: `（${agent}）${goalOf(contract)}`,
    ref: refFor(writer),
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
