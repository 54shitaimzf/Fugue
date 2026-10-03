import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { createBlobIndexLookup } from './blob-index.ts'
import { createBlobIndexStore } from './index-store.ts'
function id(bytes: Uint8Array, algorithm = 'sha1'): string { return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex') }
async function fixture() {
  const root = tmpDir('fugue-facts-lookup-'), store = createBlobIndexStore(root)
  const sources = new Map<string, Uint8Array>()
  const add = async (text: string, algorithm = 'sha1') => {
    const bytes = Buffer.from(text), blob = id(bytes, algorithm); sources.set(blob, bytes)
    assert.equal((await store.rebuild(blob, bytes)).stored, true)
    return blob
  }
  const source = async (blob: string) => { const bytes = sources.get(blob); if (bytes === undefined) throw new Error('source missing'); return bytes }
  return { root, store, sources, add, source }
}

test('learned immutable facts survive decoded LRU eviction but unknown grams still load full tables', async () => {
  const f = await fixture(), a = await f.add('abc xyz'), b = await f.add('abc second', 'sha256'), c = await f.add('third xyz')
  const lookup = createBlobIndexLookup(f.root, f.source, { maxRecords: 1 })
  try {
    assert.equal(await lookup.mightContain(a, ['abc']), true)
    assert.equal(await lookup.mightContain(b, ['abc']), true)
    assert.equal(await lookup.mightContain(c, ['abc']), false)
    const loads = lookup.stats().diskHits
    for (const [blob, expected] of [[a, true], [b, true], [c, false]] as const) assert.equal(await lookup.mightContain(blob, ['abc']), expected)
    assert.equal(lookup.stats().diskHits, loads)
    assert.equal(lookup.stats().factHits, 3)
    assert.equal(await lookup.mightContain(a, ['xyz']), true, 'unknown membership cannot be invented as absence')
    assert.equal(lookup.stats().diskHits, loads + 1)
    assert.equal(await lookup.mightContain(a, ['abc', 'xyz']), true)
  } finally { await lookup.close() }
})

test('requirement mutation after await cannot poison facts learned for the original requirement', async () => {
  const f = await fixture(), blob = await f.add('abc xyz'), lookup = createBlobIndexLookup(f.root, f.source)
  try {
    assert.equal(await lookup.mightContain(blob, ['abc']), true)
    const required = ['xyz'], pending = lookup.mightContain(blob, required)
    required[0] = 'zzz'
    assert.equal(await pending, true)
    const before = lookup.stats().factHits
    assert.equal(await lookup.mightContain(blob, ['xyz']), true)
    assert.equal(lookup.stats().factHits, before + 1)
    assert.equal(await lookup.mightContain(blob, ['zzz']), false)
  } finally { await lookup.close() }
})

test('close racing a resolved table lookup cannot relearn cleared facts or return an exclusion', async () => {
  const f = await fixture(), blob = await f.add('abc xyz'), lookup = createBlobIndexLookup(f.root, f.source)
  assert.equal(await lookup.mightContain(blob, ['abc']), true)
  const pending = lookup.mightContain(blob, ['zzz'])
  await Promise.all([lookup.close(), pending.then(answer => assert.equal(answer, null))])
  assert.equal(lookup.stats().factEntries, 0); assert.equal(lookup.stats().factKeys, 0)
  assert.equal(lookup.stats().factLogicalBytes, 0)
  assert.equal(await lookup.mightContain(blob, ['abc']), null)
})

test('separate repository handles do not share facts and corrupt/failed reads learn nothing', async () => {
  const f = await fixture(), blob = await f.add('abc'), first = createBlobIndexLookup(f.root, f.source)
  const missing = createBlobIndexLookup(tmpDir('fugue-facts-other-repo-'), async () => { throw new Error('missing') })
  try {
    assert.equal(await first.mightContain(blob, ['xyz']), false)
    assert.equal(await missing.mightContain(blob, ['xyz']), null)
    await missing.drain()
    assert.equal(missing.stats().factEntries, 0)
    await first.close()
    writeFileSync(join(f.root, '.fugue/idx/v1', blob.slice(0, 2), `${blob}.json`), '{"corrupt":')
    const corrupt = createBlobIndexLookup(f.root, async () => { throw new Error('offline') })
    try {
      assert.equal(await corrupt.mightContain(blob, ['xyz']), null)
      await corrupt.drain()
      assert.equal(corrupt.stats().factKeys, 0)
      assert.equal(await corrupt.mightContain(blob, ['abc']), null)
      await corrupt.drain()
      assert.equal(corrupt.stats().factKeys, 0)
    } finally { await corrupt.close() }
  } finally { await Promise.all([first.close(), missing.close()]) }
})

test('fact budgets and disabled existing retention budgets preserve fallback and release counters', async () => {
  const f = await fixture(), blob = await f.add('abcdef')
  for (const options of [{ facts: false } as const, { maxRecords: 0 }, { maxGrams: 0 }, { maxSerializedBytes: 0 }, { facts: { maxFacts: 1 } }]) {
    const lookup = createBlobIndexLookup(f.root, f.source, options)
    try {
      assert.equal(await lookup.mightContain(blob, ['abc', 'bcd', 'cde']), true)
      assert.equal(lookup.stats().factEntries, 0)
      assert.equal(lookup.stats().factKeys, 0)
      assert.equal(lookup.stats().factLogicalBytes, 0)
    } finally { await lookup.close() }
  }
  assert.throws(() => createBlobIndexLookup(f.root, f.source, { facts: { maxFacts: Infinity } }), /invalid index fact/)
})
