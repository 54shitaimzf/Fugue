// tier: real —— 真实 Git/Truth/View 的代所有权、元数据计数与原扫描回执。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { truthViewFixture } from '../../test/helpers/truth-view.ts'
import { createCohortIndexStore } from '../search/cohort-store.ts'
import type { CohortIndexStore } from '../search/cohort-store.ts'
import { createViewCohortLookup } from '../search/view-cohort.ts'
import { createToolHost } from './host.ts'
import { faceOf } from './execute.ts'
import type { ToolContext, ToolHost } from './execute.ts'
import type { AgentId } from '../terms.ts'
import type { Delta } from '../delta.ts'

const grep = faceOf('grep')!, mode = 0o100644
type Fixture = Awaited<ReturnType<typeof truthViewFixture>>
type Target = Awaited<ReturnType<Fixture['target']>>
const context = (t: Target): ToolContext => ({ agent: t.writer as AgentId, step: 0, cwd: '', holder: false })
function attach(f: Fixture, t: Target, store: Pick<CohortIndexStore, 'read' | 'write'>) {
  const index = f.own(createViewCohortLookup(t.view, () => t.plain.walk(), store))
  return { index, host: createToolHost(t.view, f.roots, { cohortIndex: index }) }
}
function measured(t: Target, host: ToolHost) {
  let stats = 0
  const stat = t.view.stat.bind(t.view), reads: string[] = []
  t.view.stat = async path => { stats++; return stat(path) }
  return { reads, stats: () => stats,
    host: { ...host, readBytes: async (path: string) => { reads.push(path); return host.readBytes(path) } } }
}
function held<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>(resolve => { release = resolve })
  return { promise, release }
}

function ready<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

// Counter assertions describe calls only; they do not make a wall-clock claim.
test('513 real paths capture one generation once across five query batches and every unchanged repeat', async () => {
  const files = Object.fromEntries(Array.from({ length: 513 }, (_, at) => [String(at).padStart(3, '0'), 'quiet\n']))
  const f = await truthViewFixture(files)
  try {
    const store = f.own(createCohortIndexStore(f.root)), t = await f.target('wide-snapshot'), independent = await f.target('same-generation')
    const preparing = attach(f, t, store)
    assert.equal(await preparing.index.prepare(blob => f.truth.getBlob(blob)), true)
    const indexed = attach(f, t, store), checked = measured(t, indexed.host)
    let warm = false
    async function exact(authorityStats: number, expectedReads: readonly string[] = []) {
      for (const output_mode of ['content', 'count', 'files_with_matches']) {
        const before = checked.stats(), reads = checked.reads.length, queries = indexed.index.stats().queries
        const args = { pattern: 'needle', output_mode }
        const result = await grep(args, checked.host, context(t))
        assert.equal(checked.stats() - before, (warm ? 0 : authorityStats) + expectedReads.length,
          'only snapshot capture and surviving byte reads may stat; candidate membership never re-stats')
        assert.deepEqual(checked.reads.slice(reads), expectedReads)
        assert.equal(indexed.index.stats().queries - queries, 5, '513 paths cross five bounded candidate batches')
        assert.deepEqual(result, await grep(args, t.plain, context(t)))
        warm = true
      }
    }
    await exact(513)
    assert.equal(indexed.index.stats().diskReads, 1)
    const beforeUnknown = checked.stats()
    assert.deepEqual(await indexed.index.filterCandidates(['000', 'not-enumerated', 'not-enumerated'], ['nee']),
      ['not-enumerated', 'not-enumerated'], 'unknown candidates keep their original multiplicity without guessed IDs')
    assert.equal(checked.stats(), beforeUnknown)
    assert.equal(t.view.base, independent.view.base); assert.equal(t.view.rev, independent.view.rev)
    const queries = indexed.index.stats().queries
    const foreign = createToolHost(independent.view, f.roots, { cohortIndex: indexed.index })
    assert.deepEqual(await grep({ pattern: 'needle' }, foreign, context(independent)),
      await grep({ pattern: 'needle' }, independent.plain, context(independent)))
    assert.equal(indexed.index.stats().queries, queries, 'equal base/rev never authorizes another View identity')
    for (const delta of [
      { kind: 'rename', from: '000', to: 'renamed' },
      { kind: 'chmod', path: 'renamed', mode: 0o100755 },
      { kind: 'delete', path: 'renamed' },
      { kind: 'add', path: 'renamed', bytes: Buffer.from('quiet\n'), mode },
    ] as Delta[]) {
      await t.change(delta)
      warm = false
      await exact(delta.kind === 'delete' ? 512 : 513)
    }
    const sourceReads = indexed.index.stats().sourceReads, builds = indexed.index.stats().builds
    assert.equal(sourceReads, 0); assert.equal(builds, 0, 'queries do not prepare source artifacts')
    await t.change({ kind: 'modify', path: '512', bytes: Buffer.from('needle now\n'), mode })
    const before = checked.stats(), readAt = checked.reads.length
    const missed = await grep({ pattern: 'needle' }, checked.host, context(t))
    assert.equal(checked.stats() - before, 1026, 'a missing exact-set artifact keeps all 513 scans after one 513-path capture')
    assert.equal(checked.reads.length - readAt, 513)
    assert.deepEqual(missed, await grep({ pattern: 'needle' }, t.plain, context(t)))
    const missStats = checked.stats(), missDiskReads = indexed.index.stats().diskReads
    assert.deepEqual(await grep({ pattern: 'needle' }, checked.host, context(t)), missed)
    assert.equal(checked.stats() - missStats, 513, 'a cached artifact miss repeats only byte scans, without authority re-stats')
    assert.equal(indexed.index.stats().diskReads, missDiskReads)
    assert.equal(indexed.index.stats().sourceReads, sourceReads); assert.equal(indexed.index.stats().builds, builds)
    const prepStats = checked.stats()
    assert.equal(await indexed.index.prepare(blob => f.truth.getBlob(blob)), true)
    assert.equal(checked.stats() - prepStats, 513, 'explicit preparation pays for a new exact snapshot')
    warm = true
    await exact(513, ['512'])
    assert.equal(t.plain.filterCandidates, undefined)
  } finally { await f.close() }
})

