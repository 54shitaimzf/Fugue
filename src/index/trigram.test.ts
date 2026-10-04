// trigram postings 的判据：**键控 blob id · 只出候选 · 顺序号由内容定**。
// 出处：ROADMAP § 4 的 0.3.1 行「trigram postings 键控 blob id」· TARGETS `T16` ②。
// 跑法：cd ~/fugue && node --test src/index/trigram.test.ts
//
//   ① 记录级往返：编出来再读回来，blob 表与每个 gram 的候选集一模一样
//   ② **候选集对照全扫**：语料里出现过的每一个三字组，索引给的候选集与"逐份字节扫一遍"逐字节相同
//      对手：收尾边界写错的构建器（`i < n-3` 而不是 `i <= n-3`——最后那一个三字组整批丢掉）·
//      差分解码错一位的解码器
//   ③ 边界与去重：恰好三个字节的 blob · 短于三个字节的 blob · 同一份内容出现两次 · 输入顺序
//      对手：按"喂进来的第几条"发顺序号的构建器（同一组内容换个顺序就编出另一份工件）
//   ④ 选择性：`countOf` 只看字典就答得出，且与候选集长度恒等
//      对手：把计数与 postings 分开维护、会各自漂的第二份
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { SECTION, decodeIndexHeader, sectionBody, sectionRefOf } from './format.ts'
import {
  GRAM_RECORD_BYTES,
  buildTrigram,
  decodeGramRecord,
  decodeTrigram,
  encodeBlobTable,
  encodeGramRecord,
  encodeTrigram,
  findGram,
  gramRecordOffset,
  indexOfParts,
} from './trigram.ts'
import type { BlobBytes, Trigram } from './trigram.ts'

const bytesOf = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'))

const blobOf = (text: string): BlobBytes => {
  const bytes = bytesOf(text)
  return { id: createHash('sha256').update(bytes).digest('hex'), bytes }
}

/** 字节里第 i 位起的三字节 → 那个 24 位的键（与 `trigram.ts` 同一套位序）。 */
const gramAt = (bytes: Uint8Array, i: number): Trigram => ((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]) >>> 0

/** 纯 ASCII 的三个字符走这一条（三字节的 UTF-8 与 UTF-16 单元在这里同值；非 ASCII 走 `gramAt`）。 */
const gramOf = (s: string): Trigram => gramAt(bytesOf(s), 0)

/** 一份确定性的语料：手写的几份 + 一串伪随机（同一颗种子量出来就是同一份）。 */
function corpus(): BlobBytes[] {
  const out: BlobBytes[] = [
    blobOf('export function lineWindow(bytes, offset, limit) {'),
    blobOf('postings 键控 blob id —— 一处真相'),
    blobOf('abc'),
    blobOf('ab'),
    blobOf(''),
    blobOf('abcdef'),
  ]
  let s = 20261004 >>> 0
  const next = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s
  }
  for (let i = 0; i < 18; i++) {
    const n = 8 + (next() % 120)
    let text = ''
    for (let k = 0; k < n; k++) text += String.fromCharCode(32 + (next() % 40))
    out.push(blobOf(text))
  }
  return out
}

/** 全扫那一侧：这份内容里含不含这个三字组。 */
function containsGram(bytes: Uint8Array, gram: Trigram): boolean {
  const needle = Buffer.from([(gram >>> 16) & 0xff, (gram >>> 8) & 0xff, gram & 0xff])
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(needle) !== -1
}

