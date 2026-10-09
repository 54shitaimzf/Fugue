// 图形协议的纯编码层：只收 RGBA 像素与已分配的位置；不读文件、不写终端。
// Kitty: https://sw.kovidgoyal.net/kitty/graphics-protocol/
// Sixel: DEC VT330/VT340 Programmer Reference, graphics chapter 14。
import type { GraphicsTier } from './image.ts'

export interface PixelImage {
  readonly width: number
  readonly height: number
  readonly rgba: Uint8Array
}

export interface ImagePlace {
  /** 非零的本客户端图片号；清理只针对这个号。 */
  readonly id: number
  readonly columns: number
  readonly rows: number
}

export const IMAGE_CHUNK_BYTES = 4096
export const MAX_IMAGE_PIXELS = 262_144

function positive(n: number): boolean { return Number.isSafeInteger(n) && n > 0 }
function valid(image: PixelImage): boolean {
  return positive(image.width) && positive(image.height) && image.width * image.height <= MAX_IMAGE_PIXELS &&
    image.rgba instanceof Uint8Array && image.rgba.length === image.width * image.height * 4
}
function validPlace(place: ImagePlace): boolean {
  return positive(place.id) && place.id <= 0xffffffff && positive(place.columns) && positive(place.rows)
}

/** 缺省关；坏输入给空串，让调用方保留文字原文。 */
export function imageSequence(image: PixelImage, place: ImagePlace, tier: GraphicsTier = 'none'): string {
  if (tier === 'none' || !valid(image) || !validPlace(place)) return ''
  if (tier === 'sixel') return sixelOf(image)
  if (tier !== 'kitty') return ''
  const payload = Buffer.from(image.rgba).toString('base64')
  const out: string[] = []
  for (let at = 0; at < payload.length; at += IMAGE_CHUNK_BYTES) {
    const more = at + IMAGE_CHUNK_BYTES < payload.length ? 1 : 0
    const head = at === 0
      ? `a=T,t=d,f=32,s=${image.width},v=${image.height},i=${place.id},c=${place.columns},r=${place.rows},C=1,q=2,`
      : 'q=2,'
    out.push(`\x1b_G${head}m=${more};${payload.slice(at, at + IMAGE_CHUNK_BYTES)}\x1b\\`)
  }
  return out.join('')
}

/** Kitty 释放本号；Sixel 用其已占像素矩形恢复宿主默认背景。 */
export function clearImageSequence(image: PixelImage, id: number, tier: GraphicsTier = 'none'): string {
  if (tier === 'none' || !valid(image) || !positive(id) || id > 0xffffffff) return ''
  if (tier === 'kitty') return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`
  if (tier === 'sixel') return `\x1bP0;0;0q"1;1;${image.width};${image.height}?\x1b\\`
  return ''
}

interface ColorCell { key: number; count: number; rgb: number[] }
interface ColorBox { cells: ColorCell[]; axis: number; score: number; weight: number }

function boxOf(cells: ColorCell[]): ColorBox {
  const low = [255, 255, 255], high = [0, 0, 0]
  let weight = 0
  for (const cell of cells) {
    weight += cell.count
    for (let c = 0; c < 3; c += 1) { low[c] = Math.min(low[c]!, cell.rgb[c]!); high[c] = Math.max(high[c]!, cell.rgb[c]!) }
  }
  const ranges = high.map((v, c) => v - low[c]!)
  const axis = ranges.indexOf(Math.max(...ranges))
  return { cells, axis, score: cells.length > 1 ? ranges[axis]! ** 2 * weight : 0, weight }
}

