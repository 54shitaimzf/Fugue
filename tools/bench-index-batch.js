#!/usr/bin/env node
// 独立 record-reader 调度对照；不接 grep、不触发 source/Worker 或模型。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBlobIndex } from '../src/search/index-format.ts'
import { createBlobIndexStore } from '../src/search/index-store.ts'

function argument(name, fallback, maximum) {
  const at = process.argv.indexOf(name)
  const value = at < 0 ? fallback : Number(process.argv[at + 1])
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`)
  return value
}
const runs = argument('--runs', 7, 20)
const files = argument('--files', 512, 1024)
const lines = argument('--lines', 256, 512)
const batchRows = argument('--batch', 128, 128)
const sourceHashes = Object.fromEntries(['index-store.ts', 'index-format.ts'].map(file =>
  [file, createHash('sha256').update(readFileSync(new URL(`../src/search/${file}`, import.meta.url))).digest('hex')]))
// 参数/源码校验之后分配；setup 的准备成本单列，不冒充 runtime Worker 成本。
const root = mkdtempSync(join(tmpdir(), 'fugue-index-batch-bench-'))
const store = createBlobIndexStore(root)
const ids = [], expected = []
let sourceBytes = 0
let activeCounts
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
async function batched() {
  const records = []
  for (let at = 0; at < ids.length; at += batchRows) {
    const next = await store.readBatch(ids.slice(at, at + batchRows))
    assert.ok(next, 'stable private generated record batch became unavailable')
    records.push(...next)
  }
  return records
}
async function measure(invoke) {
  activeCounts = { open: 0, stat: 0, read: 0, close: 0 }
  const start = performance.now()
  const records = await invoke()
  const result = { ms: performance.now() - start, calls: activeCounts }
  activeCounts = undefined
  assert.deepEqual(records, expected, 'reader differed from independently constructed source indexes')
  return result
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
try {
  const setupAt = performance.now()
  for (let at = 0; at < files; at++) {
    const bytes = Buffer.from(Array.from({ length: lines }, (_, line) =>
      `dense_hit file${at} line${line} ${'x'.repeat(96)}${at === files - 1 && line === lines - 1 ? ' rare_hit' : ''}`,
    ).join('\n') + '\n')
    sourceBytes += bytes.length
    const id = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    ids.push(id); expected.push(buildBlobIndex(id, bytes))
    assert.equal((await store.rebuild(id, bytes)).stored, true)
  }
  const setupMs = performance.now() - setupAt
  const before = [], after = []
  for (let run = 0; run < runs; run++) {
    if (run % 2 === 0) { before.push(await measure(scalar)); after.push(await measure(batched)) }
    else { after.push(await measure(batched)); before.push(await measure(scalar)) }
  }
  console.log(JSON.stringify({ files, lines, batchRows, sourceBytes, runs, sourceHashes, setupMs,
    beforeMedianMs: median(before.map(value => value.ms)), afterMedianMs: median(after.map(value => value.ms)), before, after,
    boundary: 'own generated validated records; four leaf lanes on both sides; no persistent fd/cache; OS page cache primed; wrappers add overhead; API-call counts are not kernel syscall counts; no query/default/physical-cold acceptance' }, null, 2))
} finally {
  fs.open = originalOpen; syncBuiltinESMExports()
  rmSync(root, { recursive: true, force: true })
}
