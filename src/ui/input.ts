// TUI 的第二版第一格：**输入行**——单行编辑 · 历史 · 反查 · 大段粘贴折叠 · 撤销栈。
//
// 出处：PLAN § 5.19 第二版「二 · 按键」那张表（`Enter` 提交 · `Ctrl-J` 换行 · `Alt-R` 反查 ·
// `Ctrl-U`/`Ctrl-W`/`Ctrl-A`/`Ctrl-E` · `Ctrl-Z`/`Ctrl-Y` · `Ctrl-O` 展开折叠）·「三 · 状态」那张表
// （焦点 `Input` 那一档 · 输入模式 `Command`/`Say`——这一份把它做成**推出来的**，见 `modeOf`）·
// 「六 · 提交的四种去向」（这一份只到"交出去的是什么"，往哪儿去由 `ui/run.ts` 接线）。
//
// **这一份是纯的**：`Editor → Intent → Editor`，一个字节的 IO 都不做，也不认识终端。于是"按下去
// 之后这一行变成什么样"是这一格能单独证伪的事；"那一趟命令起没起、账上多了什么"是 `ui/run.ts`
// 与它那几条真子进程的事（与 `ui/keymap.ts` 同一处分工）。
//
// 四条不许破的性质：
//
//   · **原文一个字节不丢**：折叠 · 换行记号 · 控制字符的写法都只改**显示**——`draft.text` 永远是
//     原样那一份，`submitOf` 交出去的就是它（`input.test.ts` ③ 拿折叠过的粘贴逐字节对账）；
//   · **光标永远落在簇边界上**：左右按**簇**走（`frame.ts` 的 `clustersOf`），列宽也按簇算
//     （`widthOf`）——汉字 · 组合符号 · emoji 不会被切成半个，也不会按 code unit 数错一格；
//   · **零个隐藏状态**：`Editor` 就是它自己那一份值（撤到哪一步 · 在第几条历史上 · 反查查的什么
//     都写在里面），闭包里没有"上一帧"；进来那一份一个字段都不改；
//   · **显示里没有一个裸控制字符**：原文里的 `\x1b` 印成 `^[`（不然粘一段带转义的东西进来，
//     屏幕上就能被它摆布）——这条与"原文不丢"是同一条的两面。
//
// **这一份不是"前端状态"**：它手里只有"人正在打的那一行"。处境（`Idle`/`Running`/`Gate`）·
// 排队 · 授权都在账上，这一份连它们的名字都不认识（PLAN § 5.19 三那张表的三轴里，只有焦点与
// 输入模式落在这一份，而输入模式还是推出来的）。
import type { UiAction } from './keymap.ts'
import { clustersOf, cutAt, widthOf } from './frame.ts'

/** 折叠阈值：粘进来的东西超过其中任意一条就折起来（显示成一块牌子，`Ctrl-O` 展开）。 */
export const FOLD_LINES = 4
export const FOLD_COLS = 240

/** 撤销栈有几层（再多也不给人退到半小时前）。 */
export const UNDO_DEPTH = 64

/** kill 环有几格（`Ctrl-Y` 只粘最近那一格）。 */
export const KILL_DEPTH = 8

/** 输入行最多长到几行（第 1 行是主体，其余是续行）；再多就按光标滚。 */
export const INPUT_ROWS = 3

/** 换行在显示里的记号（一列）。原文里那个字节照旧是 `\n`。 */
export const NEWLINE_MARK = '↵'

/** 制表符在显示里占几列（真 tab stop 是每八列一格；输入行里按光标起算更乱，先按四列）。 */
export const TAB_COLS = 4

/** 一段折起来的粘贴：`[start, end)` 是它在 `text` 上的位置。 */
export interface Fold {
  readonly start: number
  readonly end: number
  readonly lines: number
  readonly chars: number
}

/** 撤销栈里的一步。**只有这三样**（历史 · 反查 · kill 环不进栈）。 */
export interface Snapshot {
  readonly text: string
  readonly caret: number
  readonly folded: readonly Fold[]
}

