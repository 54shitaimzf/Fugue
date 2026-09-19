// M1 的进程层。**M1 只有这一个地方起 git 进程**——这条性质本身是一条断言（PLAN § 5 U2 ③），
// 所以起进程的计数就在这里，`spawns()` 报的是真实起点，不是估计。
//
// 两条纪律落在本文件里：
//
// 一 · **读走批量。** `git cat-file --batch-command` 一个子进程处理全部读请求。逐文件起
// 进程的代价几乎全是进程创建（架构 § 8.2：`rev-parse` 与 `hash-object` 耗时相同即为证），
// 500 个 blob 光这一步就是 500 ms 量级，直接把一轮预算吃掉一半。
//
// **批量要批到请求这一层，不只是进程这一层。** 一个目录的 500 个条目，若每条各写一次
// 请求，进程数是一个、往返数还是 500——所以 `objectMany` 把一整批请求一次写完、一次收完。
//
// **退化档：逐次读。** `read: 'oneshot'` 可以显式选它，批量子进程死掉时也自动退回去；
// 这时一批请求仍是一个进程（一次调用一个进程），只是没有那个跨调用的长命子进程。
// 判据是 AGENTS 第五节那句话——那个机制死掉的时候，系统是**变慢**，不是跑不起来。
//
// 二 · **每次调用都是 plumbing，且带 `gc.auto=0`**（架构 § 8.2 硬约束 3）。porcelain
// 命令会碰索引与工作树，一条都不用——M1 不碰 HEAD、不碰索引、不碰工作树。
//
// 那个子进程**不是常驻进程**：它的生命周期严格短于发起它的那一次 `fugue` 调用，随父进程
// 退出而消失，不持有任何跨调用的状态。§ 9.6 的"单次进程 + 每次重建"没有被破坏。
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'

/** 读的档位。`oneshot` 是退化档，不是另一条实现。 */
export type ReadTier = 'batch' | 'oneshot'

export interface ObjectReply {
  type: string
  size: number
  /** `info` 档恒为空——那一档要的就是"不把内容读回来"。 */
  body: Buffer
}

export interface RunResult {
  status: number
  stdout: Buffer
  stderr: string
}

export class GitError extends Error {
  readonly argv: readonly string[]
  readonly status: number
  readonly stderr: string

  constructor(argv: readonly string[], status: number, stderr: string) {
    super(`git ${argv.join(' ')} 退出码 ${status}${stderr.trim() === '' ? '' : '：' + stderr.trim()}`)
    this.name = 'GitError'
    this.argv = argv
    this.status = status
    this.stderr = stderr
  }
}

export interface GitHandle {
  readonly root: string
  readonly gitDir: string
  /** 这个句柄起过多少个 git 进程。 */
  spawns(): number
  /** 这个句柄向 git 发过多少次请求。批量档下它大于进程数——那正是批量的意义。 */
  requests(): number
  /** 当前实际在用的读档位——批量子进程死掉之后这里会变成 `oneshot`。 */
  readTier(): ReadTier
  tryRun(args: readonly string[], input?: string | Uint8Array): Promise<RunResult>
  run(args: readonly string[], input?: string | Uint8Array): Promise<Buffer>
  object(want: 'info' | 'contents', id: string): Promise<ObjectReply | null>
  objectMany(want: 'info' | 'contents', ids: readonly string[]): Promise<Array<ObjectReply | null>>
  close(): Promise<void>
}

/**
 * 从 `process.env` 里抹掉的 git 变量：它们会把 `--git-dir` 顶掉，或者把对象库换到别处。
 * 不抹的话，"工作区在哪"就由调用者的环境决定，而不由参数决定。
 */
const SCRUBBED: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
]

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of SCRUBBED) delete env[k]
  // 用户级与系统级配置一律不读：`gc.auto` 之类不能由机器上碰巧装了什么决定。
  // 身份显式给出——`commit-tree` 需要它，而"提交的作者是谁"不该取决于谁在跑测试。
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'fugue',
    GIT_AUTHOR_EMAIL: 'fugue@localhost',
    GIT_COMMITTER_NAME: 'fugue',
    GIT_COMMITTER_EMAIL: 'fugue@localhost',
  }
}

