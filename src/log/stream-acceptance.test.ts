// Independent M0 snapshot acceptance: actual journal bytes, deterministic failures, no live providers.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import type { LogEvent } from './events.ts'
import { encodeEvent } from './envelope.ts'
import { logDir, logFileOf, LogCorruptError, openLog } from './log.ts'
import { LogReadLimitError, readLogSnapshot, STREAM_LOG_LIMITS } from './stream.ts'
import { callLedgerOf, readCallLedger } from '../probe/call-ledger.ts'

const event = (body = '雪\\n"quoted", {"seq":9}'): LogEvent => ({
  t: 'agent/handoff', agent: 'a', successor: 'b', contract: 'c', digest: 'd', body,
})
const row = (writer: string, seq: number, body?: string) => encodeEvent(seq, writer, event(body)) + '\n'
function fixture() {
  const root = tmpDir('fugue-stream-acceptance-')
  function write(writer: string, bytes: string | Buffer): string {
    const path = logFileOf(root, writer)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, bytes)
    return path
  }
  return { root, write }
}
async function cached(root: string, fromSeq = 0) {
  const log = openLog(root)
  try { return await Array.fromAsync(log.readMerged(fromSeq)) } finally { await log.close() }
}

// Each test file has its own process. Restore the built-in binding even when an assertion rejects.
async function instrument<T>(
  wrap: (file: Awaited<ReturnType<typeof fs.promises.open>>, path: string) => void,
  run: () => Promise<T>,
): Promise<T> {
  const original = fs.promises.open
  fs.promises.open = (async (...args: Parameters<typeof original>) => {
    assert.equal(args[1], 'r', 'the snapshot must never open a writer')
    const file = await original(...args)
    wrap(file, String(args[0]))
    return file
  }) as typeof original
  syncBuiltinESMExports()
  try { return await run() } finally { fs.promises.open = original; syncBuiltinESMExports() }
}

test('every complete corrupt row rejects the first next with authoritative writer, physical line and reason', async () => {
  const invalid = [
    row('b', 2).replace('"digest":"d"', '"digest":"changed"'),
    '{"\\u0073eq":2,' + row('b', 2).slice(1),
    '{"writer":"b",' + row('b', 2).slice(1),
    row('foreign', 2),
    ...[0, -1, 1.5].map(seq => row('b', seq)),
  ]
  for (const bad of invalid) {
    const { root, write } = fixture()
    write('a', row('a', 1))
    // The non-ASCII prefix crosses chunks. Empty physical lines still count toward the diagnosis.
    const path = write('b', row('b', 1, '雪'.repeat(25_000)) + '\n\n' + bad + '{"torn":')
    const before = readFileSync(path)
    for (const fromSeq of [0, 100]) {
      let expected: LogCorruptError | undefined
      try { await cached(root, fromSeq) } catch (error) { expected = error as LogCorruptError }
      assert.ok(expected instanceof LogCorruptError)
      await assert.rejects(readLogSnapshot(root, fromSeq).next(), error => {
        assert.ok(error instanceof LogCorruptError)
        assert.equal(error.writer, 'b')
        assert.equal(error.line, 4)
        assert.equal(error.reason, expected!.reason)
        return true
      })
    }
    assert.deepEqual(readFileSync(path), before)
    assert.equal(existsSync(path.replace(/\.jsonl$/, '.lock')), false)
  }
})

test('short reads across UTF8, escapes and LF retain the same merge and fromSeq semantics', async () => {
  const { root, write } = fixture()
  write('nested/a', row('nested/a', 1) + row('nested/a', 5) + row('nested/a', 3))
  write('nested/b', '\n' + row('nested/b', 1) + row('nested/b', 4) + '\n')
  const expected = await Promise.all([0, 1, 4, 99].map(from => cached(root, from)))
  await instrument(file => {
    const read = file.read.bind(file)
    file.read = (async (buffer: Buffer, offset: number, length: number, position: number) =>
      read(buffer, offset, Math.min(7, length), position)) as typeof file.read
  }, async () => {
    for (const [at, from] of [0, 1, 4, 99].entries()) {
      assert.deepEqual(await Array.fromAsync(readLogSnapshot(root, from)), expected[at])
    }
  })
  assert.deepEqual(expected[0].map(entry => entry.pos), [
    { writer: 'nested/a', seq: 1 }, { writer: 'nested/b', seq: 1 },
    { writer: 'nested/b', seq: 4 }, { writer: 'nested/a', seq: 5 }, { writer: 'nested/a', seq: 3 },
  ], 'physical writer order is preserved; this reader adds no new sequence rejection')
})

