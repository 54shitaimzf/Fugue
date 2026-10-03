// Combined maintenance boundary: complete duplicate and torn-tail refusals never rewrite authoritative bytes.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { encodeEvent } from './envelope.ts'
import type { LogEvent } from './events.ts'
import { logDir, LogCorruptError, openLog } from './log.ts'

const event = (rev: number): LogEvent => ({
  t: 'view/write', agent: 'round', path: 'src/甲😀.ts', rev, blob: `b${rev}`, mode: 420,
} as LogEvent)
const row = (seq: number): string => encodeEvent(seq, 'round', event(seq))

function fixture(text: string) {
  const root = tmpDir('fugue-maintenance-log-'), file = join(logDir(root), 'round.jsonl')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return { root, file }
}

for (const key of ['seq', '\\u0073eq']) {
  test(`complete duplicate ${key} before a partial tail refuses without mutation, then same-handle initialization retries after explicit complete-prefix repair`, async () => {
    const prefix = row(1) + '\n'
    const ambiguous = `{"${key}":999,${row(2).slice(1)}`
    const f = fixture(prefix + ambiguous + '\n{"partial":')
    const before = readFileSync(f.file)
    const writer = openLog(f.root, { write: 'round', sync: 'never' })
    try {
      await assert.rejects(writer.append('round', event(3)), error => {
        assert.ok(error instanceof LogCorruptError)
        assert.match(error.reason, /重复/)
        return true
      })
      assert.deepEqual(readFileSync(f.file), before, 'refusal must preserve both complete and partial bytes')
      // Repair only this generated fixture; the failed initializer must not poison this handle.
      writeFileSync(f.file, prefix + '{"partial":')
      await assert.rejects(writer.append('round', event(2)), LogCorruptError)
      assert.equal(readFileSync(f.file, 'utf8'), prefix + '{"partial":')
      writeFileSync(f.file, prefix)
      assert.equal(await writer.append('round', event(2)), 2)
    } finally { await writer.close() }
    assert.equal(readFileSync(f.file, 'utf8'), prefix + row(2) + '\n')
  })
}

test('ambiguous unterminated row stays uncommitted for readers and refuses writer initialization without mutation', async () => {
  const prefix = row(1) + '\n'
  const f = fixture(prefix + `{"seq":999,${row(2).slice(1)}`)
  const before = readFileSync(f.file)
  const reader = openLog(f.root, { sync: 'never' })
  try {
    const events: LogEvent[] = []
    for await (const value of reader.readByWriter('round')) events.push(value)
    assert.deepEqual(events, [event(1)])
  } finally { await reader.close() }
  const writer = openLog(f.root, { write: 'round', sync: 'each' })
  try { await assert.rejects(writer.append('round', event(2)), LogCorruptError) }
  finally { await writer.close() }
  assert.deepEqual(readFileSync(f.file), before)
})
