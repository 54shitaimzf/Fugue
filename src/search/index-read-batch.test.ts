// 只分享本批的受控祖先；原叶检查、整批 epoch 回退与 fd 收尾都要可被打红。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { chmodSync, linkSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { createBlobIndexStore, MAX_INDEX_BATCH_BYTES, MAX_INDEX_BATCH_GRAMS } from './index-store.ts'
import { encodeBlobIndex } from './index-format.ts'
import type { BlobIndex } from './index-format.ts'
import type { BlobId } from '../terms.ts'
import type { FileHandle } from 'node:fs/promises'

function idOf(bytes: Uint8Array): BlobId { return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') as BlobId }
function pathOf(root: string, id: string): string { return join(root, '.fugue/idx/v1', id.slice(0, 2), `${id}.json`) }
async function fixture() {
  const root = tmpDir('fugue-index-batch-')
  const store = createBlobIndexStore(root)
  const ids: BlobId[] = []
  for (const text of ['first abc needle', 'second é界😀 needle']) {
    const bytes = Buffer.from(text), id = idOf(bytes)
    assert.equal((await store.rebuild(id, bytes)).stored, true)
    ids.push(id)
  }
  return { root, store, ids }
}
async function hooked<T>(hook: (file: FileHandle, path: string) => void, run: () => Promise<T>): Promise<T> {
  const original = fs.open
  fs.open = async (...args) => {
    const file = await original(...args)
    hook(file, String(args[0]))
    return file
  }
  syncBuiltinESMExports()
  try { return await run() }
  finally { fs.open = original; syncBuiltinESMExports() }
}

// 文件内测试串行；每个 hook 只在自己的 try/finally 存活。
test('batch preserves order, duplicate identities and per-record misses without creating data', async () => {
  const f = await fixture()
  const original = [...f.ids]
  const ids = [original[1], original[0], 'a'.repeat(40) as BlobId, original[1]]
  const pending = f.store.readBatch(ids)
  ids.length = 0
  assert.deepEqual(await pending, [await f.store.read(original[1]), await f.store.read(original[0]), null, await f.store.read(original[1])])
  writeFileSync(pathOf(f.root, original[0]), '{"torn":')
  assert.deepEqual(await f.store.readBatch(original), [null, await f.store.read(original[1])])
})

test('empty, sparse, invalid and overbudget identities perform no filesystem work', async () => {
  const root = tmpDir('fugue-index-batch-empty-'), store = createBlobIndexStore(root)
  let opens = 0
  await hooked(() => { opens++ }, async () => {
    assert.deepEqual(await store.readBatch([]), [])
    for (const ids of [new Array<BlobId>(1), ['../outside' as BlobId], [Buffer.from('a'.repeat(40)) as unknown as BlobId], Array(129).fill('a'.repeat(40) as BlobId)]) {
      assert.equal(await store.readBatch(ids), null)
    }
  })
  assert.equal(opens, 0)
})

test('custom iterator admission cannot expand a bounded array into extra filesystem work', async () => {
  const root = tmpDir('fugue-index-batch-iterator-'), store = createBlobIndexStore(root)
  const ids = new Array<BlobId>(1)
  let iteratorCalls = 0
  ids[Symbol.iterator] = function* () { iteratorCalls++; for (let at = 0; at < 129; at++) yield 'a'.repeat(40) as BlobId }
  let opens = 0
  await hooked(() => { opens++ }, async () => {
    assert.equal(await store.readBatch(ids), null)
  })
  assert.equal(iteratorCalls, 0)
  assert.equal(opens, 0)
  const f = await fixture()
  const dense = [f.ids[0]]
  dense[Symbol.iterator] = function* () { iteratorCalls++; for (let at = 0; at < 129; at++) yield f.ids[0] }
  assert.deepEqual(await f.store.readBatch(dense), [await f.store.read(f.ids[0])])
  assert.equal(iteratorCalls, 0)
  const exact = Array(128).fill(f.ids[0])
  assert.equal((await f.store.readBatch(exact))?.length, 128)
  assert.equal(await f.store.readBatch([...exact, f.ids[0]]), null)
})

test('shared ancestors and each shard/leaf keep no-follow, ownership and single-link guards', async () => {
  for (const shared of ['.fugue', '.fugue/idx', '.fugue/idx/v1']) {
    const f = await fixture(), target = join(f.root, shared)
    renameSync(target, `${target}-original`)
    symlinkSync(`${target}-original`, target)
    assert.equal(await f.store.readBatch(f.ids), null)
  }
  for (const shared of ['shard', 'leaf-mode']) {
    const f = await fixture(), file = pathOf(f.root, f.ids[0])
    if (shared === 'shard') {
      const shard = dirname(file)
      renameSync(shard, `${shard}-original`)
      symlinkSync(`${shard}-original`, shard)
    } else chmodSync(file, 0o666)
    assert.deepEqual(await f.store.readBatch(f.ids), [null, await f.store.read(f.ids[1])])
  }
  for (const hardlink of [false, true]) {
    const f = await fixture(), file = pathOf(f.root, f.ids[0])
    renameSync(file, `${file}-original`)
    if (hardlink) linkSync(`${file}-original`, file)
    else symlinkSync(`${file}-original`, file)
    assert.deepEqual(await f.store.readBatch(f.ids), [null, await f.store.read(f.ids[1])])
  }
})

test('ancestor replacement or unsafe/restored mode invalidates the entire otherwise-valid batch', async () => {
  for (const action of ['replace', 'mode', 'restore-mode']) {
    const f = await fixture(), control = join(f.root, '.fugue/idx')
    let changed = false
    try {
      const result = await hooked((file, path) => {
        if (!path.endsWith('.json')) return
        const original = file.read.bind(file)
        file.read = async (...args) => {
          if (!changed) {
            changed = true
            if (action === 'replace') { renameSync(control, `${control}-old`); mkdirSync(control, { mode: 0o700 }) }
            else { chmodSync(control, 0o777); if (action === 'restore-mode') chmodSync(control, 0o700) }
          }
          return original(...args)
        }
      }, () => f.store.readBatch(f.ids))
      assert.equal(changed, true)
      assert.equal(result, null, action)
    } finally { if (action !== 'replace') chmodSync(control, 0o700) }
  }
})

test('root name replacement cannot reuse a live descriptor for the old namespace', async () => {
  const f = await fixture(), moved = `${f.root}-moved`
  let changed = false
  try {
    const result = await hooked((file, path) => {
      if (!path.endsWith('.json')) return
      const original = file.read.bind(file)
      file.read = async (...args) => {
        if (!changed) { changed = true; renameSync(f.root, moved); mkdirSync(f.root, { mode: 0o700 }) }
        return original(...args)
      }
    }, () => f.store.readBatch(f.ids))
    assert.equal(changed, true)
    assert.equal(result, null)
  } finally { if (changed) { rmSync(f.root, { recursive: true, force: true }); renameSync(moved, f.root) } }
})

test('shared stat/close rejection fails open and all opened handles are observed closing', async () => {
  for (const failure of ['stat', 'close']) {
    const f = await fixture()
    let opened = 0, closed = 0
    const result = await hooked((file, path) => {
      opened++
      const originalClose = file.close.bind(file)
      file.close = async () => {
        await originalClose(); closed++
        if (path === f.root && failure === 'close') throw new Error('controlled close failure')
      }
      if (path === f.root && failure === 'stat') file.stat = async () => { throw new Error('controlled metadata failure') }
    }, () => f.store.readBatch(f.ids))
    assert.equal(result, null)
    assert.equal(closed, opened)
  }
})

test('leaf read rejection keeps that record unknown and closes it without hiding valid siblings', async () => {
  const f = await fixture()
  let opened = 0, closed = 0
  const result = await hooked((file, path) => {
    opened++
    const originalClose = file.close.bind(file)
    file.close = async () => { await originalClose(); closed++ }
    if (path.endsWith(`${f.ids[0]}.json`)) file.read = async () => { throw new Error('controlled read failure') }
  }, () => f.store.readBatch(f.ids))
  assert.deepEqual(result, [null, await f.store.read(f.ids[1])])
  assert.equal(closed, opened)
})


// canonical 合成表仅测资源预算，不冒充真实 blob 内容/查询等价。
function budgetRecords(root: string, grams: string[], count: number): BlobId[] {
  const ids: BlobId[] = []
  for (let at = 0; at < count; at++) {
    const id = (at + 1).toString(16).padStart(40, '0') as BlobId
    const record: BlobIndex = { format: 'fugue-blob-trigrams', version: 1, blob: id,
      sourceBytes: grams.length + 2, textUnits: grams.length + 2, tables: { trigrams: grams, symbols: null } }
    const path = pathOf(root, id)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, encodeBlobIndex(record), { mode: 0o600 })
    ids.push(id)
  }
  return ids
}

