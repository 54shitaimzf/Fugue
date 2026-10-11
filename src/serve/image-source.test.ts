import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import cp from 'node:child_process'
import wt from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { runCli } from '../../test/helpers/run-cli.ts'
import { openServeSource } from './source.ts'
import { openImageSource } from './image-source.ts'
import { MAX_PNG_BYTES } from '../ui/png.ts'
import { readFileSync } from 'node:fs'
const fixtures = JSON.parse(readFileSync(new URL('../ui/png-fixtures.json', import.meta.url), 'utf8'))
const png = Buffer.from(fixtures.valid.find((c: { name: string }) => c.name === 'color-6-depth-8-filters-0-4').png, 'base64')
const hash = (bytes: Buffer): string => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const request = { agent: 'agent/r1/1', path: 'image;$(anything).png', blob: hash(png) }
async function fixture(program: string) {
  const root = await mkdtemp(join(tmpdir(), 'fugue-image-'))
  const cli = join(root, 'cli.mjs')
  await writeFile(join(root, 'data.png'), png)
  await writeFile(cli, `import fs from 'node:fs';\n${program}`)
  return { root, cli, clean: async () => rm(root, { recursive: true, force: true }) }
}

test('image bytes use existing CLI read arguments; blob pins pixels and decoding yields to input', async () => {
  const f = await fixture(`fs.writeFileSync(process.argv[3]+'/args.json', JSON.stringify(process.argv.slice(2))); process.stdout.write(fs.readFileSync(process.argv[3]+'/data.png'))`)
  const source = openImageSource(f)
  const originalWorker = wt.Worker; const threads: number[] = []; const owned: wt.Worker[] = []
  wt.Worker = class extends originalWorker {
    constructor(...args: ConstructorParameters<typeof originalWorker>) { super(...args); threads.push(this.threadId); owned.push(this) }
  }
  syncBuiltinESMExports()
  try {
    const ready = source.read(request)
    let ticked = false
    await new Promise<void>(done => setImmediate(() => { ticked = true; done() }))
    const image = await ready
    assert.ok(ticked); assert.ok(image)
    assert.equal(threads.length, 1); assert.ok(threads[0]! > 0, 'decode is performed in an owned worker thread')
    assert.equal(owned[0]!.threadId, -1, 'result settles only after its worker exited')
    assert.equal(image.width, 7); assert.equal(image.height, 5)
    assert.deepEqual(Buffer.from(image.rgba), Buffer.from(fixtures.valid.find((c: { name: string }) => c.name === 'color-6-depth-8-filters-0-4').rgba, 'base64'))
    assert.deepEqual(JSON.parse(await readFile(join(f.root, 'args.json'), 'utf8')),
      ['--root', f.root, '--agent', 'agent/r1/1', 'read', 'image;$(anything).png'])
    assert.equal(await source.read({ ...request, blob: '0'.repeat(40) }), null)
    console.log('CLI raw read args exact; 35 pixels differ 0; event-loop tick before result; changed blob →null')
  } finally { wt.Worker = originalWorker; syncBuiltinESMExports(); await source.close(); await f.clean() }
})

test('bad bytes, oversized output, failing read and missing executable preserve text fallback', async () => {
  for (const program of [
    `process.stdout.write('not a PNG')`,
    `process.stdout.write(Buffer.alloc(${MAX_PNG_BYTES + 1}))`,
    `process.exit(7)`,
  ]) {
    const f = await fixture(program); const source = openImageSource(f)
    const badRequest = program.includes('not a PNG') ? { ...request, blob: hash(Buffer.from('not a PNG')) } : request
    try { assert.equal(await source.read(badRequest), null) } finally { await source.close(); await f.clean() }
  }
  const source = openImageSource({ root: '/missing', cli: '/missing/fugue.ts' })
  assert.equal(await source.read(request), null); await source.close()
  console.log('bad/oversized/exit7/missing CLI →null; no protocol bytes reach the terminal')
})


test('deadline, abort and close kill in-flight reads; closed source cannot spawn again', async t => {
  for (const how of ['deadline', 'abort', 'close']) {
    const f = await fixture(`fs.writeFileSync(process.argv[3]+'/pid', String(process.pid)); setInterval(()=>{},1000)`)
    const source = openImageSource({ ...f, timeoutMs: 10000 })
    const ac = new AbortController()
    let kills = 0, pid = 0, finished = false
    const originalSpawn = cp.spawn, children: cp.ChildProcess[] = []
    cp.spawn = ((...args: Parameters<typeof cp.spawn>) => { const child = originalSpawn(...args); children.push(child); return child }) as typeof cp.spawn
    syncBuiltinESMExports()
    const originalKill = cp.ChildProcess.prototype.kill
    cp.ChildProcess.prototype.kill = function (...args) { kills += 1; return originalKill.apply(this, args) }
    if (how === 'deadline') t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const ready = source.read(request, ac.signal).finally(() => { finished = true })
      while (!pid && !finished) {
        try { pid = Number(await readFile(join(f.root, 'pid'), 'utf8')) } catch { await new Promise<void>(done => setImmediate(done)) }
      }
      assert.ok(pid > 0, 'read process reached its ready marker')
      if (how === 'deadline') {
        t.mock.timers.tick(9999); assert.equal(kills, 0)
        t.mock.timers.tick(1); assert.equal(kills, 1, 'deadline triggers only at its boundary')
      }
      if (how === 'abort') { ac.abort(); assert.equal(kills, 1) }
      if (how === 'close') { const closing = source.close(); assert.equal(kills, 1); await closing }
      assert.equal(await ready, null)
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
      await source.close(); await source.close()
      const closedRead = source.read(request)
      assert.equal(children.length, 1, 'after close there is no second child')
      assert.equal(await closedRead, null)
    } finally {
      for (const child of children) child.kill('SIGKILL')
      await source.close(); cp.ChildProcess.prototype.kill = originalKill
      cp.spawn = originalSpawn; syncBuiltinESMExports()
      if (how === 'deadline') t.mock.timers.reset()
      await f.clean()
    }
  }
  console.log('mock deadline 9999ms kill=0 /10000ms kill=1; abort/close kill=1; child alive=0; double-close spawn=0')
})

