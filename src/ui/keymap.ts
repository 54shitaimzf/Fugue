// TUI 的第二版第二格：**键位表**——动作 id + 缺省键串 + 说明，**一处声明**，喂三处。
//
// 出处：PLAN § 5.19 第二版「二 · 按键」那张表 ·「四 · 取消链与退出」·「三 · 状态」那张表的三个轴 ·
// 第九节 `T2` 那一行（"提示行 · 帮助面板 · 菜单三处渲染出来的键串与表逐字相同，条数也相同"）。
// 上一版那一张 5 条的键表（`ui/keys.ts`）并进这一处，那个文件删了——**按键只有一处真相**。
//
// 为什么值得单独一格：同类里有一家把帮助目录与真分发做成两张互不相干的表，实测已经漂了 5 条
// （`?` · `l` · `v` · `g` · `G` 早就换了前缀）。这一份的牙就是**三处渲染与分发读的是同一张表**。
//
// 四条口径写在这里：
//
//   · **表里不写字节**：写的是人能读的键名（`Ctrl-J` · `Alt-Enter` · `↑` · `Alt-1…9`），字节由
//     `bytesOfKey` 从这些名字翻出来。人改一条键串不用懂转义，分发那一头也不用认识键名；
//   · **动作 id 与键串两层**：分发只认动作 id（`applyIntent`/`onAction` 那一头），所以加一条键
//     不动逻辑、换一处逻辑不动键；
//   · **还没接线的动作不许出现在提示行里**：`by` 记着哪一格把它接上，`WIRED` 记着**到现在为止落了地
//     的那几格**——提示行只印 `by` 在 `WIRED` 里头的那些。面板那块地方是给"现在就按得动"的键留的
//     ——许诺一个按下去没反应的键，比少印几条坏得多（同类里 CodeWhale 那种"目录里有、按下去没有"
//     正是这一条要躲的）。帮助面板与菜单**列全部**，没接线的那几条后面缀着 `（T5 那一格接上）`；
//   · **打字是缺省路**（`T4` 把输入行接上线时补上的一条）：表里没吃掉的可打印字符走 `insert`——表
//     是**动作**那一层，不是"键盘上每个键都登记一次"。可打印字符的那几条绑定（`q` · `g` · `?` ·
//     `/` · `@`）只在**行里没字的地方**算动作（`emptyLineOnly`）：`/round go` 里那个 `g` 要是也当
//     动作，这一行会当场被发出去——一条命令都打不完。这一条不是偏好，是打字打得进去的前提；
//   · **大段粘贴不许被解释**（`T4` 同一条）：终端开了 bracketed paste（`ESC[?2004h`）之后把粘进来
//     的那一段用一对记号夹住，记号之间那一整段原文交给 `insert`（里面的换行不是 `Enter`）；
//     不认这一档的终端把原文裸着送进来，那一条路照旧（换行还是 `Enter`）——地板是"少一层保护"，
//     不是"这一档跑不起来"。
//   · **一串序列不许被当成按键**：`escapeAt` 把 `ESC` 起头的那一段整段吃掉；被切开的半截
//     （`ESC` 单独来 · `ESC [` 还没到终字节）**攒着**（`decoderOf` 的 `pending`），攒到
//     `ESC_WAIT_MS` 还没有下文，才当"人真按了一下 `Esc`"——`Esc` 现在是一条键了，这一条必须有。
import { widthOf } from './frame.ts'

/** 输入行与面板认的那些动作。**一个动作一个意思**（哪个字节算哪个动作由下面那张表定）。 */
export type UiAction =
  | 'submit'
  | 'newline'
  | 'cancel'
  | 'interrupt'
  | 'quit'
  | 'historyOlder'
  | 'historyNewer'
  | 'search'
  | 'home'
  | 'end'
  | 'backspace'
  | 'delete'
  | 'left'
  | 'right'
  | 'wordLeft'
  | 'wordRight'
  | 'killToStart'
  | 'killWord'
  | 'killToEnd'
  | 'yank'
  | 'undo'
  | 'redo'
  | 'toggleFold'
  | 'menu'
  | 'panel'
  | 'complete'
  | 'focus'
  | 'mention'
  | 'go'
  /**
   * 门口那一批那两档（`T6`）：**开关是"门口那一块开着没有"，不是"行里有没有字"**——而后者才是
   * `actsOnEmpty` 那一份判的东西。所以这两条不进那一份的名单：分发处那一头先问"门口那一块开着
   * 没有"（`cli/cmd/observe.ts` 的 ⓪），关着的时候它们就是人打的字（`y` / `n` 是可打印的）。
   */
  | 'approve'
  | 'reject'
  | 'help'
  // **不是一条键**：可打印字符的缺省路（带着那几个字）——表里没有它这一行，它不是绑定，是"没被
  // 表吃掉的那个字节"的去处。
  | 'insert'

