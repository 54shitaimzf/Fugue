import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import zlib from 'node:zlib'
import { syncBuiltinESMExports } from 'node:module'
import { decodePng, MAX_PNG_BYTES } from './png.ts'
import { MAX_IMAGE_PIXELS } from './image-codec.ts'
const fixtures = JSON.parse(readFileSync(new URL('./png-fixtures.json', import.meta.url), 'utf8')) as {
  valid: { name: string; png: string; width: number; height: number; rgba?: string; solid?: number[] }[]
  invalid: { name: string; png: string }[]
  paddingCrc: number
}

test('PNG colors, depths, filters and split IDAT reproduce independently authored RGBA', () => {
  let pixels = 0
  for (const c of fixtures.valid.filter(c => c.rgba)) {
    const actual = decodePng(Buffer.from(c.png, 'base64'))
    assert.ok(actual, c.name)
    assert.equal(actual.width, c.width, c.name); assert.equal(actual.height, c.height, c.name)
    assert.deepEqual(Buffer.from(actual.rgba), Buffer.from(c.rgba!, 'base64'), c.name)
    pixels += actual.width * actual.height
  }
  console.log(`PNG: 15 color/depth combinations × filters 0..4; ${pixels} pixels, RGBA differences=0`)
})

test('large and one-pixel-wide PNG stay bounded; area average preserves thin detail and alpha edges', () => {
  for (const c of fixtures.valid.filter(c => c.solid)) {
    const actual = decodePng(Buffer.from(c.png, 'base64'))
    assert.ok(actual, c.name)
    assert.equal(actual.width, c.width, c.name); assert.equal(actual.height, c.height, c.name)
    assert.ok(actual.width * actual.height <= MAX_IMAGE_PIXELS, c.name)
    for (let at = 0; at < actual.rgba.length; at += 4) {
      assert.equal(actual.rgba[at], c.solid![0], c.name); assert.equal(actual.rgba[at + 1], c.solid![1], c.name)
      assert.equal(actual.rgba[at + 2], c.solid![2], c.name); assert.equal(actual.rgba[at + 3], c.solid![3], c.name)
    }
  }
  console.log('PNG: 1024²→512² checker average=128; transparent blue does not pollute red; 1×524289→1×262144')
})

test('corruption, over-expansion, unsupported formats and size limits return text fallback', () => {
  for (const c of fixtures.invalid) assert.equal(decodePng(Buffer.from(c.png, 'base64')), null, c.name)
  assert.equal(decodePng(new Uint8Array()), null)
  assert.equal(decodePng(new Uint8Array(MAX_PNG_BYTES + 1)), null)
  assert.equal(decodePng(Buffer.from('<svg onload="code()"></svg>')), null)
  console.log(`PNG fallback: ${fixtures.invalid.length} malformed/unsupported samples + empty/size/SVG; no throw`)
})


test('resource ceilings stop oversized files before parsing and bound inflation to known scanlines', () => {
  const source = Buffer.from(fixtures.valid.find(c => c.name.startsWith('color-6-depth-8'))!.png, 'base64')
  const padding = Buffer.alloc(MAX_PNG_BYTES + 12)
  padding.writeUInt32BE(MAX_PNG_BYTES); padding.write('tEXt', 4); padding.writeUInt32BE(fixtures.paddingCrc, padding.length - 4)
  const oversized = Buffer.concat([source.subarray(0, -12), padding, source.subarray(-12)])
  assert.equal(decodePng(oversized), null, 'a valid PNG with too much ancillary data still hits the byte ceiling')
  const original = zlib.inflateSync, limits: number[] = []
  try {
    zlib.inflateSync = ((bytes, options) => {
      limits.push(options?.maxOutputLength ?? 0)
      return original(bytes, options)
    }) as typeof zlib.inflateSync
    syncBuiltinESMExports()
    assert.equal(decodePng(Buffer.from(fixtures.invalid.find(c => c.name === 'huge-dimensions')!.png, 'base64')), null)
    assert.deepEqual(limits, [], 'dimension ceiling rejects before any decompression')
    assert.ok(decodePng(source))
    assert.deepEqual(limits, [145], '7×5 RGBA8 has exactly five 29-byte scanlines, including filter bytes')
  } finally { zlib.inflateSync = original; syncBuiltinESMExports() }
  console.log('PNG: byte ceiling 8MiB; source ceiling 16Mi pixels before inflate; 7×5 RGBA8 inflate ceiling=145')
})
