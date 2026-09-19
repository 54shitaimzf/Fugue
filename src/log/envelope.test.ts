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
