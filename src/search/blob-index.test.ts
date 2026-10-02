import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { createBlobIndexLookup } from './blob-index.ts'
import type { IndexLookupHandle } from './blob-index.ts'
import { MAX_SOURCE_BYTES } from './index-format.ts'
import { copyIndexSource } from './index-source.ts'

function idOf(bytes: Uint8Array): string { return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex') }
function fixture() {
  const root = tmpDir('fugue-index-lookup-')
  const blobs = new Map<string, Uint8Array>()
  let reads = 0
  const add = (text: string) => { const bytes = Buffer.from(text); const id = idOf(bytes); blobs.set(id, bytes); return id }
  const source = async (id: string) => { reads++; const bytes = blobs.get(id); if (bytes === undefined) throw new Error('missing blob'); return bytes }
  return { root, blobs, add, source, reads: () => reads }
}
async function build(lookup: IndexLookupHandle, id: string, grams: string[]): Promise<void> {
  await lookup.mightContain(id, grams)
  await lookup.drain()
}

test('miss scans immediately; subsequent hot/disk hits read only genuinely new source blobs', async () => {
  const f = fixture(), a = f.add('first abc'), b = f.add('second xyz')
  const lookup = createBlobIndexLookup(f.root, f.source)
  assert.equal(await lookup.mightContain(a, ['abc']), null)
  await lookup.drain()
  assert.equal(await lookup.mightContain(a, ['abc']), true)
  assert.equal(await lookup.mightContain(a, ['xyz']), false)
  assert.equal(f.reads(), 1)
  const restarted = createBlobIndexLookup(f.root, f.source)
  assert.equal(await restarted.mightContain(a, ['abc']), true)
  assert.equal(f.reads(), 1)
  assert.equal(await restarted.mightContain(b, ['xyz']), null)
  await restarted.drain()
  assert.equal(await restarted.mightContain(b, ['xyz']), true)
  assert.equal(f.reads(), 2)
  assert.equal(restarted.stats().diskHits, 1)
  await Promise.all([lookup.close(), restarted.close()])
})

test('corrupt shard is a nonblocking miss, then background repair is equivalent', async () => {
  const f = fixture(), id = f.add('repair abc')
  const first = createBlobIndexLookup(f.root, f.source)
  await build(first, id, ['abc']); await first.close()
  writeFileSync(join(f.root, '.fugue/idx/v1', id.slice(0, 2), `${id}.json`), '{"incomplete":')
  const repaired = createBlobIndexLookup(f.root, f.source)
  assert.equal(await repaired.mightContain(id, ['abc']), null)
  await repaired.drain()
  assert.equal(await repaired.mightContain(id, ['abc']), true)
  assert.equal(await repaired.mightContain(id, ['xyz']), false)
  assert.equal(f.reads(), 2)
  await repaired.close()
})

test('source failures/wrong IDs/unsupported requirements never become exclusions or cached failures', async () => {
  const f = fixture(), id = f.add('safe abc')
  const failing = createBlobIndexLookup(f.root, async () => { throw new Error('unavailable') })
  for (let i = 0; i < 2; i++) { assert.equal(await failing.mightContain(id, ['abc']), null); await failing.drain() }
  assert.equal(failing.stats().pending, 0); assert.equal(failing.stats().entries, 0)
  const wrong = createBlobIndexLookup(f.root, async () => Buffer.from('different source'))
  assert.equal(await wrong.mightContain(id, ['abc']), null); await wrong.drain()
  assert.equal(wrong.stats().entries, 0)
  const lookup = createBlobIndexLookup(f.root, f.source)
  for (const required of [[], ['ab'], ['abcd'], Array(257).fill('abc'), new Array(1)]) assert.equal(await lookup.mightContain(id, required), null)
  assert.equal(await lookup.mightContain('HEAD', ['abc']), null)
  assert.equal(f.reads(), 0)
  await Promise.all([failing.close(), wrong.close(), lookup.close()])
})

test('blocked optional source does not block queries; pending loads are shared and bounded', async () => {
  const f = fixture(), a = f.add('first abc'), b = f.add('second xyz')
  let release: () => void = () => {}
  const gate = new Promise<void>((done) => { release = done })
  const lookup = createBlobIndexLookup(f.root, async (id) => { await gate; return f.source(id) }, { maxPending: 1 })
  assert.equal(await lookup.mightContain(a, ['abc']), null, 'must return without resolving source gate')
  assert.equal(await lookup.mightContain(a, ['abc']), null)
  assert.equal(await lookup.mightContain(b, ['xyz']), null)
  await new Promise<void>((done) => setImmediate(done)); await new Promise<void>((done) => setImmediate(done))
  assert.equal(lookup.stats().pending, 1, 'b 的探测过了、构建名额满了没排候补，只剩 a 在等源')
  assert.equal(f.reads(), 0, '源被闸门挡着，b 也没有去读')
  release(); await lookup.drain()
  assert.equal(await lookup.mightContain(a, ['abc']), true)
  assert.equal(f.reads(), 1); assert.equal(lookup.stats().sharedLoads, 1)
  await build(lookup, b, ['xyz']); assert.equal(await lookup.mightContain(b, ['xyz']), true)
  await lookup.close()
})

test('LRU recency and three independent budgets bound retained indexes', async () => {
  const f = fixture(), a = f.add('aaaa'), b = f.add('bbbb'), c = f.add('cccc')
  const lookup = createBlobIndexLookup(f.root, f.source, { maxRecords: 2 })
  await build(lookup, a, ['aaa']); await build(lookup, b, ['bbb'])
  await lookup.mightContain(a, ['aaa']); await build(lookup, c, ['ccc'])
  assert.equal(lookup.stats().entries, 2); assert.equal(lookup.stats().evictions, 1)
  const before = lookup.stats().diskHits
  await lookup.mightContain(b, ['bbb']); await lookup.drain()
  assert.equal(lookup.stats().diskHits, before + 1)
  for (const options of [{ maxRecords: 0 }, { maxGrams: 0 }, { maxSerializedBytes: 0 }]) {
    const uncached = createBlobIndexLookup(f.root, f.source, options)
    assert.equal(await uncached.mightContain(a, ['aaa']), true)
    assert.equal(uncached.stats().entries, 0); await uncached.close()
  }
  await lookup.close()
})

test('disabled work and invalid limits cause no source or index writes', async () => {
  const f = fixture(), id = f.add('abc')
  const disabled = createBlobIndexLookup(f.root, f.source, { maxPending: 0 })
  assert.equal(await disabled.mightContain(id, ['abc']), null)
  assert.equal(f.reads(), 0); assert.ok(!existsSync(join(f.root, '.fugue')))
  for (const options of [{ maxRecords: -1 }, { maxGrams: NaN }, { maxPending: 17 }, { maxSerializedBytes: Infinity }, { maxBuildMs: 120001 }]) {
    assert.throws(() => createBlobIndexLookup(f.root, f.source, options), /limit/)
  }
  await disabled.close()
})

test('unsafe disk cache stays optional and numeric keys preserve every decoded fragment', async () => {
  const f = fixture(), outside = tmpDir('fugue-index-lookup-outside-')
  symlinkSync(outside, join(f.root, '.fugue'))
  const lookup = createBlobIndexLookup(f.root, f.source)
  for (const bytes of [Buffer.from('😀xy'), Buffer.from([0xff, 0x61, 0x62]), Buffer.from([0, 0, 0])]) {
    const id = idOf(bytes); f.blobs.set(id, bytes)
    const text = bytes.toString('utf8')
    await build(lookup, id, [text.slice(0, 3)])
    for (let i = 0; i + 2 < text.length; i++) assert.equal(await lookup.mightContain(id, [text.slice(i, i + 3)]), true)
  }
  assert.equal(lookup.stats().unsavedBuilds, 3); assert.ok(!existsSync(join(outside, 'idx')))
  await lookup.close()
})

test('source overbudget/failure retries clear pending without partial retained records', async () => {
  const f = fixture(), oversized = new Uint8Array(MAX_SOURCE_BYTES + 1), largeId = idOf(oversized)
  const big = createBlobIndexLookup(f.root, async () => oversized)
  assert.equal(await big.mightContain(largeId, ['abc']), null); await big.drain()
  assert.equal(big.stats().pending, 0); assert.equal(big.stats().entries, 0); assert.equal(big.stats().builds, 0)
  assert.ok(!existsSync(join(f.root, '.fugue')))
  const id = f.add('recovered abc'); let attempts = 0
  const retry = createBlobIndexLookup(f.root, async (blob) => { if (++attempts === 1) throw new Error('temporary'); return f.source(blob) })
  await build(retry, id, ['abc']); assert.equal(retry.stats().entries, 0)
  await build(retry, id, ['abc']); assert.equal(await retry.mightContain(id, ['abc']), true)
  assert.equal(attempts, 2); await Promise.all([big.close(), retry.close()])
})

test('requirements are captured before pending shared disk lookup observes caller mutation', async () => {
  const f = fixture(), id = f.add('abc')
  const producer = createBlobIndexLookup(f.root, f.source); await build(producer, id, ['abc']); await producer.close()
  const reader = createBlobIndexLookup(f.root, f.source), mutable = ['abc']
  const first = reader.mightContain(id, mutable), shared = reader.mightContain(id, mutable)
  mutable[0] = 'zzz'; mutable.push('yyy')
  assert.deepEqual(await Promise.all([first, shared]), [true, true])
  assert.equal(f.reads(), 1); await reader.close()
})

test('close aborts source, resolves draining, is idempotent, and forbids late writes', async () => {
  const f = fixture(), id = f.add('abc')
  let release: () => void = () => {}, started: () => void = () => {}
  const gate = new Promise<void>((done) => { release = done }), begun = new Promise<void>((done) => { started = done })
  let signal: AbortSignal | undefined
  const lookup = createBlobIndexLookup(f.root, async (blob, abort) => { signal = abort; started(); await gate; return f.source(blob) })
  assert.equal(await lookup.mightContain(id, ['abc']), null); await begun
  await Promise.all([lookup.close(), lookup.close()]); await lookup.drain()
  assert.ok(signal?.aborted); assert.equal(lookup.stats().pending, 0)
  release(); await new Promise<void>((done) => setImmediate(done))
  assert.ok(!existsSync(join(f.root, '.fugue')))
  assert.equal(await lookup.mightContain(id, ['abc']), null)
})

test('deadline retires uncooperative source without waiting for it', async (t) => {
  const f = fixture(), id = f.add('abc')
  let started: () => void = () => {}
  const begun = new Promise<void>((done) => { started = done })
  const lookup = createBlobIndexLookup(f.root, async () => { started(); return new Promise<Uint8Array>(() => {}) }, { maxBuildMs: 20 })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  assert.equal(await lookup.mightContain(id, ['abc']), null); await begun
  t.mock.timers.tick(20); await lookup.drain()
  assert.equal(lookup.stats().pending, 0); assert.equal(lookup.stats().entries, 0)
  await lookup.close()
})

test('external abort cancels accepted work and closed handles stay scan-only', async () => {
  const f = fixture(), id = f.add('abc'), abort = new AbortController()
  const lookup = createBlobIndexLookup(f.root, f.source, { signal: abort.signal })
  abort.abort(); await lookup.close()
  assert.equal(await lookup.mightContain(id, ['abc']), null)
  assert.equal(f.reads(), 0); assert.equal(lookup.stats().pending, 0)
})


test('worker source snapshots copy only pooled/subarray windows and preserve caller buffers', async () => {
  const f = fixture()
  for (const borrowed of [Buffer.from('pooled abc'), Buffer.alloc(1024 * 1024, 0xff).subarray(123, 127)]) {
    const before = Buffer.from(borrowed)
    const owned = copyIndexSource(borrowed)
    assert.ok(owned)
    assert.equal(owned.buffer.byteLength, borrowed.byteLength)
    assert.equal(owned.byteOffset, 0)
    assert.deepEqual(Buffer.from(owned), before)
    assert.notEqual(owned.buffer, borrowed.buffer)
    const id = idOf(borrowed); f.blobs.set(id, borrowed)
    const lookup = createBlobIndexLookup(f.root, f.source)
    const text = borrowed.toString('utf8'), gram = text.slice(0, 3)
    await build(lookup, id, [gram])
    assert.equal(await lookup.mightContain(id, [gram]), true)
    assert.deepEqual(Buffer.from(borrowed), before, 'transfer must not detach/mutate caller data')
    await lookup.close()
  }
})

test('close terminates an active owned worker and retires its lifecycle', async () => {
  const f = fixture(), bytes = Buffer.from('worker active source abc\n'.repeat(200000)), id = idOf(bytes)
  f.blobs.set(id, bytes)
  const lookup = createBlobIndexLookup(f.root, f.source)
  assert.equal(await lookup.mightContain(id, ['abc']), null)
  while (lookup.stats().pending > 0 && lookup.stats().workers === 0) await new Promise<void>((done) => setImmediate(done))
  assert.equal(lookup.stats().workers, 1)
  await lookup.close(); await lookup.drain()
  assert.equal(lookup.stats().workers, 0); assert.equal(lookup.stats().pending, 0)
  assert.equal(await lookup.mightContain(id, ['abc']), null)
  // 已完成的安全缓存发布可能存在；关闭不是对已发生 IO 的事务回滚。
})

test('only verified build failures are permanent: oversized admission remains retryable', async () => {
  const f = fixture()
  // trigram失败之前已核源地址；接收超大回复时尚未核地址，不能认定永久失败。
  const oversized = new Uint8Array(MAX_SOURCE_BYTES + 1), oversizedId = idOf(oversized)
  const noisy = Array.from(randomBytes(900_000), (byte) => String.fromCharCode(33 + byte % 94)).join('')
  const dense = f.add(noisy)
  const lookup = createBlobIndexLookup(f.root, async (blob) => blob === oversizedId ? oversized : f.source(blob))
  for (let round = 0; round < 3; round++) await build(lookup, dense, ['abc'])
  assert.equal(f.reads(), 1, '已核地址的trigram预算失败只读一次源')
  assert.equal(lookup.stats().sourceReads, 1)
  assert.equal(lookup.stats().unindexable, 1)
  for (let round = 0; round < 3; round++) await build(lookup, oversizedId, ['abc'])
  assert.equal(lookup.stats().sourceReads, 4, '未核身份的接收拒绝保持可重试')
  assert.equal(lookup.stats().builds, 0)
  assert.equal(lookup.stats().unindexable, 1, '超大回复不能增添永久负事实')
  // 暂时故障不记：同一份字节读一次失败、第二次成功，仍然建得出来。
  const id = f.add('transient abc'); let attempts = 0
  const flaky = createBlobIndexLookup(f.root, async (blob) => { if (++attempts === 1) throw new Error('temporary'); return f.source(blob) })
  await build(flaky, id, ['abc']); await build(flaky, id, ['abc'])
  assert.equal(await flaky.mightContain(id, ['abc']), true)
  assert.equal(flaky.stats().unindexable, 0)
  await Promise.all([lookup.close(), flaky.close()])})

test('concurrent queries for blobs that already have a disk record are not gated by the background-build quota', async () => {
  const f = fixture(), ids = Array.from({ length: 16 }, (_, at) => f.add(`record ${at} abc`))
  const writer = createBlobIndexLookup(f.root, f.source)
  for (const id of ids) await build(writer, id, ['abc'])
  await writer.close()
  const reads = f.reads()
  // 全新的句柄：内存里什么都没有，16 个（探测上限；构建名额只有 4）查询同时到，记录都已经在盘上。
  const lookup = createBlobIndexLookup(f.root, f.source)
  const answers = await Promise.all(ids.map((id) => lookup.mightContain(id, ['abc'])))
  assert.deepEqual(answers, ids.map(() => true), '盘上已有的记录不该因为"后台构建名额只有 4 个"而退回扫描')
  assert.equal(f.reads(), reads, '纯磁盘命中不读源')
  assert.equal(lookup.stats().diskHits, 16)
  await lookup.close()
})
