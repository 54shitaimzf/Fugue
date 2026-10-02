#!/usr/bin/env node
// A single generated immutable warm-path counterfactual, not a product implementation or matrix.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { openTruth } from '../src/truth/truth.ts'
import { openLog } from '../src/log/log.ts'
import { loadView } from '../src/view/view.ts'
import { lowerAt } from '../src/view/lower.ts'
import { refHeadOf } from '../src/round/head.ts'
import { createRoots } from '../src/roots/roots.ts'
import { createToolHost } from '../src/tools/host.ts'
import { faceOf } from '../src/tools/execute.ts'
import { createCohortIndexStore } from '../src/search/cohort-store.ts'
import { createViewCohortLookup } from '../src/search/view-cohort.ts'
import { grepVerificationStats } from '../src/tools/grep-verifier.ts'
import { withCohortBenchmarkHandles } from './cohort-benchmark-owned.js'
import { settleBenchmarkCleanups } from './benchmark-cleanup.js'
const repo = resolve(import.meta.dirname, '..'), made = []
const temp = prefix => { const root = mkdtempSync(join(repo, prefix)); made.push(root); return root }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const delta = (a, b) => Object.fromEntries(Object.keys(b).filter(k => typeof b[k] === 'number').map(k => [k, b[k] - a[k]]))
let outcome = { failed: false }
try {
const home = temp('.prefetch-probe-home-'), root = temp('.prefetch-probe-')
const env = { PATH: process.env.PATH, HOME: home, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'fugue', GIT_AUTHOR_EMAIL: 'fugue@localhost', GIT_COMMITTER_NAME: 'fugue', GIT_COMMITTER_EMAIL: 'fugue@localhost' }
execFileSync('git', ['init', '-q', '--object-format=sha1', root], { env })
const seed = openTruth(root), digest = createHash('sha256'); let base
try {
  const entries = []
  for (let file = 0; file < 512; file++) {
    const body = Buffer.alloc(32768, 'x')
    Buffer.from(`generated-${file}`).copy(body)
    for (let line = 1; line <= 256; line++) body[line * 128 - 1] = 10
    if (file === 511) Buffer.from('rare_hit').copy(body, body.length - 10)
    const name = `c/f${String(file).padStart(4, '0')}`
    digest.update(name + '\0'); digest.update(body)
    entries.push({ name, mode: 0o100644, id: await seed.putBlob(body) })
  }
  base = await seed.commit(await seed.putTree(entries), [], 'generated all-hit prefetch probe')
} finally { await seed.close() }
const result = await withCohortBenchmarkHandles(async owned => {
  const truth = owned.truth = openTruth(root), log = owned.log = openLog(root, { write: 'bench', sync: 'never' })
  const view = await loadView(log, 'bench', { lower: lowerAt(truth, base) }), head = await refHeadOf(log, 'bench', base)
  let reads = 0, statCalls = 0, prefetchedIds = 0, prefetchCalls = 0
  const read = view.read.bind(view), stat = view.stat.bind(view), prefetch = truth.prefetchBlobs.bind(truth)
  view.read = async path => { reads++; return read(path) }
  view.stat = async path => { statCalls++; return stat(path) }
  truth.prefetchBlobs = async ids => { prefetchCalls++; prefetchedIds += ids.length; return prefetch(ids) }
  const roots = createRoots(root), scan = createToolHost(view, roots)
  const store = owned.store = createCohortIndexStore(root), index = owned.index = createViewCohortLookup(view, () => scan.walk(), store)
  const host = createToolHost(view, roots, { actions: { writer: 'bench', log, truth, head }, cohortIndex: index })
  const originalPrefetch = host.prefetch, originalRead = host.readBytes
  const grep = faceOf('grep'), args = { pattern: 'rare(?:_hit)' }, context = { agent: 'bench', step: 0, cwd: '', holder: false }
  async function measure(mode) {
    host.prefetch = mode === 'fullPrefetch' ? originalPrefetch : async () => undefined
    assert.equal(host.readBytes, originalRead)
    reads = 0; statCalls = 0; prefetchedIds = 0; prefetchCalls = 0
    const before = truth.stats(), verify = grepVerificationStats(host), cpu = process.cpuUsage(), start = performance.now()
    const receipt = await grep(args, host, context), used = process.cpuUsage(cpu)
    return { mode, ms: performance.now() - start, cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000, reads, statCalls, prefetchedIds, prefetchCalls, truthDelta: delta(before, truth.stats()), verificationDelta: delta(verify, grepVerificationStats(host)), verification: grepVerificationStats(host), receipt }
  }
  try {
    const coldWarmup = await measure('fullPrefetch'), expected = coldWarmup.receipt
    assert.equal(expected.ok, true); assert.ok(expected.output.includes('c/f0511:256:'))
    assert.equal(coldWarmup.verification.verifiedSources, 512); assert.equal(coldWarmup.verification.entries, 512)
    const samples = []
    for (const mode of ['fullPrefetch', 'disabledFixturePrefetch', 'disabledFixturePrefetch', 'fullPrefetch']) {
      const sample = await measure(mode)
      assert.deepEqual(sample.receipt, expected); assert.equal(sample.reads, 0); assert.equal(sample.verificationDelta.sourceReads, 0); assert.equal(sample.verificationDelta.hits, 512)
      sample.receiptSha256 = hash(JSON.stringify(sample.receipt)); delete sample.receipt
      samples.push(sample)
    }
    coldWarmup.receiptSha256 = hash(JSON.stringify(coldWarmup.receipt)); delete coldWarmup.receipt
    return { coldWarmup, samples }
  } finally { host.prefetch = originalPrefetch }
}, run => run)
const modules = ['src/tools/execute.ts', 'src/tools/host.ts', 'src/tools/grep-verifier.ts', 'src/truth/truth.ts', 'src/truth/git.ts', 'src/view/view.ts', 'src/search/view-cohort.ts']
console.log(JSON.stringify({ schema: 1, node: process.version, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), scriptSha256: hash(readFileSync(import.meta.filename)), sourceHashes: Object.fromEntries(modules.map(p => [p, hash(readFileSync(join(repo, p)))])), generated: { files: 512, bytes: 16777216, corpusSha256: digest.digest('hex') }, result,
  boundary: 'One immutable generated corpus on exact527, one host and four warm alternating counterfactual samples; no matrix, provider, index preparation or default activation. Disabled fixture prefetch is not a safe shipping decision or implementation: there is no non-loading readiness API today. Existing verifier still performs current View/reader/pattern checks on every path, with all512 genuine cache hits asserted. Full FaceResult equality asserted. OS cache/host noise not controlled. Seed/handle construction outside clocks. Counters distinguish requested IDs, batch Git requests and actual View reads. No physical IO byte, RSS or universal latency claim.' }, null, 2))
} catch (error) { outcome = { failed: true, error } }
finally { await settleBenchmarkCleanups(made.reverse().map(root => () => rmSync(root, { recursive: true, force: true })), outcome) }
