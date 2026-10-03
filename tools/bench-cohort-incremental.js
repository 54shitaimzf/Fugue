#!/usr/bin/env node
// Paid preparation comparison; generated Git objects and real View receipts only.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withCohortBenchmarkHandles } from './cohort-benchmark-owned.js'

function option(name, fallback) {
  const at = process.argv.indexOf(name)
  return at < 0 ? fallback : process.argv[at + 1]
}
function count(name, fallback, max) {
  const value = Number(option(name, fallback))
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('invalid ' + name)
  return value
}
const reference = option('--reference', null)
if (reference === null) throw new Error('--reference must identify the prior complete backend checkout')
const runs = count('--runs', 3, 5), files = count('--files', 512, 512), lines = count('--lines', 256, 256)
const profile = option('--profile', 'code')
if (!['code', 'mixed'].includes(profile)) throw new Error('invalid profile')
const sourcePaths = ['src/search/cohort-format.ts', 'src/search/cohort-store.ts', 'src/search/view-cohort.ts',
  'src/search/index-format.ts', 'src/tools/execute.ts', 'src/tools/host.ts', 'src/truth/truth.ts',
  'src/truth/git.ts', 'src/view/edit.ts', 'src/view/view.ts', 'src/view/lower.ts', 'src/log/log.ts']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function backend(root) {
  const module = path => import(pathToFileURL(join(root, path)).href)
  const [truth, log, view, lower, roots, host, execute, store, lookup, edit] = await Promise.all([
    module('src/truth/truth.ts'), module('src/log/log.ts'), module('src/view/view.ts'), module('src/view/lower.ts'),
    module('src/roots/roots.ts'), module('src/tools/host.ts'), module('src/tools/execute.ts'),
    module('src/search/cohort-store.ts'), module('src/search/view-cohort.ts'), module('src/view/edit.ts'),
  ])
  return { ...truth, ...log, ...view, ...lower, ...roots, ...host, ...store, ...lookup, ...edit,
    grep: execute.faceOf('grep'), sourceHashes: Object.fromEntries(sourcePaths.map(path => [path, hash(readFileSync(join(root, path)))])) }
}
const old = await backend(resolve(reference)), current = await backend(resolve('.'))
assert.notEqual(old.sourceHashes['src/search/view-cohort.ts'], current.sourceHashes['src/search/view-cohort.ts'],
  'reference must load the distinct prior preparation implementation')
