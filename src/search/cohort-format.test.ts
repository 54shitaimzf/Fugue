import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { buildBlobIndex, MAX_SOURCE_BYTES, MAX_TRIGRAMS } from './index-format.ts'
import type { BlobIndex } from './index-format.ts'
import { buildCohortIndex, cohortKey, cohortMightContain, decodeCohortIndex, encodeCohortIndex,
  MAX_COHORT_BLOBS, MAX_COHORT_BYTES, MAX_COHORT_GRAMS, MAX_COHORT_POSTINGS, MAX_COHORT_REQUIRED } from './cohort-format.ts'
import type { CohortIndex } from './cohort-format.ts'

function source(bytes: Uint8Array | string, algorithm: 'sha1' | 'sha256' = 'sha1') {
  const data = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes)
  const blob = createHash(algorithm).update(`blob ${data.byteLength}\0`).update(data).digest('hex')
  return { data, index: buildBlobIndex(blob, data) }
}
function repaired(bytes: Buffer): Buffer {
  const checksum = createHash('sha256').update(bytes.subarray(0, bytes.length - 32)).digest()
  checksum.copy(bytes, bytes.length - 32)
  return bytes
}
function layout(index: CohortIndex) {
  const dictionaryAt = 56 + index.blobs.reduce((count, id) => count + 13 + id.length / 2, 0)
  return { dictionaryAt, postingsAt: dictionaryAt + index.gramCount * 12 }
}
function random(seed: number) {
  let state = seed >>> 0
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0 }
}
function snapshot(index: BlobIndex): BlobIndex {
  return { ...index, tables: { trigrams: [...index.tables.trigrams], symbols: null } }
}

test('packed cohort is deterministic, exact-ID-bound and separate from per-blob v1', () => {
  const records = [source('banana\nbanana').index, source('x😀yz\nnext', 'sha256').index, source('').index]
  const index = buildCohortIndex(records)
  const encoded = encodeCohortIndex(index)
  assert.deepEqual(encoded, encodeCohortIndex(buildCohortIndex([...records].reverse())))
  assert.equal(index.key, cohortKey(records.map(record => record.blob)))
  assert.equal(index.postingCount, records.reduce((count, record) => count + record.tables.trigrams.length, 0))
  assert.equal(index.gramCount, new Set(records.flatMap(record => [...record.tables.trigrams])).size)
  assert.equal(index.byteLength, encoded.byteLength)
  const decoded = decodeCohortIndex(encoded, records.map(record => record.blob).reverse())!
  assert.ok(decoded)
  assert.deepEqual(encodeCohortIndex(decoded), encoded)
  assert.deepEqual(decoded, index)
  assert.equal(decodeCohortIndex(encoded, records.slice(1).map(record => record.blob)), null)
  assert.equal(decodeCohortIndex(encoded, [records[0].blob, records[0].blob]), null)
  assert.equal(decodeCohortIndex(encoded, records.map((record, at) => at === 0 ? 'a'.repeat(40) : record.blob)), null)
  assert.equal(cohortKey([]), null)
  assert.equal(cohortKey(['HEAD']), null)
  assert.equal(cohortKey(['A'.repeat(40)]), null)
  assert.equal(cohortKey(new Array(MAX_COHORT_BLOBS + 1).fill('a'.repeat(40))), null)
  assert.throws(() => buildCohortIndex([records[0], records[0]]), /duplicate/)
  assert.throws(() => buildCohortIndex([]), /budget/)
  assert.equal(cohortMightContain(index, records[0].blob, ['ban', 'ana']), true)
  assert.equal(cohortMightContain(index, records[0].blob, ['xyz']), false)
  assert.equal(cohortMightContain(index, records[2].blob, ['ban']), false)
})

test('owned snapshots ignore iterators and stay immutable across input/output mutations', () => {
  const record = snapshot(source('abcdef').index)
  const grams = record.tables.trigrams as string[]
  grams[Symbol.iterator] = function* () { yield 'xyz' }
  const records = [record]
  records[Symbol.iterator] = function* () { yield source('wrong').index }
  const ids = [record.blob]
  ids[Symbol.iterator] = function* () { yield 'f'.repeat(40) }
  const index = buildCohortIndex(records)
  assert.equal(index.key, cohortKey(ids))
  assert.ok(Object.isFrozen(index)); assert.ok(Object.isFrozen(index.blobs))
  grams[0] = 'xxx'; records[0] = source('changed').index
  const wire = encodeCohortIndex(index)
  const padded = Buffer.concat([Buffer.from('outside'), Buffer.from(wire), Buffer.from('outside')])
  const view = padded.subarray(7, 7 + wire.length)
  const decoded = decodeCohortIndex(view, ids)!
  assert.ok(decoded)
  view.fill(0); wire.fill(0)
  assert.equal(cohortMightContain(index, ids[0], ['abc']), true)
  assert.equal(cohortMightContain(decoded, ids[0], ['abc']), true)
  const required = ['abc']
  required[Symbol.iterator] = function* () { yield 'xyz' }
  assert.equal(cohortMightContain(index, ids[0], required), true)
  assert.equal(cohortMightContain({ ...index }, ids[0], ['abc']), null)
  assert.throws(() => encodeCohortIndex({ ...index }), /unrecognized/)
})

