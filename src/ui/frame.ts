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
//   · **对话视图那一档（缺省）**：轮次头 · 块间细线 · 在飞那几格（`chatOf`）——这是主面；
//   · **另两档视图**：`progress` = `round/state` 链重放出来的那几行（每一步 · 每一格走到哪儿 · 停因）；
//     `spending` = 记账那几行（契约 · 折叠尝试 · 冲突 · 验收 · 用量 · 八元 · 打回三数）；
//   · **账尾（footer）**：全账的那一条状态条（最近一条永久行的原文 · 或"最近一条事件是什么 ·
//     一共几条"）。它**不进任何一栏**：它是"这份账到哪儿了"，不是某一栏的读数——放进某一档
//     视图的话，"多一条 `round/state` 只动 `progress` 那一档"这条性质就会被它搅浑（`frame.test.ts` ②）。
//
// 于是有三条可证伪的性质（`frame.test.ts` ②/③/④ 那三条对照）：
//
//   · 账里多一条 `round/state` → **`progress` 那一档变**，`spending` 逐字节不变（账尾那条会动，那是
//     全账的读数）；
//   · 账里多一条 `merge/attempt`（冲突 2）→ **`spending` 变**，`progress` 逐字节不变；
//   · 账里多一次 `llm/call` → **两档都变**（调用次数在两边各有一处口径）——这一条也是对的，
//     它说明那两档不是按事件类型分的，是按**读法**分的。
//
// **装不下怎么办**：宽了**折行**（一行都不少——折在空格处，折不出来才硬切）；只有屏幕**矮**到
// 装不下这几行时才截断，并且末行说出还剩几行。**框恒填满这一屏**（第二幕 ⑦）：内容不够就用
// 空行补足（补在候选与门口那一块的上面）——宽了折 · 矮了截 · 不够补空，三条各管一件事。
// 高度连五行都没有（画不出框 + 账尾）时印一句"太矮"，不静默给一个空帧。
import type { MetricValue } from '../probe/metrics.ts'
import { costOf, matchModels, moneyText } from '../model/price.ts'
import type { Phase } from '../model/price.ts'
import type { Catalog } from '../model/catalog.ts'
import type { MetricReading } from '../probe/round.ts'
import { skipsNote } from '../probe/status.ts'
import type { RoundUsage, StatusSnapshot } from '../probe/status.ts'
import { clip, glyphs, widthOf, wrap } from './glyph.ts'
import { iconOf } from './icons.ts'
import type { IconName } from './icons.ts'
import { airOf, MIN_FRAME_ROWS } from './layout.ts'
import { humanNumber } from '../human.ts'
import { WORDS, stateFaceOf } from '../words.ts'
import { DEFAULT_VIEW, viewNameOf } from './views.ts'
import type { ViewKey } from './views.ts'

export { AIR_COLUMNS } from './layout.ts'

/**
 * 画得出框 + 账尾至少要几行：上下两条边 · 一行内容 · 一条分隔 · 一行账尾。**值住在 `ui/layout.ts`
 * 那一份布局常量表里**（第二幕 ④ 把这一带的数收成一处），这一行只是把那个名字露给这一份的读者。
 */
export const MIN_HEIGHT = MIN_FRAME_ROWS

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
  return Math.max(0, width - 2 - 2 * airOf(width))
}

/**
 * 一条读数的两栏。**它是这一份唯一的中间产物**——渲染与那三条对照都从它读。
 *
 * 第二幕 ⑦ 之后这两栏**不再并排**：它们各是一档 `Tab` 视图（`progress` / `spending`）的内容，
 * 行文一字没动（决策材料问三：两栏各拿满宽，行文与今天 `bodyOf` 一字不变）。对照那三条
 * （`frame.test.ts` ②③④）量的仍是这两栏，与它们印在屏上怎么摆无关。
 */
export interface FrameBody {
  /** 处境那几行（`progress` 视图的内容）。 */
  readonly left: readonly string[]
  /** 读数那几行（`spending` 视图的内容）。 */
  readonly right: readonly string[]
}

