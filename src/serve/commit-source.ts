// Accepted commit changes are git-derived read data; no event/log read or workspace writes.
import { spawn } from 'node:child_process'
export interface CommitRequest {
  readonly round: string
  readonly base: string
  readonly commit: string
}
export interface CommitChanges extends CommitRequest {
  readonly files: readonly { readonly kind: 'A' | 'M' | 'D' | 'T'; readonly path: string }[]
}
/** Exact recorded commits; no rename heuristics or current HEAD/disk inference. */
export function openCommitSource(o: { readonly root: string; readonly git?: string; readonly timeoutMs?: number }) {
  const jobs = new Map<AbortController, Promise<CommitChanges | null>>()
  let closed = false
  return {
    read(request: CommitRequest, signal?: AbortSignal): Promise<CommitChanges | null> {
      if (closed || signal?.aborted || !/^[a-f0-9]{40}$/.test(request.base) || !/^[a-f0-9]{40}$/.test(request.commit)) return Promise.resolve(null)
      const controller = new AbortController(), cancel = (): void => controller.abort()
      signal?.addEventListener('abort', cancel, { once: true })
      const done = new Promise<CommitChanges | null>(resolve => {
        const child = spawn(o.git ?? 'git', ['-C', o.root, 'diff', '--no-ext-diff', '--no-textconv', '--name-status', '--no-renames', '-z', request.base, request.commit, '--'], { stdio: ['ignore', 'pipe', 'ignore'] })
        const parts: Buffer[] = []; let size = 0, failed = false
        const stop = (): void => { failed = true; child.kill('SIGKILL') }
        controller.signal.addEventListener('abort', stop, { once: true })
        const timer = setTimeout(cancel, o.timeoutMs ?? 3_000); timer.unref()
        child.stdout.on('data', (part: Buffer) => {
          size += part.length
          if (size > 1_048_576) { cancel(); return }
          parts.push(part)
        })
        child.on('error', () => { failed = true })
        child.on('close', code => {
          clearTimeout(timer); controller.signal.removeEventListener('abort', stop)
          if (failed || code !== 0 || controller.signal.aborted) { resolve(null); return }
          let text: string
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)) } catch { resolve(null); return }
          const fields = text === '' ? [] : text.split('\0')
          if (fields.length > 0 && fields.pop() !== '') { resolve(null); return }
          const files: CommitChanges['files'][number][] = []
          for (let i = 0; i < fields.length; i += 2) {
            const kind = fields[i], path = fields[i + 1]
            if (!['A', 'M', 'D', 'T'].includes(kind!) || path === undefined || path === '') { resolve(null); return }
            files.push({ kind: kind as 'A' | 'M' | 'D' | 'T', path })
          }
          resolve({ ...request, files })
        })
      }).finally(() => { signal?.removeEventListener('abort', cancel); jobs.delete(controller) })
      jobs.set(controller, done); return done
    },
    async close(): Promise<void> {
      closed = true
      for (const controller of jobs.keys()) controller.abort()
      await Promise.allSettled(jobs.values())
    },
  }
}
