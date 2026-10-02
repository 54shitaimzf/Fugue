// tier: real —— 真实 Git/Truth/View 的增量 cohort 取源计数与原扫描回执。
import assert from 'node:assert/strict'
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { truthViewFixture } from '../../test/helpers/truth-view.ts'
import { createCohortIndexStore } from '../search/cohort-store.ts'
import { buildCohortIndex, cohortKey, encodeCohortIndex } from '../search/cohort-format.ts'
import { buildBlobIndex } from '../search/index-format.ts'
import { createViewCohortLookup } from '../search/view-cohort.ts'
import { createToolHost } from './host.ts'
import { faceOf } from './execute.ts'
import type { ToolContext, ToolHost } from './execute.ts'
import type { AgentId, BlobId, RelPath } from '../terms.ts'
import type { Delta } from '../delta.ts'

const grep = faceOf('grep')!, mode = 0o100644
const corpus = { 'dir/a.ts': 'needle A\r\n', 'alias.ts': 'needle A\r\n', 'dir/b.ts': 'other\n', 'keep.ts': 'needle keep\n',
  emoji: '😀xy\n', invalid: Buffer.from([0xff, 0x61, 0x62, 10]), falsePositive: 'abc bcd cde def\n' }
type Fixture = Awaited<ReturnType<typeof truthViewFixture>>
type Target = Awaited<ReturnType<Fixture['target']>>
const context = (t: Target): ToolContext => ({ agent: t.writer as AgentId, step: 0, cwd: '', holder: false })
function attach(f: Fixture, t: Target, store: ReturnType<typeof createCohortIndexStore>) {
  const index = f.own(createViewCohortLookup(t.view, () => t.plain.walk(), store))
  return { index, host: createToolHost(t.view, f.roots, { cohortIndex: index }) }
}
async function ids(t: Target): Promise<BlobId[]> {
  const found = new Set<BlobId>()
  for (const path of await t.plain.walk()) {
    const meta = await t.view.stat(path as RelPath)
    if (meta?.kind === 'file') found.add(meta.id as BlobId)
  }
  return [...found].sort()
}
async function equalReceipts(t: Target, host: ToolHost) {
  for (const args of [{ pattern: 'needle' }, { pattern: 'nee.*le' }, { pattern: '^needle.*\\r?$' },
    { pattern: '😀x' }, { pattern: '�ab' }, { pattern: 'abcdef' }, { pattern: 'needle', path: 'dir', glob: '**/*.ts' }]) {
    for (const output_mode of ['content', 'count', 'files_with_matches']) {
      const query = { ...args, output_mode }
      assert.deepEqual(await grep(query, host, context(t)), await grep(query, t.plain, context(t)))
    }
  }
}
function sourceControl(f: Fixture) {
  const sources: BlobId[] = [], batches: BlobId[][] = [], events: string[] = []
  return { sources, batches, events,
    source: async (blob: BlobId) => { sources.push(blob); events.push('source'); return f.truth.getBlob(blob) },
    prefetch: async (blobs: readonly BlobId[]) => {
      assert.equal(Object.isFrozen(blobs), true); assert.ok(blobs.length <= 128)
      batches.push([...blobs]); events.push(`prefetch:${blobs.length}`)
      await f.truth.prefetchBlobs(blobs)
    },
  }
}
function held<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>(resolve => { release = resolve })
  return { promise, release }
}

