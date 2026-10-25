// TUI 的第二版第二格：**键位表**——动作 id + 缺省键串 + 说明，**一处声明**，喂三处。
//
// 出处：PLAN § 5.19 第二版「二 · 按键」那张表 ·「四 · 取消链与退出」·「三 · 状态」那张表的三个轴 ·
// 第九节 `T2` 那一行（"提示行 · 帮助面板 · 菜单三处渲染出来的键串与表逐字相同，条数也相同"）。
// 上一版那一张 5 条的键表（`ui/keys.ts`）并进这一处，那个文件删了——**按键只有一处真相**。
//
// 为什么值得单独一格：同类里有一家把帮助目录与真分发做成两张互不相干的表，实测已经漂了 5 条
// （`?` · `l` · `v` · `g` · `G` 早就换了前缀）。这一份的判据就是**三处渲染与分发读的是同一张表**。
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
import { widthOf } from './glyph.ts'

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
  /** 翻页（U14）：`PgUp`/`PgDn` 半屏（阅读面 · 门口批次 · 候选三处，谁开着翻谁）；`Ctrl-Home`/`Ctrl-End` 跳首尾。 */
  | 'pageUp'
  | 'pageDown'
  | 'jumpFirst'
  | 'jumpLast'
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
  /**
   * 阅读面那一格（`T9`）：**开与关都在这一条上**（开着再按一下就收起——与 `Ctrl-P` 那种"再按一下
   * 换一个来源"的做法不同：阅读面是"我要看这一份东西"，看一眼就走）。开着之后 `Tab` 在三面之间
   * 轮换 · `↑`/`↓` 翻 · `Esc` 收起。
   */
  | 'read'
  | 'mention'
  | 'go'
  /**
   * 门口那一批那两档（`T6`）：**开关是"门口那一块开着没有"，不是"行里有没有字"**——而后者才是
   * `actsOnEmpty` 那一份判的东西。所以这两条不进那一份的名单：分发处那一头先问"门口那一块开着
   * 没有"（`ui/console.ts` 的 ⓪），关着的时候它们就是人打的字（`y` / `n` 是可打印的）。
   */
  | 'approve'
  | 'reject'
  | 'help'
  // **不是一条键**：可打印字符的缺省路（带着那几个字）——表里没有它这一行，它不是绑定，是"没被
  // 表吃掉的那个字节"的去处。
  | 'insert'

/** 哪一格把这个动作接上（`T2` 就是这一格）。 */
export type Stage = 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T8' | 'T9'

/** 提示场景从当前界面推导；日常提示精选能用的动作，any保完整命令行帮助。 */
export type HintWhen = 'any' | 'gate' | 'read' | 'pending' | 'plan' | 'menu' | 'input' | 'typing' | 'run' | 'queue' | 'search' | 'done' | 'menuEmpty'

/** 能按处境换一句话的那几档（`any` 那一档没有"换一句"这回事：它就是表里那一句）。 */
export type HintSayWhen = Exclude<HintWhen, 'any'>

