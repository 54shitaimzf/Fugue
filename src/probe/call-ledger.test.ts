import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { logFileOf, openLog } from '../log/log.ts'
import type { LogEvent } from '../log/events.ts'
import type { MergedRow } from './metrics.ts'
import { callLedgerOf, readCallLedger } from './call-ledger.ts'

type Call = Extract<LogEvent, { t: 'llm/call' }>
function call(over: Partial<Call> = {}): Call {
  return { t: 'llm/call', agent: 'a', step: '0', model: 'model', wire: 'openai-chat',
    thinking: null, toolCount: 12, invocations: 2, status: null, headers: null,
    usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: null, outputTokens: 4, reasoningTokens: 2 },
    rawStop: 'tool_calls', stop: 'tool-calls', ...over }
}
function row(event: LogEvent, writer = 'a', seq = 1): MergedRow { return { pos: { writer, seq }, e: event } }

test('ledger preserves reported zero/null tokens without inventing per-tool attribution', () => {
  const result = callLedgerOf([row(call()), row({ t: 'run/end', agent: 'a', step: '0', exit: 0, ms: 99, denied: false }, 'a', 2)])
  assert.equal(result.schema, 1)
  assert.equal(result.tokenScope, 'model-call')
  assert.equal(result.totalCalls, 1)
  assert.deepEqual(result.calls[0].usage, call().usage)
  assert.equal(result.calls[0].requestedTools, 2)
  assert.equal(result.calls[0].toolMs, null, 'run duration cannot stand in for each requested tool')
  assert.equal(result.calls[0].toolArgumentBytes, null)
  assert.equal(result.calls[0].toolReceiptBytes, null)
  assert.equal(result.calls[0].attempts, null)
})

test('source positions distinguish interleaved agents and repeated step identifiers', () => {
  const rows = [row(call(), 'a', 2), row(call({ agent: 'b' }), 'b', 2), row(call({ attempts: [429, 200] }), 'a', 5)]
  const ledger = callLedgerOf(rows)
  assert.deepEqual(ledger.calls.map((entry) => entry.source), [{ writer: 'a', seq: 2 }, { writer: 'b', seq: 2 }, { writer: 'a', seq: 5 }])
  assert.deepEqual(ledger.calls[2].attempts, [429, 200])
  assert.equal(ledger.totalCalls, 3)
  assert.equal(ledger.truncated, false)
})

test('legacy absent and malformed counts remain unknown, not zero or coerced text', () => {
  const legacy = call() as unknown as Record<string, unknown>
  delete legacy.invocations
  delete legacy.usage
  const ledger = callLedgerOf([row(legacy as unknown as Call), row(call({ toolCount: -1 }))])
  assert.equal(ledger.calls[0].requestedTools, null)
  assert.deepEqual(ledger.calls[0].usage, { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null })
  assert.equal(ledger.calls[1].publishedTools, null)
  assert.equal(ledger.calls[0].stop, 'tool-calls')
})

test('malformed retry lists stay unknown instead of aborting the ledger or coercing text', () => {
  for (const attempts of [null, 7, 'x', {}, ['429'], [429, -1], [429, 1.5]]) {
    const ledger = callLedgerOf([row(call({ attempts } as unknown as Partial<Call>))])
    assert.equal(ledger.calls[0].attempts, null, JSON.stringify(attempts))
    assert.equal(ledger.totalCalls, 1)
  }
  assert.deepEqual(callLedgerOf([row(call({ attempts: [429, 0, 200] }))]).calls[0].attempts, [429, 0, 200])
})

test('partial provider calls keep absent usage and completion distinct', () => {
  const usage = { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null }
  const ledger = callLedgerOf([row(call({ stop: null, rawStop: null, status: 503, usage }))])
  assert.equal(ledger.calls[0].stop, null)
  assert.deepEqual(ledger.calls[0].usage, usage)
  assert.equal(ledger.calls[0].toolMs, null)
})