test('actual View rename/chmod/deletion reuse zero sources; changed and recreated IDs alone fetch once with exact receipts', async () => {
  const f = await truthViewFixture(corpus)
  try {
    const store = f.own(createCohortIndexStore(f.root)), t = await f.target('mutating'), other = await f.target('independent')
    const indexed = attach(f, t, store), initial = sourceControl(f)
    let previous = await ids(t)
    assert.equal(await indexed.index.prepare(initial.source, { prefetchBlobs: initial.prefetch }), true)
    assert.deepEqual(initial.sources, previous, 'initial preparation hashes each distinct real blob once')
    const independent = attach(f, other, store)
    const original = await grep({ pattern: 'needle' }, independent.host, context(other))
    for (const [delta, expectedNew] of [
      [{ kind: 'rename', from: 'dir/a.ts', to: 'renamed.ts' }, 0],
      [{ kind: 'chmod', path: 'renamed.ts', mode: 0o100755 }, 0],
      [{ kind: 'delete', path: 'alias.ts' }, 0],
      [{ kind: 'modify', path: 'keep.ts', bytes: Buffer.from('needle changed\n'), mode }, 1],
      [{ kind: 'delete', path: 'dir' }, 0],
      [{ kind: 'add', path: 'dir/reborn.ts', bytes: Buffer.from('needle recreated\n'), mode }, 1],
    ] as [Delta, number][]) {
      await t.change(delta)
      const current = await ids(t), missing = current.filter(blob => !previous.includes(blob)), control = sourceControl(f)
      assert.equal(missing.length, expectedNew)
      const before = indexed.index.stats().reusedRecords
      assert.equal(await indexed.index.prepare(control.source, { prefetchBlobs: control.prefetch }), true)
      assert.deepEqual(control.sources, missing, `${delta.kind}: only new immutable IDs may read source`)
      assert.deepEqual(control.batches.flat(), missing)
      assert.equal(indexed.index.stats().reusedRecords - before, current.length - missing.length)
      const sourceReads = indexed.index.stats().sourceReads, builds = indexed.index.stats().builds
      await equalReceipts(t, indexed.host)
      assert.equal(indexed.index.stats().sourceReads, sourceReads); assert.equal(indexed.index.stats().builds, builds)
      assert.deepEqual(await grep({ pattern: 'needle' }, independent.host, context(other)), original)
      previous = current
    }
    assert.equal(independent.index.stats().sourceReads, 0)
    const result = await grep({ pattern: 'needle' }, indexed.host, context(t))
    assert.match(result.output, /dir\/reborn.ts:1:needle recreated/)
    assert.doesNotMatch(result.output, /dir\/a.ts|dir\/b.ts|alias.ts/)
  } finally { await f.close() }
})

test('M0 restart reuses one exact prior artifact; broken/unsupported/wrong-set priors rebuild every current source', async () => {
  const f = await truthViewFixture(corpus)
  try {
    const store = f.own(createCohortIndexStore(f.root)), t = await f.target('restart'), initial = attach(f, t, store)
    const previousBlobs = await ids(t)
    assert.equal(await initial.index.prepare(blob => f.truth.getBlob(blob)), true)
    const priorPath = join(f.root, '.fugue/idx/v1/cohorts', `${cohortKey(previousBlobs)}.bin`), priorBytes = readFileSync(priorPath)
    await initial.index.close()
    await t.change({ kind: 'modify', path: 'keep.ts', bytes: Buffer.from('needle restarted\n'), mode })
    await t.log.close()
    const replay = await f.target('restart')
    assert.deepEqual(replay.view.state(), t.view.state()); assert.deepEqual(replay.view.diff(), t.view.diff())
    const current = await ids(replay), missing = current.filter(blob => !previousBlobs.includes(blob))
    assert.equal(missing.length, 1)
    const restarted = attach(f, replay, store), control = sourceControl(f), before = store.stats().reads
    assert.equal(await restarted.index.prepare(control.source, { previousBlobs, prefetchBlobs: control.prefetch }), true)
    assert.equal(store.stats().reads - before, 1)
    assert.deepEqual(control.sources, missing); assert.deepEqual(control.batches, [missing])
    assert.equal(restarted.index.stats().reusedRecords, current.length - 1)
    await equalReceipts(replay, restarted.host)
    const fresh = attach(f, replay, store)
    await equalReceipts(replay, fresh.host)
    assert.equal(fresh.index.stats().sourceReads, 0); assert.equal(fresh.index.stats().builds, 0)
    const wrongBlob = missing[0], wrongBytes = encodeCohortIndex(buildCohortIndex([buildBlobIndex(wrongBlob, await f.truth.getBlob(wrongBlob))]))
    for (const damage of ['missing', 'corrupt', 'unsupported', 'wrong-set']) {
      writeFileSync(priorPath, priorBytes, { mode: 0o600 }); chmodSync(priorPath, 0o600)
      if (damage === 'missing') rmSync(priorPath)
      else if (damage === 'corrupt') writeFileSync(priorPath, 'torn')
      else if (damage === 'wrong-set') writeFileSync(priorPath, wrongBytes)
      else { const bytes = Buffer.from(priorBytes); bytes.writeUInt16BE(99, 8); writeFileSync(priorPath, bytes) }
      const fallback = attach(f, replay, store), sources = sourceControl(f), reads = store.stats().reads
      assert.equal(await fallback.index.prepare(sources.source, { previousBlobs }), true, damage)
      assert.equal(store.stats().reads - reads, 1)
      assert.deepEqual(sources.sources, current, `${damage} hint supplies no trusted reuse records`)
      assert.equal(fallback.index.stats().reusedRecords, 0)
      await equalReceipts(replay, fallback.host)
    }
    for (const hint of [new Array<BlobId>(1), [], ['HEAD'], [previousBlobs[0], previousBlobs[0]]]) {
      const invalid = attach(f, replay, store), stats = store.stats()
      assert.equal(await invalid.index.prepare(async () => { assert.fail('invalid hint source') }, { previousBlobs: hint as BlobId[] }), false)
      assert.equal(store.stats().reads, stats.reads); assert.equal(store.stats().writes, stats.writes)
    }
  } finally { await f.close() }
})