/** 表里的一行。 */
export interface Binding {
  readonly action: UiAction
  /** 按哪几个键（人能读的写法，一个动作可以有几种写法：`Ctrl-D` 与 `q`）。 */
  readonly keys: readonly string[]
  /** 提示那一行里的一句（**短**：那一行是给屏幕看的，不是说明书）。 */
  readonly hint: string
  /** 帮助面板与菜单里的一句（人读的一句话：按下去到底干什么）。 */
  readonly note: string
  /**
   * **这个键在某几档处境下换一句话**（第三幕 ②）：只在"它在那一档里不是这个意思"的地方写。不写
   * 就是 `hint` 那一句照用——这张表里绝大多数行没有这一栏，那是**对的**，不是缺的。措辞仍住在这张
   * 表里（与 `hint` · `note` 同一处真源），分档只决定"先露谁"。
   */
  readonly says?: Readonly<Partial<Record<HintSayWhen, string>>>
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
    note: '发送输入；任务运行中先排队，结束后依次处理',
    by: 'T4',
  },
  {
    action: 'newline',
    keys: ['Ctrl-J', 'Alt-Enter'],
    hint: '换行',
    note: '在输入中换行，保留草稿，不发送',
    by: 'T4',
  },
  {
    action: 'cancel',
    keys: ['Esc'],
    hint: '取消',
    note: '每次处理一项：收起最上层、停止任务、撤掉最后一条排队内容、退出反查、清空输入',
    // 同一个 `Esc`，两处处在说的是两件事（第三幕 ②）：门口那一块开着是"收起门口"，阅读面开着是
    // "收起"——两处各有自己的一级，措辞照各自那一级写。
    says: { read: '收起', plan: '返回' },
    by: 'T5',
  },
  {
    action: 'interrupt',
    keys: ['Ctrl-C'],
    hint: '打断',
    note: '停止正在运行的任务；空闲时在 3 秒内连按两次退出',
    by: 'T5',
  },
  {
    action: 'quit',
    keys: ['Ctrl-D', 'q', 'Q'],
    hint: '退出',
    note: '输入为空时退出；任务运行中先等结束，再按一次立即退出',
    by: 'T5',
  },
  {
    action: 'historyOlder',
    keys: ['↑'],
    hint: '上一条',
    note: '查看上一条输入；列表或阅读打开时向上移动',
    says: { read: '上一行', gate: '上一项', plan: '上一行' },
    by: 'T4',
  },
  {
    action: 'historyNewer',
    keys: ['↓'],
    hint: '下一条',
    note: '查看下一条输入；列表或阅读打开时向下移动',
    says: { read: '下一行', gate: '下一项', plan: '下一行' },
    by: 'T4',
  },
  {
    action: 'search',
    keys: ['Alt-R'],
    hint: '反查',
    note: '用输入中的文字反查历史；再按一次找更早的一条',
    by: 'T4',
  },
  {
    action: 'pageUp',
    keys: ['PgUp'],
    hint: '上翻半屏',
    note: '当前列表或阅读向上翻半页',
    by: 'T9',
  },
  {
    action: 'pageDown',
    keys: ['PgDn'],
    hint: '下翻半屏',
    note: '当前列表或阅读向下翻半页',
    by: 'T9',
  },
  {
    action: 'jumpFirst',
    keys: ['Ctrl-Home'],
    hint: '跳到头',
    note: '跳到当前列表或阅读的开头',
    by: 'T9',
  },
  {
    action: 'jumpLast',
    keys: ['Ctrl-End'],
    hint: '跳到尾',
    note: '跳到当前列表或阅读的末尾',
    by: 'T9',
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
    note: '删除光标左边一个字符，组合符号一起删除',
    by: 'T4',
  },
  {
    action: 'delete',
    keys: ['Delete'],
    hint: '删一格',
    note: '删除光标右边一个字符，组合符号一起删除',
    by: 'T4',
  },
  {
    action: 'left',
    keys: ['←'],
    hint: '左移',
    note: '光标向左一个字符，组合符号一起移动',
    by: 'T4',
  },
  {
    action: 'right',
    keys: ['→'],
    hint: '右移',
    note: '光标向右一个字符，组合符号一起移动',
    by: 'T4',
  },
  {
    action: 'wordLeft',
    keys: ['Alt-B', 'Ctrl-←'],
    hint: '退一个词',
    note: '光标向左一个词，连续汉字一起移动',
    by: 'T4',
  },
  {
    action: 'wordRight',
    keys: ['Alt-F', 'Ctrl-→'],
    hint: '进一个词',
    note: '光标向右一个词',
    by: 'T4',
  },
  {
    action: 'killToStart',
    keys: ['Ctrl-U'],
    hint: '清行',
    note: '删除光标前的输入；已在行首时清空整行，可粘回',
    by: 'T4',
  },
  {
    action: 'killWord',
    keys: ['Ctrl-W'],
    hint: '删一个词',
    note: '删除光标左边一个词，可粘回',
    by: 'T4',
  },
  {
    action: 'killToEnd',
    keys: ['Ctrl-K'],
    hint: '删到行尾',
    note: '删除光标后的输入，可粘回',
    by: 'T4',
  },
  {
    action: 'yank',
    keys: ['Ctrl-Y'],
    hint: '粘回',
    note: '把最近删除的一段粘回光标处',
    by: 'T4',
  },
  {
    action: 'undo',
    keys: ['Ctrl-Z'],
    hint: '撤销',
    note: '撤销上一步，也能恢复取消时清空的输入',
    by: 'T4',
  },
  {
    action: 'redo',
    keys: ['Alt-Z'],
    hint: '重做',
    note: '重做刚撤销的那一步',
    by: 'T4',
  },
  {
    action: 'toggleFold',
    keys: ['Ctrl-O'],
    hint: '展开粘贴',
    note: '展开或收起长段粘贴，输入原文保持完整',
    by: 'T4',
  },
  {
    action: 'menu',
    keys: ['/'],
    hint: '命令菜单',
    note: '打开命令列表；选择后填入输入，发送才运行',
    by: 'T4',
  },
  {
    action: 'panel',
    keys: ['Ctrl-P'],
    hint: '命令面板',
    note: '打开可筛选的列表；命令输入查命令，其余输入查按键',
    by: 'T4',
  },
  {
    action: 'complete',
    keys: ['Tab'],
    hint: '补全/视图',
    note: '补全输入；阅读时换面，其余时候切换对话、进展、结果与花费',
    says: { read: '换一面' },
    by: 'T4',
  },
  {
    action: 'focus',
    keys: ['Alt-1…9'],
    hint: '切到第 n 格',
    note: '查看第 1 到 9 个执行者的进展',
    by: 'T8',
  },
  {
    action: 'read',
    keys: ['Ctrl-R'],
    hint: '阅读面',
    note: '查看当前计划全文或文件改动、事件与详情；再按一次收起',
    says: { gate: '看全', plan: '返回确认' },
    by: 'T9',
  },
  {
    action: 'mention',
    keys: ['@'],
    hint: '引用路径',
    note: '把工作区中的文件路径插入输入',
    by: 'T4',
  },
  {
    action: 'go',
    keys: ['g', 'G'],
    hint: '继续这一轮',
    says: { pending: '查看确认' },
    note: '有待确认的任务时查看计划；其余时候继续当前任务',
    by: 'T2',
  },
  {
    action: 'approve',
    keys: ['y'],
    hint: '执行',
    note: '执行整批：确认卡开着且输入为空时，按一次选择，再按一次或提交键确认',
    by: 'T6',
  },
  {
    action: 'reject',
    keys: ['n'],
    hint: '暂不执行',
    note: '暂不执行：按一次选择，再确认；计划保留，可补充要求再讨论',
    by: 'T6',
  },
  {
    action: 'help',
    keys: ['?'],
    hint: '按键帮助',
    note: '查看全部按键，取消可返回原画面',
    by: 'T2',
  },
]

