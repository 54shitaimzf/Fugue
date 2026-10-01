import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { encodeEvent } from './envelope.ts'
import { holdWriter, LogHeldError } from './hold.ts'
import { logDir, LogCorruptError, openLog } from './log.ts'
import type { LogEvent } from './events.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'

const event = (rev: number): LogEvent => ({ t: 'view/write', agent: 'round', path: 'src/甲😀.ts', rev, blob: `b${rev}`, mode: 420 } as LogEvent)
const row = (seq: number): string => encodeEvent(seq, 'round', event(seq)) + '\n'
function fixture(bytes: Uint8Array) {
  const root = tmpDir('fugue-tail-recovery-'), file = join(logDir(root), 'round.jsonl')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, bytes)
  return { root, file }
}
async function rows(root: string) {
  const reader = openLog(root, { sync: 'never' })
  try {
    const result: LogEvent[] = []
    for await (const value of reader.readByWriter('round')) result.push(value)
    return result
  } finally { await reader.close() }
}

for (const sync of ['each', 'batch', 'never'] as const) {
  test(`${sync}: writer removes only incomplete bytes before append and restart`, async () => {
    const prefix = Buffer.from(row(1)), interrupted = Buffer.from(row(2))
    const cut = interrupted.indexOf(Buffer.from('😀')) + 2 // 落在UTF8码点中间，不能按解码文本长度截。
    assert.ok(cut > 1 && cut < interrupted.length)
    const f = fixture(Buffer.concat([prefix, interrupted.subarray(0, cut)]))
    assert.deepEqual(await rows(f.root), [event(1)])
    let writer = openLog(f.root, { write: 'round', sync })
    try { assert.equal(await writer.append('round', event(2)), 2) }
    finally { await writer.close() }
    assert.deepEqual(readFileSync(f.file), Buffer.concat([prefix, Buffer.from(row(2))]))
    writer = openLog(f.root, { write: 'round', sync })
    try { assert.equal(await writer.append('round', event(3)), 3) }
    finally { await writer.close() }
    assert.deepEqual(await rows(f.root), [event(1), event(2), event(3)])
  })
}

test('a crash in the first row recovers empty prefix, then emits a parseable seq1', async () => {
  const f = fixture(Buffer.from(row(1)).subarray(0, 28)), writer = openLog(f.root, { write: 'round', sync: 'each' })
  try { assert.equal(await writer.append('round', event(1)), 1) }
  finally { await writer.close() }
  assert.deepEqual(readFileSync(f.file), Buffer.from(row(1)))
  assert.deepEqual(await rows(f.root), [event(1)])
})

test('complete corrupt, foreign-writer or opaque-over-window tails are never truncated', async () => {
  const bad = row(2).replace('"blob":"b2"', '"blob":"wrong"')
  const foreign = encodeEvent(2, 'other', event(2)) + '\n'
  for (const bytes of [Buffer.from(row(1) + bad + '{"partial"'), Buffer.from(row(1) + foreign + '{"partial"'), Buffer.alloc(65537, 0x78)]) {
    const f = fixture(bytes), writer = openLog(f.root, { write: 'round', sync: 'never' })
    try { await assert.rejects(writer.append('round', event(3)), error => error instanceof LogCorruptError) }
    finally { await writer.close() }
    assert.deepEqual(readFileSync(f.file), bytes)
  }
})

test('an existing writer fence rejects another handle before recovery can alter any bytes', () => {
  const bytes = Buffer.from(row(1) + '{"partial"'), f = fixture(bytes), hold = holdWriter(f.root, 'round')
  try { assert.throws(() => openLog(f.root, { write: 'round', sync: 'never' }), error => error instanceof LogHeldError) }
  finally { hold.release() }
  assert.deepEqual(readFileSync(f.file), bytes)
})

async function withObservedFile(file: string, run: (ops: string[], opens: () => number) => Promise<void>, configure?: (handle: FileHandle, ordinal: number) => void) {
  const originalOpen = fs.open, ops: string[] = [], owned: FileHandle[] = []
  let openCount = 0
  fs.open = async function (...args: Parameters<typeof originalOpen>) {
    const ordinal = args[0] === file ? ++openCount : 0
    const handle = await originalOpen(...args)
    if (ordinal !== 0) {
      owned.push(handle)
      for (const name of ['truncate', 'sync', 'write'] as const) {
        const original = handle[name].bind(handle)
        handle[name] = (async (...values: unknown[]) => {
          ops.push(name)
          return await Reflect.apply(original, handle, values)
        }) as typeof handle[typeof name]
      }
      configure?.(handle, ordinal)
    }
    return handle
  }
  try { syncBuiltinESMExports() }
  catch (error) {
    fs.open = originalOpen
    try { syncBuiltinESMExports() } catch { /* Preserve the original setup error. */ }
    throw error
  }
  try { await run(ops, () => openCount) }
  finally {
    try { await Promise.allSettled(owned.map(handle => Promise.resolve().then(() => handle.close()))) }
    finally { fs.open = originalOpen; syncBuiltinESMExports() }
  }
}