test('all unsupported requirements and absent identities remain unknown before any negative', () => {
  const record = source('abcdef').index, index = buildCohortIndex([record])
  for (const required of [[], ['ab'], ['abcd'], ['xyz', null], new Array(2), new Array(MAX_COHORT_REQUIRED + 1).fill('abc')]) {
    assert.equal(cohortMightContain(index, record.blob, required as string[]), null)
  }
  assert.equal(cohortMightContain(index, 'b'.repeat(40), ['xyz']), null)
  assert.equal(cohortMightContain(index, 'HEAD', ['xyz']), null)
  const required = new Proxy(['xyz'], { get(target, key) { if (key === 'length') throw new Error('hostile length'); return Reflect.get(target, key) } })
  assert.equal(cohortMightContain(index, record.blob, required), null)
  assert.equal(cohortKey(required), null)
  assert.throws(() => buildCohortIndex(required as unknown as BlobIndex[]), /hostile/)
})

test('UTF16 code units include NUL, replacement units, surrogate halves and all gram extrema', () => {
  const fixtures = [Buffer.from('x😀yz\nnext'), Buffer.from([0xff, 0x61, 0x62]), Buffer.from([0, 0x61, 0x62]), Buffer.from('xy'), Buffer.from('')]
  for (const data of fixtures) {
    const { index: record } = source(data)
    const index = decodeCohortIndex(encodeCohortIndex(buildCohortIndex([record])), [record.blob])!
    assert.ok(index)
    for (let at = 0; at + 2 < data.toString('utf8').length; at++) {
      assert.equal(cohortMightContain(index, record.blob, [data.toString('utf8').slice(at, at + 3)]), true)
    }
  }
  // Structural codec fixture. Caller provenance remains a separate build/store contract.
  const grams = ['\0\0\0', '\ud800\udfff\uffff', '\uffff\uffff\uffff']
  const record: BlobIndex = { format: 'fugue-blob-trigrams', version: 1, blob: 'a'.repeat(40), sourceBytes: 100, textUnits: 100, tables: { trigrams: grams, symbols: null } }
  const index = decodeCohortIndex(encodeCohortIndex(buildCohortIndex([record])), [record.blob])!
  for (const gram of grams) assert.equal(cohortMightContain(index, record.blob, [gram]), true)
  assert.equal(cohortMightContain(index, record.blob, ['\uffff\uffff\ufffe']), false)
})

test('seeded differential gram reference and canonical regex full scan never lose matches', () => {
  const next = random(0x7189ab)
  const sources = Array.from({ length: 48 }, (_, ordinal) => {
    const bytes = Buffer.alloc(80 + next() % 400)
    for (let at = 0; at < bytes.length; at++) bytes[at] = next() % 256
    // Distinct textual seed makes useful positive and negative literal probes.
    return source(Buffer.concat([Buffer.from(`item${ordinal}: needle${ordinal}\n`), bytes]), ordinal % 2 ? 'sha256' : 'sha1')
  })
  const records = sources.map(item => item.index)
  const index = decodeCohortIndex(encodeCohortIndex(buildCohortIndex(records)), records.map(record => record.blob))!
  assert.ok(index)
  const references = records.map(record => new Set(record.tables.trigrams))
  const queries: string[][] = []
  for (let probe = 0; probe < 200; probe++) {
    const chosen = records[next() % records.length].tables.trigrams
    queries.push(Array.from({ length: 1 + next() % 5 }, () => chosen[next() % chosen.length]))
  }
  queries.push(['\0\0\0'], ['\uffff\uffff\uffff'])
  for (const required of queries) {
    for (let ordinal = 0; ordinal < records.length; ordinal++) {
      assert.equal(cohortMightContain(index, records[ordinal].blob, required), required.every(gram => references[ordinal].has(gram)))
    }
  }
  for (let ordinal = 0; ordinal < sources.length; ordinal++) {
    const literal = `needle${ordinal}`, regex = new RegExp(literal), required: string[] = []
    for (let at = 0; at + 2 < literal.length; at++) required.push(literal.slice(at, at + 3))
    const fullScan = sources.filter(item => regex.test(item.data.toString('utf8'))).map(item => item.index.blob).sort()
    const filteredScan = sources.filter(item => cohortMightContain(index, item.index.blob, required) !== false)
      .filter(item => regex.test(item.data.toString('utf8'))).map(item => item.index.blob).sort()
    assert.deepEqual(filteredScan, fullScan)
  }
})

