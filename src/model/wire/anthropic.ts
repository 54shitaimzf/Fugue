// Anthropic Messages 那条线：请求体与事件流（架构 § 10.3 的"Messages 优先"）。PLAN § 5.8 的 `B2`。
//
// **形状来自两处**：Anthropic 官方的 Messages 流式文档（`message_start` · `content_block_start` ·
// `content_block_delta` · `content_block_stop` · `message_delta` · `message_stop` · `ping`），以及
// DeepSeek 那家声明了覆盖的那条路 `/anthropic/v1/messages`（`B0` 的读数：无凭据 401，路在；
// P2e 起这段特化住 `wireOverrides`，线协议表里留的是标准 `/v1/messages`）。
//
// **翻译的三条规矩**（`B2` 的断言 ② 量的就是这三条）：
//
//   一 · **文本**：`content_block_delta` 里 `delta.type === 'text_delta'` 的 `text` → 我们的 `delta`。
//   二 · **工具调用**：`content_block_start` 里 `content_block.type === 'tool_use'` → `tool-start`
//        （`id` 与 `name` 那一刻就有）；接着每一片 `input_json_delta` 的 `partial_json` → `tool-delta`；
//        `content_block_stop` 那一条 → `tool-call`（参数就是拼起来的那一串）。**三段各有各的事件**。
//   三 · **用量**：`message_start` 的 `message.usage` 给输入那三个数，`message_delta` 的 `usage`
//        给输出那一个数——**所以它是并起来的，不是一条事件给的**（`usageUpdate` 就是干这个的）。
//
// **不认识的 `content_block` 类型跳过、不报错**：那条线上还有 `thinking` 之类的东西，它们不是
// 我们的事件，而"多了一种块"不该让整条流断掉。反过来，**不认识的 `stop_reason` 要报**——
// 结束原因是 `B4` 那三档判据的输入（`StepOutcome` 的 continue/done/failed），猜一个会让循环
// 按错的原因往下走。
import type { ModelEvent, StopReason, ThinkingLevel, Turn, Usage } from '../contract.ts'
import type { WireAdapter } from './stream.ts'
import { WireError, bodyOf, wireHeadOf } from './stream.ts'
import { THINKING_LEVELS } from '../contract.ts'

/** 请求里那几样这一份要用到的：三区字节 · 提供方那边的模型名 · 工具目录 · 调用配置。 */
interface MessagesRequest {
  readonly model: string
  readonly zones: { readonly A: Uint8Array; readonly B: Uint8Array; readonly C: Uint8Array }
  readonly tools?: readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[]
  readonly call?: { readonly temperature?: number; readonly maxTokens?: number; readonly thinking?: ThinkingLevel }
  /** 断点发不发（`WIRES` 那一栏，经 `promptCacheFor` 带过来）。 */
  readonly promptCache?: 'explicit' | 'implicit'
  /** 已经走过的那几步（给了就发原生轮次，不给就照旧发 C 区那条文本）。 */
  readonly turns?: readonly Turn[]
  /** C 区那一段的**头**（人说的那一句）：有轮次时它照旧要发。见 `wireHeadOf`。 */
  readonly cHead?: Uint8Array
}

/**
 * 一步 → 这一条线上那一对消息。**不变式在这里核**：一条 `tool_result` 的 `tool_use_id` 必须对
 * 得上同一步里某个 `tool_use` 的 id——对不上就抛，不静默发出一个错的请求体。
 */
function turnMessages(turn: Turn, at: number): Record<string, unknown>[] {
  const said: Record<string, unknown>[] = []
  // **思考块排在最前**：这条线上它就是助理消息的第一块（顺序是形状的一部分），而带工具时
  // 它必须原样回传——`signature` 一起带上，缺了签名这块就不成立了。
  if (turn.thinking !== undefined && (turn.thinking.text !== '' || turn.thinking.signature !== null)) {
    said.push({
      type: 'thinking',
      thinking: turn.thinking.text,
      ...(turn.thinking.signature === null ? {} : { signature: turn.thinking.signature }),
    })
  }
  if (turn.text !== undefined && turn.text !== '') said.push({ type: 'text', text: turn.text })
  const ids: string[] = []
  turn.calls.forEach((c, i) => {
    // 这条线给 id，有些兼容实现不给（contract.ts 那条读数）——不给就自己编一个，而它必须与
    // 下面那条 `tool_result` 是同一个：**编也只编一处**。
    const id = c.id ?? `tool_${at}_${i}`
    ids.push(id)
    let input: unknown = {}
    try {
      input = c.arguments === '' ? {} : JSON.parse(c.arguments)
    } catch {
      input = {}
    }
    said.push({ type: 'tool_use', id, name: c.name, input })
  })
  const results = turn.results.map((r, i) => {
    const id = r.id ?? ids[i] ?? `tool_${at}_${i}`
    if (!ids.includes(id)) {
      throw new Error(
        `第 ${at} 步有一条结果的 tool_use_id 对不上这一步里任何一个 tool_use：${id}` +
          `（这一步调的是 ${ids.join(' · ') || '（一条都没有）'}）`,
      )
    }
    return {
      type: 'tool_result',
      tool_use_id: id,
      content: r.output,
      ...(r.isError ? { is_error: true } : {}),
    }
  })
  const out: Record<string, unknown>[] = []
  if (said.length > 0) out.push({ role: 'assistant', content: said })
  if (results.length > 0) out.push({ role: 'user', content: results })
  return out
}