/** 人正在打的那一行。 */
export interface Draft {
  /** 真身：一个字节不改的那一份。折叠 · 记号都只是显示。 */
  readonly text: string
  /** 光标：`text` 上的 code unit 偏移，永远落在簇边界上（或 0 / `text.length`）。 */
  readonly caret: number
  readonly folded: readonly Fold[]
  /** kill 环（最近的在后）：`Ctrl-Y` 粘回最近那一格。 */
  readonly killed: readonly string[]
  readonly undo: readonly Snapshot[]
  readonly redo: readonly Snapshot[]
}

export const EMPTY_DRAFT: Draft = { text: '', caret: 0, folded: [], killed: [], undo: [], redo: [] }

/** 反查那一档：查的是什么 · 命中的是历史里第几位。 */
export interface Search {
  readonly q: string
  readonly at: number
}

/** 输入行那一份状态：这一行 + 历史 + 反查 + 一条视图开关。 */
export interface Editor {
  readonly draft: Draft
  /** 提交过的那些行（最新的在后）。**只在内存里**（进程一退就没了）。 */
  readonly history: readonly string[]
  /** 正在看历史里第几条（`null` = 手里是新写的一行）。 */
  readonly at: number | null
  /** 翻历史之前手里那一行（翻回来时原样还回去）。 */
  readonly stash: string | null
  readonly search: Search | null
  /** 被折叠的粘贴展开显示没有（`Ctrl-O` 切）——纯视图状态，不进账。 */
  readonly unfolded: boolean
}

export function emptyEditor(): Editor {
  return { draft: EMPTY_DRAFT, history: [], at: null, stash: null, search: null, unfolded: false }
}

/**
 * 输入行认的那些动作。**一个动作一个意思**（哪个字节算哪个动作是 `ui/keymap.ts` 那张表的事，
 * 这一份不认字节）。
 */
export type Intent =
  | { readonly t: 'insert'; readonly text: string }
  | { readonly t: 'backspace' }
  | { readonly t: 'delete' }
  | { readonly t: 'left' }
  | { readonly t: 'right' }
  | { readonly t: 'wordLeft' }
  | { readonly t: 'wordRight' }
  | { readonly t: 'home' }
  | { readonly t: 'end' }
  | { readonly t: 'killToStart' }
  | { readonly t: 'killToEnd' }
  | { readonly t: 'killWord' }
  | { readonly t: 'yank' }
  | { readonly t: 'undo' }
  | { readonly t: 'redo' }
  | { readonly t: 'historyOlder' }
  | { readonly t: 'historyNewer' }
  | { readonly t: 'search' }
  | { readonly t: 'toggleFold' }
  | { readonly t: 'cancel' }
  // **整行换成另一串字**（菜单选中 · `Tab` 补全那两处）：它是"人改了这一行"，所以进撤销栈。
  | { readonly t: 'setLine'; readonly text: string }

/** 折叠块在显示里的样子。 */
export function chipOf(f: Fold): string {
  return `[粘贴 ${f.lines} 行 · ${f.chars} 字]`
}

/**
 * 一个簇在屏幕上怎么写：换行是 `↵` · 制表符按四列 · 别的控制字符写成 `^X`（`DEL` 是 `^?`）。
 * **只改显示**：原文一个字节不动，折叠起来的牌子交出去的还是原文。
 */
function shownOf(text: string): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    if (ch === '\n') out += NEWLINE_MARK
    else if (ch === '\t') out += ' '.repeat(TAB_COLS)
    else if (c < 0x20) out += `^${String.fromCharCode(c + 0x40)}`
    else if (c === 0x7f) out += '^?'
    else out += ch
  }
  return out
}

const snapOf = (d: Draft): Snapshot => ({ text: d.text, caret: d.caret, folded: d.folded })

const withDraft = (e: Editor, draft: Draft): Editor => ({ ...e, draft })

/**
 * 改一次文字：**先记一步撤销**（`undo` 有界，最老的丢掉），清掉重做那一摞。
 * 只挪光标不算改（那几次走 `caretTo`，不经过这里）。
 */
