// TUI 的第三格：**接终端**（擦 K 行 / 写 K 行）。出处：PLAN § 5.19 第五段（`UI2` 那一行 ·
// 「形态」「行数账」「地板四档」那几段）· 架构 § 9.8（可附着 TUI 那一行与它那几条定死）。
//
// 这一份只做两件事：把一块**恒定 K 行**的区域摆在终端底部，以及在它上方追加永久行。
// **渲染不在这里发生**——面板那 K 行是调用方算好的（`ui/frame.ts` 的 `frameOf` → `panelOf`），
// 这一份只量列宽、只擦、只摆。于是"底下那块画得对不对"与"终端上的字节对不对"是两件分得开、
// 各自证得动的事（`frame.test.ts` 拿 `lines` 当答案 · `term.test.ts` 拿字节当答案）。
//
// **区域的形状**（唯一会错的地方，所以写清楚）：面板占恒定 `height` 行，每行**恰好 `columns` 列**
// （`panelOf` 先截后补）——1 逻辑行 = 1 物理行，所以"上移 K 行"永远落回面板顶上。一次重画：
//
//   · 上移「上一次画完时光标停的那一行」（0 = 面板顶）→ 光标到面板顶；
//   · 新到的永久行**从面板顶写下去**（按列宽拆成物理行，逐行清写）——面板因此被顶下去 n 行；
//   · 面板那 K 行接着往下写（`\x1b[2K` 逐行清 + 重写）；
//   · 输入行那几行写在面板**下面**（`Panel.input`；逐行清 + 重写，最后一行不带换行）；
//   · 光标停在**最后一行输入行**上——不变量：下一次上移「上一次停的那一行」仍然落在面板顶上。
//
// **输入行是 `T4` 加进来的**（在那之前这一块区域只有 K 行面板）。它那几行**不计进 K**：K 是面板的
// 高度，输入行是它下面另起的一行块。于是"上移多少"从一个常数变成一个记下来的数（`cursorRow`），
// 收走这一块也从"删 K 行"变成"删这一块一共几行"（`regionRows`）。两条都只在有输入行时与从前不同
// ——`term.test.ts` 拿"没有输入行时逐字节不变"钉住这件事。
//
// **提示行与框下那一个空行是第二幕 ④ 加进来的**：它们在框下面、输入行上面，**算在 K 里**
// （`ui/layout.ts`：框 10 ＋ 空 1 ＋ 提示 1 = K 12）。从前提示行是启动时写进终端历史的一行**永久
// 行**——进了历史就追不回来（宽度变了它还是旧的那一串），现在每帧重画、位置固定。**装不下时先丢
// 的是它**（框那一格一行不让）：判据是「框 ＋ 那两行还放不放得进终端」，放不进就只画框。
//
// **输入行不长出去**：调用方给的每一行宽度 ≤ `columns` − 1（`ui/input.ts` 的 `inputFrameOf` 就是按
// "量到的列宽减一"折的），所以一行输入行就是一个物理行，`\x1b[KA` 那条算术不会被终端的自动换行
// 打乱。光标那一下是在写完那一行之后**往左退**到光标列（显示宽度算，不是 code unit）。
//
// **永久行只写一次。** 它们在面板上方，重画时只有面板那 K 行被擦改：终端历史里那一串是干净的
// 流水（翻得回去 · 搜索 · 连 `| tee` 出去都没有转义序列）。
//
// **宽度变窄（resize）不猜重排。** 旧行可能拆成多条并进入 scrollback，各家终端重排行为不同。
// 这一档从下面另起一块，避免猜位置吃历史。变宽时旧区域每行都有显式换行，仍各占一条物理行，
// 可以原位替换；终端增高也保留旧顶边。可信完整回报且宽高一起缩至满窗时，记录原宽高
// 上限；在该范围内恢复前清理已证明自有的可见行。无回报、新事实、图形或越过上限保留原路径。
//
// **地板：不是 TTY / `$TERM` 认不出来 → 一个字节的 ANSI 都不写。** 那一档 `draw` 只把永久行按
// 到达序印出去，面板整块不画（重定向出去就是一份干净的事件流水，CI 里不会有半块面板）。
// `$TERM` 认不认得出来由 `ansiOf` 那张表说了算：认不出来就退。**这是手写 ANSI 相对 `terminfo`
// 丢掉的那一样东西，价码写在这里**——什么条件下改主意：要认的终端多了，往 `KNOWN_TERM` 里加一行；
// 反过来，哪一台终端上这几条 escape 画错了，就从那张表里划掉（退一档比画错好）。
//
// **`--full`（`T10`）：整屏那一档只多两个 escape**——进来写 `\x1b[?1049h`（进 alt screen），收尾写
// `\x1b[?1049l`（出来）。**排版那一层一行不动**：K 行面板 · 永久行的次序 · 宽度 · 那次上移，与不
// 整屏那一档**逐字节相同**（`term.test.ts` ⑨拿"两档的字节流只差这两条"钉住）。价码如实说：进了 alt
// screen 就没有终端历史可翻——永久行落在那一块里，与人一起消失。**所以缺省关**（PLAN § 5.19 第二版
// 一 · 取舍第一条：同类里三家把它做成可选或缺省关）。
//
// **实测自有 full 的 resize**：调用方提供实际 alternate screen 报告后，尺寸变化只重建这块屏，
// 按新宽度重放最近一屏永久行。Kitty 先收回本号图片，再清文字；Sixel 不再使用旧相对坐标。
// CLI 只在显式 auto 图形档读取所有权；关图不探测，未知或拒绝切屏保留旧 full 文字路径。
// 普通缓冲区仍要求固定几何；终端后台普通缓冲区的 resize 行为不由此层控制。
//
// **行数也量（U6）：期望高度夹进终端行数。** `K` 是**期望**，不是死的：实际画的高度是
// `clamp(期望, 1, 行数 − 1)`——终端矮了面板跟着矮，不再顶穿屏幕顶（那正是刷屏五根因的第一条：
// 区域比终端高时上移被屏幕顶钳住，每帧滚一屏）。期望是**每帧现问**的（`heightOf`）：弹层（菜单 ·
// 阅读面）开着时调用方给更大的数。终端按行数连框都放不下的那一帧（面板最少 `MIN_HEIGHT` 行）
// **只印永久行**、一个字节的 ANSI 都不写——行数够了下一帧自动回来（`drawn` 没置过，回来时另起
// 一块）。高度与宽度**不是**同一条路（这一版改掉的那一处）：宽度变过是量不到重排，高度变过是量得到
// 的——那一块画在终端底部、每帧都把末行按回底行的位置，所以下一次该上移多少**算得出来**。
// 一张一块画画看的账：上移的基数是「上一次画完光标离区域顶几行」（`cursorRow`），
//
//   · 高度没变 → 上移 `cursorRow` 行（与从前逐字节相同，新块顶落在旧块顶）；
//   · 普通屏高度变高 → 只使用自己写出的空行向上扩展；它们不足时保持旧顶边向下长，
//     必要的滚动把永久行送进真正的终端历史，保住内容。新永久行让上方空行的所有权失效；
//     full 的自有屏仍按原底边扩展。
//   · 高度**变矮** → 仍上移 `cursorRow` 行（顶边不动），多出来的那几行在下面擦成空行
//     （与输入行变少那一条同路）。
//
// 从前这一档两边都不上移（把高度当成宽度那一条处理）：新块就地往下写，一帧滚掉一屏，旧块留在屏幕上
// ——退出之后还看得见它。**什么条件下改主意**：这几条 escape 在某一台终端上量错了位置（比如它把
// `\x1b[KM` 当成别的意思），就从 `KNOWN_TERM` 里划掉那一台，退到只印永久行那一档。
// 收尾时行数变过仍不删面板（那一块漂到哪儿量不到）。
//
// **一帧一笔（U3）**：`draw` 把那一帧的所有片段拼成一个串、`out.write` 恰一次（`close` 同理）。
// 逐行小 write 在慢链路（ssh · mux 那一头）上是撕裂与闪跳的主因——一帧之内终端先看见半帧。
// 字节流与逐笔那一版**逐字节相同**，变的只是笔数（`term.test.ts` ①拿"每次绘制恰一笔 + 拼接等于
// 原件"钉住）。
//
// **行级 diff（U8）：未变的行掠过去，变了的行才重写。** 重画的那一帧里大多数行没动（账没到的
// 那几秒里面板几乎不变——那正是"每帧几十行 × 每秒五帧"把慢链路打满的第四条根因）。这一层记着
// 上一帧行（`lastRegion`：面板 + 输入行），逐行比对：未变 `\r` + 下移一行掠过（`\x1b[1B`），
// 变了才 `\r\x1b[2K` + 重写；**帧一个字节都没变时，那帧里的 `CLEAR_LINE` 数是零**。保险丝只有
// 一条：宽度或高度变过走全量（与"另起一块"同一条判据）；输入行行数变了也对不齐，同样走全量——
// 全量那一趟把上一帧多出来的行**擦成空行**（行数变少不留残影）。掠过与重写的**光标算术相同**
// （每行以 `\r` 起头、末尾恒回 caret 列），所以下一帧的"上移多少"不知道这一帧走了哪条路。
//
// **每行以 `\r` 起头**（U8 顺手修掉的一个错位）：上一帧结束时光标停在输入行的 caret 列，`up()`
// 只上移不改列——行首没有 `\r` 的话，下一帧第一行从 caret 列写起，整块错位。首帧同理（进程
// 启动时光标在 shell 提示符后面的哪一列，这一层量不到）。`\r` 在每一行开头把列归零，几何就闭合了。
//
// 那一条 escape 写在**第一次画**的时候（不是 `openTerm` 的时候）：`--once` 与不是 TTY 那两档一次都
// 不画，而人要把永久行留在真历史里——那两档不该进 alt screen。
//
// **退出**：`close()` 把面板那 K 行删掉（`\x1b[KM`），终端历史里只剩永久行；没画过、或宽度变过
// （重排之后不知道那 K 行落在哪）就一个字节都不写。**alt screen 那一条是例外**：进去过就一定要出来
// ——少写它，那台终端就停在另一块屏上，而 `--full` 缺省关的时候一个字节都不会写（两档各归各的）。
import type { BottomInput, MenuInput, NavInput, ReadInput } from './frame.ts'
import { MIN_HEIGHT, panelOf } from './frame.ts'
import type { LineRole } from './frame.ts'
import { clustersOf, widthOf } from './glyph.ts'
import { FRAME_ROWS, GAP_ROWS, HINT_ROWS, REGION_ROWS } from './layout.ts'
import type { ViewKey } from './views.ts'
import { openImageLayer } from './image-layer.ts'
import type { PanelImage } from './image-layer.ts'
import type { GraphicsTier } from './image.ts'
import type { CellPixels, SixelCells } from './cell-probe.ts'

