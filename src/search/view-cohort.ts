// Optional current-View cohort adapter. Preparation is explicit; a query miss scans.
import type { BlobId, RelPath } from '../terms.ts'
import type { View } from '../view/contract.ts'
import type { CohortIndexStore } from './cohort-store.ts'
import { buildBlobIndex, MAX_SOURCE_BYTES } from './index-format.ts'
import type { BlobIndex } from './index-format.ts'
import { buildCohortIndex, cohortKey, cohortMightContain, MAX_COHORT_BLOBS, MAX_COHORT_POSTINGS } from './cohort-format.ts'
import type { CohortIndex } from './cohort-format.ts'
import { MAX_INDEX_REQUIREMENTS } from './current-view-candidates.ts'
// 一批候选的上限就是批读存储一次最多读的行数（同一个数，不另拍一个）。
import { MAX_INDEX_BATCH_ROWS as MAX_INDEX_CANDIDATE_BATCH } from './index-store.ts'

type CohortView = Pick<View, 'base' | 'rev' | 'stat'>
export interface ViewCohortLookup {
  filterCandidates(paths: readonly string[], required: readonly string[]): Promise<readonly string[]>
}
export interface ViewCohortHandle extends ViewCohortLookup {
  /** Caller-paid preparation from immutable Git objects; never called by filterCandidates. */
  prepare(readBlob: (blob: BlobId) => Promise<Uint8Array>): Promise<boolean>
  /** Observes admitted work; the caller separately owns store.close(). */
  close(): Promise<void>
  stats(): { queries: number; diskReads: number; sourceReads: number; builds: number; fallbacks: number; active: number; closed: boolean }
}
interface Generation {
  readonly base: View['base']
  readonly rev: View['rev']
}
interface Snapshot extends Generation { readonly blobs: readonly BlobId[] }
interface Cached extends Generation { readonly result: Promise<CohortIndex | null> }
const owners = new WeakMap<ViewCohortLookup, CohortView>()
const typedArray = Object.getPrototypeOf(Uint8Array.prototype)
const byteLengthOf = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!
const byteOffsetOf = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset')!.get!
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!
/** An adapter prepared for another View cannot supply negative path decisions to this host. */
export function cohortLookupForView(lookup: ViewCohortLookup, view: CohortView): boolean {
  return owners.get(lookup) === view
}
const MAX_VIEW_PATHS = 5000
function id(value: unknown): value is BlobId {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
}
function strings(input: readonly string[], maximum: number, gram = false): readonly string[] | null {
  if (!Array.isArray(input)) return null
  const count = input.length
  if (!Number.isSafeInteger(count) || count < 0 || count > maximum || (gram && count === 0)) return null
  const output: string[] = []
  for (let at = 0; at < count; at++) {
    const value = input[at]
    if (typeof value !== 'string' || (gram && value.length !== 3)) return null
    output.push(value)
  }
  return Object.freeze(output)
}

