// TUI 的量尺：**一个串占几列 · 在哪断开**，外加**字形档**（哪几个字形许印）。这一份是从 `ui/frame.ts` 拆出来的——那里原先的
// 注释写过触发条件：「长到几十行就该单独一份文件（`ui/glyph.ts`）」，现在长到了。
//
// 一把尺，处处共用：`frame.ts` 折行与补宽 · `term.ts` 输入行光标回退 · `input.ts` 簇级编辑 ·
// `gate.ts` 折行 · `read.ts`/`queue.ts`/`nav.ts`/`keymap.ts` 截断与对齐。尺只有一份，量出来的
// 列宽才处处是同一个数——第二把尺就是第二份真相。
//
// 三条不许破的性质（原样从 `frame.ts` 带过来）：
//
//   · **纯**：同一个串调两次，逐字节相同——不读终端、不看时刻；
//   · **按串记住**（`CLUSTERS`）：一帧里同一个串要被问好几次（截 · 折 · 量列宽），每帧重算是白烧。
//     表里存的只是纯函数对同一个输入的答案，所以这不改任何输出；
//   · **近似是声明过的**：UAX #29 那张表是几百段，整张抄进来就是一份会漂的第二份真相；收的是
//     终端上真会出现的那几段。表外的组合符号会被当成独立的字——多占一列。**什么条件下改主意**：
//     真遇到表外的（那种字真落进输入行，而不只是印出来），就换 `Intl.Segmenter`，或者把这张表
//     按需要长出来。

/**
 * **字形档三档**（宪法 0.4.3 行 ⑥ · 施工单 § 五 ⑤）。地板 = 内核内建 ∩ console-setup 那一撮
 * （单双线框 22 个 · `░▒█` · `←↑↓→` · `▶` · `•` · ASCII；进出名单与读数在
 * `docs/0.4.3-survey-decisions.md` § 5.4）。
 *
 *   · `ascii`：**只印 ASCII**——最恶劣的字体那一档（`mark` 三列 `...`，框用 `+ - |`）；
 *   · `box`（**缺省**）：交集里那一撮。**成员表是闭的**：这一档印出去的每一个非 ASCII 字形
 *     都在下面 `GLYPHS.box` 里有名字——`glyph-tier.test.ts` ② 拿真画出来的帧量这一条；
 *   · `rich`：交集之外那些（`▸` `┈` `●` `⇒` …），**只由配置开关点名**（`ui.glyphs`）。
 *
 * **管得着的那一层**：字形档管的是**渲染那一层**的结构字形（框线 · 标记 · 箭头 · 条形）——
 * 面板里那些字。**值层的读数原文不在其中**：状态图那几行（`⇒` `×` 那些）是 `StatusSnapshot.edges`
 * 的原文，它进 `--json`，换字形就是改值层（宪法：账上的原话与 `--json` 字段名一个字不动）。
 */
export const GLYPH_TIERS = ['ascii', 'box', 'rich'] as const

/** 三档里的哪一档。 */
export type GlyphTier = (typeof GLYPH_TIERS)[number]

/** 缺省那一档（交集）。 */
export const DEFAULT_GLYPH_TIER: GlyphTier = 'box'

/**
 * 一档里那几格字形。**键是"这一格是什么意思"，值是那一个字形**——名字一处，三档各一个值，
 * 于是"同一格在三档里换了个样子"是看得见的一件事。
 */
export interface GlyphSet {
  /** 框线：横 · 竖 · 四角 · 上中 · 下中 · 左中 · 右中。 */
  readonly h: string
  readonly v: string
  readonly tl: string
  readonly tj: string
  readonly tr: string
  readonly bl: string
  readonly bj: string
  readonly br: string
  readonly ml: string
  readonly mj: string
  readonly mr: string
  /** 截断与折叠标记（④「全站一个口径」）。**它的列宽也住在这里**（`markWidthOf`）。 */
  readonly mark: string
  /** 选中那一行前面那一个。 */
  readonly sel: string
  /** 翻页提示里那两个。 */
  readonly up: string
  readonly down: string
  /** 小条形那四格：空 · 低 · 中 · 高（`░▒█` 三档 + 一个空格位）。 */
  readonly spark: readonly [string, string, string, string]
}

