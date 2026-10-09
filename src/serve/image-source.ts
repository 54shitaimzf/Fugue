// 图片走已有 read 命令的带外字节；账的读源仍只有 source.ts 的事件通道。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { MAX_PNG_BYTES } from '../ui/png.ts'
import { imageIsValid } from '../ui/image-codec.ts'
import type { PixelImage } from '../ui/image-codec.ts'

export interface ImageRequest {
  readonly agent: string
  readonly path: string
  readonly blob: string
}
export interface ImageSourceOptions {
  readonly root: string
  /** 测试替换 CLI；产品路径不给。 */
  readonly cli?: string
  /** 覆盖整趟读与解码，到期退文字。 */
  readonly timeoutMs?: number
}

function readBytes(o: ImageSourceOptions, r: ImageRequest, signal: AbortSignal): Promise<Buffer | null> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(null); return }
    const cli = o.cli ?? fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))
    const child = spawn(process.execPath, [cli, '--root', o.root, '--agent', r.agent, 'read', r.path], { stdio: ['ignore', 'pipe', 'ignore'] })
    const parts: Buffer[] = []; let length = 0, failed = false
    const cancel = (): void => { failed = true; child.kill('SIGKILL') }
    signal.addEventListener('abort', cancel, { once: true })
    child.stdout.on('data', (part: Buffer) => {
      if (failed) return
      length += part.length
      if (length > MAX_PNG_BYTES) { cancel(); return }
      parts.push(part)
    })
    child.on('error', () => { failed = true })
    child.on('close', code => {
      signal.removeEventListener('abort', cancel)
      resolve(failed || code !== 0 || signal.aborted ? null : Buffer.concat(parts))
    })
  })
}

function decodeAsync(bytes: Buffer, signal: AbortSignal): Promise<PixelImage | null> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(null); return }
    const input = Uint8Array.from(bytes)
    const worker = new Worker(new URL('../ui/png-worker.ts', import.meta.url), { workerData: input, transferList: [input.buffer] })
    let image: PixelImage | null = null, failed = false
    const cancel = (): void => { failed = true; void worker.terminate() }
    signal.addEventListener('abort', cancel, { once: true })
    worker.on('message', (value: PixelImage | null) => { image = value !== null && imageIsValid(value) ? value : null })
    worker.on('error', () => { failed = true })
    worker.on('exit', code => {
      signal.removeEventListener('abort', cancel)
      resolve(failed || code !== 0 || signal.aborted ? null : image)
    })
  })
}

/** 请求与客户端同命；失败只退预览，保留路径，不影响事件通道。 */
export function openImageSource(o: ImageSourceOptions) {
  const jobs = new Map<AbortController, Promise<PixelImage | null>>()
  let closed = false
  return {
    read(request: ImageRequest, signal?: AbortSignal): Promise<PixelImage | null> {
      if (closed || signal?.aborted || !/^[a-f0-9]{40}$/.test(request.blob)) return Promise.resolve(null)
      const controller = new AbortController()
      const cancel = (): void => controller.abort()
      signal?.addEventListener('abort', cancel, { once: true })
      const timer = setTimeout(cancel, o.timeoutMs ?? 3_000)
      timer.unref()
      const done = (async (): Promise<PixelImage | null> => {
        const bytes = await readBytes(o, request, controller.signal)
        if (bytes === null || controller.signal.aborted) return null
        const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
        if (blob !== request.blob) return null
        return await decodeAsync(bytes, controller.signal)
      })().catch(() => null).finally(() => {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel); jobs.delete(controller)
      })
      jobs.set(controller, done)
      return done
    },
    async close(): Promise<void> {
      closed = true
      for (const controller of jobs.keys()) controller.abort()
      await Promise.allSettled(jobs.values())
    },
  }
}
