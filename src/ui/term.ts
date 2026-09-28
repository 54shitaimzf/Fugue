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
//   · 新到的永久行**从面板顶写下去**（一条一行）——面板因此被顶下去 n 行；
//   · 面板那 K 行接着往下写（`\x1b[2K` 逐行清 + 重写）；
//   · 输入行那几行写在面板**下面**（`Panel.input`；逐行清 + 重写，最后一行不带换行）；
//   · 光标停在**最后一行输入行**上——不变量：下一次上移「上一次停的那一行」仍然落在面板顶上。
//
// **输入行是 `T4` 加进来的**（在那之前这一块区域只有 K 行面板）。它那几行**不计进 K**：K 是面板的
// 高度，输入行是它下面另起的一行块。于是"上移多少"从一个常数变成一个记下来的数（`cursorRow`），
// 收走这一块也从"删 K 行"变成"删这一块一共几行"（`regionRows`）。两条都只在有输入行时与从前不同
// ——`term.test.ts` 拿"没有输入行时逐字节不变"钉住这件事。
//
// **输入行不长出去**：调用方给的每一行宽度 ≤ `columns` − 1（`ui/input.ts` 的 `inputFrameOf` 就是按
// "量到的列宽减一"折的），所以一行输入行就是一个物理行，`\x1b[KA` 那条算术不会被终端的自动换行
// 打乱。光标那一下是在写完那一行之后**往左退**到光标列（显示宽度算，不是 code unit）。
//
// **永久行只写一次。** 它们在面板上方，重画时只有面板那 K 行被擦改：终端历史里那一串是干净的
// 流水（翻得回去 · 搜索 · 连 `| tee` 出去都没有转义序列）。
//
// **宽度变过（resize）就不猜重排。** 终端会把已经印出去的那 K 行按新宽度重排，而重排之后那几行
// 占几个物理行是**这一层量不到的**（各家终端的 reflow 行为不一样）。所以宽度一变就不"上移 K 行"：
// 上一块按终端自己的重排留在历史里，新宽度从下面另起一块。宁可多留一块旧的，也不去吃历史——
// 吃历史那一条错法是不可逆的。
//
// **地板：不是 TTY / `$TERM` 认不出来 → 一个字节的 ANSI 都不写。** 那一档 `draw` 只把永久行按
// 到达序印出去，面板整块不画（重定向出去就是一份干净的事件流水，CI 里不会有半块面板）。
// `$TERM` 认不认得出来由 `ansiOf` 那张表说了算：认不出来就退。**这是手写 ANSI 相对 `terminfo`
// 丢掉的那一样东西，价码写在这里**——什么条件下改主意：要认的终端多了，往 `KNOWN_TERM` 里加一行；
// 反过来，哪一台终端上这几条 escape 画错了，就从那张表里划掉（退一档比画错好）。
//
// **退出**：`close()` 把面板那 K 行删掉（`\x1b[KM`），终端历史里只剩永久行；没画过、或宽度变过
// （重排之后不知道那 K 行落在哪）就一个字节都不写。
import type { BottomInput, MenuInput } from './frame.ts'
import { panelOf, widthOf } from './frame.ts'

/** 底部那块区域的**恒定**行数（PLAN § 5.19：K 取 12；画出框的下限是 5，12 够放处境那几行）。 */
export const K = 12

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

/** 这一份只用到输出那一头的三个栏（`process.stdout` 就是它）。 */
export interface TermOut {
  write(s: string): unknown
  /** `process.stdout.isTTY`：不是 TTY 就不写一个字节的 ANSI。 */
  readonly isTTY?: boolean | undefined
  /** 终端此刻几列（量不到是 `undefined`）。 */
  readonly columns?: number | undefined
}

/** 输入行那几行：已经带提示符，每行宽度 ≤ `columns` − 1（所以一行就是一个物理行）。 */
export interface PanelInput {
  readonly rows: readonly string[]
  /** 光标在第 `row` 行第 `col` 列（显示列，0 基）。**最后一行就是光标停的那一行。** */
  readonly caret: { readonly row: number; readonly col: number }
}

/** 面板那一块：`rows` 是那个框（补到正好 `height` 行），`input` 是它下面那几行输入行（不给就没有）。 */
export interface Panel {
  readonly rows: readonly string[]
  readonly input?: PanelInput | undefined
}

/** 界面自己那几样（`T4`）：候选那一层与输入行。**纯视图状态**（授权 · 排队 · 处境一律落在账上）。 */
export interface ViewInput {
  readonly menu?: MenuInput | undefined
  /**
   * 面板最下面那一栏（`T6` 的门口那一块 · `T7` 的排队行）：**它是面板那一栏的最下面**，不是输入行
   * 那一栏（输入行还在它下面）。
   */
  readonly bottom?: BottomInput | undefined
  readonly input?: PanelInput | undefined
}

