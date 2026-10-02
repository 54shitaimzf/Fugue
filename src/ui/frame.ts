// TUI 的第一格：**同一读面的第二档渲染**。
//
// 出处：架构 § 9.6 那张观察表（`status` / `watch` 的落地栏）· 架构 § 8.13（`round/state` 那条链
// 与它的图）· 架构 § 8.15（"不采集，只重算——因此任何指标都能被复核"）· PLAN § 5.18 的三面表
// （**事件面是唯一读源**：状态机从 `round/state` 链重放，指标从日志重算）· § 5.19 第五段
// （"TUI 是同一读面的第二档渲染，不是新功能"）。
//
// **它一个新读源都不开。** 进来的那份 `StatusSnapshot` 就是 `status --once` 印的那一份
// （`probe/status.ts` 折出来的），指标是 `--metrics` 那一份从日志重算出来的八元，打回三数是
// `--report` 那一份（`probe/round.ts`）。这一份**只排版**：一个字节都不写、一次 IO 都不做。
//
// 三条不许破的性质：
//
//   · **纯**：同一份输入调两次，逐字节相同——没有时间 · 没有随机 · 不读终端尺寸（尺寸是入参，
//     TUI 那一侧问终端，这一份不问）；
//   · **不写状态**（读面那一列的天花板）：它连"最后一帧"都不留；
//   · **少印要说出来**：屏幕装不下时截断，并且说出还剩多少行——读面不许因为屏小就静默少印。
//
// 一帧分三层，每层读的都是同一份快照，**没有一处从事件重算**（那是 `probe/` 那两处的事）：
//
//   · **左栏 = 处境**：`round/state` 链重放出来的那几行（每一步 · 每一格走到哪儿 · 停因）；
//   · **右栏 = 读数**：契约 · 折叠尝试 · 冲突 · 验收 · 用量 · 八元 · 打回三数；
//   · **账尾（footer）**：全账的那一条状态条（最近一条事件是什么 · 一共几条）。它**不进任何一栏**：
//     它是"这份账到哪儿了"，不是某一栏的读数——放进右栏的话，"多一条 `round/state` 只动左栏"
//     这条性质就会被它搅浑（`frame.test.ts` ②）。
//
// 于是有三条可证伪的性质（`frame.test.ts` ②/③/④ 那三条对照）：
//
//   · 账里多一条 `round/state` → **左栏变**，右栏逐字节不变（账尾那条会动，那是全账的读数）；
//   · 账里多一条 `merge/attempt`（冲突 2）→ **右栏变**，左栏逐字节不变；
//   · 账里多一次 `llm/call` → **两栏都变**（调用次数在左栏与右栏各有一处口径）——这一条也是对的，
//     它说明两栏不是按事件类型分的，是按**读法**分的。
//
// **装不下怎么办**：宽了**折行**（一行都不少——折在空格处，折不出来才硬切），窄了收成单栏
// （同一个框，少中间那根竖线）；只有屏幕**矮**到装不下这几行时才截断，并且末行说出还剩几行。
// 高度连五行都没有（画不出框 + 账尾）时印一句"太矮"，不静默给一个空帧。
import type { MetricValue } from '../probe/metrics.ts'
import { costOf, matchModels, moneyText } from '../model/price.ts'
import type { Phase } from '../model/price.ts'
import type { Catalog } from '../model/catalog.ts'
import type { MetricReading } from '../probe/round.ts'
import type { StatusSnapshot } from '../probe/status.ts'
import { clip, widthOf, wrap } from './glyph.ts'

/** 两栏至少要这么宽才画得下（再窄就收成单栏）：左 24 · 右 20 · 框与中间那根竖线 3 列。 */
export const MIN_TWO_COLUMN = 24 + 20 + 3

/** 画得出框 + 账尾至少要几行：上下两条边 · 一行内容 · 一条分隔 · 一行账尾。 */
export const MIN_HEIGHT = 5

/**
 * 画得出框至少要几列：左右两根竖线 + 框内一列。**出处是代码，不是直觉**：`ui/term.ts` 的列宽探测是
 * `seen > 0` 就放行，1–2 列照样落进 `frameOf`。
 *
 * 那一档不加这道提示画出来是什么：3 列以下 `innerOf` 给 0，框内一列都没有——每一行都是 `││`（一个
 * 字符都印不出来），1 列上连 `┌┐` 都比屏幕宽。与 `height < MIN_HEIGHT` **同一口径**：画不出框就说
 * 出来，不给一个静默的空框（读面那条"少印要说出来"）。
 *
 * **U2 之后的那句老话不成立了**：`innerOf` 把 `width - 2` 夹成 0 之后，"负数进了 `repeat` 当场
 * RangeError"这条已经不存在。守的东西因此收窄成一条——别印一个空框；出处与可达性一字未改。
 */
