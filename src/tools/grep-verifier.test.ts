// Pure verifier ownership/completeness controls; no Git, process or network.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { View } from '../view/contract.ts'
import type { ToolHost } from './execute.ts'
import { searchLines } from './search-receipt.ts'
import { bindGrepVerifier, grepVerificationStats, verifiedGrepMatches, MAX_VERIFICATION_SOURCE_BYTES,
  MAX_VERIFICATION_RECORD_BYTES, MAX_VERIFICATION_BYTES, MAX_VERIFICATION_ENTRIES } from './grep-verifier.ts'

function fixture(bytes: Uint8Array = Buffer.from('none\nhit\nhit\n'), algorithm = 'sha1') {
  let source = bytes, reads = 0
  const hash = (b: Uint8Array) => createHash(algorithm).update(`blob ${b.byteLength}\0`).update(b).digest('hex')
  let id = hash(bytes)
  const view = { base: null, rev: 0, stat: async () => ({ kind: 'file', id, size: bytes.byteLength, mode: 0o100644 }) }
  const host = { readBytes: async () => { reads++; return { bytes: source, mode: 0o100644 } } } as ToolHost
  bindGrepVerifier(host, view as unknown as View)
  return { host, view, reads: () => reads, id: () => id, source: (next: Uint8Array) => { source = next },
    change: (next: Uint8Array) => { source = next; id = hash(next); view.rev++ }, stats: () => grepVerificationStats(host)! }
}
async function scan(f: ReturnType<typeof fixture>, re: RegExp) {
  const proof = await verifiedGrepMatches(f.host, 'file', re)
  assert.ok(proof !== undefined && proof !== null)
  assert.equal(proof.current(), true)
  return [...proof.matches]
}

test('complete verified immutable results reuse exact regex source/flags and expose no mutable rows', async () => {
  const f = fixture()
  assert.deepEqual(await scan(f, /hit/), [{ line: 'hit', number: 2 }, { line: 'hit', number: 3 }])
  assert.equal(f.stats().installed, 1)
  const second = await scan(f, /hit/)
  assert.equal(f.reads(), 1); assert.equal(f.stats().hits, 1)
  assert.throws(() => { (second[0] as { line: string }).line = 'forged' }, TypeError)
  assert.deepEqual(await scan(f, /hit/i), second)
  assert.equal(f.reads(), 2, 'flags do not alias the old record')
  assert.deepEqual(await scan(f, /^hit$/m), second)
  assert.equal(f.reads(), 3, 'source and flags both belong in the key')
})

test('consumer return never installs partial positive or negative verification', async () => {
  const f = fixture()
  const proof = await verifiedGrepMatches(f.host, 'file', /hit/)
  assert.ok(proof)
  for (const line of proof.matches) { assert.equal(line.number, 2); break }
  assert.equal(f.stats().installed, 0)
  assert.equal(f.stats().testedLines, 2, 'the scanner did not finish the tail to populate its cache')
  assert.equal((await scan(f, /hit/)).length, 2)
  assert.equal(f.reads(), 2); assert.equal(f.stats().installed, 1)
})

test('SHA1/SHA256 visible windows preserve invalid UTF8, CRLF, NUL and terminal blank numbering', async () => {
  const bytes = Buffer.from([0xff, 13, 10, 0, 10])
  for (const algorithm of ['sha1', 'sha256']) {
    const f = fixture(bytes, algorithm)
    let getters = 0
    class Spoofed extends Uint8Array {
      get byteLength() { getters++; return 0 }
      get byteOffset() { getters++; return 999 }
      get buffer() { getters++; return new ArrayBuffer(0) }
      [Symbol.iterator](): ArrayIterator<number> { assert.fail('source iterator consumed') }
    }
    const backing = Buffer.concat([Buffer.from('padding'), bytes, Buffer.from('tail')])
    f.source(new Spoofed(backing.buffer, backing.byteOffset + 7, bytes.length))
    const expected = [...searchLines(bytes.toString('utf8'))]
    assert.deepEqual(await scan(f, /(?:)/u), expected)
    assert.deepEqual(await scan(f, /(?:)/u), expected)
    assert.equal(getters, 0); assert.equal(f.reads(), 1); assert.equal(f.stats().verifiedSources, 1)
  }
  const empty = fixture(Buffer.alloc(0))
  assert.deepEqual(await scan(empty, /^$/), [{ line: '', number: 1 }])
})

test('wrong-address bytes remain scan results and never become an immutable cache proof', async () => {
  const f = fixture(Buffer.from('hit'))
  f.source(Buffer.from('none'))
  assert.deepEqual(await scan(f, /hit/), [])
  assert.deepEqual(await scan(f, /hit/), [])
  assert.equal(f.stats().installed, 0); assert.equal(f.stats().rejectedSources, 2); assert.equal(f.reads(), 2)
  f.source(Buffer.from('hit'))
  assert.deepEqual(await scan(f, /hit/), [{ line: 'hit', number: 1 }])
})

