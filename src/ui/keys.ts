// TUI 的第五格：**门那儿按一下**（按键那一半）。出处：PLAN § 5.19 第五段（`UI4` 那一行）·
// 架构 § 9.8（可附着 TUI：**人的每个状态动作都是一条命令** · 界面不写日志 · 观察不加锁）·
// PLAN § 5.19「两条已知近似」那段末尾那一句（"要连旧那一块一起收走……那是 `UI4` 收下 stdin
// 之后的事"）。
//
// 这一份只做一件事：**把 stdin 上的字节翻成动作**（一张表），外加 raw mode 的开与关。
// 它不 spawn、不写账、不认识轮次、不认识终端尺寸——**按下去之后干什么由调用方接线**
// （`src/cli/fugue.ts` 的 `tui`，那条命令由 `ui/go.ts` 起）。于是"哪个字节算什么"是这一份能
// 单独证伪的事，而"按下去账上多了什么"是 `keys.test.ts` ⑤ 那条真子进程的事。
//
// **raw mode 从这一格起。** `UI2`/`UI3` 那两格刻意一个字节都不读 stdin；这一格收下它，于是
// 两件事跟着变，都写在这里：
//
//   · **Ctrl-C 不再有 `SIGINT`**：raw mode 关掉的是行缓冲与信号（`ISIG`），所以 `\x03` 是**一个
//     普通字节**，得由这张表把它翻成"退出"。这是这一格唯一一处"停下来的信号从信号那一头挪到了
//     输入这一头"——而 `openKeys` 只把动作交出去，拨哪一下归调用方（它不碰 `process`）；
//   · **一条序列不许被当成按键**：方向键（`ESC [ A`）· 鼠标报告（`ESC [ < … M`）· 终端报出来的
//     组合键（`ESC [ 27;5;103~`）里都带着字母——`escapeAt` 把 `ESC` 起头的那一段整段吃掉，所以
//     它不会被读成 `g` 或 `q`。**这条牙在 ② 里有一条负对照**（那是这一份最容易错的地方：一手
//     一个 `const k = chunk[0]` 就把 Ctrl-Alt-g 读成了"放行"）。
//
// **不是 TTY 就不收**（`openKeys` 认出 `isTTY !== true` 就返回一个空句柄：`on('data')` 一次都不
// 调）——那条地板与 `ui/term.ts` 那一档同一个意思：管道 · CI · `node --test` 里一个字节都不读。
//
// **闭包那一半写在注释里，不写进代码**（`tuiModeOf` 那一张表说了算）：按键只在"面板"那一档收，
// `--once` / 不是 TTY / `$TERM` 认不出来那几档一个字节都不读。

/** 按下去之后能做的那三件事。**它是这一份对外的全部**——多一件事就该多一条按键与一条接线。 */
export type Action = 'go' | 'quit' | 'help'

/** 那三件事的次序（表要逐条对上：漏一条当场红——`keys.test.ts` ①）。 */
export const ACTION_KEYS: readonly Action[] = ['go', 'quit', 'help']

/** 一条按键：**哪个字节 · 算什么 · 按下去干什么**。 */
export interface KeyBinding {
  /** 屏幕上怎么写它（提示那一行用这个）。 */
  readonly key: string
  readonly action: Action
  /** 收进来的字节（同一个动作可以有几个写法：`g` 与 `G`）。 */
  readonly bytes: readonly string[]
  /** 这一条按下去到底干什么（人读的一句话）。 */
  readonly note: string
}

/**
 * 那一张表。**次序就是提示那一行的次序**（`keysHintOf` 按动作分组，第一次出现的动作排前面）。
 *
 * `\x03` 与 `\x04` 两条不是"顺手加的"：raw mode 下终端不再替我们发 `SIGINT`，不放它们进表就是
 * "面板起来了、`Ctrl-C` 不管用了"——那是这一档最难受的一种坏法。
 *
 * **不放进表的东西**：`Ctrl-Z`（挂起要 `SIGTSTP`，与 raw mode 那一档相冲：计划 § 5.19 已经把它
 * 记成"挂起回来会重复一屏"那条近似，这一格不动它）· 方向键与鼠标（那是整屏那一档的事，
 * 见 § 5.19「第一版不做」）· 任何"直接改契约"的键（架构 § 9.8：人的状态动作都是一条命令，
 * 而这一档手里没有写句柄——`ui/go.ts` 起的是子进程）。
 */
export const KEYS: readonly KeyBinding[] = [
  { key: 'g', action: 'go', bytes: ['g', 'G'], note: '放行这一轮：起一次 `fugue round go`（账由那个子进程写，界面一个字节都不写）' },
  { key: 'q', action: 'quit', bytes: ['q', 'Q'], note: '退出面板：终端历史里只剩永久行（退出码 0——人喊停不是失败）' },
  { key: 'Ctrl-C', action: 'quit', bytes: ['\u0003'], note: '退出（raw mode 下 `SIGINT` 不再由终端发出来，这个字节就是它）' },
  { key: 'Ctrl-D', action: 'quit', bytes: ['\u0004'], note: '退出（与 `Ctrl-C` 同一档）' },
  { key: '?', action: 'help', bytes: ['?', 'h'], note: '把按键那一行重印一遍（翻上去了再按一下就回来）' },
]

