// 外观草稿（**素材，未接线**）· 三样探测：上不上色 · 图标用哪套字形 · 给不给图。
//
// 出处：ROADMAP § 5 的 0.4.3 行 ①（256 色档 + 两级地板）与 ⑤（图标与图片是探测驱动的增强档）。
//
// **这一份只判，不问。**问终端（写一串查询、等它回话）是 IO，要超时、要从按键流里把回话摘出来——
// 那是 0.4.3 接线时终端那一层的事。这里收的是**已经拿到的答案**（环境变量的原值 · 回话的原文），
// 判出一档。所以三样都是纯函数：同一份答案两次判，逐字节相同。
//
// **地板不因增强档变低**（规格 ⑤ 末句）：三样各自有一档「什么都不加」——`off` / `ascii` / `none`
// ——探测不到、开关没开、`--no-style`，都落在那一档；那一档的输出与「没有这一档」逐字节同形
// （`look.test.ts` ③–⑥ 那几条负对照）。
//
// **请示一条（`TERM=linux`）**：Linux 的字符控制台（没有窗口系统的那一档）认 16 色，3.16 起还把
// `38;5;n` 就近折成 16 色。规格的判据是「认得 256 色才上色」，所以这一份照规格把它判进黑白属性档
// ——那一档在控制台上是正常且好看的（暗 · 粗两个属性控制台都认）。要不要为它单开一个 16 色档，
// 是规格层面的事，草稿不擅开。
import { ansiOf } from '../term.ts'
import { themeOf } from '../theme.ts'
import type { ColorTier } from './palette.ts'

/**
 * 认得 256 色的 `$TERM`：**后缀**一条规则（`-256color` · `-256colour` · `-direct`，后面还可以跟
 * `-bce` 一类修饰），再加几个**总是**有 256 色、却不在名字里说的终端（前缀，与 `KNOWN_TERM`
 * 同一种判法）。表外的就是黑白档——认不出来就退，不试。
 */
export const TERM_256_PREFIX: readonly string[] = [
  'xterm-kitty',
  'xterm-ghostty',
  'ghostty',
  'alacritty',
  'wezterm',
  'foot',
  'contour',
]

/** `COLORTERM` 的这两个值说的是 24 位色（它包含 256 色）。别的值（`yes` · `rxvt-xpm`）不算。 */
export const COLORTERM_DEEP: readonly string[] = ['truecolor', '24bit']

/** 终端那几样环境的**原值**（`process.env` 那几栏 · `stdout.isTTY` · 开关表里的 `--no-style`）。 */
export interface ColorEnv {
  readonly isTTY?: boolean | undefined
  readonly term?: string | undefined
  readonly colorTerm?: string | undefined
  readonly noColor?: string | undefined
  readonly noStyle?: boolean | undefined
}

/** 这一份环境认不认得 256 色（不管门开没开——门在 `colorTierOf` 里）。 */
export function knows256(term: string | undefined, colorTerm: string | undefined): boolean {
  if (COLORTERM_DEEP.includes((colorTerm ?? '').toLowerCase())) return true
  const t = (term ?? '').toLowerCase()
  if (/-(256colou?r|direct)(-|$)/.test(t)) return true
  return TERM_256_PREFIX.some((p) => t.startsWith(p))
}

/**
 * 上色那一档。**两道门复用生产那一份**（`theme.ts` 的 `themeOf`：`--no-style` 与 `NO_COLOR` 非空），
 * 写不写 ANSI 复用 `term.ts` 的 `ansiOf`（不是 TTY · `$TERM` 认不出 → 一个字节的 ANSI 都不写）——
 * 判据各只有一处，草稿不抄第二份。
 */
export function colorTierOf(e: ColorEnv): ColorTier {
  if (themeOf({ noStyle: e.noStyle, noColor: e.noColor }) === undefined) return 'off'
  if (e.isTTY !== true || !ansiOf(e.term)) return 'off'
  return knows256(e.term, e.colorTerm) ? '256' : 'mono'
}

/** 图标那两套字形：Nerd Font 一类专有字体的字形，或同义的 ASCII。 */
export type IconTier = 'nerd' | 'ascii'

/**
 * 图标那一档。**字体在不在场探测不了**（终端不报字体），所以只认配置开关：值恰好是 `nerd` 才给，
 * 别的（没配 · 拼错 · 别的值）一律 ASCII。`--no-style` 也退到 ASCII——那个开关的意思是「全无
 * 样式那一档」，专有字形属于样式。`NO_COLOR` 只管颜色，不动字形。
 */
export function iconTierOf(o: { readonly icons?: string | undefined; readonly noStyle?: boolean | undefined }): IconTier {
  if (o.noStyle === true) return 'ascii'
  return o.icons === 'nerd' ? 'nerd' : 'ascii'
}

/** 图片那一档：kitty graphics · sixel · 不给。 */
export type ImageTier = 'kitty' | 'sixel' | 'none'

/**
 * 两条查询（**写不写、等多久不在这里**）。kitty 文档推荐的问法：先发一条只查询不显示的图形命令
 * （`a=q`），紧跟一条 DA1——不认 kitty 图形的终端只回 DA1，于是不用干等超时就知道答案。
 */
export const KITTY_QUERY = '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\'
export const DA1_QUERY = '\x1b[c'

/**
 * 图片那一档，从**回话原文**判。`kittyReply` 是终端对 `KITTY_QUERY` 的回话（没回是 `null`），
 * `da1` 是对 `DA1_QUERY` 的回话（`ESC [ ? 62 ; 4 ; 22 c` 那种：参数里有 `4` 就是认 sixel）。
 *
 * 不写 ANSI 的那一档（`ansi` 为假）与 `--no-style` 一律不给——图是增强档，不是地板。
 * kitty 优先：它收 PNG 原样（`f=100`），不用在这一头解码；sixel 要先解码再量化成调色板，草稿
 * 只判出这一档、不带编码器（`image.ts` 头注）。
 */
export function imageTierOf(o: {
  readonly ansi: boolean
  readonly noStyle?: boolean | undefined
  readonly kittyReply?: string | null | undefined
  readonly da1?: string | null | undefined
}): ImageTier {
  if (!o.ansi || o.noStyle === true) return 'none'
  if (typeof o.kittyReply === 'string' && /\x1b_Gi=31;OK\x1b\\/.test(o.kittyReply)) return 'kitty'
  const m = typeof o.da1 === 'string' ? /\x1b\[\?([0-9;]*)c/.exec(o.da1) : null
  if (m !== null && (m[1] as string).split(';').includes('4')) return 'sixel'
  return 'none'
}
