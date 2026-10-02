#!/usr/bin/env node
// One real before/after scenario chain, without replacing host/readBytes/prefetch or product edits.
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
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const modules = ['src/tools/execute.ts', 'src/tools/host.ts', 'src/tools/grep-verifier.ts', 'src/tools/search-receipt.ts', 'src/tools/walk.ts', 'src/truth/truth.ts', 'src/truth/git.ts', 'src/truth/blob-lru.ts', 'src/view/view.ts', 'src/view/owned.ts', 'src/view/lower.ts', 'src/log/log.ts', 'src/round/head.ts', 'src/roots/roots.ts', 'src/search/view-cohort.ts', 'src/search/cohort-store.ts']
async function backend(root) {
  const api = {}, paths = [...modules]
  if (existsSync(join(root, 'src/tools/prefetch-plan.ts'))) paths.push('src/tools/prefetch-plan.ts')
  for (const path of paths) Object.assign(api, await import(pathToFileURL(join(root, path)).href))
  return { api, commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceHashes: Object.fromEntries(paths.map(path => [path, hash(readFileSync(join(root, path)))])) }
}
const backends = { before: await backend(before), after: await backend(after) }
assert.notEqual(backends.before.sourceHashes['src/tools/execute.ts'], backends.after.sourceHashes['src/tools/execute.ts'], 'prefetch before/after source fingerprints must differ')
const repo = resolve(import.meta.dirname, '..'), made = []
const temp = prefix => { const root = mkdtempSync(join(repo, prefix)); made.push(root); return root }
const delta = (a, b) => b === null ? null : Object.fromEntries(Object.keys(b).filter(k => typeof b[k] === 'number').map(k => [k, b[k] - (a?.[k] ?? 0)]))
let outcome = { failed: false }
try {
const home = temp('.all-hit-home-')
const env = { PATH: process.env.PATH, HOME: home, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'fugue', GIT_AUTHOR_EMAIL: 'fugue@localhost', GIT_COMMITTER_NAME: 'fugue', GIT_COMMITTER_EMAIL: 'fugue@localhost' }
const bodies = [], digest = createHash('sha256')
for (let file = 0; file < 512; file++) {
  const body = Buffer.alloc(32768, 'x'); Buffer.from(`generated-${file}`).copy(body)
  for (let line = 1; line <= 256; line++) body[line * 128 - 1] = 10
  if (file === 511) Buffer.from('rare_hit').copy(body, body.length - 10)
  const name = `c/f${String(file).padStart(4, '0')}`
  digest.update(name + '\0'); digest.update(body); bodies.push({ name, body })
}
async function seed(root, api) {
  execFileSync('git', ['init', '-q', '--object-format=sha1', root], { env })
  const truth = api.openTruth(root)
  try { const entries = []; for (const { name, body } of bodies) entries.push({ name, mode: 0o100644, id: await truth.putBlob(body) }); return await truth.commit(await truth.putTree(entries), [], 'generated real all-hit prefetch chain') }
  finally { await truth.close() }
}
async function session(root, base, api, indexed, run) {
  return withCohortBenchmarkHandles(async owned => {
    const truth = owned.truth = api.openTruth(root), log = owned.log = api.openLog(root, { write: 'bench', sync: 'never' })
    const view = await api.loadView(log, 'bench', { lower: api.lowerAt(truth, base) }), head = await api.refHeadOf(log, 'bench', base)
    const read = view.read.bind(view), stat = view.stat.bind(view), prefetch = truth.prefetchBlobs.bind(truth)
    let viewReads = 0, statCalls = 0, prefetchCalls = 0, prefetchedIds = 0
    view.read = async path => { viewReads++; return read(path) }
    view.stat = async path => { statCalls++; return stat(path) }
    // Must be installed before host factory: production elision brands the underlying method too.
    truth.prefetchBlobs = async ids => { prefetchCalls++; prefetchedIds += ids.length; return prefetch(ids) }
    const roots = api.createRoots(root), actions = { writer: 'bench', log, truth, head }, scan = api.createToolHost(view, roots)
    let index
    if (indexed) { const store = owned.store = api.createCohortIndexStore(root); index = owned.index = api.createViewCohortLookup(view, () => scan.walk(), store) }
    const host = api.createToolHost(view, roots, { actions, ...(index ? { cohortIndex: index } : {}) })
    const originalRead = host.readBytes, originalPrefetch = host.prefetch
    const grep = api.faceOf('grep'), context = { agent: 'bench', step: 0, cwd: '', holder: false }
    async function measure(name, args) {
      assert.equal(host.readBytes, originalRead); assert.equal(host.prefetch, originalPrefetch)
      viewReads = 0; statCalls = 0; prefetchCalls = 0; prefetchedIds = 0
      const truthBefore = truth.stats(), verificationBefore = api.grepVerificationStats(host), indexBefore = index?.stats(), cpu = process.cpuUsage(), start = performance.now()
      const receipt = await grep(args, host, context), used = process.cpuUsage(cpu)
      assert.equal(receipt.ok, true)
      const verification = api.grepVerificationStats(host)
      if (verification) { assert.ok(verification.entries <= 1024); assert.ok(verification.bytes <= 2 * 1024 * 1024) }
      return { name, args, ms: performance.now() - start, cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000, viewReads, statCalls, prefetchCalls, prefetchedIds, truthDelta: delta(truthBefore, truth.stats()), verification, verificationDelta: delta(verificationBefore, verification), indexDelta: index && delta(indexBefore, index.stats()), receipt }
    }
    return { measure }
  }, run)
}
const results = {}
for (const name of ['before', 'after']) {
  const api = backends[name].api, root = temp('.all-hit-chain-'), base = await seed(root, api)
  const indexed = await session(root, base, api, true, async s => {
    const rare = { pattern: 'rare(?:_hit)' }, samples = []
    samples.push(await s.measure('coldRare', rare))
    samples.push(await s.measure('warmRare1', rare)); samples.push(await s.measure('warmRare2', rare))
    samples.push(await s.measure('warmCount', { ...rare, output_mode: 'count' }))
    samples.push(await s.measure('warmFiles', { ...rare, output_mode: 'files_with_matches' }))
    samples.push(await s.measure('coldNewPattern', { pattern: 'absent_second_pattern' }))
    samples.push(await s.measure('scopedExtraPatternEviction', { pattern: 'extra_absent_pattern', glob: 'c/f0000' }))
    samples.push(await s.measure('rareAfterEviction', rare))
    samples.push(await s.measure('denseEarlyCold', { pattern: 'x' })); samples.push(await s.measure('denseEarlyRepeat', { pattern: 'x' }))
    return samples
  })
  const plain = await session(root, base, api, false, async s => [await s.measure('plainCold', { pattern: 'rare(?:_hit)' }), await s.measure('plainRepeat', { pattern: 'rare(?:_hit)' })])
  results[name] = { indexed, plain }
}
for (const group of ['indexed', 'plain']) {
  assert.equal(results.before[group].length, results.after[group].length)
  for (let at = 0; at < results.before[group].length; at++) {
    const prior = results.before[group][at], next = results.after[group][at]
    assert.equal(prior.name, next.name); assert.deepEqual(next.receipt, prior.receipt, `${group}/${prior.name} full result changed`)
    for (const result of [prior, next]) { result.receiptSha256 = hash(JSON.stringify(result.receipt)); result.outputBytes = Buffer.byteLength(result.receipt.output); result.earlyTruncated = result.receipt.output.includes('Search stopped at the receipt budget'); delete result.receipt }
  }
}
const find = (side, name) => results[side].indexed.find(result => result.name === name)
for (const name of ['warmRare1', 'warmRare2', 'warmCount', 'warmFiles']) {
  const prior = find('before', name), next = find('after', name)
  assert.equal(prior.viewReads, 0); assert.equal(next.viewReads, 0); assert.equal(prior.verificationDelta.sourceReads, 0); assert.equal(next.verificationDelta.sourceReads, 0)
  assert.equal(prior.prefetchedIds, 512); assert.equal(next.prefetchedIds, 0, `${name} did not elide actual prefetch`)
  assert.equal(next.truthDelta.gitRequests, 0)
}
assert.equal(find('after', 'coldRare').viewReads, 512); assert.equal(find('after', 'coldNewPattern').viewReads, 512)
assert.ok(find('after', 'scopedExtraPatternEviction').verificationDelta.evictions > 0)
for (const name of ['denseEarlyCold', 'denseEarlyRepeat']) { const next = find('after', name); assert.equal(next.viewReads, 1); assert.equal(next.prefetchedIds, 32); assert.equal(next.verificationDelta.installed, 0); assert.equal(next.earlyTruncated, true) }
for (const result of results.after.plain) { assert.equal(result.verification, null); assert.equal(result.viewReads, 512); assert.equal(result.prefetchedIds, 512) }
console.log(JSON.stringify({ schema: 1, node: process.version, before: { commit: backends.before.commit, sourceHashes: backends.before.sourceHashes }, after: { commit: backends.after.commit, sourceHashes: backends.after.sourceHashes }, scriptSha256: hash(readFileSync(import.meta.filename)), generated: { files: 512, bytes: 16777216, corpusSha256: digest.digest('hex') }, fullFaceResultEquality: true, results,
  boundary: 'One corpus and one sequential scenario chain per exact backend, not a performance matrix/statistical certificate. Real actions/Truth prefetch and exact host/readBytes/prefetch identities preserved. Source methods instrumented before construction. Missing optional cohort selected deliberately; default plain host separately unbound. One cold fill, four all-hit mode/reuse cases, new-pattern cold, single additional pattern inducing entry eviction, rare replay, dense early-stop and plain controls. Seed/construct/close outside query clocks; no index preparation, provider, remote writes or default activation. Logical capacity gauges are not RSS. Source/regex cold and50ms target stay independent and unfulfilled.' }, null, 2))
} catch (error) { outcome = { failed: true, error } }
finally { await settleBenchmarkCleanups(made.reverse().map(root => () => rmSync(root, { recursive: true, force: true })), outcome) }