function edited(d: Draft, next: {
  readonly text: string
  readonly caret: number
  readonly folded?: readonly Fold[]
}): Draft {
  return {
    text: next.text,
    caret: next.caret,
    folded: next.folded ?? d.folded,
    killed: d.killed,
    undo: [...d.undo, snapOf(d)].slice(-UNDO_DEPTH),
    redo: [],
  }
}

/**
 * 折叠段跟着一次编辑挪位置：整个在编辑点前头的照挪（`added - removed`），整个在后面的不动；
 * **被编辑碰到的那一段丢掉**——它已经不是"原样粘进来的那一份"了，再折起来就是骗人。
 */
function shiftFolds(folded: readonly Fold[], at: number, removed: number, added: number): readonly Fold[] {
  const out: Fold[] = []
  for (const f of folded) {
    if (f.end <= at) out.push(f)
    else if (f.start >= at + removed) {
      out.push({ ...f, start: f.start + added - removed, end: f.end + added - removed })
    }
  }
  return out
}

/** 折叠段按位置排好、去掉重叠（同一处插进一块粘贴时，新的那块在前头留住）。 */
function tidy(folded: readonly Fold[]): readonly Fold[] {
  const sorted = [...folded].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Fold[] = []
  for (const f of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && f.start < last.end) continue
    out.push(f)
  }
  return out
}

/** 粘进来的东西要不要折起来（行数 · 最宽那一行，两条里超一条就折）。 */
function foldFor(text: string, start: number, end: number): readonly Fold[] {
  const lines = text.split('\n')
  let widest = 0
  for (const one of lines) widest = Math.max(widest, widthOf(one))
  if (lines.length <= FOLD_LINES && widest <= FOLD_COLS) return []
  return [{ start, end, lines: lines.length, chars: [...text].length }]
}

/** `i` 之后下一个簇边界（到头就是 `text.length`）。 */
function nextStop(s: string, i: number): number {
  for (const c of clustersOf(s)) if (c.start > i) return c.start
  return s.length
}

/** `i` 之前上一个簇边界（到头就是 0）。 */
function prevStop(s: string, i: number): number {
  let at = 0
  for (const c of clustersOf(s)) {
    if (c.end >= i) break
    at = c.end
  }
  return at
}

/** 往右一步：站在折叠块的左边就跨过整块（块里的原文不让人一个字节一个字节地看）。 */
function stepRight(d: Draft): number {
  const f = d.folded.find((x) => x.start === d.caret)
  return f !== undefined ? f.end : nextStop(d.text, d.caret)
}

/** 往左一步：站在折叠块的右边就整块退回来。 */
function stepLeft(d: Draft): number {
  const f = d.folded.find((x) => x.end === d.caret)
  return f !== undefined ? f.start : prevStop(d.text, d.caret)
}

/** 位置落进折叠块里就贴到它靠边的那一头（块里不许站人）。 */
function snapOut(d: Draft, at: number, dir: -1 | 1): number {
  for (const f of d.folded) {
    if (at > f.start && at < f.end) return dir > 0 ? f.end : f.start
  }
  return at
}

/**
 * 算一个词的那些字：空白与标点之外都算。**汉字连成一串算一个词**（没有空格可依），
 * 这一档只用来"整词删 · 整词跳"，不是分词。
 */
function isWordChar(ch: string): boolean {
  return !/\s/.test(ch) && !'.,;:!?/\\|<>()[]{}"\'`~@#$%^&*+=_-—…·、。，；：！？（）【】《》“”‘’'.includes(ch)
}

function wordLeft(s: string, i: number): number {
  let at = i
  while (at > 0) {
    const p = prevStop(s, at)
    if (isWordChar(s.slice(p, at))) break
    at = p
  }
  while (at > 0) {
    const p = prevStop(s, at)
    if (!isWordChar(s.slice(p, at))) break
    at = p
  }
  return at
}

function wordRight(s: string, i: number): number {
  let at = i
  while (at < s.length) {
    const n = nextStop(s, at)
    if (isWordChar(s.slice(at, n))) break
    at = n
  }
  while (at < s.length) {
    const n = nextStop(s, at)
    if (!isWordChar(s.slice(at, n))) break
    at = n
  }
  return at
}