const EMPTY = Buffer.alloc(0)

/**
 * 解一条 `cat-file` 回复。够不够一条回复由这里判定，所以批量子进程与逐次调用共用它——
 * `info` 只要头一行，`contents` 要头 + `size` 字节 + 一个换行。**树对象里是可以有换行的**，
 * 所以内容必须按字节数读，不能按行读。
 */
function parseReply(
  buf: Buffer,
  want: 'info' | 'contents',
): { reply: ObjectReply | null; rest: Buffer } | null {
  const nl = buf.indexOf(0x0a)
  if (nl === -1) return null
  const line = buf.subarray(0, nl).toString('utf8')
  const parts = line.split(' ')
  if (parts.length === 2 && parts[1] === 'missing') {
    return { reply: null, rest: buf.subarray(nl + 1) }
  }
  if (parts.length < 3) throw new Error(`cat-file 的回复解不开：${JSON.stringify(line)}`)
  const size = Number(parts[2])
  if (!Number.isInteger(size) || size < 0) {
    throw new Error(`cat-file 给的 size 不是非负整数：${JSON.stringify(line)}`)
  }
  if (want === 'info') {
    return { reply: { type: parts[1], size, body: EMPTY }, rest: buf.subarray(nl + 1) }
  }
  const end = nl + 1 + size + 1
  if (buf.length < end) return null
  return {
    reply: { type: parts[1], size, body: buf.subarray(nl + 1, nl + 1 + size) },
    rest: buf.subarray(end),
  }
}

/** 一批请求。一次 `ask` = 一次写入 = 一次往返，不管里面几条。 */
interface Pending {
  want: 'info' | 'contents'
  count: number
  replies: Array<ObjectReply | null>
  resolve: (r: Array<ObjectReply | null>) => void
  reject: (e: unknown) => void
}

interface Batch {
  ask(want: 'info' | 'contents', ids: readonly string[]): Promise<Array<ObjectReply | null>>
  kill(): Promise<void>
}

