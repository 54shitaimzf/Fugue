// 三字组 postings：**键是 blob id**。出处：ROADMAP § 4 的「trigram postings 键控 blob id」那一行 ·
// TARGETS `T16` ②。容器在 `format.ts`，这一份只有语义与载荷。
//
// 三节的分工（形状见 `format.ts`）：
//
//   blobs    u32 idBytes + N 个定宽 id（**按 id 升序**）。顺序号就是它的下标。
//   dict     N 条定宽 18 字节记录（三个 UTF-16 单元 · count u32 · offset u64），按 gram 升序。
//   postings 各 gram 的顺序号表依次相接：**差分 + varint**（无符号 LEB128）。
//
// 五条口径：
//
//   一 · **只出候选。** `candidatesOf` 给的是"这个三字组可能出现在哪些 blob 里"；答案永远从真源
//        字节里验出来（0.3.3 的验证那一格）。这份载荷里没有一处判断"原文怎么匹配"。
//   二 · **键是 blob id，不是路径。** 内容寻址 ⇒ 同一份内容出现在几条路径上只有一条 posting，
//        而改名不动索引——0.3.2 的增量只爬新 blob，靠的就是这一条。
//   三 · **工件是 blob 集合的纯函数**：顺序号按 id 升序发、gram 表按 gram 升序排，于是同一组
//        (id, 字节) 无论以什么顺序喂进来，编出来的字节逐字节相同。
//   四 · **字典定宽是为了"先拿计数"**：第 k 条记录就在 `k × 18`，二分查找既能在一份读回来的
//        字典里做，也能按偏移逐条读。变长编码的字典要把整段走一遍才找得到一个 gram——
//        "不读完就拿到计数"那条路会当场堵死，而 `countOf` 正是选择性派发要的那一问。
//        长度那一栏**不存**：它就是"下一条的起点减这一条的起点"（末条减到 postings 那一节的
//        长度）。存一份推得出来的东西，就是给漂移留一个不报错的位置。
//   五 · **三字组是"解码之后那三个 UTF-16 单元"，不是三个字节。** 匹配那一侧是 `tools/execute.ts`
//        的 `utf8Of(...)` 之后按行 `RegExp.test`——它眼里的"字符"是解码出来的单元。索引若按原始
//        字节取键，两边就不在同一个空间里：blob 里一处非法 UTF-8 解码之后是 U+FFFD，而查询串里的
//        U+FFFD 编回 UTF-8 是 `EF BF BD`，三个字节哪一个都不在那份 blob 的字节里。于是候选集把一份
//        **真能匹配**的 blob 判成"不候选"——候选集少了就是漏报，而漏报是这一层唯一不能犯的错。
//        键 = `u0 × 2^32 + u1 × 2^16 + u2`（≤ 2^48−1，在 Number 的 53 位精确整数之内），数值序
//        与三个单元的字典序一致，所以字典按数值升序排就是按单元字典序排。
//
// **载荷解出来之后不再自己核一遍摘要**：节体在进到这里之前已经按节核对过（`format.ts` 口径二），
// 所以解码循环信任手里的字节，不为"不可能到达的输入"付常数代价。
import { CODEC, SECTION, decodeIndexHeader, encodeIndex, sameBytes, sectionBody, sectionRefOf } from './format.ts'
import type { SectionInput } from './format.ts'
import type { BlobId } from '../terms.ts'

/** 三字组的键：三个 UTF-16 单元拼成一个 48 位整数（高位在前）。 */
export type Trigram = number
/** 一个三字组占几个单元。**是单元不是字节**（口径五）。 */
export const TRIGRAM_UNITS = 3
/** 一个三字组的键在字典里占几个字节（三个 u16 相接）。 */
export const GRAM_KEY_BYTES = 6
/** 字典一条记录的字节数。**定宽**是口径四那条路的前提。 */
export const GRAM_RECORD_BYTES = 18
/** 键的上界：三个码元全满。 */
export const GRAM_MAX = 0xff_ffff_ffff_ffff
const UNIT_BASE = 0x1_0000
const HIGH_BASE = 0x1_0000_0000

export interface BlobBytes {
  readonly id: BlobId
  readonly bytes: Uint8Array
}

/** 字典里存着的那三栏。 */
export interface GramRow {
  readonly gram: Trigram
  /** 这个 gram 在几个 blob 里出现过——**选择性派发要的就是它**。 */
  readonly count: number
  /** 相对 postings 那一节起点的偏移。 */
  readonly offset: number
}