/** 哪一格把这个动作接上（`T2` 就是这一格）。 */
export type Stage = 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T8'

/** 表里的一行。 */
export interface Binding {
  readonly action: UiAction
  /** 按哪几个键（人能读的写法，一个动作可以有几种写法：`Ctrl-D` 与 `q`）。 */
  readonly keys: readonly string[]
  /** 提示那一行里的一句（**短**：那一行是给屏幕看的，不是说明书）。 */
  readonly hint: string
  /** 帮助面板与菜单里的一句（人读的一句话：按下去到底干什么）。 */
  readonly note: string
  readonly by: Stage
}

/**
 * **那一张表。次序就是提示行与帮助面板的次序**（先提交 · 再取消 · 再编辑 · 再导航 · 最后放行）。
 *
 * `interrupt` 与 `quit` 那两行到 `T5` 才真接上（取消链在 `ui/cancel.ts`）：在那之前 `Ctrl-C` 与
 * `Ctrl-D` 的地板都是退出（少一条地板比多一条近似坏得多）。
 */
export const TABLE: readonly Binding[] = [
  {
    action: 'submit',
    keys: ['Enter'],
    hint: '提交',
    note: '把这一行交出去：空闲就直接跑，忙就入队（排队项看得见、撤得掉）',
    by: 'T4',
  },
  {
    action: 'newline',
    keys: ['Ctrl-J', 'Alt-Enter'],
    hint: '换行',
    note: '在行里换一行，不提交（多行草稿与折叠过的粘贴都从这里来）',
    by: 'T4',
  },
  {
    action: 'cancel',
    keys: ['Esc'],
    hint: '取消',
    note: '取消链第一级：先关一层弹层，再打断、再丢排队草稿、再清空输入，都没有就什么都不做',
    by: 'T5',
  },
  {
    action: 'interrupt',
    keys: ['Ctrl-C'],
    hint: '打断',
    note: '取消链：有在途的那一趟就打断它；空闲时按一下只举手，3 秒内再按一次才是退出',
    by: 'T5',
  },
  {
    action: 'quit',
    keys: ['Ctrl-D', 'q', 'Q'],
    hint: '退出',
    note: '退出面板：只在输入行空着的时候（退出码 0——人喊停不是失败）',
    by: 'T5',
  },
  {
    action: 'historyOlder',
    keys: ['↑'],
    hint: '上一条',
    note: '输入历史往前翻；有面板开着的时候是往上选',
    by: 'T4',
  },
  {
    action: 'historyNewer',
    keys: ['↓'],
    hint: '下一条',
    note: '输入历史往后翻；翻到底回到手里原来那一行',
    by: 'T4',
  },
  {
    action: 'search',
    keys: ['Alt-R'],
    hint: '反查',
    note: '拿行里已经打的那几个字在历史里反查，再按一下找更早的一条',
    by: 'T4',
  },
  {
    action: 'home',
    keys: ['Ctrl-A', 'Home'],
    hint: '行首',
    note: '光标到行首',
    by: 'T4',
  },
  {
    action: 'end',
    keys: ['Ctrl-E', 'End'],
    hint: '行尾',
    note: '光标到行尾',
    by: 'T4',
  },
  {
    action: 'backspace',
    keys: ['Backspace'],
    hint: '退格',
    note: '删掉光标左边那一个簇（汉字与组合符号各算一个）',
    by: 'T4',
  },
  {
    action: 'delete',
    keys: ['Delete'],
    hint: '删一格',
    note: '删掉光标右边那一个簇',
    by: 'T4',
  },
  {
    action: 'left',
    keys: ['←'],
    hint: '左移',
    note: '光标往左一个簇',
    by: 'T4',
  },
  {
    action: 'right',
    keys: ['→'],
    hint: '右移',
    note: '光标往右一个簇',
    by: 'T4',
  },
  {
    action: 'wordLeft',
    keys: ['Alt-B', 'Ctrl-←'],
    hint: '退一个词',
    note: '光标往左退一个词（汉字连成一串算一个词）',
    by: 'T4',
  },
  {
    action: 'wordRight',
    keys: ['Alt-F', 'Ctrl-→'],
    hint: '进一个词',
    note: '光标往右进一个词',
    by: 'T4',
  },
  {
    action: 'killToStart',
    keys: ['Ctrl-U'],
    hint: '清行',
    note: '清到行首（光标已经在行首就清整行）；清掉的那一段在 kill 环里',
    by: 'T4',
  },
  {
    action: 'killWord',
    keys: ['Ctrl-W'],
    hint: '删一个词',
    note: '砍掉光标左边那一个词（进 kill 环）',
    by: 'T4',
  },
  {
    action: 'killToEnd',
    keys: ['Ctrl-K'],
    hint: '删到行尾',
    note: '砍掉光标右边那一段（进 kill 环）',
    by: 'T4',
  },
  {
    action: 'yank',
    keys: ['Ctrl-Y'],
    hint: '粘回',
    note: '把 kill 环里最近那一段粘回光标处',
    by: 'T4',
  },
  {
    action: 'undo',
    keys: ['Ctrl-Z'],
    hint: '撤销',
    note: '退一步（`Esc` 清掉的那一行也从这里回来）',
    by: 'T4',
  },
  {
    action: 'redo',
    keys: ['Alt-Z'],
    hint: '重做',
    note: '把刚撤掉的那一步再做回来',
    by: 'T4',
  },
  {
    action: 'toggleFold',
    keys: ['Ctrl-O'],
    hint: '展开粘贴',
    note: '把折起来的那一大段粘贴展开（原文一个字节都不改，只是显示）',
    by: 'T4',
  },
  {
    action: 'menu',
    keys: ['/'],
    hint: '命令菜单',
    note: '命令行的候选表：本机的那些命令与这些键都在一张单子上',
    by: 'T4',
  },
  {
    action: 'panel',
    keys: ['Ctrl-P'],
    hint: '命令面板',
    note: '面板：看这一行现在是什么——命令行走命令那张表，别处开键表（30 条，能筛）',
    by: 'T4',
  },
  {
    action: 'complete',
    keys: ['Tab'],
    hint: '补全',
    note: '补全；没有可补的时候在各面板之间轮换',
    by: 'T4',
  },
  {
    action: 'focus',
    keys: ['Alt-1…9'],
    hint: '切到第 n 格',
    note: '直接切到第 n 格 agent 或第 n 轮',
    by: 'T8',
  },
  {
    action: 'mention',
    keys: ['@'],
    hint: '引用路径',
    note: '把工作区里的一条路径引用进这一行',
    by: 'T4',
  },
  {
    action: 'go',
    keys: ['g', 'G'],
    hint: '放行这一轮',
    note: '放行：起一次 `fugue round go`（账由那个子进程写，界面一个字节都不写）',
    by: 'T2',
  },
  {
    action: 'approve',
    keys: ['y'],
    hint: '放行',
    note: '门口那一批：放行它（起一次 `fugue round go`）；**再按一次 `y` 或 Enter 才生效**——只在门口那一块开着、且输入行空着的时候是动作，别处它就是那个字',
    by: 'T6',
  },
  {
    action: 'reject',
    keys: ['n'],
    hint: '拒',
    note: '门口那一批：拒它——**一个字节都不落**，门照旧停着等人；再按一次 `n` 或 Enter 才生效（同上）',
    by: 'T6',
  },
  {
    action: 'help',
    keys: ['?'],
    hint: '重印这一行',
    note: '把按键那一行重印一遍（翻上去了再按一下就回来）',
    by: 'T2',
  },
]

