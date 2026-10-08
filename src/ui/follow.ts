// TUI 的第四格：**跟随接上**。出处：PLAN § 5.19 第五段（`UI3` 那一行）· 架构 § 9.6 那张观察表
// （`watch --follow` 那一行）· § 9.8（可附着 TUI：人的每个状态动作都是一条命令 · 界面不写日志）·
// PLAN § 5.18 的三面表（事件面是唯一读源）。
//
// 这一份把**读**与**摆**接起来（`probe/watch.ts` 的 `follow()` → `ui/term.ts` 的 `draw`），中间只夹
// 一样东西：**累起来的那些行**。于是跟随与一次性读在渲染那一头是同一段代码——面板那 K 行是"这些
// 行"的一个纯函数（`ui/frame.ts`），跟随只决定"这些行此刻有哪些"。
//
// 三条不许破的性质（`follow.test.ts` 逐条量）：
//
//   · **不许有第二种答案**：同一批事件，跟随读到的那一帧与"一次性读齐再折"的那一帧逐字节相同。
//     这一条有一处边界，写在 `watch.ts` 头上：新事件都长在尾部时两条路的**次序**也相同；而晚出现的
//     那个 writer 第一条就是 `seq = 1`，到达序与全序在那里本来就不同——那一档量的是"一条都不少"；
//   · **永久行只写一次**：每一条按到达序写出去一次，不重印、不跳过。已经印出去的那几条若被回头改
//     （换了分法那一张表），`newLinesOf` 当场抛——不许静默把终端历史重新编号；
//   · **地板**：不是 TTY · `$TERM` 认不出来 · `--once` → 只印永久行那一档（`tuiModeOf` 那张表），
//     面板一次都不画，`redraw()` 一个字节都不写。
//
// **永久行的次序是"到达序"，不是账上的全序。** `fugue tui` 那一档按读到的先后追加，而
// `tui --once` · `status --once` · `log` 读的是 `(seq, writer)` 的全序——同一份账，两份的
// **集合逐字相同、次序可以不同**（晚出现的那个 writer 第一条就是 `seq = 1`；`follow.test.ts`
// ②③ 那份夹具量的就是这件事）。两条路各答各的问题：跟随答"现在在发生什么"，一次读答
// "账按坐标长什么样"。**什么条件下改主意**：有人要求两条路逐字节相同——那要把每一帧的
// 永久行重排一遍，而已经写进终端历史的那几行收不回来（只能改成"每帧只画一块、不追加进
// 历史"），"实时"这一条跟着丢掉。
//
// **第一趟读齐、只画一次；之后一趟一批、一画（U4）。** `follow()` 从零起把账上已经有的几十条
// **作为一批**吐出来（`UI2` 实测过逐条那一档一次启动 31 次重画 · 394 次清行，而屏幕上一个字节的
// 差别都没有）；之后每一趟的新行也是一批——同趟到的几条对屏幕来说是同一瞬间。
//
// **注记那一层**（`note()`）：按键提示 · 起的那条命令的输出 · 它的退出码走这里。它与永久行同一档
// ——写在面板上方、**只写一次**——但**不是账上的一行**（账上有什么由 `probe/` 那两处说了算），
// 所以它不参与"已经写出去的那几条不许被回头改"那条判据。面板在屏幕底部，界面自己的话总得有个去处：
// 直接往 `stdout` 写会插进半块面板。
//
// **代价如实记在这里**：`readingsOf` 那一段**有帧快照记忆（U16）**——三份读数是纯函数对
// 「这一批行 + 焦点 + readings 选项」的答案，`rows` 每批换新引用，所以**同一批**被问几遍
// （`note()` 连按 · `redraw()`）都只折一次；一批新到恰折一次。缓存不改任何输出：折法只有一处
// 真源（`probe/status.ts` 的 `readingsOf`），这一份不另写一份。**永久行那一栏只折尾部（U5）**——
// `rows` 单调变长，已折的前缀是纯函数的答案。`readingsOf` 要改成增量折，那是另一格的事。
//
// **信号那一头是入参。** `Ctrl-C`（`AbortSignal`）由调用方给；`SIGWINCH` 那一档由调用方接
// `redraw()`。这一份不注册任何信号、不碰 `process`——那样它才在 `node --test` 里跑得动。
//
// **读源是事件通道那一份**（客户端化）：`source` 就是 `serve/source.ts` 的 `LedgerSource`，
// 一趟调用回一趟事。这一份因此**不认识账本**——不 import `log/log.ts`，也不 import
// `probe/watch.ts`；那两条直连住在 serve 那一头。界面手上那些行只有这一个来路。
import type { Phase } from '../model/price.ts'
import type { Catalog } from '../model/catalog.ts'
import type { ReadingsOptions, RoundUsage, StatusReadings, StatusRow } from '../probe/status.ts'
import { readingsOf, usageByRoundOf } from '../probe/status.ts'
import type { LedgerSource } from '../serve/source.ts'
import type { ConversationRow, FrameInput } from './frame.ts'
import { frameOf } from './frame.ts'
import type { FamilyTable } from './stream.ts'
import { conversationOf, permanentLinesOf } from './stream.ts'
import type { Panel, Term, ViewInput } from './term.ts'