const bodies = Array.from({ length: files }, (_, file) => ({
  path: 'corpus/file-' + String(file).padStart(3, '0'),
  body: Buffer.from(Array.from({ length: lines }, (_, line) =>
    'dense_hit file' + file + ' line' + line + ' ' +
    (profile === 'code' ? 'x'.repeat(96) : 'const 变量 = "😀 e\u0301";\0' + 'value '.repeat(11)) +
    (file === files - 1 && line === lines - 1 ? ' rare_hit' : '') + '\n').join('')),
}))
const corpusHash = createHash('sha256')
for (const row of bodies) { corpusHash.update(row.path + '\0'); corpusHash.update(row.body) }
const corpusSha256 = corpusHash.digest('hex'), bytes = bodies.reduce((n, row) => n + row.body.length, 0)
const made = []
function temporary(name) { const root = mkdtempSync(join(tmpdir(), name)); made.push(root); return root }
const counter = truth => { const s = truth.stats(); return { gitRequests: s.gitRequests, gitSpawns: s.gitSpawns } }
const delta = (before, after) => Object.fromEntries(Object.keys(after).filter(key => typeof after[key] === 'number').map(key => [key, after[key] - (before[key] ?? 0)]))
const context = { agent: 'bench', step: 0, cwd: '', holder: false }
try {
  const home = temporary('fugue-incremental-home-')
  const env = { PATH: process.env.PATH, HOME: home, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'fugue', GIT_AUTHOR_EMAIL: 'fugue@localhost', GIT_COMMITTER_NAME: 'fugue', GIT_COMMITTER_EMAIL: 'fugue@localhost' }
  async function seed(api, root) {
    execFileSync('git', ['init', '-q', '--object-format=sha1', root], { env })
    const truth = api.openTruth(root)
    try {
      const entries = []
      for (const row of bodies) entries.push({ name: row.path, mode: 0o100644, id: await truth.putBlob(row.body) })
      return { base: await truth.commit(await truth.putTree(entries), [], 'incremental cohort benchmark'), ids: entries.map(row => row.id).sort() }
    } finally { await truth.close() }
  }
  async function session(api, root, base, run) {
    return withCohortBenchmarkHandles(async owned => {
      const setupStart = performance.now()
      const truth = owned.truth = api.openTruth(root)
      const log = owned.log = api.openLog(root, { write: 'bench', sync: 'never' })
      const view = await api.loadView(log, 'bench', { lower: api.lowerAt(truth, base) })
      const roots = api.createRoots(root), scan = api.createToolHost(view, roots)
      const store = owned.store = api.createCohortIndexStore(root)
      const index = owned.index = api.createViewCohortLookup(view, () => scan.walk(), store)
      const indexed = api.createToolHost(view, roots, { cohortIndex: index })
      const setup = { ms: performance.now() - setupStart, ...counter(truth) }
      async function prepare(previousBlobs) {
        const before = counter(truth), prior = index.stats(), start = performance.now()
        const prepared = await index.prepare(blob => truth.getBlob(blob), {
          previousBlobs, prefetchBlobs: ids => truth.prefetchBlobs(ids),
        })
        return { prepared, ms: performance.now() - start, ...delta(before, counter(truth)),
          work: delta(prior, index.stats()), retained: index.stats(), store: store.stats() }
      }
      async function verify(pattern) {
        const before = counter(truth), start = performance.now()
        const output = (await api.grep({ pattern }, indexed, context)).output
        const query = { ms: performance.now() - start, ...delta(before, counter(truth)) }
        const expected = (await api.grep({ pattern }, scan, context)).output
        assert.equal(output, expected, 'indexed receipt differs from the current default scan')
        assert.ok(output.includes(pattern), 'the intended source match must survive each mutation and M0 restart')
        return query
      }
      async function ids() {
        const start = performance.now(), blobs = []
        for (const path of await scan.walk()) {
          const meta = await view.stat(path)
          if (meta?.kind === 'file') blobs.push(meta.id)
        }
        return { blobs: [...new Set(blobs)].sort(), ms: performance.now() - start }
      }
      return { truth, view, prepare, verify, ids, setup, change: delta => api.applyEdit({ view, truth, log, writer: 'bench' }, delta) }
    }, run)
  }
  async function trial(api) {
    const root = temporary('fugue-incremental-query-'), seeded = await seed(api, root)
    const same = await session(api, root, seeded.base, async s => {
      const cold = await s.prepare(), coldQuery = await s.verify('rare_hit')
      const repeat = await s.prepare()
      const mutationBefore = counter(s.truth), mutationStart = performance.now()
      const changedBytes = Buffer.concat([bodies[0].body, Buffer.from('incremental_hit\n')])
      // Use the actual product edit path so Truth objects and M0 replay share authority.
      await s.change({ kind: 'modify', path: bodies[0].path, bytes: changedBytes, mode: 0o100644 })
      const mutation = { ms: performance.now() - mutationStart, ...delta(mutationBefore, counter(s.truth)) }
      const changed = await s.prepare(), changedQuery = await s.verify('incremental_hit')
      const renamedPath = 'corpus/renamed'
      await s.change({ kind: 'rename', from: bodies[0].path, to: renamedPath })
      const renamed = await s.prepare(), renamedQuery = await s.verify('incremental_hit')
      const currentIds = await s.ids()
      return { setup: s.setup, cold, coldQuery, repeat, mutation, changed, changedQuery, renamed, renamedQuery, currentIds }
    })
    const restartOldHint = await session(api, root, seeded.base, async s => ({ setup: s.setup, prepare: await s.prepare(seeded.ids), query: await s.verify('incremental_hit') }))
    const restartCurrentHint = await session(api, root, seeded.base, async s => ({ setup: s.setup, prepare: await s.prepare(same.currentIds.blobs), query: await s.verify('incremental_hit') }))
    delete same.currentIds.blobs
    for (const value of [same.cold, same.repeat, same.changed, same.renamed, restartOldHint.prepare, restartCurrentHint.prepare]) {
      assert.equal(value.prepared, true, 'generated fitting corpus must prepare completely')
    }
    return { ...same, restartOldHint, restartCurrentHint }
  }
  const trials = []
  for (let at = 0; at < runs; at++) {
    // Alternate backend order across pairs; every backend has its own generated repo and handles.
    const result = {}
    for (const name of at % 2 ? ['current', 'reference'] : ['reference', 'current']) result[name] = await trial(name === 'current' ? current : old)
    trials.push(result)
  }
  console.log(JSON.stringify({ runs, files, lines, profile, bytes, corpusSha256,
    referenceHashes: old.sourceHashes, currentHashes: current.sourceHashes,
    harnessSha256: hash(readFileSync(new URL(import.meta.url))), trials,
    boundary: 'Generated Git-only corpus; exact default-scan receipts. Fresh handles in the same Node process, OS cache retained. Generated corpus creation is excluded; opening/replay setup is separately charged before timed preparation. Receipt checks can warm later source caches. Current explicit prefetch hints and immutable-record reuse are measured together; source calls, Git requests and spawns are distinct. Prior/current restart hints charge one validated artifact read when supported. No default activation or full/live certificate.' }, null, 2))
} finally {
  let failure
  for (const root of made.reverse()) { try { rmSync(root, { recursive: true, force: true }) } catch (error) { failure ??= error } }
  if (failure) throw failure
}