test('structural corruption with recomputed checksums still fails closed as a proof and open as a query', () => {
  const records = [source('abcdefg').index, source('abczzzz').index]
  const index = buildCohortIndex(records), base = Buffer.from(encodeCohortIndex(index)), ids = [...index.blobs]
  const { dictionaryAt, postingsAt } = layout(index)
  const mutations: Array<(bytes: Buffer) => void> = [
    bytes => { bytes[0] ^= 1 }, bytes => bytes.writeUInt16BE(2, 8), bytes => bytes.writeUInt16BE(1, 10),
    bytes => bytes.writeUInt32BE(0xffffffff, 12), bytes => bytes.writeUInt32BE(MAX_COHORT_GRAMS + 1, 16),
    bytes => bytes.writeUInt32BE(MAX_COHORT_POSTINGS + 1, 20), bytes => { bytes[24] ^= 1 },
    bytes => { bytes[56] = 21 }, bytes => { bytes[57] ^= 1 },
    bytes => bytes.writeUInt32BE(MAX_SOURCE_BYTES + 1, 77), bytes => bytes.writeUInt32BE(0xffffffff, 81),
    bytes => bytes.writeUInt32BE(MAX_TRIGRAMS + 1, 85),
    bytes => bytes.copy(bytes, dictionaryAt + 12, dictionaryAt, dictionaryAt + 6),
    bytes => bytes.writeUInt32BE(1, dictionaryAt + 6), bytes => bytes.writeUInt16BE(0, dictionaryAt + 10),
    bytes => bytes.writeUInt16BE(MAX_COHORT_BLOBS + 1, dictionaryAt + 10),
    bytes => bytes.writeUInt16BE(records.length, postingsAt),
    bytes => bytes.writeUInt16BE(bytes.readUInt16BE(postingsAt), postingsAt + 2),
  ]
  for (let ordinal = 0; ordinal < mutations.length; ordinal++) {
    const bytes = Buffer.from(base); mutations[ordinal](bytes)
    assert.equal(decodeCohortIndex(repaired(bytes), ids), null, `malformed case ${ordinal}`)
  }
  for (let length = 0; length < base.length; length++) assert.equal(decodeCohortIndex(base.subarray(0, length), ids), null)
  assert.equal(decodeCohortIndex(Buffer.concat([base, Buffer.from([0])]), ids), null)
  assert.equal(decodeCohortIndex(Buffer.alloc(MAX_COHORT_BYTES + 1), ids), null)
  // Seeded byte corruption and adversarial count fields exercise parser limits/overflow.
  const next = random(0x15f00d)
  for (let iteration = 0; iteration < 1000; iteration++) {
    const bytes = Buffer.from(base), at = next() % bytes.length
    bytes[at] ^= 1 + next() % 255
    assert.equal(decodeCohortIndex(bytes, ids), null)
  }
  for (let iteration = 0; iteration < 300; iteration++) {
    const bytes = Buffer.from(base), at = [12, 16, 20, dictionaryAt + 6][next() % 4]
    bytes.writeUInt32BE(0x80000000 + next() % 0x80000000, at)
    assert.equal(decodeCohortIndex(repaired(bytes), ids), null)
  }
})

test('spoofed typed-array length and mutable proxy lengths cannot evade bounds', () => {
  const record = source('abcdef').index, index = buildCohortIndex([record]), wire = encodeCohortIndex(index)
  class SpoofedLength extends Uint8Array { get byteLength() { return 1 } }
  const spoofed = new SpoofedLength(wire.length); spoofed.set(wire)
  assert.ok(decodeCohortIndex(spoofed, [record.blob]))
  const oversized = new SpoofedLength(MAX_COHORT_BYTES + 1)
  assert.equal(decodeCohortIndex(oversized, [record.blob]), null)
  let reads = 0
  const ids = new Proxy([record.blob], { get(target, key) { if (key === 'length') return ++reads === 1 ? 1 : Number.MAX_SAFE_INTEGER; return Reflect.get(target, key) } })
  assert.equal(cohortKey(ids), index.key)
  assert.equal(reads, 1)
})

test('builder rejects complete-cohort budgets wholesale, never a truncated dictionary or postings prefix', () => {
  const gramAt = (value: number) => String.fromCharCode(Math.floor(value / 0x1_0000_0000), Math.floor(value / 0x1_0000) % 0x1_0000, value % 0x1_0000)
  const synthetic = (id: number, grams: readonly string[]): BlobIndex => ({
    format: 'fugue-blob-trigrams', version: 1, blob: id.toString(16).padStart(40, '0'),
    sourceBytes: 1_000_000, textUnits: 500_000, tables: { trigrams: grams, symbols: null },
  })
  const first = Array.from({ length: 100_001 }, (_, at) => gramAt(at))
  const second = Array.from({ length: 100_001 }, (_, at) => gramAt(100_001 + at))
  assert.throws(() => buildCohortIndex([synthetic(1, first), synthetic(2, second)]), /dictionary budget/)
  const common = Array.from({ length: MAX_TRIGRAMS }, (_, at) => gramAt(at))
  const overPostings = Array.from({ length: 11 }, (_, at) => synthetic(at + 1, common))
  assert.throws(() => buildCohortIndex(overPostings), /posting budget/)
  assert.throws(() => buildCohortIndex(new Array(MAX_COHORT_BLOBS + 1)), /blob budget/)
  const malformed = snapshot(source('abcdef').index)
  ;(malformed.tables.trigrams as string[]).reverse()
  assert.throws(() => buildCohortIndex([malformed]), /invalid blob index/)
})