export const MIN_WIDTH = 3

/**
 * **框内那一栏**占几列（左右两根竖线各一列）。**这是它的唯一出处**——面板自己那一栏与舞台那几处
 * 算列宽的地方（`stage.ts` 的输入行 · 门口那一块 · 树 · 阅读面）全从这一只推。
 *
 * 为什么要收成一处：第二把尺就是第二份真相，而它漂移的时候**不报错**——宽一列的那一份画不进框，
 * `cell` 把它悄悄截掉，屏幕上只少一个字符。`width < 3` 时给 0（框都画不出来，那一档由 `frameOf`
 * 的极窄提示兜住，见 `MIN_WIDTH`）。
 */
export function innerOf(width: number): number {
  return Math.max(0, width - 2)
}

/** 一条读数的两栏。**它是这一份唯一的中间产物**——渲染与那三条对照都从它读。 */
export interface FrameBody {
  /** 左栏那些行：处境。 */
  readonly left: readonly string[]
  /** 右栏那些行：读数。 */
  readonly right: readonly string[]
}

/** 一帧的三层。**帧自己说得出它的几何**（谁要把一帧拆开，就按 `columns` 拆）。 */
export interface Frame {
  readonly width: number
  readonly height: number
  /** 左栏与右栏各占多少列（单栏那一档 `right` 是 0）。 */
  readonly columns: { readonly left: number; readonly right: number }
  /** 账尾那一行（已经是把 `footerOf` 折进框宽之后的样子）。 */
  readonly footer: string
  /** 整帧：`height` 行以内，逐行等宽（显示宽度，按 `widthOf` 那把尺）。 */
  readonly lines: readonly string[]
  /**
   * 那几行各自是**哪一种行**（U20 样式层地基）：与 `lines` 平行、逐行对应。排版这一层只**报**角色，
   * 不上样式——包不包 SGR 由终端那一层按 `theme` 决定，所以缺省（没有主题）时字节流一个不变。
   */
  readonly roles: readonly LineRole[]
}

/**
 * 行的角色（U20；U3 加了 `readHeading`）：`border` 框线 · `body` 正文（树与读数）· `footer` 账尾 ·
 * `overlay` 临时那一层（候选 · 门口那一块 · 排队）· `read` 阅读面正文 · `readHeading` 阅读面开着时
 * **那个框的名字**。**只在地基这一层声明**——值是给终端那一层的 `theme` 查的键，排版本身不知道
 * 任何样式。（**永久行与输入行不在这张表里**：U20 那条形状不动——永久行进终端历史要保持干净
 * 流水，输入行是光标算术那一行。）
 */
export type LineRole = 'border' | 'body' | 'footer' | 'overlay' | 'read' | 'readHeading'

