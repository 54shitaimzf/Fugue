// TUI 的主面与它轮换出去的那两档视图（第二幕 ⑦）。
//
// 出处：交接单 § 三 3「对话与汇报为主面、状态收进账尾；两栏『处境 · 读数』是 `Tab` 轮换出去的视图
// （`nav.ts` 现成形状）」· § 五 ⑦「27 格处置：12 保留进账尾与对话流 · 11 降级进 Tab 视图 · 4 删」
// · 决策材料问三那张切法表与它那两张三分表。
//
// **三档，一个环**：`对话`（缺省）· `处境` · `读数`。轮换的形状直接从 `nav.ts` 取
// （`clampNav` / `stepNav`）——"在几档之间循环"与"在几格之间循环"是同一件事，不写第二份。
// 视图是**纯视图状态**：不落账 · 不进日志 · 进程一退就没了（PLAN § 5.19 一 · 3）。
//
// **三分表也住在这里**（`CELL_TABLE`）：哪一格印在哪一面是这一站定下来的事，写进代码比写在
// 提交信息里可查——`views.test.ts` ③ 拿它数数（12/11/4），并把"删"的那四格按人读两面 × 值层
// 两面各查一遍。表里不改一行渲染：它是一份**决定记录**，不是第二份渲染真源。
import { WORDS } from '../words.ts'
import { clampNav, stepNav } from './nav.ts'

/** 视图的键。**只在代码里用**；印出去的那个词从 `ui/../words.ts` 那一处取（`WORDS.chat` 等）。 */
export type ViewKey = 'chat' | 'progress' | 'spending'

/**
 * 视图表：一处真源，**次序就是 `Tab` 轮换的次序**（头一个是缺省面）。
 *
 * `face` 从词表取，不在这里另写一遍——`处境` / `读数` 那两个词与面板、与人面是同几个字节。
 */
export const VIEW_TABLE: readonly { readonly key: ViewKey; readonly face: string; readonly arch: string }[] = [
  { key: 'chat', face: WORDS.chat, arch: '对话主面（缺省视图：轮次头 + 在飞那几格）' },
  { key: 'progress', face: WORDS.progress, arch: '`bodyOf().left` 那一半（一字不改搬过来当一档视图）' },
  { key: 'spending', face: WORDS.spending, arch: '`bodyOf().right` 那一半（同上）' },
]

/** 表里那些键的名单（**从表推**，次序就是表里的次序）。 */
export const VIEW_KEYS: readonly ViewKey[] = VIEW_TABLE.map((v) => v.key)

/** 缺省那一档（表里头一个）——`frameOf` 不给 `view` 时就是它。 */
export const DEFAULT_VIEW: ViewKey = VIEW_KEYS[0] as ViewKey

/** 键 → 印出去的那个词。认不出来的键退到缺省那一档（不猜、也不报——它到不了）。 */
export function viewNameOf(k: ViewKey): string {
  return VIEW_TABLE.find((v) => v.key === k)?.face ?? WORDS.chat
}

/** 第几号视图（夹回范围里，与 `clampNav` 同一手）。 */
export function viewAt(at: number): ViewKey {
  return VIEW_KEYS[clampNav(VIEW_KEYS.length, at)] as ViewKey
}

/** 走一档（`Tab` 用）：**环形**——最后一个再往下回到第一个。 */
export function stepView(at: number, delta: number): number {
  return stepNav(VIEW_KEYS.length, at, delta)
}

/**
 * 一格信息印在哪一面（三分表）。六种去处：
 *
 *   · `tail` 账尾那一行 · `flow` 对话流（永久行）· `chat` 对话视图那一栏（框内）
 *   · `progress` 处境视图 · `spending` 读数视图 · `gone` 哪儿都不印（值层照旧，进 `--json`）
 */
export type CellHome = 'tail' | 'flow' | 'chat' | 'progress' | 'spending' | 'detail' | 'gone'

/** 去处 → 人读的说法（报告与断言都用这一份，不另写）。视图那三档的名字从词表取。 */
export const HOME_NAME: Readonly<Record<CellHome, string>> = {
  tail: '账尾',
  flow: '对话流（永久行）',
  chat: `${WORDS.chat}视图`,
  progress: `${WORDS.progress}视图`,
  spending: `${WORDS.spending}视图`,
  detail: '阅读面详情',
  gone: '仅 JSON 与详情',
}