/** 场景内精选当前动作；宽屏也不补入其他场景的键。any 供完整命令行帮助沿用原表。
 * 确认卡自身已有批准、拒绝、返回，常驻提示只补全文与翻项。
 */
export const HINT_WHEN: Readonly<Record<HintWhen, readonly UiAction[]>> = {
  any: ['submit', 'menu', 'complete', 'read', 'interrupt', 'quit', 'panel'],
  input: ['submit', 'menu', 'read', 'complete', 'help'],
  done: ['quit', 'read', 'submit', 'help'],
  typing: ['submit', 'newline', 'cancel', 'mention'],
  run: ['cancel', 'submit', 'read', 'help'],
  queue: ['submit', 'cancel', 'read', 'help'],
  search: ['cancel', 'historyOlder', 'submit'],
  pending: ['go', 'read', 'help'],
  menu: ['cancel', 'historyNewer', 'historyOlder', 'submit', 'read'],
  menuEmpty: ['cancel', 'killToStart'],
  plan: ['cancel', 'historyNewer', 'historyOlder', 'pageDown', 'read'],
  gate: ['read', 'historyOlder', 'historyNewer'],
  read: ['complete', 'historyOlder', 'historyNewer', 'cancel', 'pageDown'],
}

const CONTEXT_HINT: Partial<Record<HintWhen, Partial<Record<UiAction, string>>>> = {
  input: { submit: '发送', menu: '命令', read: '记录', complete: '视图', help: '帮助' },
  done: { read: '记录', submit: '发送', help: '帮助' },
  typing: { submit: '发送', newline: '换行', cancel: '清空输入', mention: '文件' },
  run: { cancel: '停止', submit: '排队', read: '记录', help: '帮助' },
  queue: { submit: '下一条', cancel: '取消末条', read: '记录', help: '帮助' },
  search: { cancel: '结束反查', historyOlder: '更早', submit: '发送' },
  menu: { cancel: '返回', historyNewer: '下一项', historyOlder: '上一项', submit: '选择', read: '看全' },
  menuEmpty: { cancel: '返回' },
}

