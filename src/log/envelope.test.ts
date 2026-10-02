// 信封的断言。它贴着 `envelope.ts` 住：改信封格式时，验它的断言就在眼前。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeLine, encodeEvent } from './envelope.ts'
import type { LogEvent } from './events.ts'
import type { AgentId } from '../terms.ts'

const A = (s: string): AgentId => s as AgentId
const EV: LogEvent = {
  t: 'view/write',
  agent: A('agent/r1/1'),
  path: 'src/a.ts',
  rev: 7,
  blob: 'b1',
  mode: 420,
}

test('信封往返：编码再解码得回原事件', () => {
  const d = decodeLine(encodeEvent(17, A('agent/r1/1'), EV))
  if (!d.ok) assert.fail(d.reason)
  assert.deepEqual(d.pos, { writer: 'agent/r1/1', seq: 17 })
  assert.deepEqual(d.event, EV)
})

test('crc 与键的书写顺序无关：重排键，信封照样完好', () => {
  const parsed = JSON.parse(encodeEvent(1, 'round', EV)) as Record<string, unknown>
  const shuffled: Record<string, unknown> = {}
  for (const k of Object.keys(parsed).reverse()) shuffled[k] = parsed[k]
  const d = decodeLine(JSON.stringify(shuffled))
  if (!d.ok) assert.fail(d.reason)
  assert.deepEqual(d.event, EV)
})

test('改一个字节 → crc 不符，并给出重算值', () => {
  const line = encodeEvent(1, 'round', EV)
  const at = line.indexOf('src/a.ts')
  const d = decodeLine(line.slice(0, at + 4) + 'X' + line.slice(at + 5))
  assert.equal(d.ok, false)
  if (d.ok) return
  assert.match(d.reason, /crc 不符/)
})

test('载荷字段与信封字段重名 → 拒绝编码', () => {
  const bad = { t: 'view/write', agent: A('round'), seq: 1 } as unknown as LogEvent
  assert.throws(() => encodeEvent(1, 'round', bad), /重名/)
})

test('seq 不是正整数 → 拒绝解码', () => {
  const parsed = JSON.parse(encodeEvent(1, 'round', EV)) as Record<string, unknown>
  parsed.seq = 0
  const d = decodeLine(JSON.stringify(parsed))
  assert.equal(d.ok, false)
  if (!d.ok) assert.match(d.reason, /seq 非法/)
})

test('不是 JSON 对象 → 拒绝解码', () => {
  for (const line of ['', '   ', '[]', '"x"', '{oops']) {
    assert.equal(decodeLine(line).ok, false, `应拒绝：${JSON.stringify(line)}`)
  }
})

// ────────────────────────────────── 顶层重复键
//
// `JSON.parse` 对同名键取最后一个，而"取哪一个"没有规范可依——所以重算出来的 crc 取决于
// 解析器的选择。**两格分得开**：crc 不配平的那一格今天报"crc 不符"（指错地方）；crc **配平**
// 的那一格今天读得进来（这才是那道缝上的破口，也正是负对照要抓的）。

test('顶层同名键两次 → 拒，理由指名那个键（不再是「crc 不符」）', () => {
  const line = encodeEvent(17, A('agent/r1/1'), EV)
  // 在前面插一个假的 `path`：JSON.parse 取最后一个（真的那一个），于是这一行的 crc **不配平**
  // ——今天它会死在 crc 那一关，而那句理由指向错误的地方。
  const duped = '{"path":"谁说了算？",' + line.slice(1)
  const d = decodeLine(duped)
  assert.equal(d.ok, false)
  if (d.ok) return
  assert.match(d.reason, /顶层重复键/)
  assert.match(d.reason, /path/, '理由要点名是哪个键重了')
  assert.doesNotMatch(d.reason, /crc/, '不再走「crc 不符」那句报偏的话')
})

test('crc 配平的重复键行：今天读得进来，现在必须拒（负对照盯的就是这一格）', () => {
  const line = encodeEvent(17, A('agent/r1/1'), EV)
  // **配平**：重复的那个 `path` 把真的那一个放在最后，所以解析回来重算 crc 与行内那一栏相同。
  const balanced = '{"path":"被丢掉的那一个",' + line.slice(1)
  const asParsed = JSON.parse(balanced) as Record<string, unknown>
  // 这一句是这一格的**前提**：最后一个赢——于是"这一行是什么"取决于谁在读。
  assert.equal(asParsed.path, 'src/a.ts', '最后一个赢，这就是"读得进来"的来路')
  const d = decodeLine(balanced)
  assert.equal(d.ok, false, '配平了 crc 也一样拒——重复键本身就是不合格的信封')
  if (!d.ok) assert.match(d.reason, /顶层重复键：\"path\"/)
  // 同一行**不带**那个重复键，照旧完好：拒的是"重了"，不是内容。
  assert.equal(decodeLine(line).ok, true)
})

test('不误伤：值里面写成文本的 JSON（那段里有同名键字样）照旧完好', () => {
  const ev = {
    t: 'view/write',
    agent: A('round'),
    path: 'src/a.ts',
    rev: 1,
    blob: 'b1',
    mode: 420,
    // 载荷里带一段 JSON **文本**：值里出现 `"path":` 那样字样，还有转义引号与逗号。
    note: '{"path":"src/别的.ts","path":"src/又一条.ts"} 以及 \\" 与 , 与 :',
  } as unknown as LogEvent
  const d = decodeLine(encodeEvent(3, A('round'), ev))
  if (!d.ok) assert.fail(d.reason)
  assert.equal((d.event as unknown as { note: string }).note, (ev as unknown as { note: string }).note)
})