test('the complete-row byte ceiling is inclusive and an overlong torn suffix is never repaired', async () => {
  const { root, write } = fixture()
  const overhead = Buffer.byteLength(row('a', 1, '')) - 1
  const exact = row('a', 1, 'x'.repeat(STREAM_LOG_LIMITS.maxRowBytes - overhead))
  assert.equal(Buffer.byteLength(exact) - 1, STREAM_LOG_LIMITS.maxRowBytes)
  const path = write('a', exact + '雪'.repeat(STREAM_LOG_LIMITS.maxRowBytes))
  const before = readFileSync(path)
  assert.equal((await Array.fromAsync(readLogSnapshot(root))).length, 1)
  assert.deepEqual(readFileSync(path), before)
  appendFileSync(path, '\n')
  await assert.rejects(readLogSnapshot(root).next(), LogReadLimitError)
  assert.deepEqual(readFileSync(path), Buffer.concat([before, Buffer.from('\n')]))
})

test('writer limit admits exactly its budget and refuses the next writer before acquiring any file', async () => {
  const { root, write } = fixture()
  for (let at = 0; at < STREAM_LOG_LIMITS.maxWriters; at++) write(`w${at}`, '')
  writeFileSync(join(logDir(root), 'ignored.lock'), 'sidecar')
  let opened = 0, active = 0, peak = 0
  await instrument(file => {
    opened++; active++; peak = Math.max(peak, active)
    const close = file.close.bind(file)
    file.close = async () => { try { await close() } finally { active-- } }
  }, async () => {
    assert.deepEqual(await Array.fromAsync(readLogSnapshot(root)), [])
    assert.equal(opened, STREAM_LOG_LIMITS.maxWriters)
    assert.equal(peak, STREAM_LOG_LIMITS.maxWriters)
    assert.equal(active, 0)
    write('extra', '')
    await assert.rejects(readLogSnapshot(root).next(), LogReadLimitError)
    assert.equal(opened, STREAM_LOG_LIMITS.maxWriters)
  })
  assert.equal(readFileSync(join(logDir(root), 'ignored.lock'), 'utf8'), 'sidecar')
})

test('early consumer break settles all descriptors even if one close rejects', async () => {
  const { root, write } = fixture()
  write('a', row('a', 1) + row('a', 2))
  write('b', row('b', 1))
  const closeError = new Error('injected close failure')
  const closed: string[] = []
  await instrument((file, path) => {
    const close = file.close.bind(file)
    file.close = async () => {
      await close(); closed.push(path)
      if (path.endsWith('/a.jsonl')) throw closeError
    }
  }, async () => {
    let seen = 0
    await assert.rejects(async () => {
      for await (const _entry of readLogSnapshot(root)) { seen++; break }
    }, error => error === closeError)
    assert.equal(seen, 1)
    assert.equal(closed.length, 2)
    assert.equal(new Set(closed).size, 2)
  })
})

test('failed initial metadata still closes the newly owned handle and preserves the original error', async () => {
  const { root, write } = fixture()
  write('a', row('a', 1))
  write('b', row('b', 1))
  const primary = new Error('injected initial stat failure')
  const opened: string[] = [], closed: string[] = []
  await instrument((file, path) => {
    opened.push(path)
    const close = file.close.bind(file)
    file.close = async () => { await close(); closed.push(path); throw new Error('injected cleanup failure') }
    if (path.endsWith('/b.jsonl')) file.stat = async () => { throw primary }
  }, async () => {
    await assert.rejects(readLogSnapshot(root).next(), error => error === primary)
    assert.deepEqual(closed.sort(), opened.sort())
    assert.equal(closed.length, 2)
  })
})

test('a read failure in a later writer yields nothing and settles earlier and failing handles', async () => {
  const { root, write } = fixture()
  write('a', row('a', 1)); write('b', row('b', 1))
  const primary = new Error('injected read failure')
  const closed: string[] = []
  await instrument((file, path) => {
    const close = file.close.bind(file)
    file.close = async () => { await close(); closed.push(path) }
    if (path.endsWith('/b.jsonl')) file.read = async () => { throw primary }
  }, async () => {
    await assert.rejects(readLogSnapshot(root).next(), error => error === primary)
    assert.equal(closed.length, 2)
  })
})

test('a same-size rewrite between validation and the first result invalidates the captured snapshot', async () => {
  const { root, write } = fixture()
  const path = write('a', row('a', 1, 'old') + row('a', 2))
  let reads = 0
  await instrument(file => {
    const read = file.read.bind(file)
    file.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await read(buffer, offset, length, position)
      if (++reads === 2) writeFileSync(path, row('a', 1, 'new') + row('a', 2))
      return result
    }) as typeof file.read
  }, async () => {
    await assert.rejects(readLogSnapshot(root).next(), /快照读取中改变/)
  })
  assert.deepEqual((await Array.fromAsync(readLogSnapshot(root)))[0].e, event('new'))
})

test('mutation of another writer after a yield rejects before the next result; new invocation sees it', async () => {
  const { root, write } = fixture()
  write('a', row('a', 1) + row('a', 3))
  const other = write('b', row('b', 2))
  const reader = readLogSnapshot(root)
  assert.equal((await reader.next()).value!.pos.writer, 'a')
  appendFileSync(other, row('b', 4))
  await assert.rejects(reader.next(), /快照读取中改变/)
  assert.deepEqual(await Array.fromAsync(readLogSnapshot(root)), await cached(root))
})