/**
 * 那一档（`PLAN § 5.19` 的四条地板收成这一张表）：**面板**（真终端）· **只印永久行**（管道 · CI ·
 * `--once` · `$TERM` 认不出来）。后两条只差"要不要一直跟着"。
 *
 * `--once` 与 `--follow` 说不到一起，那条用法错在命令那一层就拦下了（退 2）；这里给 `--once` 让路。
 */
export type TuiMode = 'panel' | 'lines-once' | 'lines-follow'

/** resize 信号尾沿防抖的安静期（U7）：拖拽窗口连发的 `SIGWINCH` 只补最后一次重画。 */
export const RESIZE_WAIT_MS = 120

export function tuiModeOf(o: {
  readonly ansi: boolean
  readonly once: boolean
  readonly follow: boolean
}): TuiMode {
  if (o.once) return 'lines-once'
  if (!o.ansi) return o.follow ? 'lines-follow' : 'lines-once'
  return 'panel'
}

/**
 * 睡一会儿，**信号一到就当场醒**（跟随那一趟的节拍：账上没动就不空转）。
 *
 * 它替掉了原先 `probe/watch.ts` 那一份里的等待：那一条住在直连模块里，界面这一侧不再 import 它。
 */
function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(t)
      signal?.removeEventListener('abort', finish)
      done()
    }
    const t = setTimeout(finish, ms)
    if (signal?.aborted === true) finish()
    else signal?.addEventListener('abort', finish)
  })
}

/** 折一帧要的那几样（与 `probe/status.ts` 的 `readingsOf` 那两个开关同名同义）。 */
export interface SessionOptions {
  /** 三份读数里要哪几样（`--metrics` / `--report`）。不给就只要处境那一份。 */
  readonly readings?: ReadingsOptions
  /** 钱那一栏的档（峰/谷）。**不给就不印钱那一栏**——账上没有时刻，这一档只能由读的人给。 */
  readonly phase?: Phase
  /** 钱算在哪一份目录上（P2d）：与 `phase` 成对——两样都给了那一栏才印。 */
  readonly cat?: Catalog
  /** 事件族那一张分法表。**它是入参**（`ui/stream.ts`）：换一张表，历史那一栏就跟着换。 */
  readonly table?: FamilyTable
  /**
   * 那一刻**界面自己那几样**（输入行 · 候选那一层，`T4`）：每次折帧现问一次。
   *
   * **纯视图状态**——授权 · 排队 · 处境一律落在账上（PLAN § 5.19 一 · 3"界面不留第二份真相"），
   * 这一份里进得来的一律是"进程一退就没了"的那几样。不给就与从前逐字节相同。
   */
  readonly view?: (() => ViewInput) | undefined
  /**
   * `--tail N`（U15）：首趟永久行只写**尾部 N 条**——旧账很长时不用翻几百行才到活的那些。
   * 被跳过的前几条按「已写出去」记（`fresh()` 那道前缀检查从预置点起照走对账），之后的新行照常
   * 增量。N 大过行数就是全部；不给就与从前逐字节相同（全印）。
   */
  readonly reveal?: number
  /**
   * 折三份读数的那一刀（U16）：**缺省 `readingsOf`**。它进得来是为了**注入计数**——帧快照记忆
   * 的断言靠它数「同一批折了几次」。折法只有一处真源，这一份不另写一份。
   */
  readonly fold?: (rows: readonly StatusRow[], opts: ReadingsOptions | undefined) => StatusReadings
}

/**
 * 一档会话：**从开面板到收面板之间，读来的那些行累起来的那一份**。
 *
 * 它是这一份里唯一有状态的东西，而那个状态只有一样：**行**（`rows`）加上"哪几条永久行已经写出去
 * 了"（`shown`）。面板与历史都是它的纯函数。
 */
