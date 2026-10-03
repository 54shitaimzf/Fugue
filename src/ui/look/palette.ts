// 外观草稿（**素材，未接线**）· 语义色位：八格定死 · 角色 → 颜色只住这一处。
//
// 出处：ROADMAP § 5 的 0.4.3 行 ①②（外观那批的规格，2026-10-02 定稿）。这一份是那一行的**素材**，
// 不是实现：生产路径上没有一处 import 它（`look.test.ts` ① 钉着这一条——要接线是 0.4.3 的事，
// 而 256 色还在架构 § 9.8「定义里永远不做」那张单子上，开口按 0.4.1 的批）。
//
// **八格是语义，不是样子**：「候选/弹层」与「命中行」在两档里都是粗——样子相同，语义不同，所以是
// 两格。反过来，**同一个样子不许兼两个语义**（「同义不许混用」）：绿只说成功，红只说拒绝/错误，
// 黄只说等待/运行中。diff 的增删行因此**不**上绿红——那是「加了 · 删了」，不是「成了 · 错了」。
//
// **三档，一张表**：
//
//   · `off`——`--no-style` · `NO_COLOR` 非空 · 不是 TTY · `$TERM` 认不出：一个 SGR 都不写。
//     这一档画出来的字节与「根本没有色位这回事」逐字节相同（`paint.test.ts` ②）。
//   · `mono`——黑白属性档（地板）：只用粗（`1`）与暗（`2`）两个属性。终端认不得 256 色就落在这里，
//     Linux 的字符控制台（`TERM=linux`）也在这里——见 `tier.ts` 头注那一条请示。
//   · `256`——`COLORTERM`/`TERM` 认得 256 色才上。索引按参照系（Textual 的设计语言）挑，
//     **再加一道可证伪的约束**：每个上色的格在纯黑底与纯白底上的对比度都 ≥ 3（WCAG 对界面
//     元素的那一档）。理由是背景色探测要一趟往返（OSC 11），草稿不做探测——那就只挑在两种底上
//     都读得清的那几格，深色主题与浅色主题一份表。`palette.test.ts` ③ 拿 xterm 256 色的公式现算。
//
// **为什么不用 0–15 那几格**（`\x1b[32m` 那一族）：那十六格跟着终端主题走，Solarized 深色的
// 「亮黑」恰好就是背景色——弱化那一格会整个看不见。16–255 是固定值，跟着主题走的只剩缺省前景。
import type { LineRole } from '../frame.ts'

/** 八格（规格 ② 的次序）。 */
export type Slot = 'ok' | 'bad' | 'wait' | 'muted' | 'body' | 'heading' | 'overlay' | 'hit'

/** 三档。 */
export type ColorTier = 'off' | 'mono' | '256'

/** 三档的次序（由低到高）。`PALETTES` 的键序不可靠（`'256'` 像整数，JS 把它排在最前）。 */
export const COLOR_TIERS: readonly ColorTier[] = ['off', 'mono', '256']

/** 一档的表：每一格一段 SGR（空串 = 这一格不包，原样印）。 */
export type Palette = Readonly<Record<Slot, string>>

/**
 * 每一格**说的是什么**（规格 ② 原文），连同它在 256 色档里该落在哪一族色相上。测试拿 `family`
 * 核 256 档的索引真落在那一族里（`palette.test.ts` ②）——换一个索引的人改不动语义。
 */
export const SLOT_MEANING: Readonly<Record<Slot, { readonly says: string; readonly family: string }>> = {
  ok: { says: '成功', family: 'green' },
  bad: { says: '拒绝/错误', family: 'red' },
  wait: { says: '等待/运行中', family: 'yellow' },
  muted: { says: '弱化（框线 · 脚注 · 截断标记）', family: 'brightBlack' },
  body: { says: '正文', family: 'default' },
  heading: { says: '阅读面标题', family: 'blue+bold' },
  overlay: { says: '候选/弹层', family: 'bold' },
  hit: { says: '命中行', family: 'bold' },
}

/** 八格，次序照规格。**从 `SLOT_MEANING` 推**，不另写一遍。 */
export const SLOTS: readonly Slot[] = Object.keys(SLOT_MEANING) as Slot[]

const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const fg = (n: number): string => `\x1b[38;5;${n}m`

/**
 * **角色 → 颜色的唯一一处。**三档各一行，八格一格不缺（`palette.test.ts` ① 从这张表推格名）。
 *
 * 256 档的五个索引（参照系 Textual：success `#4EBF71` · error `#ba3c5b` · warning `#ffa62b` ·
 * primary `#0178D4`；在「黑白两种底上对比度都 ≥ 3」之内取色相最近、最像那个颜色名的一格）：
 *
 *   · 成功 `28`（`#008700`，黑底 4.47 · 白底 4.70）——`71` 更像 Textual，白底只有 2.70，落选；
 *   · 拒绝/错误 `167`（`#d75f5f`，5.69 · 3.69）——`161` 色相更近，可它读起来是品红，不是「红」；
 *   · 等待/运行中 `136`（`#af8700`，6.29 · 3.34）——`214` 那种亮橙在白底上 1.84，看不见；
 *   · 弱化 `244`（`#808080`，5.32 · 3.95）——就是 xterm 缺省「亮黑」那个灰，只是钉成固定值；
 *   · 阅读面标题 `32`（`#0087d7`，5.45 · 3.86）+ 粗——几乎就是 Textual 的 primary。
 *
 * `mono` 那一行：弱化=暗 · 标题/弹层/命中=粗 · **拒绝/错误=粗**（没有颜色时错要靠粗把人叫住；
 * 成功与等待在这一档靠字与标记说，不靠属性）· 其余原样。
 */
export const PALETTES: Readonly<Record<ColorTier, Palette>> = {
  off: { ok: '', bad: '', wait: '', muted: '', body: '', heading: '', overlay: '', hit: '' },
  mono: { ok: '', bad: BOLD, wait: '', muted: DIM, body: '', heading: BOLD, overlay: BOLD, hit: BOLD },
  '256': {
    ok: fg(28),
    bad: fg(167),
    wait: fg(136),
    muted: fg(244),
    body: '',
    heading: `\x1b[1;38;5;32m`,
    overlay: BOLD,
    hit: BOLD,
  },
}

/**
 * 0.2.8 那几种**行角色**落在哪一格（整行一个角色的那一层——`frame.ts` 报的 `roles`）。
 *
 * **账尾是这张表里唯一一处请示**：规格 ② 的八格没有点名账尾。0.2.8 U3 把它整行加粗；草稿把它
 * 拆成「状态标记（成功/等待/错误三格之一）+ 正文」（`layout.ts` 的 `FooterInput`）——与
 * Claude Code 底部那一行同形：颜色落在标记上，字是正文。于是整行那一层它落 `body`，`palette.test.ts`
 * ④ 把「只有账尾与 0.2.8 不同」这件事明着钉出来，而不是让它悄悄漂。
 */
export const LINE_SLOT: Readonly<Record<LineRole, Slot>> = {
  border: 'muted',
  body: 'body',
  footer: 'body',
  overlay: 'overlay',
  read: 'body',
  readHeading: 'heading',
}
