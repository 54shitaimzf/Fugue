// 索引容器格式的四条判据。出处：ROADMAP § 4 的「索引落盘格式」那一行（"格式往返断言"）与 § 9 的
// 「索引在盘格式（带版本号）」那一格。跑法：cd ~/fugue && node --test src/index/format.test.ts
//
//   ① 往返：编出来再读回来，三节齐、顺序对、字节逐字节相同
//   ② **版本漂移必红**：头部版本那一栏动一个字节，读的一侧给 `null`（当损坏），不硬读
//      对手：一个不看版本、照着字段位置硬读的读者——它会把未来的布局读成今天的语义
//   ③ **逐字节改动必红**：工件里每一个字节各改成另外 255 个取值，没有一次能整份读回来
//      对手：一个只核节体、不核节表/头部的读者——改节表里的偏移或长度，它会静默读错一段
//   ④ **槽位**：多带第四节（预留号与未知号）· 节表顺序打乱——前三节读回来一如既往
//      对手：一个按"第 3 节就是 postings"取节的读者——第四节一进来它取到的就是别的节
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CODEC,
  DIGEST_BYTES,
  HEADER_BYTES,
  INDEX_MAGIC,
  INDEX_VERSION,
  SECTION,
  SECTION_ENTRY_BYTES,
  decodeIndexHeader,
  digestOf,
  encodeIndex,
  indexHeadBytes,
  sameBytes,
  sectionBody,
  sectionRefOf,
} from './format.ts'
import type { IndexParts, SectionInput } from './format.ts'

const sec = (kind: number, body: string): SectionInput => ({
  kind,
  codec: CODEC.raw,
  body: new Uint8Array(Buffer.from(body, 'utf8')),
})

/** 三节齐全的一份最小工件——各节体长短不同，改一个字节就换一段内容。 */
const partsOf = (extra: readonly SectionInput[] = []): IndexParts => ({
  sections: [
    sec(SECTION.blobs, 'blobs-body-0173'),
    sec(SECTION.dict, 'dict-body-0123456789'),
    sec(SECTION.postings, 'postings-body-9'),
    ...extra,
  ],
})

const REQUIRED = [SECTION.blobs, SECTION.dict, SECTION.postings] as const

/** 一份工件"读得回来"：容器认得出，且三节都在、摘要都对（读者那一侧的组合判据）。 */
function fullyReadable(bytes: Uint8Array): boolean {
  const header = decodeIndexHeader(bytes)
  if (header === null) return false
  for (const kind of REQUIRED) {
    const ref = sectionRefOf(header, kind)
    if (ref === null || sectionBody(bytes, ref) === null) return false
  }
  return true
}

/** 按类型取三节的字节（读不回来就是 `null`）。 */
function threeBodies(bytes: Uint8Array): Record<number, string> | null {
  const header = decodeIndexHeader(bytes)
  if (header === null) return null
  const out: Record<number, string> = {}
  for (const kind of REQUIRED) {
    const ref = sectionRefOf(header, kind)
    if (ref === null) return null
    const body = sectionBody(bytes, ref)
    if (body === null) return null
    out[kind] = Buffer.from(body).toString('utf8')
  }
  return out
}

// ── ① 往返 ─────────────────────────────────────────────────────────────────

test('① 往返：编出来再读回来，节按类型都找得到，字节逐字节相同', () => {
  const bytes = encodeIndex(partsOf())
  const header = decodeIndexHeader(bytes)
  assert.notEqual(header, null)
  assert.equal(header?.version, INDEX_VERSION)
  // **只给头部与节表、另报整份文件大小**：节体不在手里也读得出节表（按需读的那条路走它）。
  assert.deepEqual(decodeIndexHeader(bytes.subarray(0, indexHeadBytes(3)), bytes.byteLength), header)
  assert.equal(header?.sections.length, 3)
  assert.equal(
    bytes.byteLength,
    indexHeadBytes(3) + 'blobs-body-0173'.length + 'dict-body-0123456789'.length + 'postings-body-9'.length,
  )
  assert.deepEqual(threeBodies(bytes), {
    [SECTION.blobs]: 'blobs-body-0173',
    [SECTION.dict]: 'dict-body-0123456789',
    [SECTION.postings]: 'postings-body-9',
  })
  // 标出的那一段就是节体本身：偏移与长度带上节表，别处一个字节不差。
  const dict = sectionRefOf(header!, SECTION.dict)!
  assert.equal(dict.offset, HEADER_BYTES + 3 * SECTION_ENTRY_BYTES + 'blobs-body-0173'.length)
  assert.equal(dict.length, 'dict-body-0123456789'.length)
  assert.equal(sameBytes(dict.digest, digestOf(bytes.subarray(dict.offset, dict.offset + dict.length))), true)
  assert.equal(dict.digest.byteLength, DIGEST_BYTES)
})

