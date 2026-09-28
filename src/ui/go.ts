// TUI 的第五格：**门那儿按一下**（起命令那一半）。出处：PLAN § 5.19 第五段（`UI4` 那一行：
// 「按键 → `spawn` 一次 `fugue round go`。**界面不写日志、不持写句柄**」）· 架构 § 9.8
// （「人的每个状态动作都是一条命令」）· 架构 § 9.6（CLI 是单次进程 + 每次重建：这一格也照它办，
// 界面临时起一个子进程，不是自己长出一只手）。
//
// **账是子进程写的。** 这一份手里只有一个 `spawn`：不 `openLog` · 不 `append` · 不认识 `Log`——
// 于是"界面能不能自己改契约"这件事在**签名上**就没有入口（`keys.test.ts` ⑤ 的负对照量的正是
// 这一处的差别：界面自己往账上写的那一版，账与"按了键"的那一版对不上）。
//
// **argv 与手敲的那一条逐字相同**：`<self> --root <dir> round go`。`self` 缺省是
// 「这个进程自己是拿什么跑起来的」（`process.execPath` + 入口脚本的**绝对路径**——子进程的 cwd
// 与这一趟不一定相同，相对路径会当场漂）。`--json` 不传：那一栏管的是打印，不是账；而它印出来
// 的那几行要落在人的屏幕上，所以要的是人读的那一份。
//
// **界面不与子进程抢键盘、也不与它抢账。** stdin 给 `/dev/null`（`stdio: ['ignore','pipe','pipe']`）
// ——按键全归这一份；账由子进程按它自己的 writer 口写，而这一档的读者不取锁（架构 § 9.7）。
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * 这一趟的命令行那两段（解释器 + 入口脚本）。**绝对路径**：`node src/cli/fugue.ts` 里的
 * `src/cli/fugue.ts` 是相对的，而子进程的 cwd 由调用方那一趟决定（`bin/fugue` 那一层递进来的
 * 已经是绝对路径，两条路在这一处收成同一个形状）。
 */
export function selfArgvOf(argv: readonly string[] = process.argv): readonly string[] {
  const entry = argv[1]
  return entry === undefined ? [process.execPath] : [process.execPath, resolve(entry)]
}

/** 手敲的那一条命令。**与 `fugue --root <dir> round go` 逐字相同**（⑤ 拿它当尺）。 */
export function goArgvOf(o: { readonly self: readonly string[]; readonly root: string }): readonly string[] {
  return [...o.self, '--root', o.root, 'round', 'go']
}

/** 子进程收尾：退出码（被信号杀掉是 `null`）· 起都起不来时那句话（`ENOENT` 那一档）。 */
export interface GoOutcome {
  readonly code: number | null
  readonly why: string | null
}

/** 一个起好了的子进程（这一份只用到这三样）。 */
export interface Spawned {
  readonly out: AsyncIterable<Uint8Array> | null
  readonly err: AsyncIterable<Uint8Array> | null
  readonly done: Promise<GoOutcome>
}

export type SpawnFn = (file: string, args: readonly string[]) => Spawned

/** 真子进程那一档：stdout 与 stderr 收成管道，stdin 不接（按键归界面）。 */
export const spawnChild: SpawnFn = (file, args) => {
  const c = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    out: (c.stdout ?? null) as unknown as AsyncIterable<Uint8Array> | null,
    err: (c.stderr ?? null) as unknown as AsyncIterable<Uint8Array> | null,
    done: new Promise<GoOutcome>((res) => {
      // `error`（起不来）与 `close`（跑完了）分得开：前者的退出码是"没有",不是 0。
      c.once('error', (err: Error) => res({ code: null, why: err.message }))
      c.once('close', (code: number | null) => res({ code, why: null }))
    }),
  }
}

export interface GoOptions {
  readonly root: string
  /** 命令行那两段。缺省「这一个进程自己」（`selfArgvOf()`）；测试里给一个确定的。 */
  readonly self?: readonly string[]
  /** 起子进程那一处（缺省 `spawnChild`）。**测试用它换成一个假的，跑起来不用真起进程。** */
  readonly spawn?: SpawnFn
  /**
   * 子进程吐出来的行（一条一行；空行丢掉）。**stdout 与 stderr 各是一条流：两条流之间的先后不承诺**
   * ——两个管道没有共同次序（`keys.test.ts` ④ 钉的是每一条流自己的次序）。
   */
  readonly onLine: (line: string) => void
  /** 收尾那一下。 */
  readonly onDone?: (r: GoOutcome) => void
}

/** 一个口：按一下起一次。 */
export interface GoLauncher {
  /** 手敲的那一条命令（日志与测试读它）。 */
  readonly argv: readonly string[]
  /** 还跑着没有。 */
  readonly running: boolean
  /** 按一下。**跑着的时候按不起了**（返回 `false`：同一条命令不叠第二次）。 */
  press(): boolean
}

/**
 * 开一个口。**它只起命令、只收它的输出**：不写账、不注册信号、不认识终端。
 *
 * 子进程的输出走 `onLine`（一条一行），调用方把它们摆到面板上方（`ui/follow.ts` 的 `note`）——
 * **不直接写 stdout**：那样会在终端历史里插进半块面板。
 */
export function openGo(o: GoOptions): GoLauncher {
  const argv = goArgvOf({ self: o.self ?? selfArgvOf(), root: o.root })
  const run = o.spawn ?? spawnChild
  let running = false
  /** 一条流：按 `\n` 切成行。**多字节字符可能被拆在两个块里**，所以解码器是流式的。 */
  const eat = async (stream: AsyncIterable<Uint8Array> | null): Promise<void> => {
    if (stream === null) return
    const dec = new TextDecoder()
    let rest = ''
    for await (const chunk of stream) {
      rest += dec.decode(chunk, { stream: true })
      let at = rest.indexOf('\n')
      while (at >= 0) {
        const line = rest.slice(0, at).replace(/\r$/, '')
        rest = rest.slice(at + 1)
        if (line !== '') o.onLine(line)
        at = rest.indexOf('\n')
      }
    }
    rest += dec.decode()
    if (rest !== '') o.onLine(rest)
  }
  return {
    argv,
    get running(): boolean {
      return running
    },
    press(): boolean {
      if (running) return false
      running = true
      const kid = run(argv[0] as string, argv.slice(1))
      // 两条流都收干净（收尾顺序与子进程的死活无关：先等它死，再等两条流读完），然后才报收尾。
      const drained = Promise.all([eat(kid.out), eat(kid.err)]).then(
        () => undefined,
        () => undefined,
      )
      void kid.done.then(async (r) => {
        await drained
        running = false
        o.onDone?.(r)
      })
      return true
    },
  }
}
