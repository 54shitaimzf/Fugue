#!/usr/bin/env node
// 同进程交替：只改workerIdleMs，逐blob构建与源文本答案都核对。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createBlobIndexLookup } from '../src/search/blob-index.ts'

const blobs = new Map(Array.from({ length: 64 }, (_, at) => {
  const bytes = Buffer.from(`file ${at} ${at % 2 ? 'other' : 'needle'}\n` + 'stable source row\n'.repeat(2000))
  const id = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
  return [id, bytes]
}))
async function run(workerIdleMs) {
  const root = await mkdtemp(join(tmpdir(), 'fugue-worker-profile-'))
  let sourceReads = 0
  const index = createBlobIndexLookup(root, async id => { sourceReads++; return blobs.get(id) }, { workerIdleMs, maxPending: 1 })
  try {
    const start = performance.now()
    for (const id of blobs.keys()) {
      assert.equal(await index.mightContain(id, ['nee']), null)
      await index.drain()
    }
    const preparationMs = performance.now() - start
    const hits = []
    for (const id of blobs.keys()) if (await index.mightContain(id, ['nee']) !== false) hits.push(id)
    const expected = [...blobs.keys()].filter(id => blobs.get(id).toString('utf8').includes('needle'))
    assert.deepEqual(hits, expected)
    assert.equal(sourceReads, blobs.size)
    assert.equal(index.stats().builds, blobs.size)
    return { preparationMs: Math.round(preparationMs * 1000) / 1000, sourceReads, hits: hits.length, stats: index.stats() }
  } finally {
    await index.close()
    assert.equal(index.stats().retainedWorkers, 0)
    await rm(root, { recursive: true, force: true })
  }
}
const trials = []
for (let trial = 0; trial < 3; trial++) {
  let unpooled, pooled
  if (trial % 2 === 0) { unpooled = await run(0); pooled = await run(10000) }
  else { pooled = await run(10000); unpooled = await run(0) }
  assert.equal(unpooled.stats.workerStarts, blobs.size)
  assert.equal(pooled.stats.workerStarts, 1)
  assert.equal(unpooled.stats.grams, pooled.stats.grams)
  assert.equal(unpooled.stats.serializedBytes, pooled.stats.serializedBytes)
  trials.push({ unpooled, pooled })
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
console.log(JSON.stringify({ node: process.version, corpusFiles: blobs.size,
  corpusBytes: [...blobs.values()].reduce((sum, bytes) => sum + bytes.length, 0),
  medianPreparationMs: { unpooled: median(trials.map(t => t.unpooled.preparationMs)), pooled: median(trials.map(t => t.pooled.preparationMs)) },
  trials, boundary: 'Explicit preparation mechanism only, same source/codec/store and exact full-text hits. No product-query, cold-disk, ext4 or default-activation claim.' }, null, 2))
