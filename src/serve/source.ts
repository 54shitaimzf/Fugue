// 事件通道的**客户端一头**：界面读账的**唯一一条路**。出处：架构 § 9.11 的「事件通道」那一段
// （通道的来源是账本尾随 · 一趟调用回一趟事 · 响应里带这一趟读到的事件与下一趟要用的游标 ·
// 游标是每个 writer 一个、语义是排他下界）与「多端附着」那一段（命绑客户端：客户端一走，
// 服务端就收）。
//
// 这一份把那条通道收成一个接口：`pass(resume)` 问一趟、拿回这一趟的事件与下一趟要用的游标串。
// **界面的读源到此为止**——`src/ui/` 那一侧不再有人开账本口、也不再有人顺着账本口扫；
// `log/log.ts` 与 `probe/watch.ts` 这两条直连住在 serve 那一头（它按请求开、按请求关）。
//
// **命绑客户端**：进程是这一份拉起来的（`spawn`），也是这一份收掉的（`close()` → `shutdown`
// 之后关掉 stdin）。§ 9.11「不引守护进程」在这一份上就是这一句——没有第二条常驻的路。
//
// `rowsReaderOf` 是**同一批行的另一种读法**，不是第二个读源：界面手上那些行本来就是这条通道
// 送来的，`pendingOf` 那一族要一个 `LogReader`，于是把那些行按 `readByWriter` 的形状露一遍。
// 它不开文件、不碰账本、不看时刻——纯函数对已经拿到的那些行。
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { LogEvent, LogReader } from '../log/events.ts'
import type { WriterId } from '../terms.ts'
import type { StatusRow } from '../probe/status.ts'
import { PROTOCOL_VERSION } from '../protocol.ts'
import { JSONRPC, PROTOCOL_PARAM } from './wire.ts'

/** 一趟尾随的结果：这一趟读到的事件（到达序）与**下一趟要用的游标串**（§ 9.11）。 */
export interface SourcePass {
  readonly rows: readonly StatusRow[]
  /** 下一趟要带的游标串——串形与 `--resume` 那个一样（`writer:seq,…`）。空串 = 从头。 */
  readonly resume: string
}

/** 握手那一份回执里这一份用得到的那几栏。 */
export interface SourceHello {
  readonly protocol: string
  readonly product: string
  readonly methods: readonly string[]
}

/** 界面读账的那条路。**读源到此为止**。 */
export interface LedgerSource {
  /** 握手报出来的那一份（协议版本 · 安装版本 · 方法面）。 */
  readonly hello: SourceHello
  /** 一趟调用回一趟事：给上一趟带回来的游标串，还这一趟的那些行与下一趟的游标串。 */
  pass(resume: string): Promise<SourcePass>
  /** 收掉这一条（`shutdown` + 关 stdin）。幂等。 */
  close(): Promise<void>
}

/** 一条回执（成功那一栏按需取，失败那一栏非空就是失败）。 */
interface Reply {
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

export interface ServeSourceOptions {
  readonly root: string
  /**
   * 跑哪一份 CLI（缺省就是这一份代码的 `src/cli/fugue.ts`）。**测试给替身**：一条不进真子进程的
   * 假服务端接得上同一个接口。产品路径上永远不给。
   */
  readonly cli?: string
  /** 收尾时等子进程自己走多久（毫秒）；到点还在就强收。 */
  readonly killAfterMs?: number
}

/** 收尾等子进程自己走多久。**它不是超时策略**：`shutdown` 之后那一头已经不再接新请求，
 * 这一档只是不让一个卡住的子进程拖住界面的退出。 */
export const CLOSE_WAIT_MS = 1_000

/**
 * 开一条：拉起 serve，握一次手，之后 `pass()` 一趟一趟地问。
 *
 * 起不来（子进程当场死）就在握手那一步抛——**不静默降级成"账上没有事件"**：那两件事长得一样，
 * 而人看着一块空面板没法判断是自己账空还是这条路断了。
 */
export async function openServeSource(o: ServeSourceOptions): Promise<LedgerSource> {
  const cli = o.cli ?? fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))
  const child: ChildProcess = spawn(process.execPath, [cli, '--root', o.root, 'serve'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  let errBuf = ''
  const waiting = new Map<number, (r: Reply) => void>()
  let nextId = 1
  let died: string | null = null
  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const raw of parts) {
      if (raw.trim() === '') continue
      const msg = JSON.parse(raw) as Reply & { id?: number }
      const done = msg.id === undefined ? undefined : waiting.get(msg.id)
      if (done === undefined) continue
      waiting.delete(msg.id as number)
      done(msg)
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    errBuf += chunk.toString('utf8')
  })
  child.on('close', (code) => {
    died = `serve 那一头退了（退出码 ${code ?? '?'}）${errBuf === '' ? '' : `：${errBuf.trim()}`}`
    for (const [, done] of waiting) done({ error: { code: -32000, message: died } })
    waiting.clear()
  })
  const ask = (method: string, params: Record<string, unknown> = {}): Promise<Reply> =>
    new Promise((done) => {
      const id = nextId
      nextId += 1
      waiting.set(id, done)
      child.stdin?.write(
        JSON.stringify({ jsonrpc: JSONRPC, id, method, params: { [PROTOCOL_PARAM]: PROTOCOL_VERSION, ...params } }) + '\n',
      )
    })

  const init = await ask('initialize')
  if (init.error !== undefined) throw new Error(`serve 握手失败：${init.error.message}`)
  const hello = init.result as SourceHello

  let closed = false
  return {
    hello,
    async pass(resume: string): Promise<SourcePass> {
      if (closed) throw new Error('这一条已经收尾了')
      const r = await ask('watch', resume === '' ? {} : { resume })
      if (r.error !== undefined) throw new Error(`事件通道那一趟没成：${r.error.message}`)
      const result = r.result as { stdout: string; result?: { resume?: string } }
      const rows: StatusRow[] = []
      for (const line of result.stdout.split('\n')) {
        if (line === '') continue
        rows.push(JSON.parse(line) as StatusRow)
      }
      return { rows, resume: result.result?.resume ?? resume }
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      // **收尾**：`shutdown` 只停止接受新请求（§ 9.11）；真正结束靠关掉 stdin——命绑客户端。
      try {
        await ask('shutdown')
      } catch {
        /* 那一头已经不在了：下面照收 */
      }
      try {
        child.stdin?.end()
      } catch {
        /* 已经关了 */
      }
      await new Promise<void>((done) => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          done()
        }
        child.on('close', finish)
        const t = setTimeout(() => {
          child.kill('SIGKILL')
          finish()
        }, o.killAfterMs ?? CLOSE_WAIT_MS)
        t.unref()
      })
    },
  }
}

/**
 * 手上这些行按 `readByWriter` 的形状露一遍——`pendingOf` 那一族要一个 `LogReader`。
 *
 * **它不是第二个读源**：行是事件通道送来的那一批，这一份只做筛选（按 writer · 按排他下界）。
 * 语义与 `log/log.ts` 的 `readByWriter` 逐条对上：`fromSeq` 是排他下界，产出序按 `seq`。
 */
export function rowsReaderOf(rows: readonly StatusRow[]): LogReader {
  return {
    async *readByWriter(w: WriterId, fromSeq = 0): AsyncGenerator<LogEvent> {
      for (const r of rows) {
        if (r.pos.writer !== w) continue
        if (r.pos.seq <= fromSeq) continue
        yield r.e
      }
    },
  }
}
