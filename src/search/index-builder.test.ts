import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { buildBlobIndex, encodeBlobIndex, INDEX_VERSION } from './index-format.ts'
import type { BlobIndex } from './index-format.ts'

function sourceId(bytes: Uint8Array, algorithm = 'sha1'): string {
  return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}
function fullStringReference(blob: string, bytes: Uint8Array): BlobIndex {
  const text = Buffer.from(bytes).toString('utf8'), grams = new Set<string>()
  for (let at = 0; at + 2 < text.length; at++) grams.add(text.slice(at, at + 3))
  return { format: 'fugue-blob-trigrams', version: INDEX_VERSION, blob,
    sourceBytes: bytes.byteLength, textUnits: text.length,
    tables: { trigrams: [...grams].sort(), symbols: null } }
}

test('packed builder emits identical canonical bytes for high-unit, binary and diverse sources', () => {
  let seed = 0x51a7
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const entropy = String.fromCharCode(...Array.from({ length: 30000 }, () => next() & 0xffff))
  const corpus = [Buffer.alloc(0), Buffer.from('\u0000a😀𠀀\uffff\ufffe\u0001 abc\r\n'),
    Buffer.from(entropy), Buffer.from(Array.from({ length: 256 * 4 }, (_, at) => at & 255))]
  for (let sample = 0; sample < 200; sample++) corpus.push(Buffer.from(Array.from({ length: next() % 513 }, () => next() & 255)))
  for (const bytes of corpus) {
    for (const algorithm of ['sha1', 'sha256']) {
      const blob = sourceId(bytes, algorithm)
      const expected = fullStringReference(blob, bytes)
      assert.deepEqual(buildBlobIndex(blob, bytes), expected)
      assert.deepEqual(encodeBlobIndex(buildBlobIndex(blob, bytes)), encodeBlobIndex(expected))
    }
  }
})

test('repeated source positions do not allocate three-unit substring entries', (t) => {
  const bytes = Buffer.from('repeated abc😀\u0000\n'.repeat(10000)), blob = sourceId(bytes)
  const textUnits = bytes.toString('utf8').length
  const original = String.prototype.slice
  let slices = 0
  t.mock.method(String.prototype, 'slice', function (start: number, end?: number) {
    if (this.length === textUnits && end === start + 3) slices++
    return original.call(this, start, end)
  })
  const index = buildBlobIndex(blob, bytes)
  assert.ok(index.tables.trigrams.length > 0)
  assert.equal(slices, 0, 'allocate strings only after deduplicating numeric keys')
})
