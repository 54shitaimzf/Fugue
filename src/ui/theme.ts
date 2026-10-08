// TUI 的主题：**四级色表**与**八格语义色位**。出处：宪法（`design/ROADMAP.md` § 5 的那一行
// ①②——「256 色档 + 两级地板」与「语义色位八格定死（同义不许混用）」）· 施工单 § 五 第二幕 ③。
//
// **四级**（`COLOR_TIERS` 是那一张表，`tierOf` 是选档那一步）：
//
//   · 第 0 级 · 全关：`--no-style` 或 `NO_COLOR` 非空——一个字节的 SGR 都不写，与"根本没有主题"
//     逐字节相同（0.2.8 那两道门，口径不动）；
//   · 第 1 级 · 黑白属性：终端没说自己能上 256 色时的那一档。**它是 0.2.8 那一版的地板，
//     逐字节锁着**（验收：两道门与黑白地板逐字节不变）；
//   · 第 2 级 · 256 色：`COLORTERM` 或 `TERM` 认得才算（认不得就退第 1 级，**不半上色**）；
//   · 第 3 级 · truecolor：**不开**。表里留着它，`tierOf` 一档都不返回 3——取值与依据见
//     `SLOT_256` 上面那一段（256 档撞色是开它的前提，而那是要实证的事）。
//
// **八格**：`SLOT_MEANING` 是唯一真源，`SLOTS` 从它推；`SLOT_256` 给每一格一个 256 色索引，
// `ROLE_SLOT` 说每个行角色落在哪一格，`theme256()` 把三者折成"角色 → SGR"那份表——
// **没有一处手抄**（验收：色位表从 `theme.ts` 推、不手抄）。
//
// **第 1 级不参与八格**：它是属性档的地板、逐字节锁着，八格是**颜色**的语义位。于是同一角色在
// 两级上的写法可以不同名同义（账尾：属性档加粗 · 256 档落在「弱化」那一格）。这是"地板逐字节
// 不变"与"八格定死"两条硬约束的交点，取前者——记在停点报告的决策点里。
//
// **退回有两道门**：`--no-style`（tui 的开关表）与 `NO_COLOR` 非空（no-color.org 惯例）——
// 任何一道开了就不给主题，字节流与没有主题那一档逐字节相同。非 TTY / `$TERM` 认不出来
// 那一档本就不写一个字节的 ANSI，主题谈不上。
import type { LineRole } from './frame.ts'

/**
 * **八格语义色位**：这一张是唯一真源（`SLOTS` 从它推），一格一句它是什么意思。
 * **同义不许混用**——同一个意思只许落在同一格里。
 */
export const SLOT_MEANING = {
  ok: '成功',
  refuse: '拒绝/错误',
  waiting: '等待/运行中',
  dim: '弱化（框线 · 脚注 · 截断标记）',
  body: '正文',
  readHeading: '阅读面标题',
  overlay: '候选/弹层',
  hit: '命中行',
} as const

/** 那一格的键（从 `SLOT_MEANING` 推，不手抄）。 */
export type Slot = keyof typeof SLOT_MEANING

/** 八格的名字，次序与 `SLOT_MEANING` 的声明次序相同。 */
export const SLOTS: readonly Slot[] = Object.keys(SLOT_MEANING) as readonly Slot[]

/**
 * **四级表**（第 3 级不开，见文件头）。`ColorTier` 里没有 3——`tierOf` 的返回值类型就是那条判据
 * 的可执行形态：想上真彩，得先动人批下来的这一张表。
 */
export const COLOR_TIERS: readonly string[] = ['全关', '黑白属性', '256 色', 'truecolor（不开）']

/** 选得出来的那三档（第 3 级不在其中）。 */
export type ColorTier = 0 | 1 | 2

/**
 * 每个行角色落在哪一格。**每一格都要有人用得上**（`theme256()` 的键集合就是从这张表推出来的）。
 *
 * 三处取舍，各自说得出为什么：
 *   · `body` 与 `read` 都落在「正文」——阅读面的正文就是正文，不是另一种东西；
 *   · 账尾（`footer`）与提示行（`hint`）落在「弱化」——前者是一句脚注式的读数（"这份账到哪儿了"），
 *     后者是一句按键提示（第二幕 ④ 从终端历史搬进重画区、常驻框下面那一行），两样本来就该退后；
 *   · 「等待/运行中」那一格（`waiting`）第三幕 ① 起有了读者：**门口那一块里要人此刻按的那一行**
 *     （宪法 ② 点名的「门口选项行走等待黄」——它是"在等你"，不是又一个弹层）；
 *   · 「成功 · 拒绝/错误 · 命中行」三格今天**还没有行角色**用（一行就是一条验收结论那样的行 · 一行
 *     里只有半截是"命中的"——后者要行内分段才落得下）。它们在表里。八格是宪法定死的，不是按今天
 *     有多少消费者倒推的。
 */
