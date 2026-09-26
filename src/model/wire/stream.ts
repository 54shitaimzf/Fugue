// 两个线协议各自的适配器：**只做翻译，不做判断**。出处：架构 § 10.1（四层里"传输"那一层）·
// § 10.3（Messages 优先 · Chat Completions 兜底）· § 10.5（拟合用录制的会话夹具验证，无需密钥）。
// PLAN § 5.8 的 `B2`。
//
// **这一份里没有分支，只有两张表。** 一个线协议 = 五个纯函数（请求体 · 用量 · 文本块 · 分片 ·
// 收尾）。所以下面这一份是**两个适配器共用**的那一半，两份适配器各自给一张表——架构 § 10.3 的
// 判据（"适配器里出现 `if (model === 'x')` 说明该差异没被建模成一个声明式字段"）在这里的读法是：
// **一份适配器只认识它自己那条线的形状，另一条线的名字它一个字都不认**。
//
// **字节是流，不是一条消息。** 上游把一个事件拆成好几个 TCP 分片是常态，所以这一层的入口是
// **字节块**（`Uint8Array`），不是字符串、不是"一行"。三件事都在这一份里：
//
//   一 · **按行切**，行的字节不满就等下一个块——`\n` 是 0x0A，而一个多字节字符（汉字 · emoji）
//        的字节可能横跨两个块，**所以解 UTF-8 要按整行解，不能按块解**（按块解会在块的边界
//        把一个字符劈成两个"乱码"，而那一处不报错，只是字节不对）。
//   二 · **SSE 那层**：若干 `data:` 行拼成一条（空行收口），`event:` 与 `:` 开头的注释行忽略。
//   三 · **把每条 `data:` 交给那个协议的 `parse`**，它给零条或多条 `ModelEvent`。
//
// **`[DONE]` 是 OpenAI 兼容那一侧的结束标记，不是内容**：这一层跳过它，收尾由 `parse` 按
// 它自己那条线的规矩发（`finish_reason` 那一条）。
import type { ModelEvent, Turn } from '../contract.ts'

/** 适配器这一层的失败：上游给的东西与这条线协议的形状对不上。**话里带指路**（哪一条 · 为什么）。 */
export class WireError extends Error {}

/**
 * **C 区那一段要发出去的那一半：它的头。**（架构 § 8.11：「那句话进的是这一趟的尾端（C 区第一条）」）
 *
 * 两条线协议共用这一个读法；`zones.C` 是那一段的全文（头 + 尾巴），而尾巴有两种发法：
 *
 *   · 有 `cHead`（运行时装配时会给）→ 发它，尾巴交给 `turns`（原生轮次）；
 *   · 没有 `cHead` → **只有"没有轮次"这一档能退回 `zones.C`**（那时尾巴是空的，两者逐字节
 *     相同）；有轮次又没有头，就是这一趟没有头可发（空）。
 *
 * **退回那一档是给夹具与别的调用方的**：它们构造请求时不给头，而它们的请求体一个字节都不许
 * 变（`src/model/fixtures/*.json` 绑的就是那些字节）。
 */
export function wireHeadOf(r: {
  readonly zones: { readonly C: Uint8Array }
  readonly cHead?: Uint8Array
  readonly turns?: readonly Turn[]
}): Uint8Array {
  if (r.cHead !== undefined) return r.cHead
  const hasTurns = r.turns !== undefined && r.turns.length > 0
  return hasTurns ? new Uint8Array(0) : r.zones.C
}

/** 一个适配器。`bytes` 与 `parse` 是纯函数；`state` 是**一条流一份**的可变状态（分片累加用）。 */
export interface WireAdapter {
  /** 线协议的名字（`WireName` 的那两个值）。 */
  readonly name: string
  /** 一个请求 → 这条线上的请求体。键序稳定（`stableJson`），所以同一份输入逐字节相同。 */
  bytes(r: unknown): Uint8Array
  /** 一条流开始时的新状态。 */
  state(): unknown
  /** 一条 `data:` 载荷（已经解析成 JSON）→ 零条或多条我们的事件。 */
  parse(payload: unknown, state: unknown): ModelEvent[]
  /** 流到头了（字节没了）：给出还欠着的那几条事件（多半是一条 `stop`）。 */
  finish(state: unknown): ModelEvent[]
}

