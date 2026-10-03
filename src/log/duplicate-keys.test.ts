import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { decodeLine, encodeEvent } from './envelope.ts'
import { logDir, LogCorruptError, openLog } from './log.ts'
import type { LogEvent } from './events.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'

const event = { t: 'view/write', agent: 'round', path: 'src/old.ts', rev: 1, blob: 'b1', mode: 420 } as LogEvent
const historical = '{"seq":1,"writer":"round","crc":"41f69388","t":"view/write","agent":"round","path":"src/old.ts","rev":1,"blob":"b1","mode":420}'
function lineWith(payload: Record<string, unknown>): string {
  return encodeEvent(1, 'round', { ...event, ...payload } as LogEvent)
}
function rejected(line: string) {
  const result = decodeLine(line)
  assert.equal(result.ok, false, 'ambiguous keys must be rejected even when last-value CRC matches')
  if (result.ok) assert.fail('expected refusal')
  assert.match(result.reason, /顶层重复键/)
  return result.reason
}

test('envelope and payload duplicate keys cannot hide behind a matching last-value CRC', () => {
  assert.equal(decodeLine(historical).ok, true)
  for (const [key, value] of [['seq', 99], ['writer', 'other'], ['crc', '00000000'], ['t', 'other'], ['path', 'hidden.ts'], ['seq', 1]]) {
    rejected(`{${JSON.stringify(key)}:${JSON.stringify(value)},${historical.slice(1)}`)
  }
})

test('escaped and literal spellings of the same decoded key are duplicates', () => {
  rejected(`{"\\u0073eq":99,${historical.slice(1)}`)
  for (const [key, escaped] of [['', ''], ['a', '\\u0061'], ['é', '\\u00e9'], ['𝄞', '\\ud834\\udd1e'], ['a/b', 'a\\/b']]) {
    const line = lineWith({ [key]: 2 })
    const duplicate = `{"${escaped}":1,${line.slice(1)}`
    assert.notEqual(duplicate, line)
    rejected(duplicate)
  }
})

test('accepted top-level boundary leaves nested payload decoding to native JSON semantics', () => {
  const line = lineWith({ nested: { value: 2 }, rows: [{ value: 3 }, { value: 4 }] })
  assert.equal(decodeLine(line).ok, true)
  for (const candidate of [
    line.replace('"nested":{"value":2}', '"nested":{"value":1,"value":2}'),
    line.replace('"rows":[{"value":3}', '"rows":[{"value":1,"value":3}'),
  ]) {
    assert.deepEqual(decodeLine(candidate), decodeLine(line), 'upstream explicitly keeps nested last-value behavior')
  }
  const quoted = lineWith({ nested: { ['quote"slash\\']: 2 } })
  const encoded = JSON.stringify('quote"slash\\')
  assert.deepEqual(decodeLine(quoted.replace(`"nested":{${encoded}:2}`, `"nested":{${encoded}:1,${encoded}:2}`)), decodeLine(quoted))
})

test('old emitted bytes, reordered keys, whitespace and JSON-looking strings remain valid', () => {
  assert.equal(encodeEvent(1, 'round', event), historical, 'emission and CRC are byte-for-byte unchanged')
  const body = { text: '{"dup":1,"dup":2} : [ ] \\\"quoted\\\"', values: ['same', 'same'], nested: { first: 1, 'é': 2, 'e\u0301': 3, A: 4, a: 5 } }
  const line = lineWith({ body, ['quote"slash\\']: 'value' })
  const parsed = JSON.parse(line)
  const reordered = Object.fromEntries(Object.entries(parsed).reverse())
  for (const candidate of [line, JSON.stringify(reordered, null, '\t'), historical]) {
    const result = decodeLine(candidate)
    assert.equal(result.ok, true)
    if (result.ok && candidate !== historical) assert.deepEqual(result.event, { ...event, body, ['quote"slash\\']: 'value' })
  }
})

test('large legitimate values remain valid and long top-level duplicate keys still refuse', () => {
  const text = '{"a":1,"a":2}\\\"'.repeat(70_000)
  assert.equal(decodeLine(lineWith({ text })).ok, true)
  const key = 'x'.repeat(16_384), line = lineWith({ [key]: 2 })
  const duplicate = `{${JSON.stringify(key)}:1,${line.slice(1)}`
  assert.ok(rejected(duplicate).includes(key), 'accepted upstream diagnostics identify the complete top-level key')
})

test('complete ambiguous M0 lines reject with writer/line and leave read-side bytes and files untouched', async () => {
  const root = tmpDir('fugue-log-duplicate-read-'), file = join(logDir(root), 'round.jsonl')
  mkdirSync(dirname(file), { recursive: true })
  const next = encodeEvent(2, 'round', { ...event, rev: 2 })
  const bad = `{"seq":999,${next.slice(1)}`
  writeFileSync(file, `${historical}\n${bad}\n`)
  const bytes = readFileSync(file), files = readdirSync(logDir(root)).sort()
  const log = openLog(root, { sync: 'never' })
  try {
    await assert.rejects(async () => { for await (const _ of log.readByWriter('round')) {} }, error => {
      assert.ok(error instanceof LogCorruptError)
      assert.equal(error.writer, 'round')
      assert.equal(error.line, 2)
      assert.match(error.reason, /重复/)
      return true
    })
  } finally { await log.close() }
  assert.deepEqual(readFileSync(file), bytes)
  assert.deepEqual(readdirSync(logDir(root)).sort(), files, 'no read-side lock or repair artifact')
})

test('an ambiguous complete tail prevents append; an unterminated tail retains existing recovery behavior', async () => {
  const root = tmpDir('fugue-log-duplicate-tail-'), file = join(logDir(root), 'round.jsonl')
  mkdirSync(dirname(file), { recursive: true })
  const bad = `{"seq":999,${encodeEvent(2, 'round', { ...event, rev: 2 }).slice(1)}`
  writeFileSync(file, `${historical}\n${bad}\n`)
  const before = readFileSync(file), writer = openLog(root, { write: 'round', sync: 'never' })
  try { await assert.rejects(writer.append('round', { ...event, rev: 3 }), /重复/) }
  finally { await writer.close() }
  assert.deepEqual(readFileSync(file), before, 'complete bad lines cannot be extended or rewritten')
  writeFileSync(file, `${historical}\n${bad}`)
  const reader = openLog(root, { sync: 'never' })
  try {
    const rows = []
    for await (const row of reader.readByWriter('round')) rows.push(row)
    assert.equal(rows.length, 1, 'no newline means incomplete tail, still ignored as before')
  } finally { await reader.close() }
})