test('a batch cannot retain more than its gram budget even when every record is individually valid', async () => {
  const root = tmpDir('fugue-index-batch-grams-')
  const grams = Array.from({ length: 200_000 }, (_, at) => String.fromCharCode(
    33 + Math.floor(at / (90 * 90)), 33 + Math.floor(at / 90) % 90, 33 + at % 90,
  ))
  const ids = budgetRecords(root, grams, 6)
  const result = await createBlobIndexStore(root).readBatch(ids)
  assert.ok(result)
  assert.equal(result.filter(index => index !== null).length, 5)
  assert.equal(result.reduce((sum, index) => sum + (index?.tables.trigrams.length ?? 0), 0), MAX_INDEX_BATCH_GRAMS)
})

test('raw canonical-byte budget bounds accepted IO, independently of retained grams', async () => {
  const root = tmpDir('fugue-index-batch-bytes-')
  const grams = Array.from({ length: 200_000 }, (_, at) => String.fromCharCode(
    0xd800 + Math.floor(at / (1024 * 1024)), 0xd800 + Math.floor(at / 1024) % 1024, 0xd800 + at % 1024,
  ))
  const ids = budgetRecords(root, grams, 4)
  const store = createBlobIndexStore(root)
  const single = await store.read(ids[0])
  assert.ok(single)
  const size = encodeBlobIndex(single).byteLength
  assert.ok(size * 4 > MAX_INDEX_BATCH_BYTES && size * 3 <= MAX_INDEX_BATCH_BYTES)
  const result = await store.readBatch(ids)
  assert.ok(result)
  assert.equal(result.filter(index => index !== null).length, 3)
})

test('synchronous shared close failure still attempts every other handle before batch fallback', async () => {
  const f = await fixture()
  let opened = 0, attempted = 0, closed = 0
  const held: (() => Promise<void>)[] = []
  try {
    const result = await hooked((file, path) => {
      opened++
      const original = file.close.bind(file)
      file.close = () => {
        attempted++
        if (path === f.root) { held.push(original); throw new Error('controlled synchronous close failure') }
        return original().then(() => { closed++ })
      }
    }, () => f.store.readBatch(f.ids))
    assert.equal(result, null)
    assert.equal(attempted, opened)
    assert.equal(closed + held.length, opened)
  } finally {
    // 故意拒绝关闭的测试口由原方法释放，不让测试自己留下 fd。
    for (const close of held) await close()
  }
})
