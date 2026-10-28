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
import { callModel, wireFactsOf, wireRequestOf } from '../model/http.ts'
import { wireNamed } from '../model/wire/registry.ts'
import type { WireAdapter } from '../model/wire/stream.ts'
import type { Prefix, Protocol } from '../assemble/contract.ts'
import { assemble, hashOf } from '../assemble/assemble.ts'
import { sourcesFor } from '../assemble/sources.ts'
import { humanTextOf, wireTurnsOf, withFact } from '../assemble/facts.ts'
import { promptCacheFor } from '../model/contract.ts'
import type { AgentCoord, AssembleState } from '../assemble/sources.ts'
import type { ToolEntry } from '../tools/catalog.ts'
import type { AskItem } from '../tools/execute.ts'
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
  /**
   * **这一趟从别的格带回来的问题**（U18 甲案）。与 `halt` 同一档：一次调用的一件结构化的事，
   * 由执行器那一侧递上来，运行时**不认识它是问谁**——只把它原样带出这一步（`StepResult.asks`）。
   */
  readonly asks?: readonly AskItem[]
}

/** 怎么执行一次工具调用。**这一层不认识沙箱**：策略 · 围栏 · 视图都在实现那一侧（`B5`）。 */
export interface ToolExecutor {
  execute(call: ToolCallRequest, h: AgentHandle): Promise<ToolResult>
  /**
   * **这一趟的这几条一起跑**，结果**按传进来的次序**交回来（本版）。
   *
   * 为什么它在这一道缝上而不是在运行时里：哪几条能叠着跑是**工具面**的事（"这条工具跑一次会不会
   * 动东西"住在能力表那一处），而运行时那一层按定义不认识工具。所以运行时只问一句"你能不能一
   * 次收一批"，收不收、怎么收，由执行器答。
   *
   * **不给这一栏就是"一次一条"**：运行时照旧一条一条调 `execute`（旧串行档一个字不动）。给了它，
   * 结果的下标必须与 `calls` 的下标一一对应——**模型回执按原调用序**这一条是它的契约，不是调用方
   * 的自觉（对应的断言在 `src/runtime/batch.test.ts`）。
   *
   * **抛就是这一趟失败**（与 `execute` 同一条）：抛哪一条不影响判决，而运行时只看见"这一步失败"。
   */
  executeAll?(calls: readonly ToolCallRequest[], h: AgentHandle): Promise<readonly ToolResult[]>
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

/**
 * 编码一份请求要的那几样（**不含 `target`**：编码不碰它；真发的时候才用得上）。
 *
 * 它是“同一份投影”的输入：`runtime/step.ts` 发出去的那一份、预算量的那一份、占用表量
 * 的那一份都从这里过——三处各拼一遍的话，预算与请求就会静默地不是同一份。
 */
export interface RequestParts {
  readonly protocol: Protocol
  readonly model: ModelId
  readonly wireModel: string
  readonly adapter: { readonly name: string }
  readonly call?: { readonly temperature?: number; readonly maxTokens?: number; readonly thinking?: ThinkingLevel }
  readonly state: AssembleState
  readonly coord: AgentCoord | null
}

/** 这一份请求的线协议参数：**只此一处**（`step()` 与预算读的是同一份投影）。 */
function wireAskOf(p: RequestParts, tools: readonly ToolEntry[]): Parameters<typeof wireRequestOf>[0] {
  const prefix = assemble({ protocol: p.protocol, model: p.model, segments: sourcesFor(p.protocol, p.state, p.coord) })
  // 同一份事实的两个投影：头是文本的那一半；尾巴是原生轮次的那一半（判词折进回合的
  // `notes`——`wireTurnsOf`）。文本预览按段取，不吃 `notes`。
  const head = humanTextOf(p.state.facts)
  const turns = wireTurnsOf(p.state.facts)
  return {
    adapter: p.adapter,
    prefix,
    model: p.wireModel,
    tools,
    ...(turns.length === 0 ? {} : { turns }),
    ...(head === '' ? {} : { cHead: new TextEncoder().encode(head) }),
    ...(p.call === undefined ? {} : { call: p.call }),
  }
}

/** 这一步要发出去的那份请求（运行时的 `RuntimeRequest`）。 */
export function requestOf(
  h: RequestParts & { readonly target: Target },
  tools: readonly ToolEntry[],
): RuntimeRequest {
  return {
    target: h.target,
    adapter: h.adapter,
    promptCache: promptCacheFor(h.adapter.name),
    ...wireAskOf(h, tools),
  }
}

/**
 * **编码后的那一份**：预算读的就是它。
 *
 * 与 `callModel` 里 `t.wire.bytes(r)` 编的是同一份（同一处 `wireAskOf` 的投影 + 同一个目标
 * wire 的适配器）。`target` 不参与——它只说发到哪儿，不改字节。
 */
export function requestBodyOf(h: RequestParts, tools: readonly ToolEntry[]): Uint8Array {
  return wireNamed(h.adapter.name).bytes(wireRequestOf(wireAskOf(h, tools)))
}

/** 第 2 步的出口：事件流 + 一次调用的账。 */
export interface ModelReply {
  readonly events: AsyncIterable<ModelEvent>
  /**
   * 流停下来之后才有值。半截的流是 `call: null` + `failure` 有话说（与 `B3` 同一个口径：
   * 没 `stop` 就不算一次调用）。`attempts` 是每一次尝试的状态码（P2f，恒 ≥ 1 条——假模型
   * 那一档也是一次即成 `[200]`）。
   */
  ledger(): { readonly call: ModelCall | null; readonly failure: string | null; readonly attempts: readonly number[] }
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
  /**
   * 这一步里那几条工具**从别的格带回来的问题**（U18 甲案：`ask_user_question` 在子 agent 那一格
   * 的出口）。空/缺席都是"这一步没有"——轮次那一层据此收下并裁断。
   */
  readonly asks?: readonly AskItem[]
  /**
   * 这一步**有没有把工具调用交下去过**（执行了哪怕一条也是 `true`；缺席 = 没有）。
   *
   * 读它的是驱动那一层的回退闸：已执行工具的失败不换脸重跑——副作用已经落了，回退模型看不到
   * 那一批回执，重跑这一步等于给它一个重放写的机会（2026-10-26 外部审查 3.1 的判决）。
   */
  readonly executed?: boolean
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

interface RuntimeDeps {
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
        return { call: l.call, failure: l.failure, attempts: l.attempts }
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
      // **半截的那一档也交得出账**（与产品那一档同一个口径）：脚本里没有 `stop`，`checkEvents`
      // 核得出"没收尾"，账上就是 `call: null` + 一句为什么——而不是把那次核对的原样抛出去。
      // 抛出去的话 `step()` 的 catch 里还要再读一次账（拿 attempts），第二次抛就没人接了：
      // "半截的流"这一档于是根本造不出来（cut-stream 的断言全红在这里）。
      ledger: () => {
        try {
          return { call: checkEvents(events), failure: null, attempts: [200] }
        } catch (err) {
          return { call: null, failure: err instanceof Error ? `${err.name}: ${err.message}` : String(err), attempts: [200] }
        }
      },
    }
  }
}

