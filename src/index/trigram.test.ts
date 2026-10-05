// trigram postings 的判据：**键控 blob id · 只出候选 · 顺序号由内容定 · 键是解码之后的单元**。
// 出处：ROADMAP § 4 的「trigram postings 键控 blob id」那一行 · TARGETS `T16` ②。
// 跑法：cd ~/fugue && node --test src/index/trigram.test.ts
//
//   ① 记录级往返：编出来再读回来，blob 表与每个 gram 的候选集一模一样
//   ② **候选集对照全扫**：语料里出现过的每一个三字组，索引给的候选集与"逐份文本扫一遍"逐字节相同
//      对手：收尾边界写错的构建器（`i < n-3` 而不是 `i <= n-3`——最后那一个三字组整批丢掉）·
//      差分解码错一位的解码器
//   ③ 边界与去重：恰好三个单元的 blob · 短于三个单元的 blob · 同一份内容出现两次 · 输入顺序
//      对手：按"喂进来的第几条"发顺序号的构建器（同一组内容换个顺序就编出另一份工件）
//   ④ 选择性：`countOf` 只看字典就答得出，且与候选集长度恒等
//      对手：把计数与 postings 分开维护、会各自漂的第二份
//   ⑤ **键与匹配器同空间**：非法 UTF-8 · 半个代理 · NUL 混在一起，三个单元一个窗口全扫也得一份不漏
//      对手：按原始字节取键的构建器——`\xFF` 解码之后是 U+FFFD，而查询串里的 U+FFFD 编回 UTF-8 是
//      `EF BF BD`：按字节找就把一份**真能匹配**的 blob 判成不候选（漏报）
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

/** 文本里第 i 个单元起的那三个单元 → 那个 48 位的键（与 `trigram.ts` 同一套算术，这里独立写一遍）。 */
const gramAt = (text: string, i: number): Trigram =>
  text.charCodeAt(i) * 0x1_0000_0000 + text.charCodeAt(i + 1) * 0x1_0000 + text.charCodeAt(i + 2)

/** 与 `tools/execute.ts` 的 `utf8Of` 同一句：匹配那一侧看到的就是这一段文本。 */
const textOf = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')

const gramOf = (s: string): Trigram => gramAt(s, 0)

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

/**
 * 全扫那一侧：这份内容里含不含这个三字组。
 *
 * **按解码之后的单元逐窗口比**，不按字节找子串——这一句就是"候选集与匹配器同空间"那条口径在全扫
 * 那一侧的对照物：拿字节去找，含非法 UTF-8 的语料当场对不上。
 */