/**
 * 底部那块**重画区**的期望行数（PLAN § 5.19：K 取 12）——**框 10 ＋ 空一行 ＋ 提示行**（第二幕 ④；
 * 那一本行账住 `ui/layout.ts` 一处，这一行只是把那个名字露给这一份的读者与测试）。它是**整块地方**
 * 的账，不是喂给 `frameOf` 的那个高度（那个是 `FRAME_ROWS`）。实际画的高度是它们各自夹进终端行数的
 * 那一个（U6）。
 */
export const K = REGION_ROWS

/** 量不到列宽时兜的列数（PLAN § 5.19：`columns === undefined` 兜 80）。 */
export const FALLBACK_COLUMNS = 80

/** 上移 `n` 行。 */
export function upOf(n: number): string {
  return `\x1b[${n}A`
}

/** 光标往左退 `n` 列（输入行那一下：写完那一行，退到光标该在的列）。 */
export function leftOf(n: number): string {
  return `\x1b[${n}D`
}

/** 擦掉整行（光标不动）——"重画"就是它加一次重写。 */
export const CLEAR_LINE = '\x1b[2K'

/** 从光标那一行起删掉 `n` 行（下面那些往上顶）——退出时收走面板用的是它。 */
export function deleteLinesOf(n: number): string {
  return `\x1b[${n}M`
}

/** 进 alt screen（`--full` 那两个 escape 的第一个）：第一次画的时候写。不进这一档就一个字节都不写。 */
export const ALT_ON = '\x1b[?1049h'

/**
 * 出 alt screen（那两个 escape 的第二个）：**每一条退出路径都得写到它**——`close()` 的每一处出口
 * 都写（面板删不删是另一码事：宽度变过那一档不删面板，但**一样要出来**）。
 */