/** 每个动作在提示那一行里的一句话（**短**：那一行是给屏幕看的，不是说明书）。 */
export const HINT_OF: Readonly<Record<Action, string>> = {
  go: '放行这一轮（起一次 `fugue round go`）',
  quit: '退出',
  help: '重印这一行',
}

/** 一个字节 → 一个动作。**表只在这里读一遍**：两处各建一张的话，加一条键就会漂。 */
const ACTION_OF: ReadonlyMap<string, Action> = new Map(
  KEYS.flatMap((b) => b.bytes.map((x) => [x, b.action] as const)),
)

/**
 * `ESC` 起头的那一段有几个字符（不是 `ESC` 起头就是 0）。
 *
 * 两条规矩：**CSI 的终字节是 `@` 到 `~`**（`ESC [` 之后一路吃到它）——方向键 · 鼠标报告 ·
 * 终端报出来的组合键全落在这一条里；**`ESC` 后面跟一个普通字符是 Alt 那一档**（整两个字符吃掉），
 * 所以 `ESC q` 不是"按了 q"。还没收全的序列整段吃掉（宁可少认一个键，也不许把半个序列当按键）。
 */
export function escapeAt(s: string, i: number): number {
  if (s[i] !== '\u001b') return 0
  const next = s[i + 1]
  if (next === undefined) return 1
  if (next !== '[' && next !== 'O') return 2
  let j = i + 2
  while (j < s.length) {
    const c = s.charCodeAt(j)
    if (c >= 0x40 && c <= 0x7e) return j - i + 1
    j += 1
  }
  return s.length - i
}

/**
 * 一段输入 → 那几个动作（**一个字节都不多认**）。
 *
 * 认不出来的字节（中文 · 回车 · 空格 · 别的字母）**安静地丢掉**：这一档不是命令行，多认一个字节
 * 就是多一种"按错了键也放行"的可能。一段里可以有好几个动作（终端可能一次给好几个字节）。
 */
export function actionsOf(chunk: string): readonly Action[] {
  const out: Action[] = []
  for (let i = 0; i < chunk.length; ) {
    const esc = escapeAt(chunk, i)
    if (esc > 0) {
      i += esc
      continue
    }
    const a = ACTION_OF.get(chunk[i] as string)
    if (a !== undefined) out.push(a)
    i += 1
  }
  return out
}

/**
 * 提示那一行。**由表推出来**（`KEYS` + `HINT_OF`），不是另写一句：加一条键它就跟着变，
 * 而"提示里说的"与"真认的"因此不可能漂（`keys.test.ts` ① 盯着这一条）。
 */
export function keysHintOf(): string {
  const keys: string[] = []
  const seen = new Map<Action, string[]>()
  for (const b of KEYS) {
    const had = seen.get(b.action)
    if (had === undefined) keys.push(b.action)
    seen.set(b.action, [...(had ?? []), b.key])
  }
  return `按键 ${keys.map((a) => `${(seen.get(a) ?? []).join('/')} ${HINT_OF[a]}`).join(' · ')}`
}

/**
 * 收输入的那一头（`process.stdin` 就是它）。**四个方法都是结构上的**——测试里给一个假的就能把
 * 这一档跑起来，不用真终端（与 `ui/term.ts` 的 `TermOut` 同一个做法）。
 */
export interface KeyInput {
  on(ev: 'data', listener: (chunk: string | Uint8Array) => void): unknown
  removeListener(ev: 'data', listener: (chunk: string | Uint8Array) => void): unknown
  /** 进/出 raw mode（`process.stdin.setRawMode`）。不是 TTY 的输入上没有它。 */
  setRawMode?(raw: boolean): unknown
  /** 是不是终端：不是就不收（管道 · CI · 重定向进来的一份输入）。 */
  readonly isTTY?: boolean | undefined
}

/** 一个收输入的口。**`close()` 幂等**（正常退 · 信号 · `finally` 三条路都会走到它）。 */
export interface KeySource {
  /** raw mode 开着没有（不是 TTY 时是 `false`：一个字节都不读）。 */
  readonly raw: boolean
  close(): void
}

/**
 * 收下 stdin。**它不注册信号、不碰 `process`、不认识 `Action` 之外的东西**——动作交出去，
 * 拨哪一下由调用方决定（`cli/fugue.ts` 的 `tui`）。
 *
 * 不是 TTY → 返回一个空句柄（`raw: false` · `close()` 什么也不做），**一个字节都不读**：
 * 这一条与 `ui/term.ts` 那一档是同一条地板，写在两处各说各的那一半。
 */
export function openKeys(o: { readonly input: KeyInput; readonly onAction: (a: Action) => void }): KeySource {
  const input = o.input
  const raw = input.isTTY === true && typeof input.setRawMode === 'function'
  if (!raw) return { raw: false, close(): void {} }
  const onData = (chunk: string | Uint8Array): void => {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    for (const a of actionsOf(text)) o.onAction(a)
  }
  input.setRawMode?.(true)
  input.on('data', onData)
  let done = false
  return {
    raw: true,
    close(): void {
      if (done) return
      done = true
      input.removeListener('data', onData)
      input.setRawMode?.(false)
    },
  }
}
