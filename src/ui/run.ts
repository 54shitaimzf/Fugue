// TUI 的第二版第三格：**起命令**——界面里的每一个动作都是一条命令。
//
// 出处：PLAN § 5.19 第二版「二 · 按键」（"界面可以发任意一条命令、起轮次也在内，账仍由那个子进程
// 写；改契约仍归命令，不归界面"）·「六 · 提交的四种去向」· 第九节 `T3` 那一行（"输入行敲 `round go`
// 与手敲落下的账**逐字节相同**；负对照：界面自己写一条 `round/approve`"）· 架构 § 9.8（**人的每个
// 状态动作都是一条命令**）· 架构 § 9.6（CLI 是单次进程 + 每次重建：界面临时起一个子进程，不是自己
// 长出一只手）。
//
// 上一版那一格（`ui/go.ts`）只会起固定的 `round go`；这一格泛化成"起任意一条 fugue 命令"，
// 于是**输入行敲的那一行字与 `g` 那一键走的是同一条路**：一行字 → argv → 子进程。
//
// 四条不许破的性质：
//
//   · **账是子进程写的**：这一份手里只有一个 `spawn`——不 `openLog` · 不 `append` · 不认识 `Log`。
//     于是"界面能不能自己改契约"这件事在**签名上**就没有入口（`run.test.ts` ③ 的负对照量的就是它）；
//   · **不过 shell**：那一行按空白切开、认引号，argv 直接交给 `spawn`——`$HOME` 不会被展开，
//     `;` 不会分成两条命令；行首那个 `!`（任意 shell）是架构 § 9.8 不许的旁路，**这里明确拒绝
//     并说出为什么**（不是安静地丢）；
//   · **argv 与手敲的那一条逐字相同**：`<self> --root <dir> <命令> <参数…>`。`self` 缺省是"这个
//     进程自己是拿什么跑起来的"（`process.execPath` + 入口脚本的**绝对路径**——子进程的 cwd 与
//     这一趟不一定相同，相对路径会当场漂）；
//   · **一次只起一个**：跑着的时候再按起不动（同一条命令不叠第二个进程）。排队与打断是 `T7` 的事。
//
// **界面不与子进程抢键盘、也不与它抢账。** stdin 给 `/dev/null`（`stdio: ['ignore','pipe','pipe']`）
// ——按键全归界面；账由子进程按它自己的 writer 口写，而这一档的读者不取锁（架构 § 9.7）。
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

/** `g` 那一键按下去发的那一条命令（`ui/keymap.ts` 那张表里那一行的说明说的就是它）。 */
export const GO_LINE = 'round go'

/** 输入模式那一轴（PLAN § 5.19 三）：行首是 `/` 就是命令，否则是话。 */
export type LineMode = 'Command' | 'Say'

/** 一行字翻出来的东西。**起不了的时候 `words` 与 `argv` 都是空的，原因在 `why`。** */
export interface LineArgv {
  readonly words: readonly string[]
  readonly argv: readonly string[]
  readonly why: string | null
}

/**
 * 这一趟的命令行那两段（解释器 + 入口脚本）。**绝对路径**：`node src/cli/fugue.ts` 里的
 * `src/cli/fugue.ts` 是相对的，而子进程的 cwd 由调用方那一趟决定（`bin/fugue` 那一层递进来的
 * 已经是绝对路径，两条路在这一处收成同一个形状）。
 */
export function selfArgvOf(argv: readonly string[] = process.argv): readonly string[] {
  const entry = argv[1]
  return entry === undefined ? [process.execPath] : [process.execPath, resolve(entry)]
}

/**
 * 一行字切成那几个词：**按空白切 · 认单双引号 · 就这一层**（不是 shell，也没有第二层）。
 *
 * 认不出来的三档都说出为什么：空行 · 引号没闭合 · 行首 `!`（任意 shell 是架构 § 9.8 不许的旁路，
 * 这一档明确拒绝——安静丢掉会让人以为"按下去没反应"）。
 */
