#!/usr/bin/env node
// 独立 record-reader 调度对照；不接 grep、不触发 source/Worker 或模型。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBlobIndex, encodeBlobIndex } from '../src/search/index-format.ts'
import { createBlobIndexStore } from '../src/search/index-store.ts'

function argument(name, fallback, maximum) {
  const at = process.argv.indexOf(name)
  const value = at < 0 ? fallback : Number(process.argv[at + 1])
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`)
  return value
}
const recoverUnknown = process.argv.includes('--recover-unknown')
const runs = argument('--runs', 7, 20)
const files = argument('--files', 512, 1024)
const lines = argument('--lines', 256, 512)
const batchRows = argument('--batch', 128, 128)
const entropyChars = process.argv.includes('--entropy-chars') ? argument('--entropy-chars', 50000, 200000) : null
const referenceBatchRows = process.argv.includes('--compare-batch') ? argument('--compare-batch', 4, 128) : null
if (entropyChars !== null && files * entropyChars > 8_000_000) {
  throw new Error('aggregate entropy work must not exceed 8,000,000 seeded code units')
}
const sourceHashes = Object.fromEntries(['index-store.ts', 'index-format.ts'].map(file =>
  [file, createHash('sha256').update(readFileSync(new URL(`../src/search/${file}`, import.meta.url))).digest('hex')]))
// 参数/源码校验之后分配；setup 的准备成本单列，不冒充 runtime Worker 成本。
sourceHashes.benchmark = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')
const root = mkdtempSync(join(tmpdir(), 'fugue-index-batch-bench-'))
const store = createBlobIndexStore(root)
const ids = [], expected = []
let sourceBytes = 0, canonicalBytes = 0, retainedGrams = 0
let activeCounts
let batchUnknownRecords = 0, fallbackReads = 0
const originalOpen = fs.open
function count(name) { if (activeCounts) activeCounts[name]++ }
fs.open = async (...args) => {
  count('open')
  const file = await originalOpen(...args)
  for (const method of ['stat', 'read', 'close']) {
    const original = file[method].bind(file)
    file[method] = async (...values) => { count(method); return original(...values) }
  }
  return file
}
syncBuiltinESMExports()
async function scalar() {
  const records = Array(ids.length).fill(null)
  let next = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < ids.length) { const at = next++; records[at] = await store.read(ids[at]) }
  }))
  return records
}
async function batched(rows = batchRows) {
  const records = []
  for (let at = 0; at < ids.length; at += rows) {
    const next = await store.readBatch(ids.slice(at, at + rows))
    assert.ok(next, 'stable private generated record batch became unavailable')
    const captured = [...next]
    batchUnknownRecords += captured.filter(record => record === null).length
    if (recoverUnknown) {
      let nextUnknown = 0
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (nextUnknown < captured.length) {
          const index = nextUnknown++
          if (captured[index] !== null) continue
          fallbackReads++; captured[index] = await store.read(ids[at + index])
          assert.ok(captured[index], 'generated valid record could not be reread')
        }
      }))
    }
    records.push(...captured)
  }
  return records
}
async function measure(invoke) {
  batchUnknownRecords = 0; fallbackReads = 0
  activeCounts = { open: 0, stat: 0, read: 0, close: 0 }
  const start = performance.now()
  const records = await invoke()
  const result = { ms: performance.now() - start, calls: activeCounts, batchUnknownRecords, fallbackReads, unknownRecords: records.filter(record => record === null).length }
  activeCounts = undefined
  assert.equal(records.length, expected.length)
  if (entropyChars === null || recoverUnknown) assert.deepEqual(records, expected, 'reader differed from independently constructed source indexes')
  else for (let at = 0; at < records.length; at++) {
    if (records[at] !== null) assert.deepEqual(records[at], expected[at], 'known record differed from full-source index')
  }
  return result
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
try {
  const setupAt = performance.now()
  for (let at = 0; at < files; at++) {
    const repeated = Buffer.from(Array.from({ length: lines }, (_, line) =>
      `dense_hit file${at} line${line} ${'x'.repeat(96)}${at === files - 1 && line === lines - 1 ? ' rare_hit' : ''}`,
    ).join('\n') + '\n')
    let bytes = repeated
    if (entropyChars !== null) {
      let state = at + 1
      const characters = []
      for (let at = 0; at < entropyChars; at++) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5
        characters.push(String.fromCharCode(0x100 + (state >>> 0) % 512))
      }
      bytes = Buffer.from(characters.join(''), 'utf8')
    }
    sourceBytes += bytes.length
    const id = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    const index = buildBlobIndex(id, bytes)
    ids.push(id); expected.push(index)
    canonicalBytes += encodeBlobIndex(index).byteLength; retainedGrams += index.tables.trigrams.length
    assert.equal((await store.rebuild(id, bytes)).stored, true)
  }
  const setupMs = performance.now() - setupAt
  const before = [], after = []
  const reference = referenceBatchRows === null ? scalar : () => batched(referenceBatchRows)
  for (let run = 0; run < runs; run++) {
    if (run % 2 === 0) { before.push(await measure(reference)); after.push(await measure(batched)) }
    else { after.push(await measure(batched)); before.push(await measure(reference)) }
  }
  console.log(JSON.stringify({ node: process.version, files, lines, entropyChars, recoverUnknown, referenceBatchRows, batchRows, sourceBytes, canonicalBytes, retainedGrams, runs, sourceHashes, setupMs,
    beforeMedianMs: median(before.map(value => value.ms)), afterMedianMs: median(after.map(value => value.ms)), before, after,
    boundary: 'own generated validated records; four leaf lanes on both sides; no persistent fd/cache; OS page cache primed; wrappers add overhead; API-call counts are not kernel syscall counts; unknownRecords count valid disk records skipped by aggregate budgets; recoverUnknown optionally rereads unavailable disk records with four scalar lanes for full-reference equivalence; sourceReads/builds are not measured because no lookup factory runs; no query/default/physical-cold acceptance' }, null, 2))
} finally {
  fs.open = originalOpen; syncBuiltinESMExports()
  rmSync(root, { recursive: true, force: true })
}