test('held old preparation completion cannot publish its path snapshot over a newer warm real View generation', { timeout: 15_000 }, async testContext => {
  const f = await truthViewFixture({ a: 'quiet\n', hit: 'needle\n' })
  const gate = held<void>(), entered = held<void>()
  let blocked = false
  try {
    const store = f.own(createCohortIndexStore(f.root)), t = await f.target('held-publication')
    const indexed = attach(f, t, {
      read: blobs => store.read(blobs),
      write: async index => { if (blocked) { entered.release(); await gate.promise } return store.write(index) },
    })
    assert.equal(await indexed.index.prepare(blob => f.truth.getBlob(blob)), true)
    const checked = measured(t, indexed.host)
    blocked = true
    const old = indexed.index.prepare(blob => f.truth.getBlob(blob))
    try {
      await ready(entered.promise, testContext.signal)
      await t.change({ kind: 'rename', from: 'a', to: 'renamed' })
      const before = checked.stats()
      assert.deepEqual(await indexed.index.filterCandidates(['hit', 'renamed', 'a'], ['nee']), ['hit', 'a'])
      assert.equal(checked.stats() - before, 2, 'the new generation owns its renamed path identities')
      assert.equal(indexed.index.stats().diskReads, 1)
    } finally { blocked = false; gate.release() }
    const published = await old
    const before = checked.stats(), diskReads = indexed.index.stats().diskReads
    assert.deepEqual(await indexed.index.filterCandidates(['hit', 'renamed', 'a'], ['nee']), ['hit', 'a'])
    assert.equal(checked.stats(), before, 'old completion cannot force rollback/rebuild of the already warm newer snapshot')
    assert.equal(indexed.index.stats().diskReads, diskReads)
    assert.equal(published, false, 'stale preparation completion has no current-generation authority')
    for (const output_mode of ['content', 'count', 'files_with_matches']) {
      const args = { pattern: 'needle', output_mode }
      assert.deepEqual(await grep(args, checked.host, context(t)), await grep(args, t.plain, context(t)))
    }
    assert.equal(indexed.index.stats().active, 0)
  } finally { blocked = false; gate.release(); await f.close() }
})

test('a held exact-set disk proof cannot exclude a newly matching real View path after an edit', { timeout: 15_000 }, async testContext => {
  const f = await truthViewFixture({ a: 'quiet\n', b: 'needle original\n' })
  const gate = held<void>(), entered = held<void>()
  try {
    const store = f.own(createCohortIndexStore(f.root)), t = await f.target('disk-generation')
    const preparing = attach(f, t, store)
    assert.equal(await preparing.index.prepare(blob => f.truth.getBlob(blob)), true)
    const indexed = attach(f, t, {
      read: async blobs => { const oldProof = await store.read(blobs); entered.release(); await gate.promise; return oldProof },
      write: index => store.write(index),
    })
    const checked = measured(t, indexed.host)
    const pending = grep({ pattern: 'needle' }, checked.host, context(t))
    try {
      await ready(entered.promise, testContext.signal)
      await t.change({ kind: 'modify', path: 'a', bytes: Buffer.from('needle newly matching\n'), mode })
    } finally { gate.release() }
    const result = await pending
    assert.deepEqual(result, await grep({ pattern: 'needle' }, t.plain, context(t)))
    assert.deepEqual(checked.reads, ['a', 'b'], 'generation rollback must restore the whole batch, including a formerly negative file')
    assert.match(result.output, /a:1:needle newly matching/)
    assert.equal(indexed.index.stats().sourceReads, 0); assert.equal(indexed.index.stats().builds, 0)
    assert.equal(indexed.index.stats().active, 0)
  } finally { gate.release(); await f.close() }
})