test('truncate precedes new bytes and recovery preserves configured flush policy', async () => {
  for (const sync of ['each', 'batch', 'never'] as const) {
    const f = fixture(Buffer.from(row(1) + '{"partial"'))
    await withObservedFile(f.file, async ops => {
      const writer = openLog(f.root, { write: 'round', sync })
      try {
        await writer.append('round', event(2))
        assert.deepEqual(ops, sync === 'each' ? ['truncate', 'write', 'sync'] : ['truncate', 'write'])
      } finally { await writer.close() }
    })
    await withObservedFile(f.file, async ops => {
      const writer = openLog(f.root, { write: 'round', sync: 'never' })
      try { await writer.append('round', event(3)) }
      finally { await writer.close() }
      assert.deepEqual(ops, ['write'], 'an intact tail needs no recovery truncate or forced sync')
    })
  }
})

test('bounded short reads fill the tail window before any recovery decision', async () => {
  const prefix = Buffer.from(row(1)), f = fixture(Buffer.concat([prefix, Buffer.from('{"partial"')]))
  await withObservedFile(f.file, async () => {
    const writer = openLog(f.root, { write: 'round', sync: 'never' })
    try { assert.equal(await writer.append('round', event(2)), 2) }
    finally { await writer.close() }
  }, handle => {
    const original = handle.read.bind(handle)
    handle.read = ((buffer: Buffer, offset: number, length: number, position: number) =>
      original(buffer, offset, Math.min(length, 7), position)) as typeof handle.read
  })
  assert.deepEqual(readFileSync(f.file), Buffer.concat([prefix, Buffer.from(row(2))]))
})

test('a file changed during recovery is refused without deleting the uncooperative additions', async () => {
  const before = Buffer.from(row(1) + '{"partial"'), f = fixture(before), added = Buffer.from('unexpected bytes')
  await withObservedFile(f.file, async ops => {
    const writer = openLog(f.root, { write: 'round', sync: 'never' })
    try { await assert.rejects(writer.append('round', event(2)), /恢复前改变/) }
    finally { await writer.close() }
    assert.deepEqual(ops, [])
  }, handle => {
    const original = handle.read.bind(handle)
    handle.read = (async (...args: Parameters<typeof original>) => {
      const result = await original(...args)
      appendFileSync(f.file, added)
      return result
    }) as typeof handle.read
  })
  assert.deepEqual(readFileSync(f.file), Buffer.concat([before, added]))
})

test('failed configured flush is not a false durability acknowledgment; complete bytes resume at the next sequence', async () => {
  const prefix = Buffer.from(row(1)), f = fixture(Buffer.concat([prefix, Buffer.from('{"partial"')])), marker = new Error('event sync failed')
  let syncCalls = 0
  await withObservedFile(f.file, async () => {
    const writer = openLog(f.root, { write: 'round', sync: 'each' })
    try { await assert.rejects(writer.append('round', event(2)), error => error === marker) }
    finally { await writer.close() }
  }, handle => {
    const original = handle.sync.bind(handle)
    handle.sync = async () => {
      if (++syncCalls === 1) throw marker
      await original()
    }
  })
  assert.equal(syncCalls, 1, 'a failed each-mode flush is reported; close does not invent a durability acknowledgment')
  assert.deepEqual(readFileSync(f.file), Buffer.concat([prefix, Buffer.from(row(2))]), 'failed sync can follow a completed write; do not pretend the bytes disappeared')
  const writer = openLog(f.root, { write: 'round', sync: 'each' })
  try { assert.equal(await writer.append('round', event(3)), 3) }
  finally { await writer.close() }
  assert.deepEqual(await rows(f.root), [event(1), event(2), event(3)])
})


function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('a valid multirow prefix crossing64KiB keeps its raw bytes before a UTF8 partial tail', async () => {
  const prefix = Buffer.from(Array.from({ length: 900 }, (_, at) => row(at + 1)).join(''))
  assert.ok(prefix.length > 65536)
  const interrupted = Buffer.from(row(901)), cut = interrupted.indexOf(Buffer.from('😀')) + 2
  const f = fixture(Buffer.concat([prefix, interrupted.subarray(0, cut)])), writer = openLog(f.root, { write: 'round', sync: 'never' })
  try { assert.equal(await writer.append('round', event(901)), 901) }
  finally { await writer.close() }
  assert.deepEqual(readFileSync(f.file), Buffer.concat([prefix, Buffer.from(row(901))]))
  assert.equal((await rows(f.root)).length, 901)
})

