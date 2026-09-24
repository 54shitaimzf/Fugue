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
// 它们的判据是**调用的收尾原因**（`B1` 的 `StopReason` 五种），所以 `B4` 的断言 ③ 才成立：
//
//   `tool-calls` → `continue`（它要调工具）· `end-turn` → `done`（它说完了）·
//   `max-tokens` / `stop-sequence` / `refusal` → `failed`（它没能说完，而**不是"结束了"**）
import type { Log } from '../log/events.ts'
import type { AgentId, BranchId, ContractId, LogSeq, StepId, WriterId } from '../terms.ts'
import type { ModelCall, ModelEvent, StopReason, Usage } from '../model/contract.ts'
import { checkEvents } from '../model/contract.ts'
import type { Target } from '../model/http.ts'
import { callModel } from '../model/http.ts'
import type { WireAdapter } from '../model/wire/stream.ts'
import { parseStream } from '../model/wire/stream.ts'
import type { Prefix, Protocol } from '../assemble/contract.ts'
import { assemble, hashOf } from '../assemble/assemble.ts'
import { sourcesFor } from '../assemble/sources.ts'
import type { AgentCoord, AssembleState } from '../assemble/sources.ts'
import type { ToolEntry } from '../tools/catalog.ts'
import type { ModelId } from './contract.ts'

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
  readonly coord: AgentCoord
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
  /** 轮内固定的调用配置（架构 § 10.2 的必固四条之一）。 */
  readonly call?: { readonly temperature?: number; readonly maxTokens?: number }
}

/** 一次工具调用（`B1` 的 `ToolCall` 的别名：名字 · 原样的参数 JSON 文本 · 那条线给的 id）。 */
export type ToolCallRequest = ModelCall['toolCalls'][number]

/** 一次工具调用的结果：一段文本 + 它是不是失败。**失败也是一种结果**（要进 C 区被看见）。 */
export interface ToolResult {
  readonly ok: boolean
  readonly output: string
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
  /** 提供方那边什么名字（`ModelRequest.model`）。 */
  readonly model: string
  readonly call?: { readonly temperature?: number; readonly maxTokens?: number }
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
  constructor(why: string, message: string) {
    super(message)
    this.why = why
  }
}

/** 一次 `step()` 的全部产出：三档之一 + 下一步的状态 + 落下去的日志位置。 */
export interface StepResult {
  readonly outcome: StepOutcome
  readonly next: AssembleState
  /** 这一步落的那些事件的位置（按落下去的顺序）。**每一步两条**（`prefix/assemble` · `llm/call`）。 */
  readonly seqs: readonly LogSeq[]
}

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
  /** 一步最多走几圈（预算那条线上界之外的兜底：防一个不收敛的循环）。**缺省 64**。 */
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
 * **夹具档与真网络档在这份代码里没有分岔**：分岔在 `Target` 里（`from: 'decl' | 'fixture'`），
 * 而那是调用方拼的。
 */
export const wireCall: CallModel = (request, signal) => {
  const stream = callModel(
    request.target,
    {
      model: request.model,
      zones: { A: request.prefix.zoneA, B: request.prefix.zoneB, C: request.prefix.zoneC },
      tools: request.tools,
      ...(request.call === undefined ? {} : { call: request.call }),
    },
    undefined,
    signal,
  )
  return {
    events: stream.events,
    ledger: () => {
      const l = stream.ledger()
      return { call: l.call, failure: l.failure }
    },
  }
}

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

/** 工具结果那一段文本：写进 C 区那个积累段（模型下一步看得到自己上一步干了什么）。 */
function toolTurn(at: number, call: ToolCallRequest, r: ToolResult): string {
  return `${r.ok ? '工具' : '工具（失败）'} ${call.name}（第 ${at + 1} 条）：\n${r.output}`
}

/** 收尾原因 → 三档。**这一处就是"为什么停"的判据**（架构 § 14.2 的 `StepOutcome`）。 */
function outcomeOf(stop: StopReason, usage: Usage | null, said: string): StepOutcome {
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
  }
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const tools = deps.tools ?? []
  const maxSteps = deps.maxSteps ?? 64

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
      model: h.wireModel,
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
    try {
      for await (const e of reply.events) events.push(e)
      const l = reply.ledger()
      call = l.call
      failure = l.failure
    } catch (err) {
      // 半截的流：**记一条 `llm/call`（`stop: null`）并报失败**，不重试（`B3` 断言 ④ 那条纪律）。
      failure = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
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
        toolCount: tools.length,
        invocations: calls.length,
        usage: {
          inputTokens: usage?.inputTokens ?? null,
          cacheReadTokens: usage?.cacheReadTokens ?? null,
          cacheWriteTokens: usage?.cacheWriteTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
        },
        // 提供方自己的原话来自**收尾那一条事件**（`checkEvents` 把它放在账的 `rawStop` 上），
        // 不是来自用量那一条（`usage.rawStop` 在两条线上常常是 null）。
        rawStop: call?.rawStop ?? null,
        stop: call?.stop ?? null,
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
    const turns: string[] = []
    const said = call.text
    if (said !== '') turns.push(`模型：${said}`)
    let at = 0
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
      turns.push(toolTurn(at, one, r))
      at += 1
    }

    // ── 6. 下一状态：C 区那个积累段**只追加**（架构 § 8.11 的验证性质）。
    const outcome = outcomeOf(call.stop, usage, said)
    const next: AssembleState = {
      ...h.state,
      step: h.state.step + 1,
      // `上一步结果` 与 `运行时上下文` 都是 C 区的段：前者是"刚过去那一步"，后者是那条只追加的尾巴。
      lastStep: turns.length === 0 ? h.state.lastStep : turns.join('\n'),
      ...(turns.length === 0 ? {} : { turns: [...(h.state.turns ?? []), ...turns] }),
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
        if (steps >= maxSteps) {
          return {
            last: {
              outcome: { kind: 'failed', error: new HarnessError('step-limit', `走了 ${steps} 步还没收敛（上限 ${maxSteps}）`) },
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
