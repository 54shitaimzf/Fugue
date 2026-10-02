// wire-in 夹具的两件纯事，**改齐脚本与对齐测试共用这一份**：在一份 JSON 原文里找出顶层某一栏
// 的字节区间，以及"当前工具目录在该线型上长什么样"。两处各写一遍，改齐与断言就会各有一套
// "什么算对齐"——而它们本来是同一句话。
//
// 为什么定位在**原文**上而不是"解析再重排"：夹具绑的是**发出去的那一串字节**（`wireInTransport`
// 按 `requestHash` 逐字节核），改齐只许动 `tools` 那一栏，别处一个字节不碰。靠的是"键序稳定"
// （`stableJson`）这条已知事实，而不是"再序列化一次看起来差不多"。
import { hashOf } from '../../src/assemble/assemble.ts'
import { catalog, CATALOG_STATES } from '../../src/tools/catalog.ts'
import { wireNamed } from '../../src/model/wire/registry.ts'

/** 一处字节区间（`[start, end)`）。 */
export interface Span {
  readonly start: number
  readonly end: number
}

/**
 * 顶层某一栏的值的字节区间；这一栏不在就返回 `null`。
 *
 * 走的是原文扫描（字符串与括号配对都认），所以 `"tools"` 这几个字符出现在别处的字符串里也
 * 不会被误认成键。
 */
export function valueSpanOf(raw: string, key: string): Span | null {
  let i = 0
  const skipWs = (): void => {
    while (i < raw.length && (raw[i] === ' ' || raw[i] === '\n' || raw[i] === '\t' || raw[i] === '\r')) i += 1
  }
  /** 从 `raw[i] === '"'` 读一个字符串，停在结束引号之后。 */
  const skipString = (): void => {
    i += 1
    while (i < raw.length) {
      const c = raw[i]
      if (c === '\\') i += 2
      else if (c === '"') {
        i += 1
        return
      } else i += 1
    }
  }
  /** 读一个值（标量或括号配对的容器）。 */
  const skipValue = (): void => {
    skipWs()
    const c = raw[i]
    if (c === '"') {
      skipString()
      return
    }
    if (c === '{' || c === '[') {
      let depth = 0
      while (i < raw.length) {
        const d = raw[i]
        if (d === '"') skipString()
        else if (d === '{' || d === '[') {
          depth += 1
          i += 1
        } else if (d === '}' || d === ']') {
          depth -= 1
          i += 1
          if (depth === 0) return
        } else i += 1
      }
      return
    }
    while (i < raw.length && raw[i] !== ',' && raw[i] !== '}' && raw[i] !== ']') i += 1
  }

  skipWs()
  if (raw[i] !== '{') return null
  i += 1
  for (;;) {
    skipWs()
    if (raw[i] !== '"') return null
    const keyAt = i
    skipString()
    const name = JSON.parse(raw.slice(keyAt, i)) as string
    skipWs()
    if (raw[i] !== ':') return null
    i += 1
    skipWs()
    const start = i
    skipValue()
    const end = i
    if (name === key) return { start, end }
    skipWs()
    if (raw[i] === ',') {
      i += 1
      continue
    }
    return null
  }
}

/**
 * **当前工具目录在某条线型上的那一栏**（`tools` 的值的字节）。
 *
 * 形状由**那条线自己的适配器**给（Messages 那条是 `{name,description,input_schema}`，Chat 那条
 * 多包一层 `{type:'function',function:{…}}`）——判形状不判名：这里不写死任何一种，也不猜。
 */
export function toolsValueOf(wireName: string): string {
  const empty = new Uint8Array(0)
  const body = Buffer.from(
    wireNamed(wireName).bytes({
      model: '',
      zones: { A: empty, B: empty, C: empty },
      tools: catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number]),
    }),
  ).toString('utf8')
  const span = valueSpanOf(body, 'tools')
  if (span === null) throw new Error(`这一条线协议（${wireName}）的请求体里没有 tools 那一栏`)
  return body.slice(span.start, span.end)
}

/**
 * 录下来的那一份请求里 **A 区**的字节——**算出来，不是假定它不变**。
 *
 * 两条线型把 A 区放在两处：Messages 那条是顶层 `system`（一串纯文本，或显式缓存那一档的内容块
 * 数组），Chat 那条是 `messages` 里 `role: 'system'` 的那一条。判形状不判名；两处都没有就报
 * `null`（调用方当场停——"复算不出来"与"复算出来一样"是两件事）。
 */
export function zoneAOf(body: unknown): Uint8Array | null {
  const j = body as Record<string, unknown>
  const sys = j['system']
  if (typeof sys === 'string') return new Uint8Array(Buffer.from(sys, 'utf8'))
  if (Array.isArray(sys)) {
    const text = (sys as Record<string, unknown>[]).map((b) => (typeof b['text'] === 'string' ? (b['text'] as string) : '')).join('')
    return new Uint8Array(Buffer.from(text, 'utf8'))
  }
  const messages = j['messages']
  if (Array.isArray(messages)) {
    const one = (messages as Record<string, unknown>[]).find((m) => m['role'] === 'system')
    if (one !== undefined && typeof one['content'] === 'string') return new Uint8Array(Buffer.from(one['content'] as string, 'utf8'))
  }
  return null
}

/** 短指纹（16 个十六进制字符，与日志 · `prefix/assemble` · `meta.json` 里那两栏同一把尺）。 */
export { hashOf }