test('① 头部认得出自己：魔数、版本、节数三栏都在，且节数为 0 读不回来', () => {
  const bytes = encodeIndex(partsOf())
  assert.equal(Buffer.from(bytes.subarray(0, 8)).toString('latin1'), INDEX_MAGIC)
  // 节数 0 不是"一份空索引"，是一个读不回来的形状。
  const zero = Uint8Array.prototype.slice.call(bytes)
  new DataView(zero.buffer).setUint32(12, 0, true)
  assert.equal(decodeIndexHeader(zero), null)
})

// ── ② 版本漂移必红 ─────────────────────────────────────────────────────────

test('② 版本漂移必红：头部版本那一栏每改一个字节，读的一侧都给 null', () => {
  const bytes = encodeIndex(partsOf())
  for (let i = 0; i < 4; i++) {
    for (const value of [0x00, 0x02, 0x7f, 0x80, 0xff]) {
      const bent = Uint8Array.prototype.slice.call(bytes)
      if (bent[8 + i] === value) continue
      bent[8 + i] = value
      assert.equal(decodeIndexHeader(bent), null, `版本第 ${i} 字节改成 ${value} 之后仍读得回来`)
    }
  }
  // 对照那一侧是绿的：原样的那一份读得回来（上面几条才不是空话）。
  assert.equal(fullyReadable(bytes), true)
})

// ── ③ 逐字节改动必红 ───────────────────────────────────────────────────────

test('③ 逐字节改动必红（只有那三节）：每个字节各改成其余 255 个取值，一律读不回来', () => {
  const bytes = encodeIndex(partsOf())
  assert.equal(fullyReadable(bytes), true)
  let tried = 0
  for (let at = 0; at < bytes.byteLength; at++) {
    const was = bytes[at]
    for (let value = 0; value < 256; value++) {
      if (value === was) continue
      const bent = Uint8Array.prototype.slice.call(bytes)
      bent[at] = value
      tried += 1
      assert.equal(
        fullyReadable(bent),
        false,
        `第 ${at} 字节由 ${was} 改成 ${value} 之后整份仍读得回来——那一个字节没有被任何判据查到`,
      )
    }
  }
  // 这一条量到的规模要写出来：改动次数就是"每个字节 × 其余 255 个取值"。
  assert.equal(tried, bytes.byteLength * 255)
})

test('③ 逐字节改动必红（带上那节可选表）：不是读不回来，就是读回来的一模一样', () => {
  // 可选表自己的字节改了，今天的读者不看它，于是"读得回来"是**应当**的。要钉住的是更强的那
  // 半句：**不许读回来另一份索引**。判据只有两个出口——落空，或者三节逐字节与原件相同。
  const bytes = encodeIndex(partsOf([sec(SECTION.symbols, 'symbol-table-placeholder')]))
  const original = threeBodies(bytes)
  assert.notEqual(original, null)
  let tried = 0
  let refused = 0
  for (let at = 0; at < bytes.byteLength; at++) {
    const was = bytes[at]
    for (let value = 0; value < 256; value++) {
      if (value === was) continue
      const bent = Uint8Array.prototype.slice.call(bytes)
      bent[at] = value
      tried += 1
      const read = threeBodies(bent)
      if (read === null) {
        refused += 1
        continue
      }
      assert.deepEqual(
        read,
        original,
        `第 ${at} 字节由 ${was} 改成 ${value} 之后读回来的是另一份索引——没有被任何判据查到`,
      )
    }
  }
  assert.equal(tried, bytes.byteLength * 255)
  // 可选表那一段之外一律被拒：这一条量到的规模也要写出来。
  assert.ok(refused > 0, `一次都没被拒，那这条判据是空话：${refused}/${tried}`)
})