export function openGit(root: string, opts: { read?: ReadTier } = {}): GitHandle {
  const gitDir = join(root, '.git')
  let st
  try {
    st = statSync(gitDir)
  } catch {
    throw new Error(`找不到对象库：${gitDir} —— M1 不建仓库；真源是既有的 git 对象库（架构 § 9.1）`)
  }
  if (!st.isDirectory()) throw new Error(`对象库不是一个目录：${gitDir}`)

  const env = gitEnv()
  // `-c gc.auto=0` 是架构 § 8.2 的硬约束 3：自动 gc 由任何一次 porcelain 调用触发，
  // 而 gc 与并发写者共用对象库是错的。这里每条命令都带上它，不指望仓库配置里有。
  const prefix: readonly string[] = ['--git-dir=' + gitDir, '-c', 'gc.auto=0']
  let spawns = 0
  let requests = 0
  let tier: ReadTier = opts.read ?? 'batch'
  let batch: Batch | undefined

  async function tryRun(args: readonly string[], input?: string | Uint8Array): Promise<RunResult> {
    spawns++
    requests++
    const child = spawn('git', [...prefix, ...args], {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    // 子进程早退时写 stdin 会得到 EPIPE；那不是这里的错，退出码才是判据。
    child.stdin.on('error', () => undefined)
    child.stdin.end(input ?? '')
    const status = await new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code, signal) => resolve(code ?? (signal === null ? 1 : 128)))
    })
    return { status, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }
  }

  async function run(args: readonly string[], input?: string | Uint8Array): Promise<Buffer> {
    const r = await tryRun(args, input)
    if (r.status !== 0) throw new GitError(args, r.status, r.stderr)
    return r.stdout
  }

  function startBatch(): Batch {
    spawns++
    const argv = [...prefix, 'cat-file', '--batch-command']
    const child: ChildProcess = spawn('git', argv, {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buf = Buffer.alloc(0)
    let dead: Error | undefined
    let closed = false
    const pending: Pending[] = []
    const errChunks: Buffer[] = []

    const die = (err: Error): void => {
      if (dead !== undefined) return
      dead = err
      for (const w of pending.splice(0)) w.reject(err)
    }

    function pump(): void {
      while (pending.length > 0) {
        const head = pending[0]
        const parsed = parseReply(buf, head.want)
        if (parsed === null) return
        buf = parsed.rest
        head.replies.push(parsed.reply)
        if (head.replies.length === head.count) {
          pending.shift()
          head.resolve(head.replies)
        }
      }
    }

    child.stdout?.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      pump()
    })
    child.stderr?.on('data', (d: Buffer) => errChunks.push(d))
    child.stdin?.on('error', (e: Error) => die(e))
    child.on('error', (e: Error) => die(e))
    child.on('close', (code) => {
      closed = true
      const why = Buffer.concat(errChunks).toString('utf8').trim()
      die(new Error(`cat-file --batch-command 退出（${code}）${why === '' ? '' : '：' + why}`))
    })

    function ask(
      want: 'info' | 'contents',
      ids: readonly string[],
    ): Promise<Array<ObjectReply | null>> {
      if (dead !== undefined) return Promise.reject(dead)
      return new Promise<Array<ObjectReply | null>>((resolve, reject) => {
        if (ids.length === 0) {
          resolve([])
          return
        }
        requests++
        pending.push({ want, count: ids.length, replies: [], resolve, reject })
        child.stdin?.write(ids.map((id) => `${want} ${id}\n`).join(''))
      })
    }

    async function kill(): Promise<void> {
      if (closed) return
      await new Promise<void>((resolve) => {
        child.once('close', () => resolve())
        child.kill('SIGTERM')
      })
    }

    return { ask, kill }
  }

  /** 退化档：一次调用一个进程，但**一批请求仍然只发一个进程**。 */
  async function oneShotMany(
    want: 'info' | 'contents',
    ids: readonly string[],
  ): Promise<Array<ObjectReply | null>> {
    if (ids.length === 0) return []
    const args = want === 'contents' ? ['cat-file', '--batch'] : ['cat-file', '--batch-check']
    const r = await tryRun(args, ids.map((id) => id + '\n').join(''))
    const out: Array<ObjectReply | null> = []
    let rest = r.stdout
    for (let i = 0; i < ids.length; i++) {
      const parsed = parseReply(rest, want)
      if (parsed === null) {
        if (r.status !== 0) throw new GitError(args, r.status, r.stderr)
        throw new Error(`cat-file 只回了 ${i} / ${ids.length} 条`)
      }
      out.push(parsed.reply)
      rest = parsed.rest
    }
    return out
  }

  async function objectMany(
    want: 'info' | 'contents',
    ids: readonly string[],
  ): Promise<Array<ObjectReply | null>> {
    if (tier === 'batch') {
      try {
        if (batch === undefined) batch = startBatch()
        return await batch.ask(want, ids)
      } catch {
        // 批量读这一档死了。**退到逐次读，不是把错误抛给调用者**——读是幂等的，
        // 在途的那一批重发一次没有副作用。退化之后本句柄不再尝试批量。
        batch = undefined
        tier = 'oneshot'
      }
    }
    return oneShotMany(want, ids)
  }

  async function object(want: 'info' | 'contents', id: string): Promise<ObjectReply | null> {
    return (await objectMany(want, [id]))[0]
  }

  async function close(): Promise<void> {
    const b = batch
    batch = undefined
    if (b !== undefined) await b.kill()
  }

  return {
    root,
    gitDir,
    spawns: () => spawns,
    requests: () => requests,
    readTier: () => tier,
    tryRun,
    run,
    object,
    objectMany,
    close,
  }
}
