// 真终端那一档的跑手。出处：0.2.6 ①（PR15 审查件 § 2 采纳 1 · 路线图 0.2.6 行）。
//
// 三件本机事实决定了它的形状，逐条都是实测撞出来的：
//
//   1. **node 没有 pty。** 借 `script`（util-linux）：它开一对主从，把子进程的
//      stdin/stdout/stderr 接到从设备上，再把主设备那一头的字节转给它的 stdout。于是测试这一侧
//      看见的是**真终端**（`isatty` 为真 · `stty` 读得动），而不是"换掉 `process.stdout` 对象"
//      那一档（`test/helpers/run-cli.ts` 走的是后一条，它碰不到真终端）。
//   2. **按键不能写 `/dev/tty`。** 写从设备是**输出**（终端会把它显示出来），进不了子进程的
//      读队列——实测：只写 `/dev/tty` 的那一版，TUI 一直跑到被人 `kill`。按键要写进 `script`
//      自己的 stdin，由它转给主设备。
//   3. **外来信号那一格要显式重定向。** POSIX：未开作业控制时，异步列表的 stdin 在**任何显式
//      重定向之前**被塞成 `/dev/null`。不写 `< /dev/tty`，那一格根本不是终端——raw mode 一次都
//      没进过，两行 `stty -g` 于是都"没动过"，比对等于空断言（实测：不加那一句时 `?2004h` 与
//      `?2004l` 一个都不出现）。
//
// **终端参数的读法**：driver 在自己这一侧跑 `stty -g`（读的就是那个从设备），子进程跑完再读
// 一次。两行逐字节相同 = 人回到 shell 时终端是进去之前那一份。这是**面外**的读数：判它的不是
// TUI 自己说的任何一句话。
//
// **喂按键等到真进了 raw mode**（`?2004h` 是 `openKeys` 开那一档时写出去的；它一到，`data` 的
// 监听器就已经挂上了）。定死一个 sleep 是赌——赌的是这台机器的启动速度。
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..')
const CLI = join(REPO, 'src', 'cli', 'fugue.ts')

export interface PtyRun {
  /** 子进程的退出码；没写出来（超时被杀 · driver 半途没了）时是 `null`。 */
  readonly code: number | null
  /** 从设备那一头出来的全部字节（`script` 转过来的那一份）。 */
  readonly out: string
  readonly err: string
  /** 进场时的终端参数（`stty -g` 的原样一行）。 */
  readonly entry: string
  /** 退出时的终端参数。与 `entry` 逐字节相同 = 还原了。 */
  readonly exit: string
  /** `entry === exit` 且两行都读到了。 */
  readonly restored: boolean
  /** 到时限还没退，被这一侧杀掉了。 */
  readonly timedOut: boolean
}

export interface PtyOptions {
  /** 工作区（`--root`）。 */
  readonly root: string
  /** 跑这一趟的落点：`driver.sh` 与 `entry` / `exit` / `code` 三个读数都在这里。 */
  readonly dir: string
  /** 要喂进去的按键字节（`'\u0003'` 就是 `Ctrl-C`）。不给 = 一个字节都不喂。 */
  readonly keys?: string
  /** 给了就按"外来信号"那一格跑：起进程 · 等这么多毫秒 · `kill -<信号>`。 */
  readonly killAfterMs?: number
  /** 发哪个信号（不带 `SIG` 前缀，缺省 `TERM`）。 */
  readonly killSignal?: string
  /** `tui` 后面的额外开关（`--full` 那一档）。 */
  readonly extra?: readonly string[]
  readonly timeoutMs?: number
}

/** 一行 `sh`：先记终端参数，跑 TUI，再记一次。**每一格都要留下这两行**，不然那一格没有判据。 */
function driverOf(o: PtyOptions): string {
  const extra = (o.extra ?? []).map((a) => `'${a}'`).join(' ')
  const run = `'${process.execPath}' '${CLI}' tui --root '${o.root}' --interval 60 ${extra}`.trimEnd()
  const tail = `echo $? > "$D/code"\nstty -g > "$D/exit"\nexit 0\n`
  if (o.killAfterMs !== undefined) {
    // **`< /dev/tty` 那一段不是装饰**（见文件头第 3 条）：少了它，这一格拿到的 stdin 是 /dev/null。
    return (
      `#!/bin/sh\nD='${o.dir}'\nstty -g > "$D/entry"\n` +
      `${run} < /dev/tty > /dev/tty 2>&1 &\npid=$!\n` +
      `( sleep ${(o.killAfterMs / 1000).toFixed(3)}; kill -${o.killSignal ?? 'TERM'} "$pid" ) &\n` +
      `wait "$pid"\n${tail}`
    )
  }
  return `#!/bin/sh\nD='${o.dir}'\nstty -g > "$D/entry"\n${run}\n${tail}`
}

/** 在真终端里跑一趟 `fugue tui`，把这一趟的前前后后一起交回来。 */
export function runTuiInPty(o: PtyOptions): Promise<PtyRun> {
  const driver = join(o.dir, 'driver.sh')
  writeFileSync(driver, driverOf(o), { mode: 0o755 })
  const child = spawn('script', ['-qec', `sh '${driver}'`, '/dev/null'], {
    env: { ...process.env, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const timeoutMs = o.timeoutMs ?? 20000
  return new Promise<PtyRun>((finish, fail) => {
    let out = ''
    let err = ''
    let timedOut = false
    let sent = (o.keys ?? '') === ''
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    if (sent) child.stdin.end()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
      if (!sent && out.includes('\u001b[?2004h')) {
        sent = true
        child.stdin.end(o.keys ?? '')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      err += chunk
    })
    // 起不来（`script` 不在 PATH 上 · 权限）是硬失败：这一档不"跳过"，也不假装跑过。
    child.on('error', (e) => {
      clearTimeout(timer)
      fail(new Error(`开不出 PTY（util-linux 的 script 是这一档的系统工具，不在就红）：${e.message}`))
    })
    child.on('close', () => {
      clearTimeout(timer)
      const read = (name: string): string => {
        try {
          return readFileSync(join(o.dir, name), 'utf8').trim()
        } catch {
          return ''
        }
      }
      const entry = read('entry')
      const exit = read('exit')
      const raw = read('code')
      finish({
        code: raw === '' ? null : Number(raw),
        out,
        err,
        entry,
        exit,
        restored: entry !== '' && entry === exit,
        timedOut,
      })
    })
  })
}
