import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { createBlobIndexStore } from './index-store.ts'
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
  }
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
