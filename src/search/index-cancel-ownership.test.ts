import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { cleanupIndexTemporary, createBlobIndexStore } from './index-store.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const data = Buffer.from('needle abc')
const blob = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')

test('name-only cancellation preserves a later active publisher reusing the consumed nonce', async () => {
  const root = tmpDir('fugue-cancel-owner-'), nonce = 'abcdef'.repeat(4)
  const store = createBlobIndexStore(root)
  assert.equal((await store.rebuild(blob, data, nonce)).stored, true)
  const suffix = `/.tmp-${process.pid}-${nonce}`
  const temporary = join(root, '.fugue', 'idx', 'v1', blob.slice(0, 2), suffix.slice(1))
  const entered = deferred(), release = deferred(), originalOpen = fs.open
  fs.open = async function (...args: Parameters<typeof originalOpen>) {
    const file = await originalOpen(...args)
    if (String(args[0]).endsWith(suffix)) {
      const write = file.writeFile.bind(file)
      file.writeFile = (async (...values: Parameters<typeof write>) => {
        entered.resolve()
        await release.promise
        return await write(...values)
      }) as typeof file.writeFile
    }
    return file
  }
  try { syncBuiltinESMExports() }
  catch (error) {
    fs.open = originalOpen
    try { syncBuiltinESMExports() } catch { /* Preserve the original installation error. */ }
    throw error
  }
  const next = store.rebuild(blob, data, nonce)
  try {
    await entered.promise
    assert.equal(existsSync(temporary), true)
    await cleanupIndexTemporary(root, blob, nonce)
    assert.equal(existsSync(temporary), true, 'an old task knows a name, not the new writer inode')
    release.resolve()
    assert.equal((await next).stored, true)
  } finally {
    release.resolve()
    try { await next }
    finally { fs.open = originalOpen; syncBuiltinESMExports() }
  }
  assert.equal(existsSync(temporary), false, 'the successful exclusive creator consumed its own leaf')
  assert.notEqual(await store.read(blob), null)
})

test('known PID and nonce do not authorize deleting an existing safe leaf', async () => {
  const root = tmpDir('fugue-cancel-unknown-'), store = createBlobIndexStore(root)
  assert.equal((await store.rebuild(blob, data)).stored, true)
  const nonce = 'a'.repeat(24)
  const file = join(root, '.fugue', 'idx', 'v1', blob.slice(0, 2), `.tmp-${process.pid}-${nonce}`)
  writeFileSync(file, 'another operation', { mode: 0o600 })
  const before = readFileSync(file)
  await cleanupIndexTemporary(root, blob, nonce)
  assert.deepEqual(readFileSync(file), before)
})

test('nonprimitive IDs and nonces reject before coercion or filesystem admission', async () => {
  const root = tmpDir('fugue-index-no-coercion-'), store = createBlobIndexStore(root)
  let calls = 0
  const id = { toString() { calls++; return blob } } as unknown as string
  const nonce = { toString() { calls++; return 'a'.repeat(24) } } as unknown as string
  assert.equal(await store.read(id), null)
  assert.equal((await store.rebuild(id, data)).stored, false)
  assert.equal((await store.rebuild(blob, data, nonce)).stored, false)
  assert.equal(calls, 0)
  assert.deepEqual(readdirSync(root), [], 'no derived directory created for rejected nonce input')
})