test('129 actual new blobs prefetch in bounded immediately consumed batches; a later single edit hints and hashes only its new ID', async () => {
  const f = await truthViewFixture(Object.fromEntries(Array.from({ length: 129 }, (_, at) => [String(at).padStart(3, '0'), `none ${at}`])))
  try {
    const store = f.own(createCohortIndexStore(f.root)), t = await f.target('batching'), indexed = attach(f, t, store), first = sourceControl(f)
    assert.equal(await indexed.index.prepare(first.source, { prefetchBlobs: first.prefetch }), true)
    assert.deepEqual(first.events, ['prefetch:128', ...Array<string>(128).fill('source'), 'prefetch:1', 'source'])
    assert.deepEqual(first.sources, await ids(t)); assert.deepEqual(first.batches.flat(), first.sources)
    await t.change({ kind: 'modify', path: '000', bytes: Buffer.from('needle changed\n'), mode })
    const next = sourceControl(f), changed = (await t.view.stat('000'))!.id as BlobId
    assert.equal(await indexed.index.prepare(next.source, { prefetchBlobs: next.prefetch }), true)
    assert.deepEqual(next.events, ['prefetch:1', 'source']); assert.deepEqual(next.sources, [changed]); assert.deepEqual(next.batches, [[changed]])
    await equalReceipts(t, indexed.host)
    const fresh = attach(f, t, store)
    await equalReceipts(t, fresh.host)
    assert.equal(fresh.index.stats().sourceReads, 0); assert.equal(fresh.index.stats().diskReads, 1)
  } finally { await f.close() }
})

test('actual edits during held incremental work and closing a held restart hint publish nothing and leave exact scan fallback', { timeout: 15_000 }, async testContext => {
  function ready<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(testContext.signal.reason)
      if (testContext.signal.aborted) { abort(); return }
      testContext.signal.addEventListener('abort', abort, { once: true })
      void promise.then(value => { testContext.signal.removeEventListener('abort', abort); resolve(value) },
        error => { testContext.signal.removeEventListener('abort', abort); reject(error) })
    })
  }
  const f = await truthViewFixture({ a: 'none A', b: 'none B', keep: 'needle keep\n' })
  const hint = held<void>(), hinted = held<void>(), stopHint = held<void>(), stopEntered = held<void>()
  try {
    const store = f.own(createCohortIndexStore(f.root)), t = await f.target('held'), indexed = attach(f, t, store), previousBlobs = await ids(t)
    assert.equal(await indexed.index.prepare(blob => f.truth.getBlob(blob)), true)
    await t.change({ kind: 'modify', path: 'a', bytes: Buffer.from('needle A\n'), mode })
    let sources = 0
    const before = store.stats().writes
    const pending = indexed.index.prepare(async blob => { sources++; return f.truth.getBlob(blob) }, {
      prefetchBlobs: async () => { hinted.release(); await hint.promise },
    })
    try {
      await ready(hinted.promise)
      await t.change({ kind: 'modify', path: 'b', bytes: Buffer.from('needle B\n'), mode })
    } finally { hint.release() }
    assert.equal(await pending, false); assert.equal(sources, 0); assert.equal(store.stats().writes, before)
    await equalReceipts(t, indexed.host)
    const recovery = sourceControl(f), current = await ids(t), missing = current.filter(blob => !previousBlobs.includes(blob))
    assert.equal(missing.length, 2)
    assert.equal(await indexed.index.prepare(recovery.source), true)
    assert.deepEqual(recovery.sources, missing)
    const closing = attach(f, t, store), writes = store.stats().writes
    const prep = closing.index.prepare(async blob => { sources++; return f.truth.getBlob(blob) }, {
      previousBlobs, prefetchBlobs: async () => { stopEntered.release(); await stopHint.promise },
    })
    await ready(stopEntered.promise)
    let retired = false
    const stopped = closing.index.close().then(() => { retired = true })
    await Promise.resolve(); assert.equal(retired, false, 'close observes the admitted held preparation')
    stopHint.release(); assert.equal(await prep, false); await stopped
    assert.equal(sources, 0); assert.equal(store.stats().writes, writes)
    await equalReceipts(t, closing.host)
    assert.equal(closing.index.stats().active, 0); assert.equal(closing.index.stats().closed, true)
  } finally { hint.release(); stopHint.release(); await f.close() }
})
