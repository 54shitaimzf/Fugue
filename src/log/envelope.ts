// 信封的编解码。出处：架构 § 9.2。
//
// **纯函数：没有 I/O，没有策略。** 它只回答"这一行是不是一个完好的信封"，
// 至于坏了以后该怎么办（截断？拒绝？），由 `M0` 决定——判据在这里，判决不在这里。
//
// 一行一条事件，行首是自描述信封：
//   {"seq":17,"writer":"agent/r1/2","crc":"8f3a…","t":"view/write",…载荷…}
//
// `crc` 覆盖的是**去掉 crc 字段后的规范形式**：键按字典序排列。于是校验与键的
// 书写顺序无关——重排一行里的键，它照样是一个完好的信封。
import { crc32 } from 'node:zlib'
import type { LogEvent } from './events.ts'
import type { LogPos, LogSeq, WriterId } from '../terms.ts'

/** 信封字段。载荷里出现同名字段会把信封本身顶掉，所以编码时拒绝。 */
const RESERVED: readonly string[] = ['seq', 'writer', 'crc', 't']

function crcHex(text: string): string {
  return crc32(Buffer.from(text, 'utf8')).toString(16).padStart(8, '0')
}

/** 规范形式：对象键按字典序，数组保序，`undefined` 按 JSON 的规矩丢弃。 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  switch (typeof value) {
    case 'number':
    case 'boolean':
    case 'string':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v) => canonicalJson(v)).join(',') + ']'
      }
      const o = value as Record<string, unknown>
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}'
    }
    default:
      return 'null'
  }
}

/** 把一条事件编成一行（不含行终止符）。 */
export function encodeEvent(seq: LogSeq, writer: WriterId, event: LogEvent): string {
  const { t, ...payload } = event as { t: string } & Record<string, unknown>
  for (const k of Object.keys(payload)) {
    if (RESERVED.includes(k)) throw new Error(`事件的载荷字段与信封字段重名：${k}`)
  }
  const crc = crcHex(canonicalJson({ seq, writer, t, ...payload }))
  return JSON.stringify({ seq, writer, crc, t, ...payload })
}

export type DecodeResult =
  | { ok: true; pos: LogPos; event: LogEvent }
  | { ok: false; reason: string }

/** 解一行。`reason` 是给人看的——它会被带进错误、指向行号。 */
export function decodeLine(line: string): DecodeResult {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch (err) {
    return { ok: false, reason: `JSON 解析失败：${(err as Error).message}` }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: '行不是一个 JSON 对象' }
  }
  const { seq, writer, crc, t, ...payload } = raw as Record<string, unknown>

  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
    return { ok: false, reason: `seq 非法：${JSON.stringify(seq)}` }
  }
  if (typeof writer !== 'string' || writer.length === 0) {
    return { ok: false, reason: `writer 非法：${JSON.stringify(writer)}` }
  }
  if (typeof t !== 'string' || t.length === 0) {
    return { ok: false, reason: `t 非法：${JSON.stringify(t)}` }
  }
  if (typeof crc !== 'string') {
    return { ok: false, reason: `缺少 crc 字段：${JSON.stringify(crc)}` }
  }
  const want = crcHex(canonicalJson({ seq, writer, t, ...payload }))
  if (want !== crc.toLowerCase()) {
    return { ok: false, reason: `crc 不符：行内 ${crc}，重算 ${want}` }
  }

  return {
    ok: true,
    pos: { writer: writer as WriterId, seq },
    event: { t, ...payload } as unknown as LogEvent,
  }
}
