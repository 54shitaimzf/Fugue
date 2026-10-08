// 图片那一档（第二幕 ⑨ 的后一半）：**探测 + 文件名那一行 + 留白**——本站不落编码器（缓，§ 三 8：
// 等一条真实的图片需求）。文件名那一行本来就印在那几面上（账上的路径），这一档加的只是它后面
// 那块留白：图位先占住，画不画另说。
//
// **开关只有"全关"与"按探测"两种**（`ui.images: auto / off`）：两档全关时这一份一个字节都不印——
// 与"根本没有这一档"逐字节相同（地板不许因增强档变低）。
//
// **探测是环境变量那一路的近似，不是真问终端**：真探测要往终端发一条查询（DA1：`\x1b[c`）再等
// 回话，那一趟要接管输入那一层（超时窗口多长 · tmux 那一条透传链怎么转义——决策材料 § 六 那两条
// 都标着"未核"）。于是这里只认几个**终端自己报出来的**信号。**改主意的条件**＝真有一条图片需求
// 要它：那时把这一趟挪进 `ui/term.ts`（那里已经有 raw 模式与读回话那条路），这一份只留 `none`
// 那一档与"留白"那一段。
export const GRAPHICS_TIERS = ['none', 'sixel', 'kitty'] as const

/** 探到的那一档（`none` = 这一台画不了图，或这一档被关了）。 */
export type GraphicsTier = (typeof GRAPHICS_TIERS)[number]

/** 缺省：**没有**（增强档不许改变缺省的字节流；产品路径 `ui/console.ts` 探一次再定）。 */
export const DEFAULT_GRAPHICS_TIER: GraphicsTier = 'none'

/** 那一格开关认的两个值。**不是三档**——人不必替终端去点 `sixel` / `kitty`。 */
export const IMAGE_SETTINGS = ['auto', 'off'] as const

export type ImageSetting = (typeof IMAGE_SETTINGS)[number]

/** 留白留几行（图位占的地方）。**常量，可调**：三行够表意（再多也只是空着）。 */
export const IMAGE_RESERVE_ROWS = 3

/** 认得出是图的那些后缀（**闭表**：多一个就往这里添一行）。 */
export const IMAGE_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']

/**
 * 探一遍（`env` 是那一刻的环境，`process.env` 那一份）。
 *
 * 认的信号：**kitty 那一族**——`KITTY_WINDOW_ID`（它家自己的一个信号）· `TERM` 里带 `kitty`
 * （它以及它的派生，比如 ghostty 的 `xterm-kitty` 那一档）· `TERM_PROGRAM` 是 `kitty` / `ghostty`；
 * **sixel 那一族**——`TERM` 里带 `sixel`（mlterm 与 xterm 的 sixel 变体）· `TERM_PROGRAM` 是
 * `WezTerm` / `mintty`（这两家真支持 sixel）。其余一律 `none`——**认不出来就是没有**（图片这一档
 * 宁可少给：画不出来的终端上吐那几个字节是给屏幕添乱）。
 */
export function graphicsOf(env: Readonly<Record<string, string | undefined>>): GraphicsTier {
  const term = env.TERM ?? ''
  const program = env.TERM_PROGRAM ?? ''
  if ((env.KITTY_WINDOW_ID ?? '') !== '' || term.includes('kitty')) return 'kitty'
  if (program === 'kitty' || program === 'ghostty') return 'kitty'
  if (term.includes('sixel')) return 'sixel'
  if (program === 'WezTerm' || program === 'mintty') return 'sixel'
  return 'none'
}

/** 这条路径像不像图（按后缀；大小写不认）。 */
export function isImagePath(path: string): boolean {
  const low = path.toLowerCase()
  return IMAGE_EXTENSIONS.some((e) => low.endsWith(e))
}

let CURRENT: GraphicsTier = DEFAULT_GRAPHICS_TIER

/** 定档，把上一档还回去（与 `setIconTier` 同一手）。 */
export function setGraphics(tier: GraphicsTier): GraphicsTier {
  const was = CURRENT
  CURRENT = tier
  return was
}

/** 当前那一档。 */
export function graphics(): GraphicsTier {
  return CURRENT
}

/**
 * 一条路径后面那块留白：**档是 `none` · 路径不像图 · 就给空表**——一个字节都不占（"没有这一档"
 * 与"有这一档而这一条不是图"在输出上分得开：后者什么也不加）。
 *
 * 头一行说清楚**这是留白、不是图**：本站不编码（不读 PNG · 不量化 · 不写任何图形序列），所以
 * 印出来的只有这一句与底下那几行空的。名字取路径最后一段（全路径那一行本来就在上面）。
 */
export function imageRowsOf(path: string, tier: GraphicsTier = CURRENT): readonly string[] {
  if (tier === 'none' || !isImagePath(path)) return []
  const name = path.slice(path.lastIndexOf('/') + 1)
  const rows: string[] = [`  （${name}：这一台终端认 ${tier}，图位先留在这里——本站只探测不编码）`]
  for (let i = 0; i < IMAGE_RESERVE_ROWS; i += 1) rows.push('  ')
  return rows
}
