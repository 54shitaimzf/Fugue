// Snapshot metadata optimization acceptance: actual files plus precise failure injection; no providers.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import timers from 'node:timers/promises'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { encodeEvent } from './envelope.ts'
import { logFileOf } from './log.ts'
import { readLogSnapshot } from './stream.ts'

const row = (writer: string, seq: number, body = '雪') => encodeEvent(seq, writer, {
  t: 'agent/handoff', agent: writer, successor: 'next', contract: 'c', digest: 'd', body,
}) + '\n'
function fixture() {
  const root = tmpDir('fugue-stream-fstat-acceptance-')
  function write(writer: string, content: string): string {
    const path = logFileOf(root, writer)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
    return path
  }
  return { root, write }
}

async function instrument<T>(
  onOpen: (file: FileHandle, path: string) => void,
  onStat: (fd: number, actual: BigIntStats) => BigIntStats,
  run: () => Promise<T>,
): Promise<T> {
  const originalOpen = fs.promises.open, originalStat = fs.fstatSync
  fs.promises.open = (async (...args: Parameters<typeof originalOpen>) => {
    assert.equal(args[1], 'r')
    const file = await originalOpen(...args)
    onOpen(file, String(args[0]))
    return file
  }) as typeof originalOpen
  fs.fstatSync = ((fd: number, options?: { bigint?: boolean }) => {
    assert.equal(options?.bigint, true, 'snapshot fields must preserve nanoseconds and exact inode/device integers')
    return onStat(fd, originalStat(fd, { bigint: true }))
  }) as typeof originalStat
  syncBuiltinESMExports()
  try { return await run() } finally {
    fs.promises.open = originalOpen; fs.fstatSync = originalStat; syncBuiltinESMExports()
  }
}

test('FD metadata checks preserve every exact field independently, with no source-byte mutation', async () => {
  for (const field of ['size', 'ino', 'dev', 'mtimeNs', 'ctimeNs'] as const) {
    const { root, write } = fixture()
    const path = write('a', row('a', 1) + row('a', 2))
    const before = readFileSync(path)
    let calls = 0, closed = 0
    await instrument(file => {
      const close = file.close.bind(file)
      file.close = async () => { await close(); closed++ }
    }, (_fd, actual) => {
      calls++
      return calls === 2 ? { ...actual, [field]: actual[field] + 1n } as BigIntStats : actual
    }, async () => {
      const reader = readLogSnapshot(root)
      try {
        await assert.rejects(reader.next(), /快照读取中改变/)
        assert.equal(calls, 2)
        assert.equal(closed, 1)
      } finally { await reader.return(undefined).catch(() => undefined) }
    })
    assert.deepEqual(readFileSync(path), before, field)
  }
})

test('synchronous fstat failure settles every acquired descriptor and retains the primary error', async () => {
  const { root, write } = fixture()
  write('a', row('a', 1)); write('b', row('b', 1))
  const primary = new Error('injected synchronous fstat failure')
  const opened = new Set<number>(), closed = new Set<number>()
  let stats = 0
  await instrument(file => {
    const fd = file.fd, close = file.close.bind(file)
    opened.add(fd)
    file.close = async () => { await close(); closed.add(fd); throw new Error('injected close failure') }
  }, (_fd, actual) => {
    if (++stats === 2) throw primary
    return actual
  }, async () => {
    const reader = readLogSnapshot(root)
    try {
      await assert.rejects(reader.next(), error => error === primary)
      assert.equal(stats, 2)
      assert.deepEqual(closed, opened)
    } finally { await reader.return(undefined).catch(() => undefined) }
  })
})

test('synchronous invariant checks remain before and after every chunk, pass boundary and merged yield', async () => {
  const { root, write } = fixture()
  write('a', row('a', 1) + row('a', 3)); write('b', row('b', 2))
  const paths = new Map<number, string>(), checks = new Map<string, number>()
  const timeline: string[] = []
  let asyncStats = 0
  await instrument((file, path) => {
    const writer = path.endsWith('/a.jsonl') ? 'a' : 'b'
    paths.set(file.fd, writer)
    const stat = file.stat.bind(file), read = file.read.bind(file)
    file.stat = (async (...args: Parameters<typeof file.stat>) => { asyncStats++; return stat(...args) }) as typeof file.stat
    file.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      assert.equal(timeline.at(-1), `stat:${writer}`, 'every chunk request is guarded immediately before reading')
      timeline.push(`read:${writer}`)
      const result = await read(buffer, offset, length, position)
      timeline.push(`done:${writer}`)
      return result
    }) as typeof file.read
  }, (fd, actual) => {
    const writer = paths.get(fd)!
    checks.set(writer, (checks.get(writer) ?? 0) + 1)
    timeline.push(`stat:${writer}`)
    return actual
  }, async () => {
    const reader = readLogSnapshot(root)
    for (const writer of ['a', 'b', 'a']) {
      const next = await reader.next()
      assert.equal(next.value!.pos.writer, writer)
      assert.deepEqual(timeline.slice(-2), ['stat:a', 'stat:b'], 'all captured writers remain guarded before each result')
    }
    assert.equal((await reader.next()).done, true)
    for (let at = 0; at < timeline.length; at++) {
      if (timeline[at].startsWith('done:')) {
        assert.equal(timeline[at + 1], timeline[at].replace('done:', 'stat:'), 'every completed read is guarded before decoding')
      }
    }
    // Two one-chunk passes, EOF checks on both passes, pass-boundary check and three all-writer yield checks.
    assert.equal(asyncStats, 2, 'initial source acquisition retains its existing asynchronous stat boundary')
    assert.deepEqual(checks, new Map([['a', 10], ['b', 10]]))
  })
})