test('global/sticky/custom regex and wrapped/replaced readers preserve legacy authority', async () => {
  const f = fixture()
  for (const re of [/hit/g, /hit/y, new (class extends RegExp {})('hit')]) {
    re.lastIndex = 2
    assert.equal(await verifiedGrepMatches(f.host, 'file', re), undefined)
    assert.equal(re.lastIndex, 2, 'fallback must not reset stateful regex')
  }
  const custom = /hit/
  Object.defineProperty(custom, 'exec', { get: () => { assert.fail('custom method accessor consumed') } })
  assert.equal(await verifiedGrepMatches(f.host, 'file', custom), undefined)
  assert.equal(f.reads(), 0)
  await scan(f, /hit/)
  const clone = { ...f.host }
  assert.equal(await verifiedGrepMatches(clone, 'file', /hit/), undefined)
  f.host.readBytes = async () => ({ bytes: Buffer.from('different'), mode: 0o100644 })
  assert.equal(await verifiedGrepMatches(f.host, 'file', /hit/), undefined)
})

test('intrinsic regex fields ignore caller accessors and generation proof is rechecked after await', async () => {
  const f = fixture()
  const re = /hit/u
  for (const field of ['source', 'flags', 'unicode', 'global']) Object.defineProperty(re, field, { get: () => { assert.fail('custom regex accessor consumed') } })
  assert.equal((await scan(f, re)).length, 2)
  const proof = await verifiedGrepMatches(f.host, 'file', re)
  assert.ok(proof)
  f.change(Buffer.from('other'))
  assert.equal(proof.current(), false, 'a queued consumer cannot use the previous cached positive or negative')
  assert.deepEqual(await scan(f, /hit/u), [])
})

test('source and record ceilings skip caching while the original full verification remains exact', async () => {
  const f = fixture(Buffer.alloc(MAX_VERIFICATION_SOURCE_BYTES + 1, 120))
  assert.deepEqual(await scan(f, /absent/), [])
  assert.deepEqual(await scan(f, /absent/), [])
  assert.equal(f.stats().installed, 0); assert.equal(f.reads(), 2)
  const largeMatch = fixture(Buffer.alloc(MAX_VERIFICATION_RECORD_BYTES, 120))
  assert.equal((await scan(largeMatch, /x/))[0]!.line.length, MAX_VERIFICATION_RECORD_BYTES)
  assert.equal(largeMatch.stats().installed, 0)
})

test('retained records have bounded entries/bytes and LRU hits affect eviction order', async () => {
  const f = fixture(Buffer.alloc(0))
  for (let at = 0; at < MAX_VERIFICATION_ENTRIES; at++) await scan(f, new RegExp(`^${at}$`))
  assert.equal(f.stats().entries, MAX_VERIFICATION_ENTRIES)
  await scan(f, /^0$/)
  await scan(f, /^extra$/)
  assert.equal(f.stats().entries, MAX_VERIFICATION_ENTRIES)
  assert.ok(f.stats().bytes <= MAX_VERIFICATION_BYTES)
  const reads = f.reads()
  await scan(f, /^0$/)
  assert.equal(f.reads(), reads, 'the recently used entry survived')
  await scan(f, /^1$/)
  assert.equal(f.reads(), reads + 1, 'the oldest untouched entry was evicted')
  const weighted = fixture(Buffer.alloc(30_000, 120))
  for (let at = 0; at < 40; at++) await scan(weighted, new RegExp(`x|(?:${at})`))
  assert.ok(weighted.stats().evictions > 0, 'the byte ceiling evicts before the entry ceiling')
  assert.ok(weighted.stats().entries < 40)
  assert.ok(weighted.stats().bytes <= MAX_VERIFICATION_BYTES)
})

test('reader replacement during metadata await starts no source work for the old binding', { timeout: 10_000 }, async () => {
  const f = fixture()
  let release!: () => void, enter!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { enter = resolve })
  const stat = f.view.stat
  f.view.stat = async () => { enter(); await gate; return stat() }
  const pending = verifiedGrepMatches(f.host, 'file', /hit/)
  try {
    await Promise.race([entered, pending.then(() => { assert.fail('verifier completed before the metadata callback') })])
    f.host.readBytes = async () => ({ bytes: Buffer.from('replacement'), mode: 0o100644 })
    release()
    assert.equal(await pending, undefined)
    assert.equal(f.reads(), 0)
    assert.equal(f.stats().installed, 0)
  } finally {
    release()
    await pending.catch(() => {})
  }
})

test('only complete admitted lines are detached, preserving decoded Unicode bytes exactly', async () => {
  const body = Buffer.from('hit 😀 e\u0301 \u0000 替换�\r\nhit 第二行\n')
  const f = fixture(body)
  const original = Buffer.from
  const copied: string[] = []
  Buffer.from = ((...args: unknown[]) => {
    if (typeof args[0] === 'string') copied.push(args[0])
    return Reflect.apply(original, Buffer, args)
  }) as typeof Buffer.from
  try {
    const partial = await verifiedGrepMatches(f.host, 'file', /hit/u)
    assert.ok(partial)
    for (const line of partial.matches) { assert.equal(line.number, 1); break }
    assert.deepEqual(copied, [], 'a partial record must not allocate retained line copies')
    const expected = [...searchLines(body.toString('utf8'))].filter(line => /hit/u.test(line.line))
    assert.deepEqual(await scan(f, /hit/u), expected)
    assert.deepEqual(copied, expected.map(line => line.line))
    assert.deepEqual(await scan(f, /hit/u), expected)
    assert.equal(copied.length, expected.length, 'cache hits do not copy the source again')
    const oversized = fixture(Buffer.alloc(MAX_VERIFICATION_RECORD_BYTES, 120))
    await scan(oversized, /x/)
    assert.equal(copied.length, expected.length, 'over-budget records must not allocate cached line copies')
  } finally { Buffer.from = original }
})