/**
 * `stop_reason` → 我们那五种。**不认识的当场拒**（理由见头注最后一段）。
 *
 * `tool_use` → `tool-calls`：那是"它要调工具"，与 OpenAI 那侧的 `tool_calls` 是同一件事。
 */
const STOP_OF: Readonly<Record<string, StopReason>> = {
  tool_use: 'tool-calls',
  end_turn: 'end-turn',
  max_tokens: 'max-tokens',
  stop_sequence: 'stop-sequence',
  refusal: 'refusal',
  // `pause_turn`：这条线说"这一趟太长，我停在这儿了"（官方那一页的建议是把这一次的回应原样带回去
  // 接着走）。我们这一版的循环没有"接着走"这一档，所以它归 `incomplete`——**与原话一起**留着，
  // 将来要支持"续跑"时，判据是 `rawStop === 'pause_turn'` 这一条读数。
  pause_turn: 'incomplete',
}

/** 声明里那一栏 → 一个真档位。没写就是 `off`（这条线上不写就是不开，两边一致）。 */
function thinkingOf(v: ThinkingLevel | undefined): ThinkingLevel {
  if (v === undefined) return 'off'
  if (!THINKING_LEVELS.includes(v)) throw new WireError(`没有这一档思考：${String(v)}（有的是 ${THINKING_LEVELS.join(' · ')}）`)
  return v
}

const usageOf = (u: Record<string, unknown> | undefined): Partial<Usage> | null => {
  if (u === undefined) return null
  const num = (k: string): number | null => (typeof u[k] === 'number' ? (u[k] as number) : null)
  const out: Partial<Usage> = {
    inputTokens: num('input_tokens'),
    cacheReadTokens: num('cache_read_input_tokens'),
    cacheWriteTokens: num('cache_creation_input_tokens'),
    outputTokens: num('output_tokens'),
    // 思考 token **这条线不报**：Anthropic 那一份 `usage` 里没有这一项，所以它是 `null`——不拿
    // `output_tokens` 顶（那会把"没量到"写成"量到了"）。
  }
  return Object.values(out).some((v) => v !== null) ? out : null
}

/** 一次工具调用在流里的状态：三段之间那点东西（id · name · 参数分片）。 */
interface ToolInFlight {
  readonly id: string | null
  readonly name: string | null
  args: string
}

interface MessagesState {
  readonly blocks: Map<number, ToolInFlight>
  /**
   * 这条流上落过的文本。**它不在发给调用方的事件里**（`delta` 那一条就是内容本身，再攒一遍是重复），
   * 攒它是给 `B4` 的回合历史用的：一次调用结束后总得有一份"这一回合它说了什么"。
   */
  readonly text: string[]
  rawStop: string | null
}

/** 这一条线的适配器。名字取 PLAN § 5.8 的 `B2` 行：一份 `wireOf()` 给请求体与事件流。 */
/**
 * `system` 那一栏：隐式那一档是一段纯文本；显式那一档是内容块数组，末尾一个断点。
 *
 * **断点放在内容的末尾**：它声明的是"到这里为止的内容是一个缓存单元"，放开头等于什么都没说。
 * 空串不发给断点（那一栏就不出现内容块），它与"隐式那一档的空串"逐字节相同。
 */
function systemField(a: Uint8Array, breakpoint: boolean): unknown {
  const text = new TextDecoder().decode(a)
  if (!breakpoint) return text
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
}

/**
 * 一条 user 消息的内容：要给断点时是内容块数组，否则是纯文本。
 *
 * **只有 B 区那一条给**：它跨步稳定（架构 § 8.11），断点放它末尾等于把 A+B 一起定成缓存
 * 单元；C 区是只追加的那一段，每一步都变，给它放断点没有意义。
 */
function userContent(text: string, breakpoint: boolean): unknown {
  if (!breakpoint) return text
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
}

