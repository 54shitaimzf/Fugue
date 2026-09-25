// Chat Completions 那条线：请求体与事件流（架构 § 10.3 的"Chat Completions 兜底"）。
// PLAN § 5.8 的 `B2`。
//
// **它同时是"另一条线协议"与"兼容层"**：`/v1/chat/completions` 这条路是兼容事实标准，所以这一份
// 认识的是**那一套公共形状**（`choices[].delta` · `tool_calls[]` · `finish_reason`），而不是某一家
// 的私货。**两处会漂的地方单独标出来**（用量那四个数的名字 · `finish_reason` 的取值表）：它们是
// `B3` 拿到真夹具时第一批要核的东西（PLAN § 5.8 的 B2 行与"留下的疑点"）。
//
// **与 Messages 那条线的差别在哪，一目了然**（`B2` 的断言 ② 就是量这个）：
//
//   · 工具调用**没有"块"这个概念**，靠 `delta.tool_calls[].index` 分组；名字与 id 只在第一片里来。
//   · **没有 `content_block_stop`**：一条调用的收尾没有专属事件，所以它是**流到头时补发的**
//     （`finish`），不是某一条事件给的。
//   · `finish_reason` 与 `usage` 都在最后那几片里：收尾事件同样是 `finish` 发的。
//   · 系统提示词在**第一条 message** 里（`role: 'system'`），不是顶层字段。
//
// **收尾为什么不在 `parse` 里发**：那一片只知道"又多了一个 index"，不知道后面还会不会来下一片。
// 一条调用的三段（起点 · 分片 · 收尾）必须在**同一处**定下来（`checkEvents` 只认这个形状），
// 所以"收尾"归 `finish`——它是"这条流到头了"那一刻的判决。
import type { ModelEvent, StopReason, Usage } from '../contract.ts'
import type { WireAdapter } from './stream.ts'
import { WireError, bodyOf } from './stream.ts'

interface ChatRequest {
  readonly model: string
  readonly zones: { readonly A: Uint8Array; readonly B: Uint8Array; readonly C: Uint8Array }
  readonly tools?: readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[]
  readonly call?: { readonly temperature?: number; readonly maxTokens?: number }
}

/**
 * `finish_reason` → 我们那五种。**不认识的当场拒**：结束原因是 `B4` 三档判据的输入。
 *
 * `content_filter` 归 `refusal`（那一档的意思是"它不肯/不能按你说的做"）；`length` 归 `max-tokens`
 * （两条线上是同一件事：撞了输出预算）。
 */
const STOP_OF: Readonly<Record<string, StopReason>> = {
  tool_calls: 'tool-calls',
  stop: 'end-turn',
  length: 'max-tokens',
  content_filter: 'refusal',
}

/**
 * 用量那四个数的名字。**兼容层上会漂的就是这一处**：OpenAI 自己那套是
 * `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens`，而
 * DeepSeek 那一侧另给 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。
 * 两套都认（`??` 链），**认不出来就是 `null`，不猜一个 0**——`usageCount` 会如实报"没有读数"。
 */
const usageOf = (u: Record<string, unknown> | undefined): Partial<Usage> | null => {
  if (u === undefined) return null
  const num = (k: string): number | null => (typeof u[k] === 'number' ? (u[k] as number) : null)
  const details = (u['prompt_tokens_details'] ?? {}) as Record<string, unknown>
  const cached = typeof details['cached_tokens'] === 'number' ? (details['cached_tokens'] as number) : null
  const hit = num('prompt_cache_hit_tokens')
  const miss = num('prompt_cache_miss_tokens')
  const prompt = num('prompt_tokens')
  const out: Partial<Usage> = {
    // 输入那一个数在两条兼容实现里意思不同：OpenAI 的 `prompt_tokens` 是**总数**，
    // DeepSeek 把命中与未命中分开给。取"未命中"那一半（与 Anthropic 那一侧的 `input_tokens` 同义）。
    inputTokens: miss ?? (prompt !== null && cached !== null ? prompt - cached : prompt),
    cacheReadTokens: hit ?? cached,
    // 隐式缓存的这条线上**没有缓存写入这一项**——它是 `null`，不是 0。
    cacheWriteTokens: null,
    outputTokens: num('completion_tokens'),
  }
  if (!Object.values(out).some((v) => v !== null)) return null
  return {
    ...out,
    model: typeof u['model'] === 'string' ? (u['model'] as string) : null,
    rawStop: typeof u['finish_reason'] === 'string' ? (u['finish_reason'] as string) : null,
  }
}

/** 一条工具调用在流里的状态：那一片一片拼起来的名字与参数。 */
interface ToolInFlight {
  id: string | null
  name: string | null
  args: string
}

interface ChatState {
  readonly tools: Map<number, ToolInFlight>
  rawStop: string | null
  reason: StopReason | null
  done: boolean
}

