// Bounded developer snapshot read: real files only, no process/network/mount dependencies.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { encodeEvent } from './envelope.ts'
import { LogCorruptError, logFileOf, openLog } from './log.ts'
import type { LogEvent } from './events.ts'
import { LogReadLimitError, readLogSnapshot, STREAM_LOG_LIMITS } from './stream.ts'

const event = (body = '雪\\n"quote"'): LogEvent => ({ t: 'agent/handoff', agent: 'a', successor: 'b', contract: 'c', digest: 'd', body })
const row = (writer: string, seq: number, body?: string) => encodeEvent(seq, writer, event(body)) + '\n'
function fixture() {
  const root = tmpDir('fugue-stream-log-')
  const write = (writer: string, bytes: string | Buffer) => {
    const path = logFileOf(root, writer)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, bytes)
    return path
  }
  return { root, write }
}
async function cached(root: string, from = 0) {
  const log = openLog(root)
  try { return await Array.fromAsync(log.readMerged(from)) } finally { await log.close() }
}

test('merge ties, writer physical order and filtering equal authoritative cached reads', async () => {
  const { root, write } = fixture()
  write('agent/a', row('agent/a', 1) + '\n' + row('agent/a', 5) + row('agent/a', 3))
  write('agent/b', row('agent/b', 1) + row('agent/b', 4))
  for (const from of [0, 1, 4, 9]) assert.deepEqual(await Array.fromAsync(readLogSnapshot(root, from)), await cached(root, from))
})

test('chunk-split UTF8 and escaped text, blank lines and torn raw tail are preserved without mutation', async () => {
  const { root, write } = fixture()
  const path = write('a', Buffer.concat([Buffer.from('\n' + row('a', 1, '雪'.repeat(50_000)) + row('a', 2)), Buffer.from([0xe9, 0x9b])]))
  const before = readFileSync(path)
  assert.deepEqual(await Array.fromAsync(readLogSnapshot(root)), await cached(root))
  assert.deepEqual(readFileSync(path), before)
  assert.ok(!existsSync(path.replace('.jsonl', '.lock')))
})

test('all complete rows validate before any yield, even excluded rows and later writers', async () => {
  for (const bad of ['not-json\n', row('foreign', 2), '{"seq":8,' + row('b', 2).slice(1)]) {
    const { root, write } = fixture()
    write('a', row('a', 1))
    const path = write('b', '\n' + row('b', 1) + bad + '{"partial"')
    const before = readFileSync(path)
    for (const from of [0, 100]) {
      await assert.rejects(readLogSnapshot(root, from).next(), error => error instanceof LogCorruptError && error.writer === 'b' && error.line === 3)
    }
    assert.deepEqual(readFileSync(path), before)
  }
})

test('complete over-budget row refuses distinctly, but arbitrarily long uncommitted tail is ignored', async () => {
  const { root, write } = fixture()
  const path = write('a', row('a', 1) + 'x'.repeat(STREAM_LOG_LIMITS.maxRowBytes + 10))
  assert.equal((await Array.fromAsync(readLogSnapshot(root))).length, 1)
  appendFileSync(path, '\n')
  await assert.rejects(readLogSnapshot(root).next(), LogReadLimitError)
})

test('writer admission is bounded before file opening; missing roots remain missing', async () => {
  const { root, write } = fixture()
  const missing = join(root, 'absent')
  assert.deepEqual(await Array.fromAsync(readLogSnapshot(missing)), [])
  assert.equal(existsSync(missing), false)
  for (let n = 0; n <= STREAM_LOG_LIMITS.maxWriters; n++) write('w' + n, '')
  await assert.rejects(readLogSnapshot(root).next(), LogReadLimitError)
})

test('a new invocation sees appends and new writers; an active changed snapshot refuses', async () => {
  const { root, write } = fixture()
  const path = write('a', row('a', 1) + row('a', 2))
  const reader = readLogSnapshot(root)
  assert.equal((await reader.next()).value!.pos.seq, 1)
  appendFileSync(path, row('a', 3))
  await assert.rejects(reader.next(), /快照读取中改变/)
  write('b', row('b', 1))
  assert.deepEqual(await Array.fromAsync(readLogSnapshot(root)), await cached(root))
})


test('early return and failed read settle every owned descriptor, with bounded read requests', async () => {
  const { root, write } = fixture()
  write('a', row('a', 1, 'x'.repeat(80_000)) + row('a', 2))
  write('b', row('b', 1))
  const original = fs.promises.open
  let active = 0, opened = 0, closes = 0, maxRead = 0, fail = false
  fs.promises.open = (async (...args: Parameters<typeof original>) => {
    const file = await original(...args)
    active++; opened++
    const read = file.read.bind(file), close = file.close.bind(file)
    file.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      maxRead = Math.max(maxRead, length)
      if (fail) return { bytesRead: 0, buffer }
      return read(buffer, offset, length, position)
    }) as typeof file.read
    file.close = async () => { try { await close() } finally { active--; closes++ } }
    return file
  }) as typeof original
  syncBuiltinESMExports()
  try {
    const reader = readLogSnapshot(root)
    await reader.next()
    assert.equal(active, 2)
    await reader.return(undefined)
    assert.equal(active, 0)
    assert.equal(closes, opened)
    assert.ok(maxRead <= 64 * 1024)
    fail = true
    await assert.rejects(readLogSnapshot(root).next(), /提前结束/)
    assert.equal(active, 0)
    assert.equal(closes, opened)
  } finally { fs.promises.open = original; syncBuiltinESMExports() }
})
