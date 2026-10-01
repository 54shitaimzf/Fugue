#!/usr/bin/env node
// 只拆开发侧已准备索引的读/校验成本，不接产品，不绕过store信任检查。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { observeIndexReads } from './index-validation-instrument.js'
import { openTruth } from '../src/truth/truth.ts'
import { createBlobIndexStore } from '../src/search/index-store.ts'
import { createBlobIndexLookup } from '../src/search/blob-index.ts'

const root = mkdtempSync(join(tmpdir(), 'fugue-index-validation-'))
const truthEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const records = [], required = ['nee', 'eed', 'edl', 'dle']
let truth
let forbiddenSourceCalls = 0
const noSource = async () => { forbiddenSourceCalls++; throw new Error('prepared disk phase must not retrieve source') }
async function measure(observed = false) {
  const instrumentation = observed ? observeIndexReads() : undefined
  let lookup
  try {
    lookup = createBlobIndexLookup(root, noSource, { facts: false })
    let next = 0
    const hits = [], start = performance.now()
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < records.length) {
        const row = records[next++]
        const got = await lookup.mightContain(row.blob, required)
        assert.notEqual(got, null, 'every generated record must pass complete store validation')
        assert.equal(got, row.expected)
        if (got) hits.push(row.blob)
      }
    }))
    const ms = performance.now() - start
    assert.deepEqual(hits.sort(), records.filter(row => row.expected).map(row => row.blob).sort())
    return { ms, hitIds: hits, stats: lookup.stats(), metrics: instrumentation?.metrics() }
  } finally {
    try { await lookup?.close() }
    finally { instrumentation?.restore() }
  }
}
try {
  execFileSync('git', ['init', '-q', root], { env: truthEnv })
  truth = openTruth(root)
  const store = createBlobIndexStore(root)
  const preparationStart = performance.now()
  let sourceBytes = 0
  for (let file = 0; file < 512; file++) {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, line) => `file${file} line${line} ${'x'.repeat(106)}${file % 16 === 0 && line === 255 ? ' needle' : ''}`).join('\n') + '\n')
    sourceBytes += bytes.byteLength
    const blob = await truth.putBlob(bytes)
    const built = await store.rebuild(blob, bytes)
    assert.equal(built.stored, true)
    // 参考来自生成Git原字节，不从索引或probe结果反推期待答案。
    records.push({ blob, expected: bytes.toString('utf8').includes('needle') })
  }
  const preparationMs = performance.now() - preparationStart
  const samples = []
  // 固定交替顺序仅是趋势探针；包装过的时延不能冒充无观察器产品时延。
  for (let pair = 0; pair < 3; pair++) {
    if (pair % 2 === 0) samples.push({ plain: await measure(), observed: await measure(true) })
    else {
      const observed = await measure(true)
      samples.push({ plain: await measure(), observed })
    }
  }
  assert.equal(forbiddenSourceCalls, 0)
  for (const sample of samples) {
    assert.equal(sample.observed.metrics.open.calls, records.length * 6)
    assert.equal(sample.observed.metrics.stat.calls, records.length * 7)
    assert.equal(sample.observed.metrics.read.calls, records.length * 2)
    assert.equal(sample.observed.metrics.close.calls, records.length * 6)
    assert.equal(sample.plain.stats.diskHits, records.length)
    assert.equal(sample.observed.stats.diskHits, records.length)
  }
  const modules = ['tools/bench-index-validation.js', 'tools/index-validation-instrument.js', 'src/search/blob-index.ts', 'src/search/index-store.ts', 'src/search/index-format.ts', 'src/search/index-worker-pool.ts', 'src/search/index-worker-reply.ts', 'src/search/index-worker.ts', 'src/search/index-gram-facts.ts', 'src/search/index-source.ts']
  const sourceHashes = Object.fromEntries(modules.map(path => [path, createHash('sha256').update(readFileSync(new URL('../' + path, import.meta.url))).digest('hex')]))
  console.log(JSON.stringify({ records: records.length, sourceBytes, preparationMs, sourceHashes, samples,
    boundary: 'Generated Git corpus only. Four concurrent prepared lookups; facts disabled and fresh handles. API durations overlap and cannot be summed into wall fractions. Wrappers add CPU/allocation/scheduling overhead; compare separate plain wall samples. Preparation uses foreground store.rebuild, not product background workers. No current-View query or ext4/default activation claim.' }, null, 2))
} finally {
  try { await truth?.close() }
  finally { rmSync(root, { recursive: true, force: true }) }
}