/** 插一段进来（粘贴也走这一条：折与不折在这一处定）。 */
function insertInto(d: Draft, ins: string): Draft {
  if (ins === '') return d
  const at = d.caret
  const text = d.text.slice(0, at) + ins + d.text.slice(at)
  const folded = tidy([...shiftFolds(d.folded, at, 0, ins.length), ...foldFor(ins, at, at + ins.length)])
  return edited(d, { text, caret: at + ins.length, folded })
}

/** 退格：站在折叠块右边就整块删掉。 */
function backspaceOf(d: Draft): Draft {
  const f = d.folded.find((x) => x.end === d.caret)
  if (f !== undefined) {
    return edited(d, {
      text: d.text.slice(0, f.start) + d.text.slice(f.end),
      caret: f.start,
      folded: d.folded.filter((x) => x !== f),
    })
  }
  const at = prevStop(d.text, d.caret)
  if (at === d.caret) return d
  return edited(d, {
    text: d.text.slice(0, at) + d.text.slice(d.caret),
    caret: at,
    folded: tidy(shiftFolds(d.folded, at, d.caret - at, 0)),
  })
}

/** 向前删一格：站在折叠块左边就整块删掉。 */
function deleteOf(d: Draft): Draft {
  const f = d.folded.find((x) => x.start === d.caret)
  if (f !== undefined) {
    return edited(d, {
      text: d.text.slice(0, f.start) + d.text.slice(f.end),
      caret: f.start,
      folded: d.folded.filter((x) => x !== f),
    })
  }
  const at = nextStop(d.text, d.caret)
  if (at === d.caret) return d
  return edited(d, {
    text: d.text.slice(0, d.caret) + d.text.slice(at),
    caret: d.caret,
    folded: tidy(shiftFolds(d.folded, d.caret, at - d.caret, 0)),
  })
}

/** 清掉 `[from, to)`：那一段进 kill 环（`Ctrl-Y` 粘得回来）。 */
function killRange(d: Draft, from: number, to: number): Draft {
  if (from >= to) return d
  const cut = d.text.slice(from, to)
  const next = edited(d, {
    text: d.text.slice(0, from) + d.text.slice(to),
    caret: from,
    folded: tidy(shiftFolds(d.folded, from, to - from, 0)),
  })
  return { ...next, killed: [...d.killed, cut].slice(-KILL_DEPTH) }
}

/**
 * `Ctrl-U`：光标不在行首就清到行首，**在行首就清整行**（表里那一格写的是"清行"）。
 */
function killToStart(d: Draft): Draft {
  return d.caret === 0 ? killRange(d, 0, d.text.length) : killRange(d, 0, d.caret)
}

function undoOf(d: Draft): Draft {
  const prev = d.undo[d.undo.length - 1]
  if (prev === undefined) return d
  return {
    text: prev.text,
    caret: prev.caret,
    folded: prev.folded,
    killed: d.killed,
    undo: d.undo.slice(0, -1),
    redo: [...d.redo, snapOf(d)].slice(-UNDO_DEPTH),
  }
}

function redoOf(d: Draft): Draft {
  const next = d.redo[d.redo.length - 1]
  if (next === undefined) return d
  return {
    text: next.text,
    caret: next.caret,
    folded: next.folded,
    killed: d.killed,
    undo: [...d.undo, snapOf(d)].slice(-UNDO_DEPTH),
    redo: d.redo.slice(0, -1),
  }
}

/** 只挪光标（不进撤销栈：走一步不算改过东西）。 */
function caretTo(d: Draft, at: number): Draft {
  const clamped = Math.max(0, Math.min(d.text.length, at))
  return clamped === d.caret ? d : { ...d, caret: clamped }
}

/** 装上历史里那一条（或翻回手里那一行）：**替换整行，但不进撤销栈**（历史不是改写）。 */
function loadLine(e: Editor, text: string, keep: { readonly at: number | null; readonly stash: string | null }): Editor {
  return { ...e, ...keep, draft: { ...EMPTY_DRAFT, text, caret: text.length } }
}