export interface FrameInput {
  /** 读源一：那一刻的处境（`status --once` 印的那一份）。 */
  readonly snapshot: StatusSnapshot
  /** 读源二：八元指标。**不给就不印那一栏**——不拿 0 顶（`B1` 那一条）。 */
  readonly metrics?: readonly MetricValue[]
  /** 读源三：打回那三个数。同上，不给就不印。 */
  readonly report?: readonly MetricReading[]
  /**
   * 读的时候是峰时还是谷时（官方价目分两档）。**不给就不印钱那一栏**——账上没有时刻，这一档只能由
   * 读的人给（与 `status --once` 那条同一个口径）。
   */
  readonly phase?: Phase
  /**
   * 钱算在哪一份目录上（P2d）。与 `phase` **一起给才印**那一栏——两样都是"读的人递"，缺一样
   * 就不印（会话那一层的选项全是可选的，这一对也跟着可选；命令面总是成对递）。
   */
  readonly cat?: Catalog
  /**
   * 读源四：**永久行那一栏**（`ui/stream.ts` 的 `permanentLinesOf(rows)`）。账尾印它最后一条的
   * 原文——"这份账走到哪儿了"要说的是处境那条链走到哪了，不是"最近一条事件"的时刻与坐标（最近
   * 一条多半是一条只进瞬态区的 `llm/call`，印出来只是一个坐标）。不给（或空）时账尾照旧印
   * "最近 <事件>（writer seq）· 事件 N 条"。
   */
  readonly permanent?: readonly string[]
  /**
   * 读源五（**临时那一层**）：面板的候选行（`ui/menu.ts` 算好的原文）与选中项落在第几条。
   *
   * 它排在内容那一栏的**最下面**（挨着账尾）——面板是临时的一层，永久行与读数都不为它让位到看不见；
   * 装不下时 `windowOf` 把选中的那一条留在窗里，并把上下还剩几条说出来。不给时一列都不占。
   */
  readonly menu?: MenuInput | undefined
  /** 读源六（`T6`／`T7`）：**面板最下面那一栏**（门口那一块 · 排队行）。见 `BottomInput`。 */
  readonly bottom?: BottomInput | undefined
  /** 读源七（`T8`）：**树那几个节点**（排在内容那一栏的最上面）。见 `NavInput`。 */
  readonly nav?: NavInput | undefined
  /**
   * 读源八（`T9`）：**阅读面**那几行（`ui/read.ts` 的 `facesOf` 算好的原文）与看到第几行起。
   *
   * 它排在内容那一栏的**最下面**——挨着账尾、盖住底下那几行读数（人按了"我要看这一份东西"，
   * 那一刻要看的就是它）。装不下时最后一行说"下面还有 N 行"。不给时一个字节都不占
   * （`T9` 之前那一帧逐字节相同）。
   */
  readonly read?: ReadInput | undefined
  readonly width: number
  readonly height: number
}

/** 用量那四个数：**量到的和 + 没量到的条数**（与 `status --once` 同一个口径）。 */
function usageText(t: { readonly total: number; readonly missing: number }): string {
  return t.missing > 0 ? `${t.total}（缺 ${t.missing} 条）` : String(t.total)
}

/**
 * 两栏的内容。**只读快照，不算任何东西**——这一份里没有一处从事件重算的口径（那是
 * `probe/` 那两处的事，两处都在它们自己那一份文件里）。
 *
 * 次序两栏都是"先粗后细"：左栏先是轮次那一行（状态 · 转移条数 · 打回几次）再逐条边、再每一格；
 * 右栏先是记账那几行（契约 · 验收 · 用量），再八元、再打回三数。
 */
export function bodyOf(o: {
  readonly snapshot: StatusSnapshot
  readonly metrics?: readonly MetricValue[]
  readonly report?: readonly MetricReading[]
  readonly phase?: Phase
  readonly cat?: Catalog
}): FrameBody {
  const s = o.snapshot

  const left: string[] = []
  if (s.rounds.length === 0) {
    left.push('还没开过轮次（账上一条 round/state 都没有）')
  }
  for (const r of s.rounds) {
    const here = r.round === s.current ? ' · 最近一条落在这一轮' : ''
    left.push(`轮次 ${r.round} · 状态 ${r.state} · 转移 ${r.transitions} 条 · 图上 ${r.hops} 步 · 打回 ${r.rejects} 次${here}`)
    for (const e of r.edges) left.push(`  ${e}`)
    if (r.unrouted > 0) left.push(`  （图上走不通的 ${r.unrouted} 条：账与图对不上）`)
  }
  for (const a of s.agents) {
    const stop = a.stopped === null ? '没停' : `${a.stopSteps ?? '?'} 步 · ${a.stopped}`
    left.push(`格 ${a.agent} · 调 ${a.calls} 次 · ${a.steps} 步 · 工具调用 ${a.invocations} · 动作 ${a.actions} · 停：${stop}`)
  }

  const right: string[] = []
  right.push(
    `契约 ${s.contracts} · 折叠尝试 ${s.attempts} · 冲突 ${s.conflicts} · 验收 ${s.accepts.accepts} 次（过 ${s.accepts.pass} / 没过 ${s.accepts.fail}）`,
  )
  right.push(
    `用量 调用 ${s.usage.calls} · input ${usageText(s.usage.inputTokens)} · cacheRead ${usageText(s.usage.cacheReadTokens)}` +
      ` · cacheWrite ${usageText(s.usage.cacheWriteTokens)} · output ${usageText(s.usage.outputTokens)}` +
      ` · 思考 ${usageText(s.usage.reasoningTokens)}`,
  )
  // 钱那一栏：与 `status --once` 同一处算法、同一句话（`src/model/price.ts` 的 `moneyText`）。
  if (o.phase !== undefined && o.cat !== undefined) {
    const match = matchModels(s.models, o.cat)
    right.push(moneyText({ money: costOf(s.usage, match.row, o.phase), match, phase: o.phase, models: s.models }))
  }
  for (const m of o.metrics ?? []) {
    right.push(`${m.metric} ${m.value === null ? '算不出来' : m.value}（${m.numerator ?? '—'}/${m.denominator ?? '—'}）`)
  }
  if (o.report !== undefined && o.report.length > 0) {
    right.push(`打回 ${o.report.map((r) => `${r.metric} ${r.count}`).join(' · ')}`)
  }
  return { left, right }
}

