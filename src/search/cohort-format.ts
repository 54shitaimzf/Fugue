// Optional derived cohort format. Existing per-blob v1 records remain unchanged.
import { createHash } from 'node:crypto'
import type { BlobId } from '../terms.ts'
import { encodeBlobIndex, MAX_SOURCE_BYTES, MAX_TRIGRAMS } from './index-format.ts'
import type { BlobIndex } from './index-format.ts'

export const COHORT_VERSION = 1
export const MAX_COHORT_BLOBS = 4096
export const MAX_COHORT_GRAMS = 200_000
export const MAX_COHORT_POSTINGS = 2_000_000
export const MAX_COHORT_BYTES = 32 * 1024 * 1024
export const MAX_COHORT_REQUIRED = 256

/** An immutable handle, not a caller-constructible membership proof. */
export interface CohortIndex {
  readonly key: string
  readonly blobs: readonly BlobId[]
  readonly gramCount: number
  readonly postingCount: number
  readonly byteLength: number
}
interface PackedState {
  readonly bytes: Buffer
  readonly dictionaryAt: number
  readonly postingsAt: number
  readonly ordinals: ReadonlyMap<BlobId, number>
}
const states = new WeakMap<CohortIndex, PackedState>()
const MAGIC = Buffer.from('FGCOHORT')
const HEADER_BYTES = 56
const CHECKSUM_BYTES = 32
const GRAM_ENTRY_BYTES = 12
const KEY_DOMAIN = 'fugue-cohort-utf16-postings-v1\0'
const UNIT_BASE = 0x1_0000
const HIGH_BASE = 0x1_0000_0000

function isBlob(id: unknown): id is BlobId {
  return typeof id === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)
}
function bounded(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}
function sortedBlobs(input: readonly BlobId[]): BlobId[] | null {
  if (!Array.isArray(input)) return null
  const length = input.length
  if (!bounded(length, MAX_COHORT_BLOBS) || length === 0) return null
  const ids: BlobId[] = []
  for (let at = 0; at < length; at++) {
    const id: unknown = input[at]
    if (!isBlob(id)) return null
    ids.push(id)
  }
  ids.sort()
  for (let at = 1; at < ids.length; at++) if (ids[at - 1] === ids[at]) return null
  return ids
}
function keyOfSorted(ids: readonly BlobId[]): string {
  const hash = createHash('sha256').update(KEY_DOMAIN)
  const count = Buffer.alloc(4)
  count.writeUInt32BE(ids.length)
  hash.update(count)
  // The digest length separates SHA1 and SHA256. IDs are complete, never prefixes.
  for (let at = 0; at < ids.length; at++) {
    hash.update(Buffer.from([ids[at].length / 2]))
    hash.update(Buffer.from(ids[at], 'hex'))
  }
  return hash.digest('hex')
}
/** Order-independent identity for an exact, nonempty, distinct bounded set. */
export function cohortKey(blobs: readonly BlobId[]): string | null {
  try { const ids = sortedBlobs(blobs); return ids === null ? null : keyOfSorted(ids) }
  catch { return null }
}
function gramKey(gram: string): number {
  return gram.charCodeAt(0) * HIGH_BASE + gram.charCodeAt(1) * UNIT_BASE + gram.charCodeAt(2)
}
function readGram(bytes: Buffer, at: number): number {
  return bytes.readUInt16BE(at) * HIGH_BASE + bytes.readUInt16BE(at + 2) * UNIT_BASE + bytes.readUInt16BE(at + 4)
}
function writeGram(bytes: Buffer, at: number, key: number): void {
  bytes.writeUInt16BE(Math.floor(key / HIGH_BASE), at)
  bytes.writeUInt16BE(Math.floor(key / UNIT_BASE) % UNIT_BASE, at + 2)
  bytes.writeUInt16BE(key % UNIT_BASE, at + 4)
}
const viewPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const viewLength = Object.getOwnPropertyDescriptor(viewPrototype, 'byteLength')!.get!
const viewOffset = Object.getOwnPropertyDescriptor(viewPrototype, 'byteOffset')!.get!
const viewBuffer = Object.getOwnPropertyDescriptor(viewPrototype, 'buffer')!.get!
function ownedBytes(input: Uint8Array): Buffer | null {
  if (!(input instanceof Uint8Array)) return null
  const length = viewLength.call(input) as number
  if (length < HEADER_BYTES + CHECKSUM_BYTES || length > MAX_COHORT_BYTES) return null
  return Buffer.from(new Uint8Array(viewBuffer.call(input), viewOffset.call(input), length))
}
function checksum(bytes: Buffer): Buffer { return createHash('sha256').update(bytes).digest() }
function handle(bytes: Buffer, ids: BlobId[], dictionaryAt: number, gramCount: number, postingCount: number): CohortIndex {
  const index: CohortIndex = Object.freeze({ key: bytes.subarray(24, 56).toString('hex'),
    blobs: Object.freeze(ids), gramCount, postingCount, byteLength: bytes.byteLength })
  states.set(index, { bytes, dictionaryAt, postingsAt: dictionaryAt + gramCount * GRAM_ENTRY_BYTES,
    ordinals: new Map(ids.map((id, ordinal) => [id, ordinal])) })
  return index
}

