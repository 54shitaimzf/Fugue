#!/usr/bin/env node
// Full Truth/View/grep receipts, generated corpus only. No model/live capture or default activation.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTruth } from '../src/truth/truth.ts'
import { openLog } from '../src/log/log.ts'
import { loadView } from '../src/view/view.ts'
import { lowerAt } from '../src/view/lower.ts'
import { createRoots } from '../src/roots/roots.ts'
import { createToolHost } from '../src/tools/host.ts'
import { faceOf } from '../src/tools/execute.ts'
import { createCohortIndexStore } from '../src/search/cohort-store.ts'
import { createViewCohortLookup } from '../src/search/view-cohort.ts'
import { withCohortBenchmarkHandles } from './cohort-benchmark-owned.js'

function integer(name, fallback, max) {
  const at = process.argv.indexOf(name), value = at < 0 ? fallback : Number(process.argv[at + 1])
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`invalid ${name}`)
  return value
}
const runs = integer('--runs', 3, 5), files = integer('--files', 64, 512), lines = integer('--lines', 64, 256)
const profileAt = process.argv.indexOf('--profile'), profile = profileAt < 0 ? 'code' : process.argv[profileAt + 1]
if (!['code', 'mixed', 'entropy'].includes(profile)) throw new Error('invalid profile')
const made = []
const temporary = name => { const root = mkdtempSync(join(tmpdir(), name)); made.push(root); return root }
try {
const home = temporary('fugue-cohort-bench-home-')
const env = { PATH: process.env.PATH, HOME: home, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue', GIT_AUTHOR_EMAIL: 'fugue@localhost', GIT_COMMITTER_NAME: 'fugue', GIT_COMMITTER_EMAIL: 'fugue@localhost' }
const grep = faceOf('grep'), context = { agent: 'bench', step: 0, cwd: '', holder: false }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const modules = ['src/tools/execute.ts', 'src/tools/host.ts', 'src/tools/walk.ts', 'src/search/view-cohort.ts',
  'src/search/cohort-store.ts', 'src/search/cohort-format.ts', 'src/search/index-format.ts',
  'src/truth/truth.ts', 'src/truth/git.ts', 'src/view/view.ts', 'src/view/lower.ts', 'src/log/log.ts',
  'tools/cohort-benchmark-owned.js', 'tools/bench-cohort-query.js']
const sourceHashes = Object.fromEntries(modules.map(path => [path, hash(readFileSync(new URL('../' + path, import.meta.url)))]))
const counters = truth => { const s = truth.stats(); return { gitRequests: s.gitRequests, gitSpawns: s.gitSpawns } }
const difference = (a, b) => ({ gitRequests: b.gitRequests - a.gitRequests, gitSpawns: b.gitSpawns - a.gitSpawns })
const median = numbers => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)]