function historyStep(e: Editor, dir: -1 | 1): Editor {
  if (e.history.length === 0) return e
  if (dir > 0 && e.at === null) return e
  const at = e.at === null ? e.history.length - 1 : e.at + dir
  if (at < 0) return e
  if (at >= e.history.length) return loadLine(e, e.stash ?? '', { at: null, stash: null })
  return loadLine(e, e.history[at] as string, { at, stash: e.stash ?? e.draft.text })
}

/**
 * `Alt-R` 反查：**拿输入行里已经打的那几个字当查询词**，翻出最近一条含它的历史；再按一下找更早
 * 的一条（第一次按之后查询词就定住了，不然第二次会拿刚翻出来的那一条去找）。
 */
function searchStep(e: Editor): Editor {
  if (e.history.length === 0) return e
  const q = e.search === null ? e.draft.text : e.search.q
  const from = e.search === null ? e.history.length - 1 : e.search.at - 1
  for (let i = from; i >= 0; i -= 1) {
    const line = e.history[i] as string
    if (q === '' || line.includes(q)) {
      return { ...loadLine(e, line, { at: null, stash: e.stash ?? e.draft.text }), search: { q, at: i } }
    }
  }
  return e
}

/**
 * 交出去的那一份：**原文**（折叠 · 记号 · 控制字符的写法都只是显示，一个字节都不改）。
 * 交出去之后往哪儿去（`say` 还是某一条命令）由 `ui/run.ts` 按 `modeOf` 决定。
 */
export function submitOf(e: Editor): string {
  return e.draft.text
}

/**
 * 这一行是**命令**还是**话**（PLAN § 5.19 三那张表的输入模式那一轴）。**推出来的，不是存下来的**：
 * 行首是 `/` 就是命令（那个斜杠是记号，交出去之前由 `ui/run.ts` 摘掉），否则是话（落进 `say`）。
 * 于是"现在是什么模式"永远不会跟"行里有什么"打架——这正是"前端不留第二份状态"那一档。
 */
export function modeOf(d: Draft): 'Command' | 'Say' {
  return d.text.startsWith('/') ? 'Command' : 'Say'
}

/**
 * 交出去之后收下这一行：历史里存一份（空行与跟上一条相同的不存——连按两次翻出来两遍一样的，
 * 那不是历史），手里换成新的一行。
 * **历史只在内存里**：落盘是另一格的事，多一份文件就多一份要管的真相。
 */
export function rememberSubmit(e: Editor, line: string): Editor {
  const last = e.history[e.history.length - 1]
  const history = line === '' || line === last ? e.history : [...e.history, line]
  return { draft: EMPTY_DRAFT, history, at: null, stash: null, search: null, unfolded: e.unfolded }
}

/** 显示里的一截：`[at, to)` 是它在 `text` 上的位置，`text` 是它在屏幕上写出来的样子。 */
interface Piece {
  readonly at: number
  readonly to: number
  readonly text: string
}

/** `Esc` 在输入行这一层接下来该做的那一件事（`null` = 这一层没事可做，让上头的链接着走）。 */
export function cancelTargetOf(e: Editor): 'search' | 'input' | null {
  if (e.search !== null) return 'search'
  return e.draft.text === '' ? null : 'input'
}

/**
 * `Esc` 在输入行这一层：**在反查就先退反查**（行里还是找到的那一条），否则**清空这一行**。
 * 清掉的那一份在撤销栈上（表里 `Ctrl-Z` 那一格说的"恢复刚清掉的草稿"就是它），也在 kill 环里。
 */
export function cancelAt(e: Editor): Editor {
  const what = cancelTargetOf(e)
  if (what === 'search') return { ...e, search: null }
  if (what === 'input') return withDraft(e, killRange(e.draft, 0, e.draft.text.length))
  return e
}