/**
 * 账尾那一行（全账的读数，**不属于任何一栏**）：**最近那条永久行的原文**；一条永久行都还没有时
 * 才是"最近一条事件是什么 + 一共几条"。
 *
 * 次序是"最近一条"在前：这一行窄起来要从右边截（状态条那一档），先留住的是"账还在动"这个信号。
 * 永久行那一栏由分法给（`ui/stream.ts` 那一张表），这一份只读它的最后一条——不分法、不重算。
 */
export function footerOf(s: StatusSnapshot, permanent?: readonly string[]): string {
  const last = permanent?.[permanent.length - 1]
  if (last !== undefined) return last
  if (s.last === null) return '事件 0 条（账上还没有一条）'
  return `最近 ${s.last.t}（${s.last.writer} ${s.last.seq}）· 事件 ${s.events} 条`
}

/**
 * 把一帧补成**正好 `height` 行、每行正好 `columns` 列**——终端那一层要的那块恒定 K 行的区域。
 *
 * 为什么要在这一份里做：**1 逻辑行 = 1 物理行**是"上移 K 行"唯一的前提，而它靠两件事——每行
 * 恰好 `columns` 列（`cell` 先截后补）与行数不超过 `height`。`frameOf` 本来就保证
 * `lines.length <= height`，这里再兜一次；**少的那几行补空白，不补内容**（"还有 N 行没印"那句
 * 由 `frameOf` 自己说，补空行不是少印）。
 */
export function panelOf(lines: readonly string[], height: number, columns: number): readonly string[] {
  const h = Math.max(0, height)
  const w = Math.max(0, columns)
  const out = lines.slice(0, h).map((one) => cell(one, w))
  while (out.length < h) out.push(' '.repeat(w))
  return out
}

/** 补到正好 `w` 列（先截后补）。折过行的那几行进来时正好是 `w` 以内，所以这里的截是兜底。 */
function cell(s: string, w: number): string {
  const cut = clip(s, w)
  return cut + ' '.repeat(Math.max(0, w - widthOf(cut)))
}

/** 一段框线：左边一个空格与标签，右边拿 `─` 补满（位置不够就只剩 `─`）。 */
function bar(w: number, label?: string): string {
  if (label === undefined || widthOf(label) + 3 > w) return '─'.repeat(Math.max(0, w))
  return `─ ${label} ` + '─'.repeat(w - widthOf(label) - 3)
}

/** 候选那一层那几行（`ui/menu.ts` 算好的原文）与选中项落在第几条（`T4`）。 */
export interface MenuInput {
  readonly rows: readonly string[]
  readonly sel: number
}

/**
 * 面板最下面那一栏（**横贯整栏的那几行** + 装不下也要留住的条数）。
 *
 * 住在这里的是两样（各自算好原文进来，这一份只排版）：`T6` 的**门口那一块**（底部队列行 + 预览 +
 * 三档）与 `T7` 的**排队行**。装不下时**先让位的是预览**（头几行），末 `keep` 行留住——那几行是
 * 人要按 · 要看的东西。不给时一列都不占（`T6` 之前逐字节相同）。
 */
export interface BottomInput {
  readonly rows: readonly string[]
  readonly keep: number
}

/** 树那几个节点（`ui/nav.ts` 算好的原文）与选中项落在第几个（`T8`）。 */
export interface NavInput {
  readonly rows: readonly string[]
  readonly sel: number
}

/**
 * 阅读面那一栏（`T9`）：**算好的原文**与看到第几行起（`top`，0 = 标题那一行）。
 *
 * 它是**一栏整幅**的（不像候选那一层带 `▸` 选中标记）：人在这里是"读"，不是在"选"。装不下时
 * 只印得下多少印多少，末行说还剩几行——**少印要说出来**（`frame.ts` 那一条纪律）。
 */
