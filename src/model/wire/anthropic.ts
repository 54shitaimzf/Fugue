// Anthropic Messages 那条线：请求体与事件流（架构 § 10.3 的"Messages 优先"）。PLAN § 5.8 的 `B2`。
//
// **形状来自两处**：Anthropic 官方的 Messages 流式文档（`message_start` · `content_block_start` ·
// `content_block_delta` · `content_block_stop` · `message_delta` · `message_stop` · `ping`），以及
// 声明里那个 host 的 `/anthropic/v1/messages` 那一条路（`B0` 的读数：无凭据 401，路在）。
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
import type { ModelEvent, StopReason, Usage } from '../contract.ts'
import type { WireAdapter } from './stream.ts'
import { WireError, bodyOf } from './stream.ts'

/** 请求里那几样这一份要用到的：三区字节 · 提供方那边的模型名 · 工具目录 · 调用配置。 */
interface MessagesRequest {
  readonly model: string
  readonly zones: { readonly A: Uint8Array; readonly B: Uint8Array; readonly C: Uint8Array }
  readonly tools?: readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[]
  readonly call?: { readonly temperature?: number; readonly maxTokens?: number }
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
}

const usageOf = (u: Record<string, unknown> | undefined): Partial<Usage> | null => {
  if (u === undefined) return null
  const num = (k: string): number | null => (typeof u[k] === 'number' ? (u[k] as number) : null)
  const out: Partial<Usage> = {
    inputTokens: num('input_tokens'),
    cacheReadTokens: num('cache_read_input_tokens'),
    cacheWriteTokens: num('cache_creation_input_tokens'),
    outputTokens: num('output_tokens'),
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
export function wireOf(): WireAdapter {
  return {
    name: 'anthropic-messages',

    bytes(r: unknown): Uint8Array {
      const req = r as MessagesRequest
      // 三区按区带过来，拼成这一条线上的形状：A 区是 `system`（那条线上系统提示词不在 messages 里），
      // B 区与 C 区各一条 user 消息——**区与区的分界是装配的结论**，这里只翻译，不重排。
      const messages: Record<string, unknown>[] = []
      const b = new TextDecoder().decode(req.zones.B)
      const c = new TextDecoder().decode(req.zones.C)
      if (b !== '') messages.push({ role: 'user', content: b })
      if (c !== '') messages.push({ role: 'user', content: c })
      return bodyOf({
        model: req.model,
        // `max_tokens` 在那条线上是**必填**，所以这里必须有个数兜底；真的那个数由声明给（`B6` 填
        // `call.maxTokens`）。`?? 4096` 是**兜底常数，不是默认值**——它在疑点清单上。
        max_tokens: req.call?.maxTokens ?? 4096,
        // 系统提示词在这一条线上是**顶层的 `system` 字段**，不是 messages 里的第一条。DeepSeek 那一侧
        // 只吃字符串（给数组会被 400 拒掉），所以这里发字符串。
        system: new TextDecoder().decode(req.zones.A),
        messages,
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
          if (cb['type'] !== 'tool_use') return [] // `text` · `thinking` 之类：不是事件，跳过
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
          return [] // `thinking_delta` 那一类：不是我们的事件
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
