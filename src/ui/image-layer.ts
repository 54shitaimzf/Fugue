// 图片与文字分层。Kitty 按号收回；Sixel 在调用方保证的固定几何内只擦自己的字格。
// Sixel 需要已核对的字符像素与调色板容量；终端接线仍须解决尺寸变化，缺省及未知能力保留文字。
import { createHash, randomInt } from 'node:crypto'
import { imageIsValid, imageSequence, clearImageSequence } from './image-codec.ts'
import type { PixelImage } from './image-codec.ts'
import type { GraphicsTier } from './image.ts'
import { fitSixel } from './pixels.ts'
import type { SixelCells } from './cell-probe.ts'

export interface PanelImage {
  readonly image: PixelImage
  /** 相对面板顶的单元格位置，0 基；图片必须完整落在面板内。 */
  readonly row: number
  readonly column: number
  readonly columns: number
  readonly rows: number
}

interface ImageFrame {
  readonly columns: number
  readonly height: number
  readonly cursorRow: number
  /** null 表示全量重画；否则逐行指出是否擦过。 */
  readonly changed: readonly boolean[] | null
}

function fits(p: PanelImage, f: ImageFrame): boolean {
  return [p.row, p.column, p.columns, p.rows].every(Number.isSafeInteger) && p.row >= 0 && p.column >= 0 &&
    p.columns > 0 && p.rows > 0 && p.row + p.rows <= f.height && p.column + p.columns <= f.columns && imageIsValid(p.image)
}

function atPicture(command: string, p: PanelImage, cursorRow: number): string {
  const up = cursorRow - p.row
  const move = `${up > 0 ? `\x1b[${up}A` : ''}\r${p.column > 0 ? `\x1b[${p.column}C` : ''}`
  return `\x1b7${move}${command}\x1b8`
}

/** ECH erases graphics and restores the real terminal background, without adding a bitmap. */
function eraseSixel(p: PanelImage, cursorRow: number): string {
  const rows = Array.from({ length: p.rows }, () => `\x1b[${p.columns}X`).join('\x1b[1B')
  return atPicture(rows, p, cursorRow)
}

/** Kitty owns one random ID. Sixel needs verified cells and known fixed geometry. */
export function openImageLayer(tier: GraphicsTier = 'none', cellPixels?: () => SixelCells | null) {
  const id = tier === 'kitty' ? randomInt(1, 0x100000000) : 0
  let current: { signature: string; clear: string } | undefined
  function clear(): string {
    const command = current?.clear ?? ''
    current = undefined
    return command
  }
  return {
    clear,
    update(next: PanelImage | undefined, frame: ImageFrame): { before: string; after: string } {
      if ((tier !== 'kitty' && tier !== 'sixel') || next === undefined || !fits(next, frame)) return { before: clear(), after: '' }
      const p = next
      const cell = tier === 'sixel' ? cellPixels?.() : undefined
      if (tier === 'sixel' && (cell == null || !Number.isSafeInteger(cell.colors) || cell.colors < 2 || cell.colors > 256)) return { before: clear(), after: '' }
      const signature = createHash('sha256').update(p.image.rgba)
        .update(`${p.image.width},${p.image.height},${p.row},${p.column},${p.columns},${p.rows},${cell?.width ?? ""},${cell?.height ?? ""},${cell?.colors ?? ""}`).digest('hex')
      const repainted = frame.changed === null || frame.changed.slice(p.row, p.row + p.rows).some(Boolean)
      if (current?.signature === signature && !repainted) return { before: '', after: '' }
      const before = clear()
      const scaled = tier === 'sixel' ? fitSixel(p.image, p, cell) : p.image
      if (scaled === null) return { before, after: '' }
      const pixels = imageSequence(scaled, { id: tier === 'sixel' ? 1 : id, columns: p.columns, rows: p.rows, colors: cell?.colors }, tier)
      if (pixels === '') return { before, after: '' }
      current = { signature, clear: tier === 'sixel' ? eraseSixel({ ...p, image: scaled }, frame.cursorRow) : clearImageSequence(p.image, id, tier) }
      // DECSC/DECRC keeps the actual input caret; Kitty also uses C=1.
      return { before, after: atPicture(pixels, p, frame.cursorRow) }
    },
  }
}
