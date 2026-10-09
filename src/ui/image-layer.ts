// 图片与文字分层。这里只安排 Kitty 的位置与生命周期；缺省及未知能力保留文字。
// Sixel 尚无可靠的像素尺寸与退出清理证据，终端层暂不启用它。
import { createHash, randomInt } from 'node:crypto'
import { imageIsValid, imageSequence, clearImageSequence } from './image-codec.ts'
import type { PixelImage } from './image-codec.ts'
import type { GraphicsTier } from './image.ts'

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

/** 一个终端句柄占一个随机图片号；清理永远只针对自己，不动别的客户端。 */
export function openImageLayer(tier: GraphicsTier = 'none') {
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
      if (tier !== 'kitty' || next === undefined || !fits(next, frame)) return { before: clear(), after: '' }
      const p = next
      const signature = createHash('sha256').update(p.image.rgba)
        .update(`${p.image.width},${p.image.height},${p.row},${p.column},${p.columns},${p.rows}`).digest('hex')
      const repainted = frame.changed === null || frame.changed.slice(p.row, p.row + p.rows).some(Boolean)
      if (current?.signature === signature && !repainted) return { before: '', after: '' }
      const before = clear()
      const pixels = imageSequence(p.image, { id, columns: p.columns, rows: p.rows }, tier)
      if (pixels === '') return { before, after: '' }
      current = { signature, clear: clearImageSequence(p.image, id, tier) }
      const up = frame.cursorRow - p.row
      const move = `${up > 0 ? `\x1b[${up}A` : ''}\r${p.column > 0 ? `\x1b[${p.column}C` : ''}`
      // DECSC/DECRC 保存真实 caret；Kitty C=1 避免图片移动光标。
      return { before, after: `\x1b7${move}${pixels}\x1b8` }
    },
  }
}