export interface TuiSession {
  /** 到这一刻为止读进来的行（到达序）。 */
  readonly rows: readonly StatusRow[]
  /** 收下新到的行（跟随一趟吐出来的那些，或第一趟读齐的那一批）。 */
  push(more: readonly StatusRow[]): void
  /** 到这一刻为止配得上历史的那些行的原文（全量）。 */
  permanent(): readonly string[]
  /** 到这一刻为止**还没写出去**的那几条（按原文次序）。**每调用一次就记下"写过了"**。 */
  fresh(): readonly string[]
  /** 那一刻的一帧（尺寸是入参——这一份不问终端）。 */
  frame(size: { readonly columns: number; readonly height: number }): readonly string[]
  /**
   * 那一刻的**一整块**（尺寸是入参）：面板那几行 + 它下面那几行输入行（`T4`）。终端那一头拿的是它。
   * 有输入行时**总行数才多出来**——终端那一档按"上一次停在哪一行"让位（`ui/term.ts` 头注）。
   */
  panel(size: { readonly columns: number; readonly height: number }): Panel
}

/**
 * 已经写出去的那一串 + 现在这一串 → 还没写的那几条。**前缀对不上就当场抛。**
 *
 * 为什么要这道检查：`fresh()` 是"接着上次那一条往下写"，而"上次那一条"在下一次折的时候**会重新算
 * 一遍**。分法那一张表是入参（`ui/stream.ts`），换掉它就能让已经写出去的某一条变样或消失——那时
 * 静默接着写就是把终端历史重新编号（人翻上去看到的那一串与现在的账对不上，而屏幕上不报错）。
 * 抛出去比接着写对：这一档宁可停在原地，也不许印一份对不上的历史。
 */
export function newLinesOf(all: readonly string[], shown: readonly string[]): readonly string[] {
  for (let i = 0; i < shown.length; i += 1) {
    const had = shown[i] as string
    const now = all[i]
    if (now !== had) {
      throw new Error(
        `永久行那一栏回头改了第 ${i + 1} 条：写出去的是「${had}」，现在是「${now ?? '（没了）'}」——` +
          '已经进终端历史的那几条收不回来，所以这一档停在原地',
      )
    }
  }
  return all.slice(shown.length)
}

