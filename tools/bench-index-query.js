#!/usr/bin/env node
// 实际 Truth/View/grep：首 miss、显式准备、磁盘冷读、内存热读，对照默认关闭的扫描。
// 只记录 cloud 趋势和资源读数，不给产品设速度断言，不触发模型或 live 录制。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { openTruth } from '../src/truth/truth.ts'
import { openLog } from '../src/log/log.ts'
import { loadView } from '../src/view/view.ts'
import { lowerAt } from '../src/view/lower.ts'
import { createRoots } from '../src/roots/roots.ts'
import { createBlobIndexLookup } from '../src/search/blob-index.ts'
import { requiredLiteralTrigrams } from '../src/search/regex-literal.ts'
import { createToolHost } from '../src/tools/host.ts'
import { faceOf } from '../src/tools/execute.ts'
import { refHeadOf } from '../src/round/head.ts'

function argument(name, fallback, max) {
  const at = process.argv.indexOf(name)
  const value = at === -1 ? fallback : Number(process.argv[at + 1])
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 to ${max}`)
  return value
}
const runs = argument('--runs', 3, 10)
const files = argument('--files', 64, 1024)
const lines = argument('--lines', 64, 512)
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue', GIT_AUTHOR_EMAIL: 'fugue@localhost', GIT_COMMITTER_NAME: 'fugue', GIT_COMMITTER_EMAIL: 'fugue@localhost' }
const grep = faceOf('grep')
const ctx = { agent: 'bench', step: 0, cwd: '', holder: false }
const made = []
const sourceHashes = Object.fromEntries([
  '../src/tools/execute.ts', '../src/tools/host.ts', '../src/search/current-view-candidates.ts',
  '../src/search/regex-literal.ts', '../src/search/blob-index.ts', '../src/search/index-store.ts',
].map(path => [path.slice(3), createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')]))
const indexDirectory = dirname(realpathSync(new URL('../src/search/blob-index.ts', import.meta.url)))
for (const file of ['index-format.ts', 'index-source.ts', 'index-worker.ts']) {
  sourceHashes[`src/search/${file}`] = createHash('sha256').update(readFileSync(join(indexDirectory, file))).digest('hex')
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

function counters(truth) {
  const { gitRequests, gitSpawns } = truth.stats()
  return { gitRequests, gitSpawns }
}
function delta(before, after) {
  return { gitRequests: after.gitRequests - before.gitRequests, gitSpawns: after.gitSpawns - before.gitSpawns }
}
async function build(root) {
  execFileSync('git', ['init', '-q', root], { env })
  const truth = openTruth(root)
  try {
    const entries = []
    let bytes = 0
    for (let at = 0; at < files; at++) {
      const body = Buffer.from(Array.from({ length: lines }, (_, line) =>
        `dense_hit file${at} line${line} ${'x'.repeat(96)}${at === files - 1 && line === lines - 1 ? ' rare_hit' : ''}`,
      ).join('\n') + '\n')
      bytes += body.length
      entries.push({ name: `corpus/file-${String(at).padStart(3, '0')}`, mode: 0o100644, id: await truth.putBlob(body) })
    }
    return { base: await truth.commit(await truth.putTree(entries), [], 'index query matrix'), bytes }
  } finally { await truth.close() }
}
async function session(root, base, indexed) {
  const truth = openTruth(root)
  const log = openLog(root, { write: 'bench', sync: 'never' })
  let index
  try {
    const view = await loadView(log, 'bench', { lower: lowerAt(truth, base) })
    index = indexed ? createBlobIndexLookup(root, id => truth.getBlob(id)) : undefined
    const product = createToolHost(view, createRoots(root), { blobIndex: index,
      actions: { writer: 'bench', log, truth, head: await refHeadOf(log, 'bench', base) },
    })
    let reads = 0
    let prefetched = 0
    const host = { ...product,
      readBytes: async path => { reads++; return product.readBytes(path) },
      prefetch: async paths => { prefetched += paths.length; return product.prefetch(paths) },
    }
    const measure = async pattern => {
      reads = 0; prefetched = 0
      const before = counters(truth)
      const start = performance.now()
      const output = (await grep({ pattern }, host, ctx)).output
      return { output, ms: performance.now() - start, ...delta(before, counters(truth)), reads, prefetched, index: index?.stats() }
    }
    const drain = async () => {
      const before = counters(truth)
      const start = performance.now()
      await index?.drain()
      return { ms: performance.now() - start, ...delta(before, counters(truth)), index: index?.stats() }
    }
    const prepare = async pattern => {
      const before = counters(truth)
      const start = performance.now()
      await index.drain()
      const required = requiredLiteralTrigrams(pattern)
      for (const path of await host.walk()) {
        const meta = await view.stat(path)
        if (meta?.kind !== 'file') continue
        await index.mightContain(meta.id, required); await index.drain()
      }
      return { ms: performance.now() - start, ...delta(before, counters(truth)), index: index.stats() }
    }
    return { measure, drain, prepare, close: async () => { await index?.close(); await log.close(); await truth.close() } }
  } catch (error) {
    await index?.close(); await log.close(); await truth.close(); throw error
  }
}
async function trial(pattern) {
  const root = mkdtempSync(join(tmpdir(), 'fugue-index-query-bench-'))
  made.push(root)
  const { base, bytes } = await build(root)
  const plain = await session(root, base, false)
  let plainCold, plainHot
  try { plainCold = await plain.measure(pattern); plainHot = await plain.measure(pattern) }
  finally { await plain.close() }
  const missing = await session(root, base, true)
  let firstMissing, backgroundDrain, preparation
  try {
    firstMissing = await missing.measure(pattern)
    backgroundDrain = await missing.drain()
    preparation = await missing.prepare(pattern)
  } finally { await missing.close() }
  const restarted = await session(root, base, true)
  let diskCold, preparedRepeat
  try { diskCold = await restarted.measure(pattern); preparedRepeat = await restarted.measure(pattern) }
  finally { await restarted.close() }
  const results = { plainCold, plainHot, firstMissing, diskCold, preparedRepeat }
  const referenceOutput = plainCold.output
  for (const result of Object.values(results)) {
    assert.equal(result.output, referenceOutput, 'candidate indexing changed exact grep receipt')
    delete result.output
  }
  return { bytes, ...results, backgroundDrain, preparation }
}
function summarize(trials) {
  const phases = ['plainCold', 'plainHot', 'firstMissing', 'backgroundDrain', 'preparation', 'diskCold', 'preparedRepeat']
  return Object.fromEntries(phases.map(phase => {
    const values = trials.map(trial => trial[phase])
    return [phase, { medianMs: Number(median(values.map(value => value.ms)).toFixed(3)),
      gitRequests: values.map(value => value.gitRequests), gitSpawns: values.map(value => value.gitSpawns),
      reads: values.map(value => value.reads), prefetched: values.map(value => value.prefetched), indexes: values.map(value => value.index) }]
  }))
}
try {
  const cases = {}
  let bytes
  for (const [name, pattern] of [['dense', 'dense_hit'], ['sparse', 'rare_hit'], ['miss', 'absent_needle']]) {
    const trials = []
    for (let at = 0; at < runs; at++) trials.push(await trial(pattern))
    bytes = trials[0].bytes
    cases[name] = { pattern, ...summarize(trials) }
  }
  console.log(JSON.stringify({ files, lines, bytes, runs, sourceHashes, cases,
    boundary: 'cloud trend only; opt-in derived index; first missing query and observed background/preparation costs are separate; preparedRepeat is memory-hot only if the working set fits retained budgets; full blobs still vary in bytes' }, null, 2))
} finally {
  for (const root of made) rmSync(root, { recursive: true, force: true })
}
