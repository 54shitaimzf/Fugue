// **事件联合 → JSON Schema 契约件**（可读性五件之一）。出处：ROADMAP § 5 的 0.4.1 行（schema 导出：
// 外部语言客户端不再手抄解析——webui 将是它第一个消费者，TS 类型从 schema 生成）· 架构 § 8.1
// （事件联合是唯一那一处）。
//
// **从联合推、不手抄**：这一份读 `src/log/events.ts` 的源码（联合唯一的那一处）与 `src/terms.ts`
// 的词汇表，别的什么都不读。**认不出的形状当场报错**，不给一个 `{}` 放过去——那正是
// 「schema 与事件联合对账进闸」要抓的对手：联合加了一栏而契约没跟上。
//
// 契约钉的是**载荷那一层**（`t` 加它的栏）：信封那四栏与钟那三栏是 § 9.2 的事，读一行的人先把
// 它们摘掉（`decodeLine` 做的就是这件事），剩下的正是这一份。
//
// 用法：node tools/export-schema.ts          重新生成 src/log/events.schema.json
//       node tools/export-schema.ts --check  只比，漂了退 1（快档里跑的就是它）
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
export const EVENTS_FILE = join(REPO, 'src', 'log', 'events.ts')
export const TERMS_FILE = join(REPO, 'src', 'terms.ts')
export const SCHEMA_FILE = join(REPO, 'src', 'log', 'events.schema.json')

/** 注解与注释去掉。**联合与词汇表里没有带 `//` 的字符串字面**（有的话下面会当场报错）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** `text[at]` 是 `{`，还它配对的 `}` 的下标。 */
function matchBrace(text: string, at: number): number {
  let depth = 0
  for (let i = at; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  throw new Error('大括号不配对')
}

interface Field {
  readonly name: string
  readonly optional: boolean
  readonly type: string
}

/**
 * 把一段对象体（`{` 与 `}` 里面的那一段）切成栏。
 *
 * 一条栏的 type 在**深度 0 的 `;`** 处结束，或者在**深度 0 的换行**处结束——后者要求下一段是一个
 * 新的栏名或那个收尾的 `}`（多行成员就是靠这一条切的）。type 那一段**原样留着换行**：嵌套对象
 * 还要按同一套再切一次。
 */
function splitFields(body: string): Field[] {
  const out: Field[] = []
  let i = 0
  while (i < body.length) {
    const m = /^[\s,;]*([A-Za-z_][A-Za-z0-9_]*)(\??)\s*:/.exec(body.slice(i))
    if (m === null) {
      i += 1
      continue
    }
    const start = i + m[0].length
    let depth = 0
    let end = start
    while (end < body.length) {
      const c = body[end] as string
      if (c === '{' || c === '[' || c === '(') depth += 1
      else if (c === '}' || c === ']' || c === ')') depth -= 1
      else if (depth === 0 && c === ';') break
      else if (depth === 0 && c === '\n') {
        if (/^\s*([A-Za-z_][A-Za-z0-9_]*\??\s*:|\})/.test(body.slice(end + 1))) break
      }
      end += 1
    }
    out.push({ name: m[1] as string, optional: m[2] === '?', type: body.slice(start, end).trim() })
    i = end + 1
  }
  return out
}

/** 顶层按 `|` 切开（引号与尖括号里面的 `|` 不算）。 */
function topLevelParts(type: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = false
  let at = 0
  for (let i = 0; i < type.length; i++) {
    const c = type[i]
    if (c === "'") quote = !quote
    else if (quote) continue
    else if (c === '{' || c === '[' || c === '(' || c === '<') depth += 1
    else if (c === '}' || c === ']' || c === ')' || c === '>') depth -= 1
    else if (c === '|' && depth === 0) {
      out.push(type.slice(at, i).trim())
      at = i + 1
    }
  }
  out.push(type.slice(at).trim())
  return out
}

type Json = Record<string, unknown>

const isLiteral = (part: string): boolean => /^'[^']*'$/.test(part)

