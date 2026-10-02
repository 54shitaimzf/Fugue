import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BlobId, CommitId, RelPath, ViewRev } from '../terms.ts'
import type { EntryMeta } from '../entries.ts'
import { buildBlobIndex, MAX_SOURCE_BYTES } from './index-format.ts'
import { buildCohortIndex } from './cohort-format.ts'
import { createCohortIndexStore } from './cohort-store.ts'
import { createViewCohortLookup, cohortLookupForView } from './view-cohort.ts'

function fixture(input = { a: 'none', b: 'needle' }) {
  const paths = new Map<string, BlobId>()
  const blobs = new Map<BlobId, Buffer>()
  const view = {
    base: null as CommitId | null, rev: 0 as ViewRev,
    async stat(path: RelPath): Promise<EntryMeta | null> {
      const blob = paths.get(path)
      return blob === undefined ? null : { kind: 'file', id: blob, size: blobs.get(blob)!.length, mode: 0o100644 }
    },
  }
  function write(path: string, text: string) {
    const bytes = Buffer.from(text)
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') as BlobId
    paths.set(path, blob); blobs.set(blob, bytes)
    view.rev = (Number(view.rev) + 1) as ViewRev
  }
  Object.entries(input).forEach(([path, text]) => write(path, text))
  const enumerate = async () => [...paths.keys()]
  const source = async (blob: BlobId) => blobs.get(blob)!
  const index = () => buildCohortIndex([...new Set(paths.values())].map(blob => buildBlobIndex(blob, blobs.get(blob)!)))
  return { view, paths, blobs, write, enumerate, source, index }
}
function held<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>(resolve => { release = resolve })
  return { promise, release }
}

