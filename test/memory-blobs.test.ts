// Pure accepted Lower blob-port fixture, including Buffer ownership.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { memoryBlobs } from './helpers/memory-blobs.ts'

test('virtual blob ports preserve Git identity and owned bytes for both formats', async () => {
  for (const algorithm of ['sha1', 'sha256'] as const) {
    const store = memoryBlobs(algorithm)
    for (const input of [Buffer.alloc(0), Buffer.from('雪\0needle'), Buffer.from([0xff, 0, 0x80])]) {
      const original = new Uint8Array(input)
      const pending = store.putBlob(input)
      input.fill(0x61)
      const id = await pending
      assert.equal(id, createHash(algorithm).update(`blob ${original.length}\0`).update(original).digest('hex'))
      assert.equal(id.length, algorithm === 'sha1' ? 40 : 64)
      const first = await store.readBlob(id)
      assert.deepEqual(first, original)
      first.fill(0x62)
      assert.deepEqual(await store.readBlob(id), original)
      await assert.rejects(memoryBlobs(algorithm).readBlob(id), /unknown memory blob/)
    }
  }
})