export interface ReadInput {
  readonly rows: readonly string[]
  readonly top: number
}

/** 候选那一层开的一个窗：印第 `from` 条起的 `count` 条，`summary` 说还要不要补一行"还有几条"。 */
export interface MenuWindow {
  readonly from: number
  readonly count: number
  readonly above: number
  readonly below: number
  readonly summary: boolean
}

/**
 * 在 `budget` 行里给 `n` 条候选开一个窗，**选中的那一条一定在窗里**（偏到边上就贴着边走）。装不下时
 * 留一行说"还有几条"（`summary`），于是印出去的候选行数 + 那一样 ≤ `budget`。
 */
export function windowOf(n: number, sel: number, budget: number): MenuWindow {
  const total = Math.max(0, n)
  const b = Math.max(1, budget)
  const at = Math.max(0, Math.min(total - 1, sel))
  if (total <= b) return { from: 0, count: total, above: 0, below: 0, summary: false }
  if (b === 1) return { from: at, count: 1, above: at, below: total - at - 1, summary: false }
  const count = b - 1
  const from = Math.max(0, Math.min(total - count, at - Math.floor(count / 2)))
  const above = from
  const below = total - from - count
  return { from, count, above, below, summary: above + below > 0 }
}

/**
 * 一帧。**纯函数**：进去的那几样决定出来的那几行，别的一处都不看。
 *
 * 尺寸：`width` / `height` 是入参。两栏要 `MIN_TWO_COLUMN` 以上才画得出，否则收成单栏；
 * 内容装不下时按行截断，末行说出还剩多少行（账尾那一条装不下时先让位——它是全账的读数，
 * 不是这一屏的内容）。`width <= 0 || height <= 0` 时给一个空帧（终端那一刻没给出尺寸）。
 */
