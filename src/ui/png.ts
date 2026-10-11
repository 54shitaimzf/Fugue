// 有界 PNG 静态预览，不执行文件内容。格式依据 https://www.w3.org/TR/png-3/。
// 支持所有静态颜色/位深组合；Adam7 暂退文字。忽略颜色配置，保留 PNG 的 RGB 样本。
import { inflateSync } from 'node:zlib'
import { fitPixels } from './pixels.ts'
import type { PixelImage } from './image-codec.ts'

export const MAX_PNG_BYTES = 8 * 1024 * 1024
const MAX_PNG_PIXELS = 16 * 1024 * 1024
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const DEPTHS: Readonly<Record<number, readonly number[]>> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i
  for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crcOf(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** 坏格式、过大、未知关键块、Adam7 或解压失败给 null，调用方继续显示路径。 */
export function decodePng(bytes: Uint8Array): PixelImage | null {
  if (bytes.length < 45 || bytes.length > MAX_PNG_BYTES) return null
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (!data.subarray(0, 8).equals(SIGNATURE)) return null
  let width = 0, height = 0, depth = 0, color = -1, ended = false, idatEnded = false
  let palette: Buffer | undefined, transparency: Buffer | undefined
  const parts: Buffer[] = []
  for (let at = 8; at < data.length;) {
    if (at + 12 > data.length) return null
    const length = data.readUInt32BE(at), end = at + 12 + length
    if (end > data.length) return null
    const type = data.toString('latin1', at + 4, at + 8), body = data.subarray(at + 8, end - 4)
    if (!/^[A-Za-z]{4}$/.test(type) || (data[at + 6]! & 32) !== 0) return null
    if (crcOf(data.subarray(at + 4, end - 4)) !== data.readUInt32BE(end - 4)) return null
    if (at === 8 && type !== 'IHDR') return null
    if (type === 'IHDR') {
      if (at !== 8 || length !== 13) return null
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]!; color = body[9]!
      if (width === 0 || height === 0 || width * height > MAX_PNG_PIXELS || !DEPTHS[color]?.includes(depth) ||
          body[10] !== 0 || body[11] !== 0 || body[12] !== 0) return null
    } else if (type === 'PLTE') {
      if (palette || parts.length > 0 || length === 0 || length % 3 !== 0 || length > 768 || color === 0 || color === 4) return null
      palette = body
    } else if (type === 'tRNS') {
      if (transparency || parts.length > 0 || color === 4 || color === 6 ||
          (color === 0 && length !== 2) || (color === 2 && length !== 6) ||
          (color === 3 && (!palette || length === 0 || length > palette.length / 3))) return null
      transparency = body
    } else if (type === 'IDAT') {
      if (idatEnded) return null
      parts.push(body)
    } else if (type === 'IEND') {
      if (length !== 0 || end !== data.length) return null
      ended = true; break
    } else if ((data[at + 4]! & 32) === 0) return null
    if (parts.length > 0 && type !== 'IDAT') idatEnded = true
    at = end
  }
  if (!ended || parts.length === 0 || (color === 3 && (!palette || palette.length / 3 > 2 ** depth))) return null
  const channels = CHANNELS[color]!, stride = Math.ceil(width * channels * depth / 8), bpp = Math.max(1, Math.ceil(channels * depth / 8))
  const expected = (stride + 1) * height
  let packed: Buffer
  try { packed = inflateSync(Buffer.concat(parts), { maxOutputLength: expected }) } catch { return null }
  if (packed.length !== expected) return null
  const raster = new Uint8Array(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = packed[y * (stride + 1)]!
    if (filter > 4) return null
    for (let x = 0; x < stride; x += 1) {
      const at = y * stride + x, a = x >= bpp ? raster[at - bpp]! : 0
      const b = y > 0 ? raster[at - stride]! : 0, c = y > 0 && x >= bpp ? raster[at - stride - bpp]! : 0
      const predict = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c)
      raster[at] = (packed[y * (stride + 1) + x + 1]! + predict) & 255
    }
  }
  const rgba = new Uint8Array(width * height * 4), max = 2 ** depth - 1
  function sample(y: number, n: number): number {
    const bit = n * depth, at = y * stride + Math.floor(bit / 8)
    return depth === 16 ? raster[at]! * 256 + raster[at + 1]! : depth === 8 ? raster[at]! : (raster[at]! >> (8 - depth - bit % 8)) & max
  }
  const byte = (n: number): number => Math.round(n * 255 / max)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const first = sample(y, x * channels)
    const at = (y * width + x) * 4
    rgba[at + 3] = 255
    if (color === 3) {
      const index = first
      if (!palette || index * 3 + 3 > palette.length) return null
      rgba.set(palette.subarray(index * 3, index * 3 + 3), at)
      rgba[at + 3] = transparency?.[index] ?? 255
    } else if (color === 0 || color === 4) {
      rgba.fill(byte(first), at, at + 3)
      if (color === 4) rgba[at + 3] = byte(sample(y, x * channels + 1))
      else if (transparency?.readUInt16BE(0) === first) rgba[at + 3] = 0
    } else {
      for (let c = 0; c < 3; c += 1) rgba[at + c] = byte(sample(y, x * channels + c))
      if (color === 6) rgba[at + 3] = byte(sample(y, x * channels + 3))
      else if (transparency && first === transparency.readUInt16BE(0) &&
        sample(y, x * channels + 1) === transparency.readUInt16BE(2) && sample(y, x * channels + 2) === transparency.readUInt16BE(4)) rgba[at + 3] = 0
    }
  }
  return fitPixels({ width, height, rgba }, width, height)
}