/** 词汇表：`terms.ts` 里的每一个 `export type X = …`（可跨行）与 `export interface X { … }`。 */
function aliasesOf(termsSrc: string): Map<string, string> {
  const out = new Map<string, string>()
  const text = stripComments(termsSrc)
  for (const m of text.matchAll(/export type ([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/g)) {
    const start = (m.index as number) + m[0].length
    const rest = text.slice(start)
    const next = rest.search(/\nexport |\ninterface /)
    // 多行联合是以 `|` 开头的：先摘掉第一个 `|`，再并成一行。
    const value = rest
      .slice(0, next < 0 ? rest.length : next)
      .trim()
      .replace(/^\|\s*/, '')
      .replace(/\s+/g, ' ')
    out.set(m[1] as string, value)
  }
  for (const m of text.matchAll(/export interface ([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)) {
    const at = (m.index as number) + m[0].length - 1
    out.set(m[1] as string, text.slice(at, matchBrace(text, at) + 1))
  }
  return out
}

/** 一个不认识的形状：**当场报错**，不猜。 */
function unknown(type: string, where: string): never {
  throw new Error(`认不出的形状：${JSON.stringify(type)}（在 ${where}）——契约与联合对不上了`)
}

function schemaOf(type: string, aliases: Map<string, string>, where: string, seen: readonly string[]): Json {
  const raw = type.trim().replace(/^readonly\s+/, '')
  if (raw.startsWith('{')) {
    return objectSchemaOf(splitFields(raw.slice(1, raw.lastIndexOf('}'))), aliases, where, seen)
  }
  const t = raw.replace(/\s+/g, ' ')
  const parts = topLevelParts(t)
  if (parts.length > 1) {
    if (parts.every(isLiteral)) return { type: 'string', enum: parts.map((p) => p.slice(1, -1)) }
    const rest = parts.filter((p) => p !== 'null')
    if (rest.length < parts.length) {
      const inner =
        rest.length === 1
          ? schemaOf(rest[0] as string, aliases, where, seen)
          : { anyOf: rest.map((p) => schemaOf(p, aliases, where, seen)) }
      return { anyOf: [inner, { type: 'null' }] }
    }
    // 一个字面量与一个类型名并列（`AgentId | 'round'`）：名字那一份说了算（字面量是它的取值之一）。
    const names = parts.filter((p) => !isLiteral(p))
    if (names.length === 1) return schemaOf(names[0] as string, aliases, where, seen)
    return {
      anyOf: parts.map((p) =>
        isLiteral(p) ? { type: 'string', const: p.slice(1, -1) } : schemaOf(p, aliases, where, seen),
      ),
    }
  }
  const arr = /^(.+)\[\]$/.exec(t)
  if (arr !== null) return { type: 'array', items: schemaOf(arr[1] as string, aliases, where, seen) }
  const record = /^Readonly<Record<([^,]+),\s*(.+)>>$/.exec(t)
  if (record !== null) {
    return { type: 'object', additionalProperties: schemaOf(record[2] as string, aliases, where, seen) }
  }
  if (t === 'string' || t === 'Branded<string>') return { type: 'string' }
  if (t === 'number') return { type: 'number' }
  if (t === 'boolean') return { type: 'boolean' }
  if (t === 'null') return { type: 'null' }
  if (t.startsWith('Branded<')) return { type: 'string' }
  const alias = aliases.get(t)
  if (alias === undefined) unknown(t, where)
  if (seen.includes(t)) unknown(`${t}（自引用）`, where)
  return schemaOf(alias as string, aliases, where, [...seen, t])
}

function objectSchemaOf(
  fields: readonly Field[],
  aliases: Map<string, string>,
  where: string,
  seen: readonly string[],
): Json {
  const properties: Record<string, Json> = {}
  const required: string[] = []
  for (const f of fields) {
    properties[f.name] = schemaOf(f.type, aliases, `${where}.${f.name}`, seen)
    if (!f.optional) required.push(f.name)
  }
  return { type: 'object', additionalProperties: false, required, properties }
}

/** 联合的成员：每一个 `t: '…'` 那一个对象（**按声明次序**）。 */
export function membersOf(eventsSrc: string): { family: string; body: string }[] {
  const text = stripComments(eventsSrc)
  const start = text.indexOf('export type LogEvent =')
  if (start < 0) throw new Error('events.ts 里找不到 `export type LogEvent =`')
  const stop = text.indexOf('\nexport ', start + 1)
  const region = text.slice(start, stop < 0 ? text.length : stop)
  const out: { family: string; body: string }[] = []
  for (const m of region.matchAll(/t:\s*'([a-zA-Z]+\/[a-zA-Z]+|signal)'/g)) {
    const at = region.lastIndexOf('{', m.index as number)
    if (at < 0) throw new Error(`找不到 ${m[1]} 那个成员的开括号`)
    out.push({ family: m[1] as string, body: region.slice(at + 1, matchBrace(region, at)) })
  }
  if (out.length === 0) throw new Error('一个成员都没认出来——联合的形状变了')
  return out
}

/** 从两份源码推这一份契约。**纯函数**：测试拿它驱动"联合一动就红"那一格。 */
export function buildSchema(eventsSrc: string, termsSrc: string): Json {
  const aliases = aliasesOf(termsSrc)
  const oneOf = membersOf(eventsSrc).map((m) => {
    const schema = objectSchemaOf(
      splitFields(m.body).filter((f) => f.name !== 't'),
      aliases,
      m.family,
      [],
    )
    return {
      title: m.family,
      type: 'object',
      additionalProperties: false,
      required: ['t', ...(schema.required as string[])],
      properties: { t: { const: m.family }, ...(schema.properties as Record<string, Json>) },
    }
  })
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'fugue/log/events',
    title: 'LogEvent（架构 § 8.1）',
    description:
      '事件联合的一份外部契约：一族一个分支，`t` 是判别栏。**从 src/log/events.ts 的联合推出来**' +
      '（`tools/export-schema.ts`），联合变了它就跟着变。它描述的是**载荷那一层**——读一行的人先' +
      '摘掉信封（`seq` · `writer` · `crc`，以及给钟时的 `ts` · `boot` · `inc`），剩下的正是这一份。',
    oneOf,
  }
}

export function readSources(): { events: string; terms: string } {
  return { events: readFileSync(EVENTS_FILE, 'utf8'), terms: readFileSync(TERMS_FILE, 'utf8') }
}

export function schemaText(): string {
  const { events, terms } = readSources()
  return JSON.stringify(buildSchema(events, terms), null, 2) + '\n'
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('export-schema.ts')) {
  const text = schemaText()
  if (process.argv.includes('--check')) {
    let have = ''
    try {
      have = readFileSync(SCHEMA_FILE, 'utf8')
    } catch {
      console.error(`FAIL 读不到 ${SCHEMA_FILE}——跑 node tools/export-schema.ts 生成它`)
      process.exit(1)
    }
    if (have !== text) {
      console.error('FAIL 契约件与事件联合对不上：跑 node tools/export-schema.ts 重新生成')
      process.exit(1)
    }
    console.log(`ok   ${SCHEMA_FILE} 与 src/log/events.ts 的联合逐字节一致`)
  } else {
    writeFileSync(SCHEMA_FILE, text)
    console.log(`ok   写出 ${SCHEMA_FILE}（${text.length} 字节）`)
  }
}