/**
 * 键按字典序的 JSON。**同一份输入两个适配器各自序列化，都必须逐字节稳定**——缓存要求的是字节，
 * 而对象字面量的键序是写下来的顺序，不是保证。
 */
export function stableJson(v: unknown): string {
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  }
  throw new WireError(`这一种值序列化不了：${typeof v}`)
}

/** 一个请求体：稳定序列化的 UTF-8 字节。 */
export function bodyOf(v: unknown): Uint8Array {
  return new TextEncoder().encode(stableJson(v))
}

/** 拆开一个块里完整的那些行：留下的尾巴（没有换行的那一段）**一个字都不能丢**。 */
export function splitLines(buf: Uint8Array): { lines: string[]; tail: Uint8Array } {
  const lines: string[] = []
  let from = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue
    // **按整行解 UTF-8**：一个多字节字符可能横跨两个块，按块解会把它们劈开。
    const raw = buf.subarray(from, i)
    const body = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, raw.length - 1) : raw
    lines.push(new TextDecoder().decode(body))
    from = i + 1
  }
  return { lines, tail: buf.subarray(from) }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/**
 * SSE 那一层：字节块 → 一条条 `data:` 的载荷。**它只认 SSE 的语法**，不认任何一个协议的字段——
 * 两个适配器共用它（一份实现，两条线）。
 *
 * 一个事件 = 若干 `data:` 行 + 一个空行收口。`event:` 那一行忽略（两条线的载荷里都带 `type`），
 * 以 `:` 开头的行是注释（有些实现拿它当心跳）。`[DONE]` 是结束标记，跳过。
 */
export async function* dataRecords(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  let buf = new Uint8Array(0)
  let data: string[] = []
  const flush = (): unknown | undefined => {
    if (data.length === 0) return undefined
    const text = data.join('\n')
    data = []
    if (text.trim() === '' || text.trim() === '[DONE]') return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new WireError(`这一条 \`data:\` 不是一份 JSON（前 120 个字符）：${text.slice(0, 120)}`)
    }
  }
  for await (const chunk of chunks) {
    const split = splitLines(concatBytes([buf, chunk]))
    buf = split.tail
    for (const line of split.lines) {
      if (line === '') {
        const one = flush()
        if (one !== undefined) yield one
        continue
      }
      if (line.startsWith(':')) continue
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      // `event:` · `id:` · `retry:` 一律忽略：判决靠载荷里的 `type`，不靠传输层的标签。
    }
  }
  // 收尾时把尾巴当最后一行解（有些实现对最后一条不发空行）。
  if (buf.length > 0) {
    const one = splitLines(concatBytes([buf, new Uint8Array([0x0a])]))
    for (const line of one.lines) if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  const last = flush()
  if (last !== undefined) yield last
}

/** 一条流 → 我们的事件。**两个适配器共用这一条骨架**，差别只在那一张表（`parse` · `finish`）。 */
export async function* parseStream(a: WireAdapter, chunks: AsyncIterable<Uint8Array>): AsyncGenerator<ModelEvent> {
  const state = a.state()
  for await (const record of dataRecords(chunks)) {
    for (const e of a.parse(record, state)) yield e
  }
  for (const e of a.finish(state)) yield e
}

/** 一个请求体（值）→ 一条字节流。给测试与夹具用：真出网那一条在 `http.ts`（B3）。 */
export async function* justBytes(one: Uint8Array): AsyncGenerator<Uint8Array> {
  yield one
}

/** 把一份夹具（一个字符串）按**给定的块大小**切成字节块：`parseStream` 的第一条断言用它。 */
export async function* chunksOf(text: string, size: number): AsyncGenerator<Uint8Array> {
  const all = new TextEncoder().encode(text)
  for (let at = 0; at < all.length; at += size) yield all.subarray(at, Math.min(at + size, all.length))
}
