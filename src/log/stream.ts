// Development-only bounded snapshot reader. Product M0 polling/cache and its three methods stay unchanged.
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import { decodeLine } from './envelope.ts'
import { LogCorruptError, logFileOf, openLog } from './log.ts'
import type { LogEvent } from './events.ts'
import type { LogPos, LogSeq, WriterId } from '../terms.ts'

const CHUNK_BYTES = 64 * 1024
export const STREAM_LOG_LIMITS = Object.freeze({ maxWriters: 128, maxRowBytes: 1024 * 1024 })

/** Resource refusal is distinct from corrupt authoritative data. Nothing is repaired or dropped. */
export class LogReadLimitError extends Error {
  constructor(message: string) { super(message); this.name = 'LogReadLimitError' }
}
interface Row { pos: LogPos; e: LogEvent }
interface Source { writer: WriterId; file: FileHandle; size: number; mtimeNs: bigint; ctimeNs: bigint; ino: bigint; dev: bigint }

async function unchanged(source: Source): Promise<void> {
  const now = await source.file.stat({ bigint: true })
  if (now.size !== BigInt(source.size) || now.ino !== source.ino || now.dev !== source.dev ||
      now.mtimeNs !== source.mtimeNs || now.ctimeNs !== source.ctimeNs) {
    throw new Error(`日志在快照读取中改变：${source.writer}；请重新读取`)
  }
}

/** Each pass retains one chunk and at most one bounded line. Split UTF8 is decoded only at LF. */
async function* rowsOf(source: Source): AsyncGenerator<Row> {
  const chunk = Buffer.alloc(CHUNK_BYTES)
  let offset = 0, line = 0, length = 0
  let oversized = false
  let parts: Buffer[] = []
  while (offset < source.size) {
    await unchanged(source)
    const want = Math.min(chunk.length, source.size - offset)
    const { bytesRead } = await source.file.read(chunk, 0, want, offset)
    if (bytesRead === 0) throw new Error(`日志快照读取提前结束：${source.writer}`)
    await unchanged(source)
    offset += bytesRead
    let start = 0
    while (start < bytesRead) {
      const lf = chunk.indexOf(0x0a, start)
      const end = lf < 0 || lf >= bytesRead ? bytesRead : lf
      const bytes = end - start
      length += bytes
      if (length > STREAM_LOG_LIMITS.maxRowBytes) { oversized = true; parts = [] }
      else if (bytes > 0 && !oversized) parts.push(Buffer.from(chunk.subarray(start, end)))
      if (end === bytesRead) break
      line++
      // A huge unterminated tail is still ignored; only a complete over-budget row is refused.
      if (oversized) throw new LogReadLimitError(`日志行超过 ${STREAM_LOG_LIMITS.maxRowBytes} 字节：${source.writer} 第 ${line} 行`)
      if (length > 0) {
        const raw = parts.length === 1 ? parts[0]!.toString('utf8') : Buffer.concat(parts, length).toString('utf8')
        const decoded = decodeLine(raw)
        if (!decoded.ok) throw new LogCorruptError(source.writer, line, decoded.reason)
        if (decoded.pos.writer !== source.writer) {
          throw new LogCorruptError(source.writer, line, `信封里的 writer 与文件名不符：${decoded.pos.writer}`)
        }
        parts = []; length = 0
        yield { pos: decoded.pos, e: decoded.event }
      }
      start = end + 1
    }
  }
  // An unterminated suffix is uncommitted, including malformed/partial UTF8 bytes. Pure read never truncates.
  await unchanged(source)
}

/**
 * Two-pass stable snapshot: validate every complete row before yielding anything, then merge one head/writer.
 * Full-file parsed cache is deliberately absent here. Append/rewrite during either pass refuses and can retry.
 * Directory membership is captured once; the next invocation sees appended rows and newly appearing writers.
 */
export function readLogSnapshot(root: string, fromSeq: LogSeq = 0): AsyncGenerator<Row> {
  return readSnapshot(resolve(root), fromSeq)
}

async function* readSnapshot(capturedRoot: string, fromSeq: LogSeq): AsyncGenerator<Row> {
  const log = openLog(capturedRoot)
  let names: WriterId[]
  try { names = await log.writers() } finally { await log.close() }
  if (names.length > STREAM_LOG_LIMITS.maxWriters) {
    throw new LogReadLimitError(`日志 writer 超过 ${STREAM_LOG_LIMITS.maxWriters} 个`)
  }
  const sources: Source[] = []
  const iterators: AsyncGenerator<Row>[] = []
  let refused = false
  try {
    for (const writer of names) {
      let file: FileHandle
      try { file = await open(logFileOf(capturedRoot, writer), 'r') }
      catch (error) { if ((error as { code?: string }).code === 'ENOENT') continue; throw error }
      // Register ownership before stat, so a failed stat still closes this handle.
      const source = { writer, file } as Source
      sources.push(source)
      const st = await file.stat({ bigint: true })
      if (st.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new LogReadLimitError(`日志快照大小不可安全寻址：${writer}`)
      Object.assign(source, { size: Number(st.size), mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, ino: st.ino, dev: st.dev })
    }
    for (const source of sources) for await (const _row of rowsOf(source)) { /* validate before first yield */ }
    for (const source of sources) await unchanged(source)
    const heads: (Row | undefined)[] = []
    async function advance(at: number): Promise<void> {
      for (;;) {
        const next = await iterators[at]!.next()
        if (next.done) { heads[at] = undefined; return }
        if (next.value.pos.seq > fromSeq) { heads[at] = next.value; return }
      }
    }
    for (const source of sources) iterators.push(rowsOf(source))
    for (let at = 0; at < iterators.length; at++) await advance(at)
    for (;;) {
      let best = -1
      for (let at = 0; at < heads.length; at++) {
        const row = heads[at]
        if (row === undefined) continue
        const prior = best < 0 ? undefined : heads[best]
        if (prior === undefined || row.pos.seq < prior.pos.seq ||
            (row.pos.seq === prior.pos.seq && row.pos.writer < prior.pos.writer)) best = at
      }
      if (best < 0) return
      // Mutation of even another writer invalidates the entire captured read, before the next result.
      for (const source of sources) await unchanged(source)
      yield heads[best]!
      await advance(best)
    }
  } catch (error) {
    refused = true
    throw error
  } finally {
    // Settle every owned iterator and descriptor, even when one cleanup rejects.
    await Promise.allSettled(iterators.map(iterator => iterator.return(undefined)))
    const closed = await Promise.allSettled(sources.map(source => Promise.resolve().then(() => source.file.close())))
    const failed = closed.find(result => result.status === 'rejected')
    if (!refused && failed?.status === 'rejected') throw failed.reason
  }
}
