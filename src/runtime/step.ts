// 步进执行器：全系统执行最频繁的那个操作。出处：架构 § 14.2（`Runtime.step` 的六步 ·
// `StepOutcome` 的三种 · "**`runtime` 是零工具调用率的观测点**" · "`runtime` 不认识沙箱、
// 不认识虚拟化"）· § 8.11 的验证性质（相邻两步仅 C 变化）· § 8.13（`M12` 只做转移）·
// § 8.15（指标钩子挂在这里）。PLAN § 5.8 的 `B4`：**接口冻结点**——`B5` 的工具面接线 ·
// `B6` 的预算与交接 · `B7` 的读数全押在这几个形状上，所以它单独停、不攒。
//
// **六步逐字对应架构那一份**（每一条都在下面的 `step()` 里指得出来）：
//
//   1. `prefix = M10.assemble(protocol, state)`   —— 装配（纯函数，不碰模型）
//   2. `resp   = llm.call(prefix, tools)`          —— 一次调用（`CallModel`）
//   3. `calls  = parseToolCalls(resp)`             —— 分片拼成工具调用（`B1` 的 `checkEvents`）
//   4. `results = calls.map(dispatch)`             —— 执行（`ToolExecutor`；**这一层不认识沙箱**）
//   5. `M0.log.append(...)`                        —— 落日志（`prefix/assemble` 与 `llm/call` 各一条）
//   6. `→ 下一状态`                                 —— 工具结果进 C 区那个积累段
//
// **这一层不认识沙箱、不认识虚拟化**（架构 § 14.2 第二条设计要点）：它手里只有两个注入的接缝
// ——`CallModel`（怎么调模型）与 `ToolExecutor`（怎么执行一次工具调用）。策略、围栏、物化都在
// 它们下面。所以这一份里没有一处 `if (action === …)`：那类分岔归 `B5` 的派发表。
//
// **它也不取凭据。** 发到哪儿（`Target`：host · 路 · 头）是**调用方装进句柄里的**，而拼那个
// `Target` 的地方（`B3` 的 `targetOf`）是唯一调 `authOf()` 的。于是这一份里没有一条路径会因为
// "没有密钥"而失败——除非真的要发一次真请求（PLAN § 5.8 的口径一）。
//
// **三档 `StepOutcome` 是"为什么停"**（架构那一份的形状，逐字）：`continue` · `done` · `failed`。
// 它们的判据是**调用的收尾原因**（`B1` 的 `StopReason` 六种），所以 `B4` 的断言 ③ 才成立：
//
//   `tool-calls` → `continue`（它要调工具）· `end-turn` → `done`（它说完了）·
//   `max-tokens` / `stop-sequence` / `refusal` / `incomplete` → `failed`（它没能说完，
//   而**不是"结束了"**）——最后一档是**上游自己说"这一趟没走完"**（它忙不过来 / 被打断了 /
//   那一趟太长停了），原话进那一句错话，因为"要不要过一会儿再来一次"取决于原话。
import type { Log } from '../log/events.ts'
import type { AgentId, BranchId, ContractId, LogSeq, StepId, WriterId } from '../terms.ts'
import type { ModelCall, ModelEvent, StopReason, Thinking, ThinkingLevel, Turn, Usage } from '../model/contract.ts'
import { checkEvents } from '../model/contract.ts'
import type { Target, Transport } from '../model/http.ts'
import type { WireFacts } from '../model/http.ts'
import { callModel, wireFactsOf, wireRequestOf } from '../model/http.ts'
import type { WireAdapter } from '../model/wire/stream.ts'
import { parseStream } from '../model/wire/stream.ts'
import type { Prefix, Protocol } from '../assemble/contract.ts'
import { assemble, hashOf } from '../assemble/assemble.ts'
import { cZoneHeadOf } from '../assemble/sources.ts'
import { sourcesFor, turnText } from '../assemble/sources.ts'
import { promptCacheFor } from '../model/contract.ts'
import type { AgentCoord, AssembleState } from '../assemble/sources.ts'
import type { ToolEntry } from '../tools/catalog.ts'
import type { ModelId } from '../terms.ts'