/** 解出来的一条：那三栏，加上由邻居推出来的长度。 */
export interface GramEntry extends GramRow {
  readonly length: number
}

export interface TrigramParts {
  /** 升序、去重之后的 blob id。顺序号 = 下标。 */
  readonly blobIds: readonly BlobId[]
  /** 按 gram 升序。 */
  readonly grams: readonly { readonly gram: Trigram; readonly ordinals: readonly number[] }[]
  /** 收进来的这些 blob 一共解出多少个单元（读数，不进判据）。 */
  readonly textUnits: number
}

/**
 * 一份读回来的索引。**它只出候选与计数**，不回答"哪一行匹配"。
 */
export interface TrigramIndex {
  readonly blobIds: readonly BlobId[]
  /** 见到的三字组有几个（读数，不进判据）。 */
  readonly gramCount: number
  /**
   * 这个三字组见过的那些 blob（升序、去重）。**候选，不是答案。**
   *
   * 没见过的 gram 给空数组——"没有 blob 含它"与"这份索引没建过它"在这里是同一件事，而两者
   * 对候选集的含义相同（都不候选）。
   */
  candidatesOf(gram: Trigram): readonly BlobId[]
  /**
   * 这个三字组在几个 blob 里出现过。**只看字典就答得出**，postings 那一段一个字节都不读。
   *
   * 选择性派发要的就是这一问：候选多（密集）走扫描，候选少（稀疏）走索引。
   */
  countOf(gram: Trigram): number
}

// ── 键：解码之后的单元（口径五）──────────────────────────────────────────────

/**
 * blob 字节 → 匹配那一侧看到的文本。
 *
 * **这一句必须与 `tools/execute.ts` 的 `utf8Of` 逐字同义**：三个单元的三字组只有落在同一个解码
 * 结果上，候选集与匹配器才在同一个空间里。改那一处就要回来改这一处。
 */
export function textOf(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')
}

/** 文本里第 `at` 个单元起的那三个单元 → 键。调用方保证 `at + 3 <= text.length`。 */
export function gramAt(text: string, at: number): Trigram {
  return text.charCodeAt(at) * HIGH_BASE + text.charCodeAt(at + 1) * UNIT_BASE + text.charCodeAt(at + 2)
}

// ── 载荷编解码（纯字节，不碰文件系统）────────────────────────────────────────