/**
 * 三档那一张表。`box` 那一列**每一个成员都在交集里**（ASCII 与那 22 个框线 · `░▒█` · `↑↓` ·
 * `▶`）；`mark` 是宪法 ⑥ 点名的一处例外（它写的就是「`box` 档 `…` 一列」）——`…` 按 § 5.4 那份
 * 名单落在"console-setup 才有"那一栏，这一处按宪法走，理由与改主意的条件记在停点报告里。
 */
export const GLYPHS: Readonly<Record<GlyphTier, GlyphSet>> = {
  ascii: {
    h: '-', v: '|',
    tl: '+', tj: '+', tr: '+',
    bl: '+', bj: '+', br: '+',
    ml: '+', mj: '+', mr: '+',
    mark: '...',
    sel: '>',
    up: '^', down: 'v',
    spark: [' ', '.', '+', '#'],
  },
  box: {
    h: '─', v: '│',
    tl: '┌', tj: '┬', tr: '┐',
    bl: '└', bj: '┴', br: '┘',
    ml: '├', mj: '┴', mr: '┤',
    mark: '…',
    sel: '▶',
    up: '↑', down: '↓',
    spark: [' ', '░', '▒', '█'],
  },
  rich: {
    h: '─', v: '│',
    tl: '┌', tj: '┬', tr: '┐',
    bl: '└', bj: '┴', br: '┘',
    ml: '├', mj: '┴', mr: '┤',
    mark: '…',
    sel: '▸',
    up: '↑', down: '↓',
    spark: [' ', '░', '▒', '█'],
  },
}

/** 某一档那一份字形。 */
export function glyphsOf(tier: GlyphTier): GlyphSet {
  return GLYPHS[tier]
}

/**
 * 截断与折叠标记占几列（`ascii` 档 `...` 三列 · `box` 档 `…` 一列）。**从档里那一个字符串量**，
 * 不另记一个数——数与字形是同一件事的两面，分开写就会走岔。
 */
export function markWidthOf(tier: GlyphTier): number {
  return widthOf(GLYPHS[tier].mark)
}

/**
 * **当前这一档**。它是一份**进程级的显示设置**，不是每帧的数据：这一次运行里档不会变，而
 * `clip` 这类函数在一帧里要被叫上百次——把它当参数一路递下去要穿过八个模块（列宽 · 折行 ·
 * 截断三处都得知道），换来的只是"同一个值换个传递方式"。
 *
 * **纯度那条性质照旧**：同一个串 + 同一档，调两次逐字节相同（`setGlyphTier` 只该被两处调——
 * 产品路径一次：`ui/console.ts` 按开关与配置定档；断言里各档各设一次、用完还原）。
 * 缺省 `box`：**没有设过就是缺省那一档**，与"根本没有这一档"这件事无关（那是 `ascii`。
 */
let CURRENT: GlyphTier = DEFAULT_GLYPH_TIER

/** 定档，把上一档还回去（断言里拿它还原；产品路径只调一次）。 */
export function setGlyphTier(tier: GlyphTier): GlyphTier {
  const was = CURRENT
  CURRENT = tier
  return was
}

/** 当前那一档。 */
export function glyphTier(): GlyphTier {
  return CURRENT
}

/** 当前那一档的字形。 */
export function glyphs(): GlyphSet {
  return GLYPHS[CURRENT]
}

/** 一个**簇**：人眼算一个字的那些 code unit（基字符 + 跟在它身上的组合符号 · 变体选择符 · ZWJ 那几段）。 */
export interface Cluster {
  /** 簇里的原文（一个字节不改）。 */
  readonly text: string
  /** 在这一行里的起止（`[start, end)`，code unit 偏移）。 */
  readonly start: number
  readonly end: number
  /** 占几列。 */
  readonly width: number
}

/** 东亚宽字符那几段（连 emoji）。**近似**：`⇒` 这类 Ambiguous 按 Unicode 缺省算一列。 */
function isWide(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff)
  )
}

/**
 * 零宽那些段：组合符号 · 变体选择符 · 肤色修饰 · 连接符（ZWJ）。
 *
 * **近似**：UAX #29 那张表是几百段，整张抄进来就是一份会漂的第二份真相；这里收的是终端上真会
 * 出现的那几段（印出来的字、还有输入行里打进去的字）。表外的组合符号会被当成独立的字——多占一列。
 * **什么条件下改主意**：真遇到表外的（那种字真落进输入行，而不只是印出来），就换
 * `Intl.Segmenter`，或者把这张表按需要长出来。
 */