/** 面板那一块：给一个尺寸，还回那几行（**渲染在调用方**，这一份只量尺寸）。阵列是"没有输入行"那一档。 */
export type RenderPanel = (size: {
  readonly columns: number
  readonly height: number
}) => readonly string[] | Panel

export interface TermOptions {
  readonly out: TermOut
  /** 这一台终端叫什么（`process.env.TERM`）。缺省读环境。 */
  readonly term?: string | undefined
  /** 区域高度 K。缺省 `K`。 */
  readonly height?: number
  /** 量列宽那一处（缺省读 `out.columns`）：真终端上就是它，resize 那一档要一个会变的数。 */
  readonly columnsOf?: () => number | undefined
}

export interface Term {
  /** 走不走 ANSI：不是 TTY，或 `$TERM` 认不出来时是 `false`（那一档只印永久行）。 */
  readonly ansi: boolean
  /** 区域高度（恒定 K 行）。 */
  readonly height: number
  /** 上一次量到的列宽（量不到就是兜的那个 80）。 */
  readonly columns: number
  /** 摆一块：让开旧的那一块 → 写永久行 → 把面板补到 K 行写在它下面 → 有输入行就写在再下面。 */
  draw(permanent: readonly string[], render: RenderPanel): void
  /** 收走底部那一块（终端历史里只剩永久行）。 */
  close(): void
}

/**
 * 开一块。**一个句柄都不持有**：不管 stdin、不注册信号、不碰日志——信号与跟随是调用方的事
 * （`cli/fugue.ts` 的 `tui`），这一份只管那一块地方。
 */
export function openTerm(o: TermOptions): Term {
  const out = o.out
  const height = o.height ?? K
  const measure = o.columnsOf ?? ((): number | undefined => out.columns)
  const ansi = out.isTTY === true && ansiOf(o.term ?? process.env.TERM)
  let columns = FALLBACK_COLUMNS
  let drawn = false
  let drawnColumns = 0
  /** 上一次画完时光标停在区域第几行（0 = 面板顶）——下一次"上移多少"靠它。 */
  let cursorRow = height
  /** 上一次画出去的区域一共几行（面板 K + 输入那几行）——`close()` 收走这一块靠它。 */
  let regionRows = height
  return {
    ansi,
    height,
    get columns(): number {
      return columns
    },
    draw(permanent: readonly string[], render: RenderPanel): void {
      const seen = measure()
      columns = typeof seen === 'number' && seen > 0 ? seen : FALLBACK_COLUMNS
      if (!ansi) {
        // 只印永久行那一档：面板整块不画，一个字节的 ANSI 都不写。
        for (const line of permanent) out.write(`${line}\n`)
        return
      }
      // 面板先算好：**尺寸是刚刚量到的那一个**（渲染与摆是同一把尺，所以 1 逻辑行 = 1 物理行）。
      const asked = render({ columns, height })
      const spec: Panel = Array.isArray(asked) ? { rows: asked } : asked
      const rows = panelOf(spec.rows, height, columns)
      // 上移只在"上一次画过、而且宽度没变过"时做——宽度变过就不猜重排。
      if (drawn && columns === drawnColumns) out.write(upOf(cursorRow))
      for (const line of permanent) out.write(`${CLEAR_LINE}${line}\n`)
      for (const row of rows) out.write(`${CLEAR_LINE}${row}\n`)
      const input = spec.input
      const body = input === undefined ? [] : input.rows
      for (let i = 0; i < body.length; i += 1) {
        const one = body[i] as string
        // 最后一行**不带换行**：光标停在它上面（这是这一块区域唯一有光标的地方），退到该在的那一列。
        if (i === body.length - 1) {
          out.write(`\r${CLEAR_LINE}${one}`)
          const back = widthOf(one) - (input as PanelInput).caret.col
          if (back > 0) out.write(leftOf(back))
        } else {
          out.write(`\r${CLEAR_LINE}${one}\n`)
        }
      }
      cursorRow = body.length === 0 ? height : height + body.length - 1
      regionRows = height + body.length
      drawn = true
      drawnColumns = columns
    },
    close(): void {
      if (!ansi || !drawn) return
      // **现量一次**：宽度变过之后终端会把面板那几行重排，重排之后它占几个物理行这一层量不到，
      // 所以那一档不去删它（宁可留一块旧的，也不去吃历史）。量不到列宽时按"没变"办——上移 K 行
      // 落回面板顶这条不变量在没重排时是成立的。
      const now = measure()
      if (typeof now === 'number' && now > 0 && now !== drawnColumns) return
      out.write(upOf(cursorRow))
      out.write(deleteLinesOf(regionRows))
      drawn = false
    },
  }
}