/** Capture indexed fields once; do not trust array iterators or later mutations. */
function snapshotRecord(record: BlobIndex): BlobIndex {
  if (record === null || typeof record !== 'object') throw new Error('invalid cohort record')
  const format = record.format, version = record.version, blob = record.blob
  const sourceBytes = record.sourceBytes, textUnits = record.textUnits, tables = record.tables
  if (tables === null || typeof tables !== 'object') throw new Error('invalid cohort tables')
  const grams = tables.trigrams, symbols = tables.symbols
  if (!Array.isArray(grams)) throw new Error('invalid cohort grams')
  const length = grams.length
  if (!bounded(length, MAX_TRIGRAMS)) throw new Error('invalid cohort grams')
  const trigrams: string[] = []
  for (let at = 0; at < length; at++) trigrams.push(grams[at])
  const owned: BlobIndex = { format, version, blob, sourceBytes, textUnits, tables: { trigrams, symbols } }
  // Reuse the unchanged v1 format's complete shape/budget validation.
  encodeBlobIndex(owned)
  return owned
}

/**
 * Input must be COMPLETE records from hash-verified sources or the controlled
 * derived store. Shape/checksum validation alone does not establish provenance.
 * An incomplete/over-budget cohort is rejected wholesale, never published partly.
 */