/** 一行 `text` 摊成显示里的那几截：一个簇一截，折叠块换成一块牌子。 */
function piecesOf(d: Draft, unfolded: boolean): readonly Piece[] {
  const out: Piece[] = []
  const folds = unfolded ? [] : d.folded
  let at = 0
  const pushRaw = (from: number, to: number): void => {
    for (const c of clustersOf(d.text.slice(from, to))) {
      out.push({ at: from + c.start, to: from + c.end, text: shownOf(c.text) })
    }
  }
  for (const f of folds) {
    if (f.start > at) pushRaw(at, f.start)
    out.push({ at: f.start, to: f.end, text: chipOf(f) })
    at = f.end
  }
  if (at < d.text.length) pushRaw(at, d.text.length)
  return out
}

/** 屏幕上那一行（**没有裸控制字符 · 没有真换行**——这块地方只有一行）。 */
export function displayOf(d: Draft, o?: { readonly unfolded?: boolean }): string {
  return piecesOf(d, o?.unfolded ?? false)
    .map((p) => p.text)
    .join('')
}

/** 光标在显示里占第几列（按显示列算，不是 code unit）。 */
export function caretColOf(d: Draft, o?: { readonly unfolded?: boolean }): number {
  let col = 0
  for (const p of piecesOf(d, o?.unfolded ?? false)) {
    if (d.caret < p.to) break
    col += widthOf(p.text)
  }
  return col
}