/**
 * 一个 agent 在这一步手里有什么。**它不认识沙箱、不认识策略**（架构 § 14.2）。
 *
 * `coord` 是装配要的那份坐标（产物路径机械追加在"我的任务"的末尾，§ 8.12）；`contract` 是这一格
 * 活的键，进事件、不进前缀（§ 8.11：`id` · `agent` · `branch` 是系统的键）；`state` 是这一步
 * 先看到的状态（上一步那六步的第 6 步产出的那一份）。
 *
 * `target` 与 `adapter` 是**这一层与 `B2`/`B3` 的那道缝**：发到哪儿、走哪条线协议。运行时只把
 * 它们原样传下去——它不认识 host、不认识头、不取凭据。
 */
export interface AgentHandle {
  readonly agent: AgentId
  /**
   * 这一格的坐标（产物路径那一栏来自它）。**持轮者那一格是 `null`**（架构 § 8.11：它手里是
   * 全部契约，不是一份），于是「我的任务」那一段的产物路径没有来源——而持轮者那一份协议里
   * 本来就没有那一段（`sourcesFor` 的 `who` 那一栏同一个意思）。
   *
   * 它是 `| null` 而不是"给一个空坐标"：空坐标是一条**假**的坐标（它说这个 agent 没有产物
   * 路径），而"没有 agent 这一栏"与"这个 agent 的产物路径是空的"是两件事——差别只在将来
   * 有人往持轮者那份协议里加一段读坐标的段时才会现形，而那时它是一个静默的错误。
   */
  readonly coord: AgentCoord | null
  readonly branch: BranchId
  readonly contract: ContractId
  readonly protocol: Protocol
  /** 我们这边的键（进 `llm/call` 的 `model` 那一栏）。 */
  readonly model: ModelId
  /** 提供方那边叫什么（进请求体的 `model` 那一栏）。 */
  readonly wireModel: string
  readonly target: Target
  readonly adapter: WireAdapter
  readonly state: AssembleState
  /**
   * 轮内固定的调用配置（架构 § 10.2 的必固四条之一）：温度 · 输出预算 · **思考档**。
   *
   * `thinking` 原先不在这两个类型里（`RuntimeRequest.call` 同病），可它是 `ModelDecl.call` 的
   * 第三个字段、适配器一直在读它——运行时这一侧只是**转手**，类型窄一栏不会当场红（没有编译
   * 步骤），代价是"这一层不认识思考"这句话看着像真的。这一栏补上的是同一个事实的另一半。
   */
  readonly call?: { readonly temperature?: number; readonly maxTokens?: number; readonly thinking?: ThinkingLevel }
}

/** 一次工具调用（`B1` 的 `ToolCall` 的别名：名字 · 原样的参数 JSON 文本 · 那条线给的 id）。 */
export type ToolCallRequest = ModelCall['toolCalls'][number]

/** 一次工具调用的结果：一段文本 + 它是不是失败。**失败也是一种结果**（要进 C 区被看见）。 */
export interface ToolResult {
  readonly ok: boolean
  readonly output: string
  /**
   * **这一格到这儿为止**（`exit_plan_mode` 那一类交卷的工具给）。
   *
   * 运行时把它读成一次 `done`：与模型自己说完同一档，而**它是机械地停在这里**——不是"没话说"
   * 也不是失败。判据还是那条：停因要能说得清是"收敛"。
   */
  readonly halt?: boolean
}

/** 怎么执行一次工具调用。**这一层不认识沙箱**：策略 · 围栏 · 视图都在实现那一侧（`B5`）。 */
export interface ToolExecutor {
  execute(call: ToolCallRequest, h: AgentHandle): Promise<ToolResult>
}