/** 少色图保留原色；多色图按加权中位切分到至多256格。半透明在 Sixel 上以128为界。 */
function paletteOf(image: PixelImage): { indexed: Int16Array; colors: readonly number[][] } {
  const { rgba, width, height } = image
  const exact = new Map<number, number>()
  for (let at = 0; at < rgba.length; at += 4) {
    if (rgba[at + 3]! < 128) continue
    const key = rgba[at]! * 65536 + rgba[at + 1]! * 256 + rgba[at + 2]!
    if (!exact.has(key)) exact.set(key, exact.size)
    if (exact.size > 256) break
  }
  const indexed = new Int16Array(width * height).fill(-1)
  if (exact.size <= 256) {
    const colors = [...exact.keys()].map(k => [k >> 16, (k >> 8) & 255, k & 255])
    for (let at = 0; at < rgba.length; at += 4) if (rgba[at + 3]! >= 128) {
      indexed[at / 4] = exact.get(rgba[at]! * 65536 + rgba[at + 1]! * 256 + rgba[at + 2]!)!
    }
    return { indexed, colors }
  }
  // 五位直方图限制分组内存；每格仍用原像素的均值，保留暗色的小差别。
  const keyAt = (at: number): number => (rgba[at]! >> 3) * 1024 + (rgba[at + 1]! >> 3) * 32 + (rgba[at + 2]! >> 3)
  const cells = new Map<number, ColorCell>()
  for (let at = 0; at < rgba.length; at += 4) if (rgba[at + 3]! >= 128) {
    const key = keyAt(at)
    let cell = cells.get(key)
    if (cell === undefined) { cell = { key, count: 0, rgb: [0, 0, 0] }; cells.set(key, cell) }
    cell.count += 1
    for (let c = 0; c < 3; c += 1) cell.rgb[c] = cell.rgb[c]! + rgba[at + c]!
  }
  for (const cell of cells.values()) cell.rgb = cell.rgb.map(n => n / cell.count)
  const boxes = [boxOf([...cells.values()])]
  while (boxes.length < 256) {
    let best = 0
    for (let i = 1; i < boxes.length; i += 1) if (boxes[i]!.score > boxes[best]!.score) best = i
    const box = boxes[best]!
    if (box.score === 0) break
    const sorted = box.cells.sort((a, b) => a.rgb[box.axis]! - b.rgb[box.axis]!)
    let weight = 0, cut = 0
    while (cut < sorted.length - 1 && weight < box.weight / 2) weight += sorted[cut++]!.count
    cut = Math.max(1, cut)
    boxes.splice(best, 1, boxOf(sorted.slice(0, cut)), boxOf(sorted.slice(cut)))
  }
  const lookup = new Map<number, number>()
  const colors = boxes.map((box, i) => {
    const rgb = [0, 0, 0]
    for (const cell of box.cells) {
      lookup.set(cell.key, i)
      for (let c = 0; c < 3; c += 1) rgb[c] = rgb[c]! + cell.rgb[c]! * cell.count
    }
    return rgb.map(n => Math.round(n / box.weight))
  })
  for (let at = 0; at < rgba.length; at += 4) if (rgba[at + 3]! >= 128) indexed[at / 4] = lookup.get(keyAt(at))!
  return { indexed, colors }
}

/** 连续相同列压成 !N 字符；短串原样，避免小图反而膨胀。 */
function runsOf(chars: string): string {
  let out = ''
  for (let at = 0; at < chars.length;) {
    let end = at + 1
    while (end < chars.length && chars[end] === chars[at]) end += 1
    out += end - at >= 4 ? `!${end - at}${chars[at]}` : chars.slice(at, end)
    at = end
  }
  return out
}

function sixelOf(image: PixelImage): string {
  const { width, height, rgba } = image
  const { indexed, colors } = paletteOf(image)
  const out = [`\x1bP0;1;0q"1;1;${width};${height}`]
  for (const [color, rgb] of colors.entries()) {
    out.push(`#${color};2;${rgb.map(n => Math.round(n * 100 / 255)).join(';')}`)
  }
  for (let y = 0; y < height; y += 6) {
    const band = new Set<number>()
    for (let i = y * width; i < Math.min(y + 6, height) * width; i += 1) if (indexed[i]! >= 0) band.add(indexed[i]!)
    for (const color of band) {
      let chars = ''
      for (let x = 0; x < width; x += 1) {
        let bits = 0
        for (let dy = 0; dy < 6 && y + dy < height; dy += 1) {
          if (indexed[(y + dy) * width + x] === color) bits |= 1 << dy
        }
        chars += String.fromCharCode(63 + bits)
      }
      out.push(`#${color}${runsOf(chars)}$`)
    }
    if (y + 6 < height) out.push('-')
  }
  out.push('\x1b\\')
  return out.join('')
}