/** 一个三字组在这份语料里**真正**出现在哪些 blob 里（按 id 升序）。 */
function bruteSet(blobs: readonly BlobBytes[], gram: Trigram): string[] {
  return blobs
    .filter((b) => containsGram(b.bytes, gram))
    .map((b) => b.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** 一份工件里某一节的节体（按节表的偏移算术取，不重跑一遍编码）。 */
function sectionOf(encoded: Uint8Array, kind: number): Uint8Array {
  const header = decodeIndexHeader(encoded)
  assert.notEqual(header, null)
  const ref = sectionRefOf(header!, kind)
  assert.notEqual(ref, null)
  const body = sectionBody(encoded, ref!)
  assert.notEqual(body, null)
  return body!
}

// ── ① 记录级往返 ───────────────────────────────────────────────────────────

test('① 记录级往返：编出来再读回来，blob 表与每个 gram 的候选集一模一样', () => {
  const blobs = corpus()
  const built = buildTrigram(blobs)
  const back = decodeTrigram(encodeTrigram(built))
  assert.notEqual(back, null)
  assert.deepEqual(back!.blobIds, [...built.blobIds])
  assert.equal(back!.blobIds.length, new Set(blobs.map((b) => b.id)).size)
  assert.equal(back!.gramCount, built.grams.length)
  for (const g of built.grams) {
    assert.deepEqual(back!.candidatesOf(g.gram), g.ordinals.map((i) => built.blobIds[i]))
  }
})

test('① postings 是升序去重的，blob 表是升序的', () => {
  const built = buildTrigram(corpus())
  assert.deepEqual([...built.blobIds].sort(), [...built.blobIds])
  assert.ok(built.grams.length > 500, `语料太小，遮不住边界：${built.grams.length} 个三字组`)
  for (const g of built.grams) {
    for (let i = 1; i < g.ordinals.length; i++) assert.ok(g.ordinals[i] > g.ordinals[i - 1])
  }
})

// ── ② 候选集对照全扫 ───────────────────────────────────────────────────────

test('② 候选集对照全扫：语料里出现过的每一个三字组，候选集与逐份字节扫出来的相同', () => {
  const blobs = corpus()
  const index = decodeTrigram(encodeTrigram(buildTrigram(blobs)))
  assert.notEqual(index, null)
  const grams = new Set<Trigram>()
  for (const b of blobs) {
    for (let i = 0; i + 3 <= b.bytes.byteLength; i++) {
      grams.add(((b.bytes[i] << 16) | (b.bytes[i + 1] << 8) | b.bytes[i + 2]) >>> 0)
    }
  }
  assert.ok(grams.size > 500, `语料太小，遮不住边界：${grams.size} 个三字组`)
  let checked = 0
  for (const gram of grams) {
    const truth = bruteSet(blobs, gram)
    assert.deepEqual(index!.candidatesOf(gram), truth, `三字组 ${gram} 的候选集对不上全扫`)
    assert.equal(index!.countOf(gram), truth.length)
    checked += 1
  }
  assert.equal(checked, grams.size)
  // 没见过的那一侧：语料里没有的三字组给空候选（不是"随便给一份"）。
  const absent = gramOf('\u0001\u0002\u0003')
  assert.deepEqual(index!.candidatesOf(absent), [])
  assert.equal(index!.countOf(absent), 0)
})

// ── ③ 边界与去重 ───────────────────────────────────────────────────────────

test('③ 恰好三个字节的 blob：那唯一一个三字组必须被收录（收尾边界）', () => {
  const only = blobOf('abc')
  const index = decodeTrigram(encodeTrigram(buildTrigram([only])))
  assert.notEqual(index, null)
  assert.deepEqual(index!.candidatesOf(gramOf('abc')), [only.id])
  assert.equal(index!.countOf(gramOf('abc')), 1)
})

test('③ 短于三个字节的 blob：在 blob 表里，但不带任何 posting', () => {
  const index = decodeTrigram(encodeTrigram(buildTrigram([blobOf(''), blobOf('a'), blobOf('ab')])))
  assert.notEqual(index, null)
  assert.equal(index!.blobIds.length, 3)
  assert.equal(index!.gramCount, 0)
})

test('③ 同一份内容给了两次：一个顺序号、一条 posting', () => {
  const one = blobOf('重复的内容 repeated')
  const index = decodeTrigram(encodeTrigram(buildTrigram([one, one, one])))
  assert.notEqual(index, null)
  assert.equal(index!.blobIds.length, 1)
  // **键是字节**：这份内容里第一个三字节窗口从 UTF-8 的头一个字节起，不从字符起。
  assert.deepEqual(index!.candidatesOf(gramAt(one.bytes, 0)), [one.id])
  assert.equal(index!.countOf(gramAt(one.bytes, 0)), 1)
})

test('③ 输入顺序不动工件：同一组 (id, 字节) 换个顺序喂，编出来的逐字节相同', () => {
  const blobs = corpus()
  const forward = encodeTrigram(buildTrigram(blobs))
  const backward = encodeTrigram(buildTrigram([...blobs].reverse()))
  const rotated = encodeTrigram(buildTrigram([...blobs.slice(7), ...blobs.slice(0, 7)]))
  assert.deepEqual(forward, backward)
  assert.deepEqual(forward, rotated)
})

test('③ 同一个 id 两份不同字节：当场抛，不静默取先到的那一份', () => {
  const a = blobOf('第一份')
  const bent: BlobBytes = { id: a.id, bytes: bytesOf('第二份') }
  assert.throws(() => buildTrigram([a, bent]), /同一个 blob id 给了两份不同的字节/)
})

// ── ④ 选择性 ───────────────────────────────────────────────────────────────

test('④ 选择性：countOf 只看字典就答得出——postings 那一节空着也照答', () => {
  const built = buildTrigram(corpus())
  const encoded = encodeTrigram(built)
  // 只把 blob 表与字典交出去：postings 给一段空字节。计数若住在 postings 里，这一条当场红。
  const dictOnly = indexOfParts(sectionOf(encoded, SECTION.blobs), sectionOf(encoded, SECTION.dict), new Uint8Array(0))
  assert.notEqual(dictOnly, null)
  for (const g of built.grams) {
    assert.equal(dictOnly!.countOf(g.gram), g.ordinals.length)
    // 候选集要走 postings，空着就没有候选——两件事在这一条里分开量。
    assert.deepEqual(dictOnly!.candidatesOf(g.gram), [])
  }
  const whole = decodeTrigram(encoded)
  assert.notEqual(whole, null)
  for (const g of built.grams) assert.equal(whole!.countOf(g.gram), whole!.candidatesOf(g.gram).length)
})

test('④ 字典定宽：第 k 条记录就在 k × 20，二分查找按它走', () => {
  const rows = [7, 100, 5000].map((gram, i) => ({ gram, count: i + 1, offset: i * 4, length: 4 }))
  const dict = new Uint8Array(rows.length * GRAM_RECORD_BYTES)
  rows.forEach((r, i) => dict.set(encodeGramRecord(r), gramRecordOffset(i)))
  assert.deepEqual(decodeGramRecord(dict, gramRecordOffset(1)), rows[1])
  assert.equal(findGram(dict, 5000)?.count, 3)
  assert.equal(findGram(dict, 101), null)
  assert.equal(GRAM_RECORD_BYTES, 20)
  assert.equal(gramRecordOffset(3), 60)
  // 定宽那一栏自己是算得出来的：记录条数 = 节体长度 ÷ 20。
  assert.equal(dict.byteLength / GRAM_RECORD_BYTES, 3)
})

test('④ blob 表的宽度由长度推：同一个集合编两次宽度不变', () => {
  const ids = corpus().map((b) => b.id)
  assert.equal(encodeBlobTable(ids, 32).byteLength, 4 + ids.length * 32)
  assert.equal(encodeBlobTable([], 20).byteLength, 4)
})