/** 一次调用的输入：装配出来的那一份 + 这一次用哪条路 + 公布哪些工具。 */
export interface RuntimeRequest {
  readonly target: Target
  readonly adapter: WireAdapter
  readonly prefix: Prefix
  readonly tools: readonly ToolEntry[]
  /** 已经走过的那几步（发原生轮次用；第 0 步没有）。 */
  readonly turns?: readonly Turn[]
  /**
   * **C 区那一段的头**（`AssembleState.runtime` 的字节）：只追加那条尾巴之前的字节。
   *
   * 它必须单独带过去：`turns` 一有值，适配器就把尾巴发成原生轮次，而**头照旧要发**——不然
   * 人说的那一句从第 1 步起就再也读不到（架构 § 8.11：「那句话进的是这一趟的尾端（C 区第一
   * 条）」）。空串就不带（那时 `zones.C` 与它逐字节相同）。
   */
  readonly cHead?: Uint8Array
  /** 提供方那边什么名字（`ModelRequest.model`）。 */
  readonly model: string
  readonly call?: { readonly temperature?: number; readonly maxTokens?: number; readonly thinking?: ThinkingLevel }
}

/** 第 2 步的出口：事件流 + 一次调用的账。 */
export interface ModelReply {
  readonly events: AsyncIterable<ModelEvent>
  /**
   * 流停下来之后才有值。半截的流是 `call: null` + `failure` 有话说（与 `B3` 同一个口径：
   * 没 `stop` 就不算一次调用）。
   */
  ledger(): { readonly call: ModelCall | null; readonly failure: string | null }
}

/**
 * 怎么调一次模型。**运行时只认识这一个接缝。**
 *
 * 产品实现是 `wireCall`（`B3` 的 `callModel`：真网络或夹具）；测试里的实现是一个"一串脚本化的
 * 响应"的假模型。**两者在 `step()` 眼里没有区别**——这就是断言 ④ 说"用假模型驱动它"的落点。
 */
export type CallModel = (request: RuntimeRequest, signal: AbortSignal) => ModelReply

/**
 * 一步之后是什么。**三档，与架构 § 14.2 逐字一致。**
 *
 * `usage` 是一次调用的用量（四个数，可缺；缺了是 `null`——这一层不改那个口径）。`failed` 那一档
 * 带 `error`：一个 `HarnessError`（这一层自己的失败），不是模型说的话。
 */
export type StepOutcome =
  | { readonly kind: 'continue'; readonly usage: Usage | null }
  | { readonly kind: 'done'; readonly usage: Usage | null }
  | { readonly kind: 'failed'; readonly error: HarnessError }

/** 一步里这一层自己的失败：流半截 · 工具执行器抛了 · 没能说完 · 步数到顶。 */
export class HarnessError extends Error {
  /** 一个短的分类（`cut-stream` · `tool-threw` · `max-tokens` · `step-limit` …）：读日志的人先看它。 */
  readonly why: string
  /**
   * 上游给的那几个事实（可选）——**它不是新的一族事件**：填进已有的 `llm/call`。
   *
   * 失败那一档原先只剩一句话在 stderr 上，而"上游为什么没让它走完"（状态码 · 请求号 · 限流）
   * 是排障唯一要的几样。成功那一路没有这一栏。
   */
  readonly facts?: Readonly<Record<string, string | number>>
  constructor(why: string, message: string, facts?: Readonly<Record<string, string | number>>) {
    super(message)
    this.why = why
    if (facts !== undefined) this.facts = facts
  }
}

/** 一次 `step()` 的全部产出：三档之一 + 下一步的状态 + 落下去的日志位置。 */
export interface StepResult {
  readonly outcome: StepOutcome
  readonly next: AssembleState
  /** 这一步落的那些事件的位置（按落下去的顺序）。**每一步两条**（`prefix/assemble` · `llm/call`）。 */
  readonly seqs: readonly LogSeq[]
}