/**
 * 这一刻是哪一档（第三幕 ②）：阅读面开着报 `read`，门口展开报 `gate`，收起但仍在等待报 `pending`，其余报 `any`。
 *
 * **为什么阅读面压过门口**：门口那一块里**自己就印着**它那三个键（`y 放行整批 · n 拒绝 · Esc 收起`——第三幕 ① 那一行还单独染了等待黄），而阅读面那几样（`Tab` · `↑`/`↓` · `Esc`）在屏幕上
 * 只有提示行这一处说得出。两样同时开着的时候，这一行让给"别处查不到的那一份"。
 */
export function hintWhenOf(o: { readonly gate: boolean; readonly read: boolean; readonly pending?: boolean }): HintWhen {
  if (o.read) return 'read'
  if (o.gate) return 'gate'
  if (o.pending) return 'pending'
  return 'any'
}

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
  PgUp: ['\u001b[5~'],
  PgDn: ['\u001b[6~'],
}

/** 可打印 = 空格以上、`DEL` 以下（表里没吃掉的那些字走 `insert`）。 */
function isPrintable(cp: number): boolean {
  return cp >= 0x20 && cp !== 0x7f
}

/**
 * **只在行里没字的地方算动作**的那几条。两种：`q`/`Q` · `g`/`G` · `?` · `/` · `@` 是**可打印
 * 字符**，`Ctrl-D`（`quit`）是**控制字符**。
 *
 * 判据（`ui/console.ts` 分发处那一条闸是它唯一的用处）：
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
 * 判据收在一处：`ui/console.ts` 分发处那一条闸读它，别处谁都不许再写一遍。
 */
export function fallsToText(a: UiAction, key: string | undefined, text: string, caret: number): boolean {
  if (key === undefined || actsOnEmpty(a, text, caret)) return false
  const cp = key.codePointAt(0)
  return cp !== undefined && isPrintable(cp)
}

/**
 * **已经落了地的那几格**：提示行只印 `by` 在这里头的那些，帮助面板给其余的缀上一句"哪一格接上"。
 * 每落一格把它的名字加进来——这一份是**进度**，不是口味（`T2` 那一条断言的判据就在这儿：目录与
 * 分发同一张表，而"这一格接上了没有"也只有一个地方说）。
 */
