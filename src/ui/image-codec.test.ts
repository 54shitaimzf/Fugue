// 解码器按线协议独立重建像素，既不 import 编码器内部函数，也不抄它的循环。
import assert from 'node:assert/strict'
import test from 'node:test'
import { imageSequence, clearImageSequence, MAX_IMAGE_PIXELS } from './image-codec.ts'
import type { PixelImage } from './image-codec.ts'

const place = { id: 77, columns: 24, rows: 8 }
function fixture(width: number, height: number): PixelImage {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const at = (y * width + x) * 4
    rgba.set([x % 6 * 51, y % 6 * 51, (x + y) % 6 * 51, (x + y) % 7 ? 255 : 0], at)
  }
  return { width, height, rgba }
}

/** 流式解释六像素列；扩展色定义、换色、重复、回行、换带各自消费一条 token。 */
export function decodeSixel(raw: string): PixelImage {
  const m = /^\x1bP0;1;0q"1;1;(\d+);(\d+)([\s\S]*)\x1b\\$/.exec(raw)
  assert.ok(m, 'Sixel 外壳与透明背景')
  const width = Number(m[1]), height = Number(m[2]), rgba = new Uint8Array(width * height * 4)
  const palette = new Map<number, number[]>()
  let x = 0, y = 0, color = 0
  const tokens = m[3]!.match(/#\d+(?:;2;\d+;\d+;\d+)?|!\d+[?-~]|[?$\-@-~]/g) ?? []
  assert.equal(tokens.join(''), m[3], '所有字节都落在合法 Sixel token 中')
  for (const token of tokens) {
    if (token[0] === '#') {
      const nums = token.slice(1).split(';').map(Number)
      color = nums[0]!
      if (nums.length > 1) palette.set(color, nums.slice(2).map(n => Math.round(n * 255 / 100)))
    } else if (token === '$') x = 0
    else if (token === '-') { y += 6; x = 0 }
    else {
      const repeat = token[0] === '!' ? Number(token.slice(1, -1)) : 1
      const bits = token.charCodeAt(token.length - 1) - 63
      for (let n = 0; n < repeat; n += 1, x += 1) for (let bit = 0; bit < 6; bit += 1) {
        if (bits & (1 << bit)) {
          assert.ok(x < width && y + bit < height, '不能越出声明矩形')
          rgba.set([...palette.get(color)!, 255], ((y + bit) * width + x) * 4)
        }
      }
    }
  }
  return { width, height, rgba }
}

test('Kitty 分块不超过4096，最后一块才完成；RGBA逐字节，安静且不移光标，清理只删本号', () => {
  const image = fixture(32, 32)
  const raw = imageSequence(image, place, 'kitty')
  const parts = [...raw.matchAll(/\x1b_G([^;]+);([A-Za-z0-9+/=]*)\x1b\\/g)]
  assert.equal(parts.length, 2)
  assert.equal(parts.map(p => p[0]).join(''), raw)
  assert.equal(parts[0]![1], 'a=T,t=d,f=32,s=32,v=32,i=77,c=24,r=8,C=1,q=2,m=1')
  assert.equal(parts[1]![1], 'q=2,m=0')
  assert.ok(parts.every(p => p[2]!.length <= 4096 && p[2]!.length % 4 === 0))
  assert.deepEqual(Buffer.from(parts.map(p => p[2]).join(''), 'base64'), Buffer.from(image.rgba))
  assert.equal(clearImageSequence(image, 77, 'kitty'), '\x1b_Ga=d,d=I,i=77,q=2\x1b\\')
  console.log(`Kitty：${image.width}×${image.height} · 2块 ${parts.map(p => p[2]!.length).join('/')} · 像素差0 · C=1/q=2 · 删除id77`)
})

test('Sixel 独立解码：跨6像素带、最后不足6行、透明像素与压缩重复均保真', () => {
  for (const [width, height] of [[1, 1], [1, 7], [19, 13], [64, 8]]) {
    const image = fixture(width!, height!)
    const decoded = decodeSixel(imageSequence(image, place, 'sixel'))
    for (let at = 0; at < image.rgba.length; at += 4) {
      const expected = image.rgba[at + 3] === 0 ? [0, 0, 0, 0] : Array.from(image.rgba.slice(at, at + 4))
      assert.deepEqual(Array.from(decoded.rgba.slice(at, at + 4)), expected, `像素 ${at / 4}`)
    }
  }
  const solid = { width: 64, height: 7, rgba: new Uint8Array(64 * 7 * 4).fill(255) }
  const raw = imageSequence(solid, place, 'sixel')
  assert.ok(raw.includes('!64~'), '完整带压缩')
  assert.ok(raw.includes('!64@'), '末行只有第一个 bit')
  assert.deepEqual(decodeSixel(raw).rgba, solid.rgba)
  assert.equal(clearImageSequence(solid, 77, 'sixel'), '\x1bP0;0;0q"1;1;64;7?\x1b\\')
  console.log('Sixel：1×1 / 1×7 / 19×13 / 64×8逐像素差0 · 64×7压缩与尾带差0 · 清理P2=0')
})

test('Sixel 按图片选色：少色暗图不变蓝，多色渐变≤256色且平均误差≤8', () => {
  const dark = { width: 2, height: 1, rgba: new Uint8Array([15,20,32,255,32,41,60,255]) }
  const darkDecoded = decodeSixel(imageSequence(dark, place, 'sixel'))
  for (let i = 0; i < dark.rgba.length; i += 1) assert.ok(Math.abs(dark.rgba[i]! - darkDecoded.rgba[i]!) <= 1)
  const rgba = new Uint8Array(32 * 32 * 4)
  for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) rgba.set([x*8,y*8,(x+y)*4,255], (y*32+x)*4)
  const raw = imageSequence({ width:32, height:32, rgba }, place, 'sixel')
  const defs = [...raw.matchAll(/#\d+;2;/g)]
  assert.ok(defs.length > 1 && defs.length <= 256)
  const decoded = decodeSixel(raw).rgba
  const meanError = rgba.reduce((sum, n, i) => sum + (i % 4 === 3 ? 0 : Math.abs(n - decoded[i]!)), 0) / (32*32*3)
  assert.ok(meanError <= 8, `平均通道误差 ${meanError}`)
  console.log(`Sixel自选色盘：暗图最大误差1 · 1024色渐变→${defs.length}色 · 平均通道误差${meanError.toFixed(3)}`)
})

test('全关、不支持和坏图退回空串，不能把半份协议写给文字界面', () => {
  const image = fixture(2, 2)
  assert.equal(imageSequence(image, place), '')
  assert.equal(clearImageSequence(image, 77), '')
  for (const tier of ['kitty', 'sixel'] as const) {
    for (const bad of [{ ...image, width: 0 }, { ...image, height: NaN }, { ...image, width: MAX_IMAGE_PIXELS + 1 }, { ...image, rgba: new Uint8Array(1) }]) assert.equal(imageSequence(bad, place, tier), '')
    for (const bad of [{ ...place, id: 0 }, { ...place, id: 0x100000000 }, { ...place, columns: -1 }, { ...place, rows: 1.2 }]) assert.equal(imageSequence(image, bad, tier), '')
    assert.equal(clearImageSequence(image, 0, tier), '')
  }
})
