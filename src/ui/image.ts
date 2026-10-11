// 图片能力按显式 auto 选择；不明能力、控制台与复用器退文字。
// 实际像素由阅读面按可见事件请求，终端层独立摆放与清理。
const GRAPHICS_TIERS = ['none', 'sixel', 'kitty'] as const

/** 探到的那一档（`none` = 这一台画不了图，或这一档被关了）。 */
export type GraphicsTier = (typeof GRAPHICS_TIERS)[number]

/** 缺省：**没有**（增强档不许改变缺省的字节流；产品路径 `ui/console.ts` 探一次再定）。 */
export const DEFAULT_GRAPHICS_TIER: GraphicsTier = 'none'

/** 那一格开关认的两个值。**不是三档**——人不必替终端去点 `sixel` / `kitty`。 */
export const IMAGE_SETTINGS = ['auto', 'off'] as const

export type ImageSetting = (typeof IMAGE_SETTINGS)[number]

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
  const term = (env.TERM ?? '').toLowerCase()
  const program = env.TERM_PROGRAM ?? ''
  if (env.TMUX || env.STY || /^(linux|screen|tmux)(?:[-.]|$)/.test(term)) return 'none'
  if ((env.KITTY_WINDOW_ID ?? '') !== '' || term.includes('kitty')) return 'kitty'
  if (program === 'kitty' || program === 'ghostty') return 'kitty'
  if (term.includes('sixel')) return 'sixel'
  if (program === 'WezTerm' || program === 'mintty') return 'sixel'
  return 'none'
}

/** 图位只在用户选择 auto 后探测；没有配置时保持完整的纯文字界面。 */
export function graphicsFor(setting: unknown, env: Readonly<Record<string, string | undefined>>): GraphicsTier {
  return setting === 'auto' ? graphicsOf(env) : DEFAULT_GRAPHICS_TIER
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