/** 按列宽硬切（**不 trim**：输入行里的空格是人打的，一个都不许吃掉）。整簇切。 */
function cutRows(s: string, w: number): readonly string[] {
  if (s === '') return ['']
  const out: string[] = []
  let rest = s
  while (rest !== '') {
    const cut = cutAt(rest, w)
    if (cut <= 0) {
      out.push(rest)
      break
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  return out
}

/** 输入行画出来的那几行 + 光标在哪儿 + 上下各藏了几行。 */
export interface InputFrame {
  readonly rows: readonly string[]
  /** 光标在几行几列（`col` 是显示列，**一律落在 `[0, width)` 里**：正好在行尾就归下一行）。 */
  readonly caret: { readonly row: number; readonly col: number }
  readonly hidden: { readonly above: number; readonly below: number }
}

/**
 * 量出一块输入行：提示符占前几列，剩下的按列宽折；超过 `rows` 行就**按光标滚**，滚上去的时候
 * 提示符那一格换成 `…`（说出"上面还有"）。
 *
 * 光标那一列**不许等于这一行宽**（终端上那个位置放不下光标）：只有**那一行真占满了**、光标又正好
 * 落在行尾时才归下一行，下一行还不存在就补一个空行；没占满的行上光标就停在内容末尾那一格。
 */
export function inputFrameOf(o: {
  readonly e: Editor
  readonly prompt: string
  readonly width: number
  readonly rows?: number
}): InputFrame {
  const maxRows = Math.max(1, o.rows ?? INPUT_ROWS)
  const width = Math.max(1, o.width)
  const prompt = widthOf(o.prompt) < width ? o.prompt : ''
  const lead = widthOf(prompt)
  const avail = Math.max(1, width - lead)
  const display = displayOf(o.e.draft, { unfolded: o.e.unfolded })
  const all = [...cutRows(display, avail)]
  const caretAt = caretColOf(o.e.draft, { unfolded: o.e.unfolded })
  let row = 0
  let before = 0
  // 往下走一格的条件是**这一行真的占满了**（`avail` 列）：没占满的那一行上，光标落在内容末尾
  // 仍然放得下（列 = 提示符 + 内容宽 < width），不该被推到下一行去。
  while (row < all.length) {
    const w = widthOf(all[row] as string)
    if (w === 0 || caretAt < before + avail) break
    before += w
    row += 1
  }
  if (row >= all.length) all.push('')
  const start = Math.max(0, Math.min(row < maxRows ? 0 : row - maxRows + 1, Math.max(0, all.length - maxRows)))
  const shown = all.slice(start, start + maxRows)
  const head = start === 0 ? prompt : `…${' '.repeat(Math.max(0, lead - 1))}`
  return {
    rows: shown.map((one, i) => `${i === 0 ? head : ' '.repeat(lead)}${one}`),
    caret: { row: row - start, col: lead + (caretAt - before) },
    hidden: { above: start, below: Math.max(0, all.length - start - shown.length) },
  }
}

/** 一个动作进去，新的一份状态出来（**进来那一份一个字段都不改**）。 */
export function applyIntent(e: Editor, it: Intent): Editor {
  const d = e.draft
  switch (it.t) {
    case 'insert':
      return withDraft(e, insertInto(d, it.text))
    case 'backspace':
      return withDraft(e, backspaceOf(d))
    case 'delete':
      return withDraft(e, deleteOf(d))
    case 'left':
      return withDraft(e, caretTo(d, stepLeft(d)))
    case 'right':
      return withDraft(e, caretTo(d, stepRight(d)))
    case 'wordLeft':
      return withDraft(e, caretTo(d, snapOut(d, wordLeft(d.text, d.caret), -1)))
    case 'wordRight':
      return withDraft(e, caretTo(d, snapOut(d, wordRight(d.text, d.caret), 1)))
    case 'home':
      return withDraft(e, caretTo(d, 0))
    case 'end':
      return withDraft(e, caretTo(d, d.text.length))
    case 'killToStart':
      return withDraft(e, killToStart(d))
    case 'killToEnd':
      return withDraft(e, killRange(d, d.caret, d.text.length))
    case 'killWord':
      return withDraft(e, killRange(d, wordLeft(d.text, d.caret), d.caret))
    case 'yank':
      return withDraft(e, insertInto(d, d.killed[d.killed.length - 1] ?? ''))
    case 'undo':
      return withDraft(e, undoOf(d))
    case 'redo':
      return withDraft(e, redoOf(d))
    case 'historyOlder':
      return historyStep(e, -1)
    case 'historyNewer':
      return historyStep(e, 1)
    case 'search':
      return searchStep(e)
    case 'toggleFold':
      return { ...e, unfolded: !e.unfolded }
    case 'cancel':
      return cancelAt(e)
    case 'setLine':
      // 补全与菜单选中都是**换掉这一整行**（不是插一段）：光标跟着到行尾，折叠块清掉（换来的那一行
      // 是命令名或路径，没有"原样粘进来的那一段"）。
      return withDraft(e, edited(d, { text: it.text, caret: it.text.length, folded: [] }))
    default:
      return e
  }
}

/**
 * 表里那个动作 id → 这一份认的编辑动作（`ui/keymap.ts` 的 `UiAction`）。**只翻编辑那几样**：
 * `submit` · `cancel` · 退出 · 菜单 · 补全 · 导航要看的不止这一行字，由调用方接（`null`）。
 *
 * `newline` 在这里翻成"插一个换行"——`Ctrl-J`/`Alt-Enter` 与 `Enter` 的分别就在这一格（表里那一行
 * 说的就是"换行，不提交"）。
 */
export function intentOf(a: UiAction, text = ''): Intent | null {
  switch (a) {
    case 'insert':
      return { t: 'insert', text }
    case 'newline':
      return { t: 'insert', text: '\n' }
    case 'backspace':
      return { t: 'backspace' }
    case 'delete':
      return { t: 'delete' }
    case 'left':
      return { t: 'left' }
    case 'right':
      return { t: 'right' }
    case 'wordLeft':
      return { t: 'wordLeft' }
    case 'wordRight':
      return { t: 'wordRight' }
    case 'home':
      return { t: 'home' }
    case 'end':
      return { t: 'end' }
    case 'killToStart':
      return { t: 'killToStart' }
    case 'killToEnd':
      return { t: 'killToEnd' }
    case 'killWord':
      return { t: 'killWord' }
    case 'yank':
      return { t: 'yank' }
    case 'undo':
      return { t: 'undo' }
    case 'redo':
      return { t: 'redo' }
    case 'historyOlder':
      return { t: 'historyOlder' }
    case 'historyNewer':
      return { t: 'historyNewer' }
    case 'search':
      return { t: 'search' }
    case 'toggleFold':
      return { t: 'toggleFold' }
    case 'cancel':
      return { t: 'cancel' }
    default:
      return null
  }
}