/** 一帧的三层。**帧自己说得出它的几何**（谁要把一帧拆开，就按 `columns` 拆）。 */
export interface Frame {
  readonly width: number
  readonly height: number
  /**
   * 内容那一栏占多少列。第二幕 ⑦ 之后没有第二栏了（`right` 恒 0）——留着那一格是为了不动
   * 这一份形状：读者与测试都按 `left + right + 3 = width` 读它。改主意的条件：再没有第二个
   * 读者时（0.5.0 那一档看）就把 `right` 收掉，那时 `columns` 直接是一个数。
   */
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
 * 行的角色（U20；U3 加了 `readHeading`；第三幕 ① 加了 `waiting`）：`border` 框线 · `body` 正文
 * （树与读数）· `footer` 账尾 · `overlay` 临时那一层（候选 · 门口那一块的预览与排队行）·
 * `waiting` **门口那一块里要人此刻按的那一行**（宪法 ② 点名的「门口选项行走等待黄」——它是"在等你"
 * 那一件事，不是又一个弹层）· `read` 阅读面正文 · `readHeading` 阅读面开着时**那个框的名字**。**只在地基这一层声明**——值是给终端那一层的 `theme` 查的键，排版本身不知道
 * 任何样式。（**永久行与输入行不在这张表里**：U20 那条形状不动——永久行进终端历史要保持干净
 * 流水，输入行是光标算术那一行。）
 */
export type LineRole = 'border' | 'body' | 'footer' | 'overlay' | 'waiting' | 'read' | 'readHeading' | 'hint' | 'ok' | 'refuse' | 'hit'

export interface ConversationRow {
  readonly text: string
  readonly role: LineRole
}

export interface FrameInput {
  readonly conversation?: readonly ConversationRow[]
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
   * 读源九（**可读性三件 ② 的 sparkline**）：近几轮用量的那一份（`probe/status.ts` 的
   * `usageByRoundOf` 折出来的）。
   *
   * **它只在结果与花费那一档视图里印**（另两档不印那一条），所以调用方按视图给。不给就一个字节都
   * 不占——那一条小条形是增强，不是地板（"没有这一栏 → 与无该档输出逐字节同形"）。
   */
  readonly usageByRound?: readonly RoundUsage[] | undefined
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
  /**
   * 看哪一档视图（第二幕 ⑦）：`chat`（缺省，对话主面）· `progress`（处境）· `spending`（读数）。
   * 缺省那一档由 `ui/views.ts` 的表说（`DEFAULT_VIEW`），这一份不另抄一个缺省值。
   */
  readonly view?: ViewKey | undefined
  /**
   * 切到哪一格（`T8`）：**在这一份里只进框名**（标题那一行印 `对话 · agent/r1/2`）。
   *
   * 折帧那一头按它筛行（`ui/follow.ts`），所以这一份拿到的快照已经是那一格的了；这里再要一次
   * 是因为对话视图不印树（决策材料的线框稿里没有它）——不写框名，人就不知道读的是哪一格。
   */
  readonly focus?: string | null | undefined
  readonly width: number
  readonly height: number
}

/** 用量那四个数：**量到的和 + 没量到的条数**（与 `status --once` 同一个口径）。 */
function usageText(t: { readonly total: number; readonly missing: number }): string {
  return t.missing > 0 ? `${humanNumber(t.total)}（缺 ${humanNumber(t.missing)} 条）` : humanNumber(t.total)
}

/**
 * 那条小条形最多印几轮（可读性三件 ② 的 sparkline）。**它是一个常量，可调**：八轮够看出"这一阵
 * 是越花越多还是收住了"，再长一行里也读不出更多。改主意的条件＝人嫌短——改这一个数，那一行别处
 * 一个字节都不动。
 */
export const SPARK_ROUNDS = 8

/**
 * 近几轮用量那条小条形（可读性三件 ② 的 sparkline）。**每轮一格**，四档从字形档取
 * （空 · `░` · `▒` · `█`——`▓` 在 console-setup 那一档零命中，不用；决策材料 § 5.1）。
 *
 * 分级：零那一轮就是那一个空格位（"零就不印"在条形里是不印色块，**列位照旧对齐**——第几格是第几轮
 * 这件事因此读得出来）；非零按**这一段里的峰值**分三级。量的是**每轮用量**（四个 token 数的合计），
 * 不是钱：钱要价目与峰谷两样都得给，缺一样这一栏就不该印。**改主意的条件**＝有人要按钱量（那时把
 * `costOf` 那一手接在这一处，仍是这一处判据）。
 *
 * 印不出来就不印（不是印一条空的）：一轮都没有 · 只有一轮（一个格子的趋势不算趋势）· 或者全是零。
 * **没量到的那些项一起报**（"少印要说出来"）——条形是下界时那句话说在括号里。
 */
function sparkLineOf(usage: readonly RoundUsage[] | undefined): string | null {
  const plots = (usage ?? []).filter((u) => u.round !== null)
  if (plots.length < 2) return null
  const shown = plots.slice(-SPARK_ROUNDS)
  const max = shown.reduce((n, u) => Math.max(n, u.tokens.total), 0)
  if (max <= 0) return null
  const g: readonly [string, string, string, string] = glyphs().spark
  const bar = shown
    .map((u) => {
      const level = u.tokens.total <= 0 ? 0 : 1 + Math.min(2, Math.floor((u.tokens.total / max) * 3))
      return g[level] as string
    })
    .join('')
  const miss = shown.reduce((n, u) => n + u.tokens.missing, 0)
  return `近 ${shown.length} 轮${WORDS.usage} ${bar}（最高 ${humanNumber(max)}${miss > 0 ? ` · ${miss} 项没量到` : ''}）`
}

/**
 * 两档视图的内容。**只读快照，不算任何东西**——这一份里没有一处从事件重算的口径（那是
 * `probe/` 那两处的事，两处都在它们自己那一份文件里）。
 *
 * 次序两档都是"先粗后细"：`progress` 那一档先是轮次那一行（状态 · 转移条数 · 打回几次）再逐条边、
 * 再每一格；`spending` 那一档先是记账那几行（契约 · 验收 · 用量 · **近几轮那条小条形**），再八元、
 * 再打回三数。
 */
export function bodyOf(o: {
  readonly snapshot: StatusSnapshot
  readonly metrics?: readonly MetricValue[]
  readonly report?: readonly MetricReading[]
  readonly phase?: Phase
  readonly cat?: Catalog
  readonly usageByRound?: readonly RoundUsage[] | undefined
}): FrameBody {
  const s = o.snapshot

  const left: string[] = []
  if (s.rounds.length === 0) {
    left.push('还没开过轮次（账上一条 round/state 都没有）')
  }
  for (const r of s.rounds) {
    const here = r.round === s.current ? ' · 最近一条落在这一轮' : ''
    // 跳步那一栏**不再自己做减法**（`hops - transitions` 在图外边那一档印出过 -1，在自环那一档
    // 把真的跳步抵成不印）；数与写法都从 `probe/status.ts` 那一处取，与命令行那一张脸同源。
    left.push(
      `${WORDS.round} ${r.round} · ${stateFaceOf(r.state)} · ${WORDS.transitions} ${humanNumber(r.transitions)} 条${skipsNote(r.skips)}` +
        ` · ${WORDS.rejects} ${humanNumber(r.rejects)} 次${here}`,
    )
    // **那几条原始转移不上主面**（收口后按人令）：它们是值层原文（`r.edges` 逐条进 `--json`），
    // 印出来是 `Idle ──land──> Planning` 这种内部名字——机器名上屏，人读不懂也不缺。条数与跳步数
    // 在轮次那一行；逐条原文的读法在阅读面的事件流与 `fugue log`。同一条口径：**主面只留人话，
    // 原文去阅读面**。改主意的条件：若实测发现"跳步那一条到底走了哪几步"在主面上要得紧，
    // 就把 `probe/status.ts` 的每一步改成**结构化的**（`from` / `to` / `on` 三栏，与 `round new
    // --json` 的 `trail` 同形），再由每一面各印各的人话——那是加值层的一栏，要人批。
    if (r.unrouted > 0) left.push(`  （图上走不通的 ${r.unrouted} 条：账与图对不上）`)
  }
  for (const a of s.agents) {
    // **零那一条印成一个状态，不印成一个"没有"**（决策材料问九：`停：没停` → `还在跑`）；
    // 停下来的那一档是 `N 步就停（停因）`——停因是账上的原话（`agent/stop` 的 `stopped`），一个字不动。
    const stop =
      a.stopped === null
        ? WORDS.moving
        : `${a.stopSteps === undefined ? '?' : humanNumber(a.stopSteps)} ${WORDS.steps}${WORDS.halted}（${a.stopped}）`
    // **一行一件事**（收口后按人令）：头一行只说"这是哪一格 · 它还在跑还是停了"，计数挪到缩进的那一行
    // ——与对话面同一个形状（`chatOf` 那两行）。**零值不上屏**：一条命令都没起过的格不印
    // 「运行命令 0 次」，与跳步 · 内核拒 · 边界挡同一条口径（零那一条不占宽度）。
    left.push(`${WORDS.agent} ${a.agent} · ${stop}`)
    left.push(
      `  ${[
        `${WORDS.calls} ${humanNumber(a.calls)} 次`,
        `走了 ${humanNumber(a.steps)} ${WORDS.steps}`,
        `${WORDS.invocations} ${humanNumber(a.invocations)}`,
        a.actions > 0 ? `${WORDS.commands} ${humanNumber(a.actions)} 次` : '',
      ]
        .filter((one) => one !== '')
        .join(' · ')}`,
    )
  }

  const right: string[] = []
  right.push(
    `${WORDS.task} ${humanNumber(s.contracts)} · ${WORDS.merges} ${humanNumber(s.attempts)} 次 · ` +
      `${WORDS.conflicts} ${humanNumber(s.conflicts)}` +
      ` · ${WORDS.accepts} ${humanNumber(s.accepts.accepts)} 次（过 ${humanNumber(s.accepts.pass)} / 没过 ${humanNumber(s.accepts.fail)}）`,
  )
  right.push(
    `${WORDS.usage} ${WORDS.calls} ${humanNumber(s.usage.calls)} · input ${usageText(s.usage.inputTokens)}` +
      ` · cacheRead ${usageText(s.usage.cacheReadTokens)}` +
      ` · cacheWrite ${usageText(s.usage.cacheWriteTokens)} · output ${usageText(s.usage.outputTokens)}` +
      ` · 思考 ${usageText(s.usage.reasoningTokens)}`,
  )
  // 近几轮用量那条小条形（可读性三件 ②）：**排在用量那一行下面**——先给合计，再给"这一阵的走势"。
  const spark = sparkLineOf(o.usageByRound)
  if (spark !== null) right.push(spark)
  // 钱那一栏：与 `status --once` 同一处算法、同一句话（`src/model/price.ts` 的 `moneyText`）。
  if (o.phase !== undefined && o.cat !== undefined) {
    const match = matchModels(s.models, o.cat)
    right.push(moneyText({ money: costOf(s.usage, match.row, o.phase), match, phase: o.phase, models: s.models }))
  }
  for (const m of o.metrics ?? []) {
    right.push(`${m.metric} ${m.value === null ? '算不出来' : m.value}（${m.numerator ?? '—'}/${m.denominator ?? '—'}）`)
  }
  if (o.report !== undefined && o.report.length > 0) {
    right.push(`打回 ${o.report.map((r) => `${r.metric} ${humanNumber(r.count)}`).join(' · ')}`)
  }
  return { left, right }
}

/**
 * 对话视图那一栏的一行：轮次头 · 块间细线 · 一格 agent · 那一格的读数（`aside`，缩进一行）。
 *
 * `aside` 是收口后按人令加的：格那一行从前五样挤在一起（这是谁 · 调用几次 · 几步 · 工具调用几次 ·
 * 停没停），用小圆点串到底——读的人得先自己把那一行拆开。现在第一行只说"这是谁 · 它还在跑还是停了"，
 * 计数那几样缩进着跟在下面。
 */
export interface ChatRow {
  readonly kind: 'head' | 'rule' | 'agent' | 'aside'
  readonly icon?: IconName | undefined
  readonly text: string
  readonly role?: LineRole
}

/**
 * 图标那两列（第二幕 ⑨ 的前一半）：**档关着给空串**——一个字节都不占，于是与"根本没有这一档"
 * 逐字节相同。开着是"一颗图标 + 一个空格"（两列，由 `widthOf` 量，不另记一个数）。
 */
function iconPrefixOf(icon: IconName | undefined): string {
  if (icon === undefined) return ''
  const glyph = iconOf(icon)
  return glyph === '' ? '' : `${glyph} `
}

/** 最近汇报占据主面；状态与计数分别进入账尾和视图。 */
export function chatOf(o: { readonly snapshot: StatusSnapshot; readonly conversation?: readonly ConversationRow[] }): readonly ChatRow[] {
  if ((o.conversation?.length ?? 0) > 0) {
    return (o.conversation as readonly ConversationRow[]).map((r) => ({ kind: 'head', text: r.text, role: r.role }))
  }
  const s = o.snapshot
  const state = s.rounds.find((r) => r.round === s.current)?.state
  if (state === 'Planning') return [{ kind: 'head', text: '计划已准备，等待你确认。', role: 'waiting' }]
  if (state === 'Committed') return [{ kind: 'head', text: '任务已完成，可以继续对话。', role: 'ok' }]
  if (state === 'Aborted') return [{ kind: 'head', text: '任务已中止，进展视图可查看原因。', role: 'refuse' }]
  if (state !== undefined || s.agents.some((a) => a.stopped === null)) return [{ kind: 'head', icon: 'round', text: '正在处理你的任务。' }]
  return [
    { kind: 'head', icon: 'round', text: '说说你想做什么。' },
    { kind: 'aside', text: '输入问题开始对话；/ 查看命令。', role: 'hint' },
  ]
}

/** 账尾只显示运行状态，不重复历史，也不显示内部事件坐标。 */
export function footerOf(s: StatusSnapshot, _permanent?: readonly string[]): string {
  const state = s.rounds.find((r) => r.round === s.current)?.state
  const running = s.agents.filter((a) => a.stopped === null).length
  return (state === undefined ? '等待输入' : stateFaceOf(state)) +
    (running > 0 ? ` · ${humanNumber(running)} 项任务在运行` : '')
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

/** 一段框线：左边一个空格与标签，右边拿横线补满（位置不够就只剩横线）。字形从档取。 */
function bar(w: number, label?: string): string {
  const h = glyphs().h
  if (label === undefined || widthOf(label) + 3 > w) return h.repeat(Math.max(0, w))
  return `${h} ${label} ` + h.repeat(w - widthOf(label) - 3)
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
  /**
   * 这几行里**要人此刻按的那一行**在第几个（`ui/gate.ts` 的选项行：`放行一次(y) · 拒(n) ·
   * 中止(Esc)` 那一行，以及它举起手之后的两种写法）。
   *
   * 它走「等待」那一格（宪法 ②：门口选项行走等待黄），其余各行走候选/弹层那一格。不给（或越界）
   * 时整块都还是弹层那一格——**与从前逐字节相同**（这一栏是加出来的，不是换掉）。
   */
  readonly waitingAt?: number | undefined
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
 * 看哪一档视图由 `view` 说（不给就是 `ui/views.ts` 的 `DEFAULT_VIEW`）。尺寸：`width` / `height`
 * 是入参；内容装不下时按行截断，末行说出还剩多少行（账尾那一条装不下时先让位——它是全账的
 * 读数，不是这一屏的内容）。`width <= 0 || height <= 0` 时给一个空帧（终端那一刻没给出尺寸）。
 */
export function frameOf(o: FrameInput): Frame {
  const { width, height } = o
  const empty: Frame = { width, height, columns: { left: 0, right: 0 }, footer: '', lines: [], roles: [] }
  if (width <= 0 || height <= 0) return empty
  if (width < MIN_WIDTH) {
    // 极窄帧：画不出框就说出来。不加这一道，出来的是一整幅 `││`（框内 0 列）——那是静默的空帧。
    const why = `（这一屏太窄：要 ${MIN_WIDTH} 列以上才画得出框）`
    return { ...empty, lines: [cell(why, width)], roles: ['body'] }
  }
  if (height < MIN_HEIGHT) {
    // 画不出框就说出来，不静默给一个空帧（读面那一条：少印要说）。
    const why = `（这一屏太矮：要 ${MIN_HEIGHT} 行以上才画得出框与账尾）`
    return { ...empty, lines: [cell(why, width)], roles: ['body'] }
  }

  const body = bodyOf(o)
  // 阅读面开着（下面那一栏有行）：**整块地方给它**，内容那一栏一个字节都不印（框名见下面）。
  const readingOn = (o.read?.rows.length ?? 0) > 0
  /**
   * 看哪一档视图（第二幕 ⑦）：对话（缺省）· 处境 · 读数。三档**各拿满宽**——两栏不再并排，
   * 于是「左栏 2/5 把一条边折成两行」与「右栏 3/5 把 `（过 2 / 没过` 切开」这两件事一起没了
   * （决策材料问三：两栏各拿满宽，行文与今天 `bodyOf` 一字不变）。
   */
  const view: ViewKey = o.view ?? DEFAULT_VIEW
  const inner = innerOf(width)
  const edge = width - 2
  const inset = ' '.repeat(airOf(width))


  // 内容那一栏那几行：**哪一档视图说什么话**。对话视图是 `chatOf` 折出来的那几行
  // （轮次头 · 细线 · 在飞那几格）；另两档是 `bodyOf` 的那一半，行文一字不变，只是各拿满宽。
  const bodyRows: readonly { readonly l: string; readonly role: LineRole }[] =
    view === 'chat'
      ? chatOf(o).map((x) =>
          x.kind === 'rule'
            ? { l: `${''}${glyphs().div.repeat(inner)}`, role: 'border' as const }
            : x.kind === 'aside'
              ? { l: `  ${x.text}`, role: x.role ?? 'body' as const }
              : { l: `${iconPrefixOf(x.icon)}${x.text}`, role: x.role ?? 'body' as const },
        )
      : (view === 'progress' ? body.left : body.right).map((l) => ({ l, role: 'body' as const }))
  const rows = bodyRows.flatMap((one) => wrap(one.l, inner).map((x) => ({ l: x, role: one.role })))

  // 账尾那条状态条：**一行**，超出就从右边截（`clip` 留 `…`，说了它被截过）。
  const footer = clip(footerOf(o.snapshot, o.permanent), inner)
  // 上下框两行、分隔与账尾两行；六行正文的预算不随信息量漂移。
  const withFooter = (o.bottom?.keep ?? 0) + 1 <= height - 4
  let budget = height - 2 - (withFooter ? 2 : 0)

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
      const g = glyphs()
      for (let i = w.from; i < w.from + w.count; i += 1) {
        menuBody.push(`${i === at ? g.sel : ' '} ${menuAll[i] as string}`)
      }
      if (w.summary) menuBody.push(`${g.mark} 还有 ${w.above + w.below} 条`)
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
    if (below > 0) {
      const g = glyphs()
      readBody[readBody.length - 1] = `${g.mark} 下面还有 ${below + 1} 行`
    }
  }
  budget -= readBody.length

  // 树那一栏（`T8`）**排在内容那一栏的最上面**（它是导航：主线为根 · agent 缩进一级）。它最多占四行
  // ——装不下时 `windowOf` 把选中那一个留在窗里，并把还剩几个说出来；预算先从这里扣（一栏都没有时
  // 下面这几步与从前逐字节相同）。**阅读面开着就不印它**（地方让给正文）。
  // 树那一栏（`T8`）**不进对话视图**：决策材料的线框稿里没有它，而对话视图那 6 行按 ④ 的行账
  // 分给了轮次头 · 细线 · 在飞那几格；切格走 `Alt-1…9`，读的是哪一格由框名说（见下）。
  const navAll = readingOn || view === 'chat' ? [] : (o.nav?.rows ?? [])
  const navCap = navAll.length === 0 ? 0 : Math.max(1, Math.min(4, budget - 2))
  const navWin = navAll.length === 0 ? null : windowOf(navAll.length, o.nav?.sel ?? 0, navCap)
  const navBody: string[] = []
  if (navWin !== null) {
    for (let i = navWin.from; i < navWin.from + navWin.count; i += 1) navBody.push(navAll[i] as string)
    if (navWin.summary) navBody.push(`  ${glyphs().mark} 还有 ${navWin.above + navWin.below} 个节点`)
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
  // 内容那一栏与临时那几层都**横贯整栏**（第二幕 ⑦ 之后没有第二栏了）：每行一个角色。
  const shown: { readonly l: string; readonly role: LineRole }[] = [
    ...navBody.map((l) => ({ l, role: 'body' as const })),
    ...content.map((x) => ({ l: x.l, role: x.role })),
  ]
  if (dropped > 0) shown.push({ l: `${glyphs().mark} 还有 ${dropped} 行没印`, role: 'body' })
  for (const one of readBody) shown.push({ l: one, role: 'read' })
  // **框恒填满这一屏**（第二幕 ⑦ 收尾）：`ui/layout.ts` 那本行账里「内容 6 行」是个**定数**
  // （框恒 10 行），而这一份从前只是"内容够长时看起来填满了"——账还小的时候（一两格 agent）
  // 框就短一截：框底浮上来，空行落在框与提示行之间，而且框底随账长大缩小、每帧多几行要重写。
  // 补出来的空行补在**候选与门口那一块的上面**：那两块接着输入行（决策材料那张线框里门口那一块
  // 就压在分隔线上），不该被空行顶上去。矮到装不下时走的是截断那条路（`还有 N 行没印`），
  // 这一处只补**多出来的**空行，不顶掉任何一行。
  //
  // 改主意的条件：有人嫌账小的时候框里空——去掉这一段，框就回到"内容多高就多高"
  // （框底随账动，逐行 diff 会多写几行）。
  const fixed = 2 + shown.length + (withFooter ? 2 : 0) + menuBody.length + gateBody.length
  for (let i = fixed; i < height; i += 1) shown.push({ l: '', role: 'body' })
  for (const one of menuBody) shown.push({ l: one, role: 'overlay' })
  // 门口那一块（第三幕 ①）：**要人此刻按的那一行**（选项行）走「等待」那一格，其余各行走弹层那一格。
  // 位置按"**离末行几个**"算：上面那几段让位是从**头**开始切的（末 `keep` 行一定还在），所以选项行
  // 与末行的距离在切前切后是同一个。
  const waitFromEnd =
    o.bottom === undefined || o.bottom.waitingAt === undefined ? -1 : gateAll.length - 1 - o.bottom.waitingAt
  for (const [i, one] of gateBody.entries()) {
    shown.push({ l: one, role: gateBody.length - 1 - i === waitFromEnd ? 'waiting' : 'overlay' })
  }

  const lines: string[] = []
  const roles: LineRole[] = []
  // 框名（U3）：阅读面开着时那个框叫「阅读面」，它那一行报 `readHeading`（主题里是加粗）——整块
  // 地方给的是它，框就得说它。其余照视图的名字（对话 · 进展 · 结果与花费），切到某一格时带上
  // 那一格：对话视图不印树，框名是「读的是哪一格」这件事唯一的落点。
  const g = glyphs()
  const focus = o.focus === undefined || o.focus === null ? '' : ` · ${o.focus}`
  const head = readingOn ? '阅读面' : `${viewNameOf(view)}${view === 'chat' ? '' : focus}`
  lines.push(`${g.tl}${bar(edge, head)}${g.tr}`)
  roles.push(readingOn ? 'readHeading' : 'border')
  for (const one of shown) {
    lines.push(`${g.v}${inset}${cell(one.l, inner)}${inset}${g.v}`)
    roles.push(one.role)
  }
  if (withFooter) {
    // **账尾的分隔那一行**：横线从字形档的 `div` 取（与框线那一横分成两格）——`box` 那一档交集里
    // 没有比 `─` 更细的一横，所以它与框同一条；`rich` 那一档是 `┈`。它**铺满框内**（块与块之间那条
    // 细线是另一件事：那条在对话视图的内容里，走空气列，见 `AIR_COLUMNS`）。
    lines.push(`${g.ml}${g.div.repeat(edge)}${g.mr}`)
    roles.push('border')
    lines.push(`${g.v}${inset}${cell(footer, inner)}${inset}${g.v}`)
    roles.push('footer')
  }
  lines.push(`${g.bl}${g.h.repeat(edge)}${g.br}`)
  roles.push('border')
  return { width, height, columns: { left: inner, right: 0 }, footer, lines, roles }
}