export function wordsOf(line: string): { readonly words: readonly string[]; readonly why: string | null } {
  const text = line.trim()
  if (text === '') return { words: [], why: '这一行是空的（没有命令可起）' }
  if (text.startsWith('!')) return { words: [], why: '`!` 那一档不做：界面不过 shell（架构 § 9.8 不许那条旁路）' }
  const words: string[] = []
  let one = ''
  let quote: '"' | "'" | null = null
  for (const ch of text) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else one += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (one !== '') {
        words.push(one)
        one = ''
      }
      continue
    }
    one += ch
  }
  if (quote !== null) return { words: [], why: `引号没闭合（${quote}）` }
  if (one !== '') words.push(one)
  if (words.length === 0) return { words: [], why: '这一行是空的（没有命令可起）' }
  return { words, why: null }
}

/**
 * 一行字 → 那一条命令。`Command` 那一档去掉行首那个 `/`（那是模式记号，不是参数）；`Say` 那一档
 * **整句落进 `say` 那一条命令的一个参数**（一个字都不切——人打的是话，不是命令）。
 */
export function lineArgvOf(o: {
  readonly self: readonly string[]
  readonly root: string
  readonly line: string
  readonly mode?: LineMode
}): LineArgv {
  const mode = o.mode ?? 'Command'
  const text = o.line.trim()
  let cut: { readonly words: readonly string[]; readonly why: string | null }
  if (mode === 'Say') {
    cut = text === '' ? { words: [], why: '这一行是空的（没有一句话可说）' } : { words: ['say', text], why: null }
  } else {
    cut = wordsOf(text.startsWith('/') ? text.slice(1) : text)
  }
  if (cut.why !== null) return { words: [], argv: [], why: cut.why }
  return { words: cut.words, argv: [...o.self, '--root', o.root, ...cut.words], why: null }
}

/** 子进程收尾：退出码（被信号杀掉是 `null`）· 起都起不来时那句话（`ENOENT` 那一档）。 */
export interface RunOutcome {
  readonly code: number | null
  readonly why: string | null
}

/** 一个起好了的子进程（这一份只用到这四样）。 */
export interface Spawned {
  readonly out: AsyncIterable<Uint8Array> | null
  readonly err: AsyncIterable<Uint8Array> | null
  readonly done: Promise<RunOutcome>
  /**
   * 请它停下（`T5` 取消链的第二级）。给的是信号名，缺省那一下是 `SIGINT`（先礼后兵那一下）。
   * **不抛**：它已经死了再叫一次会 `ESRCH`，而"目的已经达到"不是错。
   */
  stop(signal: string): void
}

export type SpawnFn = (file: string, args: readonly string[]) => Spawned

/** 真子进程那一档：stdout 与 stderr 收成管道，stdin 不接（按键归界面）。 */
export const spawnChild: SpawnFn = (file, args) => {
  const c = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    out: (c.stdout ?? null) as unknown as AsyncIterable<Uint8Array> | null,
    err: (c.stderr ?? null) as unknown as AsyncIterable<Uint8Array> | null,
    done: new Promise<RunOutcome>((res) => {
      // `error`（起不来）与 `close`（跑完了）分得开：前者的退出码是"没有",不是 0。
      c.once('error', (err: Error) => res({ code: null, why: err.message }))
      c.once('close', (code: number | null) => res({ code, why: null }))
    }),
    // 信号发给**这一个子进程**（不是进程组）："打不断就补一刀"与"那一组都得停"是 `T7` 那一格的事。
    stop: (signal: string) => {
      try {
        c.kill(signal)
      } catch {
        // 已经不在了 · 信号名认不出来：都算"请过了"（目的达到，不是错）。
      }
    },
  }
}