/** 一个假执行器：把每次调用记下来，回一段确定的文本。 */
export function recordingExecutor(
  make: (call: ToolCallRequest, at: number) => ToolResult,
): ToolExecutor & { readonly seen: ToolCallRequest[] } {
  const seen: ToolCallRequest[] = []
  /** 一条：记下来再交给那份脚本。两条入口共用它（与产品那两份包装层同一个形状）。 */
  const one = async (call: ToolCallRequest): Promise<ToolResult> => {
    seen.push(call)
    return make(call, seen.length - 1)
  }
  return {
    seen,
    execute: one,
    // **一批也记下来**（`at` 照旧是一次一条的次序）：假执行器不出现在批量那一档的话，
    // "运行时把那几条一起交下去"这句话在单测里就量不到（`src/runtime/batch.test.ts` 用它）。
    executeAll: async (calls: readonly ToolCallRequest[]): Promise<readonly ToolResult[]> => {
      const out: ToolResult[] = []
      for (const call of calls) out.push(await one(call))
      return out
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

/** `llm/call` 那一条的全部事实——**工具步与裁断共用这一份构造**（一处字段次序，两处消费）。 */
export interface LlmCallFacts {
  readonly agent: AgentId
  readonly step: string
  readonly model: string
  readonly wireName: string
  readonly thinking: ThinkingLevel | null
  readonly toolCount: number
  readonly invocations: number
  readonly ms: number
  readonly usage: Usage | null
  readonly rawStop: string | null
  readonly stop: ModelCall['stop']
  readonly status: number | null
  readonly headers: Readonly<Record<string, string | number>> | null
  readonly attempts: readonly number[]
  /** 只在裁断那一笔带（`llm/call.role`）：缺席 = 工具步。 */
  readonly role?: 'ruler'
}

/** 一笔 `llm/call` 事件（字段次序与语义只在这一处说一遍）。 */
export function llmCallEvent(f: LlmCallFacts) {
  return {
    t: 'llm/call' as const,
    agent: f.agent,
    step: f.step as StepId,
    model: f.model,
    wire: f.wireName,
    // **这一趟声明了哪一档思考**（`null` = 声明里没写这一栏，与 `off` 是两件事）。
    // 记的是**我们声明的那一档**，不是适配器补出来的那一档：`openai.ts` 把没写翻成
    // `disabled`、`anthropic.ts` 把没写翻成一个字段都不发，两处都记会在日志里漂。
    thinking: f.thinking,
    toolCount: f.toolCount,
    invocations: f.invocations,
    // **这一趟花了多久**：区间读数，与 `run/end.ms` 同一个格子；旧日志里没有这一栏。
    ms: f.ms,
    usage: {
      inputTokens: f.usage?.inputTokens ?? null,
      cacheReadTokens: f.usage?.cacheReadTokens ?? null,
      cacheWriteTokens: f.usage?.cacheWriteTokens ?? null,
      outputTokens: f.usage?.outputTokens ?? null,
      // 思考那一部分是输出里的明细（不在钱那四样里）：记它不动账，但"想了多少"只有它能量到。
      reasoningTokens: f.usage?.reasoningTokens ?? null,
    },
    // 提供方自己的原话来自**收尾那一条事件**（`checkEvents` 把它放在账的 `rawStop` 上）。
    rawStop: f.rawStop,
    stop: f.stop,
    // 上游给的那几个事实：**只有失败那一路才有**（状态码 · 请求号 · 限流那几条）。
    // 成功那一路这里是 `null`——**默认档一个字节都不多**。
    status: f.status,
    headers: f.headers,
    // 试了几次（P2f）：每一次的状态码（`0` = 没拿到状态码那一档）。**恰一次时整栏不出现**
    // ——没声明重试的默认档一个字节都不多，旧日志回放照旧。
    ...(f.attempts.length > 1 ? { attempts: [...f.attempts] } : {}),
    ...(f.role === undefined ? {} : { role: f.role }),
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
    const request = requestOf(h, tools)
    // ── 5a. `prefix/assemble`：三区指纹（`B3` 的断言 ② 要的那三个数）
    seqs.push(
      await deps.logOf(h.agent).append(h.agent as WriterId, {
        t: 'prefix/assemble',
        agent: h.agent,
        zoneAHash: hashOf(request.prefix.zoneA),
        zoneBHash: hashOf(request.prefix.zoneB),
        zoneCHash: hashOf(request.prefix.zoneC),
      }),
    )

    // ── 2. 一次调用。**这一层不认识线协议**：`deps.call` 后面是 `B3` 的传输或一串脚本。
    // 两头各取一次单调钟：这是**区间读数**（`llm/call` 那一栏 `ms`），不是时刻——信封上不落时刻。
    const started = performance.now()
    const reply = deps.call(request, signal)
    const events: ModelEvent[] = []
    let call: ModelCall | null = null
    let failure: string | null = null
    /** 上游给的那几个事实：**只有失败那一路才有**（成功那一路是 `null`）。 */
    let facts: Readonly<Record<string, string | number>> | null = null
    /** 试了几次（P2f）：账里恒有 ≥1 条（传输层记的），成功那一路通常就是 `[200]`。 */
    let attempts: readonly number[] = []
    try {
      for await (const e of reply.events) events.push(e)
      const l = reply.ledger()
      call = l.call
      failure = l.failure
      attempts = l.attempts
    } catch (err) {
      // 半截的流：**记一条 `llm/call`（`stop: null`）并报失败**——要不要再来一次由传输层
      // 按提供方的重试档决定（P2f），到了这里就是终态。
      failure = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      // 上游的原话从**抛出来的那个错误对象**上读（`B3` 的传输把它挂在那里）。读不到就是没有。
      facts = wireFactsOf(err)
      // 流抛了之后账读得出来（`done` 在它的 `finally` 里已置位）：终态之前试了几次，从这里拿。
      attempts = reply.ledger().attempts
    }
    if (call === null && failure === null) {
      call = safeCall(events)
      if (call === null) failure = '这一条流没有给出账，也没说为什么——半截的响应当不了完整的用'
    }

    /** 这一趟（含把流读完）的耗时读数：毫秒整数，与 `run/end.ms` 同一个格子。 */
    const ms = Math.round(performance.now() - started)

    // ── 3. 工具调用（分片那一段已经在 `B1` 的账里收过口了）
    const calls = call?.toolCalls ?? []
    const usage: Usage | null = call?.usage ?? null
    // ── 5b. `llm/call`：模型 · 步 · 工具调用条数 · 用量四个数
    seqs.push(
      await deps.logOf(h.agent).append(
        h.agent as WriterId,
        llmCallEvent({
          agent: h.agent,
          step: String(h.state.step),
          model: h.model,
          wireName: h.target.wire.name,
          thinking: h.call?.thinking ?? null,
          toolCount: tools.length,
          invocations: calls.length,
          ms,
          usage,
          rawStop: call?.rawStop ?? null,
          stop: call?.stop ?? null,
          status: facts === null ? null : ((facts['status'] as number | undefined) ?? null),
          headers: facts,
          attempts,
        }),
      ),
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
    //
    // **这一趟的调用一起交下去**（`executeAll`）：哪几条能叠着跑是工具面的事（只读那四条并行、
    // 写串行），运行时只问一句"你能不能一次收一批"。**不给这一栏就是一次一条**——旧串行档。
    // **次序照原样**：结果按下标对位（`calls[i]` 的回执就是 `results[i]`），这一条是回执按原调用
    // 序归位的机制侧兑现。
    let results: readonly ToolResult[]
    try {
      results =
        calls.length === 0
          ? []
          : deps.execute.executeAll !== undefined
            ? await deps.execute.executeAll(calls, h)
            : await serialExecute(deps.execute, calls, h)
    } catch (err) {
      return {
        outcome: {
          kind: 'failed',
          error: new HarnessError(
            'tool-threw',
            `执行工具的时候抛了：${err instanceof Error ? err.message : String(err)}`,
          ),
        },
        next: h.state,
        seqs,
        executed: true,
      }
    }

    /** 这一趟里有没有工具叫停（停在门口那一档）。 */
    let halted = false
    /** 这一趟里那几条工具带回来的问题（U18 甲案）。 */
    const raised: AskItem[] = []
    /** 这一步的往返：调了哪几条 · 每条回了什么（发原生轮次与渲染 C 区用的是同一份）。 */
    const done: { readonly id: string | null; readonly name: string; readonly arguments: string; readonly output: string; readonly isError: boolean }[] =
      []
    const said = call.text
    for (let at = 0; at < calls.length; at += 1) {
      const one = calls[at] as ToolCallRequest
      const r = results[at]
      // **一条都不能少**：少一条就是"那一次调用没有回执"，而 C 区那一侧会把这一步读成"它没伸手"
      // ——静默地少一件事。执行器那一侧有对应的断言（`src/runtime/batch.test.ts`）。
      if (r === undefined) {
        return {
          outcome: {
            kind: 'failed',
            error: new HarnessError('tool-threw', `执行 ${one.name} 之后没有拿到回执：这一批回执比调用少了一条`),
          },
          next: h.state,
          seqs,
          executed: true,
        }
      }
      if (r.halt === true) halted = true
      if (r.asks !== undefined) raised.push(...r.asks)
      done.push({ id: one.id, name: one.name, arguments: one.arguments, output: r.output, isError: !r.ok })
    }

    // ── 6. 下一状态：C 区那个积累段**只追加**（架构 § 8.11 的验证性质）。
    // **有工具叫停就到这儿为止**（停在门口那一档）：它是"收敛"，与模型自己说完同一档。
    const outcome = halted ? { kind: 'done' as const, usage } : outcomeOf(call.stop, usage, said, call.rawStop)
    // 这一步什么都没发生（没说话、也没调工具、也没想）——不追加一条空回合：空的一步会让
    // 「上一步结果」变成空串，而"这一步无事发生"与"上一步的结果丢了"是两件事。
    // **想过也算发生过**：只想不说、也没伸手的一步，它的思考照样要留在轮次里——带工具时
    // 不回传就是 400（上游那一页的 Tool Calls 一节），所以"安静"这一档必须把思考算进去。
    const quiet = said === '' && done.length === 0 && call.thinking === null
    // **一步就是一条回合事实**（只追加）。「上一步结果」不再另写一份字符串：它是这条事实的
    // 文本投影（`facts.ts` 的 `lastStepTextOf`）——从前 `turns` 与 `lastStep` 写的是同一个值，
    // 现在只有一份。**思考不进文本投影**（它走原生轮次那一路）。
    const next: AssembleState = quiet
      ? { ...h.state, step: h.state.step + 1 }
      : {
          ...h.state,
          step: h.state.step + 1,
          facts: withFact(h.state.facts, { kind: 'turn', turn: turnOf(said, done, call.thinking) }),
        }
    return {
      outcome,
      next,
      seqs,
      ...(calls.length > 0 ? { executed: true } : {}),
      ...(raised.length === 0 ? {} : { asks: raised }),
    }
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

/**
 * 退化档：执行器没给 `executeAll` 就一条一条来。**它与从前那一份逐字节同形**（同一个
 * `for` 循环 · 同一条"抛了就到这儿"的口径）——"并行缺席退串行"这句话就落在这一处。
 */
async function serialExecute(
  execute: ToolExecutor,
  calls: readonly ToolCallRequest[],
  h: AgentHandle,
): Promise<readonly ToolResult[]> {
  const out: ToolResult[] = []
  for (const one of calls) out.push(await execute.execute(one, h))
  return out
}