function hexToBytes(id: string): Uint8Array {
  if (id.length % 2 !== 0 || !/^[0-9a-f]*$/.test(id)) {
    throw new Error(`blob id 不是偶数长的小写十六进制：${JSON.stringify(id)}`)
  }
  const out = new Uint8Array(id.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(id.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** 一个 blob 集合的 id 宽度。空集合给 20（sha1）——那一份里没有 id，宽度无从谈起也不影响读。 */
export function idBytesOf(ids: readonly BlobId[]): number {
  if (ids.length === 0) return 20
  const width = ids[0].length / 2
  if (!Number.isInteger(width) || width === 0) throw new Error(`blob id 的长度不对：${JSON.stringify(ids[0])}`)
  return width
}

/** blobs 那一节：`u32 idBytes` 打头，其后是 N 个定宽 id。**N 由长度推，不另存一栏。** */
export function encodeBlobTable(ids: readonly BlobId[], idBytes: number): Uint8Array {
  const out = new Uint8Array(4 + ids.length * idBytes)
  new DataView(out.buffer).setUint32(0, idBytes, true)
  ids.forEach((id, i) => {
    const raw = hexToBytes(id)
    if (raw.byteLength !== idBytes) throw new Error(`blob id 的宽度与声明不符：${id}`)
    out.set(raw, 4 + i * idBytes)
  })
  return out
}

/** 读回 blobs 那一节。**长度除不尽就是形状不对**（当损坏，不硬读）。 */
export function decodeBlobTable(body: Uint8Array): { idBytes: number; ids: BlobId[] } | null {
  if (body.byteLength < 4) return null
  const idBytes = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true)
  if (idBytes === 0 || (body.byteLength - 4) % idBytes !== 0) return null
  const count = (body.byteLength - 4) / idBytes
  const ids: BlobId[] = []
  for (let i = 0; i < count; i++) ids.push(bytesToHex(body.subarray(4 + i * idBytes, 4 + (i + 1) * idBytes)))
  return { idBytes, ids }
}

/** 把一条记录写进 `out` 的第 `at` 个字节：三个单元（u16 各一）· count u32 · offset u64。 */
function writeGramRecord(out: Uint8Array, at: number, row: GramRow): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint16(at, Math.floor(row.gram / HIGH_BASE), true)
  view.setUint16(at + 2, Math.floor(row.gram / UNIT_BASE) % UNIT_BASE, true)
  view.setUint16(at + 4, row.gram % UNIT_BASE, true)
  view.setUint32(at + 6, row.count, true)
  view.setBigUint64(at + 10, BigInt(row.offset), true)
}

/** 字典的一条记录，18 字节定宽。 */
export function encodeGramRecord(row: GramRow): Uint8Array {
  const out = new Uint8Array(GRAM_RECORD_BYTES)
  writeGramRecord(out, 0, row)
  return out
}

/** 字典里第 `index` 条记录的位置。**二分查找按这个算术走**（口径四）。 */
export function gramRecordOffset(index: number): number {
  return index * GRAM_RECORD_BYTES
}

export function decodeGramRecord(dict: Uint8Array, at: number): GramRow | null {
  if (at < 0 || at + GRAM_RECORD_BYTES > dict.byteLength) return null
  const view = new DataView(dict.buffer, dict.byteOffset, dict.byteLength)
  return {
    gram: view.getUint16(at, true) * HIGH_BASE + view.getUint16(at + 2, true) * UNIT_BASE + view.getUint16(at + 4, true),
    count: view.getUint32(at + 6, true),
    offset: Number(view.getBigUint64(at + 10, true)),
  }
}

/** 第 `index` 条那一截到哪儿为止：下一条的起点，末条到 postings 那一节的末尾。 */
function endOf(dict: Uint8Array, index: number, postingsBytes: number): number {
  const next = decodeGramRecord(dict, gramRecordOffset(index + 1))
  return next === null ? postingsBytes : next.offset
}

/** 按 gram 二分查找。**只看这一段字节**——postings 那一节一个字节都不碰（口径四）。 */
export function findGram(dict: Uint8Array, gram: Trigram, postingsBytes: number): GramEntry | null {
  let lo = 0
  let hi = dict.byteLength / GRAM_RECORD_BYTES - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const row = decodeGramRecord(dict, gramRecordOffset(mid))
    if (row === null) return null
    if (row.gram < gram) {
      lo = mid + 1
      continue
    }
    if (row.gram > gram) {
      hi = mid - 1
      continue
    }
    return { ...row, length: endOf(dict, mid, postingsBytes) - row.offset }
  }
  return null
}

/** 顺序号表 → 差分 + varint（无符号 LEB128）。 */
export function encodeOrdinals(ordinals: readonly number[]): Uint8Array {
  const out: number[] = []
  let prev = 0
  for (const n of ordinals) {
    let delta = n - prev
    prev = n
    for (;;) {
      const byte = delta % 128
      delta = Math.floor(delta / 128)
      if (delta === 0) {
        out.push(byte)
        break
      }
      out.push(byte | 0x80)
    }
  }
  return new Uint8Array(out)
}

/** 一个差分写成 varint 要几个字节。**算得出来就不必先编一遍再数**（编码那一趟按它排偏移）。 */
export function varintBytes(delta: number): number {
  let bytes = 1
  for (let rest = Math.floor(delta / 128); rest > 0; rest = Math.floor(rest / 128)) bytes += 1
  return bytes
}

/**
 * 差分 + varint → 顺序号表。
 *
 * **循环由手里这段字节的长度兜住**（每步至少前进一个字节），所以不需要另一条"读到越界就停"的
 * 判据——那段字节是不是完好，已经由所在那一节的摘要答过了。
 */
export function decodeOrdinals(slice: Uint8Array): number[] {
  const out: number[] = []
  let at = 0
  let value = 0
  while (at < slice.byteLength) {
    let shift = 1
    for (;;) {
      const byte = slice[at] ?? 0
      at += 1
      value += (byte & 0x7f) * shift
      if ((byte & 0x80) === 0 || at >= slice.byteLength) break
      shift *= 128
    }
    out.push(value)
  }
  return out
}

// ── 构建（纯函数：同一组输入 → 逐字节相同的工件）──────────────────────────────

/**
 * 一份 (id, 字节) 集合 → postings。**顺序号由 id 升序定，与喂进来的顺序无关**（口径三）。
 *
 * 每个 blob 先按匹配那一侧的解码变成文本，再走三个单元一个窗口（口径五）。同一个 blob 里的重复
 * 窗口只落一条 posting：这一趟只有本 blob 在往表里追加，于是"这一条的末尾已经是本顺序号"就等于
 * "本 blob 已经收过它"——不必另起一张去重表，也就不必为它付一份与文本等长的内存。
 */