/** 开一档会话。**一个句柄都不持有**：`log` 是调用方的，这里只累行、只折帧。 */
export function openSession(o: SessionOptions = {}): TuiSession {
  let rows: StatusRow[] = []
  let shown: readonly string[] = []
  // `--tail N`（U15）只管**首趟**：第一回 `fresh()` 之前 revealed 是关的，那一回把被跳过的前缀按
  // 「已写出去」记下，之后永远走增量。预置的前缀本身就是 `permanent()` 的切片——前缀恒真，所以
  // `newLinesOf` 那道检查从预置点起照常对账。
  let revealed = o.reveal === undefined
  // **只折尾部（U5）**：`rows` 只在 `push` 里换成**更长**的引用（不删不改），于是「折到哪」就是
  // 一个长度。已折的那一段是纯函数对前缀的答案，缓存它不改任何输出——问一百遍 `permanent()`
  // 也只折新到的那几条。分法表是会话期不变的入参；真被中途换掉（没人这么用），`fresh()` 那条
  // 前缀检查照旧当场抛——错位不会静默。
  let folded: readonly string[] = []
  let foldedAt = 0
  let conversation: readonly ConversationRow[] = []
  const permanent = (): readonly string[] => {
    if (foldedAt === rows.length) return folded
    const fresh = rows.slice(foldedAt)
    folded = [...folded, ...permanentLinesOf(fresh, o.table)]
    conversation = [...conversation, ...conversationOf(fresh, o.table)].slice(-3)
    foldedAt = rows.length
    return folded
  }
  /** 折整帧（面板要 `roles` 那一份，U20；`frame()` 那个入口只取 `lines`）。**纯函数**：这一档累起来的行 + 界面自己那几样（现问一次）。 */
  // **帧快照记忆（U16）**：三份读数是纯函数对「这一批行 · 焦点 · readings 选项」的答案。`rows`
  // 每批 `push` 换新引用，键就是它——**同一批**被问几遍（`note()` 连按 · `redraw()` · `frame()`
  // 与 `panel()` 各问一遍）都命中同一份答案，一批新到恰折一次。焦点一变（`Tab` 切格）键就换；
  // readings 选项是会话期不变量，引用一并进键——真被中途换掉（没人这么用）也只是多折一次，
  // 不会错位。折法只有一处真源，缺省就是 `readingsOf`。
  const fold = o.fold ?? readingsOf
  let snap:
    | {
        readonly rows: readonly StatusRow[]
        readonly focus: string | null
        readonly readings: ReadingsOptions | undefined
        readonly value: StatusReadings
      }
    | null = null
  const readingsAt = (focus: string | null): StatusReadings => {
    if (snap !== null && snap.rows === rows && snap.focus === focus && snap.readings === o.readings) return snap.value
    // **切到某一格就只折那一份**（`T8`）：筛的是喂给折法的那一批行——与 `status --agent <x>` 筛的是
    // 同一批（`probe/status.ts` 的 `readings` 那一档也在这儿筛）。不给焦点就是整份账。
    const seen = focus === null ? rows : rows.filter((r) => r.pos.writer === focus)
    const value = fold(seen, o.readings)
    snap = { rows, focus, readings: o.readings, value }
    return value
  }
  /**
   * 近几轮用量那一份（可读性三件 ② 的 sparkline）。**与 `readingsAt` 同一手**：折法是纯函数
   * （`probe/status.ts` 的 `usageByRoundOf`），键是这一批行的引用——一批新到恰折一次。
   *
   * **只在结果与花费那一档视图里折**（`frameFullAt` 按视图传）：另两档不印那一条，白折一趟是
   * O(账上那些行)。
   */
  let sparkSnap: { readonly rows: readonly StatusRow[]; readonly value: readonly RoundUsage[] } | null = null
  const sparkAt = (): readonly RoundUsage[] => {
    if (sparkSnap !== null && sparkSnap.rows === rows) return sparkSnap.value
    const value = usageByRoundOf(rows)
    sparkSnap = { rows, value }
    return value
  }
  const frameFullAt = (size: { readonly columns: number; readonly height: number }) => {
    const v = o.view?.()
    const input: FrameInput = {
      // 三份读数与 `status --once` 同一个入口（`readingsOf`）——命令面与这一档读的是同一份。
      ...readingsAt(v?.focus ?? null),
      ...(o.phase === undefined ? {} : { phase: o.phase }),
      ...(o.cat === undefined ? {} : { cat: o.cat }),
      // 界面自己那几样（输入行 · 候选那一层 · 树 · 门口那一块）**每帧现问**：它们不是读源，是这一档
      // 自己的视图状态。
      ...(v?.menu === undefined ? {} : { menu: v.menu }),
      ...(v?.nav === undefined ? {} : { nav: v.nav }),
      ...(v?.read === undefined ? {} : { read: v.read }),
      ...(v?.bottom === undefined ? {} : { bottom: v.bottom }),
      // 视图与本帧读的是哪一格（第二幕 ⑦）：折法那一边按 `focus` 筛行，这一边按它写框名。
      ...(v?.view === undefined ? {} : { view: v.view }),
      // 近几轮那条小条形只在读数那一档视图里有读者（可读性三件 ②）：按视图折，省掉白折的那一趟。
      ...(v?.view === 'spending' ? { usageByRound: sparkAt() } : {}),
      ...(v?.focus === undefined ? {} : { focus: v.focus }),
      permanent: permanent(),
      conversation,
      width: size.columns,
      height: size.height,
    }
    return frameOf(input)
  }
  const frameAt = (size: { readonly columns: number; readonly height: number }): readonly string[] =>
    frameFullAt(size).lines
  return {
    get rows(): readonly StatusRow[] {
      return rows
    },
    push(more: readonly StatusRow[]): void {
      if (more.length > 0) rows = [...rows, ...more]
    },
    permanent,
    fresh(): readonly string[] {
      const all = permanent()
      if (!revealed) {
        revealed = true
        // 行数还没到 N 就是全部（slice 头比尾大给空表）；之后 reveals 关掉，增量照旧。
        const keep = Math.max(0, all.length - (o.reveal ?? 0))
        shown = all.slice(0, keep)
      }
      const out = newLinesOf(all, shown)
      shown = all
      return out
    },
    frame: frameAt,
    panel(size: { readonly columns: number; readonly height: number }): Panel {
      const v = o.view?.()
      const f = frameFullAt(size)
      // `roles` 与 `rows` 平行（U20）：终端那一层按它查主题；排版在 `ui/frame.ts`，这里只是带话。
      // 框下面那几行（第二幕 ④）：提示行 ＋ 输入行——两样都在框外面，终端那一层按"框画几行、下面还几行"摆。
      return {
        rows: f.lines,
        roles: f.roles,
        ...(v?.hint === undefined ? {} : { hint: v.hint }),
        ...(v?.input === undefined ? {} : { input: v.input }),
      }
    },
  }
}

