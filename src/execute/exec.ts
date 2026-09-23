// M5 的实现：spawn 与流（架构 § 8.6 的"`M5` 只负责 spawn 与流"）。
//
// **它不认识策略，也不认识路径。** 命令行已经包好了（`confine.ts` 那一份 `ConfinedArgv`），
// 环境已经重写好了（`binding.ts` 那一份），cwd 已经进了 `--chdir`。这一份只做四件事：
// 起进程 · 收两股输出 · 把中止信号与超时转成杀掉它 · 把退出码与耗时报出去。
//
// **`denied` 是读出来的。** 子进程 `open()` 拿 errno 30 (EROFS)，而父进程手里只剩退出码与
// stderr 那一句（S4 前那次实测）——所以这里按 stderr 上的签名判，签名只有这一处。它是一条
// 读数，不是判决：真正的"被拒"由树本身没变来证（X2 的断言）。
import { spawn } from 'node:child_process'
import type { AgentId } from '../terms.ts'
import type { Executor, RunResult, RunSpec } from './contract.ts'

/**
 * 沙箱拒绝的文案集（内核给的 errno 我们读不到，只有这一句）。
 *
 * **`EROFS` 那一支是 X4 补上的**：同一个 errno 30，两种子进程报法不一样——`sh` 那些走
 * `Read-only file system`，而 node 的 `open()` 报 `EROFS: read-only file system, open 'junk.txt'`。
 * 少了它，一次真被内核拒掉的运行会读成 `denied: false`（X4 的②亲眼读到过）。
 */
const DENY = /EROFS|Read-only file system|Permission denied|Operation not permitted/

export interface ExecOptions {
  /**
   * `RunSpec.cwd` 翻成物理路径（架构 § 8.6 那一栏的注：这一步归 `M5`）。
   *
   * 沙箱那一档里它同时进了 `--chdir`，所以这里给不给都跑得对；**退化档里它是唯一的那一处**
   * ——没有沙箱可 `--chdir`，子进程的工作目录就是 `spawn` 的这个 `cwd`。不给就照旧继承
   * 调用者的（单测里那些直接驱动 `confine` 的用例走的就是那条路）。
   */
  readonly cwdOf?: (a: AgentId, rel: string) => string
  /** 超时按杀掉它算，与收到中止信号同一条路。不给就没有超时。 */
  readonly timeoutMs?: number
  /** 过程往哪儿流（命令面接 stderr）。完整的两股仍然在返回值里。 */
  readonly onChunk?: (which: 'stdout' | 'stderr', chunk: string) => void
}

export function createExecutor(opts: ExecOptions = {}): Executor {
  return {
    run(_a: AgentId, spec: RunSpec, signal: AbortSignal): Promise<RunResult> {
      return new Promise<RunResult>((done) => {
        const t0 = Date.now()
        const argv = spec.confined.argv
        const child = spawn(argv[0], argv.slice(1), {
          env: spec.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(opts.cwdOf === undefined ? {} : { cwd: opts.cwdOf(_a, spec.cwd) }),
        })
        let out = ''
        let err = ''
        let settled = false
        let timer: NodeJS.Timeout | null = null

        const finish = (exit: number): void => {
          if (settled) return
          settled = true
          if (timer !== null) clearTimeout(timer)
          signal.removeEventListener('abort', kill)
          done({
            exit,
            ms: Date.now() - t0,
            denied: DENY.test(err),
            enforcement: spec.confined.enforcement,
            stdout: out,
            stderr: err,
          })
        }
        function kill(): void {
          child.kill('SIGKILL')
        }

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (s: string) => {
          out += s
          opts.onChunk?.('stdout', s)
        })
        child.stderr.on('data', (s: string) => {
          err += s
          opts.onChunk?.('stderr', s)
        })
        // 起不来（比如 bwrap 不在）也走同一条收尾：退出码非 0，那几句话进 stderr。
        child.on('error', (e: Error) => {
          err += `${e.message}\n`
          finish(1)
        })
        child.on('close', (code: number | null, sig: NodeJS.Signals | null) => {
          if (sig !== null && code === null) err += `被 ${sig} 杀掉\n`
          finish(code ?? 1)
        })

        if (signal.aborted) kill()
        else signal.addEventListener('abort', kill, { once: true })
        if (opts.timeoutMs !== undefined) timer = setTimeout(kill, opts.timeoutMs)
      })
    },
  }
}