/**
 * **「这一格最多走几步」没有缺省值——它是用户的决策，不是我们的兜底。**
 *
 * 一处定，三处读：运行时那道兜底的上界（`RuntimeDeps.maxSteps`）· 驱动那道花钱的上界
 * （`DriverAsk.maxSteps`）· 写进「我的任务」发给模型的那个数（`AssembleState.maxSteps`）。
 * 三处读的是**同一个缺少**：不给 `--max-steps` 就处处不设，于是"它以为还剩几步"与"真正停下来
 * 的那个数"不会各自漂（W11 那一轮真档照出来的那一处）。
 *
 * 不设的代价说在明处：一个转圈的会话会一直花真钱。兜底的两样是**账**与**人**——每一步落一条
 * `llm/call`（花了多少一条条看得见），停不停由人（人喊停那一档 · 终端的 Ctrl-C）。机器不替人
 * 省这道决策：给一个"合理的缺省 64"看着体贴，实际是把"这一趟最多花多少"从命令面挪进了一个
 * 没人看过的常量。
 */

export interface RuntimeDeps {
  /**
   * 这个 agent 自己的日志口。**每落一条开一个口、落完就关**（一次命令一个 writer：
   * `hold.ts` 那条禁令要防的是"同一个 writer 的序号被两个进程领到"）。
   */
  readonly logOf: (a: AgentId) => Log
  readonly call: CallModel
  readonly execute: ToolExecutor
  /** 工具目录（`M9.schema()`）。**缺省不带工具**——不带也可以，那时模型没有手。 */
  readonly tools?: readonly ToolEntry[]
  /** 一步最多走几圈。**不给就是不设上界**——上界是用户的决策（`--max-steps`），不是我们的兜底。 */
  readonly maxSteps?: number
}

export interface Runtime {
  /** 一步。**架构 § 14.2 那六步。** */
  step(h: AgentHandle, signal: AbortSignal): Promise<StepResult>
  /** `step` 至收敛（`continue` 就一直走）。返回最后那一步与走过的步数。 */
  run(h: AgentHandle, signal: AbortSignal): Promise<{ readonly last: StepResult; readonly steps: number }>
}

/**
 * 产品实现：走 `B3` 那条路（**唯一碰网的那一处**）。它把"这一次调用"翻译成 `ModelRequest`
 * （三区按区带 · 工具 · 调用配置），再交给 `callModel`。
 *
 * **真网络档 · 回放档 · 夹具档在这份代码里没有分岔**：分岔全在**传输**那一层（`Transport`），
 * 而传输是调用方给的——真网络（缺省 `fetchTransport`）· 读一份录下来的目录（`wireInTransport`）·
 * 测试里那条夹具传输。这一层一个 `if` 都没有。
 */
export function wireCallOver(transport?: Transport): CallModel {
  return (request, signal) => {
    const stream = callModel(request.target, wireRequestOf(request), transport, signal)
    return {
      events: stream.events,
      ledger: () => {
        const l = stream.ledger()
        return { call: l.call, failure: l.failure }
      },
    }
  }
}

/** 产品那一档：走真网络（`callModel` 的缺省传输）。 */
export const wireCall: CallModel = wireCallOver()

/**
 * 一个假模型：一串脚本化的响应，按**第几次被调**取第几条（用完了就一直用最后一条）。
 *
 * 它是 `B4` 断言 ④ 的驱动：三区稳定性这件事在假模型下**照旧成立**——因为稳定性是装配与循环的
 * 性质，不是模型的性质。
 */
export function scriptedModel(scripts: readonly (readonly ModelEvent[])[]): CallModel {
  let at = 0
  return () => {
    const events = scripts[Math.min(at, scripts.length - 1)] ?? []
    at += 1
    return {
      events: (async function* (): AsyncGenerator<ModelEvent> {
        for (const e of events) yield e
      })(),
      ledger: () => ({ call: checkEvents(events), failure: null }),
    }
  }
}

/** 一个假执行器：把每次调用记下来，回一段确定的文本。 */
export function recordingExecutor(
  make: (call: ToolCallRequest, at: number) => ToolResult,
): ToolExecutor & { readonly seen: ToolCallRequest[] } {
  const seen: ToolCallRequest[] = []
  return {
    seen,
    async execute(call: ToolCallRequest): Promise<ToolResult> {
      seen.push(call)
      return make(call, seen.length - 1)
    },
  }
}