// ── ④ 槽位 ─────────────────────────────────────────────────────────────────

test('④ 槽位：多带一张预留表 / 一张没见过的表，前三节读回来一如既往', () => {
  const plain = threeBodies(encodeIndex(partsOf()))
  const withSymbols = threeBodies(encodeIndex(partsOf([sec(SECTION.symbols, 'symbol-table-placeholder')])))
  const withUnknown = threeBodies(encodeIndex(partsOf([sec(99, 'a table this reader has never heard of')])))
  assert.notEqual(plain, null)
  assert.deepEqual(withSymbols, plain)
  assert.deepEqual(withUnknown, plain)
})

test('④ 槽位：节表顺序不是语义——打乱之后前三节读回来一如既往', () => {
  const plain = threeBodies(encodeIndex(partsOf()))
  const shuffled = threeBodies(
    encodeIndex({
      sections: [
        sec(SECTION.postings, 'postings-body-9'),
        sec(SECTION.symbols, 'symbol-table-placeholder'),
        sec(SECTION.blobs, 'blobs-body-0173'),
        sec(SECTION.dict, 'dict-body-0123456789'),
      ],
    }),
  )
  assert.notEqual(plain, null)
  assert.deepEqual(shuffled, plain)
})

test('④ 槽位：预留号今天没有写入者——编出来的三节工件里不带它', () => {
  const header = decodeIndexHeader(encodeIndex(partsOf()))
  assert.equal(sectionRefOf(header!, SECTION.symbols), null)
})

// ── 形状判据（放不下 / 越界 / 同类型两次）────────────────────────────────────

test('节表放不下 / 节体越界 / 同一类型两次，都是 null', () => {
  const bytes = encodeIndex(partsOf())
  // 节数说得多，节表就放不下。
  const many = Uint8Array.prototype.slice.call(bytes)
  new DataView(many.buffer).setUint32(12, 99, true)
  assert.equal(decodeIndexHeader(many), null)
  // 节体越过文件末尾。
  const over = Uint8Array.prototype.slice.call(bytes)
  new DataView(over.buffer).setBigUint64(HEADER_BYTES + 16, BigInt(bytes.byteLength), true)
  assert.equal(decodeIndexHeader(over), null)
  // 节体起点落回节表里面（"表中表"）。
  const inside = Uint8Array.prototype.slice.call(bytes)
  new DataView(inside.buffer).setBigUint64(HEADER_BYTES + 8, BigInt(HEADER_BYTES), true)
  assert.equal(decodeIndexHeader(inside), null)
  // 同一个类型两次："按类型找"就没有唯一答案了。
  const twice = encodeIndex({
    sections: [sec(SECTION.blobs, 'aaa'), sec(SECTION.blobs, 'bbb'), sec(SECTION.dict, 'c')],
  })
  assert.equal(decodeIndexHeader(twice), null)
})

test('认不出的节编码 = 这一节读不回来（不是硬读）', () => {
  const bytes = encodeIndex(partsOf())
  const header = decodeIndexHeader(bytes)!
  const ref = sectionRefOf(header, SECTION.dict)!
  const bent = Uint8Array.prototype.slice.call(bytes)
  new DataView(bent.buffer).setUint32(HEADER_BYTES + SECTION_ENTRY_BYTES + 4, 77, true)
  const after = decodeIndexHeader(bent)!
  // 容器层照旧读得出节表（编码是节那一层的事），但取节体给 null。
  assert.equal(sectionBody(bent, sectionRefOf(after, SECTION.dict)!), null)
  assert.notEqual(sectionBody(bytes, ref), null)
})