test('raw output ceiling kills immediately, before any timeout or decode', async () => {
  const original = cp.spawn
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => boolean }
  child.stdout = new EventEmitter(); let kills = 0, spawns = 0
  child.kill = () => { kills += 1; queueMicrotask(() => child.emit('close', null)); return true }
  cp.spawn = (() => { spawns += 1; return child }) as unknown as typeof cp.spawn
  syncBuiltinESMExports()
  const source = openImageSource({ root: '/test' })
  try {
    const ready = source.read(request)
    child.stdout.emit('data', Buffer.alloc(MAX_PNG_BYTES))
    assert.equal(kills, 0)
    child.stdout.emit('data', Buffer.from([0]))
    assert.equal(kills, 1, '8MiB+1 byte triggers kill synchronously, no timeout required')
    assert.equal(await ready, null)
    await source.close()
    const closedRead = source.read(request)
    assert.equal(spawns, 1, 'closed source does not start another child')
    assert.equal(await closedRead, null)
  } finally { child.emit('close', null); await source.close(); cp.spawn = original; syncBuiltinESMExports() }
  console.log('raw stream 8MiB kill=0 /8MiB+1 kill=1; decode jobs=0')
})

test('aborting or closing during decode terminates the owned worker before settling', async () => {
  const original = wt.Worker
  for (const how of ['abort', 'close']) {
    let created = 0, terminated = 0, finished = false
    const workers: EventEmitter[] = []
    wt.Worker = class extends EventEmitter {
      constructor() { super(); created += 1; workers.push(this) }
      terminate() { terminated += 1; queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1) }
    } as unknown as typeof wt.Worker
    syncBuiltinESMExports()
    const f = await fixture(`process.stdout.write(fs.readFileSync(process.argv[3]+'/data.png'))`)
    const source = openImageSource(f), ac = new AbortController()
    try {
      const ready = source.read(request, ac.signal).finally(() => { finished = true })
      while (created === 0 && !finished) await new Promise<void>(done => setImmediate(done))
      assert.equal(created, 1, 'decode worker started')
      if (how === 'abort') ac.abort()
      else { const closing = source.close(); assert.equal(terminated, 1); await closing }
      assert.equal(terminated, 1)
      assert.equal(await ready, null)
      await source.close(); assert.equal(terminated, 1)
    } finally { for (const worker of workers) worker.emit('exit', 1); await source.close(); await f.clean(); wt.Worker = original; syncBuiltinESMExports() }
  }
  console.log('abort/close during decode: worker terminate=1, pending result null; repeated close extra terminate=0')
})


test('real CLI read and event-channel blob agree; later writes cannot impersonate the earlier event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fugue-image-real-'))
  assert.equal(cp.spawnSync('git', ['init', '-q', root]).status, 0)
  const agent = 'agent/r1/1', path = 'preview.png'
  const stdin = { async *[Symbol.asyncIterator]() { yield png } }
  let channel: Awaited<ReturnType<typeof openServeSource>> | undefined
  const images = openImageSource({ root })
  try {
    const wrote = await runCli(['--root', root, '--agent', agent, 'write', path, '--stdin'], stdin)
    assert.equal(wrote.code, 0, wrote.stderr)
    channel = await openServeSource({ root })
    const first = await channel.pass('')
    const e = first.rows.find(r => r.e.t === 'view/write')!.e
    assert.equal(e.t, 'view/write')
    if (e.t !== 'view/write') throw new Error('missing write event')
    assert.equal(e.blob, hash(png))
    const image = await images.read({ agent: e.agent, path: e.path, blob: e.blob })
    assert.ok(image); assert.equal(image.width * image.height, 35)
    const changed = Buffer.from(fixtures.valid.find((c: { name: string }) => c.name === 'color-2-depth-8-filters-0-4').png, 'base64')
    const changedIn = { async *[Symbol.asyncIterator]() { yield changed } }
    const second = await runCli(['--root', root, '--agent', agent, 'write', path, '--stdin'], changedIn)
    assert.equal(second.code, 0, second.stderr)
    assert.equal(await images.read({ agent: e.agent, path: e.path, blob: e.blob }), null)
    const next = await channel.pass(first.resume)
    const newer = next.rows.find(r => r.e.t === 'view/write')!.e
    if (newer.t !== 'view/write') throw new Error('missing newer event')
    assert.ok(await images.read({ agent: newer.agent, path: newer.path, blob: newer.blob }))
    console.log('real CLI write→watch blob→raw read→35 pixels; older event/newer file mismatch→null; newer event→image')
  } finally { await images.close(); await channel?.close(); await rm(root, { recursive: true, force: true }) }
})


test('a missing worker falls back to text and still settles close', async () => {
  const original = wt.Worker
  wt.Worker = class { constructor() { throw new Error('worker unavailable') } } as unknown as typeof wt.Worker
  syncBuiltinESMExports()
  const f = await fixture(`process.stdout.write(fs.readFileSync(process.argv[3]+'/data.png'))`)
  const source = openImageSource(f)
  try { assert.equal(await source.read(request), null); await source.close() }
  finally { await source.close(); await f.clean(); wt.Worker = original; syncBuiltinESMExports() }
  console.log('worker construction failure →null; close completes')
})
