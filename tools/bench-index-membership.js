#!/usr/bin/env node
// 用指定的已审查产品checkout核实际grep；同一后台/盘读，只隔离有界事实缓存。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createBlobIndexLookup } from '../src/search/blob-index.ts'
import { createBlobIndexStore } from '../src/search/index-store.ts'
import { closeIndexBenchmark } from './bench-index-cleanup.js'
function argument(name, fallback, maximum) {
  const at = process.argv.indexOf(name), value = at < 0 ? fallback : Number(process.argv[at + 1])
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`invalid ${name}`)
  return value
}
const at = process.argv.indexOf('--product-root')
if (at < 0 || !process.argv[at + 1] || process.argv[at + 1].startsWith('--')) throw new Error('--product-root requires a reviewed query checkout')
const referenceAt = process.argv.indexOf('--reference-root')
if (referenceAt < 0 || !process.argv[referenceAt + 1] || process.argv[referenceAt + 1].startsWith('--')) throw new Error('--reference-root requires the prior lookup checkout')
const referenceRoot = resolve(process.argv[referenceAt + 1])
const referenceFactory = (await import(pathToFileURL(join(referenceRoot, 'src/search/blob-index.ts')).href)).createBlobIndexLookup
if (typeof referenceFactory !== 'function') throw new Error('reference must export createBlobIndexLookup')
const productRoot = resolve(process.argv[at + 1]), runs = argument('--runs', 3, 10), files = argument('--files', 512, 1024), lines = argument('--lines', 256, 512)
const modules = {}
for (const name of ['truth/truth', 'log/log', 'view/view', 'view/lower', 'round/head', 'roots/roots', 'tools/host', 'tools/execute']) {
  modules[name] = await import(pathToFileURL(join(productRoot, `src/${name}.ts`)).href)
}
const sourceHashes = {}
for (const name of ['tools/host', 'tools/execute', 'search/current-view-candidates', 'search/regex-literal']) {
  sourceHashes[`product/src/${name}.ts`] = createHash('sha256').update(readFileSync(join(productRoot, `src/${name}.ts`))).digest('hex')
}
for (const name of ['blob-index', 'index-gram-facts', 'index-format', 'index-store', 'index-worker', 'index-worker-pool', 'index-worker-reply', 'index-source']) {
  sourceHashes[`lookup/src/search/${name}.ts`] = createHash('sha256').update(readFileSync(new URL(`../src/search/${name}.ts`, import.meta.url))).digest('hex')
}
for (const name of ['blob-index', 'index-store', 'index-format']) {
  sourceHashes[`reference/src/search/${name}.ts`] = createHash('sha256').update(readFileSync(join(referenceRoot, `src/search/${name}.ts`))).digest('hex')
}
assert.notEqual(sourceHashes['reference/src/search/blob-index.ts'], sourceHashes['lookup/src/search/blob-index.ts'], 'reference backend must be distinct')
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'fugue', GIT_AUTHOR_EMAIL: 'fugue@localhost', GIT_COMMITTER_NAME: 'fugue', GIT_COMMITTER_EMAIL: 'fugue@localhost' }
const root = mkdtempSync(join(tmpdir(), 'fugue-membership-query-'))
const ctx = { agent: 'bench', step: 0, cwd: '', holder: false }
const patterns = ['rare_hit', 'rare_hit', 'absent_needle', 'dense_hit', 'file510', 'rare_hit', 'absent_needle']
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
async function fixture() {
  execFileSync('git', ['init', '-q', root], { env })
  const truth = modules['truth/truth'].openTruth(root), store = createBlobIndexStore(root)
  const start = performance.now()
  try {
    const entries = []; let bytes = 0
    for (let file = 0; file < files; file++) {
      const body = Buffer.from(Array.from({ length: lines }, (_, line) => `dense_hit file${file} line${line} ${'x'.repeat(96)}${file === files - 1 && line === lines - 1 ? ' rare_hit' : ''}`).join('\n') + '\n')
      bytes += body.length
      const blob = await truth.putBlob(body)
      assert.equal((await store.rebuild(blob, body)).stored, true)
      entries.push({ name: `corpus/file-${String(file).padStart(3, '0')}`, mode: 0o100644, id: blob })
    }
    return { base: await truth.commit(await truth.putTree(entries), [], 'membership query fixture'), bytes, offlinePreparationMs: performance.now() - start }
  } finally { await truth.close() }
}
async function session(base, mode) {
  const truth = modules['truth/truth'].openTruth(root)
  let log, lookup
  try {
    log = modules['log/log'].openLog(root, { write: 'bench', sync: 'never' })
    const factory = mode === 'tables' ? referenceFactory : createBlobIndexLookup
    lookup = mode === 'scan' ? undefined : factory(root, blob => truth.getBlob(blob))
    const view = await modules['view/view'].loadView(log, 'bench', { lower: modules['view/lower'].lowerAt(truth, base) })
    const host = modules['tools/host'].createToolHost(view, modules['roots/roots'].createRoots(root), { blobIndex: lookup,
      actions: { writer: 'bench', log, truth, head: await modules['round/head'].refHeadOf(log, 'bench', base) } })
    const rows = []
    for (const pattern of patterns) {
      const before = truth.stats(), oldIndex = lookup?.stats(), start = performance.now()
      const result = await modules['tools/execute'].faceOf('grep')({ pattern }, host, ctx)
      const ms = performance.now() - start, after = truth.stats(), stats = lookup?.stats()
      rows.push({ pattern, output: result.output, ms, gitRequests: after.gitRequests - before.gitRequests, gitSpawns: after.gitSpawns - before.gitSpawns,
        diskHits: stats && stats.diskHits - oldIndex.diskHits, factHits: stats?.factHits === undefined ? null : stats.factHits - oldIndex.factHits, stats })
    }
    if (lookup) assert.equal(lookup.stats().sourceReads, 0, 'prepared benchmark unexpectedly built source indexes')
    return rows
  } finally { await closeIndexBenchmark(lookup, log, truth) }
}
try {
  const built = await fixture()
  // 默认关闭的独立扫描在pairs外。它会预热OS页缓存，不冒充物理冷盘。
  const reference = await session(built.base, 'scan'), trials = []
  for (let trial = 0; trial < runs; trial++) {
    let tables, facts
    if (trial % 2 === 0) { tables = await session(built.base, 'tables'); facts = await session(built.base, 'facts') }
    else { facts = await session(built.base, 'facts'); tables = await session(built.base, 'tables') }
    for (let row = 0; row < patterns.length; row++) {
      assert.equal(tables[row].output, reference[row].output)
      assert.equal(facts[row].output, reference[row].output)
      delete tables[row].output; delete facts[row].output
      assert.ok(facts[row].stats.factKeys <= 32768 && facts[row].stats.factEntries <= 2048 && facts[row].stats.factLogicalBytes <= 1024 * 1024)
    }
    if (files > 256) { assert.equal(tables[1].diskHits, files); assert.equal(facts[1].diskHits, 0); assert.equal(facts[1].factHits, files) }
    trials.push({ tables, facts })
  }
  const medians = patterns.map((pattern, row) => ({ pattern,
    tablesMs: Number(median(trials.map(trial => trial.tables[row].ms)).toFixed(3)), factsMs: Number(median(trials.map(trial => trial.facts[row].ms)).toFixed(3)) }))
  console.log(JSON.stringify({ files, lines, runs, ...built, sourceHashes, medians, trials,
    boundary: 'Prepared records only; explicit offline preparation is not runtime miss/drain cost. Default scan prewarms OS caches. Exact receipts verified across varied/repeated queries, no general50ms/cold/ext4/default activation claim.' }, null, 2))
} finally { rmSync(root, { recursive: true, force: true }) }