/** `Ctrl-<方向键>` 那一档：终端报的不是控制码，是带修饰的那条 CSI（xterm 的 `ESC [ 1 ; 5 D`）。 */
const MODIFIED: Readonly<Record<string, readonly string[]>> = {
  '←': ['\u001b[1;5D'],
  '→': ['\u001b[1;5C'],
  '↑': ['\u001b[1;5A'],
  '↓': ['\u001b[1;5B'],
  Home: ['\u001b[1;5H'],
  End: ['\u001b[1;5F'],
  Delete: ['\u001b[3;5~'],
}

/** 键名 → 字节。**表里只写名字，字节在这里翻**（人改配置不用懂转义）。 */
const NAMED: Readonly<Record<string, readonly string[]>> = {
  Enter: ['\r'],
  Tab: ['\t'],
  Esc: ['\u001b'],
  Space: [' '],
  Backspace: ['\u007f', '\b'],
  Delete: ['\u001b[3~'],
  Home: ['\u001b[H', '\u001b[1~'],
  End: ['\u001b[F', '\u001b[4~'],
  '↑': ['\u001b[A'],
  '↓': ['\u001b[B'],
  '←': ['\u001b[D'],
  '→': ['\u001b[C'],
}

/** 可打印 = 空格以上、`DEL` 以下（表里没吃掉的那些字走 `insert`）。 */
function isPrintable(cp: number): boolean {
  return cp >= 0x20 && cp !== 0x7f
}