test('paid preparation and one fresh disk artifact preserve candidates and duplicate paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fugue-view-cohort-'))
  const store = createCohortIndexStore(root)
  const b = fixture()
  const first = createViewCohortLookup(b.view, b.enumerate, store)
  let second: ReturnType<typeof createViewCohortLookup> | undefined
  try {
    assert.deepEqual(await first.filterCandidates(['a', 'b'], ['nee']), ['a', 'b'])
    assert.equal(first.stats().sourceReads, 0)
    assert.equal(await first.prepare(b.source), true)
    assert.deepEqual(await first.filterCandidates(['a', 'b', 'b', 'absent'], ['nee']), ['b', 'b', 'absent'])
    second = createViewCohortLookup(b.view, b.enumerate, store)
    const before = store.stats().reads
    assert.deepEqual(await second.filterCandidates(['a', 'b'], ['nee']), ['b'])
    assert.deepEqual(await second.filterCandidates(['a', 'b'], ['zzz']), [])
    assert.equal(store.stats().reads - before, 1)
    assert.equal(second.stats().sourceReads, 0)
    assert.equal(second.stats().builds, 0)
  } finally { await first.close(); await second?.close(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('missing, throwing and wrong-set artifacts remain full scan; no automatic source builds', async () => {
  const b = fixture()
  const other = fixture({ x: 'different' }).index()
  for (const read of [async () => null, async () => { throw new Error('disk') }, async () => other]) {
    const lookup = createViewCohortLookup(b.view, b.enumerate, { read, write: async () => { assert.fail('unexpected write') } })
    assert.deepEqual(await lookup.filterCandidates(['a', 'b'], ['nee']), ['a', 'b'])
    assert.equal(lookup.stats().sourceReads, 0)
    await lookup.close()
  }
})

test('generation changes during disk or per-path metadata invalidate every negative', async () => {
  const b = fixture()
  const index = b.index()
  const entered = held<void>(), disk = held<ReturnType<typeof b.index>>()
  const lookup = createViewCohortLookup(b.view, b.enumerate, { read: async () => { entered.release(); return disk.promise }, write: async () => true })
  const result = lookup.filterCandidates(['a', 'b'], ['nee'])
  await entered.promise
  b.write('a', 'needle')
  disk.release(index)
  assert.deepEqual(await result, ['a', 'b'])
  await lookup.close()
  const current = b.index()
  let calls = 0
  const stat = b.view.stat.bind(b.view)
  b.view.stat = async path => {
    const result = await stat(path)
    if (++calls === 3) b.view.base = 'a'.repeat(40) as CommitId
    return result
  }
  const next = createViewCohortLookup(b.view, b.enumerate, { read: async () => current, write: async () => true })
  assert.deepEqual(await next.filterCandidates(['a', 'b'], ['zzz']), ['a', 'b'])
  await next.close()
})

test('dense frozen requirements, caller mutation and unsupported admission never issue false exclusions', async () => {
  const b = fixture()
  let reads = 0, stats = 0
  const stat = b.view.stat.bind(b.view)
  b.view.stat = async path => { stats++; return stat(path) }
  const disk = held<ReturnType<typeof b.index>>(), entered = held<void>()
  const index = b.index()
  const lookup = createViewCohortLookup(b.view, b.enumerate, { read: async () => { reads++; entered.release(); return disk.promise }, write: async () => true })
  for (const required of [new Array<string>(1), [], ['ab'], [undefined as unknown as string]]) {
    assert.deepEqual(await lookup.filterCandidates(['a', 'b'], required), ['a', 'b'])
  }
  assert.equal(reads, 0); assert.equal(stats, 0)
  const paths = ['a', 'b'], required = ['nee']
  const result = lookup.filterCandidates(paths, required)
  await entered.promise
  paths.reverse(); required[0] = 'zzz'
  disk.release(index)
  assert.deepEqual(await result, ['b'])
  await lookup.close()
})

test('one preparation is shared; stale/wrong-address/over-budget source never publishes', async () => {
  for (const kind of ['wrong', 'large', 'stale']) {
    const b = fixture()
    let writes = 0, reads = 0
    const lookup = createViewCohortLookup(b.view, b.enumerate, { read: async () => null, write: async () => { writes++; return true } })
    const source = async () => {
      reads++
      if (kind === 'stale') b.write('a', 'needle')
      return kind === 'large' ? new Uint8Array(MAX_SOURCE_BYTES + 1) : Buffer.from('wrong')
    }
    const first = lookup.prepare(source)
    assert.equal(lookup.prepare(source), first)
    assert.equal(await first, false)
    assert.equal(writes, 0); assert.equal(reads, 1)
    await lookup.close()
  }
})

test('close observes admitted disk and source work; bounded queries refuse new work', async () => {
  const b = fixture()
  const gate = held<ReturnType<typeof b.index>>(), entered = held<void>()
  let reads = 0
  const lookup = createViewCohortLookup(b.view, b.enumerate, { read: async () => { reads++; entered.release(); return gate.promise }, write: async () => true })
  const pending = Array.from({ length: 4 }, () => lookup.filterCandidates(['a', 'b'], ['nee']))
  await entered.promise
  assert.deepEqual(await lookup.filterCandidates(['a', 'b'], ['nee']), ['a', 'b'])
  let finished = false
  const closing = lookup.close().then(() => { finished = true })
  await Promise.resolve(); assert.equal(finished, false)
  gate.release(b.index())
  for (const result of await Promise.all(pending)) assert.deepEqual(result, ['a', 'b'])
  await closing; assert.equal(reads, 1)
  assert.deepEqual(await lookup.filterCandidates(['a', 'b'], ['nee']), ['a', 'b'])
  const source = held<Buffer>(), sourceEntered = held<void>()
  const prep = createViewCohortLookup(b.view, b.enumerate, { read: async () => null, write: async () => { assert.fail('write after close') } })
  const preparing = prep.prepare(async () => { sourceEntered.release(); return source.promise })
  await sourceEntered.promise
  finished = false
  const stop = prep.close().then(() => { finished = true })
  await Promise.resolve(); assert.equal(finished, false)
  source.release(Buffer.from('none'))
  assert.equal(await preparing, false)
  await stop
})

test('exact View identity is required for attaching a cohort adapter', async () => {
  const a = fixture(), b = fixture()
  const lookup = createViewCohortLookup(a.view, a.enumerate, { read: async () => a.index(), write: async () => true })
  assert.equal(cohortLookupForView(lookup, a.view), true)
  assert.equal(cohortLookupForView(lookup, b.view), false)
  assert.equal(cohortLookupForView({ filterCandidates: async () => [] }, a.view), false)
  await lookup.close()
})

test('array admission captures length once and never consumes a caller iterator', async () => {
  const b = fixture()
  let reads = 0, lengths = 0, iterators = 0
  const lookup = createViewCohortLookup(b.view, b.enumerate, { read: async () => { reads++; return b.index() }, write: async () => true })
  const paths = new Proxy(['a', 'b'], { get(target, key, receiver) {
    if (key === 'length') return ++lengths === 1 ? 2 : 1_000_000
    if (key === Symbol.iterator) { iterators++; assert.fail('iterator consumed') }
    return Reflect.get(target, key, receiver)
  } })
  assert.deepEqual(await lookup.filterCandidates(paths, ['nee']), ['b'])
  assert.equal(lengths, 1); assert.equal(iterators, 0); assert.equal(reads, 1)
  await lookup.close()
})

test('preparation charges intrinsic source windows before copying and ignores spoofed accessors', async () => {
  const b = fixture({ a: 'none', b: 'needle' })
  let writes = 0, getters = 0
  class Spoofed extends Uint8Array {
    get byteLength() { getters++; return 0 }
    get byteOffset() { getters++; return 999 }
    get buffer() { getters++; return new ArrayBuffer(0) }
    [Symbol.iterator](): ArrayIterator<number> { assert.fail('source iterator consumed') }
  }
  const lookup = createViewCohortLookup(b.view, b.enumerate, { read: async () => null, write: async () => { writes++; return true } })
  assert.equal(await lookup.prepare(async () => new Spoofed(MAX_SOURCE_BYTES + 1)), false)
  assert.equal(writes, 0); assert.equal(getters, 0)
  assert.equal(await lookup.prepare(async blob => new Spoofed(b.blobs.get(blob)!)), true)
  assert.equal(writes, 1); assert.equal(getters, 0)
  await lookup.close()
})