export const ALT_OFF = '\x1b[?1049l'

/**
 * 样式归位（U20 主题的那只右手）：有主题的角色包成 `sgr + 行 + STYLE_OFF`——每行自带归位，
 * 行与行之间不互相记账（U8 的行级 diff 于是不用知道主题存在）。
 */
export const STYLE_OFF = '\x1b[0m'

/**
 * 这一台终端认不认得那几条 escape。**认不出来就退**（不是"试一下"）：手写 ANSI 丢掉的那唯一样
 * 东西就是 `terminfo`，而试错的代价是屏幕上一坨乱码——那比"少画一块面板"贵得多。
 *
 * 判据是**前缀**（`xterm-256color` · `screen.xterm` · `tmux-256color` 都在里面）；短的几项带尾巴
 * 的连字符（`st-`），免得 `st` 把 `stupid` 也认了。
 */
export const KNOWN_TERM: readonly string[] = [
  'xterm',
  'screen',
  'tmux',
  'vt100',
  'vt102',
  'vt220',
  'ansi',
  'linux',
  'cygwin',
  'msys',
  'rxvt',
  'konsole',
  'kitty',
  'alacritty',
  'wezterm',
  'foot',
  'st-',
  'nsterm',
  'iterm',
  'putty',
  'contour',
  'ghostty',
]

/** `$TERM` 那一栏 → 认不认得。空、`dumb`、认不出来的都退到"只印永久行"那一档。 */
export function ansiOf(term: string | undefined): boolean {
  if (typeof term !== 'string') return false
  const t = term.toLowerCase()
  if (t === '' || t === 'dumb') return false
  return KNOWN_TERM.some((k) => t.startsWith(k))
}

/**
 * **降级说一声**（U10a）：真终端而 `$TERM` 是**认不出来的**值时，该说的那句话；其余场合
 * `null`（不说）。**只此一档说**：不是 TTY（管道 · CI）不说——那一档退到永久行是常态，
 * 不是意外；`''` · `dumb` · 没设不说——那是**声明过的没有**，不是认不出；`--once` 那一档
 * 由调用方跳过（本来就不画面板，没有"退"这回事）。判据与 `ansiOf` 同一张表。
 */
export function degradeNote(term: string | undefined, isTTY: boolean | undefined): string | null {
  if (isTTY !== true) return null
  if (typeof term !== 'string' || term === '' || term.toLowerCase() === 'dumb') return null
  if (ansiOf(term)) return null
  return `$TERM=${term} 认不出来，退到只印永久行那一档（不画面板——KNOWN_TERM 之外都退，退一档比画错好）`
}

/** 这一份只用到输出那一头的几个栏（`process.stdout` 就是它）。 */
export interface TermOut {
  write(s: string): unknown
  /** `process.stdout.isTTY`：不是 TTY 就不写一个字节的 ANSI。 */
  readonly isTTY?: boolean | undefined
  /** 终端此刻几列（量不到是 `undefined`）。 */
  readonly columns?: number | undefined
  /** 终端此刻几行（量不到是 `undefined`）——矮终端那一档要它（U6）。 */
  readonly rows?: number | undefined
}

/** 输入行那几行：已经带提示符，每行宽度 ≤ `columns` − 1（所以一行就是一个物理行）。 */
export interface PanelInput {
  readonly rows: readonly string[]
  /** 光标在第 `row` 行第 `col` 列（显示列，0 基）。**最后一行就是光标停的那一行。** */
  readonly caret: { readonly row: number; readonly col: number }
}

/** 面板那一块：`rows` 是那个框（补到正好 `height` 行），`input` 是它下面那几行输入行（不给就没有）。 */
export interface Panel {
  readonly segments?: readonly (readonly { readonly text: string; readonly role: LineRole }[])[] | undefined
  /** 已解码的图片，独立于可转义的文字；缺省不画。 */
  readonly image?: PanelImage | undefined
  readonly rows: readonly string[]
  /**
   * 那几行各自的角色（U20，与 `rows` 逐行对应；短出来的按 `body`）。**只在地基这一层报**——
   * 有没有样式由 `theme` 说了算，不给 `roles` 就当全是 `body`。
   */
  readonly roles?: readonly LineRole[] | undefined
  /**
   * 框下面那一行提示行（第二幕 ④）：**框下先空一行、再印它**——那两行都在重画区里（都算在 `K`
   * 里），于是它每帧重画、位置固定（不再是一行写进终端历史就追不回来的注记）。不给（或空串）时
   * 那两行都没有，与从前逐字节相同。**装不下时先让位的是它**（框那一格一行不让）。
   */
  readonly hint?: string | undefined
  readonly input?: PanelInput | undefined
}

/** 界面自己那几样（`T4`）：候选那一层与输入行。**纯视图状态**（授权 · 排队 · 处境一律落在账上）。 */
export interface ViewInput {
  /** 任务记录的实际阅读键，供省略处就近显示。 */
  readonly taskReadKey?: string | undefined
  readonly menu?: MenuInput | undefined
  /**
   * 面板最下面那一栏（`T6` 的门口那一块 · `T7` 的排队行）：**它是面板那一栏的最下面**，不是输入行
   * 那一栏（输入行还在它下面）。
   */
  readonly bottom?: BottomInput | undefined
  /**
   * 树那几个节点（`T8`）：**排在内容那一栏的最上面**（导航：主线为根 · agent 缩进一级）。`sel` 是选中
   * 哪一个（`frame.ts` 那一层按它把选中的那个留在窗里）。**对话视图那一档不印它**（第二幕 ⑦：
   * 决策材料的线框稿里没有树，切格走 `Alt-1…9`），所以它只在 `progress` / `spending` 两档里出现。
   */
  readonly nav?: NavInput | undefined
  /**
   * 切到哪一格（`T8`）：agent 的 writer id，`undefined` 或 `null` = **整份账**（主线那一档）。
   *
   * 折帧那一头**按它筛行**（`ui/follow.ts`）——不是折完再挑印哪几行，于是"切过去"与 `status --agent
   * <x>` 读的是同一批行（`T8` 那句断言查的就是它）。
   */
  readonly focus?: string | null | undefined
  /**
   * 看哪一档视图（第二幕 ⑦）：对话（缺省）· 处境 · 读数。与 `FrameInput.view` 同一样东西，
   * 这一层只带话（谁开的面板由舞台那一边说了算）。
   */
  readonly view?: ViewKey | undefined
  /**
   * 阅读面那一栏（`T9`）：**排在内容那一栏的最下面**（`ui/read.ts` 算好的那几行 · `top` 是看到第几
   * 行起）。它不给时一个字节都不占。
   */
  readonly read?: ReadInput | undefined
  /**
   * 框下面那一行提示行（第二幕 ④）：与 `Panel.hint` 同一样东西——`ui/follow.ts` 那一层把舞台折出来
   * 的这一份带话到终端那一层（它自己不算这一行）。
   */
  readonly hint?: string | undefined
  readonly input?: PanelInput | undefined
}