export const WIRED: readonly Stage[] = ['T2', 'T3', 'T4', 'T5', 'T6', 'T8', 'T9']

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
function byteMapOf(km: Keymap = KEYMAP): ReadonlyMap<string, Decoded> {
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
// DCS / OSC / APC / PM / SOS carry text until ST; OSC also accepts BEL.
// Their payload belongs to the terminal and must never reach the editor/key map.
const STRING_CONTROLS = new Set(['P', ']', '_', '^', 'X'])
function stringEndOf(s: string, i: number): number {
  const st = s.indexOf('\x1b\\', i + 2)
  const bel = s[i + 1] === ']' ? s.indexOf('\x07', i + 2) : -1
  // CAN/SUB cancel string mode; bytes after them are ordinary input again.
  const can = s.indexOf('\x18', i + 2), sub = s.indexOf('\x1a', i + 2)
  const ends = [st < 0 ? -1 : st + 2, bel < 0 ? -1 : bel + 1,
    can < 0 ? -1 : can + 1, sub < 0 ? -1 : sub + 1].filter(end => end >= 0)
  return ends.length === 0 ? -1 : Math.min(...ends)
}

export function escapeAt(s: string, i: number): number {
  if (s[i] !== '\u001b') return 0
  const next = s[i + 1]
  if (next === undefined) return 1
  if (STRING_CONTROLS.has(next)) {
    const end = stringEndOf(s, i)
    return end < 0 ? s.length - i : end - i
  }
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
  if (STRING_CONTROLS.has(s[i + 1]!)) return stringEndOf(s, i) < 0
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
      if (!escapeTruncatedAt(chunk, i) || (esc === 2 && STRING_CONTROLS.has(chunk[i + 1]!))) {
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

/** 未知尺寸的阅读与候选翻页沿用四行；已知正文容量由 stage 按当前半屏计算。 */
export const PAGE_STEP = 4

/** 粘贴的另一半记号（`ESC[201~`）等多久（毫秒）：到点还没来就退出粘贴态，攒着的照交（U10）。 */
export const PASTE_WAIT_MS = 1000

/** 一块一块喂进来的解码器（终端可能把一条序列切在两个 `data` 之间）。 */
export interface Decoder {
  /** 还没凑成一个键的那半截（空串就是没有）。 */
  readonly pending: string
  /** 粘贴记号开了一半（`ESC[200~` 到了、`ESC[201~` 还没到）。 */
  readonly pasting: boolean
  feed(chunk: string): readonly Decoded[]
  /** 普通半截按 Esc 处理；字符串残包丢弃，共用前缀的完整 Alt 键按绑定处理。 */
  flush(): readonly Decoded[]
  /** 粘贴超时：退出粘贴态，把攒到的那一段当原文交出去（`insert`）。 */
  bailPaste(): readonly Decoded[]
}

export function decoderOf(km: Keymap = KEYMAP, onControl?: (sequence: string) => void): Decoder {
  const bytes = byteMapOf(km)
  let pending = ''
  /** 粘到一半的那一段（`ESC[200~` 到了、`ESC[201~` 还没到）。 */
  let paste: string | null = null
  return {
    get pending(): string { return pending },
    get pasting(): boolean { return paste !== null },
    feed(chunk: string): readonly Decoded[] {
      let s = pending + chunk
      pending = ''
      // A paste delimiter can itself cross chunks; retain its literal prefix.
      if (paste !== null) { s = paste + s; paste = '' }
      const out: Decoded[] = []
      let i = 0
      while (i < s.length) {
        // Paste markers are interpreted only outside terminal control strings.
        if (paste !== null) {
          const end = s.indexOf(PASTE_OFF, i)
          if (end < 0) { paste += s.slice(i); return out }
          out.push({ action: 'insert', text: paste + s.slice(i, end) })
          paste = null; i = end + PASTE_OFF.length
          continue
        }
        if (s.startsWith(PASTE_ON, i)) { paste = ''; i += PASTE_ON.length; continue }
        // An unbound ESC + ESC is two boundaries, not an invented Alt key.
        // Preserve a real Esc when a terminal report starts before its timeout.
        const esc = s.startsWith('\u001b\u001b', i) && !bytes.has('\u001b\u001b') ? 1 : escapeAt(s, i)
        if (esc > 0) {
          if (escapeTruncatedAt(s, i)) { pending = s.slice(i); break }
          const sequence = s.slice(i, i + esc)
          const d = bytes.get(sequence)
          if (d !== undefined) out.push(d)
          else onControl?.(sequence)
          i += esc
          continue
        }
        const size = codepointSize(s.codePointAt(i)!)
        const ch = s.slice(i, i + size), d = bytes.get(ch)
        if (d !== undefined) out.push(d)
        else if (isPrintable(s.codePointAt(i)!)) out.push({ action: 'insert', text: ch, key: ch })
        i += size
      }
      return out
    },
    flush(): readonly Decoded[] {
      if (pending === '') return []
      const rest = pending
      const head = pending[0] as string
      pending = ''
      if (STRING_CONTROLS.has(rest[1] ?? '')) {
        // A configured two-byte Alt key can share a string prefix; a partial
        // report with a payload is never a cancel or a user action.
        const bound = rest.length === 2 ? bytes.get(rest) : undefined
        return bound === undefined ? [] : [bound]
      }
      const one = bytes.get(head)
      // **其余整段丢弃**（U10）：攒在半截里的 `ESC [` 续字节不是人按的键——回灌解一遍会把 `[` 之
      // 类当字打进行里（残包在慢链路上成对出现时，输入行里会多出几个没人打过的字符）。
      return one === undefined ? [] : [one]
    },
    bailPaste(): readonly Decoded[] {
      if (paste === null) return []
      const text = paste
      paste = null
      return [{ action: 'insert', text }]
    },
  }
}

/** 那一条印成什么（第三幕 ②）：键串照旧，那一句话按处境挑（`says[所处那一档]` 没有就用 `hint`）。 */
const entryOf = (b: Binding, when: HintWhen = 'any'): string =>
  `${keyLabelOf(when === 'done' ? { ...b, keys: b.keys.slice(0, 1) } : b)} ${CONTEXT_HINT[when]?.[b.action] ?? (when === 'any' ? undefined : b.says?.[when]) ?? b.hint}`

/**
 * 某一档下该印的那几条：`WIRED` 先过一遍（许诺一个按下去没反应的键，比少印几条坏得多），再看
 * `HINT_WHEN` 点了谁的名。
 *
 * `any` 那一档优先发送、命令、视图与阅读（第三幕 ② 之前的样子）；其他场景只
 * 展示点名的动作——次序与筛选都在这一处算。
 */
export function hintPicksOf(km: Keymap = KEYMAP, when: HintWhen = 'any'): readonly Binding[] {
  const wired = km.rows.filter((b) => WIRED.includes(b.by))
  const want = HINT_WHEN[when]
  if (want.length === 0) return when === 'any' ? wired : []
  const byAction = new Map(wired.map((b) => [b.action as string, b]))
  const named: Binding[] = []
  for (const a of want) {
    const b = byAction.get(a)
    if (b !== undefined) named.push(b)
  }
  if (when !== 'any') return named
  const used = new Set(named.map((b) => b.action))
  return [...named, ...wired.filter((b) => !used.has(b.action))]
}

/**
 * 提示那一行。**由表推出来**，只印**已经落了地的**那些（`by` 在 `WIRED` 里）——许诺一个按下去没
 * 反应的键，比少印几条坏得多。`limit` 是按屏幕宽度取前几条：**装不下的那几条不印**。
 *
 * 这一行**只印此刻按得动的**，不缀"还有 N 条，按 Ctrl-P 看全部"那半句：把"这个界面一共多少个键"
 * 端到人面前，挡的是"此刻按哪个"。`--help` 那一行读的是同一个函数，于是它也少一句
 * （`test/golden/frames/help.json` 那一帧跟着重录）。
 *
 * `when`（第三幕 ②）是"此刻屏幕上是什么"；缺省 `any` 优先显示聊天与按需查看的入口。
 */
export function hintLineOf(km: Keymap = KEYMAP, limit = 0, when: HintWhen = 'any'): string {
  const ready = hintPicksOf(km, when)
  if (ready.length === 0) return '按键：这一档还没有接上线的键'
  const shown = limit > 0 && ready.length > limit ? ready.slice(0, limit) : ready
  return `按键 ${shown.map((b) => entryOf(b, when)).join(' · ')}`
}

/**
 * 那一行里最多放得下几条：**宽度是入参**（提示行是给屏幕看的，不是给文件看的）。一条一条地量，
 * 量的是**整行**。
 *
 * 为什么要它：表落到 28 条已经落地的动作之后，整行印出来是 438 列（实测）——终端会把它折成五行，
 * 那正是这一档最难看的样子。窄到一条都放不下时给 1（只印一条）。
 */
export function hintLimitOf(columns: number, km: Keymap = KEYMAP, when: HintWhen = 'any'): number {
  const total = hintPicksOf(km, when).length
  if (total === 0) return 0
  for (let n = 1; n <= total; n += 1) {
    if (widthOf(hintLineOf(km, n, when)) > columns) return Math.max(1, n - 1)
  }
  return total
}

/** 已知容量内只放完整条目；首项也太长时去抬头和备用键，完整帮助照旧。 */
export function hintLineForWidth(columns: number, km: Keymap = KEYMAP, when: HintWhen = 'input'): string {
  const line = hintLineOf(km, hintLimitOf(columns, km, when), when)
  if (!Number.isFinite(columns) || columns < 1 || widthOf(line) <= columns) return line
  const first = hintPicksOf(km, when)[0]
  if (first === undefined) return line
  const compact = entryOf({ ...first, keys: first.keys.slice(0, 1) }, when)
  return widthOf(compact) <= columns ? compact : line
}

/** 写进终端历史的那一句注记里放几条（第三幕 ②）：常数收在这里，不在两处各写一个数。 */
const NOTE_KEYS = 4

/**
 * 同一档下"按什么键干什么"的那一段——**不带 `按键 ` 抬头，也不带"还有 N 条"那一句尾巴**。给写进
 * 终端历史的一句注记用（阅读面开的那一下）。
 *
 * 它与提示行**同一份来源**（`hintPicksOf` + `entryOf`）：措辞在 `TABLE`，次序在 `HINT_WHEN`，
 * 两处不会各说各的。**写死一句在调用处**就迟早与提示行说两样的话——这一条是这一份函数存在的理由。
 */
export function hintKeysOf(km: Keymap = KEYMAP, when: HintWhen = 'any', limit = NOTE_KEYS): string {
  const ready = hintPicksOf(km, when)
  const shown = limit > 0 && ready.length > limit ? ready.slice(0, limit) : ready
  return shown.map((b) => entryOf(b, when)).join(' · ')
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
 * 拨哪一下由调用方决定（`ui/console.ts` 的 `tui`）。
 *
 * 不是 TTY → 返回一个空句柄（`raw: false` · `close()` 什么也不做），**一个字节都不读**：这一条与
 * `ui/term.ts` 那一档是同一条地板，写在两处各说各的那一半。
 */
export function openKeys(o: {
  readonly input: KeyInput
  readonly onAction: (d: Decoded) => void
  /** Unbound complete controls, outside bracketed paste; terminal reports only. */
  readonly onControl?: (sequence: string) => void
  readonly km?: Keymap
  readonly wait?: WaitFn
  /** 写字节的那一头（`process.stdout`）：**只用来开关 bracketed paste**。不给就不开。 */
  readonly out?: { write(s: string): unknown } | undefined
}): KeySource {
  const input = o.input
  const raw = input.isTTY === true && typeof input.setRawMode === 'function'
  if (!raw) return { raw: false, close(): void {} }
  const dec = decoderOf(o.km ?? KEYMAP, o.onControl)
  const wait = o.wait ?? realWait
  // **流式解码（U9）**：一个闭包里的 `TextDecoder` 带 `{ stream: true }` 喂到底——多字节字符
  // 被拆在两个 chunk 里时（慢链路上常事）第二个块接着解，不出替换符。此前每个 chunk 新开一个
  // decoder，残在块尾的那几个字节当场变成 U+FFFD 印进行里。
  const utf8 = new TextDecoder()
  let stop: (() => void) | null = null
  // 粘贴的另一半记号没来的那一档（U10）：记号开了一半，超时（`PASTE_WAIT_MS`）就把攒着的当原文
  // 交出去、退出粘贴态——不然粘贴那一段永远卡在缓冲里，后面按的每一个键一个动作都不出。
  let bailStop: (() => void) | null = null
  const onData = (chunk: string | Uint8Array): void => {
    const text = typeof chunk === 'string' ? chunk : utf8.decode(chunk, { stream: true })
    if (stop !== null) {
      stop()
      stop = null
    }
    if (bailStop !== null) {
      bailStop()
      bailStop = null
    }
    for (const d of dec.feed(text)) o.onAction(d)
    if (dec.pasting) {
      bailStop = wait(PASTE_WAIT_MS, () => {
        bailStop = null
        for (const d of dec.bailPaste()) o.onAction(d)
      })
    }
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
      if (bailStop !== null) {
        bailStop()
        bailStop = null
      }
      input.removeListener('data', onData)
      input.setRawMode?.(false)
      o.out?.write(PASTE_DISABLE)
      // **收尾即不再读按键**（`pause()` 把那条 TTY 读停掉）：摘了监听只不再交键，stdin 还在
      // flowing——那一条 referenced 的 tty 读是唯一还攥着事件循环的句柄，退出码交给循环去收的
      // 那一版（不再 `process.exit` 强推）在信号那一档就永远退不出去（诊断报告量到的：
      // referenced+active 的 handle 恰一个 tty）。可选调用：真流都有它，测试里的假输入
      // 只模型化「监听与 raw mode」那两样。
      input.pause?.()
    },
  }
}
