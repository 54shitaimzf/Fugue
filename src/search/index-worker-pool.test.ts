import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { createIndexWorkerPool } from './index-worker-pool.ts'
import { createBlobIndexLookup } from './blob-index.ts'

function blob(bytes: Uint8Array): string { return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex') }

test('sequential background jobs reuse one bounded worker without mixing source identities', async () => {
  const root = tmpDir('fugue-worker-reuse-'), sources = new Map<string, Uint8Array>()
  const lookup = createBlobIndexLookup(root, async (id) => sources.get(id)!, { maxPending: 1 })
  try {
    for (const text of ['abc first', 'xyz second', '😀\u0000 third']) {
      const bytes = Buffer.from(text), id = blob(bytes); sources.set(id, bytes)
      assert.equal(await lookup.mightContain(id, [text.slice(0, 3)]), null)
      await lookup.drain()
      assert.equal(await lookup.mightContain(id, [text.slice(0, 3)]), true)
      assert.equal(await lookup.mightContain(id, ['zzz']), false)
    }
    assert.equal(lookup.stats().workerStarts, 1)
    assert.equal(lookup.stats().retainedWorkers, 1)
    assert.equal(lookup.stats().idleWorkers, 1)
    assert.equal(lookup.stats().workers, 0)
  } finally { await lookup.close() }
  assert.equal(lookup.stats().retainedWorkers, 0)
})

test('pool has no waiting queue and never reuses failed/terminated workers', async () => {
  const pool = createIndexWorkerPool(tmpDir('fugue-worker-bound-'), 1, 10000)
  try {
    const first = pool.acquire(); assert.ok(first)
    assert.equal(pool.acquire(), null)
    await pool.release(first, false)
    const second = pool.acquire(); assert.ok(second)
    assert.notEqual(second, first)
    assert.equal(pool.stats().starts, 2)
    await second.terminate(); await pool.release(second)
    assert.equal(pool.stats().idle, 0)
    assert.equal(pool.stats().retained, 0)
  } finally { await Promise.all([pool.close(), pool.close()]) }
  assert.equal(pool.acquire(), null)
})

test('idle deadline retires the worker and next acquisition creates a fresh one', async (t) => {
  const pool = createIndexWorkerPool(tmpDir('fugue-worker-idle-'), 1, 20)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = pool.acquire(); assert.ok(first)
  await pool.release(first)
  assert.equal(pool.stats().idle, 1)
  t.mock.timers.tick(20)
  await new Promise<void>((done) => first.once('exit', () => done()))
  assert.equal(pool.stats().retained, 0)
  const second = pool.acquire(); assert.ok(second); assert.notEqual(first, second)
  await pool.close()
})

test('unreferenced idle workers do not keep a finished client process alive', () => {
  const root = tmpDir('fugue-worker-exit-')
  const source = `import {createIndexWorkerPool} from ${JSON.stringify(new URL('./index-worker-pool.ts', import.meta.url).href)};
    const pool=createIndexWorkerPool(${JSON.stringify(root)},1,60000);
    const worker=pool.acquire(); await pool.release(worker); console.log(pool.stats().idle);`
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000 })
  assert.equal(output.trim(), '1')
})

test('invalid worker limits are rejected rather than creating unbounded retention', () => {
  const root = tmpDir('fugue-worker-limits-')
  for (const [maximum, idleMs] of [[-1, 20], [17, 20], [Infinity, 20], [1, -1], [1, 60001]]) {
    assert.throws(() => createIndexWorkerPool(root, maximum, idleMs), /invalid index worker/)
  }
})

test('deadline cancellation cannot return its active worker to the reusable pool', async (t) => {
  const root = tmpDir('fugue-worker-cancel-')
  const a = Buffer.from('cancel abc\n'.repeat(100000)), b = Buffer.from('next xyz')
  const sources = new Map([[blob(a), a], [blob(b), b]])
  const lookup = createBlobIndexLookup(root, async id => sources.get(id)!, { maxPending: 1, maxBuildMs: 20 })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    assert.equal(await lookup.mightContain(blob(a), ['abc']), null)
    while (lookup.stats().pending > 0 && lookup.stats().workers === 0) await new Promise<void>(done => setImmediate(done))
    assert.equal(lookup.stats().workers, 1)
    t.mock.timers.tick(20)
    await lookup.drain()
    assert.equal(lookup.stats().retainedWorkers, 0)
    assert.equal(await lookup.mightContain(blob(b), ['xyz']), null)
    await lookup.drain()
    assert.equal(await lookup.mightContain(blob(b), ['xyz']), true)
    assert.equal(lookup.stats().workerStarts, 2)
  } finally { await lookup.close() }
})

test('failed lookup build retires its worker before a later valid source job', async () => {
  const root = tmpDir('fugue-worker-failure-')
  const expected = Buffer.from('failed abc'), valid = Buffer.from('valid xyz')
  const lookup = createBlobIndexLookup(root, async id => id === blob(expected) ? Buffer.from('wrong source') : valid, { maxPending: 1 })
  try {
    assert.equal(await lookup.mightContain(blob(expected), ['abc']), null)
    await lookup.drain()
    assert.equal(lookup.stats().workerStarts, 1)
    assert.equal(lookup.stats().retainedWorkers, 0)
    assert.equal(lookup.stats().entries, 0)
    assert.equal(await lookup.mightContain(blob(valid), ['xyz']), null)
    await lookup.drain()
    assert.equal(await lookup.mightContain(blob(valid), ['xyz']), true)
    assert.equal(await lookup.mightContain(blob(valid), ['abc']), false)
    assert.equal(lookup.stats().workerStarts, 2)
    assert.equal(lookup.stats().retainedWorkers, 1)
  } finally { await lookup.close() }
})

test('pool captures a relative root before method-time cwd changes', async () => {
  const firstRoot = tmpDir('fugue-worker-first-root-'), otherRoot = tmpDir('fugue-worker-other-root-')
  const originalCwd = process.cwd()
  let pool: ReturnType<typeof createIndexWorkerPool> | undefined
  try {
    process.chdir(firstRoot)
    pool = createIndexWorkerPool('.', 1, 10000)
    process.chdir(otherRoot)
    const worker = pool.acquire(); assert.ok(worker)
    const bytes = Uint8Array.from(Buffer.from('root abc')), id = blob(bytes)
    const answer = new Promise<unknown>((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject)
    })
    worker.postMessage({ blob: id, bytes, temporaryId: 'a'.repeat(24) }, [bytes.buffer])
    const reply = await answer as { ok: boolean; stored: boolean }
    assert.ok(reply.ok && reply.stored)
    assert.ok(existsSync(join(firstRoot, '.fugue/idx/v1', id.slice(0, 2), `${id}.json`)))
    assert.ok(!existsSync(join(otherRoot, '.fugue')))
    await pool.release(worker)
  } finally { process.chdir(originalCwd); await pool?.close() }
})
