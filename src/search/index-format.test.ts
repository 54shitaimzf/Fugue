import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { buildBlobIndex, decodeBlobIndex, encodeBlobIndex, MAX_INDEX_BYTES, MAX_SOURCE_BYTES, MAX_TRIGRAMS } from './index-format.ts'

function idOf(bytes: Uint8Array, algorithm = 'sha1'): string {
  return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}
function indexOf(text: string) { const bytes = Buffer.from(text); return buildBlobIndex(idOf(bytes), bytes) }

test('versioned roundtrip is deterministic and leaves an explicit unused symbol table', () => {
  const index = indexOf('banana\nbanana')
  assert.equal(index.version, 1)
  assert.deepEqual(index.tables.trigrams, ['\nba', 'a\nb', 'ana', 'ban', 'na\n', 'nan'])
  assert.equal(index.tables.symbols, null)
  const encoded = encodeBlobIndex(index)
  assert.deepEqual(decodeBlobIndex(encoded, index.blob), index)
  assert.deepEqual(encodeBlobIndex(index), encoded)
  assert.ok(Buffer.from(encoded).toString().endsWith('\n'))
})

test('decoded UTF-16 units preserve emoji, newline, binary and invalid UTF-8 grep semantics', () => {
  for (const bytes of [Buffer.from('x😀yz\nnext'), Buffer.from([0xff, 0x61, 0x62]), Buffer.from([0, 0x61, 0x62]), Buffer.from('')]) {
    const index = buildBlobIndex(idOf(bytes), bytes)
    const text = bytes.toString('utf8')
    assert.equal(index.textUnits, text.length)
    for (let i = 0; i + 2 < text.length; i++) assert.ok(index.tables.trigrams.includes(text.slice(i, i + 3)))
    assert.deepEqual(decodeBlobIndex(encodeBlobIndex(index), index.blob), index)
  }
  assert.deepEqual(buildBlobIndex(idOf(Buffer.from([0xff, 0x61, 0x62])), Buffer.from([0xff, 0x61, 0x62])).tables.trigrams, ['�ab'])
  assert.deepEqual(indexOf('xy').tables.trigrams, [])
})

test('source ID binding supports both object formats and rejects incorrect identities', () => {
  const bytes = Buffer.from('immutable')
  for (const algorithm of ['sha1', 'sha256']) {
    const id = idOf(bytes, algorithm)
    assert.equal(buildBlobIndex(id, bytes).blob, id)
    assert.ok(decodeBlobIndex(encodeBlobIndex(buildBlobIndex(id, bytes)), id))
  }
  assert.throws(() => buildBlobIndex('HEAD', bytes), /complete/)
  assert.throws(() => buildBlobIndex('a'.repeat(40), bytes), /does not match/)
  const index = indexOf('abc')
  assert.equal(decodeBlobIndex(encodeBlobIndex(index), 'b'.repeat(40)), null)
})

test('corrupt, truncated, duplicate-key, extra-field and unsupported-version records are misses', () => {
  const index = indexOf('abcabc')
  const original = Buffer.from(encodeBlobIndex(index)).toString()
  const corruptions = [original.slice(0, -2), original.replace('abc', 'abd'), original.replace('"version":1', '"version":2'),
    original.replace('"version":1', '"version":1,"version":1'), original.replace('"version":1', '"version":1,"extra":true'),
    original.replace('"symbols":null', '"symbols":[]'), original.replace('"checksum":"', '"checksum":"0'), 'null', '[]', '{}']
  for (const corrupt of corruptions) assert.equal(decodeBlobIndex(Buffer.from(corrupt), index.blob), null, corrupt)
  assert.equal(decodeBlobIndex(encodeBlobIndex(index), 'HEAD'), null)
  assert.deepEqual(decodeBlobIndex(encodeBlobIndex(indexOf('abcabc')), index.blob), index, 'fresh rebuild repairs a corrupted derived record')
})

test('encoders reject malformed, unsorted and duplicate postings instead of serializing partial tables', () => {
  const index = indexOf('abcdef')
  for (const trigrams of [['abc', 'abc'], ['bcd', 'abc'], ['ab'], ['abcd'], [1]]) {
    assert.throws(() => encodeBlobIndex({ ...index, tables: { trigrams: trigrams as string[], symbols: null } }), /invalid/)
  }
  assert.throws(() => encodeBlobIndex({ ...index, textUnits: -1 }), /invalid/)
  assert.throws(() => encodeBlobIndex({ ...index, sourceBytes: 2 }), /invalid/)
  assert.throws(() => encodeBlobIndex({ ...index, tables: { trigrams: [], symbols: null } }), /invalid/)
  assert.throws(() => encodeBlobIndex({ ...index, textUnits: 0 }), /invalid/)
  const empty = indexOf('')
  assert.throws(() => encodeBlobIndex({ ...empty, sourceBytes: 1 }), /invalid/)
})

test('source, record and trigram budgets fail without treating partial indexes as complete', () => {
  assert.throws(() => buildBlobIndex('a'.repeat(40), new Uint8Array(MAX_SOURCE_BYTES + 1)), /source byte budget/)
  const index = indexOf('abc')
  assert.equal(decodeBlobIndex(new Uint8Array(MAX_INDEX_BYTES + 1), index.blob), null)
  let text = ''
  for (let i = 0; i <= MAX_TRIGRAMS; i++) text += String.fromCharCode(0x1000 + (i >>> 16), 0x1000 + ((i >>> 8) & 255), 0x1000 + (i & 255))
  const bytes = Buffer.from(text)
  assert.throws(() => buildBlobIndex(idOf(bytes), bytes), /trigram budget/)
})


test('seeded binary corpora roundtrip every decoded UTF-16 trigram without omissions', () => {
  let seed = 20261001
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  for (let sample = 0; sample < 200; sample++) {
    const bytes = Buffer.from(Array.from({ length: next() % 160 }, () => next() & 255))
    const text = bytes.toString('utf8')
    const expected = new Set<string>()
    for (let at = 0; at + 2 < text.length; at++) expected.add(text.slice(at, at + 3))
    const index = buildBlobIndex(idOf(bytes), bytes)
    const decoded = decodeBlobIndex(encodeBlobIndex(index), index.blob)
    assert.ok(decoded)
    assert.deepEqual(decoded.tables.trigrams, [...expected].sort())
  }
})