export function buildCohortIndex(records: readonly BlobIndex[]): CohortIndex {
  if (!Array.isArray(records)) throw new Error('invalid cohort records')
  const length = records.length
  if (!bounded(length, MAX_COHORT_BLOBS) || length === 0) throw new Error('cohort blob budget exceeded')
  const owned: BlobIndex[] = []
  let postingCount = 0
  for (let at = 0; at < length; at++) {
    const record = snapshotRecord(records[at])
    postingCount += record.tables.trigrams.length
    if (postingCount > MAX_COHORT_POSTINGS) throw new Error('cohort posting budget exceeded')
    owned.push(record)
  }
  owned.sort((a, b) => a.blob < b.blob ? -1 : a.blob > b.blob ? 1 : 0)
  const ids = owned.map(record => record.blob)
  const key = cohortKey(ids)
  if (key === null) throw new Error('invalid or duplicate cohort blob ID')
  const postings = new Map<number, number[]>()
  for (let ordinal = 0; ordinal < owned.length; ordinal++) {
    for (const gram of owned[ordinal].tables.trigrams) {
      const key = gramKey(gram)
      const found = postings.get(key)
      if (found === undefined) {
        if (postings.size >= MAX_COHORT_GRAMS) throw new Error('cohort dictionary budget exceeded')
        postings.set(key, [ordinal])
      } else found.push(ordinal)
    }
  }
  const keys = [...postings.keys()].sort((a, b) => a - b)
  const dictionaryAt = HEADER_BYTES + ids.reduce((bytes, id) => bytes + 13 + id.length / 2, 0)
  const postingsAt = dictionaryAt + keys.length * GRAM_ENTRY_BYTES
  const payloadBytes = postingsAt + postingCount * 2
  if (payloadBytes + CHECKSUM_BYTES > MAX_COHORT_BYTES) throw new Error('cohort byte budget exceeded')
  const bytes = Buffer.alloc(payloadBytes + CHECKSUM_BYTES)
  MAGIC.copy(bytes)
  bytes.writeUInt16BE(COHORT_VERSION, 8)
  // Bytes 10..11 are reserved and must remain zero.
  bytes.writeUInt32BE(ids.length, 12)
  bytes.writeUInt32BE(keys.length, 16)
  bytes.writeUInt32BE(postingCount, 20)
  Buffer.from(key, 'hex').copy(bytes, 24)
  let at = HEADER_BYTES
  for (const record of owned) {
    const digest = Buffer.from(record.blob, 'hex')
    bytes[at++] = digest.length
    digest.copy(bytes, at); at += digest.length
    bytes.writeUInt32BE(record.sourceBytes, at); at += 4
    bytes.writeUInt32BE(record.textUnits, at); at += 4
    bytes.writeUInt32BE(record.tables.trigrams.length, at); at += 4
  }
  let postingAt = 0
  for (let ordinal = 0; ordinal < keys.length; ordinal++) {
    const entryAt = dictionaryAt + ordinal * GRAM_ENTRY_BYTES
    const candidates = postings.get(keys[ordinal])!
    writeGram(bytes, entryAt, keys[ordinal])
    bytes.writeUInt32BE(postingAt, entryAt + 6)
    bytes.writeUInt16BE(candidates.length, entryAt + 10)
    for (const candidate of candidates) bytes.writeUInt16BE(candidate, postingsAt + 2 * postingAt++)
  }
  checksum(bytes.subarray(0, payloadBytes)).copy(bytes, payloadBytes)
  return handle(bytes, ids, dictionaryAt, keys.length, postingCount)
}

/** Returns a copy: mutating or transferring it cannot alter the live proof. */
export function encodeCohortIndex(index: CohortIndex): Uint8Array {
  const state = states.get(index)
  if (state === undefined) throw new Error('unrecognized cohort handle')
  return Uint8Array.from(state.bytes)
}