export function buildTrigram(blobs: readonly BlobBytes[]): TrigramParts {
  const byId = new Map<BlobId, Uint8Array>()
  for (const b of blobs) {
    const had = byId.get(b.id)
    if (had === undefined) {
      byId.set(b.id, b.bytes)
      continue
    }
    // 同一个 id 两份字节 = 内容寻址的前提破了。静默取先到的那一份，会让工件的字节取决于输入
    // 顺序——而"工件是 blob 集合的纯函数"正是口径三。
    if (!sameBytes(had, b.bytes)) throw new Error(`同一个 blob id 给了两份不同的字节：${b.id}`)
  }
  const ids = [...byId.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  const lists = new Map<Trigram, number[]>()
  let textUnits = 0
  ids.forEach((id, ordinal) => {
    const text = textOf(byId.get(id) as Uint8Array)
    textUnits += text.length
    for (let at = 0; at + TRIGRAM_UNITS <= text.length; at++) {
      const gram = gramAt(text, at)
      const list = lists.get(gram)
      if (list === undefined) lists.set(gram, [ordinal])
      else if (list[list.length - 1] !== ordinal) list.push(ordinal)
    }
  })
  const grams = [...lists.keys()]
    .sort((a, b) => a - b)
    .map((gram) => ({ gram, ordinals: lists.get(gram) as number[] }))
  return { blobIds: ids, grams, textUnits }
}

/** 三节编成一份工件（容器那一层在 `format.ts`）。 */
export function encodeTrigram(parts: TrigramParts): Uint8Array {
  const idBytes = idBytesOf(parts.blobIds)
  const dict = new Uint8Array(parts.grams.length * GRAM_RECORD_BYTES)
  const bodies: Uint8Array[] = []
  let at = 0
  parts.grams.forEach((g, index) => {
    const body = encodeOrdinals(g.ordinals)
    writeGramRecord(dict, gramRecordOffset(index), { gram: g.gram, count: g.ordinals.length, offset: at })
    bodies.push(body)
    at += body.byteLength
  })
  const postings = new Uint8Array(at)
  let put = 0
  for (const body of bodies) {
    postings.set(body, put)
    put += body.byteLength
  }
  const sections: SectionInput[] = [
    { kind: SECTION.blobs, codec: CODEC.raw, body: encodeBlobTable(parts.blobIds, idBytes) },
    { kind: SECTION.dict, codec: CODEC.raw, body: dict },
    { kind: SECTION.postings, codec: CODEC.raw, body: postings },
  ]
  return encodeIndex({ sections })
}

/** 一份读回来的三段载荷 → `TrigramIndex`。三节缺一不可；缺了给 `null`（当损坏）。 */
export function indexOfParts(blobsBody: Uint8Array, dict: Uint8Array, postings: Uint8Array): TrigramIndex | null {
  const table = decodeBlobTable(blobsBody)
  if (table === null) return null
  if (dict.byteLength % GRAM_RECORD_BYTES !== 0) return null
  const idsOf = (rec: GramEntry): BlobId[] => {
    const out: BlobId[] = []
    for (const ordinal of decodeOrdinals(postings.subarray(rec.offset, rec.offset + rec.length))) {
      const id = table.ids[ordinal]
      if (id !== undefined) out.push(id)
    }
    return out
  }
  return {
    blobIds: table.ids,
    gramCount: dict.byteLength / GRAM_RECORD_BYTES,
    countOf: (gram) => findGram(dict, gram, postings.byteLength)?.count ?? 0,
    candidatesOf: (gram) => {
      const rec = findGram(dict, gram, postings.byteLength)
      return rec === null ? [] : idsOf(rec)
    },
  }
}

/**
 * 整份工件 → `TrigramIndex`。**认不出的版本、缺节、摘要对不上、形状不对，一律 `null`**：
 * 调用方拿到 `null` 就重建，不硬读。
 */
export function decodeTrigram(bytes: Uint8Array): TrigramIndex | null {
  const header = decodeIndexHeader(bytes)
  if (header === null) return null
  const bodies: Uint8Array[] = []
  for (const kind of [SECTION.blobs, SECTION.dict, SECTION.postings]) {
    const ref = sectionRefOf(header, kind)
    if (ref === null) return null
    const body = sectionBody(bytes, ref)
    if (body === null) return null
    bodies.push(body)
  }
  return indexOfParts(bodies[0], bodies[1], bodies[2])
}