/** 面板那一块：给一个尺寸，还回那几行（**渲染在调用方**，这一份只量尺寸）。阵列是"没有输入行"那一档。 */
export type RenderPanel = (size: {
  readonly columns: number
  readonly height: number
}) => readonly string[] | Panel

export interface TermOptions {
  /** Fresh zero-based CPR for this completed text frame; no report keeps the original path. */
  readonly requestCursor?: ((rows: number, accept: (row: number, column: number) => void) => void) | undefined
  /** 缺省关；Sixel 另需已核对的能力与固定几何。 */
  readonly graphics?: GraphicsTier | undefined
  /** 普通缓冲区要求固定几何；full 中终端层收回自有平面并重建。 */
  readonly sixelCells?: (() => SixelCells | null) | undefined
  /** 实测 Kitty 字格；没有报告时保留文字，旧装配未提供时仍走原协议。 */
  readonly kittyCells?: (() => CellPixels | null) | undefined
  /** full 重排只清理实测自有的 alternate screen；未知/拒绝切屏走旧文字档。 */
  readonly alternateScreenOf?: (() => boolean) | undefined
  /** ALT_ON 已发出且本帧几何已记好；在 raw 输入接好后查询实际屏幕报告。 */
  readonly onAlternateScreen?: (() => void) | undefined
  readonly out: TermOut
  /** 这一台终端叫什么（`process.env.TERM`）。缺省读环境。 */
  readonly term?: string | undefined
  /** **框**那一块的期望高度（缺省 `FRAME_ROWS`）。实际画的高度是它夹进终端行数的那一个（U6）。 */
  readonly height?: number
  /**
   * 量行数那一处（缺省读 `out.rows`，与 `columnsOf` 同形）：真终端上就是它，resize 那一档要一个
   * 会变的数。量不到（`undefined`）就不夹——那一档与从前逐字节相同（U6 之前的行为）。
   */
  readonly rowsOf?: () => number | undefined
  /**
   * 期望高度那一问（**每帧现问**，U6）：弹层（菜单 · 阅读面）开着时调用方给更大的数，关了回到
   * 缺省。缺省就是 `height ?? FRAME_ROWS`。给的这个数仍要夹进终端行数——想要多大是调用方的事，画得下
   * 多大是这一层的事。
   */
  readonly heightOf?: () => number
  /** 空首帧按舞台会使用的最大框高预留；缺省按宿主容量，坏数值不预留。 */
  readonly reserveHeightOf?: () => number
  /** 量列宽那一处（缺省读 `out.columns`）：真终端上就是它，resize 那一档要一个会变的数。 */
  readonly columnsOf?: () => number | undefined
  /**
   * 整屏那一档（`--full`）：多两个 escape（`ALT_ON` / `ALT_OFF`），**排版一行不动**。缺省关。
   * 不是 TTY 或 `$TERM` 认不出来时它没有意义（那一档一个字节的 ANSI 都不写，更不进 alt screen）。
   */
  readonly full?: boolean | undefined
  /**
   * 主题（U20 样式层地基）：每种行角色给一段 SGR 序列（比如 `border: '\x1b[2m'`）。**缺省空表——
   * 字节流一个不变**；有值的角色**先补宽再包裹**（`sgr + 行 + \x1b[0m`）：SGR 是零宽的，可见宽度
   * 仍 = 列数，于是 U8 的行级 diff 与 `close()` 的删行算术**不用知道主题存在**。永久行与输入行
   * 不在这一层（永久行进终端历史，`| tee` 仍干净；输入行是光标算术那一行，不掺 SGR）。
   */
  readonly theme?: Readonly<Partial<Record<LineRole, string>>> | undefined
}

export interface Term {
  /** 走不走 ANSI：不是 TTY，或 `$TERM` 认不出来时是 `false`（那一档只印永久行）。 */
  readonly ansi: boolean
  /** 期望高度（`heightOf` 缺省那一档的值；实际画的高度每一帧夹进终端行数，U6）。 */
  readonly height: number
  /** 上一次量到的列宽（量不到就是兜的那个 80）。 */
  readonly columns: number
  /**
   * 上一次量到的终端行数（量不到是 `undefined`）。舞台按它给面板**分账**期望高度
   * （`ui/stage.ts` 的 `panelWantOf`：输入那块不得与显示区等高）——`draw` 里**先量再问期望**，
   * 所以每一帧拿到的都是当时的数。
   */
  readonly rows: number | undefined
  /**
   * 此刻在不在 alt screen 里（`T10`）：`--full` 且画得出来（TTY · `$TERM` 认得）才有为真的那一档。
   * `close()` 之后一定是 `false`——写没写出去那条 `ALT_OFF` 由它说了算，写一次就归位。
   */
  readonly alt: boolean
  /** 摆一块：让开旧的那一块 → 写永久行 → 把面板补到 K 行写在它下面 → 有输入行就写在再下面。 */
  draw(permanent: readonly string[], render: RenderPanel): void
  /** 收走底部那一块（终端历史里只剩永久行）。 */
  close(): void
}

/**
 * 开一块。**一个句柄都不持有**：不管 stdin、不注册信号、不碰日志——信号与跟随是调用方的事
 * （`cli/fugue.ts` 的 `tui`），这一份只管那一块地方。
 */