/** The enumeration and metadata are exclusively current View reads, never host paths. */
export function createViewCohortLookup(
  view: CohortView, enumerate: () => Promise<readonly string[]>,
  store: Pick<CohortIndexStore, 'read' | 'write'>,
): ViewCohortHandle {
  let closed = false
  let cached: Cached | undefined
  let preparing: Promise<boolean> | undefined
  const active = new Set<Promise<unknown>>()
  const counts = { queries: 0, diskReads: 0, sourceReads: 0, builds: 0, fallbacks: 0 }
  const generation = (): Generation => ({ base: view.base, rev: view.rev })
  function changed(mark: Generation): boolean {
    try { return closed || view.base !== mark.base || view.rev !== mark.rev }
    catch { return true }
  }
  function admit<T>(fallback: T, run: () => Promise<T>): Promise<T> {
    if (closed || active.size >= 4) return Promise.resolve(fallback)
    let finish!: () => void
    const reservation = new Promise<void>(resolve => { finish = resolve })
    active.add(reservation)
    return Promise.resolve().then(run).catch(() => fallback).finally(() => { active.delete(reservation); finish() })
  }
  async function snapshot(mark: Generation): Promise<Snapshot | null> {
    const paths = strings(await enumerate(), MAX_VIEW_PATHS)
    if (paths === null || changed(mark)) return null
    const blobs = new Set<BlobId>()
    for (const path of paths) {
      const meta = await view.stat(path as RelPath)
      if (changed(mark)) return null
      if (meta?.kind !== 'file') continue
      if (!id(meta.id)) return null
      blobs.add(meta.id)
      if (blobs.size > MAX_COHORT_BLOBS) return null
    }
    if (blobs.size === 0) return null
    return { ...mark, blobs: Object.freeze([...blobs].sort()) }
  }
  function load(mark: Generation): Promise<CohortIndex | null> {
    if (cached !== undefined && cached.base === mark.base && cached.rev === mark.rev) return cached.result
    const current: Cached = { ...mark, result: (async () => {
      const selected = await snapshot(mark)
      if (selected === null || changed(mark)) return null
      counts.diskReads++
      const index = await store.read(selected.blobs)
      return changed(mark) || index === null || index.key !== cohortKey(selected.blobs) ? null : index
    })().catch(() => null) }
    cached = current
    return current.result
  }
  const handle: ViewCohortHandle = {
    filterCandidates(paths, required) {
      let original: readonly string[]
      let grams: readonly string[] | null
      try {
        const captured = strings(paths, MAX_INDEX_CANDIDATE_BATCH)
        if (captured === null) return Promise.resolve(paths)
        original = captured
        grams = strings(required, MAX_INDEX_REQUIREMENTS, true)
      } catch { return Promise.resolve(paths) }
      return admit(original, async () => {
        counts.queries++
        if (original.length > MAX_INDEX_CANDIDATE_BATCH || grams === null) return original
        const mark = generation()
        const index = await load(mark)
        if (index === null || changed(mark)) { counts.fallbacks++; return original }
        const keep: string[] = []
        for (const path of original) {
          const meta = await view.stat(path as RelPath)
          if (changed(mark)) { counts.fallbacks++; return original }
          if (meta?.kind !== 'file' || !id(meta.id) || cohortMightContain(index, meta.id, grams) !== false) keep.push(path)
        }
        return changed(mark) ? original : keep
      })
    },
    prepare(readBlob) {
      if (closed) return Promise.resolve(false)
      if (preparing !== undefined) return preparing
      const task = admit(false, async () => {
        if (typeof readBlob !== 'function') return false
        const mark = generation()
        const selected = await snapshot(mark)
        if (selected === null) return false
        const records: BlobIndex[] = []
        let sourceBytes = 0, postings = 0
        for (const blob of selected.blobs) {
          if (changed(mark)) return false
          counts.sourceReads++
          const bytes = await readBlob(blob)
          if (changed(mark) || !(bytes instanceof Uint8Array)) return false
          const length = byteLengthOf.call(bytes) as number
          sourceBytes += length
          if (sourceBytes > MAX_SOURCE_BYTES) return false
          // Never trust subclass accessors or an iterator; charge the intrinsic byte window
          // before allocating an owned snapshot used for both hashing and decoded grams.
          const owned = Uint8Array.from(new Uint8Array(bufferOf.call(bytes), byteOffsetOf.call(bytes), length))
          const record = buildBlobIndex(blob, owned)
          postings += record.tables.trigrams.length
          if (postings > MAX_COHORT_POSTINGS) return false
          records.push(record)
        }
        if (changed(mark)) return false
        const index = buildCohortIndex(records)
        counts.builds++
        if (!await store.write(index) || changed(mark)) return false
        cached = { ...mark, result: Promise.resolve(index) }
        return true
      })
      preparing = task
      task.finally(() => { if (preparing === task) preparing = undefined }).catch(() => {})
      return task
    },
    async close() {
      closed = true
      cached = undefined
      await Promise.allSettled([...active])
    },
    stats: () => ({ ...counts, active: active.size, closed }),
  }
  owners.set(handle, view)
  return handle
}
