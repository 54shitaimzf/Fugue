// Internal M1 probe: storage format belongs to the repository, never to a caller's OID spelling.
import type { GitHandle } from './git.ts'

/** One read-only plumbing request per successful handle; concurrent callers share it. */
export function objectFormatProbe(git: Pick<GitHandle, 'run'>): () => Promise<20 | 32> {
  let pending: Promise<20 | 32> | undefined
  return () => {
    if (pending !== undefined) return pending
    const attempt = (async (): Promise<20 | 32> => {
      const output = await git.run(['rev-parse', '--show-object-format=storage'])
      if (output.equals(Buffer.from('sha1\n'))) return 20
      if (output.equals(Buffer.from('sha256\n'))) return 32
      // No guessed default, and no arbitrary-size subprocess output in the diagnostic.
      throw new Error('M1 仓库对象格式探测失败：只支持 storage sha1 或 sha256')
    })()
    pending = attempt
    void attempt.catch(() => {
      if (pending === attempt) pending = undefined
    })
    return attempt
  }
}