export function frameOf(o: FrameInput): Frame {
  const { width, height } = o
  const empty: Frame = { width, height, columns: { left: 0, right: 0 }, footer: '', lines: [], roles: [] }
  if (width <= 0 || height <= 0) return empty
  if (width < MIN_WIDTH) {
    // 极窄帧：画不出框就说出来。不加这一道，出来的是一整幅 `││`（框内 0 列）——那是静默的空帧。
    const why = `（这一屏太窄：要 ${MIN_WIDTH} 列以上才画得出框，拿到的是 ${width} 列）`
    return { ...empty, lines: [cell(why, width)], roles: ['body'] }
  }
  if (height < MIN_HEIGHT) {
    // 画不出框就说出来，不静默给一个空帧（读面那一条：少印要说）。
    const why = `（这一屏太矮：要 ${MIN_HEIGHT} 行以上才画得出框与账尾，拿到的是 ${height} 行）`
    return { ...empty, lines: [cell(why, width)], roles: ['body'] }
  }

  const body = bodyOf(o)
  // 阅读面开着（下面那一栏有行）：**整块地方给它**，框也跟着收成单栏——那一刻左右两栏一个字节都
  // 不印，还留着 `┬` 与「读数」那个栏名，只会让人以为右边的数在别处（框名见下面 `topName`）。
  const readingOn = (o.read?.rows.length ?? 0) > 0
  const two = !readingOn && width >= MIN_TWO_COLUMN && body.left.length > 0 && body.right.length > 0
  // **右栏拿大头（3/5）**（U10c）：读数那一栏是"数字 + 分子/分母"的长行（八元指标一条
  // 就是一句），40 列那档两栏对半时它截得最狠；处境那一栏的行短（轮次 · 状态 · 边），
  // 2/5 装得下。两根竖线加两头的框占 3 列，先扣再分。
  const inner = innerOf(width)
  const left = two ? Math.floor(((width - 3) * 2) / 5) : inner
  const right = two ? width - 3 - left : 0

  // 内容那一栏：**先把每一行折进它那一栏的列宽**，再一行对一行（右边短的那些补空）；
  // 单栏那一档先把左栏印完再印右栏（同一个框，只是没有中间那根竖线）。
  const rows: { readonly l: string; readonly r: string; readonly full?: boolean }[] = []
  if (two) {
    const l2 = body.left.flatMap((one) => wrap(one, left))
    const r2 = body.right.flatMap((one) => wrap(one, right))
    const n = Math.max(l2.length, r2.length)
    for (let i = 0; i < n; i += 1) rows.push({ l: l2[i] ?? '', r: r2[i] ?? '' })
  } else {
    for (const one of body.left.flatMap((x) => wrap(x, left))) rows.push({ l: one, r: '' })
    for (const one of body.right.flatMap((x) => wrap(x, left))) rows.push({ l: one, r: '' })
  }

  // 账尾那条状态条：**一行**，超出就从右边截（`clip` 留 `…`，说了它被截过）。
  const footer = clip(footerOf(o.snapshot, o.permanent), inner)
  // 框占上下两行，账尾占分隔 + 一行；装不下就先让账尾让位。**阅读面开着时内容那一栏一个字节都
  // 不印**（`content` 是空的），所以让它参与"装不装得下"的只有框与账尾自己——不留那条看不见的
  // 依赖（阅读面能印几行，取决于被它盖住的那一栏折成几行）。
  const used = readingOn ? 0 : rows.length
  let withFooter = used + 4 <= height
  let budget = height - 2 - (withFooter ? 2 : 0)
  if (budget < 1) {
    withFooter = false
    budget = height - 2
  }

  // 候选那一层（`/` 菜单 · `Ctrl-P` 面板）**从内容那一栏的最下面切一块**（最多一半）：面板开开关关，
  // 上面那几行读数一个字节都不动；它自己装不下时把选中的那一条留在窗里，并把还剩几条说出来。
  const menuAll = o.menu === undefined ? null : o.menu.rows
  const menuCap = menuAll === null ? 0 : Math.max(1, Math.min(Math.floor(budget / 2), Math.max(1, menuAll.length)))
  const win = menuAll === null || menuAll.length === 0 ? null : windowOf(menuAll.length, o.menu?.sel ?? 0, menuCap)
  const menuBody: string[] = []
  if (menuAll !== null) {
    if (menuAll.length === 0) menuBody.push('（没有匹配的）')
    else {
      const w = win as MenuWindow
      const at = Math.max(0, Math.min(menuAll.length - 1, o.menu?.sel ?? 0))
      for (let i = w.from; i < w.from + w.count; i += 1) {
        menuBody.push(`${i === at ? '▸' : ' '} ${menuAll[i] as string}`)
      }
      if (w.summary) menuBody.push(`… 还有 ${w.above + w.below} 条（↑↓ 翻，选中第 ${at + 1} 条）`)
    }
  }
  // 阅读面那一栏（`T9`）**开着的时候整块地方给它**：树与内容那一栏都不印——那一刻人要看的就是
  // 这一份东西（"看一眼就走"），而 K 是恒定的（`ui/term.ts` 的行数账），挤在一起两边都读不下去。
  // 每一条变更都带着账上的坐标（`<writer> <seq> · `），所以"读的是哪一格"在这一栏里仍然看得见。
  const readAll = o.read?.rows ?? []
  const readBody: string[] = []
  if (readingOn) {
    // 从 `top` 那一行起印；装不下时**末行换成"下面还有几行"**（不截中间那一截）。
    const top = Math.max(0, Math.min(o.read?.top ?? 0, Math.max(0, readAll.length - 1)))
    const count = Math.min(readAll.length - top, Math.max(1, budget))
    for (let i = top; i < top + count; i += 1) readBody.push(readAll[i] as string)
    const below = readAll.length - (top + count)
    // **被这一句提示顶掉的那一行也算遗漏**（交接单判决 7）：末行本来要印第 `top + count` 行，它现在
    // 被提示换了——这一行数的是"屏上没看见几行"，不是"游标之后还剩几行"。
    if (below > 0) readBody[readBody.length - 1] = `… 下面还有 ${below + 1} 行（↑↓ 翻 · Esc 收起）`
  }
  budget -= readBody.length

  // 树那一栏（`T8`）**排在内容那一栏的最上面**（它是导航：主线为根 · agent 缩进一级）。它最多占四行
  // ——装不下时 `windowOf` 把选中那一个留在窗里，并把还剩几个说出来；预算先从这里扣（一栏都没有时
  // 下面这几步与从前逐字节相同）。**阅读面开着就不印它**（地方让给正文）。
  const navAll = readingOn ? [] : (o.nav?.rows ?? [])
  const navCap = navAll.length === 0 ? 0 : Math.max(1, Math.min(4, budget - 2))
  const navWin = navAll.length === 0 ? null : windowOf(navAll.length, o.nav?.sel ?? 0, navCap)
  const navBody: string[] = []
  if (navWin !== null) {
    for (let i = navWin.from; i < navWin.from + navWin.count; i += 1) navBody.push(navAll[i] as string)
    if (navWin.summary) navBody.push(`  … 还有 ${navWin.above + navWin.below} 个节点（Tab 循环 · Alt-1…9 直选）`)
  }
  budget -= navBody.length

  // 最下面那一栏（`T6` 的门口那一块 · `T7` 的排队行）先占住它那几行，再轮到候选，最后才是内容那一
  // 栏（装不下时**从后往前让位**，而那一栏自己先让位的是**预览**——头几行；末 `keep` 行留住：那是
  // 人要按 · 要看的东西）。一栏都没有（`bottom` 不给）时下面这几步与从前逐字节相同。
  const gateAll = o.bottom?.rows ?? []
  const keep = Math.max(0, Math.min(o.bottom?.keep ?? 0, gateAll.length))
  let gateBody = [...gateAll]
  while (gateBody.length > keep && budget - 1 - gateBody.length < 0) gateBody = gateBody.slice(1)
  while (menuBody.length > 0 && budget - 1 - gateBody.length - menuBody.length < 0) menuBody.pop()
  while (gateBody.length > keep && budget - 1 - gateBody.length - menuBody.length < 0) gateBody = gateBody.slice(1)
  while (menuBody.length > 0 && budget - gateBody.length < 1) menuBody.pop()
  while (gateBody.length > 0 && budget - gateBody.length < 1) gateBody = gateBody.slice(1)
  const bodyBudget = Math.max(1, budget - menuBody.length - gateBody.length)
  // 阅读面开着：内容那一栏一个字节都不印（地方整块给了正文，见上面那一段）。
  const content = readingOn ? [] : rows.length <= bodyBudget ? rows : rows.slice(0, Math.max(0, bodyBudget - 1))
  const dropped = readingOn ? 0 : rows.length - content.length
  // 树那一栏在最上面，然后才是内容那一栏（它的每一行都是横贯整栏的）。行带着**角色**（U20）：
  // 树与读数是正文 · 阅读面正文是 `read` · 候选与门口那一块是临时的 `overlay`。
  const shown: { readonly l: string; readonly r: string; readonly full?: boolean; readonly role: LineRole }[] = [
    ...navBody.map((l) => ({ l, r: '', full: true, role: 'body' as const })),
    ...content.map((x) => ({ ...x, role: 'body' as const })),
  ]
  if (dropped > 0) shown.push({ l: `… 还有 ${dropped} 行没印（这一屏 ${height} 行）`, r: '', role: 'body' })
  for (const one of readBody) shown.push({ l: one, r: '', full: true, role: 'read' as const })
  for (const one of menuBody) shown.push({ l: one, r: '', full: true, role: 'overlay' as const })
  for (const one of gateBody) shown.push({ l: one, r: '', full: true, role: 'overlay' as const })

  const lines: string[] = []
  const roles: LineRole[] = []
  // 框名（U3）：阅读面开着时那个框叫「阅读面」，它那一行报 `readHeading`（主题里是加粗）——整块
  // 地方给的是它，框就得说它。两栏那一档照旧是「处境 / 读数」。
  lines.push(`┌${bar(left, readingOn ? '阅读面' : '处境')}${two ? `┬${bar(right, '读数')}` : ''}┐`)
  roles.push(readingOn ? 'readHeading' : 'border')
  for (const one of shown) {
    // 候选那一层**横贯整栏**（它是临时的一层，不参与左右两栏的分工）。
    if (one.full === true) {
      lines.push(`│${cell(one.l, inner)}│`)
      roles.push(one.role)
      continue
    }
    lines.push(`│${cell(one.l, left)}${two ? `│${cell(one.r, right)}` : ''}│`)
    roles.push(one.role)
  }
  if (withFooter) {
    lines.push(`├${'─'.repeat(left)}${two ? `┴${'─'.repeat(right)}` : ''}┤`)
    roles.push('border')
    lines.push(`│${cell(footer, inner)}│`)
    roles.push('footer')
  }
  lines.push(`└${'─'.repeat(left)}${two ? `┴${'─'.repeat(right)}` : ''}┘`)
  roles.push('border')
  return { width, height, columns: { left, right }, footer, lines, roles }
}