export function wireOf(): WireAdapter {
  return {
    name: 'anthropic-messages',

    bytes(r: unknown): Uint8Array {
      const req = r as MessagesRequest
      // 三区按区带过来，拼成这一条线上的形状：A 区是 `system`（那条线上系统提示词不在 messages 里），
      // B 区与 C 区各一条 user 消息——**区与区的分界是装配的结论**，这里只翻译，不重排。
      const messages: Record<string, unknown>[] = []
      const b = new TextDecoder().decode(req.zones.B)
      if (b !== '') messages.push({ role: 'user', content: userContent(b, req.promptCache === 'explicit') })
      // **C 区那一段的头先发，原生轮次跟在它后面。** 头与尾巴是两件事：尾巴有 `turns` 时发成
      // 轮次，而人说的那一句在头里——原先写成"有轮次就整段不发"，于是那句话从第 1 步起就没了
      // （架构 § 8.11「那句话进的是这一趟的尾端（C 区第一条）」，读法在 `wireHeadOf`）。
      const c = new TextDecoder().decode(wireHeadOf(req))
      if (c !== '') messages.push({ role: 'user', content: c })
      if (req.turns !== undefined && req.turns.length > 0) {
        // **原生轮次**：模型看得见自己伸手的那一下（训练时就见过的那对形状）。
        for (const [at, turn] of req.turns.entries()) messages.push(...turnMessages(turn, at))
      }
      return bodyOf({
        model: req.model,
        // `max_tokens` 在那条线上是**必填**，所以这里必须有个数兜底；真的那个数由声明给（`B6` 填
        // `call.maxTokens`）。`?? 4096` 是**兜底常数，不是默认值**——它在疑点清单上。
        max_tokens: req.call?.maxTokens ?? 4096,
        // 系统提示词在这一条线上是**顶层的 `system` 字段**，不是 messages 里的第一条。DeepSeek 那一侧
        // 只吃字符串（给数组会被 400 拒掉），所以这里发字符串。
        // **断点那一档要把 `system` 换成内容块数组**（纯文本发不出断点——架构 § 10.3 说
        // Messages 的断点是显式数据）。隐式那一档照旧一串纯文本：那是 DeepSeek 那一侧今天
        // 认的形状（`src/model/contract.ts` 的 `WIRES` 里那一段读数）。
        system: systemField(req.zones.A, req.promptCache === 'explicit'),
        messages,
        // **流式是一个请求侧的声明，不是响应侧的惊喜**：`accept: text/event-stream` 只是"我们
        // 收得下 SSE"，真正让上游按 SSE 回的是这一栏。不给它的话上游回**一条整的 JSON**，而
        // `dataRecords` 只认 `data:` 行——解出 0 条事件，`finish` 再把"没有 stop_reason"当半截
        // 的流报出来（实测：同一条请求体加不加这一栏，回的是 705 字节 JSON 与 18404 字节 SSE）。
        stream: true,
        // **思考那一栏**：这条线上它要显式开（不写就是不开），`budget_tokens` 被忽略，档位走
        // `output_config.effort`（官方 Anthropic 兼容表：`thinking` 支持、`output_config` 只认
        // `effort`）。`off` 那一档**一个字段都不发**——与这一格之前逐字节相同。
        ...(thinkingOf(req.call?.thinking) === 'off'
          ? {}
          : { thinking: { type: 'enabled' }, output_config: { effort: thinkingOf(req.call?.thinking) } }),
        // **两个线协议在"省略"这一件事上语义不同**：这一条线上 `temperature` 不填 = 由提供方定，
        // 填 0.2 就是**真的要 0.2**（而那条线的默认值是 1）。所以缺省不是常量 0.2，是"不填"。
        ...(req.call?.temperature === undefined ? {} : { temperature: req.call.temperature }),
        // 工具目录的形状两边差一层：这里是 `{name, description, input_schema}`，两个适配器里唯一
        // 有结构差异的那一处（断言 ② 量它）。
        ...(req.tools === undefined
          ? {}
          : { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }),
      })
    },

    state(): unknown {
      const s: MessagesState = { blocks: new Map<number, ToolInFlight>(), text: [], rawStop: null }
      return s
    },

    parse(payload: unknown, state: unknown): ModelEvent[] {
      const s = state as MessagesState
      const p = payload as Record<string, unknown>
      switch (p['type']) {
        case 'ping':
          return []
        case 'message_start': {
          const message = (p['message'] ?? {}) as Record<string, unknown>
          const usage = usageOf(message['usage'] as Record<string, unknown> | undefined)
          const model = typeof message['model'] === 'string' ? (message['model'] as string) : null
          // `model` 是"它说它是谁"那个坐标（`Usage.model`）：它可能与声明的 `model` 不同（别名 · 路由）。
          return [{ t: 'usage', usage: { ...(usage ?? {}), model } }]
        }
        case 'content_block_start': {
          const cb = (p['content_block'] ?? {}) as Record<string, unknown>
          // 思考块的**开头**不是事件（内容是后面的 `thinking_delta` 一条条给的），但它必须
          // 认出来：认不出来它就会掉进下面那条"跳过"里，而回传那一半要靠这里的形状。
          if (cb['type'] === 'thinking') return []
          if (cb['type'] !== 'tool_use') return [] // `text` 之类：不是事件，跳过
          const index = p['index']
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
            throw new WireError(`content_block_start 的 index 不是非负整数：${JSON.stringify(index)}`)
          }
          const id = typeof cb['id'] === 'string' && cb['id'] !== '' ? (cb['id'] as string) : null
          const name = typeof cb['name'] === 'string' && cb['name'] !== '' ? (cb['name'] as string) : null
          s.blocks.set(index, { id, name, args: '' })
          return [{ t: 'tool-start', index, id, name }]
        }
        case 'content_block_delta': {
          const index = p['index']
          const delta = (p['delta'] ?? {}) as Record<string, unknown>
          if (delta['type'] === 'text_delta') {
            const text = delta['text']
            if (typeof text !== 'string') throw new WireError(`text_delta 的 text 不是字符串：${JSON.stringify(text)}`)
            s.text.push(text)
            return text === '' ? [] : [{ t: 'delta', text }]
          }
          if (delta['type'] === 'input_json_delta') {
            if (typeof index !== 'number') throw new WireError(`input_json_delta 没带 index：${JSON.stringify(p)}`)
            const partial = delta['partial_json']
            if (typeof partial !== 'string') throw new WireError('input_json_delta 的 partial_json 不是字符串')
            if (partial === '') return [] // 那一条线上第一片常常是空串
            return [{ t: 'tool-delta', index, args: partial }]
          }
          if (delta['type'] === 'thinking_delta') {
            const text = delta['thinking']
            if (typeof text !== 'string') throw new WireError(`thinking_delta 的 thinking 不是字符串：${JSON.stringify(text)}`)
            return text === '' ? [] : [{ t: 'reasoning-delta', text }]
          }
          if (delta['type'] === 'signature_delta') {
            const signature = delta['signature']
            if (typeof signature !== 'string' || signature === '') {
              throw new WireError(`signature_delta 的 signature 不是非空字符串：${JSON.stringify(signature)}`)
            }
            return [{ t: 'reasoning-signature', signature }]
          }
          return [] // 别的块（`redacted_thinking` 之类）：不是我们的事件
        }
        case 'content_block_stop': {
          const index = p['index']
          if (typeof index !== 'number') throw new WireError(`content_block_stop 没带 index：${JSON.stringify(p)}`)
          const open = s.blocks.get(index)
          if (open === undefined) return [] // 收的是一段文本块：它没有工具调用
          s.blocks.delete(index)
          return [{ t: 'tool-call', index, id: open.id, name: open.name ?? '', arguments: open.args }]
        }
        case 'message_delta': {
          const delta = (p['delta'] ?? {}) as Record<string, unknown>
          const raw = typeof delta['stop_reason'] === 'string' ? (delta['stop_reason'] as string) : null
          const usage = usageOf(p['usage'] as Record<string, unknown> | undefined)
          const out: ModelEvent[] = []
          if (usage !== null) out.push({ t: 'usage', usage })
          if (raw !== null) {
            s.rawStop = raw
            const reason = STOP_OF[raw]
            if (reason === undefined) {
              throw new WireError(`没有这一种 stop_reason：${raw}（这一条线上的五种是 ${Object.keys(STOP_OF).join(' · ')}）`)
            }
            out.push({ t: 'stop', reason, raw })
          }
          return out
        }
        case 'message_stop':
          return []
        default:
          throw new WireError(
            `没有这一种事件：${JSON.stringify(p['type'])}（这一条线上的七种是 message_start · content_block_start · ` +
              'content_block_delta · content_block_stop · message_delta · message_stop · ping）',
          )
      }
    },

    /**
     * 流到头。这一条线**不补事件**：收尾那一条（`message_delta` 的 `stop_reason`）是自己来的，
     * 所以这里只判"欠不欠账"——欠了就拒，**不把半截的响应当完整的用**。
     */
    finish(state: unknown): ModelEvent[] {
      const s = state as MessagesState
      if (s.blocks.size > 0) {
        throw new WireError(`流到头了还有 ${s.blocks.size} 段工具调用没收尾（index ${[...s.blocks.keys()].join(' · ')}）——不把半截的响应当完整的用`)
      }
      if (s.rawStop === null) throw new WireError('流到头了没有收到 stop_reason——不把半截的响应当完整的用')
      return []
    },
  }
}
