#!/usr/bin/env node
// Developer-only exact concrete-host verification cache; no readBytes wrapper can bypass ownership.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withCohortBenchmarkHandles } from './cohort-benchmark-owned.js'
import { settleBenchmarkCleanups } from './benchmark-cleanup.js'
const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1] }
const before = resolve(arg('--before', resolve(import.meta.dirname, '..'))), after = resolve(arg('--after', before))
const runs = Number(arg('--runs', '3')), profile = arg('--profile', 'code'), scenario = arg('--scenario', 'standard'), cohort = process.argv.includes('--cohort'), prefetchEnabled = !process.argv.includes('--no-prefetch'), plain = process.argv.includes('--plain')
assert.ok(Number.isSafeInteger(runs) && runs >= 1 && runs <= 5)
assert.ok(!(plain && cohort), 'plain and prepared cohort are mutually exclusive'); assert.ok(['code', 'mixed', 'entropy'].includes(profile)); assert.ok(['standard', 'sourcecap', 'recordcap', 'bytecap', 'entrycap'].includes(scenario))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const modules = ['src/tools/execute.ts', 'src/tools/host.ts', 'src/tools/search-receipt.ts', 'src/tools/walk.ts', 'src/search/view-cohort.ts', 'src/search/cohort-store.ts', 'src/search/cohort-format.ts', 'src/search/index-format.ts', 'src/truth/truth.ts', 'src/truth/git.ts', 'src/view/view.ts', 'src/view/lower.ts', 'src/log/log.ts', 'src/roots/roots.ts', 'src/round/head.ts']
async function backend(root) {
  const api = {}, paths = [...modules]
  if (existsSync(join(root, 'src/tools/grep-verifier.ts'))) paths.push('src/tools/grep-verifier.ts')
  for (const path of paths) Object.assign(api, await import(pathToFileURL(join(root, path)).href))
  return { api, commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceHashes: Object.fromEntries(paths.map(path => [path, hash(readFileSync(join(root, path)))])) }
}
const backends = { before: await backend(before), after: await backend(after) }
assert.notEqual(backends.before.sourceHashes['src/tools/execute.ts'], backends.after.sourceHashes['src/tools/execute.ts'], 'regex before/after source hashes must differ')
assert.equal(typeof backends.after.api.grepVerificationStats, 'function', 'after must expose developer cache observations')
const limits = Object.fromEntries(['MAX_VERIFICATION_SOURCE_BYTES', 'MAX_VERIFICATION_RECORD_BYTES', 'MAX_VERIFICATION_MATCHES', 'MAX_VERIFICATION_BYTES', 'MAX_VERIFICATION_ENTRIES'].map(k => [k, backends.after.api[k]]))
const made = [], parent = resolve(arg('--temp-parent', resolve(import.meta.dirname, '..')))
const temp = prefix => { const root = mkdtempSync(join(parent, prefix)); made.push(root); return root }
let outcome = { failed: false }
try {
const home = temp('.regex-home-')
const env = { PATH: process.env.PATH, HOME: home, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'fugue', GIT_AUTHOR_EMAIL: 'fugue@localhost', GIT_COMMITTER_NAME: 'fugue', GIT_COMMITTER_EMAIL: 'fugue@localhost' }
const files = scenario === 'entrycap' ? 1100 : scenario === 'sourcecap' ? 1 : scenario === 'recordcap' ? 64 : scenario === 'standard' ? Number(arg('--files', '512')) : 512
assert.ok(Number.isSafeInteger(files) && files >= 1 && files <= 5000)
const fileBytes = scenario === 'entrycap' ? 128 : scenario === 'sourcecap' ? 2 * 1024 * 1024 : 32768
const digest = createHash('sha256'), bodies = []
let seed = 0x541ea
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed & 255 }
for (let file = 0; file < files; file++) {
  const body = Buffer.alloc(fileBytes)
  for (let line = 0; line < fileBytes / 128; line++) {
    const offset = line * 128
    if (profile === 'entropy') for (let at = 0; at < 127; at++) body[offset + at] = random()
    else body.fill(0x78, offset, offset + 127)
    const marker = Buffer.from(`dense_hit f${String(file).padStart(4, '0')} l${String(line).padStart(4, '0')} ` + (line % 8 === 0 ? 'many_hit ' : '') + (profile === 'mixed' ? 'const 变量 = "😀 e\u0301";\0 ' : 'const value = 42; '))
    marker.copy(body, offset); body[offset + 127] = 10
  }
  if (file === files - 1) Buffer.from(' rare_hit ').copy(body, body.length - 11)
  const path = `c/f${String(file).padStart(4, '0')}`; bodies.push({ path, body }); digest.update(path + '\0'); digest.update(body)
}
const generated = { files, fileBytes, bytes: files * fileBytes, profile, scenario, corpusSha256: digest.digest('hex') }
const cases = scenario === 'standard' ? { denseEarly: { pattern: 'dense_hit' }, sparse: { pattern: 'rare(?:_hit)' }, miss: { pattern: 'absent_needle' }, filesEarly: { pattern: 'dense_hit', output_mode: 'files_with_matches' } } : scenario === 'bytecap' ? { bytePressure: { pattern: 'many_hit', output_mode: 'count' } } : scenario === 'recordcap' ? { recordRefusal: { pattern: 'dense_hit', output_mode: 'count' } } : { [scenario]: { pattern: 'absent_needle' } }
const context = { agent: 'bench', step: 0, cwd: '', holder: false }
const delta = (a, b) => Object.fromEntries(Object.keys(b).filter(k => typeof b[k] === 'number').map(k => [k, b[k] - (a?.[k] ?? 0)]))
async function seedRepo(root, api) {
  execFileSync('git', ['init', '-q', '--object-format=sha1', root], { env })
  const truth = api.openTruth(root)
  try { const entries = []; for (const { path, body } of bodies) entries.push({ name: path, mode: 0o100644, id: await truth.putBlob(body) }); return await truth.commit(await truth.putTree(entries), [], 'generated regex verification corpus') }
  finally { await truth.close() }
}
async function session(root, base, api, run) {
  return withCohortBenchmarkHandles(async owned => {
    const truth = owned.truth = api.openTruth(root), log = owned.log = api.openLog(root, { write: 'bench', sync: 'never' })
    const view = await api.loadView(log, 'bench', { lower: api.lowerAt(truth, base) })
    const stat = view.stat.bind(view), read = view.read.bind(view), prefetch = truth.prefetchBlobs.bind(truth); let statCalls = 0, viewReads = 0, viewBytes = 0, prefetchCalls = 0, prefetchedIds = 0
    truth.prefetchBlobs = async ids => { prefetchCalls++; prefetchedIds += ids.length; return prefetch(ids) }
    view.stat = async path => { statCalls++; return stat(path) }
    view.read = async path => { viewReads++; const bytes = await read(path); viewBytes += bytes?.byteLength ?? 0; return bytes }
    const roots = api.createRoots(root), actions = prefetchEnabled ? { writer: 'bench', log, truth, head: await api.refHeadOf(log, 'bench', base) } : undefined
    const scan = api.createToolHost(view, roots, actions ? { actions } : {})
    let index, store, preparation = null
    if (!plain) { store = owned.store = api.createCohortIndexStore(root); index = owned.index = api.createViewCohortLookup(view, () => scan.walk(), store) }
    if (cohort) {
      const truthBefore = truth.stats(), cpu = process.cpuUsage(), started = performance.now(); statCalls = 0; viewReads = 0; viewBytes = 0
      const prepared = await index.prepare(blob => truth.getBlob(blob)); const used = process.cpuUsage(cpu)
      preparation = { ms: performance.now() - started, cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000, prepared, statCalls, truthDelta: delta(truthBefore, truth.stats()), index: index.stats(), store: store.stats() }
    }
    const host = index ? api.createToolHost(view, roots, { cohortIndex: index, ...(actions ? { actions } : {}) }) : scan
    async function measure(args) {
      statCalls = 0; viewReads = 0; viewBytes = 0; prefetchCalls = 0; prefetchedIds = 0
      const truthBefore = truth.stats(), verifyBefore = api.grepVerificationStats?.(host), indexBefore = index?.stats(), storeBefore = store?.stats(), cpu = process.cpuUsage(), start = performance.now()
      const receipt = await api.faceOf('grep')(args, host, context); const used = process.cpuUsage(cpu)
      assert.equal(receipt.ok, true)
      const verification = api.grepVerificationStats?.(host) ?? null
      if (verification) { assert.ok(verification.bytes <= limits.MAX_VERIFICATION_BYTES); assert.ok(verification.entries <= limits.MAX_VERIFICATION_ENTRIES) }
      return { ms: performance.now() - start, cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000, statCalls, viewReads, viewBytes, prefetchCalls, prefetchedIds, truthDelta: delta(truthBefore, truth.stats()), verification, verificationDelta: verification && delta(verifyBefore, verification), indexDelta: index && delta(indexBefore, index.stats()), storeDelta: store && delta(storeBefore, store.stats()), receipt }
    }
    return { measure, preparation }
  }, run)
}
const trials = []
for (let trial = 0; trial < runs; trial++) {
  const order = trial % 2 === 0 ? ['before', 'after'] : ['after', 'before'], result = {}, references = {}
  for (const name of order) {
    const api = backends[name].api, root = temp('.regex-paired-'), base = await seedRepo(root, api), measured = {}
    for (const [caseName, args] of Object.entries(cases)) {
      const phases = await session(root, base, api, async s => ({ preparation: s.preparation, coldFirst: await s.measure(args), repeat1: await s.measure(args), repeat2: await s.measure(args) }))
      phases.restartCold = await session(root, base, api, async s => ({ preparation: s.preparation, query: await s.measure(args) }))
      const expected = phases.coldFirst.receipt
      if (references[caseName] === undefined) references[caseName] = expected; else assert.deepEqual(expected, references[caseName], `${name} full cold result differs`)
      for (const [phase, value] of Object.entries(phases)) {
        if (phase === 'preparation') continue
        const query = phase === 'restartCold' ? value.query : value
        assert.deepEqual(query.receipt, expected, `${name} ${caseName} ${phase} full result differs`)
        query.ok = query.receipt.ok; query.receiptSha256 = hash(JSON.stringify(query.receipt)); query.outputBytes = Buffer.byteLength(query.receipt.output); query.earlyTruncated = query.receipt.output.includes('Search stopped at the receipt budget'); delete query.receipt
      }
      measured[caseName] = phases
    }
    result[name] = measured
  }
  trials.push({ trial, order, result })
}
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)], medians = {}
for (const name of ['before', 'after']) { medians[name] = {}; for (const c of Object.keys(cases)) medians[name][c] = Object.fromEntries(['coldFirst', 'repeat1', 'repeat2', 'restartCold'].map(p => [p, median(trials.map(t => (p === 'restartCold' ? t.result[name][c][p].query : t.result[name][c][p]).ms))])) }
const latest = trials.at(-1).result.after
if (!plain && !cohort && scenario === 'standard') {
  assert.ok(latest.sparse.repeat2.verificationDelta.hits > 0); assert.equal(latest.sparse.repeat2.viewReads, 0)
  assert.equal(latest.denseEarly.repeat2.verification.entries, 0, 'dense early-stop installed a partial source')
  assert.equal(latest.filesEarly.repeat2.verification.entries, 0, 'files-with-matches installed partial sources')
}
if (scenario === 'sourcecap' || scenario === 'recordcap') for (const phases of Object.values(latest)) assert.equal(phases.repeat2.verification.entries, 0, 'oversized source/record was cached')
if (scenario === 'bytecap' || scenario === 'entrycap') for (const phases of Object.values(latest)) assert.ok(phases.repeat2.verification.evictions > 0, 'cache pressure failed to exercise eviction')
console.log(JSON.stringify({ schema: 1, node: process.version, before: { commit: backends.before.commit, sourceHashes: backends.before.sourceHashes }, after: { commit: backends.after.commit, sourceHashes: backends.after.sourceHashes }, scriptSha256: hash(readFileSync(import.meta.filename)), generated, cohort, prefetchEnabled, pipeline: plain ? 'plain unbound host' : cohort ? 'selected prepared cohort' : 'selected cohort with missing artifact', runs, fullFaceResultEquality: true, limits, cases, trials, medians,
  boundary: 'Exact separately imported backend graphs, same process alternating backend order, original concrete host/readBytes identity preserved. Default full actions enable Truth prefetch and an explicitly selected optional cohort pipeline with a missing artifact. --plain preserves default unbound verification; --cohort pays explicit index preparation. Unknown candidates are retained, not pruned. --no-prefetch is an explicitly isolated mechanism ceiling. Prefetch calls/IDs and Git request deltas retain unpaid-source-read warnings on verification hits. View read/stat counters do not replace source ownership. Cold/restart means fresh Truth/View/concrete host, not physical-cold OS cache. Every repeat uses the same host/cache. Corpus seeding and handle construction are outside query clocks; optional cohort preparation is separately fully charged for each session. Full FaceResult (ok/output/optional fields) equality is asserted. Cache retained-byte/entry gauges are logical accounted retention, not RSS. Source, record, total-byte and entry cap fallbacks are measured separately; no universal speed or default index activation claim.' }, null, 2))
} catch (error) { outcome = { failed: true, error } }
finally { await settleBenchmarkCleanups(made.reverse().map(root => () => rmSync(root, { recursive: true, force: true })), outcome) }