/**
 * **只在行里没字的地方算动作**的那几条。两种：`q`/`Q` · `g`/`G` · `?` · `/` · `@` 是**可打印
 * 字符**，`Ctrl-D`（`quit`）是**控制字符**。
 *
 * 判据（`cli/cmd/observe.ts` 分发处那一条闸是它唯一的用处）：
 *   · `/`：行是空的（这一下按下去了，这一行才成为一条命令行）；
 *   · `@`：光标在行首，或者前一个字是空格（**词首**——夹在一句话中间的那个 `@` 就是个 `@`）；
 *   · `q`/`g`/`?`/`Ctrl-D`：行是空的。
 *
 * 行里有字的时候它们的去处**两种不一样**：可打印的让位成那个字 · 控制字符丢掉（`fallsToText` 说
 * 得出为什么）。这一条不是偏好：不这么定，`/round go` 里那个 `g` 会把这一行当场发出去。
 */
export function actsOnEmpty(a: UiAction, text: string, caret: number): boolean {
  if (a === 'mention') return caret === 0 || text[caret - 1] === ' '
  if (a === 'menu' || a === 'quit' || a === 'go' || a === 'help') return text === ''
  return true
}

/**
 * 这一下按的是不是**该让位成那个字**（`T5` 补的一条）。
 *
 * 行里已经有字的时候，"只在行里没字的地方算动作"的那几条绑定要分出两种去处：
 *
 *   · **按的是可打印字符**（`q`/`Q` · `g`/`G` · `?` · `/` · `@`）→ 让位成那个字（`insert`）。
 *     不这么定，`/round go` 里那个 `g` 会把这一行当场发出去——一条命令都打不完；
 *   · **按的是控制字符**（`Ctrl-D` 的 `quit` · `Esc` 的 `cancel`）→ **丢掉**（与"表里没这个键"
 *     同一条口径）。它们要是也"让位成那个字"，输入行里会多出一个看不见的字节，而"行里没字"这个
 *     前提恰好被它自己毁掉——`T5` 的 `quitStepOf` 于是永远够不着（`cancel.test.ts` ③ 的负对照
 *     量的就是它）。
 *
 * 判据收在一处：`cli/cmd/observe.ts` 分发处那一条闸读它，别处谁都不许再写一遍。
 */
export function fallsToText(a: UiAction, key: string | undefined, text: string, caret: number): boolean {
  if (key === undefined || actsOnEmpty(a, text, caret)) return false
  const cp = key.codePointAt(0)
  return cp !== undefined && isPrintable(cp)
}

/**
 * **已经落了地的那几格**：提示行只印 `by` 在这里头的那些，帮助面板给其余的缀上一句"哪一格接上"。
 * 每落一格把它的名字加进来——这一份是**进度**，不是口味（`T2` 那一条断言的牙就在这儿：目录与
 * 分发同一张表，而"这一格接上了没有"也只有一个地方说）。
 */
export const WIRED: readonly Stage[] = ['T2', 'T3', 'T4', 'T5', 'T6', 'T8']

/** 大段粘贴那一对记号（终端发出来的那一对）：`decoderOf` 用它把原文整段交给 `insert`。 */
export const PASTE_ON = '\u001b[200~'
export const PASTE_OFF = '\u001b[201~'

/** 让终端把粘贴夹起来的那一对（我们写出去的那一对）。 */
const PASTE_ENABLE = '\u001b[?2004h'
const PASTE_DISABLE = '\u001b[?2004l'

