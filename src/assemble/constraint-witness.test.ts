import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assemble } from './assemble.ts'
import { checkConstraints, constraintWitness } from './constraints.ts'
import type { ConstraintWitness } from './constraints.ts'
import type { Prefix, Protocol } from './contract.ts'
import { HOLDER_PROTOCOL, SUBAGENT_PROTOCOL } from './protocol.ts'
import { emptyState, sourcesFor } from './sources.ts'

const facts = { hostname: '', pid: 0 }
function snapshot(runtime: string, signals = ['previous merged signal'], lastStep = 'previous result', protocol = SUBAGENT_PROTOCOL) {
  const segments = sourcesFor(protocol, { ...emptyState(), runtime, signals, lastStep },
    protocol === HOLDER_PROTOCOL ? null : { id: 'agent', branch: 'branch', outputPaths: [] })
  const prefix = assemble({ protocol, model: 'fixture', segments })
  return { segments, prefix, witness: constraintWitness(protocol, segments, prefix) }
}
function appendViolations(before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>, protocol = SUBAGENT_PROTOCOL,
  witness = before.witness, prefix = after.prefix) {
  return checkConstraints(protocol, after.segments, before.prefix, 'next', facts, prefix, witness)
    .filter(v => v.kind === 'append-only')
}

test('named accumulating text can grow while signal/result suffixes replace for both accepted protocols', () => {
  for (const protocol of [SUBAGENT_PROTOCOL, HOLDER_PROTOCOL]) {
    for (const runtime of ['', 'unterminated first', 'first\n']) {
      const before = snapshot(runtime, ['old signal'], 'old result', protocol)
      const after = snapshot(runtime + '追加 🌱\n上一步结果 is ordinary body text', ['new signal'], 'new result', protocol)
      assert.ok(before.witness !== null)
      assert.equal(appendViolations(before, after, protocol, null).length, 1, 'bare C remains the coarse diagnostic')
      assert.deepEqual(appendViolations(before, after, protocol), [])
    }
  }
})

test('named witness detects deletion and middle rewrites with the actual UTF-8 byte position', () => {
  const before = snapshot('甲\nfirst\nsecond')
  for (const text of ['甲\nfirst', '甲\nwrong\nsecond']) {
    const after = snapshot(text, ['replacement'], 'replacement')
    const [violation] = appendViolations(before, after)
    assert.equal(appendViolations(before, after).length, 1)
    assert.equal(violation?.where, '运行时上下文')
    const common = text === '甲\nfirst' ? Buffer.byteLength(text) : Buffer.byteLength('甲\n')
    assert.match(violation!.detail, new RegExp(`前 ${common} 个字节相同，第 ${common + 1} 个字节起不同`))
  }
  const realTrailingLF = snapshot('first\n'), deletedLF = snapshot('first')
  assert.equal(appendViolations(realTrailingLF, deletedLF).length, 1, 'only renderer framing LF is removed; content LF remains history')
})

test('witness owns the previous named data and cannot refine modified prefix bytes or forged handles', () => {
  const before = snapshot('first'), after = snapshot('first\nsecond', ['new'], 'new')
  before.segments['运行时上下文'] = 'caller overwrote its old record'
  ;(before.segments['信号摘要'] as string[]).push('caller changed the source list')
  assert.deepEqual(appendViolations(before, after), [], 'owned witness retains its original named snapshot')
  assert.equal(appendViolations(before, after, SUBAGENT_PROTOCOL, { kind: 'named-c-segments' } as ConstraintWitness).length, 1)
  const changed: Prefix = { ...after.prefix, zoneC: new Uint8Array(after.prefix.zoneC) }
  changed.zoneC[0] = 120
  assert.equal(appendViolations(before, after, SUBAGENT_PROTOCOL, before.witness, changed).length, 1)
  before.prefix.zoneC[0] = 120
  assert.equal(appendViolations(before, after).length, 1, 'a witness cannot bless changed prior bytes')
})

test('unsupported layouts, missing segments and mismatched renderer witnesses keep the coarse check', () => {
  const before = snapshot('first'), after = snapshot('first\nsecond', ['new'], 'new')
  assert.equal(constraintWitness(SUBAGENT_PROTOCOL, before.segments, after.prefix), null)
  const missing = { ...before.segments, 信号摘要: undefined }
  assert.equal(constraintWitness(SUBAGENT_PROTOCOL, missing as typeof before.segments, before.prefix), null)
  const reordered: Protocol = { ...SUBAGENT_PROTOCOL, segmentOrder: [...SUBAGENT_PROTOCOL.segmentOrder.slice(0, -3), '信号摘要', '运行时上下文', '上一步结果'] }
  assert.equal(constraintWitness(reordered, before.segments, before.prefix), null)
  const reorderedPrefix = assemble({ protocol: reordered, model: 'fixture', segments: after.segments })
  assert.equal(appendViolations(before, after, reordered, before.witness, reorderedPrefix).length, 1)
  const changedRenderer: Protocol = { ...SUBAGENT_PROTOCOL, renderers: { ...SUBAGENT_PROTOCOL.renderers, 信号摘要: 'text' } }
  const segments = { ...after.segments, 信号摘要: 'new' }
  const prefix = assemble({ protocol: changedRenderer, model: 'fixture', segments })
  assert.equal(checkConstraints(changedRenderer, segments, before.prefix, 'next', facts, prefix, before.witness)
    .filter(v => v.kind === 'append-only').length, 1)
})

test('segment precision still reports materialized paths, environment identity and raw Signal fields', () => {
  const before = snapshot('first'), after = snapshot('first\nsecond', ['merged /tmp/private/file'], '{"digest":"unmerged"}')
  after.segments['项目方针'] = 'host-witness'
  const prefix = assemble({ protocol: SUBAGENT_PROTOCOL, model: 'fixture', segments: after.segments })
  const violations = checkConstraints(SUBAGENT_PROTOCOL, after.segments, before.prefix, 'next',
    { hostname: 'host-witness', pid: 0 }, prefix, before.witness)
  assert.deepEqual(violations.map(v => [v.kind, v.where]), [
    ['env', '项目方针'], ['materialized', '信号摘要'], ['signal', '上一步结果'],
  ])
})
