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

test('malformed host messages are refused without killing a reusable worker', async () => {
  const root = tmpDir('fugue-worker-badmsg-')
  const pool = createIndexWorkerPool(root, 1, 10000)
  try {
    const worker = pool.acquire(); assert.ok(worker)
    // 一轮只等三件事里最先到的那一件：回执、线程报错、线程退出。坏形状打死了 Worker
    // 也要当场给出判据，不能让这条用例挂在那里等一条永远不会来的消息。
    function round(job: unknown, transfer: readonly ArrayBuffer[] = []): Promise<Record<string, unknown>> {
      return new Promise((done) => {
        const settle = (value: Record<string, unknown>) => {
          worker.removeListener('message', onMessage)
          worker.removeListener('error', onError)
          worker.removeListener('exit', onExit)
          done(value)
        }
        const onMessage = (value: unknown) => settle(value as Record<string, unknown>)
        const onError = (error: Error) => settle({ dead: `error ${error.message}` })
        const onExit = (code: number) => settle({ dead: `exit ${code}` })
        worker.on('message', onMessage); worker.on('error', onError); worker.on('exit', onExit)
        worker.postMessage(job, transfer as ArrayBuffer[])
      })
    }
    const nonce = 'a'.repeat(24)
    const malformed: unknown[] = [null, undefined, 0, 'not a job', {}, { blob: 'x'.repeat(40) },
      { blob: 'x'.repeat(40), bytes: 'not bytes', temporaryId: nonce },
      { blob: 42, bytes: Uint8Array.from([1]), temporaryId: nonce },
      { blob: 'x'.repeat(40), bytes: Uint8Array.from([1]), temporaryId: 7 }]
    for (const bad of malformed) {
      // 参数解构失败产生的是一个没人消费的 rejected promise（EventEmitter 不看返回值），
      // 默认 unhandledRejection 模式下当场打死线程——代价是一个已经预热好的可复用 Worker。
      const refusal = await round(bad)
      assert.equal(refusal.dead, undefined, `坏形状的消息不能打死 Worker：${String(bad)}`)
      assert.equal(refusal.ok, false, String(bad))
    }
    assert.deepEqual(pool.stats(), { starts: 1, retained: 1, idle: 0 })
    // 同一个 Worker 仍然能完成一次真实任务——复用正是这一笔的收益所在。
    const bytes = Uint8Array.from(Buffer.from('still alive abc')), id = blob(bytes)
    const reply = await round({ blob: id, bytes, temporaryId: 'b'.repeat(24) }, [bytes.buffer])
    assert.equal(reply.ok, true)
    assert.equal(reply.temporaryId, 'b'.repeat(24))
    assert.equal(pool.stats().starts, 1, '不该因为坏消息换过 Worker')
  } finally { await pool.close() }
})