/** 这一档跑完时的读数。**每一栏只说这一档真有数的那一样**（面板那一档不报行数，反之亦然）。 */
export interface TuiCounts {
  /** 读进来的行数（`follow` 吐出来的那些）。 */
  readonly rows: number
  /** 其中配得上历史的（写进终端历史 / 进面板账尾的那些）。 */
  readonly permanent: number
  /** 面板画了几次（含 `redraw()` 那几次）；只印永久行那一档恒为 0。 */
  readonly draws: number
  /** 只印永久行那一档印出去的行数；面板那一档恒为 0。 */
  readonly lines: number
  /**
   * 界面自己写进历史的那几行（按键提示 · 按下去起的那条命令的输出 · 它收尾的退出码）。
   * **它不是账上的一行**——账上有什么由 `probe/` 那两处说了算，而这一栏数的是这一档自己说的话。
   */
  readonly notes: number
}

export interface TuiOptions {
  /**
   * 读源：**事件通道那一份**（`serve/source.ts` 的 `LedgerSource`）。界面这一侧只有这一条路
   * ——不开账本口、不顺着账本口扫（那两条住在 serve 那一头）。
   */
  readonly source: LedgerSource
  /** 摆的那一头（`ui/term.ts`）：擦 K 行、写 K 行。 */
  readonly term: Term
  /** 只印永久行那一档的出口（`cli` 那一侧的 `emitLine`）。面板那一档用不到它。 */
  readonly emit: (line: string) => void
  readonly mode: TuiMode
  readonly readings?: ReadingsOptions
  readonly phase?: Phase
  readonly cat?: Catalog
  readonly table?: FamilyTable
  /** 跟随那一趟睡多久（毫秒）。缺省 200——人眼的分辨率，而不是它的精度。 */
  readonly intervalMs?: number
  /** 停下来的信号（`Ctrl-C` 那一档把它拨一下）。 */
  readonly signal?: AbortSignal
  /** 界面自己那几样（输入行 · 候选那一层，`T4`）——一路递给会话，折帧时现问。 */
  readonly view?: (() => ViewInput) | undefined
  /** `--tail N`（U15）：一路递给会话——首趟永久行只写尾部 N 条。 */
  readonly reveal?: number
  /** 折三份读数的那一刀（U16）：一路递给会话——缺省 `readingsOf`，注入只为数「一批折了几次」。 */
  readonly fold?: (rows: readonly StatusRow[], opts: ReadingsOptions | undefined) => StatusReadings
  /**
   * 账往前动了一条时问一次（`T6`：门口那一批要不要重算）。**同步**——它只许"排一件事"，不许在
   * 这一趟里读账（读账那一头是异步的，而这一头跟着每一行走）。第一趟读齐的那一批也算一条。
   */
  readonly onAdvance?: ((rows: readonly StatusRow[]) => void) | undefined
}

/** 接上的那一档：一个句柄，两样东西——这一档累起来的行，与"跑完了"那一下。 */
export interface Tui {
  /** 累起来的那些行（"这一帧是从什么折出来的"这句问得出来）。 */
  readonly session: TuiSession
  /** 这一档跑完的那一下（`lines-once` 读一趟就 resolve）。 */
  readonly counts: Promise<TuiCounts>
  /**
   * 往终端历史里写一行**界面自己的话**：按键提示 · 按下去那条命令的输出 · 它收尾的退出码。
   *
   * **它不是账上的一行**（账上有什么由 `probe/` 那两处说了算），所以它进不了任何一栏，也不参与
   * `fresh()` 那条"已经写出去的那几条不许被回头改"的判据——它只写一次，写完就算了。
   * 为什么要有它：面板在屏幕底部，"按下去了"这件事总得有个回声；而界面直接往 `stdout` 写会在
   * 终端历史里插进半块面板（`ui/term.ts` 里那块地方是它自己在摆的）。
   */
  note(line: string): void
  /** 重画（`SIGWINCH` 那一档）：**不重读**——账没变，变的是地方。只印永久行那一档什么也不做。 */
  redraw(): void
  /**
   * resize 信号那一档（`SIGWINCH`，U7）：**尾沿防抖**——拖拽窗口时终端连发一串 `SIGWINCH`（实测
   * 几十毫秒一发），逐发重画就是"块叠块"。连按只补**最后一次**：安静 `RESIZE_WAIT_MS` 之后画一次。
   * `redraw()` 仍是立即的那一条（程序里自己知道变了要马上画的地方走它）。
   */
  resize(): void
}

