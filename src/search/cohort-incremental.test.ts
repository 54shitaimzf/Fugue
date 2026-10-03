import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BlobId, CommitId, RelPath, ViewRev } from '../terms.ts'
import type { EntryMeta } from '../entries.ts'
import { buildBlobIndex, encodeBlobIndex, MAX_SOURCE_BYTES } from './index-format.ts'
import { buildCohortIndex, cohortBlobRecords, cohortKey, cohortMightContain, decodeCohortIndex, encodeCohortIndex } from './cohort-format.ts'
import { createCohortIndexStore } from './cohort-store.ts'
import { createViewCohortLookup } from './view-cohort.ts'

function fixture(count = 2) {
  const paths = new Map<string, BlobId>(), blobs = new Map<BlobId, Buffer>()
  const view = { base: null as CommitId | null, rev: 0 as ViewRev,
    async stat(path: RelPath): Promise<EntryMeta | null> {
      const blob = paths.get(path)
      return blob === undefined ? null : { kind: 'file', id: blob, size: blobs.get(blob)!.length, mode: 0o100644 }
    } }
  function write(path: string, text: string) {
    const bytes = Buffer.from(text)
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') as BlobId
    paths.set(path, blob); blobs.set(blob, bytes); view.rev = (Number(view.rev) + 1) as ViewRev
  }
  for (let at = 0; at < count; at++) write(String(at), `none ${at}`)
  const enumerate = async () => [...paths.keys()]
  return { view, paths, blobs, write, enumerate, source: async (blob: BlobId) => blobs.get(blob)! }
}
function held<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>(resolve => { release = resolve })
  return { promise, release }
}

