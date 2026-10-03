import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readdir, readlink, utimes, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBlobIndexStore, settleShard } from './index-store.ts'
function idOf(b: Buffer) { return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex') }

test('external sweep retains a live writer temporary older than the age threshold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fugue-live-review-'))
  let live: Awaited<ReturnType<typeof open>> | undefined
  try {
    const bytes = Buffer.from('live writer source')
    const id = idOf(bytes)
    const store = createBlobIndexStore(root)
    assert.equal((await store.rebuild(id, bytes)).stored, true)
    const dir = join(root, '.fugue/idx/v1', id.slice(0, 2))
    const name = `.tmp-${process.pid}-${'a'.repeat(24)}`
    const path = join(dir, name)
    live = await open(path, 'wx', 0o600)
    await live.writeFile(Buffer.from('live incomplete write'))
    const older = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(path, older, older)
    assert.equal((await store.rebuild(id, bytes)).stored, true)
    assert.ok((await readdir(dir)).includes(name), 'an open live writer must not lose its namespace entry')
  } finally { await live?.close(); await rm(root, {recursive:true,force:true}) }
})

test('settleShard observes all cleanup handles even when a close throws synchronously', async () => {
  const calls: number[] = []
  const notes = { directoryRefusals:0, closeFailures:0, sweptTemporaries:0 }
  const result = await settleShard({ outcome:'completed', failed:false, refused:false }, [
    { close() { calls.push(1); throw new Error('sync close') } },
    { async close() { calls.push(2) } },
  ], notes)
  assert.equal(result, 'completed')
  assert.deepEqual(calls, [1,2])
  assert.equal(notes.closeFailures, 1)
})

test('external root permission relaxation still rejects unsafe owned namespaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fugue-mode-review-'))
  try {
    const bytes = Buffer.from('private record')
    const id = idOf(bytes)
    const store = createBlobIndexStore(root)
    await chmod(root, 0o775)
    assert.equal((await store.rebuild(id, bytes)).stored, true)
    await chmod(join(root, '.fugue'), 0o775)
    assert.ok(await store.read(id))
    await chmod(join(root, '.fugue/idx'), 0o750)
    assert.equal(await store.read(id), null)
    await chmod(join(root, '.fugue/idx'), 0o700)
    await chmod(root, 0o777)
    assert.equal(await store.read(id), null)
  } finally { await rm(root, {recursive:true,force:true}) }
})

test('settleShard waits all closes and preserves the original failure after sync and async close failures', async () => {
  const original = new Error('operation failed')
  const calls: string[] = []
  const notes = { directoryRefusals: 0, closeFailures: 0, sweptTemporaries: 0 }
  let release: () => void = () => {}
  const gate = new Promise<void>(done => { release = done })
  let finished = false
  const result = settleShard({ failure: original, failed: true, refused: true }, [
    { close() { calls.push('sync'); throw new Error('sync close') } },
    { async close() { calls.push('held'); await gate; calls.push('completed') } },
    { async close() { calls.push('async'); throw new Error('async close') } },
  ], notes).then(() => { throw new Error('expected original rejection') }, error => { finished = true; assert.equal(error, original) })
  await new Promise<void>(done => setImmediate(done))
  assert.equal(finished, false)
  assert.deepEqual(calls, ['sync', 'held', 'async'])
  release(); await result
  assert.deepEqual(calls, ['sync', 'held', 'async', 'completed'])
  assert.deepEqual(notes, { directoryRefusals: 1, closeFailures: 2, sweptTemporaries: 0 })
})


test('an actual paused rebuild remains publishable after another writer publishes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fugue-live-publisher-'))
  const seed = await open(join(root, 'seed'), 'wx')
  const prototype = Object.getPrototypeOf(seed), original = prototype.writeFile
  await seed.close()
  let release: () => void = () => {}
  let entered: (path: string) => void = () => {}
  const gate = new Promise<void>(done => { release = done })
  const atTemporary = new Promise<string>(done => { entered = done })
  let intercepted = false
  prototype.writeFile = async function (...args: unknown[]) {
    const path = await readlink(`/proc/self/fd/${this.fd}`)
    const result = await original.apply(this, args)
    if (!intercepted && path.includes('/.tmp-')) {
      intercepted = true; entered(path); await gate
    }
    return result
  }
  let first: ReturnType<ReturnType<typeof createBlobIndexStore>['rebuild']> | undefined
  try {
    const bytes = Buffer.from('actual paused producer'), store = createBlobIndexStore(root)
    first = store.rebuild(idOf(bytes), bytes)
    const path = await atTemporary
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(path, old, old)
    assert.equal((await store.rebuild(idOf(bytes), bytes)).stored, true)
    release()
    assert.equal((await first).stored, true, 'another publish must not delete a paused rebuild temporary')
  } finally {
    release()
    try { await first }
    finally { prototype.writeFile = original; await rm(root, { recursive: true, force: true }) }
  }
})