// Permanent text keeps every cluster and separator. Explicit physical rows
// let each continuation clear old UI cells before writing; display wrap() trims
// separators and therefore cannot be used for permanent history.
function historyRows(line: string, columns: number): readonly string[] {
  const rows: string[] = []
  let row = '', used = 0
  for (const c of clustersOf(line)) {
    if (used > 0 && used + c.width > columns) {
      rows.push(row)
      row = ''; used = 0
    }
    row += c.text; used += c.width
  }
  rows.push(row)
  return rows
}

export function openTerm(o: TermOptions): Term {
  const out = o.out
  const height = o.height ?? FRAME_ROWS
  const wantOf = o.heightOf ?? ((): number => height)
  const measure = o.columnsOf ?? ((): number | undefined => out.columns)
  const measureRows = o.rowsOf ?? ((): number | undefined => out.rows)
  const ansi = out.isTTY === true && ansiOf(o.term ?? process.env.TERM)
  /** 这一档要不要整屏（`--full` 且写得出 ANSI）：两样缺一样，那一个字节都不写。 */
  const wantAlt = ansi && o.full === true
  const verifiedCells = o.sixelCells === undefined ? undefined : () =>
    wantAlt && o.alternateScreenOf?.() !== true ? null : o.sixelCells!()
  const verifiedKitty = o.kittyCells === undefined ? undefined : () =>
    wantAlt && o.alternateScreenOf?.() !== true ? null : o.kittyCells!()
  const images = openImageLayer(ansi ? o.graphics : 'none', verifiedCells, verifiedKitty)
  const ownedFull = wantAlt && o.alternateScreenOf !== undefined
  const fullSixel = wantAlt && o.graphics === 'sixel' && o.sixelCells !== undefined
  // Keep only a viewport of our own permanent physical rows. Normal history is
  // outside this plane; alternate screens already have no terminal scrollback.
  let altHistory: string[] = [],historyColumns = FALLBACK_COLUMNS
  /** 此刻在不在 alt screen 里。**只由 `draw` 置真、由 `close` 置假**——两处都不猜。 */
  let alt = false
  let notifyingAlternate = false
  let columns = FALLBACK_COLUMNS
  let drawn = false
  let drawnColumns = 0
  /** 上一次量到的终端行数（`draw` 每帧先量再问期望——`rows` 那只口读它）。 */
  let seenRows: number | undefined = undefined
  /** 上一次那一帧实际画的高度；重画时按旧区域与新区域分账。 */
  let drawnHeight = 0
  /** 上一次画的时候终端有几行；变小可能截去旧区域，close 不猜。 */
  let drawnRows: number | undefined = undefined
  /** 上一次画完时光标停在区域第几行（0 = 面板顶）——下一次"上移多少"靠它。 */
  let cursorRow = height
  let cursorColumn = 0
  // Only blank rows that this dynamic normal panel emitted are safe to grow into.
  // New permanent rows or changed host geometry invalidate that ownership.
  let ownedAbove = 0
  /** 上一次区域共几行（框、留白、提示、输入行）；close 靠它。 */
  let regionRows = height
  /**
   * 上一帧的**区域行**（框 ＋ 框下面那几行，U8）：行级 diff 的比对底稿。首帧之前 · 矮帧 · 收尾之后是
   * `null`——那些场合没有可比的上一帧，走全量。
   */
  let lastRegion: readonly string[] | null = null
  let paint = 0
  let normalAnchor: { columns: number; rows: number; top: number } | null = null
  // A bottom-owned frame moved its unowned prefix into genuine history on shrink.
  // Until a new fact or growth beyond the proven old width/height, the returning viewport is ours.
  let normalRecovery: { columns: number; rows: number } | null = null
  return {
    ansi,
    height,
    get columns(): number {
      return columns
    },
    get rows(): number | undefined {
      return seenRows
    },
    get alt(): boolean {
      return alt
    },
    draw(permanent: readonly string[], render: RenderPanel): void {
      const seen = measure()
      columns = typeof seen === 'number' && seen > 0 ? seen : FALLBACK_COLUMNS
      // **夹紧（U6）**：期望夹进终端行数（留一行），量不到行数就不夹（那一档与从前逐字节相同）。
      const rowsSeen = measureRows()
      const rowsKnown = typeof rowsSeen === 'number' && rowsSeen > 0
      // 先记账再问期望（`wantOf`）：舞台的 `panelWantOf` 读 `term.rows` 按这一帧的行数分账。
      seenRows = rowsKnown ? (rowsSeen as number) : undefined
      const cap = rowsKnown ? (rowsSeen as number) - 1 : Number.POSITIVE_INFINITY
      const h = Math.max(1, Math.min(wantOf(), cap))
      const short = rowsKnown && (rowsSeen as number) - 1 < MIN_HEIGHT
      if (ownedFull && (alt || !short)) {
        if (historyColumns !== columns) altHistory = altHistory.flatMap(row => historyRows(row, columns))
        historyColumns = columns
        const limit = rowsKnown ? rowsSeen as number : REGION_ROWS
        const incoming = permanent.flatMap(row => historyRows(row, columns))
        altHistory = [...altHistory, ...incoming].slice(-Math.max(1, limit))
      }
      // After a real terminal resize, old relative image coordinates are invalid.
      // Only the alternate plane is ours: discard stale moves and reset that plane.
      // A host can switch back itself: stale alternate-plane erases must never reach normal history.
      if (fullSixel && alt && o.alternateScreenOf?.() !== true) images.clear()
      const ownedResize = ownedFull && alt && o.alternateScreenOf?.() === true &&
        (columns !== drawnColumns || rowsSeen !== drawnRows)
      const reset = ownedResize ? (o.graphics === 'kitty' ? images.clear() : '') + '\x1b[2J\x1b[H' : ''
      if (ownedResize) {
        images.clear()
        drawn = false;lastRegion = null;drawnColumns = columns;drawnRows = rowsSeen
      }
      // 矮档：量得到行数、而按行数画面板连框都放不下（面板最少 `MIN_HEIGHT` 行）→ 只印永久行。
      // 判据是**终端**矮，不是夹出来的那个数小——调用方硬要一个 3 行的机械档（测试里那一类）照样画。
      if (!ansi || short) {
        paint += 1; normalAnchor = null; normalRecovery = null
        // 只印永久行：不是 TTY / `$TERM` 认不出那一档是常态；矮终端那一帧（U6）是**临时的地板**——
        // 行数够了的下一帧自动回到面板那一档。文字不写 ANSI；已有 Kitty 图片只按号收回，不移动光标。矮帧屏幕顶
        // 紧挨着历史，`CLEAR_LINE` 会把历史吃掉一行。矮帧过后那一块漂到哪儿量不到：上一帧行作废。
        const removedImage = images.clear()
        const budget = Math.max(0, (rowsSeen as number) - 1)
        const lines = ownedResize ? altHistory.slice(Math.max(0, altHistory.length - budget)) : permanent
        const plain = lines.map((line) => `${ownedResize ? '\r' : ''}${line}\n`).join('')
        if (reset !== '' || removedImage !== '' || plain !== '') out.write(reset + removedImage + plain)
        drawn = false
        lastRegion = null
        ownedAbove = 0
        return
      }
      const buf: string[] = reset === '' ? [] : [reset]
      let entered = false
      // 整屏那一档：**第一次画的时候进 alt screen**（不是 `openTerm` 的时候——`--once` / 不是 TTY
      // 那两档一次都不画，也就不该把永久行从真历史里挪走）。写在永久行前面：那一块屏是空的。
      if (wantAlt && !alt) {
        buf.push(ALT_ON)
        alt = true
        entered = true
      }
      // 面板先算好：**尺寸是刚刚量到的那一个**（渲染与摆是同一把尺，所以 1 逻辑行 = 1 物理行）。
      const asked = render({ columns, height: h })
      const spec: Panel = Array.isArray(asked) ? { rows: asked } : asked
      // **先补宽再包裹**（U20）：`panelOf` 把每行补到正好列数，有主题的角色在那之外再包一层
      // `sgr…off`——SGR 零宽，可见宽度仍 = 列数。`lastRegion` 记的就是这一份（包裹后的）串，
      // 同一主题下「变没变」的判定与无主题时一个样；主题中途换了（没人这么用）也只是整帧重写。
      const rows = panelOf(spec.rows, h, columns).map((line, i) => {
        const role = i < (spec.roles?.length ?? 0) ? (spec.roles as readonly LineRole[])[i] : 'body'
        const parts = spec.segments?.[i]
        if (parts !== undefined && parts.map(p => p.text).join('') === line) return parts.map(p => {
          const sgr = o.theme?.[p.role]
          return sgr === undefined ? p.text : `${sgr}${p.text}${STYLE_OFF}`
        }).join('')
        const sgr = o.theme?.[role]
        return sgr === undefined ? line : `${sgr}${line}${STYLE_OFF}`
      })
      const input = spec.input
      const body = input === undefined ? [] : input.rows
      /** 光标最后停在输入行上（那几行的末行）——不是的话光标停在整块下面一行。 */
      const lastIsInput = input !== undefined && body.length > 0
      // **框下面那两行**（第二幕 ④）：空一行 ＋ 提示行。提示行是这一块里**让位第一条**——终端装不下
      // 整块时先丢它（`框 ＋ 空 ＋ 提示 > 画得下的行数`），框那一格一行不让（交接单 § 五 ④：矮屏先
      // 让提示行，不让在飞的格）。它按自己那一格上色（`LineRole` 的 `hint`，落在弱化那一格），与
      // 面板那几行同一处包裹（先补宽再包，SGR 零宽）。
      const room = rowsKnown ? (rowsSeen as number) - 1 : Number.POSITIVE_INFINITY
      // 输入末行不换行；其余尾行和光标都计入同一物理容量。
      const wantHint = typeof spec.hint === 'string' && spec.hint !== '' && h + GAP_ROWS + HINT_ROWS + body.length <= room + (lastIsInput ? 1 : 0)
      const hintText = wantHint ? (panelOf([spec.hint as string], 1, columns)[0] as string) : null
      const hintSgr = o.theme?.hint
      const pad =
        hintText === null
          ? []
          : [' '.repeat(columns), hintSgr === undefined ? hintText : `${hintSgr}${hintText}${STYLE_OFF}`]
      /** 框下面那几行：空一行 ＋ 提示行 ＋ 输入行。光标停在它的末行（没有输入行时停在它下面一行）。 */
      const tail = [...pad, ...body]
      const region = [...rows, ...tail]
      /** 变窄先保守另起；只有下方完整回报证明的底部硬行才能原位替换。变宽保持硬换行。 */
      const widthChanged = columns !== drawnColumns
      const widthShrank = columns < drawnColumns
      // `steady`：高度也没变过（那一档的上移与擦残影都与从前逐字节相同）。宽度变过要全量重画；
      // 高度变过那一块的大小变了，上移回去也对不上新面板顶——那一档走下面 `grew` / `stale` 两条。
      const finalCursor = lastIsInput ? h + tail.length - 1 : h + tail.length
      const textOnly = o.graphics === undefined || o.graphics === 'none'
      if (columns > (normalRecovery?.columns ?? drawnColumns) || permanent.length > 0 || !rowsKnown || !textOnly ||
        (normalRecovery !== null && (rowsSeen as number) > normalRecovery.rows)) normalRecovery = null
      const normalShrink = !wantAlt && textOnly && drawn && columns <= drawnColumns && permanent.length === 0 && rowsKnown &&
        Number.isSafeInteger(rowsSeen) && typeof drawnRows === 'number' && (rowsSeen as number) < drawnRows && lastIsInput && region.length <= (rowsSeen as number) &&
        normalAnchor !== null && normalAnchor.columns === drawnColumns && normalAnchor.rows === drawnRows &&
        normalAnchor.top < (rowsSeen as number) && normalAnchor.top + regionRows === drawnRows && cursorRow === regionRows - 1
      // Bottom hard lines retain row coordinates when only columns shrink.
      // A complete old frame report and a contained new region permit replacing
      // that exact rectangle; unknown reports keep the original append path.
      const normalWidth = !wantAlt && textOnly && drawn && widthShrank && permanent.length === 0 && rowsKnown && rowsSeen === drawnRows &&
        lastIsInput && normalAnchor !== null && normalAnchor.columns === drawnColumns && normalAnchor.rows === drawnRows &&
        normalAnchor.top + regionRows === (rowsSeen as number) && cursorRow === regionRows - 1 && region.length <= regionRows
      const normalReturn = !wantAlt && drawn && rowsKnown && typeof drawnRows === 'number' &&
        (rowsSeen as number) > drawnRows && normalRecovery !== null && columns <= normalRecovery.columns &&
        (rowsSeen as number) <= normalRecovery.rows && lastIsInput && region.length <= (rowsSeen as number)
      if (normalShrink) normalRecovery = { columns: Math.max(drawnColumns, normalRecovery?.columns ?? 0), rows: Math.max(drawnRows as number, normalRecovery?.rows ?? 0) }
      const normalOwnedPrefix = normalShrink && normalAnchor!.top <= ownedAbove
      const steady = drawn && !widthChanged && h === drawnHeight && !normalShrink && !normalReturn
      // 行级 diff（U8）：与上一帧行数对得上才逐行比——掠过未变行、重写变行，两条路的光标算术相同。
      // **带新永久行的帧不比**：永久行写在面板顶上，那一写把面板整体平移了几行，"屏幕上那行已是
      // 该内容"的前提失效（平移后掠过判断会对错行）——那一帧本来就要写字节，不差面板这几行。
      const diffable = steady && permanent.length === 0 && lastRegion !== null && lastRegion.length === region.length
      const imageFrame = images.update(spec.image, { columns, height: h, cursorRow: finalCursor,
        changed: diffable ? region.map((line, i) => line !== lastRegion![i]) : null })
      const finalColumn = lastIsInput ? (input as PanelInput).caret.col : 0
      // 文字、光标与图片都没变时保持安静；先让图片层核能力/收回，避免跳过图形变化。
      if (!notifyingAlternate && rowsKnown && diffable && rowsSeen === drawnRows && cursorRow === finalCursor && cursorColumn === finalColumn &&
        region.every((line, i) => line === lastRegion![i]) && imageFrame.before === '' && imageFrame.after === '' &&
        (!fullSixel || o.alternateScreenOf?.() === true)) { out.write(''); return }
      buf.push(imageFrame.before)
      // 上一帧比这一帧多出来的那几行（全量那一趟要擦成空行，行数变少不留残影）：输入行变少与高度
      // 变矮都是这一条——两处都是"顶边不动、底下多出来一截"，擦法一样。**宽度变窄那一趟不擦**
      // （旧块整体留给终端重排，新宽度另起一块）；可信底部硬行可在原范围擦尾。没画过则不擦。
      // 新块已填满当前可见区时，下方没有可擦的旧尾；LF 会把新块卷入历史。
      const stale =
        drawn && (!widthShrank || normalWidth) && lastRegion !== null && !normalShrink && !normalReturn && !(rowsKnown && region.length >= (rowsSeen as number))
          ? Math.max(0, lastRegion.length - region.length) : 0
      // **新块摆到哪儿**：full 的自有屏锚在底边；普通屏只向自己写过的空行扩展，余量向下让位。
      // 屏幕增高保留旧顶边；面板变矮也保持顶边，多余尾行交给 stale 清空。
      // 变窄与首帧从光标处另起，原上方空行的坐标也随宿主几何变化作废。
      const screenGrew = rowsKnown && typeof drawnRows === 'number' && (rowsSeen as number) > drawnRows
      if (!drawn || widthShrank || rowsSeen !== drawnRows) ownedAbove = 0
      const growth = Math.max(0, region.length - regionRows)
      const ownGrowth = drawn && !widthShrank && !screenGrew ? Math.min(ownedAbove, growth) : 0
      const back = !drawn || widthShrank ? 0 : wantAlt
        ? !screenGrew && growth > 0 ? cursorRow + growth : cursorRow
        : cursorRow + ownGrowth
      ownedAbove -= ownGrowth
      let recoveredHead = 0
      if (normalReturn) {
        // Every potentially restored line is a former UI row. Clear before any LF
        // can put that old UI back into history; keep the new caret at the bottom.
        buf.push('\x1b[2J\x1b[H')
        recoveredHead = (rowsSeen as number) - region.length
        for (let i = 0; i < recoveredHead; i += 1) buf.push('\r\n')
      } else if (normalShrink) {
        // Preserve an unowned prefix at the verified old top. If the whole
        // visible prefix is our emitted reserve, erase it before LF can
        // move stale wide cells into history (actual NorthWest XTerm).
        buf.push(normalOwnedPrefix ? '\x1b[2J\x1b[H' : `\x1b[${normalAnchor!.top + 1};1H`)
        // Fill spare rows before the new region. The visible prefix is now our
        // emitted blank space; unowned old prefix rows move into real history.
        recoveredHead = (rowsSeen as number) - region.length
        for (let i = 0; i < recoveredHead; i += 1) buf.push('\r\n')
      } else if (normalWidth) {
        buf.push(`\x1b[${normalAnchor!.top + 1};1H`)
      } else if (back > 0) buf.push(upOf(back))
      const historyBudget = rowsKnown ? Math.max(0, (rowsSeen as number) - region.length) : REGION_ROWS
      const permanentRows = ownedResize ? altHistory.slice(Math.max(0, altHistory.length - historyBudget))
        : permanent.flatMap(line => historyRows(line, columns))
      for (const row of permanentRows) buf.push(`\r${CLEAR_LINE}${row}\n`)
      // A first empty changing-height normal panel books blank space once.
      // An initial frame with facts keeps their current placement instead.
      // Its initial allocation may scroll facts into genuine terminal history;
      // subsequent expansion uses only those blank rows. Without ownership,
      // grow downward and let the terminal scroll rather than erase history.
      const reserve = !drawn && !wantAlt && o.heightOf !== undefined && rowsKnown && permanentRows.length === 0
        ? (() => {
            const maximum = o.reserveHeightOf === undefined ? (rowsSeen as number) - 1 : o.reserveHeightOf()
            return Number.isFinite(maximum) ? Math.max(0, Math.floor(Math.min(maximum - h, (rowsSeen as number) - 1 - finalCursor))) : 0
          })() : 0
      for (let i = 0; i < reserve; i += 1) buf.push(`\r${' '.repeat(columns)}\n`)
      if (!drawn) ownedAbove = reserve
      else if (permanentRows.length > 0) ownedAbove = 0
      if (diffable) {
        for (let i = 0; i < region.length; i += 1) {
          const one = region[i] as string
          const last = i === region.length - 1
          if (one === lastRegion![i]) {
            // 掠过：回到行首、下移一行。最后一行输入行不掠到下一行——光标要停回它上面。
            buf.push(last && lastIsInput ? '\r' : '\r\x1b[1B')
          } else {
            buf.push(`\r${CLEAR_LINE}${one}${last && lastIsInput ? '' : '\n'}`)
          }
        }
        // 末尾光标恒回 caret：掠过那条路走完光标还停在最后一行输入行的行首，补那一下退列（重写
        // 那条路在写的时候仍在行尾）。无输入行的帧光标停在区域下一行行首（与全量那一版相同）。
        if (lastIsInput) {
          const one = body[body.length - 1] as string
          const caret = (input as PanelInput).caret.col
          if (one === lastRegion![region.length - 1]) {
            // 掠过末行后在行首，向右到 caret；不能从行首再往左退。
            if (caret > 0) buf.push(`\x1b[${caret}C`)
          } else {
            const back = widthOf(one) - caret
            if (back > 0) buf.push(leftOf(back))
          }
        }
      } else {
        // 框那几行与框下面那两行（空一行 · 提示行）**一行一条物理行**：每行以 `\r` 起头、末尾 `\n`
        // 往下走；输入行那一块写在最后（末行不带换行——光标停在它上面）。
        for (const row of [...rows, ...pad]) buf.push(`\r${CLEAR_LINE}${row}\n`)
        for (let i = 0; i < body.length; i += 1) {
          const one = body[i] as string
          // 最后一行**不带换行**：光标停在它上面（这是这一块区域唯一有光标的地方），退到该在的那一列。
          if (i === body.length - 1) {
            buf.push(`\r${CLEAR_LINE}${one}`)
            const back = widthOf(one) - (input as PanelInput).caret.col
            if (back > 0) buf.push(leftOf(back))
          } else {
            buf.push(`\r${CLEAR_LINE}${one}\n`)
          }
        }
        // 上一帧多出来的那几行（输入行变少了）**擦成空行**——它们就在新区域的下方 · 旧区域的尾巴上，
        // 逐条「下移一行、清行」，末了上移回光标该在的那一行：帧结束的光标位置与没有残行的帧
        // 一模一样（下一帧的上移与收尾的删行都不用知道这一帧擦过几行）。
        if (stale > 0) {
          if (lastIsInput) {
            for (let j = 0; j < stale; j += 1) buf.push(`\n\r${CLEAR_LINE}`)
            buf.push(upOf(stale))
            // 每条残行的 CR 已把光标归到行首；上移后向右回到声明列。
            const caret = (input as PanelInput).caret.col
            if (caret > 0) buf.push(`\x1b[${caret}C`)
          } else {
            // 没有输入行：那一块末行（有提示行时是提示行，没有时是框的末行）的 `\n` 已把光标放到待擦
            // 的第一行上，不用先下移。
            for (let j = 0; j < stale; j += 1) buf.push(`\r${CLEAR_LINE}${j < stale - 1 ? '\n' : ''}`)
            buf.push(upOf(stale - 1))
          }
        }
      }
      buf.push(imageFrame.after)
      const framePaint = ++paint
      normalAnchor = null
      if (buf.length > 0) out.write(buf.join(''))
      cursorRow = finalCursor
      cursorColumn = finalColumn
      regionRows = h + tail.length
      drawn = true
      drawnColumns = columns
      drawnHeight = h
      drawnRows = rowsSeen
      lastRegion = region
      if (normalReturn || normalShrink) ownedAbove = recoveredHead
      if (!wantAlt && textOnly && rowsKnown && lastIsInput && region.length === finalCursor + 1) {
        const frameColumns = columns, frameRows = rowsSeen as number
        o.requestCursor?.(frameRows, (row, column) => {
          // Replies belong to an exact completed frame, never a later geometry.
          if (paint !== framePaint || !drawn || measure() !== frameColumns || measureRows() !== frameRows ||
            !Number.isSafeInteger(row) || !Number.isSafeInteger(column) || row < finalCursor || row >= frameRows || column !== finalColumn) return
          normalAnchor = { columns: frameColumns, rows: frameRows, top: row - finalCursor }
        })
      }
      if (entered && o.onAlternateScreen !== undefined) {
        // 进入通知中的同步重画延续原字节路径；通知结束后才走静止帧省略。
        notifyingAlternate = true
        try { o.onAlternateScreen() } finally { notifyingAlternate = false }
      }
    },
    close(): void {
      paint += 1; normalAnchor = null; normalRecovery = null
      // alt screen 那一笔先记下来、就地归位（**只写一次**）：`finally` 与 `exit` 那一钩都会调到这一
      // 处，崩那一档走的就是后一条——第二次进来时 `alt` 已经是假，一个字节都不再写。
      const leave = alt
      alt = false
      altHistory = []
      ownedAbove = 0
      const removedImage = images.clear()
      const buf: string[] = [leave && fullSixel && o.alternateScreenOf?.() !== true ? '' : removedImage]
      // 旧区域每行都在当时的列宽内，且显式换行：变宽/增高不会拆它，可按原行数收回。
      // 变窄/变矮可能已把一部分旧区域送进 scrollback 或截去，不能多删几行猜位置。
      if (ansi && drawn) {
        const now = measure()
        const nowRows = measureRows()
        const narrower = typeof now === 'number' && now > 0 && now < drawnColumns
        const rowsSafe = nowRows === drawnRows ||
          (typeof nowRows === 'number' && typeof drawnRows === 'number' && nowRows >= drawnRows)
        if (!narrower && rowsSafe) {
          buf.push(upOf(cursorRow))
          if (!leave && typeof nowRows === 'number' && regionRows === nowRows) {
            // XTerm390 普通屏全幅删行实测会把被删的 UI 留进历史；逐行擦自有格，不滚屏。
            for (let i = 0; i < regionRows; i += 1) buf.push(`\r${CLEAR_LINE}${i < regionRows - 1 ? '\x1b[1B' : ''}`)
            buf.push(upOf(regionRows - 1))
          } else buf.push(deleteLinesOf(regionRows))
          drawn = false
          lastRegion = null
        }
      }
      // **出来那一笔在三处出口都会写到**（面板删不删是另一码事）：进去过就必须出来，少写它那台终端
      // 就停在另一块屏上——`T10` 那条断言要抓的正是这一条。
      if (leave) buf.push(ALT_OFF)
      const output = buf.join('')
      if (output !== '') out.write(output)
    },
  }
}
