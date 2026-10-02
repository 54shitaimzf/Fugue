// Owned bytes/labels across asynchronous Lower calls; pure content-addressed fixture, no Git.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { Delta } from '../delta.ts'
import type { EntryMeta } from '../entries.ts'
import type { Log, LogEvent } from '../log/events.ts'
import type { BlobId, CommitId } from '../terms.ts'
import type { Truth } from '../truth/contract.ts'
import type { Lower, ViewSnapshot } from './contract.ts'
import { applyEdit } from './edit.ts'
import { copyBytes } from './owned.ts'
import { loadView } from './view.ts'

const hash = (bytes: Uint8Array): BlobId => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function fixture() {
  const objects = new Map<BlobId, Buffer>()
  const lower: Lower = {
    base: null,
    async putBlob(bytes) { const owned = Buffer.from(bytes), id = hash(owned); objects.set(id, owned); return id },
    async readBlob(id) { const bytes = objects.get(id); if (bytes === undefined) throw new Error('missing fixture blob'); return bytes },
    async stat() { return null }, async read() { return null }, async list() { return [] },
  }
  return { lower, objects }
}
const emptyLog = { async *readByWriter() {} }
const body = (bytes: Uint8Array | null) => bytes === null ? null : Buffer.from(bytes).toString('utf8')
const byteValues = (deltas: Delta[]) => deltas.map(d =>
  d.kind === 'add' || d.kind === 'modify' ? { ...d, bytes: new Uint8Array(d.bytes) } : d)

test('owned copies and View reads retain Buffer/plain constructors with independent visible windows', async () => {
  for (const backing of [Buffer.from('xxfirstyy'), Uint8Array.from(Buffer.from('xxfirstyy'))]) {
    const input = backing.subarray(2, 7), owned = copyBytes(input)
    const expectedConstructor = Buffer.isBuffer(input) ? Buffer : Uint8Array
    assert.equal(owned.constructor, expectedConstructor)
    assert.notEqual(owned.buffer, input.buffer)
    assert.equal(owned.byteLength, 5); assert.equal(owned.buffer.byteLength, 5)
    const f = fixture(), view = await loadView(emptyLog, 'round', { lower: f.lower })
    await view.write('a', input)
    input.fill(120)
    assert.equal(body(owned), 'first')
    const read = (await view.read('a'))!, delta = view.diff()[0]
    assert.equal(read.constructor, expectedConstructor)
    assert.equal(delta.kind, 'add')
    if (delta.kind !== 'add') assert.fail('expected add')
    assert.equal(delta.bytes.constructor, expectedConstructor)
    new Uint8Array(read.buffer).fill(121); new Uint8Array(delta.bytes.buffer).fill(122)
    assert.equal(body(await view.read('a')), 'first')
    assert.equal(body((view.diff()[0] as Extract<Delta, { kind: 'add' }>).bytes), 'first')
    assert.equal((await view.stat('a'))!.id, hash(Buffer.from('first')))
  }
})

test('Buffer/Uint8Array caller mutation during put keeps Entry, blob and recorded delta identical', { timeout: 10_000 }, async () => {
  for (const input of [Buffer.from('first'), Uint8Array.from(Buffer.from('first'))]) {
    const f = fixture(), gate = deferred(), entered = deferred(), put = f.lower.putBlob
    f.lower.putBlob = async bytes => { entered.release(); await gate.promise; return put(bytes) }
    const view = await loadView(emptyLog, 'round', { lower: f.lower })
    const pending = view.write('a', input)
    try {
      await Promise.race([entered.promise, pending.then(() => { assert.fail('write completed without reaching putBlob') })])
      input.set(Buffer.from('other')); gate.release(); await pending
      const meta = (await view.stat('a'))!
      assert.equal(body(await view.read('a')), 'first')
      assert.equal(body(await f.lower.readBlob(meta.id)), 'first')
      assert.equal(body((view.diff()[0] as Extract<Delta, { kind: 'add' }>).bytes), 'first')
      assert.equal(meta.id, hash(Buffer.from('first')))
    } finally { gate.release(); await pending.catch(() => {}) }
  }
})

