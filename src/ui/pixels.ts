// Pixel geometry is independent of terminal cursor and file decoding.
import { MAX_IMAGE_PIXELS } from './image-codec.ts'
import type { PixelImage } from './image-codec.ts'
import { MAX_CELL_PIXELS } from './cell-probe.ts'
import type { CellPixels } from './cell-probe.ts'

const positive = (n: number): boolean => Number.isSafeInteger(n) && n > 0

/** Area sampling with premultiplied alpha; keep ratio and cap output allocation. */
export function fitPixels(source: PixelImage, maxWidth: number, maxHeight: number, magnify = false): PixelImage | null {
  if (!positive(source.width) || !positive(source.height) || !Number.isSafeInteger(source.width * source.height) ||
      !(source.rgba instanceof Uint8Array) || source.rgba.length !== source.width * source.height * 4 ||
      !positive(maxWidth) || !positive(maxHeight)) return null
  const scale = Math.min(magnify ? Infinity : 1, maxWidth / source.width, maxHeight / source.height,
    Math.sqrt(MAX_IMAGE_PIXELS / (source.width * source.height)), MAX_IMAGE_PIXELS / source.width, MAX_IMAGE_PIXELS / source.height)
  const width = Math.max(1, Math.floor(source.width * scale)), height = Math.max(1, Math.floor(source.height * scale))
  if (width === source.width && height === source.height) return source
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const left = x * source.width / width, right = (x + 1) * source.width / width
    const top = y * source.height / height, bottom = (y + 1) * source.height / height
    const sum = [0, 0, 0]; let alpha = 0
    for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy += 1) for (let sx = Math.floor(left); sx < Math.ceil(right); sx += 1) {
      const weight = (Math.min(right, sx + 1) - Math.max(left, sx)) * (Math.min(bottom, sy + 1) - Math.max(top, sy))
      const at = (sy * source.width + sx) * 4, a = source.rgba[at + 3]! * weight
      alpha += a
      for (let c = 0; c < 3; c += 1) sum[c] = sum[c]! + source.rgba[at + c]! * a
    }
    const at = (y * width + x) * 4
    for (let c = 0; c < 3; c += 1) rgba[at + c] = alpha === 0 ? 0 : Math.round(sum[c]! / alpha)
    rgba[at + 3] = Math.round(alpha / ((right - left) * (bottom - top)))
  }
  return { width, height, rgba }
}

/** Sixel paints six-pixel bands; its entire footprint must stay in assigned cells and known host limits. */
export function fitSixel(source: PixelImage, place: { readonly columns: number; readonly rows: number }, cell: CellPixels | null | undefined, limits?: CellPixels): PixelImage | null {
  if (cell == null || !positive(cell.width) || !positive(cell.height) || cell.width > MAX_CELL_PIXELS || cell.height > MAX_CELL_PIXELS ||
      !positive(place.columns) || !positive(place.rows) ||
      (limits !== undefined && (!positive(limits.width) || !positive(limits.height)))) return null
  const width = Math.min(place.columns * cell.width, limits?.width ?? Infinity)
  const height = Math.floor(Math.min(place.rows * cell.height, limits?.height ?? Infinity) / 6) * 6
  if (!positive(width) || !positive(height)) return null
  return fitPixels(source, width, height, true)
}