test('bounded reports disclose truncation and keep total logged calls', async () => {
  const rows = [row(call(), 'a', 1), row(call(), 'a', 2), row(call(), 'a', 3)]
  const bounded = callLedgerOf(rows, 2)
  assert.equal(bounded.calls.length, 2)
  assert.equal(bounded.totalCalls, 3)
  assert.equal(bounded.truncated, true)
  assert.deepEqual(callLedgerOf(rows, 0), { schema: 1, tokenScope: 'model-call', calls: [], totalCalls: 3, truncated: true })
  assert.equal(callLedgerOf(rows, 3).truncated, false)
  for (const limit of [-1, 0.5, NaN, Infinity, 1_000_001]) assert.throws(() => callLedgerOf(rows, limit), /maxRows/)
  async function* stream() { yield* rows }
  assert.deepEqual(await readCallLedger(stream(), 2), bounded)
})

test('recomputation is deterministic and output buffers do not mutate source events', () => {
  const event = call({ attempts: [429, 200] })
  const rows = [row(event)]
  const first = callLedgerOf(rows)
  assert.equal(JSON.stringify(first), JSON.stringify(callLedgerOf(rows)))
  first.calls[0].usage.inputTokens = 999
  ;(first.calls[0].attempts as number[])[0] = 0
  assert.equal(event.usage.inputTokens, 10)
  assert.deepEqual(event.attempts, [429, 200])
  assert.equal(callLedgerOf(rows).calls[0].usage.inputTokens, 10)
  assert.deepEqual(callLedgerOf([]), { schema: 1, tokenScope: 'model-call', calls: [], totalCalls: 0, truncated: false })
})


test('real journal reads are observational, deterministic and preserve incomplete tails', async () => {
  const emptyRoot = tmpDir('fugue-call-ledger-empty-')
  const emptyReader = openLog(emptyRoot)
  assert.equal((await readCallLedger(emptyReader.readMerged())).totalCalls, 0)
  await emptyReader.close()
  assert.deepEqual(readdirSync(emptyRoot), [])

  const root = tmpDir('fugue-call-ledger-journal-')
  const writer = openLog(root, { write: 'a', sync: 'each' })
  await writer.append('a', call({ headers: { diagnostic: 'must-not-appear' } }))
  await writer.close()
  const path = logFileOf(root, 'a')
  appendFileSync(path, '{"incomplete":')
  const before = readFileSync(path)
  const reader = openLog(root)
  const first = await readCallLedger(reader.readMerged())
  assert.deepEqual(await readCallLedger(reader.readMerged()), first)
  await reader.close()
  assert.deepEqual(readFileSync(path), before)
  assert.equal(first.totalCalls, 1)
  assert.deepEqual(first.calls[0].source, { writer: 'a', seq: 1 })
  assert.ok(!JSON.stringify(first).includes('must-not-appear'))
  assert.ok(!existsSync(path.replace(/\.jsonl$/, '.lock')))
})


test('developer CLI stays read-only for valid, corrupt and missing journal inputs', async () => {
  const root = tmpDir('fugue-call-ledger-cli-')
  const writer = openLog(root, { write: 'a', sync: 'each' })
  await writer.append('a', call())
  await writer.close()
  const script = fileURLToPath(new URL('../../tools/call-ledger.js', import.meta.url))
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  const path = logFileOf(root, 'a')
  const before = readFileSync(path)
  const first = run(root)
  const second = run(root)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(first.stdout, second.stdout)
  assert.equal(JSON.parse(first.stdout).totalCalls, 1)
  assert.deepEqual(readFileSync(path), before)
  assert.ok(!existsSync(path.replace(/\.jsonl$/, '.lock')))
  const zero = run(root, '0')
  assert.equal(zero.status, 0, zero.stderr)
  assert.equal(JSON.parse(zero.stdout).truncated, true)
  assert.notEqual(run(root, 'invalid').status, 0)

  const corrupt = before.toString().replace('"inputTokens":10', '"inputTokens":11')
  writeFileSync(path, corrupt)
  const denied = run(root)
  assert.notEqual(denied.status, 0)
  assert.equal(denied.stdout, '')
  assert.equal(readFileSync(path, 'utf8'), corrupt)
  assert.ok(!existsSync(path.replace(/\.jsonl$/, '.lock')))

  const missing = join(root, 'no-such-root')
  const empty = run(missing)
  assert.equal(empty.status, 0, empty.stderr)
  assert.equal(JSON.parse(empty.stdout).totalCalls, 0)
  assert.ok(!existsSync(missing))
})