/** `Ctrl-<X>` 的那一半：`Ctrl-Z` 是 0x1a，`Ctrl-C` 是 0x03（raw mode 下 `SIGINT` 就是它）。 */
function ctrlByte(name: string, byte: string): string {
  // 终端上 `Ctrl-Enter` 与 `Enter` 是同一个字节（分不开），`Ctrl-Space` 是 NUL，`Ctrl-?` 是 DEL。
  if (name === 'Enter') return '\r'
  if (name === 'Space') return '\u0000'
  if (name === '?') return '\u007f'
  const c = byte.codePointAt(0) ?? 0
  if (byte.length === 1 && c >= 0x40 && c <= 0x7f) return String.fromCharCode(c & 0x1f)
  return ''
}

/**
 * 一个键名 → 那几个字节（认不出来给空数组，**不抛**：配置里写错一个键名不该把整张表带走）。
 * `Ctrl-J` 是 0x0a · `Alt-Enter` 是 `ESC` + `CR` · `↑` 是 `ESC [ A` · `Alt-1` 是 `ESC 1`。
 */
export function bytesOfKey(name: string): readonly string[] {
  const named = NAMED[name]
  if (named !== undefined) return named
  const combo = /^(Ctrl|Alt)-(.+)$/.exec(name)
  if (combo !== null) {
    const head = combo[1] as string
    const rest = combo[2] as string
    const modified = head === 'Ctrl' ? MODIFIED[rest] : undefined
    if (modified !== undefined) return modified
    const inner = bytesOfKey(rest)
    if (inner.length === 0) return []
    const out: string[] = []
    for (const x of inner) {
      // `Alt-<字母>`：不带 Shift 是 `ESC r`、带 Shift 是 `ESC R`——两个都收（表里写的是那个字母）。
      if (head === 'Ctrl') out.push(ctrlByte(rest, x))
      else if (x.length === 1 && /[A-Za-z]/.test(x)) out.push(`\u001b${x.toLowerCase()}`, `\u001b${x.toUpperCase()}`)
      else out.push(`\u001b${x}`)
    }
    return out.some((x) => x === '') ? [] : out
  }
  // 范围写法（`Alt-1…9`）：一个键名翻出九个字节——表里写一行比写九行好读，字节一个也不少。
  const range = /^([1-9])…([1-9])$/.exec(name)
  if (range !== null) {
    const from = Number(range[1])
    const to = Number(range[2])
    const out: string[] = []
    for (let i = from; i <= to; i += 1) out.push(String(i))
    return out
  }
  if ([...name].length === 1) return [name]
  return []
}

/** 屏幕上怎么写这一条（`keys` 拼起来：一处推出来，不另写一份）。 */
export function keyLabelOf(b: Binding): string {
  return b.keys.join('/')
}

/** 覆盖里认不出来的那一条（`config set ui.keys.<动作> <键串>`）：报出来，**不静默把键弄没**。 */
export interface KeymapProblem {
  readonly action: string
  readonly key: string
  readonly why: string
}

/** 分发与三处渲染读的那一份（覆盖之后）。 */
export interface Keymap {
  readonly rows: readonly Binding[]
  readonly problems: readonly KeymapProblem[]
}

/**
 * 从缺省那张表 + 一份覆盖造出分发用的那一份。覆盖的键是**动作 id**（不是键名）：
 * `{ submit: 'Ctrl-Enter' }`。认不出来的动作 id · 认不出来的键名 · 两个动作抢同一个字节，
 * 都落在 `problems` 里（那一条**照缺省走**，不静默变成"按不出来"）。
 */
export function keymapOf(over: Readonly<Record<string, string>> = {}): Keymap {
  const problems: KeymapProblem[] = []
  const known = new Set<string>(TABLE.map((b) => b.action))
  for (const [action, key] of Object.entries(over)) {
    if (!known.has(action)) problems.push({ action, key, why: '表里没有这个动作' })
  }
  const rows = TABLE.map((b) => {
    const raw = over[b.action]
    if (raw === undefined) return b
    const keys = raw.split('·').map((x) => x.trim()).filter((x) => x !== '')
    const bad = keys.filter((k) => bytesOfKey(k).length === 0)
    if (keys.length === 0 || bad.length > 0) {
      problems.push({ action: b.action, key: raw, why: `这个键名认不出来：${bad.join(' ')}（照缺省走）` })
      return b
    }
    return { ...b, keys }
  })
  const seen = new Map<string, UiAction>()
  for (const b of rows) {
    for (const k of b.keys) {
      for (const bs of bytesOfKey(k)) {
        const had = seen.get(bs)
        if (had === undefined) seen.set(bs, b.action)
        else if (had !== b.action) problems.push({ action: b.action, key: k, why: `与 ${had} 抢同一个字节` })
      }
    }
  }
  return { rows, problems }
}

