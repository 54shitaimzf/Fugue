#!/usr/bin/env node
// 只隔离候选探测调度：同一已准备 canonical 索引，旧串行 vs 当前有界只读 lanes。
// 完整首次 miss/后台准备成本仍由 bench-index-query.js 单列；这里不隐藏为免费 runtime 构建。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openTruth } from '../src/truth/truth.ts'
import { openLog } from '../src/log/log.ts'
import { loadView } from '../src/view/view.ts'
import { lowerAt } from '../src/view/lower.ts'
import { refHeadOf } from '../src/round/head.ts'
import { createRoots } from '../src/roots/roots.ts'
import { createBlobIndexLookup } from '../src/search/blob-index.ts'
import { createBlobIndexStore } from '../src/search/index-store.ts'
import { createToolHost } from '../src/tools/host.ts'
import { faceOf } from '../src/tools/execute.ts'

function argument(name, fallback, max) {
  const at = process.argv.indexOf(name)
  const value = at === -1 ? fallback : Number(process.argv[at + 1])
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 to ${max}`)
  return value
}
const runs = argument('--runs', 5, 20)
const files = argument('--files', 64, 1024)
const lines = argument('--lines', 64, 512)
const referenceAt = process.argv.indexOf('--reference-root')
const referenceArgument = referenceAt < 0 ? null : process.argv[referenceAt + 1]
if (!referenceArgument || referenceArgument.startsWith('--')) throw new Error('--reference-root requires the prior checkout path')
const referenceRoot = resolve(referenceArgument)
const referenceFactory = (await import(pathToFileURL(join(referenceRoot, 'src/tools/host.ts')).href)).createToolHost
if (typeof referenceFactory !== 'function') throw new Error('reference must export createToolHost')
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const sourceHashes = {
  referenceHost: hash(join(referenceRoot, 'src/tools/host.ts')),
  referenceCandidates: hash(join(referenceRoot, 'src/search/current-view-candidates.ts')),
  currentHost: hash(new URL('../src/tools/host.ts', import.meta.url)),
  currentCandidates: hash(new URL('../src/search/current-view-candidates.ts', import.meta.url)),
  indexLookup: hash(new URL('../src/search/blob-index.ts', import.meta.url)),
  indexStore: hash(new URL('../src/search/index-store.ts', import.meta.url)),
  indexFormat: hash(new URL('../src/search/index-format.ts', import.meta.url)),
}
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue', GIT_AUTHOR_EMAIL: 'fugue@localhost', GIT_COMMITTER_NAME: 'fugue', GIT_COMMITTER_EMAIL: 'fugue@localhost' }
const ctx = { agent: 'bench', step: 0, cwd: '', holder: false }
const grep = faceOf('grep')
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
// 全部参数、引用模块与源 hash 校验之后，才分配需要清理的目录。
const root = mkdtempSync(join(tmpdir(), 'fugue-index-probes-'))
async function build() {
  const start = performance.now()
  execFileSync('git', ['init', '-q', root], { env })
  const truth = openTruth(root)
  try {
    const entries = []
    const bodies = []
    for (let at = 0; at < files; at++) {
      const bytes = Buffer.from(Array.from({ length: lines }, (_, line) =>
        `dense_hit file${at} line${line} ${'x'.repeat(96)}${at === files - 1 && line === lines - 1 ? ' rare_hit' : ''}`,
      ).join('\n') + '\n')
      const id = await truth.putBlob(bytes)
      entries.push({ name: `corpus/file-${String(at).padStart(3, '0')}`, mode: 0o100644, id })
      bodies.push({ id, bytes })
    }
    const base = await truth.commit(await truth.putTree(entries), [], 'bounded probe comparison')
    const corpusBuildMs = performance.now() - start
    const preparedAt = performance.now()
    const store = createBlobIndexStore(root)
    for (const { id, bytes } of bodies) assert.equal((await store.rebuild(id, bytes)).stored, true)
    return { base, bytes: bodies.reduce((sum, body) => sum + body.bytes.length, 0),
      corpusBuildMs, offlineIndexPreparationMs: performance.now() - preparedAt }
  } finally { await truth.close() }
}
async function pass(base, pattern, factory) {
  const truth = openTruth(root)
  const log = openLog(root, { write: 'bench', sync: 'never' })
  const index = createBlobIndexLookup(root, id => truth.getBlob(id))
  try {
    const view = await loadView(log, 'bench', { lower: lowerAt(truth, base) })
    const product = factory(view, createRoots(root), { blobIndex: index,
      actions: { writer: 'bench', log, truth, head: await refHeadOf(log, 'bench', base) },
    })
    let reads = 0
    let prefetched = 0
    const host = { ...product, readBytes: async path => { reads++; return product.readBytes(path) },
      prefetch: async paths => { prefetched += paths.length; return product.prefetch(paths) },
    }
    const phases = {}
    let output
    for (const phase of ['diskCold', 'preparedRepeat']) {
      reads = 0; prefetched = 0
      const before = truth.stats()
      const indexBefore = index.stats()
      const start = performance.now()
      const result = (await grep({ pattern }, host, ctx)).output
      const after = truth.stats()
      const indexAfter = index.stats()
      if (output !== undefined) assert.equal(result, output, 'cold/repeat receipt differs')
      output = result
      phases[phase] = { ms: performance.now() - start, gitRequests: after.gitRequests - before.gitRequests,
        gitSpawns: after.gitSpawns - before.gitSpawns, reads, prefetched,
        diskHits: indexAfter.diskHits - indexBefore.diskHits, memoryHits: indexAfter.memoryHits - indexBefore.memoryHits,
        sourceReads: indexAfter.sourceReads - indexBefore.sourceReads, entries: indexAfter.entries }
    }
    assert.equal(index.stats().sourceReads, 0, 'prepared-only probe comparison accidentally measured a source/build miss')
    return { phases, output }
  } finally { await index.close(); await log.close(); await truth.close() }
}
function summarize(values) {
  return Object.fromEntries(['diskCold', 'preparedRepeat'].map(phase => {
    const rows = values.map(value => value.phases[phase])
    return [phase, { medianMs: Number(median(rows.map(row => row.ms)).toFixed(3)),
      samples: rows.map(row => ({ ...row, ms: Number(row.ms.toFixed(3)) })) }]
  }))
}
try {
  const fixture = await build()
  const cases = {}
  for (const [name, pattern] of [['dense', 'dense_hit'], ['sparse', 'rare_hit'], ['miss', 'absent_needle']]) {
    // 独立默认关闭的扫描作第三方答案；只放在计时 pairs 外，明确会预热文件系统缓存。
    const scanFactory = (view, roots, options) => createToolHost(view, roots, { ...options, blobIndex: undefined })
    const scan = await pass(fixture.base, pattern, scanFactory)
    const before = [], after = []
    for (let run = 0; run < runs; run++) {
      if (run % 2 === 0) { before.push(await pass(fixture.base, pattern, referenceFactory)); after.push(await pass(fixture.base, pattern, createToolHost)) }
      else { after.push(await pass(fixture.base, pattern, createToolHost)); before.push(await pass(fixture.base, pattern, referenceFactory)) }
      assert.equal(before[run].output, scan.output, 'reference indexed probe disagrees with default-off scan')
      assert.equal(after[run].output, scan.output, 'bounded indexed probe disagrees with default-off scan')
    }
    cases[name] = { pattern, defaultScan: summarize([scan]), reference: summarize(before), bounded: summarize(after) }
  }
  console.log(JSON.stringify({ files, lines, runs, sourceHashes, ...fixture, cases,
    boundary: 'isolated prepared-record probe scheduling; cloud overlay trend with default-scan reference outside timed pairs, no physical-cold claim; explicit offline preparation is not the runtime worker preparation cost; preparedRepeat may still read disk when over capacity' }, null, 2))
} finally { rmSync(root, { recursive: true, force: true }) }