const ZERO: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf], [0x05c1, 0x05c2], [0x05c4, 0x05c5],
  [0x05c7, 0x05c7], [0x0610, 0x061a], [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e4],
  [0x06e7, 0x06e8], [0x06ea, 0x06ed], [0x0711, 0x0711], [0x0730, 0x074a], [0x07a6, 0x07b0], [0x07eb, 0x07f3],
  [0x0816, 0x0819], [0x081b, 0x0823], [0x0825, 0x0827], [0x0829, 0x082d], [0x0859, 0x085b], [0x08d3, 0x08e1],
  [0x08e3, 0x0903], [0x093a, 0x093c], [0x093e, 0x094f], [0x0951, 0x0957], [0x0962, 0x0963], [0x0981, 0x0983],
  [0x09bc, 0x09bc], [0x09be, 0x09cd], [0x09d7, 0x09d7], [0x09e2, 0x09e3], [0x0a01, 0x0a03], [0x0a3c, 0x0a3c],
  [0x0a3e, 0x0a4d], [0x0a51, 0x0a51], [0x0a70, 0x0a71], [0x0a75, 0x0a75], [0x0a81, 0x0a83], [0x0abc, 0x0abc],
  [0x0abe, 0x0acd], [0x0ae2, 0x0ae3], [0x0b01, 0x0b03], [0x0b3c, 0x0b3c], [0x0b3e, 0x0b57], [0x0b62, 0x0b63],
  [0x0b82, 0x0b82], [0x0bbe, 0x0bcd], [0x0bd7, 0x0bd7], [0x0c00, 0x0c04], [0x0c3e, 0x0c56], [0x0c62, 0x0c63],
  [0x0c81, 0x0c83], [0x0cbc, 0x0cbc], [0x0cbe, 0x0cd6], [0x0ce2, 0x0ce3], [0x0d00, 0x0d03], [0x0d3b, 0x0d3c],
  [0x0d3e, 0x0d4d], [0x0d57, 0x0d57], [0x0d62, 0x0d63], [0x0d81, 0x0d83], [0x0dca, 0x0dca], [0x0dcf, 0x0dd6],
  [0x0dd8, 0x0ddf], [0x0df2, 0x0df3], [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x0eb1, 0x0eb1],
  [0x0eb4, 0x0ebc], [0x0ec8, 0x0ecd], [0x0f18, 0x0f19], [0x0f35, 0x0f35], [0x0f37, 0x0f37], [0x0f39, 0x0f39],
  [0x0f3e, 0x0f3f], [0x0f71, 0x0f84], [0x0f86, 0x0f87], [0x0f8d, 0x0f97], [0x0f99, 0x0fbc], [0x0fc6, 0x0fc6],
  [0x102b, 0x103e], [0x1056, 0x1059], [0x105e, 0x1060], [0x1062, 0x1064], [0x1067, 0x106d], [0x1071, 0x1074],
  [0x1082, 0x108d], [0x108f, 0x108f], [0x109a, 0x109d], [0x135d, 0x135f], [0x1712, 0x1715], [0x1732, 0x1734],
  [0x1752, 0x1753], [0x1772, 0x1773], [0x17b4, 0x17d3], [0x17dd, 0x17dd], [0x180b, 0x180d], [0x1885, 0x1886],
  [0x18a9, 0x18a9], [0x1920, 0x192b], [0x1930, 0x193b], [0x1a17, 0x1a1b], [0x1a55, 0x1a5e], [0x1a60, 0x1a7c],
  [0x1a7f, 0x1a7f], [0x1ab0, 0x1aff], [0x1b00, 0x1b04], [0x1b34, 0x1b44], [0x1b6b, 0x1b73], [0x1b80, 0x1b82],
  [0x1ba1, 0x1bad], [0x1be6, 0x1bf3], [0x1c24, 0x1c37], [0x1cd0, 0x1cd2], [0x1cd4, 0x1ce8], [0x1ced, 0x1ced],
  [0x1cf4, 0x1cf4], [0x1cf7, 0x1cf9], [0x1dc0, 0x1dff], [0x200d, 0x200d], [0x20d0, 0x20f0], [0x2cef, 0x2cf1],
  [0x2d7f, 0x2d7f], [0x2de0, 0x2dff], [0x302a, 0x302f], [0x3099, 0x309a], [0xa66f, 0xa672], [0xa674, 0xa67d],
  [0xa69e, 0xa69f], [0xa6f0, 0xa6f1], [0xa802, 0xa802], [0xa806, 0xa806], [0xa80b, 0xa80b], [0xa823, 0xa827],
  [0xa880, 0xa881], [0xa8b4, 0xa8c5], [0xa8e0, 0xa8f1], [0xa926, 0xa92d], [0xa947, 0xa953], [0xa980, 0xa983],
  [0xa9b3, 0xa9c0], [0xa9e5, 0xa9e5], [0xaa29, 0xaa36], [0xaa43, 0xaa43], [0xaa4c, 0xaa4d], [0xaa7b, 0xaa7d],
  [0xaab0, 0xaab0], [0xaab2, 0xaab4], [0xaab7, 0xaab8], [0xaabe, 0xaabf], [0xaac1, 0xaac1], [0xaaeb, 0xaaef],
  [0xaaf5, 0xaaf6], [0xabe3, 0xabea], [0xabec, 0xabed], [0xfb1e, 0xfb1e], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
  [0x101fd, 0x101fd], [0x102e0, 0x102e0], [0x10376, 0x1037a], [0x10a01, 0x10a0f], [0x10a38, 0x10a3f],
  [0x10ae5, 0x10ae6], [0x11000, 0x11002], [0x11038, 0x11046], [0x1107f, 0x11082], [0x110b0, 0x110ba],
  [0x11100, 0x11102], [0x11127, 0x11134], [0x11145, 0x11146], [0x11173, 0x11173], [0x11180, 0x11182],
  [0x111b3, 0x111c0], [0x1122c, 0x11237], [0x112df, 0x112ea], [0x11300, 0x11303], [0x1133b, 0x1134d],
  [0x11357, 0x11357], [0x11362, 0x11374], [0x114b0, 0x114c3], [0x115af, 0x115c0], [0x16af0, 0x16af4],
  [0x16b30, 0x16b36], [0x16f51, 0x16f92], [0x1bc9d, 0x1bc9e], [0x1d165, 0x1d169], [0x1d16d, 0x1d182],
  [0x1d185, 0x1d18b], [0x1d1aa, 0x1d1ad], [0x1d242, 0x1d244], [0x1da00, 0x1da36], [0x1da3b, 0x1da6c],
  [0x1da75, 0x1da75], [0x1da84, 0x1da84], [0x1da9b, 0x1daa1], [0x1daa9, 0x1daad], [0x1e000, 0x1e02a],
  [0x1e8d0, 0x1e8d6], [0x1e944, 0x1e94a], [0x1f3fb, 0x1f3ff], [0xe0100, 0xe01ef],
]