function corpus() {
  let seed = 0x541ea, bytes = 0
  const digest = createHash('sha256'), bodies = []
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed & 255 }
  for (let file = 0; file < files; file++) {
    const chunks = []
    for (let line = 0; line < lines; line++) {
      const marker = `dense_hit file${file} line${line} `
      if (profile === 'code') chunks.push(Buffer.from(marker + 'x'.repeat(96)))
      else if (profile === 'mixed') chunks.push(Buffer.from(marker + `const 变量_${file}_${line} = "😀 e\u0301";\0` + 'value '.repeat(11)))
      else chunks.push(Buffer.concat([Buffer.from(marker), Buffer.from(Array.from({ length: 96 }, random))]))
      if (file === files - 1 && line === lines - 1) chunks.push(Buffer.from(' rare_hit'))
      chunks.push(Buffer.from('\n'))
    }
    const body = Buffer.concat(chunks), path = `corpus/file-${String(file).padStart(3, '0')}`
    bodies.push({ path, body }); bytes += body.length; digest.update(path + '\0'); digest.update(body)
  }
  return { bodies, bytes, sha256: digest.digest('hex') }
}
const generated = corpus()
async function seed(root) {
  execFileSync('git', ['init', '-q', '--object-format=sha1', root], { env })
  const truth = openTruth(root)
  try {
    const entries = []
    for (const { path, body } of generated.bodies) entries.push({ name: path, mode: 0o100644, id: await truth.putBlob(body) })
    return await truth.commit(await truth.putTree(entries), [], 'cohort query matrix')
  } finally { await truth.close() }
}
async function session(root, base, indexed, run) {
  return await withCohortBenchmarkHandles(async owned => {
    const truth = owned.truth = openTruth(root)
    const log = owned.log = openLog(root, { write: 'bench', sync: 'never' })
    const view = await loadView(log, 'bench', { lower: lowerAt(truth, base) })
    const roots = createRoots(root), scan = createToolHost(view, roots)
    let index, store
    if (indexed) {
      store = owned.store = createCohortIndexStore(root)
      index = owned.index = createViewCohortLookup(view, () => scan.walk(), store)
    }
    const product = indexed ? createToolHost(view, roots, { cohortIndex: index }) : scan
    let reads = 0, prefetched = 0
    const host = { ...product, readBytes: async path => { reads++; return product.readBytes(path) },
      prefetch: async paths => { prefetched += paths.length; return product.prefetch(paths) } }
    const measure = async pattern => {
      reads = 0; prefetched = 0
      const before = counters(truth), start = performance.now()
      const output = (await grep({ pattern }, host, context)).output
      return { output, ms: performance.now() - start, ...difference(before, counters(truth)), reads, prefetched,
        index: index?.stats(), store: store?.stats() }
    }
    const prepare = async () => {
      const before = counters(truth), start = performance.now()
      const prepared = await index.prepare(blob => truth.getBlob(blob))
      return { prepared, ms: performance.now() - start, ...difference(before, counters(truth)), index: index.stats(), store: store.stats() }
    }
    return { measure, prepare }
  }, run)
}
async function trial(pattern) {
  const root = temporary('fugue-cohort-query-'), base = await seed(root)
  const plain = await session(root, base, false, async s => ({ scanCold: await s.measure(pattern), scanRepeat: await s.measure(pattern) }))
  const missing = await session(root, base, true, async s => ({ firstMissing: await s.measure(pattern), preparation: await s.prepare(), preparedMemory: await s.measure(pattern) }))
  const restart = await session(root, base, true, async s => ({ restartCold: await s.measure(pattern), restartRepeat: await s.measure(pattern) }))
  const result = { ...plain, ...missing, ...restart }, expected = plain.scanCold.output
  const directHits = generated.bodies.filter(({ body }) => body.toString('utf8').split('\n').some(line => new RegExp(pattern).test(line))).map(({ path }) => path)
  if (directHits.length) assert.ok(expected.includes(directHits[0]), 'the scan reference omitted its first actual source match')
  for (const [phase, value] of Object.entries(result)) {
    if (phase === 'preparation') continue
    assert.equal(value.output, expected, `${phase} differs from actual full-scan receipt`)
    delete value.output
  }
  return { directHitFiles: directHits.length, ...result }
}
  const cases = {}
  for (const [name, pattern] of [['dense', 'dense_hit'], ['sparse', 'rare_hit'], ['miss', 'absent_needle']]) {
    const trials = []
    for (let at = 0; at < runs; at++) trials.push(await trial(pattern))
    const phases = ['scanCold', 'scanRepeat', 'firstMissing', 'preparation', 'preparedMemory', 'restartCold', 'restartRepeat']
    cases[name] = { pattern, trials, mediansMs: Object.fromEntries(phases.map(p => [p, Number(median(trials.map(t => t[p].ms)).toFixed(3))])) }
  }
  console.log(JSON.stringify({ files, lines, runs, profile, bytes: generated.bytes, corpusSha256: generated.sha256, sourceHashes, cases,
    boundary: 'Generated Git-only corpus; exact full-scan receipts. Fresh Truth/View/adapter handles in the same Node process; OS page cache is not dropped. Prepared-cold includes walk/current-View metadata/filter/regex; preparation and first miss charged separately. Artifact-only timings cannot authorize default activation.' }, null, 2))
} finally {
  let failure
  for (const root of made.reverse()) { try { rmSync(root, { recursive: true, force: true }) } catch (error) { failure ??= error } }
  if (failure) throw failure
}