function containsGram(bytes: Uint8Array, gram: Trigram): boolean {
  const text = textOf(bytes)
  for (let at = 0; at + 3 <= text.length; at++) if (gramAt(text, at) === gram) return true
  return false
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

test('② 候选集对照全扫：语料里出现过的每一个三字组，候选集与逐份文本扫出来的相同', () => {
  const blobs = corpus()
  const index = decodeTrigram(encodeTrigram(buildTrigram(blobs)))
  assert.notEqual(index, null)
  const grams = new Set<Trigram>()
  for (const b of blobs) {
    const text = textOf(b.bytes)
    for (let i = 0; i + 3 <= text.length; i++) grams.add(gramAt(text, i))
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

test('③ 恰好三个单元的 blob：那唯一一个三字组必须被收录（收尾边界）', () => {
  const only = blobOf('abc')
  const index = decodeTrigram(encodeTrigram(buildTrigram([only])))
  assert.notEqual(index, null)
  assert.deepEqual(index!.candidatesOf(gramOf('abc')), [only.id])
  assert.equal(index!.countOf(gramOf('abc')), 1)
})

test('③ 短于三个单元的 blob：在 blob 表里，但不带任何 posting', () => {
  const index = decodeTrigram(encodeTrigram(buildTrigram([blobOf(''), blobOf('a'), blobOf('ab')])))
  assert.notEqual(index, null)
  assert.equal(index!.blobIds.length, 3)
  assert.equal(index!.gramCount, 0)
})

test('③ 同一份内容给了两次：一个顺序号、一条 posting', () => {
  const text = '重复的内容 repeated'
  const one = blobOf(text)
  const index = decodeTrigram(encodeTrigram(buildTrigram([one, one, one])))
  assert.notEqual(index, null)
  assert.equal(index!.blobIds.length, 1)
  // **键是解码之后的单元**：第一个窗口从文本的头一个单元起（这份内容里就是"重"）。
  assert.deepEqual(index!.candidatesOf(gramOf(text)), [one.id])
  assert.equal(index!.countOf(gramOf(text)), 1)
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

test('④ 字典定宽 13 字节：第 k 条记录就在 k × 13，二分查找按它走', () => {
  const rows = [7, 100, 5000].map((gram, i) => ({ gram, count: i + 1, offset: i * 4 }))
  const dict = new Uint8Array(rows.length * GRAM_RECORD_BYTES)
  rows.forEach((r, i) => dict.set(encodeGramRecord(r), gramRecordOffset(i)))
  assert.deepEqual(decodeGramRecord(dict, gramRecordOffset(1)), rows[1])
  // 末条的终点就是 postings 那一节的长度（80 是随便给的一个上界）。
  assert.deepEqual(findGram(dict, 5000, 80), { ...rows[2], length: 80 - rows[2].offset })
  assert.deepEqual(findGram(dict, 100, 80), { ...rows[1], length: rows[2].offset - rows[1].offset })
  assert.equal(findGram(dict, 101, 80), null)
  assert.equal(GRAM_RECORD_BYTES, 13)
  assert.equal(gramRecordOffset(3), 39)
  // 定宽那一栏自己是算得出来的：记录条数 = 节体长度 ÷ 13。
  assert.equal(dict.byteLength / GRAM_RECORD_BYTES, 3)
  // 键是三个 u16：超过 2^32 的那一段也得原样回来（只按低 32 位存就会在这里塌掉）。
  const wide = new Uint8Array(GRAM_RECORD_BYTES)
  const big = 0xffff * 0x1_0000_0000 + 0x1234 * 0x1_0000 + 0x5678
  wide.set(encodeGramRecord({ gram: big, count: 2, offset: 3 }))
  assert.deepEqual(decodeGramRecord(wide, 0), { gram: big, count: 2, offset: 3 })
  // 收窄之后那两栏各自到顶也要原样回来：计数 2^24−1 · 偏移 2^32−1。**这一格量的是位宽，不是上限**
  // ——上限那一头由 `budget.test.ts` ① 与 `store.test.ts` 各自钉住。
  const top = new Uint8Array(GRAM_RECORD_BYTES)
  top.set(encodeGramRecord({ gram: 0, count: 0xff_ffff, offset: 0xffff_ffff }))
  assert.deepEqual(decodeGramRecord(top, 0), { gram: 0, count: 0xff_ffff, offset: 0xffff_ffff })
  // 到顶那一格三个字节**全是 0xff**，于是"位移写错一位"在那上面看不出来——这一格补上它：计数
  // 0x12_3456 的三个字节是 56 34 12，各不相同；偏移那一栏也给一个四个字节都不一样的图案，两栏
  // 挨着写串一位也在这里现形。
  const mid = new Uint8Array(GRAM_RECORD_BYTES)
  mid.set(encodeGramRecord({ gram: 0, count: 0x12_3456, offset: 0x0102_0304 }))
  assert.deepEqual(decodeGramRecord(mid, 0), { gram: 0, count: 0x12_3456, offset: 0x0102_0304 })
})

test('④ blob 表的宽度由长度推：同一个集合编两次宽度不变', () => {
  const ids = corpus().map((b) => b.id)
  assert.equal(encodeBlobTable(ids, 32).byteLength, 4 + ids.length * 32)
  assert.equal(encodeBlobTable([], 20).byteLength, 4)
})

// ── ⑥ 冻结面：字节钉住 ─────────────────────────────────────────────────────

test('⑥ 冻结面：那份固定语料的工件字节钉在这儿（键空间 · 布局 · 编码一起钉住）', () => {
  // 这一条抓的是"改动落在字节上"：键的算法、字典记录的布局、postings 的编码、节表的写法、**头部那
  // 一栏版本号**——任何一处动了，这两个数就动。跳版本号（口径里写着的那两个时机）就要在这里改它们，
  // **那是要人批的改动**，不是顺手改的；而重写编码这一类"应当逐字节不变"的改动，过不了这一条就是过不了。
  const texts = [
    'export function lineWindow(bytes, offset, limit) {',
    'postings 键控 blob id —— 一处真相',
    'abc',
    'abcdef',
  ]
  const parts = buildTrigram(texts.map((text) => blobOf(text)))
  const encoded = encodeTrigram(parts)
  assert.equal(parts.blobIds.length, 4)
  assert.equal(parts.textUnits, 86)
  assert.equal(parts.grams.length, 76)
  // 本站 ⑥ 换过样本：字典记录 18 → 13 字节，这一份的字典那一节短了 76 × 5 = 380 字节
  // （1761 → 1381），摘要跟着换。方案 § 三 批的就是这第二处例外。
  assert.equal(encoded.byteLength, 1381)
  assert.equal(
    createHash('sha256').update(encoded).digest('hex'),
    '86bbac478ab48b996451d1ba62c1eab1dc9a21a2601570128f8b8f3354a78261',
  )
  // 纯函数那一半：同一组输入换个顺序喂，钉在同一个字节上。
  const rotated = encodeTrigram(buildTrigram([...texts.slice(2), ...texts.slice(0, 2)].map((text) => blobOf(text))))
  assert.deepEqual(rotated, encoded)
})

// ── ⑤ 键与匹配器同空间（口径五）─────────────────────────────────────────────

test('⑤ 键与匹配器同空间：非法 UTF-8 · 半个代理 · NUL 混在一起，三个单元一个窗口也一份不漏', () => {
  // 每一份都是**原始字节**：解码这件事本身就是这一条要量的东西，所以不经过字符串构造。
  const raw: Uint8Array[] = [
    new Uint8Array([0x41, 0xff, 0x42]), // A<FF>B：非法字节在匹配那一侧是一个 U+FFFD
    new Uint8Array([0x41, 0xe6, 0xb1]), // 截断的三字节序列
    new Uint8Array([0xf0, 0x9f, 0x98, 0x80]), // 一个星面字符：解码之后是两个单元（一对代理）
    new Uint8Array([0x00, 0x01, 0x02]), // NUL 也是普通单元
    new Uint8Array([0xed, 0xa0, 0x80]), // 编码成 UTF-8 的半个代理
    new Uint8Array([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]), // 中文四个单元
    new Uint8Array([0xef, 0xbf, 0xbd]), // 本身就是 U+FFFD 的合法编码
    new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]), // 一串非法字节
    new Uint8Array([0x41, 0xff, 0x42, 0x41, 0xff, 0x42]), // 同一个窗口来两次（去重那一格）
    new Uint8Array([0x00, 0x41, 0xff, 0x00, 0x42, 0xfe, 0x43, 0xe4, 0xb8, 0xad]),
    new Uint8Array([0xf0, 0x9f, 0x98, 0x80, 0x41, 0x42, 0x43, 0xf0, 0x9f, 0x98, 0x81, 0x44]),
    new Uint8Array([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87, 0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]),
  ]
  const blobs: BlobBytes[] = raw.map((bytes) => ({ id: createHash('sha256').update(bytes).digest('hex'), bytes }))
  const index = decodeTrigram(encodeTrigram(buildTrigram(blobs)))
  assert.notEqual(index, null)

  // 全扫那一侧走的是"解码之后逐窗口"，与索引同一空间 ⇒ 每一个出现过的窗口都得一份不漏。
  const grams = new Set<Trigram>()
  for (const b of blobs) {
    const text = textOf(b.bytes)
    for (let at = 0; at + 3 <= text.length; at++) grams.add(gramAt(text, at))
  }
  assert.ok(grams.size >= 12, `语料太小，遮不住这几个边界：${grams.size} 个三字组`)
  for (const gram of grams) assert.deepEqual(index!.candidatesOf(gram), bruteSet(blobs, gram), `键 ${gram} 漏了`)

  // 口径五那一句的当场对照：非法字节那一份里，**字节**形式的三字组不是键——
  // 按字节取键就会把它判成不候选，而它其实匹配得上。
  const bent = blobs[0]
  const text = textOf(bent.bytes)
  assert.equal(text, 'A\ufffdB')
  const asBytes = bytesOf(text) // 查询串里的 U+FFFD 编回 UTF-8 是 EF BF BD
  const byteGram = ((asBytes[0] << 16) | (asBytes[1] << 8) | asBytes[2]) >>> 0
  assert.notEqual(byteGram, gramOf(text))
  assert.deepEqual(index!.candidatesOf(byteGram), [], '按字节取键在这里是空候选——那正是漏报的形状')
  // 该留住的是**所有**含这个窗口的份（语料里有两份的文本都含 `A<FFFD>B`，所以按包含关系算）。
  const should = blobs.filter((b) => textOf(b.bytes).includes(text)).map((b) => b.id).sort()
  assert.ok(should.length >= 2)
  assert.deepEqual(index!.candidatesOf(gramOf(text)), should, '按单元取键必须留住含这个窗口的每一份')
})
