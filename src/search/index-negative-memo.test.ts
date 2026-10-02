import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBlobIndexLookup } from './blob-index.ts'
import { createBlobIndexStore } from './index-store.ts'
import { buildBlobIndex, IndexBudgetError, MAX_SOURCE_BYTES } from './index-format.ts'
import type { BlobId } from '../terms.ts'

function blobOf(bytes: Uint8Array, algorithm: 'sha1' | 'sha256' = 'sha1'): BlobId {
  return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex') as BlobId
}

for (const algorithm of ['sha1', 'sha256'] as const) {
  test(`unverified oversized source cannot suppress a valid ${algorithm} retry`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'fugue-index-negative-retry-'))
    const bytes = Buffer.from('needle'), blob = blobOf(bytes, algorithm)
    let calls = 0
    const lookup = createBlobIndexLookup(root, async () => ++calls === 1 ? Buffer.alloc(MAX_SOURCE_BYTES + 1) : bytes)
    try {
      assert.equal(await lookup.mightContain(blob, ['nee']), null)
      await lookup.drain()
      assert.equal(lookup.stats().unindexable, 0, 'size alone is not source identity evidence')
      assert.equal(await lookup.mightContain(blob, ['nee']), null)
      await lookup.drain()
      assert.equal(calls, 2)
      assert.equal(await lookup.mightContain(blob, ['nee']), true, 'valid retry builds the requested source')
    } finally {
      try { await lookup.close() }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  })
}

function diverseSource(): Buffer {
  let seed = 0x71bd204d
  const text: string[] = []
  for (let at = 0; at < 260_000; at++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    // 全是可编码BMP标量，不靠非法UTF8替换或NUL构造预算失败。
    text.push(String.fromCharCode(0x100 + (seed >>> 0) % 0xc000))
  }
  return Buffer.from(text.join(''))
}

test('verified deterministic trigram-budget memo remains useful until close clears it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fugue-index-negative-close-'))
  const bytes = diverseSource(), blob = blobOf(bytes)
  assert.ok(bytes.byteLength < MAX_SOURCE_BYTES)
  assert.throws(() => buildBlobIndex(blob, bytes), error => error instanceof IndexBudgetError)
  let calls = 0
  const lookup = createBlobIndexLookup(root, async () => { calls++; return bytes })
  try {
    assert.equal(await lookup.mightContain(blob, ['nee']), null)
    await lookup.drain()
    assert.equal(lookup.stats().unindexable, 1, 'controlled worker verified identity before trigram rejection')
    assert.equal(await lookup.mightContain(blob, ['nee']), null)
    await lookup.drain()
    assert.equal(calls, 1, 'genuine deterministic failure still avoids redundant builds')
    const closing = lookup.close()
    assert.equal(lookup.stats().unindexable, 0, 'close releases negative state before awaited cleanup')
    await closing
    await lookup.close()
    assert.equal(lookup.stats().unindexable, 0)
  } finally {
    try { await lookup.close() }
    finally { await rm(root, { recursive: true, force: true }) }
  }
})


test('store source admission cannot certify a wrong-address oversized reply as deterministic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fugue-index-negative-store-'))
  const bytes = Buffer.from('needle'), blob = blobOf(bytes), store = createBlobIndexStore(root)
  try {
    const refused = await store.rebuild(blob, Buffer.alloc(MAX_SOURCE_BYTES + 1))
    assert.equal(refused.index, null)
    assert.equal(refused.stored, false)
    assert.notEqual(refused.unindexable, true, 'source identity was not verified before admission failed')
    const retry = await store.rebuild(blob, bytes)
    assert.equal(retry.stored, true)
    assert.equal(retry.index?.blob, blob)
    const wrongAddress = await store.rebuild(blob, diverseSource())
    assert.notEqual(wrongAddress.unindexable, true, 'trigram-heavy foreign bytes still fail identity first')
  } finally { await rm(root, { recursive: true, force: true }) }
})