function isZero(c: number): boolean {
  for (const [lo, hi] of ZERO) if (c >= lo && c <= hi) return true
  return false
}

/** 区域指示符：一对拼成一面旗（两列）。 */
function isRegional(c: number): boolean {
  return c >= 0x1f1e6 && c <= 0x1f1ff
}

/**
 * 一行切成**簇**。一个簇 = 基字符 + 挂在它身上的那些（组合符号 · 变体选择符 · 肤色修饰 ·
 * ZWJ 后面那一个，一对区域指示符算一个）。于是"左移一格"对 `e` + U+0301 是一步而不是两步，
 * 对一串 ZWJ 连起来的 emoji（一家三口那种）也是一步。
 *
 * **按串记住**（`CLUSTERS`）：一帧里同一个串要被问好几次（截 · 折 · 量列宽），每帧重算是白烧。
 * 表里存的只是纯函数对同一个输入的答案，所以这不改任何输出。
 */
const CLUSTERS = new Map<string, readonly Cluster[]>()
const CLUSTERS_MAX = 512

export function clustersOf(s: string): readonly Cluster[] {
  const hit = CLUSTERS.get(s)
  if (hit !== undefined) return hit
  const out: Cluster[] = []
  let i = 0
  while (i < s.length) {
    const start = i
    const base = s.codePointAt(i) as number
    i += base > 0xffff ? 2 : 1
    let flags = isRegional(base) ? 1 : 0
    while (i < s.length) {
      const next = s.codePointAt(i) as number
      if (next === 0x200d && i + 1 < s.length) {
        i += 1
        i += (s.codePointAt(i) as number) > 0xffff ? 2 : 1
        continue
      }
      if (isZero(next)) {
        i += next > 0xffff ? 2 : 1
        continue
      }
      if (flags === 1 && isRegional(next)) {
        i += 2
        flags = 2
        continue
      }
      break
    }
    const wide = isWide(base) || isRegional(base)
    out.push({ text: s.slice(start, i), start, end: i, width: isZero(base) ? 0 : wide ? 2 : 1 })
  }
  if (CLUSTERS.size >= CLUSTERS_MAX) CLUSTERS.clear()
  CLUSTERS.set(s, out)
  return out
}