/** All failures are unknown. Exact expected identities are mandatory, not optional. */
export function decodeCohortIndex(input: Uint8Array, expectedBlobs: readonly BlobId[]): CohortIndex | null {
  try {
    const ids = sortedBlobs(expectedBlobs)
    if (ids === null) return null
    const bytes = ownedBytes(input) // Own the actual view, not its backing buffer.
    if (bytes === null) return null
    const payloadBytes = bytes.byteLength - CHECKSUM_BYTES
    if (!bytes.subarray(0, 8).equals(MAGIC) || bytes.readUInt16BE(8) !== COHORT_VERSION || bytes.readUInt16BE(10) !== 0) return null
    const blobCount = bytes.readUInt32BE(12), gramCount = bytes.readUInt32BE(16), postingCount = bytes.readUInt32BE(20)
    if (blobCount !== ids.length || gramCount > MAX_COHORT_GRAMS || postingCount > MAX_COHORT_POSTINGS) return null
    if (bytes.subarray(24, 56).toString('hex') !== keyOfSorted(ids)) return null
    if (!checksum(bytes.subarray(0, payloadBytes)).equals(bytes.subarray(payloadBytes))) return null
    let at = HEADER_BYTES
    const expectedCounts: number[] = []
    for (let ordinal = 0; ordinal < blobCount; ordinal++) {
      if (at >= payloadBytes) return null
      const digestBytes = bytes[at++]
      if ((digestBytes !== 20 && digestBytes !== 32) || at + digestBytes + 12 > payloadBytes) return null
      if (bytes.subarray(at, at + digestBytes).toString('hex') !== ids[ordinal]) return null
      at += digestBytes
      const sourceBytes = bytes.readUInt32BE(at), textUnits = bytes.readUInt32BE(at + 4), count = bytes.readUInt32BE(at + 8)
      at += 12
      // Reuse v1 constraints without reconstructing a potentially huge string table.
      if (sourceBytes > MAX_SOURCE_BYTES || textUnits > sourceBytes || ((sourceBytes === 0) !== (textUnits === 0))) return null
      if (count > MAX_TRIGRAMS || count > Math.max(0, textUnits - 2) || (textUnits >= 3 && count === 0)) return null
      expectedCounts.push(count)
    }
    const dictionaryAt = at, postingsAt = dictionaryAt + gramCount * GRAM_ENTRY_BYTES
    if (postingsAt + postingCount * 2 !== payloadBytes) return null
    const actualCounts = new Uint32Array(blobCount)
    let previousGram = -1, consumed = 0
    for (let ordinal = 0; ordinal < gramCount; ordinal++) {
      const entryAt = dictionaryAt + ordinal * GRAM_ENTRY_BYTES
      const key = readGram(bytes, entryAt), start = bytes.readUInt32BE(entryAt + 6), count = bytes.readUInt16BE(entryAt + 10)
      if (key <= previousGram || start !== consumed || count === 0 || count > blobCount || consumed + count > postingCount) return null
      previousGram = key
      let previousBlob = -1
      for (let candidate = 0; candidate < count; candidate++) {
        const blob = bytes.readUInt16BE(postingsAt + (start + candidate) * 2)
        if (blob <= previousBlob || blob >= blobCount) return null
        previousBlob = blob
        actualCounts[blob]++
      }
      consumed += count
    }
    if (consumed !== postingCount || expectedCounts.some((count, ordinal) => count !== actualCounts[ordinal])) return null
    return handle(bytes, ids, dictionaryAt, gramCount, postingCount)
  } catch { return null }
}

/** true means candidate only; the original regex must still verify real content. */
export function cohortMightContain(index: CohortIndex, blob: BlobId, required: readonly string[]): boolean | null {
  try {
    const state = states.get(index)
    if (state === undefined || !isBlob(blob) || !Array.isArray(required)) return null
    const length = required.length
    if (!bounded(length, MAX_COHORT_REQUIRED) || length === 0) return null
    const target = state.ordinals.get(blob)
    if (target === undefined) return null
    const keys: number[] = []
    // Validate ALL requirements before any absence result; malformed tails are unknown.
    for (let at = 0; at < length; at++) {
      const gram = required[at]
      if (typeof gram !== 'string' || gram.length !== 3) return null
      keys.push(gramKey(gram))
    }
    for (const key of keys) {
      let low = 0, high = index.gramCount - 1, entryAt = -1
      while (low <= high) {
        const middle = Math.floor((low + high) / 2), at = state.dictionaryAt + middle * GRAM_ENTRY_BYTES
        const found = readGram(state.bytes, at)
        if (found < key) low = middle + 1
        else if (found > key) high = middle - 1
        else { entryAt = at; break }
      }
      if (entryAt === -1) return false
      const start = state.bytes.readUInt32BE(entryAt + 6), count = state.bytes.readUInt16BE(entryAt + 10)
      low = 0; high = count - 1
      let present = false
      while (low <= high) {
        const middle = Math.floor((low + high) / 2), candidate = state.bytes.readUInt16BE(state.postingsAt + (start + middle) * 2)
        if (candidate < target) low = middle + 1
        else if (candidate > target) high = middle - 1
        else { present = true; break }
      }
      if (!present) return false
    }
    return true
  } catch { return null }
}