/** 缺省那一份（工作区没有覆盖时就是它）。 */
export const KEYMAP: Keymap = keymapOf()

/** 解出来的一个动作（`Alt-1…9` 那一档带着第几个）。 */
export interface Decoded {
  readonly action: UiAction
  readonly n?: number
  /** `insert` 那一路带的原文（人打的字 · 粘进来的一整段）。别的动作没有它。 */
  readonly text?: string
  /**
   * 那一下按的是哪个字节（`insert` 之外也有）。**用处只有一处**：可打印字符的那几条绑定在"行里
   * 已经有字"的时候要让位成那个字（`emptyLineOnly`），而要让位就得知道按的是哪个字。
   */
  readonly key?: string
}

function decodedOf(action: UiAction, bytes: string): Decoded {
  return action === 'focus' ? { action, n: Number(bytes.slice(1)), key: bytes } : { action, key: bytes }
}

/** 字节 → 动作（一张表只在这里建一次；加一条键不会漂）。 */
export function byteMapOf(km: Keymap = KEYMAP): ReadonlyMap<string, Decoded> {
  const out = new Map<string, Decoded>()
  for (const b of km.rows) {
    for (const k of b.keys) {
      for (const bs of bytesOfKey(k)) out.set(bs, decodedOf(b.action, bs))
    }
  }
  return out
}

/**
 * `ESC` 起头的那一段有几个字符（不是 `ESC` 起头就是 0）。
 *
 * 两条规矩：**CSI 的终字节是 `@` 到 `~`**（`ESC [` 之后一路吃到它）——方向键 · 鼠标报告 ·
 * 终端报出来的组合键全落在这一条里；**`ESC` 后面跟一个普通字符是 Alt 那一档**（整两个字符吃掉），
 * 所以 `ESC q` 不是"按了 q"。
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
 * `ESC` 起头那一段是不是**被切开了**（还差后面的字节才成一个键）：`ESC` 后面什么都没有 ·
 * `ESC [` 之后还没到终字节。这两档要**攒着**（`decoderOf`），不能当成"按了一下 `Esc`"。
 */
export function escapeTruncatedAt(s: string, i: number): boolean {
  if (s[i] !== '\u001b') return false
  if (s[i + 1] === undefined) return true
  if (s[i + 1] !== '[' && s[i + 1] !== 'O') return false
  for (let j = i + 2; j < s.length; j += 1) {
    const c = s.charCodeAt(j)
    if (c >= 0x40 && c <= 0x7e) return false
  }
  return true
}

const codepointSize = (c: number): number => (c > 0xffff ? 2 : 1)

/**
 * 一段输入 → 那几个动作（**一个字节都不多认**）。认不出来的字节（多余的回车 · 别的字母 ·
 * 没配过的方向键）安静丢掉：这一档不是命令行，多认一个字节就是多一种"按错了键也触发"的可能。
 * 被切开的半截序列**这一份不留**（要留就用 `decoderOf`，`openKeys` 走的是那一条）。
 */
export function actionsOf(chunk: string, km: Keymap = KEYMAP): readonly UiAction[] {
  return decodeOf(chunk, km).map((d) => d.action)
}

/** 与 `actionsOf` 同一件事，但带着 `Alt-1…9` 那个数。 */
export function decodeOf(chunk: string, km: Keymap = KEYMAP): readonly Decoded[] {
  const bytes = byteMapOf(km)
  const out: Decoded[] = []
  let i = 0
  while (i < chunk.length) {
    const esc = escapeAt(chunk, i)
    if (esc > 0) {
      if (!escapeTruncatedAt(chunk, i)) {
        const d = bytes.get(chunk.slice(i, i + esc))
        if (d !== undefined) out.push(d)
      }
      i += esc
      continue
    }
    const size = codepointSize(chunk.codePointAt(i) as number)
    const ch = chunk.slice(i, i + size)
    const d = bytes.get(ch)
    // 与 `decoderOf` 的 `step` 同一条：**表里没吃掉的可打印字符就是人打的字**。两处必须同一口径
    // （`decodeOf` 是"一次给一整块"那一档，测试与脚本用它），不然同一个字节在两条路上两个答案。
    if (d !== undefined) out.push(d)
    else if (isPrintable(chunk.codePointAt(i) as number)) out.push({ action: 'insert', text: ch, key: ch })
    i += size
  }
  return out
}