test('derived ledger consumes real journals with bounded requests and no full-file reads, including rows after maxRows', async () => {
  const { root } = fixture()
  const call: Extract<LogEvent, { t: 'llm/call' }> = {
    t: 'llm/call', agent: 'a', step: 'same-step', model: 'replay-only', wire: 'openai-chat',
    thinking: null, toolCount: 3, invocations: 0, status: null, headers: { diagnostic: 'private-header' },
    usage: { inputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: 1, reasoningTokens: null },
    rawStop: 'stop', stop: 'end-turn',
  }
  for (const name of ['agent/a', 'agent/b']) {
    const log = openLog(root, { write: name, sync: 'each' })
    try {
      await log.append(name, call)
      await log.append(name, event('雪'.repeat(24_000)))
      await log.append(name, { ...call, attempts: [429, 200] })
    } finally { await log.close() }
  }
  const expectedRows = await cached(root)
  const originalReadFile = fs.promises.readFile
  let requests = 0, maxRequest = 0, active = 0
  fs.promises.readFile = async () => { throw new Error('full-file reader forbidden') }
  syncBuiltinESMExports()
  try {
    await instrument(file => {
      active++
      const read = file.read.bind(file), close = file.close.bind(file)
      file.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        requests++; maxRequest = Math.max(maxRequest, length)
        assert.ok(buffer.length <= 64 * 1024)
        return read(buffer, offset, length, position)
      }) as typeof file.read
      file.close = async () => { try { await close() } finally { active-- } }
    }, async () => {
      for (const maxRows of [0, 1, 4]) {
        const result = await readCallLedger(readLogSnapshot(root), maxRows)
        assert.deepEqual(result, callLedgerOf(expectedRows, maxRows))
        assert.equal(result.totalCalls, 4)
        assert.equal(active, 0)
        assert.equal(JSON.stringify(result).includes('private-header'), false)
      }
      assert.ok(requests > 0)
      assert.ok(maxRequest <= 64 * 1024)
      appendFileSync(logFileOf(root, 'agent/b'), 'not-json\n')
      for (const maxRows of [0, 1]) {
        await assert.rejects(readCallLedger(readLogSnapshot(root), maxRows), LogCorruptError)
        assert.equal(active, 0)
      }
    })
  } finally { fs.promises.readFile = originalReadFile; syncBuiltinESMExports() }
  assert.deepEqual(readdirSync(join(root, '.fugue')).sort(), ['log'])
})


test('synchronous first-close failure still awaits later cleanup, without masking corruption', async () => {
  for (const corrupt of [false, true]) {
    const { root, write } = fixture()
    write('a', row('a', 1) + row('a', 2))
    write('b', corrupt ? 'not-json\n' : row('b', 1))
    const closeError = new Error('injected synchronous first-close failure')
    const attempted: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let signalClose!: () => void
    const closeStarted = new Promise<void>(resolve => { signalClose = resolve })
    const actualCloses: (() => Promise<void>)[] = []
    let outcome: Promise<{ error?: unknown }> | undefined
    await instrument((file, path) => {
      const actualClose = file.close.bind(file)
      actualCloses.push(actualClose)
      if (path.endsWith('/a.jsonl')) {
        file.close = () => { attempted.push('a'); throw closeError }
      } else {
        file.close = async () => { attempted.push('b'); signalClose(); await gate; await actualClose() }
      }
    }, async () => {
      try {
        const reader = readLogSnapshot(root)
        if (!corrupt) assert.equal((await reader.next()).value!.pos.seq, 1)
        let settled = false
        const operation = corrupt ? reader.next() : reader.return(undefined)
        outcome = operation.then(() => { settled = true; return {} }, error => { settled = true; return { error } })
        // The held close is an explicit gate, not a timing or throughput assertion.
        const progress = await Promise.race([closeStarted.then(() => 'started'), outcome.then(() => 'settled')])
        assert.equal(progress, 'started', 'a synchronous close failure must not skip later handles')
        assert.deepEqual(attempted, ['a', 'b'])
        assert.equal(settled, false, 'caller must await every owned descriptor cleanup')
        release()
        const result = await outcome
        if (corrupt) {
          assert.ok(result.error instanceof LogCorruptError)
          assert.equal(result.error.writer, 'b')
          assert.equal(result.error.line, 1)
        } else assert.equal(result.error, closeError)
      } finally {
        release()
        await outcome
        await Promise.allSettled(actualCloses.map(close => close()))
      }
    })
  }
})


test('relative root remains captured when cwd changes before the first next', async () => {
  const { root, write } = fixture()
  write('a', row('a', 1))
  const other = tmpDir('fugue-stream-other-cwd-')
  const before = process.cwd()
  try {
    process.chdir(root)
    const reader = readLogSnapshot('.')
    process.chdir(other)
    assert.deepEqual(await Array.fromAsync(reader), await cached(root))
    assert.deepEqual(readdirSync(other), [])
  } finally { process.chdir(before) }
})