export const ROLE_SLOT: Readonly<Record<LineRole, Slot>> = {
  border: 'dim',
  body: 'body',
  footer: 'dim',
  overlay: 'overlay',
  waiting: 'waiting',
  read: 'body',
  readHeading: 'readHeading',
  hint: 'dim',
}

/**
 * 第 2 级：八格各一个 256 色索引。**取值按参照系选**（Textual 的设计语言 · Claude Code 与
 * opencode 的实用第一）：低饱和、深色底与浅色底上都读得出来，且**不拿颜色当唯一信号**
 * （框线与留白照旧分出层次，颜色只是加快判读）。
 *
 *   · 成功 `35`（绿）· 拒绝/错误 `203`（柔红，不刺眼）· 等待/运行中 `214`（琥珀）；
 *   · 弱化 `242`（灰）——比 `240` 亮一档：暗底上 `240` 几乎看不见，而框线看不见＝框没了；
 *   · 正文不给（缺省那一副，`''` 会在终端那一层多写一个复位，所以不收进表里）；
 *   · 阅读面标题 `1;38;5;75`（粗 + 蓝）· 候选/弹层 `1`（粗）· 命中行 `1`（粗）。
 */
export const SLOT_256: Readonly<Record<Slot, string>> = {
  ok: '\x1b[38;5;35m',
  refuse: '\x1b[38;5;203m',
  waiting: '\x1b[38;5;214m',
  dim: '\x1b[38;5;242m',
  body: '',
  readHeading: '\x1b[1;38;5;75m',
  overlay: '\x1b[1m',
  hit: '\x1b[1m',
}

/**
 * 第 1 级（缺省那一档）：四个角色有值（`body` · `read` 不在表里——缺省不动）。
 * **这一份逐字节锁着**（0.2.8 的地板），改它要人批一次显示层期望移动。
 *
 * **加粗那一族从这张表推**：`term.test.ts` ⑬ 与 `theme.test.ts` ①② 都拿 `v === '\x1b[1m'`
 * 筛名单，不手抄一遍角色名——表动测试跟动，抄下来的那一份漂移时不报错。
 */
export const DEFAULT_THEME: Readonly<Partial<Record<LineRole, string>>> = {
  border: '\x1b[2m',
  footer: '\x1b[1m',
  overlay: '\x1b[1m',
  // 第 1 级里它**与弹层同一条属性**：那一行从前报的就是 `overlay`，换成等待那一格之后**字节不变**
  // （地板逐字节锁着那条不动）。黄只在第 2 级上出现（`SLOT_256.waiting`）。
  waiting: '\x1b[1m',
  readHeading: '\x1b[1m',
}

/**
 * 第 2 级那一份：角色 → SGR。**从 `ROLE_SLOT` 与 `SLOT_256` 推**——三张表只有一处真相，
 * 手抄第二份会在漂移时不报错。空 SGR 的角色不收进表（`term.ts` 那一层判的是 `undefined`）。
 */
export function theme256(): Readonly<Partial<Record<LineRole, string>>> {
  const out: Partial<Record<LineRole, string>> = {}
  for (const role of Object.keys(ROLE_SLOT) as readonly LineRole[]) {
    const sgr = SLOT_256[ROLE_SLOT[role]]
    if (sgr !== '') out[role] = sgr
  }
  return out
}

/**
 * 终端**自称**能上 256 色吗。`COLORTERM` 说 `256` / `truecolor` / `24bit`，或 `$TERM` 里带
 * `256color`，才算——认不得就退属性档（宪法：**不半上色**）。`truecolor` 那一声也收在这里：
 * 它声明的是"能上色"，落在第 2 级；真彩那一档**不开**（见文件头）。
 */
export function claims256(term: string | undefined, colorTerm: string | undefined): boolean {
  const c = (colorTerm ?? '').toLowerCase()
  const t = (term ?? '').toLowerCase()
  return c.includes('256') || c === 'truecolor' || c === '24bit' || t.includes('256color')
}

/**
 * 选档。**只返回 0 / 1 / 2**：第 3 级（truecolor）不在返回值类型里——那一条判据写在类型上，
 * 不写在注释里。
 */
export function tierOf(
  o: { noStyle?: boolean; noColor?: string | undefined; term?: string | undefined; colorTerm?: string | undefined } = {},
): ColorTier {
  if (o.noStyle === true) return 0
  if ((o.noColor ?? '') !== '') return 0
  return claims256(o.term, o.colorTerm) ? 2 : 1
}

/**
 * 给不给主题，给哪一档。`noColor` 是环境变量的**原值**：空串与未设一样算「没设」——
 * no-color.org 的口径是"非空才算喊了"。第 0 级给 `undefined`（= 没有主题，`openTerm` 不包一行）。
 */
export function themeOf(
  o: { noStyle?: boolean; noColor?: string | undefined; term?: string | undefined; colorTerm?: string | undefined } = {},
): Readonly<Partial<Record<LineRole, string>>> | undefined {
  const tier = tierOf(o)
  if (tier === 0) return undefined
  return tier === 2 ? theme256() : DEFAULT_THEME
}