/** 半截 `ESC` 等多久算"人真按了一下 `Esc`"（毫秒）。 */
export const ESC_WAIT_MS = 40

/** 一块一块喂进来的解码器（终端可能把一条序列切在两个 `data` 之间）。 */
export interface Decoder {
  /** 还没凑成一个键的那半截（空串就是没有）。 */
  readonly pending: string
  feed(chunk: string): readonly Decoded[]
  /** 半截攒不成键了：最前面那一个 `ESC` 当"人按了一下 `Esc`"，剩下的接着解。 */
  flush(): readonly Decoded[]
}

export function decoderOf(km: Keymap = KEYMAP): Decoder {
  const bytes = byteMapOf(km)
  let pending = ''
  /** 粘到一半的那一段（`ESC[200~` 到了、`ESC[201~` 还没到）。 */
  let paste: string | null = null
  const step = (s: string): { readonly out: readonly Decoded[]; readonly rest: string } => {
    const out: Decoded[] = []
    let i = 0
    while (i < s.length) {
      const esc = escapeAt(s, i)
      if (esc > 0) {
        if (escapeTruncatedAt(s, i)) return { out, rest: s.slice(i) }
        const d = bytes.get(s.slice(i, i + esc))
        if (d !== undefined) out.push(d)
        i += esc
        continue
      }
      const size = codepointSize(s.codePointAt(i) as number)
      const ch = s.slice(i, i + size)
      const d = bytes.get(ch)
      // 表里没吃掉的那个字节：**可打印的就是人打的字**（`insert`），别的（认不出来的控制字符）
      // 丢掉——"认不出来"与"没这个键"在读数上是同一件事。
      if (d !== undefined) out.push(d)
      else if (isPrintable(s.codePointAt(i) as number)) out.push({ action: 'insert', text: ch, key: ch })
      i += size
    }
    return { out, rest: '' }
  }
  return {
    get pending(): string {
      return pending
    },
    feed(chunk: string): readonly Decoded[] {
      // **大段粘贴**（`ESC[200~` … `ESC[201~`）：记号之间那一整段是**原文**，一个字节都不解释——
      // 里面的换行不是 `Enter`（不然粘一段代码会在中间把这一行发出去）。记号只到了一半就攒着。
      const out: Decoded[] = []
      let s = pending + chunk
      pending = ''
      if (paste !== null) {
        const end = s.indexOf(PASTE_OFF)
        if (end < 0) {
          paste += s
          return []
        }
        out.push({ action: 'insert', text: paste + s.slice(0, end) })
        paste = null
        s = s.slice(end + PASTE_OFF.length)
      }
      for (;;) {
        const at = s.indexOf(PASTE_ON)
        if (at < 0) break
        out.push(...step(s.slice(0, at)).out)
        const end = s.indexOf(PASTE_OFF, at + PASTE_ON.length)
        if (end < 0) {
          paste = s.slice(at + PASTE_ON.length)
          return out
        }
        out.push({ action: 'insert', text: s.slice(at + PASTE_ON.length, end) })
        s = s.slice(end + PASTE_OFF.length)
      }
      const r = step(s)
      pending = r.rest
      return [...out, ...r.out]
    },
    flush(): readonly Decoded[] {
      if (pending === '') return []
      const head = pending[0] as string
      const rest = pending.slice(1)
      pending = ''
      const one = bytes.get(head)
      return [...(one === undefined ? [] : [one]), ...this.feed(rest)]
    },
  }
}

const entryOf = (b: Binding): string => `${keyLabelOf(b)} ${b.hint}`

/**
 * 提示那一行。**由表推出来**，只印**已经落了地的**那些（`by` 在 `WIRED` 里）——许诺一个按下去没
 * 反应的键，比少印几条坏得多。`limit` 是给 `--help` 与面板抬头留的：只印头几条，剩下的写成
 * "还有 N 条"，而那个 N 也是从表里数出来的。
 */