/**
 * 接上：读账 → 折帧 → 摆到那一块地方，一路跟着。**它不注册信号、不碰 `process`、不关句柄**
 * （那三样都是调用方的：`cli/fugue.ts` 的 `tui`）。
 */
export function openTui(o: TuiOptions): Tui {
  const session = openSession({
    readings: o.readings,
    phase: o.phase,
    cat: o.cat,
    table: o.table,
    view: o.view,
    reveal: o.reveal,
    fold: o.fold,
  })
  const c = { rows: 0, permanent: 0, draws: 0, lines: 0, notes: 0 }
  /** 界面自己写的那几行（还没落到历史里的）：与永久行同一档、都写在面板上方，**都只写一次**。 */
  const notes: string[] = []
  const takeNotes = (): readonly string[] => (notes.length === 0 ? [] : notes.splice(0, notes.length))
  const sync = (): void => {
    c.rows = session.rows.length
    c.permanent = session.permanent().length
  }
  /** 画一次：面板那一档交给终端（擦与摆由 `ui/term.ts` 那一档说了算），只印永久行那一档走 `emit`。 */
  const paint = (): void => {
    // 次序：**账上那些行在前、界面自己的话在后**（`note` 说的是"刚刚按了一下"，它总发生在已经
    // 读到的那些行之后）。两条轨各管各的：`fresh()` 那条"前缀不许改"的判据只盯账上那一串。
    const fresh = [...session.fresh(), ...takeNotes()]
    if (o.mode === 'panel') {
      c.draws += 1
      o.term.draw(fresh, (size) => session.panel(size))
      return
    }
    c.lines += fresh.length
    for (const line of fresh) o.emit(line)
  }
  const counts = (async (): Promise<TuiCounts> => {
    // **第一趟读齐**（不给游标就是从零起问一趟）：账上已经有的那些一次折一帧。
    const first = await o.source.pass('')
    session.push(first.rows)
    sync()
    paint()
    // **第一趟那一批也算"往前动了"**：界面开着的时候门口已经停着一批，这一条是它唯一的触发点。
    if (first.rows.length > 0) o.onAdvance?.(first.rows)
    if (o.mode === 'lines-once') return { ...c }
    // 之后跟着走：**一趟调用一趟事**（架构 § 9.11）——游标每趟带回来，下一趟带着它接着问；
    // 新到的行一趟一批地进来（同一趟到的几条对屏幕来说是同一瞬间）。逐条画几十遍而字节一个不差
    // 是白烧（`UI2` 实测一次启动 31 次重画 · 394 次清行），所以一批进账、一趟一画。
    let resume = first.resume
    while (o.signal?.aborted !== true) {
      const batch = await o.source.pass(resume)
      resume = batch.resume
      if (batch.rows.length === 0) {
        await sleepMs(o.intervalMs ?? 200, o.signal)
        continue
      }
      session.push(batch.rows)
      sync()
      paint()
      o.onAdvance?.(batch.rows)
    }
    return { ...c }
  })()
  /** `redraw()` 的那一趟（`resize()` 的尾沿也走它）。 */
  const redrawNow = (): void => {
    if (o.mode !== 'panel') return
    c.draws += 1
    // resize 也把还没写出去的注记带上：账不重读，但这句话还没落到历史里。
    o.term.draw(takeNotes(), (size) => session.panel(size))
  }
  /** resize 的尾沿那一个定时器（U7）：连发只在安静之后补一次。`unref`——跟随循环才是吊住进程的那一个。 */
  let winTimer: ReturnType<typeof setTimeout> | null = null
  return {
    session,
    counts,
    note(line: string): void {
      if (line === '') return
      notes.push(line)
      c.notes += 1
      // 立刻画一次：**按下去了这件事要当场看得见**（等下一次账动可能很久，而"按了没反应"是这一档
      // 最坏的一种体验）。没按过键时这一档一次都不会被调到。
      paint()
    },
    redraw: redrawNow,
    resize(): void {
      if (o.mode !== 'panel') return
      if (winTimer !== null) clearTimeout(winTimer)
      winTimer = setTimeout(() => {
        winTimer = null
        redrawNow()
      }, RESIZE_WAIT_MS)
      winTimer.unref()
    },
  }
}