test('applyDelta owns all input bytes and primitive labels before the first await', { timeout: 10_000 }, async () => {
  const f = fixture(), gate = deferred(), entered = deferred(), put = f.lower.putBlob
  let calls = 0
  f.lower.putBlob = async bytes => { if (++calls === 1) { entered.release(); await gate.promise } return put(bytes) }
  const view = await loadView(emptyLog, 'round', { lower: f.lower })
  const a = { kind: 'add', path: 'a', bytes: Buffer.from('first'), mode: 0o100644 } as const
  const b = { kind: 'add', path: 'b', bytes: Uint8Array.from(Buffer.from('second')), mode: 0o100644 } as const
  const deltas: Delta[] = [a, b]
  const pending = view.applyDelta(deltas)
  try {
    await Promise.race([entered.promise, pending.then(() => { assert.fail('apply completed before putBlob') })])
    Object.assign(a, { path: 'wrong-a', mode: 0o100755 }); a.bytes.fill(120)
    Object.assign(b, { path: 'wrong-b', mode: 0o100755 }); b.bytes.fill(120)
    deltas.length = 0; gate.release(); await pending
    assert.equal(body(await view.read('a')), 'first'); assert.equal(body(await view.read('b')), 'second')
    assert.deepEqual(view.diff().map(d => d.kind === 'add' ? [d.path, d.mode, body(d.bytes)] : d.kind), [
      ['a', 0o100644, 'first'], ['b', 0o100644, 'second'],
    ])
  } finally { gate.release(); await pending.catch(() => {}) }
})

test('caller Buffer, read result and diff result cannot mutate upper bytes or retained identity', async () => {
  const f = fixture(), view = await loadView(emptyLog, 'round', { lower: f.lower }), input = Buffer.from('first')
  await view.write('a', input)
  const rev = view.rev, id = (await view.stat('a'))!.id
  input.fill(120)
  const read = (await view.read('a'))!
  assert.equal(body(read), 'first')
  new Uint8Array(read.buffer).fill(120)
  const diff = view.diff()[0] as Extract<Delta, { kind: 'add' }>
  new Uint8Array(diff.bytes.buffer).fill(120)
  assert.equal(body(await view.read('a')), 'first')
  assert.equal(body((view.diff()[0] as Extract<Delta, { kind: 'add' }>).bytes), 'first')
  assert.equal((await view.stat('a'))!.id, id); assert.equal(view.rev, rev)
})

test('snapshot seed owns source buffers and captures blob/path/mode/seq/revision labels', { timeout: 10_000 }, async () => {
  const f = fixture(), id = await f.lower.putBlob(Buffer.from('first')), gate = deferred(), entered = deferred(), read = f.lower.readBlob
  f.lower.readBlob = async blob => { entered.release(); await gate.promise; return read(blob) }
  const entry = { path: 'a', kind: 'file', blob: id, mode: 0o100644 } as const
  const snap: ViewSnapshot = { seq: 7, logBytes: 20, state: { rev: 1, points: [1], upper: [entry] } }
  let from: number | undefined
  const log = { async *readByWriter(_writer: string, start?: number) { from = start } }
  const pending = loadView(log, 'round', { lower: f.lower, snap })
  try {
    await Promise.race([entered.promise, pending.then(() => { assert.fail('seed completed before reading the blob') })])
    Object.assign(entry, { path: 'wrong', blob: hash(Buffer.from('other')), mode: 0o100755 })
    snap.seq = 1000; snap.state.rev = 99; snap.state.points.push(99)
    gate.release(); const view = await pending
    f.objects.get(id)!.fill(120)
    assert.equal(from, 7); assert.equal(view.rev, 1); assert.deepEqual(view.revs, [0, 1])
    assert.equal(body(await view.read('a')), 'first')
    assert.equal((await view.stat('a'))!.id, id); assert.equal((await view.stat('a'))!.mode, 0o100644)
    assert.equal(await view.stat('wrong'), null)
  } finally { gate.release(); await pending.catch(() => {}) }
})