/** 这一步那个 `Turn`：模型说了什么 + 调了哪几条 + 每条回了什么（**逐条对位**）。 */
function turnOf(
  said: string,
  done: readonly { readonly id: string | null; readonly name: string; readonly arguments: string; readonly output: string; readonly isError: boolean }[],
  thinking: Thinking | null,
): Turn {
  return {
    ...(thinking === null ? {} : { thinking }),
    ...(said === '' ? {} : { text: said }),
    calls: done.map((d) => ({ id: d.id, name: d.name, arguments: d.arguments })),
    results: done.map((d) => ({ id: d.id, output: d.output, isError: d.isError })),
  }
}

/**
 * 收尾原因 → 三档。**这一处就是"为什么停"的判据**（架构 § 14.2 的 `StepOutcome`）。
 *
 * `raw` 是给 `incomplete` 那一档用的：**上游到底说的是哪一个**（`insufficient_system_resource` ·
 * `aborted` · `pause_turn`）在那一句话里要看得出来——我们这边的动作是同一件（这一趟不算数），
 * 而"要不要过一会儿再来一次"取决于原话，所以原话不能只留在事件的 `rawStop` 上。
 */
function outcomeOf(stop: StopReason, usage: Usage | null, said: string, raw: string | null = null): StepOutcome {
  switch (stop) {
    case 'tool-calls':
      return { kind: 'continue', usage }
    case 'end-turn':
      return { kind: 'done', usage }
    case 'max-tokens':
      return { kind: 'failed', error: new HarnessError('max-tokens', '输出预算用完了（`max-tokens`）：它没说完') }
    case 'stop-sequence':
      return { kind: 'failed', error: new HarnessError('stop-sequence', `撞上了停止串（\`stop-sequence\`）：${said.slice(0, 120)}`) }
    case 'refusal':
      return { kind: 'failed', error: new HarnessError('refusal', `它拒了（\`refusal\`）：${said.slice(0, 120)}`) }
    // **上游自己说"这一趟没走完"**：这不是它的话说完了，也不是我们的预算用完了——所以这一档
    // 不许当 `done`。原话进那一句（`raw === null` 时也说得出"它没给原话"）。
    case 'incomplete':
      return {
        kind: 'failed',
        error: new HarnessError(
          'incomplete',
          `上游说这一趟没走完（${raw ?? '它没给原话'}）：这一趟不算数，要再来一次是一次**新的调用**`,
        ),
      }
  }
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const tools = deps.tools ?? []
  const maxSteps = deps.maxSteps

  /** 兜底：驱动没给账、但事件都在手上——自己积一次（**与真模型同一个口径**）。 */
  function safeCall(events: readonly ModelEvent[]): ModelCall | null {
    try {
      return checkEvents(events)
    } catch {
      return null
    }
  }

  async function step(h: AgentHandle, signal: AbortSignal): Promise<StepResult> {
    const seqs: LogSeq[] = []
    // ── 1. 装配（纯函数，不碰模型）
    const prefix = assemble({ protocol: h.protocol, model: h.model, segments: sourcesFor(h.protocol, h.state, h.coord) })
    const request: RuntimeRequest = {
      target: h.target,
      adapter: h.adapter,
      prefix,
      tools,
      promptCache: promptCacheFor(h.adapter.name),
      model: h.wireModel,
      // 走过的那几步：**有才带**。第 0 步与交接后的第一步都是“没有”——没有就发 C 区那条文本
      // （两条路都不改 A/B 两区的字节，前缀那笔账不破）。
      ...(h.state.turns === undefined || h.state.turns.length === 0 ? {} : { turns: h.state.turns }),
      // C 区那一段的**头**（人说的那一句 · 这一趟的开场）：**每一步都带**。组成规则的定义处是
      // `assemble/sources.ts` 的 `cZoneHeadOf`——C 区那一段 = 头 + 只追加的尾巴，尾巴走 `turns`。
      ...(cZoneHeadOf(h.state) === '' ? {} : { cHead: new TextEncoder().encode(cZoneHeadOf(h.state)) }),
      ...(h.call === undefined ? {} : { call: h.call }),
    }
    // ── 5a. `prefix/assemble`：三区指纹（`B3` 的断言 ② 要的那三个数）
    seqs.push(
      await deps.logOf(h.agent).append(h.agent as WriterId, {
        t: 'prefix/assemble',
        agent: h.agent,
        zoneAHash: hashOf(prefix.zoneA),
        zoneBHash: hashOf(prefix.zoneB),
        zoneCHash: hashOf(prefix.zoneC),
      }),
    )

    // ── 2. 一次调用。**这一层不认识线协议**：`deps.call` 后面是 `B3` 的传输或一串脚本。
    const reply = deps.call(request, signal)
    const events: ModelEvent[] = []
    let call: ModelCall | null = null
    let failure: string | null = null
    /** 上游给的那几个事实：**只有失败那一路才有**（成功那一路是 `null`）。 */
    let facts: Readonly<Record<string, string | number>> | null = null
    try {
      for await (const e of reply.events) events.push(e)
      const l = reply.ledger()
      call = l.call
      failure = l.failure
    } catch (err) {
      // 半截的流：**记一条 `llm/call`（`stop: null`）并报失败**，不重试（`B3` 断言 ④ 那条纪律）。
      failure = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      // 上游的原话从**抛出来的那个错误对象**上读（`B3` 的传输把它挂在那里）。读不到就是没有。
      facts = wireFactsOf(err)
    }
    if (call === null && failure === null) {
      call = safeCall(events)
      if (call === null) failure = '这一条流没有给出账，也没说为什么——半截的响应当不了完整的用'
    }

    // ── 3. 工具调用（分片那一段已经在 `B1` 的账里收过口了）
    const calls = call?.toolCalls ?? []
    const usage: Usage | null = call?.usage ?? null
    // ── 5b. `llm/call`：模型 · 步 · 工具调用条数 · 用量四个数
    seqs.push(
      await deps.logOf(h.agent).append(h.agent as WriterId, {
        t: 'llm/call',
        agent: h.agent,
        step: String(h.state.step) as StepId,
        model: h.model,
        wire: h.target.wire.name,
        // **这一趟声明了哪一档思考**（`null` = 声明里没写这一栏，与 `off` 是两件事）。
        // 记的是**我们声明的那一档**，不是适配器补出来的那一档：`openai.ts` 把没写翻成
        // `disabled`、`anthropic.ts` 把没写翻成一个字段都不发，两处都记会在日志里漂。
        thinking: h.call?.thinking ?? null,
        toolCount: tools.length,
        invocations: calls.length,
        usage: {
          inputTokens: usage?.inputTokens ?? null,
          cacheReadTokens: usage?.cacheReadTokens ?? null,
          cacheWriteTokens: usage?.cacheWriteTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          // 思考那一部分是输出里的明细（不在钱那四样里）：记它不动账，但"想了多少"只有它能量到。
          reasoningTokens: usage?.reasoningTokens ?? null,
        },
        // 提供方自己的原话来自**收尾那一条事件**（`checkEvents` 把它放在账的 `rawStop` 上）。
        // **`usage` 里原先也留了一栏同名**，两条线都想从 `usage` 对象里读它，而那个字段不在
        // `usage` 里——它一路是 `null`（序 27 删掉了那一栏，读数一条都没有过）。
        rawStop: call?.rawStop ?? null,
        stop: call?.stop ?? null,
        // 上游给的那几个事实：**只有失败那一路才有**（状态码 · 请求号 · 限流那几条）。
        // 成功那一路这里是 `null`——**默认档一个字节都不多**。
        status: facts === null ? null : ((facts['status'] as number | undefined) ?? null),
        headers: facts,
      }),
    )

    // 半截的流：三档里的 `failed`（**不许当"走完了"**）。
    if (call === null || call.stop === null) {
      return {
        outcome: { kind: 'failed', error: new HarnessError('cut-stream', failure ?? '这一条流没走完') },
        next: h.state,
        seqs,
      }
    }

    // ── 4. 执行那几条工具调用。**这一层不认识沙箱**：执行器是注入的。
    /** 这一趟里有没有工具叫停（停在门口那一档）。 */
    let halted = false
    /** 这一步的往返：调了哪几条 · 每条回了什么（发原生轮次与渲染 C 区用的是同一份）。 */
    const done: { readonly id: string | null; readonly name: string; readonly arguments: string; readonly output: string; readonly isError: boolean }[] =
      []
    const said = call.text
    for (const one of calls) {
      let r: ToolResult
      try {
        r = await deps.execute.execute(one, h)
      } catch (err) {
        return {
          outcome: {
            kind: 'failed',
            error: new HarnessError(
              'tool-threw',
              `执行 ${one.name} 的时候抛了：${err instanceof Error ? err.message : String(err)}`,
            ),
          },
          next: h.state,
          seqs,
        }
      }
      if (r.halt === true) halted = true
      done.push({ id: one.id, name: one.name, arguments: one.arguments, output: r.output, isError: !r.ok })
    }

    // ── 6. 下一状态：C 区那个积累段**只追加**（架构 § 8.11 的验证性质）。
    // **有工具叫停就到这儿为止**（停在门口那一档）：它是"收敛"，与模型自己说完同一档。
    const outcome = halted ? { kind: 'done' as const, usage } : outcomeOf(call.stop, usage, said, call.rawStop)
    // 这一步什么都没发生（没说话、也没调工具）——不追加一个空的 `Turn`：空的一步会让
    // `上一步结果` 变成空串，而"这一步无事发生"与"上一步的结果丢了"是两件事。
    // **想过也算发生过**：只想不说、也没伸手的一步，它的思考照样要留在轮次里——带工具时
    // 不回传就是 400（上游那一页的 Tool Calls 一节），所以"安静"这一档必须把思考算进去。
    const quiet = said === '' && done.length === 0 && call.thinking === null
    const next: AssembleState = quiet
      ? { ...h.state, step: h.state.step + 1 }
      : {
          ...h.state,
          step: h.state.step + 1,
          // `上一步结果` 与 `运行时上下文` 都是 C 区的段：前者是"刚过去那一步"，后者是那条只追加的尾巴。
          // **C 区那一段文本里不渲染思考**：思考走原生轮次那一路（`Turn.thinking`），写进文本面
          // 等于同一份东西发两遍，还把那一段每步都变的字节撑大。
          lastStep: turnText(turnOf(said, done, call.thinking)),
          turns: [...(h.state.turns ?? []), turnOf(said, done, call.thinking)],
        }
    return { outcome, next, seqs }
  }

  return {
    step,
    async run(h: AgentHandle, signal: AbortSignal): Promise<{ readonly last: StepResult; readonly steps: number }> {
      let cur = h
      let steps = 0
      for (;;) {
        const r = await step(cur, signal)
        steps += 1
        if (r.outcome.kind !== 'continue') return { last: r, steps }
        if (maxSteps !== undefined && steps >= maxSteps) {
          return {
            last: {
              outcome: { kind: 'failed', error: new HarnessError('step-limit', `到了你给的上界（${maxSteps} 步）——停在这里，不替你猜还能不能收敛`) },
              next: r.next,
              seqs: r.seqs,
            },
            steps,
          }
        }
        cur = { ...cur, state: r.next }
      }
    },
  }
}

/** `parseStream` 的转发：给要用**原始字节流**驱动的地方（假提供方那一档 · `B5` 起）。 */
export function eventsFrom(adapter: WireAdapter, chunks: AsyncIterable<Uint8Array>): AsyncIterable<ModelEvent> {
  return parseStream(adapter, chunks)
}