/**
 * 一个串占几列（**显示列**）。按簇算：`e` + U+0301 是一列（组合符号零宽），`中文abc` 是七列，
 * 一串 ZWJ 连起来的 emoji（一家三口那种）是两列。`⇒` 那类 Ambiguous 按 Unicode 缺省算一列（见 `isWide`）。
 */
export function widthOf(s: string): number {
  let n = 0
  for (const c of clustersOf(s)) n += c.width
  return n
}

/**
 * 前 `w` 列切在几个 code unit 上（**整簇**切：不会把一个字的基字符与它身上的组合符号切成两半）。
 * 一个簇都放不下（`w` 比整簇还窄）时切一个整簇，免得调用方原地打转；`w <= 0` 切 0。
 */
export function cutAt(s: string, w: number): number {
  if (w <= 0) return 0
  let used = 0
  let n = 0
  for (const c of clustersOf(s)) {
    if (used + c.width > w) break
    used += c.width
    n = c.end
  }
  if (n === 0) n = clustersOf(s)[0]?.end ?? 0
  return n
}

/**
 * 按列宽截断：切在**簇**边界上，末尾留下当前字形档的截断标记（`ascii` 档 `...` 三列 ·
 * `box` 档 `…` 一列）。**标记与它的列宽都从那一档取**（`glyphs().mark` 与 `widthOf`），
 * 所以换档只换那几格字，行的列宽与折行点一个不变。
 */
export function clip(s: string, w: number): string {
  if (w <= 0) return ''
  if (widthOf(s) <= w) return s
  const mark = glyphs().mark
  const mw = widthOf(mark)
  if (w <= mw) return mark
  let out = ''
  let used = 0
  for (const c of clustersOf(s)) {
    if (used + c.width > w - mw) break
    out += c.text
    used += c.width
  }
  return `${out}${mark}`
}

/**
 * 折行：把一行按列宽切成几段。**整词放得下就切在词尾**；放不下那个字符落在词中间时，退到
 * **最后一个空格**（宁可这一行短一点，也不把词切成两半——`cacheWrite` 切在中间没人看得懂）。
 * 一整段连一个空格都没有时就是硬切：**一个字都不许少**。
 *
 * 为什么是折而不是截：宽了就把一行切掉半截，等于**静默少印**——读面不许这样。折行之后一个
 * 字节都不少，只有屏幕**矮**的时候才截（那时末行会说还剩几行）。断点落在 ` · ` 前半截时，
 * 下一行会从 `· ` 开头（读起来像漏了半句）——把那个分隔符吃掉再起；吃掉的只是标点。
 */
export function wrap(s: string, w: number): readonly string[] {
  if (w <= 0 || widthOf(s) <= w) return [s]
  const out: string[] = []
  let rest = s
  while (widthOf(rest) > w) {
    // 切点：下一个簇放不下而它是个空格（或者到头了），就切在 `cutAt` 给的那个位置——那正好是一个
    // 词的末尾；放不下的那个簇落在词中间时退到最后一个空格。一个簇都放不下时切一个整簇，免得
    // 原地打转（`cutAt` 已经保证整簇切）。
    let cut = cutAt(rest, w)
    const next = rest[cut]
    if (next !== undefined && next !== ' ') {
      const sp = rest.lastIndexOf(' ', cut)
      if (sp > 0) cut = sp
    }
    if (cut <= 0) cut = clustersOf(rest)[0]?.end ?? 1
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
    if (rest.startsWith('· ')) rest = rest.slice(2)
  }
  if (rest !== '') out.push(rest)
  return out
}