test('replay captures event labels and owns the borrowed readBlob buffer', { timeout: 10_000 }, async () => {
  const f = fixture(), id = await f.lower.putBlob(Buffer.from('first')), gate = deferred(), entered = deferred(), read = f.lower.readBlob
  f.lower.readBlob = async blob => { entered.release(); await gate.promise; return read(blob) }
  const event: LogEvent = { t: 'view/write', agent: 'round', path: 'a', rev: 1, blob: id, mode: 0o100644 }
  const pending = loadView({ async *readByWriter() { yield event } }, 'round', { lower: f.lower })
  try {
    await Promise.race([entered.promise, pending.then(() => { assert.fail('replay completed before reading the blob') })])
    Object.assign(event, { path: 'wrong', rev: 99, blob: hash(Buffer.from('other')), mode: 0o100755 })
    gate.release(); const view = await pending
    f.objects.get(id)!.fill(120)
    assert.equal(body(await view.read('a')), 'first'); assert.equal(view.rev, 1)
    assert.equal((await view.stat('a'))!.id, id); assert.equal((await view.stat('a'))!.mode, 0o100644)
    assert.deepEqual(view.diff().map(d => d.kind === 'add' ? [d.path, d.mode, body(d.bytes)] : d.kind), [['a', 0o100644, 'first']])
  } finally { gate.release(); await pending.catch(() => {}) }
})

test('copy-up owns lower bytes and captures metadata before awaited content reads', { timeout: 10_000 }, async () => {
  const f = fixture(), bytes = Buffer.from('first'), id = hash(bytes), gate = deferred(), entered = deferred()
  const meta: EntryMeta = { kind: 'file', id, size: bytes.length, mode: 0o100644 }
  const lower: Lower = { ...f.lower, base: 'base' as CommitId, async stat(path) { return path === 'a' ? meta : null },
    async read() { entered.release(); await gate.promise; return bytes } }
  const view = await loadView(emptyLog, 'round', { lower }), pending = view.rename('a', 'b')
  try {
    await Promise.race([entered.promise, pending.then(() => { assert.fail('rename completed before content read') })])
    Object.assign(meta, { id: hash(Buffer.from('other')), mode: 0o100755 }); gate.release(); await pending
    bytes.fill(120)
    assert.equal(body(await view.read('b')), 'first')
    assert.equal((await view.stat('b'))!.id, id); assert.equal((await view.stat('b'))!.mode, 0o100644)
  } finally { gate.release(); await pending.catch(() => {}) }
})

for (const stage of ['putBlob', 'append'] as const) {
  test(`persistent edit owns the input before held ${stage} and preserves log/replay/live identity`, { timeout: 10_000 }, async () => {
    for (const bytes of [Buffer.from('first'), Uint8Array.from(Buffer.from('first'))]) {
      const f = fixture(), gate = deferred(), entered = deferred(), events: LogEvent[] = []
      const put = f.lower.putBlob
      let puts = 0
      const truth = { async putBlob(input: Uint8Array) {
        if (stage === 'putBlob' && ++puts === 1) { entered.release(); await gate.promise }
        return put(input)
      } } as Truth
      const log: Log = {
        async append(_writer, event) {
          events.push({ ...event })
          if (stage === 'append') { entered.release(); await gate.promise }
          return events.length
        },
        async *readByWriter() { yield* events },
        async *readMerged() {},
      }
      const view = await loadView(emptyLog, 'round', { lower: f.lower })
      const delta: Delta = { kind: 'add', path: 'a', bytes, mode: 0o100644 }
      const pending = applyEdit({ view, truth, log, writer: 'round' }, delta)
      try {
        await Promise.race([entered.promise, pending.then(() => { assert.fail(`edit completed without reaching ${stage}`) })])
        bytes.set(Buffer.from('other')); Object.assign(delta, { path: 'wrong', mode: 0o100755 })
        gate.release(); await pending
        const replayed = await loadView(log, 'round', { lower: f.lower })
        assert.deepEqual(view.state(), replayed.state())
        // Git readers can return Buffer for a plain Uint8Array-origin write.
        // The persistent invariant covers every delta label and byte value.
        assert.deepEqual(byteValues(view.diff()), byteValues(replayed.diff()))
        assert.equal(body(await view.read('a')), 'first')
        const event = events[0]
        assert.equal(event.t, 'view/write')
        if (event.t !== 'view/write') assert.fail('expected write event')
        assert.equal(event.path, 'a'); assert.equal(event.mode, 0o100644)
        assert.equal(body(await f.lower.readBlob(event.blob)), 'first')
        assert.equal((await view.stat('a'))!.id, event.blob)
      } finally { gate.release(); await pending.catch(() => {}) }
    }
  })
}