test('in-flight read remains an event-loop boundary and queued consumer return releases the snapshot', async () => {
  for (const signalRead of [true, false]) {
    const { root, write } = fixture()
    const path = write('a', row('a', 1, 'x'.repeat(80_000)) + row('a', 2))
    const before = readFileSync(path)
    let start!: () => void, release!: () => void
    const held = new Promise<void>(resolve => { start = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let reads = 0, active = 0, closes = 0
    let pending: Promise<IteratorResult<unknown>> | undefined, returned: Promise<IteratorResult<unknown>> | undefined
    await instrument(file => {
      active++
      const read = file.read.bind(file), close = file.close.bind(file)
      file.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        if (++reads === 2 && signalRead) { start(); await gate }
        return read(buffer, offset, length, position)
      }) as typeof file.read
      file.close = async () => { try { await close() } finally { active--; closes++ } }
    }, (_fd, actual) => actual, async () => {
      const reader = readLogSnapshot(root)
      try {
        pending = reader.next()
        const missingRead = new Error('next settled before the required held-read callback')
        const readiness = Promise.race([held, pending.then(() => { throw missingRead })])
        if (!signalRead) {
          // Negative control: suppress readiness entirely; next settlement must fail the gate rather than hang.
          await assert.rejects(readiness, error => error === missingRead)
          return
        }
        await readiness
        let returnSettled = false
        returned = reader.return(undefined).then(result => { returnSettled = true; return result })
        // A gated chunk proves the control boundary without elapsed-time/throughput thresholds.
        let eventLoopTurn = false
        await new Promise<void>(resolve => setImmediate(() => { eventLoopTurn = true; resolve() }))
        assert.equal(eventLoopTurn, true)
        assert.equal(returnSettled, false, 'return waits for the already in-flight next operation')
        assert.equal(active, 1)
        release()
        assert.equal((await pending).done, false)
        assert.equal((await returned).done, true)
        assert.equal(active, 0)
        assert.equal(closes, 1)
        assert.equal(reads, 4, 'early return does not read another merge chunk or begin another snapshot')
      } finally {
        release()
        await Promise.allSettled([pending, returned])
        await reader.return(undefined)
      }
    })
    assert.equal(active, 0, 'the absent-callback control also closes its owned descriptor')
    assert.equal(closes, 1)
    assert.deepEqual(readFileSync(path), before)
  }
})


test('one invocation yields every 64 metadata guards across writers and passes and resets the next invocation', async () => {
  const { root, write } = fixture()
  for (let at = 0; at < 65; at++) write(`w${at}`, '')
  const originalImmediate = timers.setImmediate
  let checks = 0, turns = 0
  const checkpoints: number[] = []
  timers.setImmediate = (async (...args: Parameters<typeof originalImmediate>) => {
    checkpoints.push(checks)
    let eventLoopCallback = false
    setImmediate(() => { eventLoopCallback = true })
    const result = await originalImmediate(...args)
    assert.equal(eventLoopCallback, true, 'fairness checkpoints advance the event loop, not only the microtask queue')
    turns++
    return result
  }) as typeof originalImmediate
  syncBuiltinESMExports()
  try {
    await instrument(() => undefined, (_fd, actual) => { checks++; return actual }, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        checks = 0; turns = 0; checkpoints.length = 0
        assert.deepEqual(await Array.fromAsync(readLogSnapshot(root)), [])
        assert.equal(checks, 195, '65 writers each retain both EOF guards and the validation-pass boundary guard')
        assert.deepEqual(checkpoints, [63, 127, 191], 'the guard budget is shared across every writer and both passes')
        assert.equal(turns, 3)
      }
    })
  } finally { timers.setImmediate = originalImmediate; syncBuiltinESMExports() }
})
