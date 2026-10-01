import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { createBlobIndexStore, settleShard } from './index-store.ts'
import { buildBlobIndex, encodeBlobIndex, MAX_INDEX_BYTES } from './index-format.ts'

function idOf(bytes: Uint8Array): string { return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex') }
function pathOf(root: string, id: string): string { return join(root, '.fugue', 'idx', 'v1', id.slice(0, 2), `${id}.json`) }

test('missing disk index is observational and rebuilding roundtrips a private derived record', async () => {
  const root = tmpDir('fugue-index-store-')
  const bytes = Buffer.from('cache me\n')
  const id = idOf(bytes)
  const store = createBlobIndexStore(root)
  assert.equal(await store.read(id), null)
  assert.deepEqual(readdirSync(root), [])
  const result = await store.rebuild(id, bytes)
  assert.equal(result.stored, true)
  assert.deepEqual(await store.read(id), buildBlobIndex(id, bytes))
  assert.equal(lstatSync(pathOf(root, id)).mode & 0o777, 0o600)
  assert.equal(lstatSync(join(root, '.fugue/idx')).mode & 0o777, 0o700)
  assert.deepEqual(readdirSync(join(root, '.fugue/idx/v1', id.slice(0, 2))), [`${id}.json`])
})

test('a corrupt derived shard becomes a miss and trusted rebuilding restores the same index', async () => {
  const root = tmpDir('fugue-index-repair-')
  const bytes = Buffer.from('immutable blob abcabc')
  const id = idOf(bytes)
  const store = createBlobIndexStore(root)
  const original = await store.rebuild(id, bytes)
  assert.ok(original.stored)
  const path = pathOf(root, id)
  writeFileSync(path, '{"truncated":')
  const bad = readFileSync(path)
  assert.equal(await store.read(id), null)
  assert.deepEqual(readFileSync(path), bad, 'reads do not mutate corrupt records')
  const repaired = await store.rebuild(id, bytes)
  assert.equal(repaired.stored, true)
  assert.deepEqual(repaired.index, original.index)
  assert.deepEqual(await store.read(id), original.index)
})

test('symlink and hardlink cache leaves are refused without changing outside data', async () => {
  for (const hardlink of [false, true]) {
    const root = tmpDir('fugue-index-unsafe-leaf-')
    const outside = tmpDir('fugue-index-outside-')
    const bytes = Buffer.from('trusted bytes')
    const id = idOf(bytes)
    const path = pathOf(root, id)
    mkdirSync(join(root, '.fugue/idx/v1', id.slice(0, 2)), { recursive: true, mode: 0o700 })
    const target = join(outside, 'private')
    const outsideBytes = encodeBlobIndex(buildBlobIndex(id, bytes))
    writeFileSync(target, outsideBytes)
    if (hardlink) linkSync(target, path)
    else symlinkSync(target, path)
    const store = createBlobIndexStore(root)
    assert.equal(await store.read(id), null)
    const rebuilt = await store.rebuild(id, bytes)
    assert.ok(rebuilt.index, 'safe in-memory build remains usable')
    assert.equal(rebuilt.stored, false)
    assert.deepEqual(readFileSync(target), Buffer.from(outsideBytes))
    assert.equal(hardlink ? lstatSync(path).nlink : lstatSync(path).isSymbolicLink(), hardlink ? 2 : true)
  }
})

test('symlink/shared-writable directories cannot redirect persisted index writes', async () => {
  for (const link of [false, true]) {
    const root = tmpDir('fugue-index-unsafe-dir-')
    const outside = tmpDir('fugue-index-external-dir-')
    const control = join(root, '.fugue')
    if (link) symlinkSync(outside, control)
    else { mkdirSync(control, { mode: 0o700 }); chmodSync(control, 0o777) }
    const bytes = Buffer.from('safe')
    const store = createBlobIndexStore(root)
    assert.equal(await store.read(idOf(bytes)), null)
    assert.equal((await store.rebuild(idOf(bytes), bytes)).stored, false)
    assert.deepEqual(readdirSync(outside), [])
    if (link) assert.ok(lstatSync(control).isSymbolicLink())
    else assert.equal(lstatSync(control).mode & 0o777, 0o777)
    // 整盘缺席要留下痕迹，调用方才能把它和「这一条还没建」分开。
    assert.equal(store.stats().directoryRefusals, 2)
  }
})

test('group-writable roots and control directories still persist private index records', async () => {
  // umask 002 下 `mkdir repo` 得到 0775，config/log 建出来的 .fugue 也是 0775。
  // 这些层不是本模块创建的，拒组可写等于在同组工作区上永久关掉整个磁盘索引。
  const root = tmpDir('fugue-index-umask-')
  chmodSync(root, 0o775)
  mkdirSync(join(root, '.fugue'), { recursive: true })
  chmodSync(join(root, '.fugue'), 0o775)
  const bytes = Buffer.from('umask 002 source')
  const id = idOf(bytes)
  const store = createBlobIndexStore(root)
  assert.equal(await store.read(id), null)
  assert.equal((await store.rebuild(id, bytes)).stored, true)
  assert.deepEqual(await store.read(id), buildBlobIndex(id, bytes))
  assert.equal(store.stats().directoryRefusals, 0)
  // 本模块自己建的那三层与记录仍然严格私有，不跟着根的宽权限走。
  for (const level of ['.fugue/idx', '.fugue/idx/v1', join('.fugue/idx/v1', id.slice(0, 2))]) {
    assert.equal(lstatSync(join(root, level)).mode & 0o777, 0o700, level)
  }
  assert.equal(lstatSync(pathOf(root, id)).mode & 0o777, 0o600)
  assert.equal(lstatSync(join(root, '.fugue')).mode & 0o777, 0o775, '不改既有控制目录的权限')
})

test('an index namespace that lost its private mode is refused instead of silently reused', async () => {
  const root = tmpDir('fugue-index-widened-')
  const bytes = Buffer.from('widened namespace')
  const id = idOf(bytes)
  assert.equal((await createBlobIndexStore(root).rebuild(id, bytes)).stored, true)
  chmodSync(join(root, '.fugue/idx'), 0o770)
  const store = createBlobIndexStore(root)
  assert.equal(await store.read(id), null)
  assert.equal((await store.rebuild(id, bytes)).stored, false)
  assert.equal(store.stats().directoryRefusals, 2)
  assert.equal(lstatSync(join(root, '.fugue/idx')).mode & 0o777, 0o770, '不自动改既有权限')
})

test('a failing handle close keeps the completed outcome and never replaces the original error', async () => {
  // 描述符锚是 Linux 专有，但「关句柄失败怎么结算」与它无关：直接对结算那一步下判据。
  function closer(fail: boolean): { closes: number; close(): Promise<void> } {
    return { closes: 0, async close() { this.closes++; if (fail) throw Object.assign(new Error('simulated close failure'), { code: 'EIO' }) } }
  }
  const notes = { directoryRefusals: 0, closeFailures: 0 }
  const handles = [closer(true), closer(false), closer(true)]
  // rename 与 fsync 都已经成功：回收描述符失败只记一笔，不能把发布退成 stored:false。
  assert.equal(await settleShard({ outcome: 'published', failed: false, refused: false }, handles, notes), 'published')
  assert.deepEqual(handles.map((handle) => handle.closes), [1, 1, 1], '每个句柄都关一次，前一个失败不能让后面漏关')
  assert.deepEqual(notes, { directoryRefusals: 0, closeFailures: 2 })
  // run 自己的错因优先，不被关句柄的异常顶掉——否则排障拿到的是完全无关的异常。
  const original = new Error('refuse unsafe existing index leaf')
  await assert.rejects(() => settleShard({ failure: original, failed: true, refused: false }, [closer(true)], notes),
    (error: unknown) => error === original)
  assert.deepEqual(notes, { directoryRefusals: 0, closeFailures: 3 })
  await assert.rejects(() => settleShard({ failure: original, failed: true, refused: true }, [], notes),
    (error: unknown) => error === original)
  assert.deepEqual(notes, { directoryRefusals: 1, closeFailures: 3 })
})

test('wrong identity, malformed IDs and read failures never create derived data', async () => {
  const root = tmpDir('fugue-index-no-write-')
  const store = createBlobIndexStore(root)
  assert.deepEqual(await store.rebuild('a'.repeat(40), Buffer.from('wrong bytes')), { index: null, stored: false })
  assert.equal(await store.read('../outside'), null)
  assert.equal(await store.read('HEAD'), null)
  assert.deepEqual(readdirSync(root), [])
  assert.equal(await createBlobIndexStore(join(root, 'missing')).read('a'.repeat(40)), null)
  assert.ok(!existsSync(join(root, 'missing')))
})


test('oversized owned corrupt records are bounded read misses and can still be replaced safely', async () => {
  const root = tmpDir('fugue-index-oversized-')
  const bytes = Buffer.from('valid source')
  const id = idOf(bytes)
  const store = createBlobIndexStore(root)
  assert.ok((await store.rebuild(id, bytes)).stored)
  writeFileSync(pathOf(root, id), Buffer.alloc(MAX_INDEX_BYTES + 1))
  assert.equal(await store.read(id), null)
  assert.equal((await store.rebuild(id, bytes)).stored, true)
  assert.deepEqual(await store.read(id), buildBlobIndex(id, bytes))
})

test('concurrent replacements publish only complete records and clean their unique temporaries', async () => {
  const root = tmpDir('fugue-index-concurrent-')
  const bytes = Buffer.from('same immutable source')
  const id = idOf(bytes)
  const store = createBlobIndexStore(root)
  const expected = buildBlobIndex(id, bytes)
  assert.ok((await store.rebuild(id, bytes)).stored)
  const writes = Array.from({ length: 12 }, () => store.rebuild(id, bytes))
  const reads = Array.from({ length: 24 }, async () => {
    const index = await store.read(id)
    if (index !== null) assert.deepEqual(index, expected)
  })
  for (const result of await Promise.all(writes)) assert.ok(result.stored)
  await Promise.all(reads)
  assert.deepEqual(await store.read(id), expected)
  assert.deepEqual(readdirSync(join(root, '.fugue/idx/v1', id.slice(0, 2))), [`${id}.json`])
})


test('relative workspace root is resolved once before later cwd changes', async () => {
  const selected = tmpDir('fugue-index-selected-root-')
  const later = tmpDir('fugue-index-later-root-')
  mkdirSync(join(selected, 'repo'), { mode: 0o700 })
  mkdirSync(join(later, 'repo'), { mode: 0o700 })
  const previous = process.cwd()
  const bytes = Buffer.from('fixed destination')
  const id = idOf(bytes)
  try {
    process.chdir(selected)
    const store = createBlobIndexStore('repo')
    process.chdir(later)
    assert.ok((await store.rebuild(id, bytes)).stored)
    assert.ok(existsSync(pathOf(join(selected, 'repo'), id)))
    assert.ok(!existsSync(join(later, 'repo', '.fugue')))
    assert.deepEqual(await store.read(id), buildBlobIndex(id, bytes))
  } finally { process.chdir(previous) }
})

test('idx, version and shard directories reject aliases to valid outside records', async () => {
  const bytes = Buffer.from('no intermediate alias')
  const id = idOf(bytes)
  const encoded = encodeBlobIndex(buildBlobIndex(id, bytes))
  const segments = ['.fugue', 'idx', 'v1', id.slice(0, 2)]
  for (let level = 1; level < segments.length; level++) {
    const root = tmpDir('fugue-index-intermediate-')
    const outside = tmpDir('fugue-index-intermediate-outside-')
    mkdirSync(join(root, ...segments.slice(0, level)), { recursive: true, mode: 0o700 })
    const leaf = join(outside, ...segments.slice(level + 1), `${id}.json`)
    mkdirSync(dirname(leaf), { recursive: true, mode: 0o700 })
    writeFileSync(leaf, encoded, { mode: 0o600 })
    symlinkSync(outside, join(root, ...segments.slice(0, level + 1)))
    const store = createBlobIndexStore(root)
    assert.equal(await store.read(id), null)
    assert.equal((await store.rebuild(id, bytes)).stored, false)
    assert.deepEqual(readFileSync(leaf), Buffer.from(encoded))
  }
})


test('exclusive temporary collision never deletes another operation file', async () => {
  const root = tmpDir('fugue-index-temp-collision-'), bytes = Buffer.from('abc'), id = idOf(bytes)
  const directory = join(root, '.fugue/idx/v1', id.slice(0, 2))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const nonce = 'a'.repeat(24), temporary = join(directory, `.tmp-${process.pid}-${nonce}`)
  writeFileSync(temporary, 'another operation', { mode: 0o600 })
  const result = await createBlobIndexStore(root).rebuild(id, bytes, nonce)
  assert.equal(result.stored, false)
  assert.equal(readFileSync(temporary, 'utf8'), 'another operation')
  assert.ok(!existsSync(pathOf(root, id)))
})

test('temporaries orphaned by a killed process are swept, in-flight ones are left alone', async () => {
  const root = tmpDir('fugue-index-temp-sweep-'), bytes = Buffer.from('sweep source'), id = idOf(bytes)
  const directory = join(root, '.fugue/idx/v1', id.slice(0, 2))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  // 被杀的进程留下的：pid 不再匹配、nonce 已经随进程消失，没有任何调用能认领它。
  const orphan = join(directory, `.tmp-999999-${'b'.repeat(24)}`)
  // 另一个**正在**写的操作：同样不属于本进程，但还新鲜，一个字节都不能动。
  const inFlight = join(directory, `.tmp-999998-${'c'.repeat(24)}`)
  // 同 pid 但够老的也算无主——本进程里没有任何任务还会回来认它。
  const ownStale = join(directory, `.tmp-${process.pid}-${'d'.repeat(24)}`)
  // 不是临时对象的叶不在扫描面上。
  const foreign = join(directory, 'keep-me')
  for (const path of [orphan, inFlight, ownStale, foreign]) writeFileSync(path, 'leftover', { mode: 0o600 })
  for (const path of [orphan, ownStale, foreign]) utimesSync(path, 0, 0)
  const store = createBlobIndexStore(root)
  assert.equal((await store.rebuild(id, bytes)).stored, true, '收孤儿不能是发布成功的前提')
  assert.equal(store.stats().sweptTemporaries, 2)
  assert.ok(!existsSync(orphan), '过期的无主临时对象要被收走')
  assert.ok(!existsSync(ownStale), '同 pid 的过期临时对象同样无主')
  assert.equal(readFileSync(inFlight, 'utf8'), 'leftover', '新鲜的并发临时对象不能动')
  assert.equal(readFileSync(foreign, 'utf8'), 'leftover', '只扫 .tmp- 前缀')
  assert.deepEqual(await store.read(id), buildBlobIndex(id, bytes))
  assert.deepEqual(readdirSync(directory).sort(), ['.tmp-999998-' + 'c'.repeat(24), `${id}.json`, 'keep-me'])
})
