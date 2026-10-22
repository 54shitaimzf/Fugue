// 外观草稿（**素材，未接线**）· 图片：探测到支持才给，不支持只印文件名。
//
// 出处：ROADMAP § 5 的 0.4.3 行 ⑤「图片按终端图形协议（sixel · kitty graphics）探测到支持才给、
// 不支持不给图（文件名照旧）」。
//
// **地板就是文件名那一行**：`tier` 是 `none`（探测不到 · 不写 ANSI · `--no-style`），或者给了档却
// 拿不出能放的数据（不是 PNG · sixel 没编码好），出来的都是**只有说明行**的那一块——与「没有图片
// 这一档」逐字节相同（`look.test.ts` ⑥）。图是加在说明行**下面**的几行留白里的，说明行本身一个
// 字节都不因为有图而变。
//
// **这一份只出串，不写终端。**图怎么摆进 K 行面板是接线时的事，草稿把那几条约束写在这里留给它：
//
//   · 放图那一串带 `C=1`（kitty：放完光标不动）——`term.ts` 的光标算术（上移 · 退列）不用知道
//     这一行有图；
//   · 清行（`\x1b[2K`）不删 kitty 的图：面板重画到那几行变了，要先发 `kittyDeleteOf(id)`，再放新的；
//   · 宽度或行数变过（`term.ts` 走全量那一档）同样先删再放——图按格子摆，格子变了图就错位。
//
// **sixel 只判档、不编码**：sixel 要先把 PNG 解码成像素、再量化成调色板，这一份不带解码器（零依赖
// 之内写得出，但那是一站的活，不是草稿的）。所以 sixel 那一档要调用方递编码好的串进来；不递就是
// 文件名那一行。
import { iconOf } from './icons.ts'
import type { Line } from './paint.ts'
import { sp } from './paint.ts'
import type { IconTier, ImageTier } from './tier.ts'

/** PNG 的头八个字节。kitty 的 `f=100` 只收 PNG。 */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** kitty 一笔最多带多少 base64 字符（协议的上限）。 */
export const KITTY_CHUNK = 4096

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_MAGIC.length && PNG_MAGIC.every((b, i) => bytes[i] === b)
}

/**
 * 放一张 PNG（kitty graphics：`a=T` 传完就放 · `f=100` PNG · `t=d` 数据就在串里 · `q=2` 不回话 ·
 * `C=1` 光标不动 · `c`/`r` 占几列几行）。base64 按 `KITTY_CHUNK` 分笔，`m=1` 说后面还有。
 */
export function kittyPlaceOf(png: Uint8Array, o: { readonly id: number; readonly cols: number; readonly rows: number }): string {
  const b64 = Buffer.from(png).toString('base64')
  const parts: string[] = []
  for (let i = 0; i < b64.length; i += KITTY_CHUNK) parts.push(b64.slice(i, i + KITTY_CHUNK))
  if (parts.length === 0) parts.push('')
  return parts
    .map((chunk, i) => {
      const more = i < parts.length - 1 ? 1 : 0
      const head = i === 0 ? `a=T,f=100,t=d,i=${o.id},c=${o.cols},r=${o.rows},C=1,q=2,m=${more}` : `m=${more}`
      return `\x1b_G${head};${chunk}\x1b\\`
    })
    .join('')
}

/** 删掉那一张（连数据一起：`d=I`）。重画那几行之前发它。 */
export function kittyDeleteOf(id: number): string {
  return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`
}

/** sixel 串的外形（DCS … `q` … ST）。草稿只认外形，不解码。 */
function isSixel(s: string): boolean {
  return /^\x1bP[0-9;]*q[\s\S]*\x1b\\$/.test(s)
}

/** 说明行：图标 · 文件名。**地板就是这一行。** */
export function captionOf(name: string, icons: IconTier): Line {
  return [iconOf('image', icons), sp(' '), sp(name)]
}

export interface ImageBlock {
  /** 说明行 + 给图留的几行空白（地板那一档只有说明行）。 */
  readonly rows: readonly Line[]
  /** 光标落在留白第一行行首时写的那一串；地板那一档是 `null`。 */
  readonly place: string | null
}

/** 一块图。给了档、也拿得出能放的数据，才多出留白与放图那一串；否则就是说明行。 */
export function imageBlockOf(o: {
  readonly name: string
  readonly tier: ImageTier
  readonly icons: IconTier
  readonly png?: Uint8Array | undefined
  readonly sixel?: string | undefined
  readonly cols: number
  readonly rows: number
  readonly id: number
}): ImageBlock {
  const caption = captionOf(o.name, o.icons)
  const blank = (): Line[] => Array.from({ length: Math.max(1, o.rows) }, () => [sp('')])
  if (o.tier === 'kitty' && o.png !== undefined && isPng(o.png)) {
    return { rows: [caption, ...blank()], place: kittyPlaceOf(o.png, { id: o.id, cols: o.cols, rows: Math.max(1, o.rows) }) }
  }
  if (o.tier === 'sixel' && o.sixel !== undefined && isSixel(o.sixel)) {
    return { rows: [caption, ...blank()], place: o.sixel }
  }
  return { rows: [caption], place: null }
}
