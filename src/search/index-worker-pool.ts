// 一个句柄的有限Worker存量：无候补队列，空闲可复用，关闭显式终止。
import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
export interface IndexWorkerPool {
  acquire(): Worker | null
  release(worker: Worker, reusable?: boolean): Promise<void>
  close(): Promise<void>
  stats(): { starts: number; retained: number; idle: number }
}
export function createIndexWorkerPool(root: string, maximum: number, idleMs: number): IndexWorkerPool {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 16 ||
      !Number.isSafeInteger(idleMs) || idleMs < 0 || idleMs > 60000) throw new Error('invalid index worker pool limits')
  const selectedRoot = resolve(root)
  const owned = new Set<Worker>()
  const idle = new Map<Worker, NodeJS.Timeout>()
  const retiring = new Map<Worker, Promise<number>>()
  let closed = false, starts = 0
  let closing: Promise<void> | undefined
  function clearIdle(worker: Worker): void {
    const timer = idle.get(worker)
    if (timer !== undefined) clearTimeout(timer)
    idle.delete(worker)
  }
  function retire(worker: Worker): Promise<number> {
    const waiting = retiring.get(worker)
    if (waiting !== undefined) return waiting
    clearIdle(worker)
    // 存量直到exit才减；终止期间不靠提前减计数超额起新Worker。
    const stopped = worker.terminate().catch(() => -1)
    retiring.set(worker, stopped)
    return stopped
  }
  return {
    acquire() {
      if (closed) return null
      const available = idle.keys().next().value
      if (available !== undefined) { clearIdle(available); available.ref(); return available }
      if (owned.size >= maximum) return null
      const worker = new Worker(new URL('./index-worker.ts', import.meta.url), {
        workerData: { root: selectedRoot }, env: {},
        execArgv: process.execArgv.filter((arg) => arg === '--experimental-strip-types'),
        // Worker代码不输出内容。Node默认stdio不为其消息端口增加持活引用。
        trackUnmanagedFds: true,
      })
      owned.add(worker); starts++
      worker.on('error', () => { void retire(worker) })
      worker.once('exit', () => { clearIdle(worker); owned.delete(worker); retiring.delete(worker) })
      return worker
    },
    async release(worker, reusable = true) {
      const stopping = retiring.get(worker)
      if (stopping !== undefined) { await stopping; return }
      if (!owned.has(worker) || worker.threadId === -1) return
      if (closed || !reusable || idleMs === 0) { await retire(worker); return }
      clearIdle(worker)
      const timer = setTimeout(() => { if (idle.get(worker) === timer) void retire(worker) }, idleMs)
      timer.unref()
      idle.set(worker, timer)
      worker.unref()
    },
    close() {
      if (closing !== undefined) return closing
      closed = true
      for (const worker of owned) clearIdle(worker)
      closing = Promise.all([...owned].map(async (worker) => {
        try { await worker.terminate() } catch { /* 异常Worker也已经退扫描。 */ }
      })).then(() => { owned.clear(); retiring.clear() })
      return closing
    },
    stats() { return { starts, retained: owned.size, idle: idle.size } },
  }
}