test('opaque extraction recovers complete exact metadata/tables in one owned selected result', () => {
  const sources = [Buffer.from('abc\0def😀x'), Buffer.from([0xff, 0x61, 0x62]), Buffer.alloc(0)]
  const records = sources.map((bytes, at) => {
    const blob = createHash(at === 1 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') as BlobId
    return buildBlobIndex(blob, bytes)
  })
  const built = buildCohortIndex(records)
  const decoded = decodeCohortIndex(encodeCohortIndex(built), records.map(row => row.blob))!
  const absent = 'e'.repeat(40) as BlobId
  const extracted = cohortBlobRecords(decoded, [...records.map(row => row.blob), absent])!
  assert.equal(extracted.length, records.length, 'absent IDs have no learned empty table')
  for (const actual of extracted) {
    const expected = records.find(record => record.blob === actual.blob)!
    assert.deepEqual(encodeBlobIndex(actual), encodeBlobIndex(expected))
    assert.equal(Object.isFrozen(actual.tables.trigrams), true)
    assert.throws(() => (actual.tables.trigrams as string[]).push('bad'))
  }
  assert.equal(cohortBlobRecords({ ...decoded }, records.map(row => row.blob)), null)
  assert.equal(cohortBlobRecords(decoded, new Array<BlobId>(1)), null)
  assert.deepEqual(cohortBlobRecords(decoded, [absent]), [])
  assert.equal(cohortMightContain(decoded, absent, ['abc']), null)
})

test('opaque extraction rejects selected aggregate source limits before reconstructing tables', () => {
  const a = fixture()
  // Structural budget control only: checksum/shape does not authenticate this
  // synthetic inflated metadata. Actual preparation verifies new source hashes.
  const records = [...a.blobs].map(([blob, bytes]) => ({ ...buildBlobIndex(blob, bytes), sourceBytes: MAX_SOURCE_BYTES }))
  const index = buildCohortIndex(records)
  assert.equal(cohortBlobRecords(index, records.map(row => row.blob)), null)
  assert.equal(cohortBlobRecords(index, [records[0].blob])!.length, 1)
})

test('same IDs, rename/mode changes and deletion reuse records; a changed ID alone reads source', async () => {
  const b = fixture()
  let writes = 0
  const lookup = createViewCohortLookup(b.view, b.enumerate, { read: async () => null, write: async () => { writes++; return true } })
  const reads: BlobId[] = []
  const source = async (blob: BlobId) => { reads.push(blob); return b.source(blob) }
  assert.equal(await lookup.prepare(source), true); assert.equal(reads.length, 2)
  reads.length = 0
  assert.equal(await lookup.prepare(source), true); assert.equal(reads.length, 0)
  b.paths.set('renamed', b.paths.get('0')!); b.paths.delete('0'); b.view.rev = (Number(b.view.rev) + 1) as ViewRev
  assert.equal(await lookup.prepare(source), true); assert.equal(reads.length, 0)
  b.view.rev = (Number(b.view.rev) + 1) as ViewRev // mode-only generation change
  assert.equal(await lookup.prepare(source), true); assert.equal(reads.length, 0)
  b.write('renamed', 'needle newly matching')
  assert.equal(await lookup.prepare(source), true); assert.deepEqual(reads, [b.paths.get('renamed')])
  assert.deepEqual(await lookup.filterCandidates(['1', 'renamed'], ['nee']), ['renamed'])
  b.paths.delete('1'); b.view.rev = (Number(b.view.rev) + 1) as ViewRev
  reads.length = 0
  assert.equal(await lookup.prepare(source), true); assert.equal(reads.length, 0)
  b.write('1', 'needle recreated')
  assert.equal(await lookup.prepare(source), true); assert.deepEqual(reads, [b.paths.get('1')])
  assert.ok(writes > 0)
  await lookup.close()
})

test('restart hints load one exact artifact; corrupt priors and invalid hints cannot become reuse proofs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fugue-cohort-incremental-'))
  const store = createCohortIndexStore(root), b = fixture()
  const first = createViewCohortLookup(b.view, b.enumerate, store)
  const priorIds = [...b.paths.values()]
  const handles = [first]
  try {
    assert.equal(await first.prepare(b.source), true); await first.close()
    b.write('0', 'needle changed')
    const next = createViewCohortLookup(b.view, b.enumerate, store); handles.push(next)
    const sourceIds: BlobId[] = []
    const before = store.stats().reads
    assert.equal(await next.prepare(async blob => { sourceIds.push(blob); return b.source(blob) }, { previousBlobs: priorIds }), true)
    assert.deepEqual(sourceIds, [b.paths.get('0')]); assert.equal(store.stats().reads - before, 1)
    assert.equal(next.stats().reusedRecords, 1)
    await next.close()
    const path = join(root, '.fugue/idx/v1/cohorts', `${cohortKey(priorIds)}.bin`)
    await writeFile(path, 'corrupt')
    const damaged = createViewCohortLookup(b.view, b.enumerate, store); handles.push(damaged)
    sourceIds.length = 0
    assert.equal(await damaged.prepare(async blob => { sourceIds.push(blob); return b.source(blob) }, { previousBlobs: priorIds }), true)
    assert.equal(sourceIds.length, 2); assert.equal(damaged.stats().reusedRecords, 0)
    const invalid = createViewCohortLookup(b.view, b.enumerate, store); handles.push(invalid)
    const stats = store.stats()
    assert.equal(await invalid.prepare(async () => { assert.fail('invalid hint source') }, { previousBlobs: new Array<BlobId>(1) }), false)
    assert.equal(store.stats().reads, stats.reads)
  } finally { for (const handle of handles) await handle.close(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('prefetch is frozen and bounded to new IDs, consumed before the next batch; failed hints still hash sources', async () => {
  const b = fixture(129)
  const lookup = createViewCohortLookup(b.view, b.enumerate, { read: async () => null, write: async () => true })
  const events: string[] = []
  const prefetched: BlobId[][] = []
  assert.equal(await lookup.prepare(async blob => { events.push('source'); return b.source(blob) }, {
    prefetchBlobs: async ids => { events.push(`prefetch:${ids.length}`); assert.equal(Object.isFrozen(ids), true); prefetched.push([...ids]); throw new Error('hint failed') },
  }), true)
  assert.deepEqual(events, ['prefetch:128', ...Array<string>(128).fill('source'), 'prefetch:1', 'source'])
  assert.equal(new Set(prefetched.flat()).size, 129)
  b.write('0', 'needle')
  prefetched.length = 0
  assert.equal(await lookup.prepare(b.source, { prefetchBlobs: async ids => { prefetched.push([...ids]) } }), true)
  assert.deepEqual(prefetched, [[b.paths.get('0')]])
  await lookup.close()
})

test('retained descriptors and new source windows share one aggregate source budget', async () => {
  const b = fixture()
  const old = b.paths.get('0')!
  const record = { ...buildBlobIndex(old, b.blobs.get(old)!), sourceBytes: MAX_SOURCE_BYTES }
  const seed = buildCohortIndex([record])
  let writes = 0, reads = 0
  const lookup = createViewCohortLookup(b.view, b.enumerate, { read: async () => seed, write: async () => { writes++; return true } })
  assert.equal(await lookup.prepare(async blob => { reads++; return b.source(blob) }, { previousBlobs: [old] }), false)
  assert.equal(reads, 1); assert.equal(writes, 0)
  await lookup.close()
})

test('a complete prior set over the aggregate budget cannot bypass source verification through zero missing IDs', async () => {
  const b = fixture()
  const records = [...b.blobs].map(([blob, bytes]) => ({ ...buildBlobIndex(blob, bytes), sourceBytes: MAX_SOURCE_BYTES }))
  const seed = buildCohortIndex(records)
  let writes = 0, sources = 0
  const lookup = createViewCohortLookup(b.view, b.enumerate, { read: async () => seed, write: async () => { writes++; return true } })
  // Shape-valid inflated descriptors are a structural negative control. They
  // cannot be trusted as reused inputs; unknown extraction requires real source.
  assert.equal(await lookup.prepare(async () => { sources++; throw new Error('no verified source') }, {
    previousBlobs: records.map(record => record.blob),
  }), false)
  assert.equal(lookup.stats().reusedRecords, 0)
  assert.equal(sources, 1); assert.equal(writes, 0)
  await lookup.close()
})

test('stale restart work and closed held prefetch cannot publish or install a new proof', async () => {
  const b = fixture(), gate = held<ReturnType<typeof buildCohortIndex>>(), entered = held<void>()
  const seed = buildCohortIndex([...b.blobs].map(([blob, bytes]) => buildBlobIndex(blob, bytes)))
  let writes = 0, sources = 0
  const lookup = createViewCohortLookup(b.view, b.enumerate, { read: async () => { entered.release(); return gate.promise }, write: async () => { writes++; return true } })
  const pending = lookup.prepare(async blob => { sources++; return b.source(blob) }, { previousBlobs: [...b.paths.values()] })
  await entered.promise; b.write('0', 'needle'); gate.release(seed)
  assert.equal(await pending, false); assert.equal(writes, 0); assert.equal(sources, 0)
  await lookup.close()
  const hint = held<void>(), hinted = held<void>()
  const next = createViewCohortLookup(b.view, b.enumerate, { read: async () => null, write: async () => { writes++; return true } })
  const prep = next.prepare(async blob => { sources++; return b.source(blob) }, { prefetchBlobs: async () => { hinted.release(); await hint.promise } })
  await hinted.promise
  let closed = false
  const close = next.close().then(() => { closed = true })
  await Promise.resolve(); assert.equal(closed, false)
  hint.release(); assert.equal(await prep, false); await close
  assert.equal(writes, 0); assert.equal(sources, 0)
})
