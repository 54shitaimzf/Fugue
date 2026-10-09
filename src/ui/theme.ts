// 主题按能力升档：全关 → 黑白属性 → 16 色 → 256 色；truecolor 暂不开。
// 八格语义色位共用 ROLE_SLOT。能力不明退回原有属性表，NO_COLOR / --no-style
// 优先于所有能力探测。linux 控制台只用标准 30–37 与粗体亮色，忽略继承的
// COLORTERM；依据 console_codes(4) 的 SGR 定义。颜色只加快识别，正文仍说明状态。
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

/** 按能力排序；第 4 级保留而不选中。 */
export const COLOR_TIERS: readonly string[] = ['全关', '黑白属性', '16 色', '256 色', 'truecolor（不开）']
export type ColorTier = 0 | 1 | 2 | 3

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
  overlayBody: 'body',
  waiting: 'waiting',
  read: 'body',
  readHeading: 'readHeading',
  hint: 'dim',
  ok: 'ok',
  refuse: 'refuse',
  hit: 'hit',
  user: 'readHeading',
  model: 'body',
  system: 'dim',
  instruction: 'overlay',
  plan: 'dim',
}

/**
 * 第 3 级：八格各一个 256 色索引。**取值按参照系选**（Textual 的设计语言 · Claude Code 与
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
 * 16 色档：标准前景色配属性，不发送 38;5 或 truecolor。
 * 正文、候选用宿主默认色；弱化保留原有属性档。亮色用粗体 + 基色，兼容内核控制台。
 */
export const SLOT_16: Readonly<Record<Slot, string>> = {
  ok: '\x1b[32m',
  refuse: '\x1b[1;31m',
  waiting: '\x1b[1;33m',
  dim: '\x1b[2m',
  body: '',
  readHeading: '\x1b[1;36m',
  overlay: '',
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
  // 新正文角色在未知色档延续原弹层属性；已知彩色档使用默认正文色。
  overlayBody: '\x1b[1m',
  // 第 1 级里它**与弹层同一条属性**：那一行从前报的就是 `overlay`，换成等待那一格之后**字节不变**
  // （地板逐字节锁着那条不动）。彩色档使用各自的等待色（`SLOT_16` / `SLOT_256`）。
  waiting: '\x1b[1m',
  readHeading: '\x1b[1m',
  ok: '\x1b[1m',
  refuse: '\x1b[1m',
  hit: '\x1b[1m',
}

/** 色位到角色共用这一次投影；空值不包 SGR。 */
function themeFrom(slots: Readonly<Record<Slot, string>>): Readonly<Partial<Record<LineRole, string>>> {
  const out: Partial<Record<LineRole, string>> = {}
  for (const role of Object.keys(ROLE_SLOT) as readonly LineRole[]) {
    const sgr = slots[ROLE_SLOT[role]]
    if (sgr !== '') out[role] = sgr
  }
  return out
}

export function theme16(): Readonly<Partial<Record<LineRole, string>>> { return themeFrom(SLOT_16) }
export type Background = 'light' | 'dark' | 'default'
/** COLORFGBG 的最后一格是宿主背景。只认明确的浅/深基础色；缺失或其他色保持中性。
 * 不向终端发背景探针，也不假设所有 256 色终端都用暗底。
 */
export function backgroundOf(colorFgBg?: string): Background {
  const last = colorFgBg?.split(';').at(-1)
  return last === '15' || last === '7' ? 'light' : last === '0' || last === '8' ? 'dark' : 'default'
}
export function theme256(background: Background = 'default'): Readonly<Partial<Record<LineRole, string>>> {
  if (background === 'default') return themeFrom(SLOT_256)
  const light = background === 'light'
  const result = themeFrom({ ...SLOT_256,
    dim: light ? '\x1b[38;5;239m' : '\x1b[38;5;245m',
    waiting: light ? '\x1b[38;5;130m' : SLOT_256.waiting,
    readHeading: light ? '\x1b[1;38;5;25m' : '\x1b[1;38;5;111m',
  })
  return { ...result, user: light ? '\x1b[1;38;5;25m' : '\x1b[1;38;5;111;48;5;235m' }
}

/**
 * 终端**自称**能上 256 色吗。`COLORTERM` 说 `256` / `truecolor` / `24bit`，或 `$TERM` 里带
 * `256color`，才算——认不得就退属性档（宪法：**不半上色**）。`truecolor` 那一声也收在这里：
 * 它声明的是"能上色"，落在第 3 级；真彩那一档暂不开。
 */
export function claims256(term: string | undefined, colorTerm: string | undefined): boolean {
  const c = (colorTerm ?? '').toLowerCase()
  const t = (term ?? '').toLowerCase()
  return c.includes('256') || c === 'truecolor' || c === '24bit' || t.includes('256color')
}

/** 先遵守全关，再尊重内核控制台的能力上限，最后探测模拟器。 */
export function tierOf(
  o: { noStyle?: boolean; noColor?: string | undefined; term?: string | undefined; colorTerm?: string | undefined; colorFgBg?: string | undefined } = {},
): ColorTier {
  if (o.noStyle === true) return 0
  if ((o.noColor ?? '') !== '') return 0
  const term = (o.term ?? '').toLowerCase()
  if (term === 'linux') return 2
  if (claims256(o.term, o.colorTerm)) return 3
  return term.endsWith('-16color') ? 2 : 1
}

/**
 * 给不给主题，给哪一档。`noColor` 是环境变量的**原值**：空串与未设一样算「没设」——
 * no-color.org 的口径是"非空才算喊了"。第 0 级给 `undefined`（= 没有主题，`openTerm` 不包一行）。
 */
export function themeOf(
  o: { noStyle?: boolean; noColor?: string | undefined; term?: string | undefined; colorTerm?: string | undefined; colorFgBg?: string | undefined } = {},
): Readonly<Partial<Record<LineRole, string>>> | undefined {
  const tier = tierOf(o)
  if (tier === 0) return undefined
  return tier === 3 ? theme256(backgroundOf(o.colorFgBg)) : tier === 2 ? theme16() : DEFAULT_THEME
}