/**
 * 27 格的信息去处（本轮按聊天优先重新分配）。**一格一行**：`cell` 是账上那一格的名字，`home` 是它这一站去哪儿，
 * `why` 是判据或来路。数与去向都是决策材料那两张表的并表结果；`删` 那四格是交接单 § 五 ⑦
 * 点名的四个（`hops` 与界面里无读者的 `denies` / `bounds` / `last`）。
 *
 * 计数口径（写清楚，免得下一次对不上）：**按格数**，同一格的多栏（比如 `accepts.pass` 与
 * `.fail`）算一格，一族今天一处都不印的（`refusals` 全部 · `outside` · `ledger`/`clock`）
 * 合起来算一格。合计 12 + 11 + 4 = 27。
 */
export const CELL_TABLE: readonly { readonly cell: string; readonly home: CellHome; readonly why: string }[] = [
  // 运行状态进账尾；结果进对话流；计数与内部编号按需查看。
  { cell: 'rounds[].round', home: 'progress', why: '轮次编号在进展视图查看' },
  { cell: 'rounds[].state', home: 'tail', why: '账尾只显示当前运行状态' },
  { cell: 'agents[].agent', home: 'progress', why: '执行者编号在进展视图查看' },
  { cell: 'agents[].calls', home: 'progress', why: '调用次数在进展视图查看' },
  { cell: 'agents[].steps', home: 'progress', why: '步数与停止原因在进展视图查看' },
  { cell: 'agents[].invocations', home: 'progress', why: '工具调用次数在进展视图查看' },
  { cell: 'agents[].stopped + stopSteps', home: 'progress', why: '停止状态与步数在进展视图查看' },
  { cell: 'accepts.pass / accepts.fail', home: 'flow', why: '`merge/accept` 那条永久行本来就有' },
  { cell: 'conflicts', home: 'flow', why: '`merge/attempt` 那条永久行本来就有' },
  { cell: 'rejects', home: 'progress', why: '退回次数在进展视图查看' },
  { cell: 'refusals.byRule（contract-scope 那一档）', home: 'detail', why: '主面只报被拒绝的路径，规则编号进入详情' },
  { cell: 'events + last（兜底）', home: 'detail', why: '内部事件坐标进入阅读面详情' },
  // Tab 视图：查得到，不占对话主面。
  { cell: 'rounds[].transitions', home: 'progress', why: '问三判据：这一条是"查得到"，不是常看' },
  { cell: 'rounds[].skips', home: 'progress', why: '同上；零就不印是今天的行为，一个字没动' },
  { cell: 'rounds[].edges', home: 'progress', why: '那条链的骨架' },
  { cell: 'rounds[].unrouted', home: 'progress', why: '账与图对不上时的自报' },
  { cell: 'agents[].actions', home: 'progress', why: '运行命令几次——细目，进 `progress` 那一档视图' },
  { cell: 'contracts', home: 'spending', why: '记账那一行' },
  { cell: 'attempts', home: 'spending', why: '同上（定义待核，词先按"合并试了"出）' },
  { cell: 'usage（调用数 + 六个 token 数）', home: 'spending', why: '用量只在结果与花费视图查看' },
  { cell: 'metrics 八元', home: 'spending', why: '重算出来的指标，按需看' },
  { cell: 'report 打回三数（含 denied 那一格）', home: 'spending', why: '与 `refusals.kernel` 同源同数——那处重复留在详读那一面' },
  { cell: 'refusals 全部 + outside + ledger/clock', home: 'spending', why: '界面今天一处都不印的那几族，按需读' },
  // 三 · 删（4）：人读两面一处都不印，值层照旧（进 `--json` 与详情面）
  { cell: 'rounds[].hops', home: 'gone', why: '零读者：每一跳印在哪几条边上，`edges` 那几行自己写着' },
  { cell: 'agents[].denies', home: 'gone', why: '人读两面都没有读者（`denied` 那个数在"越界 被挡"那一行里）' },
  { cell: 'agents[].bounds', home: 'gone', why: '同上（围栏挡的那一栏）' },
  { cell: 'agents[].last', home: 'gone', why: '同上（最近一条落在哪：账尾已经说了整账的最近）' },
]

/** 表里那些去处的格数（`{ tail: 2, … }`）——`views.test.ts` 同时核对去处与实际渲染。 */
export function cellCounts(): Readonly<Record<CellHome, number>> {
  const out: Record<CellHome, number> = { tail: 0, flow: 0, chat: 0, progress: 0, spending: 0, detail: 0, gone: 0 }
  for (const one of CELL_TABLE) out[one.home] += 1
  return out
}