export function hintLineOf(km: Keymap = KEYMAP, limit = 0): string {
  const ready = km.rows.filter((b) => WIRED.includes(b.by))
  if (ready.length === 0) return '按键：这一档还没有接上线的键'
  const shown = limit > 0 && ready.length > limit ? ready.slice(0, limit) : ready
  const more = ready.length - shown.length
  const tail = more > 0 ? ` · …（还有 ${more} 条，按 Ctrl-P 看全部）` : ''
  return `按键 ${shown.map(entryOf).join(' · ')}${tail}`
}

/**
 * 那一行里最多放得下几条：**宽度是入参**（提示行是给屏幕看的，不是给文件看的）。一条一条地量，
 * 量的是**整行**（"还有 N 条"那一句本身也占列）。
 *
 * 为什么要它：表落到 28 条已经落地的动作之后，整行印出来是 438 列（实测）——终端会把它折成五行，
 * 那正是这一档最难看的样子。窄到一条加那一句都放不下时给 1（只印一条）。
 */
export function hintLimitOf(columns: number, km: Keymap = KEYMAP): number {
  const total = km.rows.filter((b) => WIRED.includes(b.by)).length
  if (total === 0) return 0
  for (let n = 1; n < total; n += 1) {
    if (widthOf(hintLineOf(km, n)) > columns) return Math.max(1, n - 1)
  }
  return total
}

/**
 * 帮助面板那些行：**一条一行**，键那一列按表里最长的那个键对齐（列宽是算出来的，不是写死的），
 * 还没接线的动作在后面缀一句"哪一格接上"。
 */
export function helpRowsOf(km: Keymap = KEYMAP): readonly string[] {
  const w = km.rows.reduce((n, b) => Math.max(n, widthOf(keyLabelOf(b))), 0)
  return km.rows.map((b) => {
    const pad = ' '.repeat(w - widthOf(keyLabelOf(b)) + 2)
    const later = WIRED.includes(b.by) ? '' : `（${b.by} 那一格接上）`
    return `${keyLabelOf(b)}${pad}${b.note}${later}`
  })
}



/** 收输入的那一头（`process.stdin` 就是它）。**四个方法都是结构上的**——测试里给一个假的就能把
 * 这一档跑起来，不用真终端（与 `ui/term.ts` 的 `TermOut` 同一个做法）。 */
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

/** 攒着等下文的那一个定时器（测试里给一个假的就不真等）。 */
export type WaitFn = (ms: number, fn: () => void) => () => void

const realWait: WaitFn = (ms, fn) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

/**
 * 收下 stdin。**它不注册信号、不碰 `process`、不认识 `UiAction` 之外的东西**——动作交出去，
 * 拨哪一下由调用方决定（`cli/cmd/observe.ts` 的 `tui`）。
 *
 * 不是 TTY → 返回一个空句柄（`raw: false` · `close()` 什么也不做），**一个字节都不读**：这一条与
 * `ui/term.ts` 那一档是同一条地板，写在两处各说各的那一半。
 */
export function openKeys(o: {
  readonly input: KeyInput
  readonly onAction: (d: Decoded) => void
  readonly km?: Keymap
  readonly wait?: WaitFn
  /** 写字节的那一头（`process.stdout`）：**只用来开关 bracketed paste**。不给就不开。 */
  readonly out?: { write(s: string): unknown } | undefined
}): KeySource {
  const input = o.input
  const raw = input.isTTY === true && typeof input.setRawMode === 'function'
  if (!raw) return { raw: false, close(): void {} }
  const dec = decoderOf(o.km ?? KEYMAP)
  const wait = o.wait ?? realWait
  let stop: (() => void) | null = null
  const onData = (chunk: string | Uint8Array): void => {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    if (stop !== null) {
      stop()
      stop = null
    }
    for (const d of dec.feed(text)) o.onAction(d)
    if (dec.pending !== '') {
      stop = wait(ESC_WAIT_MS, () => {
        stop = null
        for (const d of dec.flush()) o.onAction(d)
      })
    }
  }
  input.setRawMode?.(true)
  // **大段粘贴**：开了这一档，终端把粘进来的那一段用一对记号夹住（`decoderOf` 认得它们）。不开就是
  // 裸字节——粘一段代码会在中间那一个换行上把这一行发出去。
  o.out?.write(PASTE_ENABLE)
  input.on('data', onData)
  let done = false
  return {
    raw: true,
    close(): void {
      if (done) return
      done = true
      if (stop !== null) {
        stop()
        stop = null
      }
      input.removeListener('data', onData)
      input.setRawMode?.(false)
      o.out?.write(PASTE_DISABLE)
    },
  }
}