test('an early-zero read refuses recovery without truncating or appending', async () => {
  const before = Buffer.from(row(1) + '{"partial"'), f = fixture(before)
  await withObservedFile(f.file, async ops => {
    const writer = openLog(f.root, { write: 'round', sync: 'never' })
    try { await assert.rejects(writer.append('round', event(2)), /读取中改变/) }
    finally { await writer.close() }
    assert.deepEqual(ops, [])
  }, handle => { handle.read = (async () => ({ bytesRead: 0, buffer: Buffer.alloc(0) })) as typeof handle.read })
  assert.deepEqual(readFileSync(f.file), before)
})

test('two first appends share recovery and cannot truncate one another committed row', async () => {
  const f = fixture(Buffer.from(row(1) + '{"partial"')), entered = deferred(), release = deferred()
  const originalMkdir = fs.mkdir
  // fixture目录已存在；让初始化的mkdir yield可控，不把断言绑定到磁盘速度。
  fs.mkdir = (async (...args: Parameters<typeof originalMkdir>) => args[0] === dirname(f.file) ? undefined : originalMkdir(...args)) as typeof fs.mkdir
  syncBuiltinESMExports()
  try {
    await withObservedFile(f.file, async (ops, opens) => {
      const writer = openLog(f.root, { write: 'round', sync: 'never' }), accepted: Promise<number>[] = []
      try {
        accepted.push(writer.append('round', event(2)))
        await entered.promise
        accepted.push(writer.append('round', event(3)))
        await Promise.resolve()
        assert.equal(opens(), 1, 'pending initialization is shared before a second native open starts')
        release.resolve()
        assert.deepEqual(await Promise.all(accepted), [2, 3])
        assert.equal(ops.filter(value => value === 'truncate').length, 1)
      } finally {
        release.resolve()
        await Promise.allSettled(accepted)
        await writer.close()
      }
    }, (handle, ordinal) => {
      if (ordinal !== 1) return
      const original = handle.read.bind(handle)
      handle.read = (async (...args: Parameters<typeof original>) => {
        entered.resolve()
        await release.promise
        return original(...args)
      }) as typeof handle.read
    })
  } finally { fs.mkdir = originalMkdir; syncBuiltinESMExports() }
  assert.deepEqual(await rows(f.root), [event(1), event(2), event(3)])
})

test('failed initialization is evicted so the same handle can retry after explicit repair', async () => {
  const prefix = Buffer.from(row(1)), f = fixture(Buffer.from(row(1) + row(2).replace('"blob":"b2"', '"blob":"wrong"')))
  const writer = openLog(f.root, { write: 'round', sync: 'never' })
  try {
    await assert.rejects(writer.append('round', event(3)), error => error instanceof LogCorruptError)
    writeFileSync(f.file, prefix)
    assert.equal(await writer.append('round', event(2)), 2)
  } finally { await writer.close() }
  assert.deepEqual(await rows(f.root), [event(1), event(2)])
})

test('different writer IDs keep independent initialization and sequence state', async () => {
  const f = fixture(Buffer.from(row(1) + '{"partial"')), other = join(logDir(f.root), 'other.jsonl')
  writeFileSync(other, encodeEvent(7, 'other', event(7)) + '\n{"partial"')
  const writer = openLog(f.root, { sync: 'never' })
  try { assert.deepEqual(await Promise.all([writer.append('round', event(2)), writer.append('other', event(8))]), [2, 8]) }
  finally { await writer.close() }
  assert.equal(readFileSync(other, 'utf8'), encodeEvent(7, 'other', event(7)) + '\n' + encodeEvent(8, 'other', event(8)) + '\n')
})

test('close retains the fence through accepted initialization/write and prevents late append', async () => {
  const f = fixture(Buffer.from(row(1) + '{"partial"')), entered = deferred(), release = deferred()
  await withObservedFile(f.file, async () => {
    const writer = openLog(f.root, { write: 'round', sync: 'never' })
    const append = writer.append('round', event(2))
    await entered.promise
    let returned = false
    const closing = writer.close().then(() => { returned = true })
    try {
      await new Promise<void>(done => setImmediate(done))
      assert.equal(returned, false, 'close must observe already accepted initialization')
      assert.throws(() => holdWriter(f.root, 'round'), error => error instanceof LogHeldError)
      release.resolve()
      assert.equal(await append, 2)
      await closing
      await assert.rejects(writer.append('round', event(3)), /已关闭/)
      const next = holdWriter(f.root, 'round')
      next.release()
    } finally {
      release.resolve()
      await Promise.allSettled([append, closing])
      await writer.close()
    }
  }, handle => {
    const original = handle.read.bind(handle)
    handle.read = (async (...args: Parameters<typeof original>) => {
      entered.resolve()
      await release.promise
      return original(...args)
    }) as typeof handle.read
  })
  assert.deepEqual(await rows(f.root), [event(1), event(2)])
})