const textOf = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** 这一条线的适配器。名字取 PLAN § 5.8 的 `B2` 行：一份 `wireOf()` 给请求体与事件流。 */
export function wireOf(): WireAdapter {
  return {
    name: 'openai-chat',

    bytes(r: unknown): Uint8Array {
      const req = r as ChatRequest
      // 三区按区带过来：A 区是 `role: 'system'` 那一条，B 区与 C 区各一条 user——**区的分界是装配的
      // 结论**，这里只翻译。空的区不发那一条（空消息在那一侧不是合法的形状）。
      const messages: Record<string, unknown>[] = []
      const a = new TextDecoder().decode(req.zones.A)
      const b = new TextDecoder().decode(req.zones.B)
      const c = new TextDecoder().decode(req.zones.C)
      if (a !== '') messages.push({ role: 'system', content: a })
      if (b !== '') messages.push({ role: 'user', content: b })
      if (c !== '') messages.push({ role: 'user', content: c })
      return bodyOf({
        model: req.model,
        messages,
        // **流式是一个请求侧的声明**（理由与 Messages 那条线上同一处相同）：不给这一栏，上游回
        // 的是一条整的 `chat.completion`，`dataRecords` 一个 `data:` 行都找不到，`finish` 报
        // "流到头了没有收到 finish_reason"——话是错的，账也是空的（`usage` 拿不到）。
        stream: true,
        // 这一条线上省略 `temperature` = 由提供方定（那边默认是 1）；填了就是要那个数。**缺省不是
        // 常量**：两个适配器共用一份 `call`，各自那边的"省略"含义不同，所以"缺省填什么"归各自。
        ...(req.call?.temperature === undefined ? {} : { temperature: req.call.temperature }),
        ...(req.call?.maxTokens === undefined ? {} : { max_tokens: req.call.maxTokens }),
        // 工具目录在这条线上多包一层 `{type:'function', function:{name, description, parameters}}`。
        ...(req.tools === undefined
          ? {}
          : {
              tools: req.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }),
      })
    },

    state(): unknown {
      const s: ChatState = { tools: new Map<number, ToolInFlight>(), rawStop: null, reason: null, done: false }
      return s
    },

    parse(payload: unknown, state: unknown): ModelEvent[] {
      const s = state as ChatState
      const p = payload as Record<string, unknown>
      if (s.done) throw new WireError('这一条流已经收尾了，后面还有 data 帧——不把半截的响应当完整的用')
      const out: ModelEvent[] = []
      const usage = usageOf(p['usage'] as Record<string, unknown> | undefined)
      if (usage !== null) out.push({ t: 'usage', usage })
      const choices = p['choices']
      if (!Array.isArray(choices) || choices.length === 0) return out
      for (const raw of choices as Record<string, unknown>[]) {
        const delta = (raw['delta'] ?? {}) as Record<string, unknown>
        const text = textOf(delta['content'])
        if (text !== null) out.push({ t: 'delta', text })
        const calls = delta['tool_calls']
        if (Array.isArray(calls)) {
          for (const rawCall of calls as Record<string, unknown>[]) {
            const index = rawCall['index']
            if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
              throw new WireError(`tool_calls 里有一片没带非负整数 index：${JSON.stringify(rawCall)}`)
            }
            const fn = (rawCall['function'] ?? {}) as Record<string, unknown>
            const id = textOf(rawCall['id'])
            const name = textOf(fn['name'])
            const args = typeof fn['arguments'] === 'string' ? (fn['arguments'] as string) : ''
            const open = s.tools.get(index)
            if (open === undefined) {
              // **`tool-start` 那一条只在拿到名字的那一片发**：我们的形状里一条调用的 `name` 是一次给足的
              // （`checkEvents` 只认"开一次"），所以名字没到就先不发、把它与参数攒着。
              s.tools.set(index, { id, name, args: '' })
            } else if (open.name === null && name !== null) {
              open.name = name
              if (open.id === null) open.id = id
            } else if (name !== null && name !== open.name) {
              // 名字改口：这条线上不该发生（名字只在那一条调用的第一片里）。**不静默丢掉**——
              // 丢掉的话 `tool-call` 会带着错的名字交出去，而工具面接线（`B5`）就按那个名字找工具。
              throw new WireError(`第 ${index} 条调用的名字改口了：先是 ${open.name}，这一片说是 ${name}`)
            }
            const live = s.tools.get(index) as ToolInFlight
            if (live.name !== null && open?.name !== live.name) {
              out.push({ t: 'tool-start', index, id: live.id, name: live.name })
            }
            if (args !== '') {
              if (live.name === null) {
                throw new WireError(`第 ${index} 条调用攒了参数却一直没有名字——这条线上名字与 id 都在第一片里`)
              }
              live.args += args
              out.push({ t: 'tool-delta', index, args })
            }
          }
        }
        const finish = raw['finish_reason']
        if (typeof finish === 'string' && finish !== '') {
          const reason = STOP_OF[finish]
          if (reason === undefined) {
            throw new WireError(`没有这一种 finish_reason：${finish}（这条线上认的是 ${Object.keys(STOP_OF).join(' · ')}）`)
          }
          s.rawStop = finish
          s.reason = reason
        }
      }
      return out
    },

    /**
     * 流到头：**先补每一条工具调用的收尾，再发 `stop`**（顺序是形状要求的：`stop` 必须最后一条）。
     *
     * 缺收尾原因就拒：一条没有 `finish_reason` 的流是半截的（上游掐断就长这样），
     * **不许当完整的用**（PLAN § 5.8 的 B3 断言 ④ 也是这一条纪律的另一个落点）。
     */
    finish(state: unknown): ModelEvent[] {
      const s = state as ChatState
      s.done = true
      const out: ModelEvent[] = []
      for (const [index, open] of s.tools) {
        out.push({ t: 'tool-call', index, id: open.id, name: open.name ?? '', arguments: open.args })
      }
      s.tools.clear()
      if (s.reason === null) throw new WireError('流到头了没有收到 finish_reason——不把半截的响应当完整的用')
      out.push({ t: 'stop', reason: s.reason, ...(s.rawStop === null ? {} : { raw: s.rawStop }) })
      return out
    },
  }
}