export interface RunOptions {
  readonly root: string
  /** 命令行那两段。缺省「这一个进程自己」（`selfArgvOf()`）；测试里给一个确定的。 */
  readonly self?: readonly string[]
  /** 起子进程那一处（缺省 `spawnChild`）。**测试用它换成一个假的，跑起来不用真起进程。** */
  readonly spawn?: SpawnFn
  /**
   * 子进程吐出来的行（一条一行；空行丢掉）。**stdout 与 stderr 各是一条流：两条流之间的先后不承诺**
   * ——两个管道没有共同次序（`run.test.ts` ② 钉的是每一条流自己的次序）。
   */
  readonly onLine: (line: string) => void
  /** 收尾那一下。 */
  readonly onDone?: (r: RunOutcome) => void
}

/** 一个口：给一行字，起一次。 */
export interface RunLauncher {
  /** 一行字 → 那一条命令（**先看不跑**：菜单 · 预览 · 测试都读它）。 */
  argvOf(line: string, mode?: LineMode): LineArgv
  /** 还跑着没有。 */
  readonly running: boolean
  /**
   * **上一次真要起的那一条命令的 argv**（还没有就是空表）。`argvOf` 是"先看不跑"，这个是"真按下去了
   * 的那一条"——"这一趟起不来，手敲一遍看看"那句注记要的就是它（起不来时没有进程，可 argv 有）。
   */
  readonly last: readonly string[]
  /**
   * 起一行。**跑着的时候起不动**（返回 `false`：同一条命令不叠第二个进程）；**认不出来的行也
   * 起不动**（返回 `false`，为什么由 `argvOf` 那一份说）。
   */
  press(line: string, mode?: LineMode): boolean
  /**
   * 请正在跑的那一趟停下（`T5` 取消链的第二级）。**没在跑就什么都不做**（返回 `false`）——调用方
   * 于是不用自己先判 `running`（那一判与这一判要是在两处，迟早漂）。返回值是"真请了没"。
   *
   * 请了不等于停了：它什么时候真死由它自己定，收尾照旧走 `onDone`（被信号杀掉的那一趟退出码是
   * `null`）。在它死之前 `running` 一直是 `true`——**不许这一趟还在死、下一趟就起来**。
   */
  stop(signal?: string): boolean
}

/**
 * 开一个口。**它只起命令、只收它的输出**：不写账、不注册信号、不认识终端。
 *
 * 子进程的输出走 `onLine`（一条一行），调用方把它们摆到面板上方（`ui/follow.ts` 的 `note`）——
 * **不直接写 stdout**：那样会在终端历史里插进半块面板。
 */
export function openRun(o: RunOptions): RunLauncher {
  const self = o.self ?? selfArgvOf()
  const run = o.spawn ?? spawnChild
  let running = false
  let last: readonly string[] = []
  /** 现在这一趟（没在跑就是 `null`）。`stop()` 从它这里把信号递下去。 */
  let kid: Spawned | null = null
  const argvOf = (line: string, mode?: LineMode): LineArgv => lineArgvOf({ self, root: o.root, line, mode })
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
    argvOf,
    get running(): boolean {
      return running
    },
    get last(): readonly string[] {
      return last
    },
    press(line: string, mode?: LineMode): boolean {
      if (running) return false
      const cut = argvOf(line, mode)
      if (cut.why !== null) return false
      last = cut.argv
      running = true
      const spawned = run(cut.argv[0] as string, cut.argv.slice(1))
      kid = spawned
      // 两条流都收干净（收尾顺序与子进程的死活无关：先等它死，再等两条流读完），然后才报收尾。
      const drained = Promise.all([eat(spawned.out), eat(spawned.err)]).then(
        () => undefined,
        () => undefined,
      )
      void spawned.done.then(async (r) => {
        await drained
        kid = null
        running = false
        o.onDone?.(r)
      })
      return true
    },
    /**
     * 请它停下：**只在真跑着的时候**发信号（没在跑返回 `false`，于是调用方不必自己先判 `running`）。
     * 缺省那一档是 `SIGINT`——先礼后兵的那一下（"打不断就补一刀"是 `T7` 那一格）。
     */
    stop(signal?: string): boolean {
      if (!running || kid === null) return false
      kid.stop(signal ?? 'SIGINT')
      return true
    },
  }
}
