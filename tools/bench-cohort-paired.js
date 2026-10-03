#!/usr/bin/env node
// Developer-only paired exact backend graphs. Generated sources never reach a model/provider.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withCohortBenchmarkHandles } from './cohort-benchmark-owned.js'
import { settleBenchmarkCleanups } from './benchmark-cleanup.js'
const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1] }
const before = resolve(arg('--before', resolve(import.meta.dirname, '..'))), after = resolve(arg('--after', before))
const runs = Number(arg('--runs', '3')), files = Number(arg('--files', '512')), profile = arg('--profile', 'code')
assert.ok(Number.isSafeInteger(runs) && runs >= 1 && runs <= 5)
assert.ok([64, 512].includes(files)); assert.ok(['code', 'mixed', 'entropy'].includes(profile))
const made = [], parent = resolve(arg('--temp-parent', resolve(import.meta.dirname, '..')))
const temp = prefix => { const root = mkdtempSync(join(parent, prefix)); made.push(root); return root }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const modules = ['src/tools/execute.ts', 'src/tools/host.ts', 'src/tools/walk.ts', 'src/search/view-cohort.ts', 'src/search/cohort-store.ts', 'src/search/cohort-format.ts', 'src/search/index-format.ts', 'src/truth/truth.ts', 'src/truth/git.ts', 'src/view/view.ts', 'src/view/lower.ts', 'src/log/log.ts']
async function backend(root) {
  const api = {}; for (const path of modules) Object.assign(api, await import(pathToFileURL(join(root, path)).href))
  Object.assign(api, await import(pathToFileURL(join(root, 'src/roots/roots.ts')).href))
  return { api, commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceHashes: Object.fromEntries(modules.map(path => [path, hash(readFileSync(join(root, path)))])) }
}
const backends = { before: await backend(before), after: await backend(after) }
assert.notEqual(backends.before.sourceHashes['src/search/view-cohort.ts'], backends.after.sourceHashes['src/search/view-cohort.ts'], 'cohort before/after source hashes must differ')
let outcome = { failed: false }
try {
const home = temp('.cohort-home-')
const env = { PATH: process.env.PATH, HOME: home, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'fugue', GIT_AUTHOR_EMAIL: 'fugue@localhost', GIT_COMMITTER_NAME: 'fugue', GIT_COMMITTER_EMAIL: 'fugue@localhost' }

const patterns = { dense: 'dense_hit', sparse: 'rare_hit', miss: 'absent_needle' }
const context = { agent: 'bench', step: 0, cwd: '', holder: false }
const digest = createHash('sha256'), bodies = []
let seed = 0x541ea
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed & 255 }
for (let file = 0; file < files; file++) {
  const body = Buffer.alloc(32768)
  for (let line = 0; line < 256; line++) {
    const offset = line * 128
    if (profile === 'entropy') for (let at = 0; at < 127; at++) body[offset + at] = random()
    else body.fill(0x78, offset, offset + 127)
    const marker = Buffer.from(`dense_hit f${String(file).padStart(3, '0')} l${String(line).padStart(3, '0')} ` + (profile === 'mixed' ? 'const 变量 = "😀 e\u0301";\0 ' : 'const value = 42; '))
    marker.copy(body, offset); body[offset + 127] = 10
  }
  if (file === files - 1) Buffer.from(' rare_hit ').copy(body, body.length - 11)
  const path = `corpus/file-${String(file).padStart(3, '0')}`; bodies.push({ path, body }); digest.update(path + '\0'); digest.update(body)
}
const sourceCorpus = { profile, files, bytes: files * 32768, fileBytes: 32768, corpusSha256: digest.digest('hex') }
const sum = (a, b) => Object.fromEntries(['gitRequests', 'gitSpawns', 'blobHits', 'blobMisses', 'infoHits', 'infoMisses'].map(k => [k, b[k] - a[k]]))
const delta = (a, b) => Object.fromEntries(Object.keys(b).filter(k => typeof b[k] === 'number').map(k => [k, b[k] - (a?.[k] ?? 0)]))
async function seedRepo(root, api) {
  execFileSync('git', ['init', '-q', '--object-format=sha1', root], { env })
  const truth = api.openTruth(root)
  try { const entries = []; for (const { path, body } of bodies) entries.push({ name: path, mode: 0o100644, id: await truth.putBlob(body) }); return await truth.commit(await truth.putTree(entries), [], 'generated paired cohort corpus') }
  finally { await truth.close() }
}
async function session(root, base, api, indexed, run) {
  return withCohortBenchmarkHandles(async owned => {
    const truth = owned.truth = api.openTruth(root), log = owned.log = api.openLog(root, { write: 'bench', sync: 'never' })
    const view = await api.loadView(log, 'bench', { lower: api.lowerAt(truth, base) })
    const stat = view.stat.bind(view); let statCalls = 0
    view.stat = async path => { statCalls++; return stat(path) }
    const roots = api.createRoots(root), scan = api.createToolHost(view, roots)
    let index, store
    if (indexed) { store = owned.store = api.createCohortIndexStore(root); index = owned.index = api.createViewCohortLookup(view, () => scan.walk(), store) }
    const product = indexed ? api.createToolHost(view, roots, { cohortIndex: index }) : scan
    let reads = 0, prefetched = 0
    const host = { ...product, readBytes: async path => { reads++; return product.readBytes(path) }, prefetch: async paths => { prefetched += paths.length; return product.prefetch(paths) } }
    async function measure(kind, pattern) {
      reads = 0; prefetched = 0; statCalls = 0
      const truthBefore = truth.stats(), indexBefore = index?.stats(), storeBefore = store?.stats(), cpu = process.cpuUsage(), start = performance.now()
      let prepared, receipt
      if (kind === 'prepare') prepared = await index.prepare(blob => truth.getBlob(blob))
      else { receipt = await api.faceOf('grep')({ pattern }, host, context); assert.equal(typeof receipt.ok, 'boolean'); assert.equal(receipt.ok, true, 'generated query must succeed') }
      const used = process.cpuUsage(cpu)
      return { ms: performance.now() - start, cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000, statCalls, reads, prefetched, truthDelta: sum(truthBefore, truth.stats()), indexDelta: index && delta(indexBefore, index.stats()), storeDelta: store && delta(storeBefore, store.stats()), prepared, receipt }
    }
    return { measure }
  }, run)
}
const trials = []
for (let trial = 0; trial < runs; trial++) {
  const order = trial % 2 === 0 ? ['before', 'after'] : ['after', 'before'], results = {}, roots = {}, bases = {}
  for (const name of order) { roots[name] = temp('.cohort-paired-'); bases[name] = await seedRepo(roots[name], backends[name].api) }
  const references = {}
  for (const name of order) {
    const api = backends[name].api, root = roots[name], base = bases[name], got = { cases: {} }
    for (const [caseName, pattern] of Object.entries(patterns)) {
      got.cases[caseName] = await session(root, base, api, false, async s => ({ scanFreshHandle: await s.measure('query', pattern), scanMemoryRepeat: await s.measure('query', pattern) }))
      const receipt = got.cases[caseName].scanFreshHandle.receipt
      if (references[caseName] === undefined) references[caseName] = receipt; else assert.deepEqual(receipt, references[caseName], `${name} scan differs`)
    }
    const missing = await session(root, base, api, true, async s => { const cases = {}; for (const [caseName, pattern] of Object.entries(patterns)) cases[caseName] = await s.measure('query', pattern); const preparation = await s.measure('prepare'); const prepared = {}; for (const [caseName, pattern] of Object.entries(patterns)) prepared[caseName] = { memoryFirst: await s.measure('query', pattern), memoryRepeat: await s.measure('query', pattern) }; return { cases, preparation, prepared } })
    got.preparation = missing.preparation
    for (const [caseName, pattern] of Object.entries(patterns)) {
      Object.assign(got.cases[caseName], { initialMissing: missing.cases[caseName], preparedMemory: missing.prepared[caseName].memoryFirst, preparedMemoryRepeat: missing.prepared[caseName].memoryRepeat })
      Object.assign(got.cases[caseName], await session(root, base, api, true, async s => ({ restartDisk: await s.measure('query', pattern), restartMemoryRepeat: await s.measure('query', pattern) })))
      for (const [phase, result] of Object.entries(got.cases[caseName])) { assert.deepEqual(result.receipt, references[caseName], `${name} ${caseName} ${phase} receipt mismatch`); result.receiptSha256 = hash(JSON.stringify(result.receipt)); result.outputSha256 = hash(result.receipt.output); result.outputBytes = Buffer.byteLength(result.receipt.output); result.ok = result.receipt.ok; delete result.receipt }
    }
    results[name] = got
  }
  assert.equal(results.before.preparation.prepared, results.after.preparation.prepared, 'backend preparation admission changed')
  trials.push({ trial, order, results })
}
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const medians = {}
for (const name of ['before', 'after']) { medians[name] = { preparationMs: median(trials.map(t => t.results[name].preparation.ms)), cases: {} }; for (const caseName of Object.keys(patterns)) { medians[name].cases[caseName] = {}; for (const phase of Object.keys(trials[0].results[name].cases[caseName])) medians[name].cases[caseName][phase] = { ms: median(trials.map(t => t.results[name].cases[caseName][phase].ms)), statCalls: trials.map(t => t.results[name].cases[caseName][phase].statCalls), reads: trials.map(t => t.results[name].cases[caseName][phase].reads) } } }
console.log(JSON.stringify({ schema: 1, node: process.version, before: { commit: backends.before.commit, sourceHashes: backends.before.sourceHashes }, after: { commit: backends.after.commit, sourceHashes: backends.after.sourceHashes }, scriptSha256: hash(readFileSync(import.meta.filename)), generated: sourceCorpus, runs, fullReceiptEquality: true, trials, medians,
  boundary: 'Same process, exact separately imported backend graphs, alternate before/after trial order. Each corpus lives in its own generated Git repository under workspace filesystem. Fresh handle is not physical cold; OS page cache is not dropped. Scan receipts are exact full bounded-tool receipts, including truncation; dense may stop early. Initial missing occurs before preparation, separately charged. One caller-paid preparation shared by dense/sparse/miss; missing cases run dense/sparse/miss in fixed order. Prepared memory queries follow preparation; restartDisk creates fresh Truth/View/adapter/store handles per pattern. Every query and preparation records own delta counters. Source/stat/I/O counts are mechanism evidence; timings are machine-local, with no universal 50ms claim. Refused entropy preparation falls back, and no default activation is implied.' }, null, 2))
} catch (error) { outcome = { failed: true, error } }
finally { await settleBenchmarkCleanups(made.reverse().map(root => () => rmSync(root, { recursive: true, force: true })), outcome) }
