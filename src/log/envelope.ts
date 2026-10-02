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
//
// **顶层重复键一律拒**（0.2.6）。`JSON.parse` 对同一个对象里出现两个同名键取最后一个，
// 而"取哪一个"没有规范可依——于是重算出来的那一串取决于解析器的选择。这种行在今天会报
// "crc 不符"（指向错误的地方），或者被一个**配平了 crc** 的写入者读得进来。后者正是那条
// 缝上的破口："两种写入者共存"是承重性质，而它的前提是两边对同一串字节读到同一件事。
// 判据在 `duplicateTopKey`，而且**写在 crc 校验之前**——报出来的由头是"重复键"，不是"crc"。
//
// **只管顶层**（0.2.6 的决定，记在提交说明里）：信封字段都在顶层，而这一份的职责是"这一行
// 是不是一个完好的信封"；载荷里面那一层是事件形状的事（§ 8.1）。**什么条件下改主意**：树里
// 出现第二套实现、而且它也往载荷里写——那时把扫描器按同一个形状扩到每一层（深度栈）。
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

/**
 * 顶层有没有同名键出现两次；有就给那个键名，没有给 `null`。
 *
 * **只认括号深度 1 上的键名。** JSON 的对象里键后面一定跟一个 `:`（数组里没有键），所以
 * "这一段字符串是不是键"由位置判——**进深度 1 之后**、或者**深度 1 上刚过一个逗号之后**那
 * 一段就是键名。字符串内部的转义与 `,` `:` 都跳过去（一路走到它自己那个收尾引号），所以
 * 载荷里那段**写成文本的 JSON**（值里出现 `"path":` 那种字样）不会误伤。
 *
 * **只在 `JSON.parse` 成功之后调用**：那一行已是合法 JSON，所以这一趟不撞畸形输入、也不用
 * "猜"——它是键名清点，不是第二份解析器。
 */
function duplicateTopKey(line: string): string | null {
  const seen = new Set<string>()
  let depth = 0
  /** 下一段字符串是不是"成员名"。 */
  let expectKey = false
  let i = 0
  while (i < line.length) {
    const c = line[i] as string
    if (c === '"') {
      const start = i
      i += 1
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\') i += 1
        i += 1
      }
      if (depth === 1 && expectKey) {
        const name = JSON.parse(line.slice(start, i + 1)) as string
        if (seen.has(name)) return name
        seen.add(name)
        expectKey = false
      }
      i += 1
      continue
    }
    if (c === '{' || c === '[') {
      depth += 1
      expectKey = depth === 1
      i += 1
      continue
    }
    if (c === '}' || c === ']') {
      depth -= 1
      i += 1
      continue
    }
    if (c === ',') {
      if (depth === 1) expectKey = true
      i += 1
      continue
    }
    if (c === ':') {
      expectKey = false
      i += 1
      continue
    }
    i += 1
  }
  return null
}

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
  // **重复键排在最前**（在 seq / writer / t / crc 那几道门之前）：这种行别的字段可能样样都
  // 好，而"这一行读出来的是什么"从根上就不确定——先说清这件事，别让人去追一个算错的 crc。
  const dup = duplicateTopKey(line)
  if (dup !== null) {
    return { ok: false, reason: `顶层重复键：${JSON.stringify(dup)}——一行里每个键只许出现一次` }
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
