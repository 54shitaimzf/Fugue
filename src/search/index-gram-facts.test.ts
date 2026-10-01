import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createIndexFactCache } from './index-gram-facts.ts'
function id(text: string, algorithm = 'sha1'): string { const bytes = Buffer.from(text); return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }

test('partial membership knowledge stays unknown except for an actually absent requirement', () => {
  const cache = createIndexFactCache(), blob = id('first')
  assert.equal(cache.query(blob, [1]), null)
  cache.remember(blob, [[1, true], [2, false]])
  assert.equal(cache.query(blob, [1]), true)
  assert.equal(cache.query(blob, [1, 3]), null)
  assert.equal(cache.query(blob, [3, 2]), false)
  assert.equal(cache.query(blob, [1, 1]), true)
  const observations: [number, boolean][] = [[3, true]]
  cache.remember(blob, observations); observations[0][1] = false
  assert.equal(cache.query(blob, [1, 3]), true)
})

test('independent instances, blob identities and object algorithms never share learned state', () => {
  const first = createIndexFactCache(), second = createIndexFactCache()
  const a = id('same bytes'), sha256 = id('same bytes', 'sha256'), other = id('other bytes')
  first.remember(a, [[1, false]])
  assert.equal(second.query(a, [1]), null)
  assert.equal(first.query(sha256, [1]), null)
  assert.equal(first.query(other, [1]), null)
  second.remember(a, [[1, false]]); first.clear()
  assert.equal(first.query(a, [1]), null); assert.equal(second.query(a, [1]), false)
  assert.equal(first.stats().logicalBytes, 0)
})

test('all three retention budgets evict whole rows, LRU refresh preserves active rows', () => {
  const a = id('a'), b = id('b'), c = id('c')
  const cache = createIndexFactCache({ maxBlobs: 2 })
  cache.remember(a, [[1, true]]); cache.remember(b, [[2, false]])
  cache.query(a, [1]); cache.remember(c, [[3, false]])
  assert.equal(cache.query(b, [2]), null); assert.equal(cache.query(a, [1]), true)
  for (const options of [{ maxFacts: 1 }, { maxLogicalBytes: 49 }]) {
    const small = createIndexFactCache(options)
    small.remember(a, [[1, true]]); small.remember(b, [[2, false]])
    assert.equal(small.query(a, [1]), null); assert.equal(small.stats().facts, 1)
    assert.equal(small.stats().logicalBytes, 49)
  }
  const tiny = createIndexFactCache({ maxLogicalBytes: 48 })
  assert.equal(tiny.remember(a, [[1, true]]), false); assert.equal(tiny.stats().blobs, 0)
})

test('invalid/disabled input cannot make a retained exclusion, contradictory batches invalidate', () => {
  const blob = id('safe'), cache = createIndexFactCache()
  for (const options of [{ maxBlobs: 0 }, { maxFacts: 0 }, { maxLogicalBytes: 0 }]) {
    const disabled = createIndexFactCache(options)
    assert.equal(disabled.remember(blob, [[1, false]]), false); assert.equal(disabled.query(blob, [1]), null)
  }
  for (const keys of [[], [NaN], [-1], [0x1_0000_0000_0000], Array(257).fill(1)]) assert.equal(cache.query(blob, keys), null)
  assert.equal(cache.remember('HEAD', [[1, false]]), false)
  assert.equal(cache.remember(blob, [[1, true], [1, false]]), false)
  assert.equal(cache.stats().blobs, 0)
  cache.remember(blob, [[1, true], [2, false]])
  assert.equal(cache.remember(blob, [[1, false]]), false)
  assert.equal(cache.query(blob, [2]), null); assert.equal(cache.stats().conflicts, 2)
  for (const options of [{ maxFacts: Infinity }, { maxBlobs: -1 }, { maxLogicalBytes: 0.5 }]) assert.throws(() => createIndexFactCache(options), /invalid index fact/)
})

test('seeded diverse queries never return a false exclusion or invented all-present answer', () => {
  const cache = createIndexFactCache({ maxBlobs: 32, maxFacts: 128, maxLogicalBytes: 8192 })
  let seed = 0x5eed
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const corpus = Array.from({ length: 80 }, (_, at) => ({ blob: id(`source ${at}`, at % 2 ? 'sha1' : 'sha256'), table: new Set(Array.from({ length: 8 }, () => next() % 64)) }))
  for (let trial = 0; trial < 5000; trial++) {
    const { blob, table } = corpus[next() % corpus.length]
    const keys = Array.from({ length: 1 + next() % 6 }, () => next() % 64)
    const answer = cache.query(blob, keys), expected = keys.every(key => table.has(key))
    if (answer !== null) assert.equal(answer, expected)
    cache.remember(blob, keys.map(key => [key, table.has(key)] as const))
    assert.equal(cache.query(blob, keys), expected)
    assert.ok(cache.stats().blobs <= 32 && cache.stats().facts <= 128 && cache.stats().logicalBytes <= 8192)
  }
})

test('contradictory incoming batch invalidates every fact already retained for that blob', () => {
  const cache = createIndexFactCache(), blob = id('retained')
  cache.remember(blob, [[1, false], [2, true]])
  assert.equal(cache.query(blob, [1]), false)
  assert.equal(cache.remember(blob, [[1, true], [1, false]]), false)
  assert.equal(cache.query(blob, [1]), null)
  assert.equal(cache.query(blob, [2]), null)
  assert.deepEqual(cache.stats(), { blobs: 0, facts: 0, logicalBytes: 0, evictions: 0, conflicts: 1 })
})
