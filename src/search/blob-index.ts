// ROADMAP § 4 / 0.3.2 · miss 不等构建：主查询回扫描，受控后台任务随后补索引。
import { Worker } from 'node:worker_threads'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { BlobId } from '../terms.ts'
import { cleanupIndexTemporary, createBlobIndexStore } from './index-store.ts'
import { encodeBlobIndex, MAX_INDEX_BYTES, MAX_TRIGRAMS } from './index-format.ts'
import type { BlobIndex } from './index-format.ts'
import { copyIndexSource } from './index-source.ts'

export interface BlobIndexLookup {
  mightContain(blob: BlobId, required: readonly string[]): Promise<boolean | null>
}
export interface IndexLookupStats {
  readonly queries: number; readonly memoryHits: number; readonly sharedLoads: number
  readonly diskHits: number; readonly sourceReads: number; readonly builds: number
  readonly unsavedBuilds: number; readonly scanFallbacks: number; readonly evictions: number
  readonly entries: number; readonly grams: number; readonly serializedBytes: number; readonly pending: number; readonly workers: number
}
export interface IndexLookupHandle extends BlobIndexLookup {
  stats(): IndexLookupStats
  /** 开发/收尾显式等已接受任务；主查询不得拿它当 miss 的前置条件。 */
  drain(): Promise<void>
  close(): Promise<void>
}
export interface IndexLookupOptions {
  readonly maxRecords?: number; readonly maxGrams?: number
  readonly maxSerializedBytes?: number; readonly maxPending?: number
  readonly maxBuildMs?: number; readonly signal?: AbortSignal
}
interface PreparedIndex { readonly grams: ReadonlySet<number>; readonly serializedBytes: number }
interface LoadTask {
  readonly blob: BlobId; readonly temporaryId: string; readonly abort: AbortController
  readonly query: Promise<PreparedIndex | null>; readonly done: Promise<void>
  readonly answer: (value: PreparedIndex | null) => void; readonly finish: () => void
  timer?: NodeJS.Timeout; worker?: Worker; canceled: boolean; settled: boolean
}
function gramKey(gram: string): number {
  return gram.charCodeAt(0) * 0x1_0000_0000 + gram.charCodeAt(1) * 0x1_0000 + gram.charCodeAt(2)
}
function limit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const chosen = value ?? fallback
  if (!Number.isSafeInteger(chosen) || chosen < 0 || chosen > maximum) throw new Error(`invalid index ${name} limit`)
  return chosen
}

export function createBlobIndexLookup(
  root: string,
  source: (blob: BlobId, signal: AbortSignal) => Promise<Uint8Array>,
  options: IndexLookupOptions = {},
): IndexLookupHandle {
  const selectedRoot = resolve(root)
  const maxRecords = limit(options.maxRecords, 256, 4096, 'record')
  const maxGrams = limit(options.maxGrams, 1_000_000, 4_000_000, 'gram')
  const maxBytes = limit(options.maxSerializedBytes, 16 * 1024 * 1024, 64 * 1024 * 1024, 'serialized-byte')
  const maxPending = limit(options.maxPending, 4, 16, 'pending')
  const maxBuildMs = limit(options.maxBuildMs, 60_000, 120_000, 'build-time')
  const store = createBlobIndexStore(selectedRoot)
  const cache = new Map<BlobId, PreparedIndex>()
  const pending = new Map<BlobId, LoadTask>()
  const counters = { queries: 0, memoryHits: 0, sharedLoads: 0, diskHits: 0,
    sourceReads: 0, builds: 0, unsavedBuilds: 0, scanFallbacks: 0, evictions: 0 }
  let grams = 0, serializedBytes = 0, closed = false
  let closing: Promise<void> | undefined

  function remember(blob: BlobId, index: PreparedIndex): void {
    if (closed || maxRecords === 0 || index.grams.size > maxGrams || index.serializedBytes > maxBytes) return
    while (cache.size >= maxRecords || grams + index.grams.size > maxGrams || serializedBytes + index.serializedBytes > maxBytes) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      const victim = cache.get(oldest)!
      cache.delete(oldest); grams -= victim.grams.size; serializedBytes -= victim.serializedBytes
      counters.evictions++
    }
    cache.set(blob, index); grams += index.grams.size; serializedBytes += index.serializedBytes
  }
  function prepared(index: BlobIndex): PreparedIndex {
    return { grams: new Set(index.tables.trigrams.map(gramKey)), serializedBytes: encodeBlobIndex(index).byteLength }
  }
  function complete(task: LoadTask): void {
    if (task.settled) return
    task.settled = true
    if (task.timer !== undefined) clearTimeout(task.timer)
    if (pending.get(task.blob) === task) pending.delete(task.blob)
    task.finish()
  }
  async function cancel(task: LoadTask): Promise<void> {
    if (task.settled) return
    task.canceled = true; task.abort.abort(); task.answer(null)
    if (task.worker !== undefined) {
      try { await task.worker.terminate() } catch { /* 当前任务仍退为 scan。 */ }
    }
    await cleanupIndexTemporary(selectedRoot, task.blob, task.temporaryId)
    complete(task)
  }
  async function build(task: LoadTask): Promise<void> {
    counters.sourceReads++
    const bytes = await source(task.blob, task.abort.signal)
    if (closed || task.canceled) return
    const ownedBytes = copyIndexSource(bytes)
    if (ownedBytes === null) return
    const worker = new Worker(new URL('./index-worker.ts', import.meta.url), {
      workerData: { root: selectedRoot, blob: task.blob, bytes: ownedBytes, temporaryId: task.temporaryId },
      env: {}, execArgv: process.execArgv.filter((arg) => arg === '--experimental-strip-types'),
      stdout: true, stderr: true, trackUnmanagedFds: true, transferList: [ownedBytes.buffer],
    })
    task.worker = worker
    worker.stdout?.resume(); worker.stderr?.resume()
    const result = await new Promise<PreparedIndex | null>((done) => {
      worker.once('message', (message) => {
        if (message?.ok !== true || !(message.keys instanceof Float64Array) || message.keys.length > MAX_TRIGRAMS || !Number.isSafeInteger(message.serializedBytes) || message.serializedBytes < 0 || message.serializedBytes > MAX_INDEX_BYTES) return done(null)
        const keys = [...message.keys] as number[]
        if (keys.some((key) => !Number.isSafeInteger(key) || key < 0 || key > 0xffff_ffff_ffff)) return done(null)
        if (!task.canceled && !closed) { counters.builds++; if (message.stored !== true) counters.unsavedBuilds++ }
        done({ grams: new Set(keys), serializedBytes: message.serializedBytes })
      })
      worker.once('error', () => done(null))
      worker.once('exit', () => done(null))
    })
    try { await worker.terminate() } catch { /* worker 已退出也是正常收尾。 */ }
    if (result !== null && !closed && !task.canceled) remember(task.blob, result)
  }
  async function probe(task: LoadTask): Promise<void> {
    try {
      const index = await store.read(task.blob)
      if (task.canceled || closed) return
      if (index !== null) {
        counters.diskHits++
        const result = prepared(index)
        remember(task.blob, result); task.answer(result)
      } else {
        // query 已返回 null；后续 source/CPU/持久化不在主查询等待链上。
        task.answer(null)
        await new Promise<void>((ready) => setImmediate(ready))
        if (!closed && !task.canceled) await build(task)
      }
    } catch { task.answer(null) }
    finally {
      task.answer(null)
      if (task.worker !== undefined) await cleanupIndexTemporary(selectedRoot, task.blob, task.temporaryId)
      complete(task)
    }
  }
  function lookup(blob: BlobId): Promise<PreparedIndex | null> {
    if (closed) return Promise.resolve(null)
    const found = cache.get(blob)
    if (found !== undefined) { cache.delete(blob); cache.set(blob, found); counters.memoryHits++; return Promise.resolve(found) }
    const waiting = pending.get(blob)
    if (waiting !== undefined) { counters.sharedLoads++; return waiting.query }
    if (pending.size >= maxPending || maxBuildMs === 0) return Promise.resolve(null)
    let answer!: LoadTask['answer'], finish!: LoadTask['finish']
    const query = new Promise<PreparedIndex | null>((done) => { answer = done })
    const done = new Promise<void>((resolveDone) => { finish = resolveDone })
    const task: LoadTask = { blob, temporaryId: randomBytes(12).toString('hex'), abort: new AbortController(), query, done, answer, finish, canceled: false, settled: false }
    pending.set(blob, task)
    task.timer = setTimeout(() => { void cancel(task).catch(() => complete(task)) }, maxBuildMs)
    void probe(task).catch(() => { task.answer(null); complete(task) })
    return query
  }
  function close(): Promise<void> {
    if (closing !== undefined) return closing
    closed = true
    options.signal?.removeEventListener('abort', onAbort)
    closing = (async () => {
      await Promise.all([...pending.values()].map(cancel))
      cache.clear(); grams = 0; serializedBytes = 0
    })()
    return closing
  }
  function onAbort(): void { void close().catch(() => {}) }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()

  return {
    async mightContain(blob, required) {
      counters.queries++
      const length = required.length
      if (closed || !((blob.length === 40 || blob.length === 64) && /^[0-9a-f]+$/.test(blob)) || length === 0 || length > 256) { counters.scanFallbacks++; return null }
      const keys: number[] = []
      for (let at = 0; at < length; at++) {
        const gram = required[at]
        if (typeof gram !== 'string' || gram.length !== 3) { counters.scanFallbacks++; return null }
        keys.push(gramKey(gram))
      }
      const index = await lookup(blob)
      if (index === null) { counters.scanFallbacks++; return null }
      return keys.every((key) => index.grams.has(key))
    },
    stats() { return { ...counters, entries: cache.size, grams, serializedBytes, pending: pending.size, workers: [...pending.values()].filter((task) => task.worker !== undefined && task.worker.threadId !== -1).length } },
    async drain() {
      for (;;) { const tasks = [...pending.values()]; if (tasks.length === 0) return; await Promise.all(tasks.map((task) => task.done)) }
    },
    close,
  }
}
