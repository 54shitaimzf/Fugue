// 三字组 postings：**键是 blob id**。出处：ROADMAP § 4 的「trigram postings 键控 blob id」那一行 ·
// TARGETS `T16` ②。容器在 `format.ts`，这一份只有语义与载荷。
//
// 三节的分工（形状见 `format.ts`）：
//
//   blobs    u32 idBytes + N 个定宽 id（**按 id 升序**）。顺序号就是它的下标。
//   dict     N 条定宽 13 字节记录（三个 UTF-16 单元 · count u24 · offset u32），按 gram 升序。
//   postings 各 gram 的顺序号表依次相接：**差分 + varint**（无符号 LEB128）。
//
// 五条口径：
//
//   一 · **只出候选。** `candidatesOf` 给的是"这个三字组可能出现在哪些 blob 里"；答案永远从真源
//        字节里验出来（查询接线那一格验的）。这份载荷里没有一处判断"原文怎么匹配"。
//   二 · **键是 blob id，不是路径。** 内容寻址 ⇒ 同一份内容出现在几条路径上只有一条 posting，
//        而改名不动索引——增量构建只爬新 blob，靠的就是这一条。
//   三 · **工件是 blob 集合的纯函数**：顺序号按 id 升序发、gram 表按 gram 升序排，于是同一组
//        (id, 字节) 无论以什么顺序喂进来，编出来的字节逐字节相同。
//   四 · **字典定宽是为了"先拿计数"**：第 k 条记录就在 `k × 13`，二分查找既能在一份读回来的
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
import {
  CODEC,
  SECTION,
  decodeIndexHeader,
  encodeIndex,
  indexHeadBytes,
  sameBytes,
  sectionBody,
  sectionRefOf,
} from './format.ts'
import type { SectionInput } from './format.ts'
import { INDEX_LIMITS, IndexBudgetExceeded } from './budget.ts'
import type { BlobId } from '../terms.ts'

/** 三字组的键：三个 UTF-16 单元拼成一个 48 位整数（高位在前）。 */
export type Trigram = number
/** 一个三字组占几个单元。**是单元不是字节**（口径五）。 */
export const TRIGRAM_UNITS = 3
/** 一个三字组的键在字典里占几个字节（三个 u16 相接）。 */
export const GRAM_KEY_BYTES = 6
/**
 * 字典一条记录的字节数 = 键 6 + count 3 + offset 4。**定宽**是口径四那条路的前提。
 *
 * 后两栏的宽度是从 `INDEX_LIMITS` 反推的，不是估的（本站 ⑥ 把 u32/u64 收到 u24/u32）：
 *
 *   count  装的是"这个 gram 出现在几个 blob 里"，而 blob 表最多 `INDEX_LIMITS.blobs` = 65,536 条
 *          （`collectBlobs` 与 `growFrom` 都在收的当场止住）——65,536 < 2^24，三个字节够。
 *   offset 装的是 postings 那一节里的位置，而整份工件最多 `INDEX_LIMITS.artifactBytes` = 64 MiB
 *          （`store.ts` 那一关判在分配之前）——64 MiB < 2^32，四个字节够。
 *
 * 于是这两栏**装不满**，写入那一侧不必再加边界检查：加一道也说不清挡的是什么灾，而上限那一边
 * 已经先抛了（`IndexBudgetExceeded`）。两条上限哪一条动了，这两个宽度都得重新反推一遍。
 */
export const GRAM_RECORD_BYTES = GRAM_KEY_BYTES + 3 + 4
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

/** 三个字节的无符号小端整数。`DataView` 没有 u24 这一档，两行手写。 */
function setUint24(view: DataView, at: number, value: number): void {
  view.setUint8(at, value & 0xff)
  view.setUint8(at + 1, (value >>> 8) & 0xff)
  view.setUint8(at + 2, (value >>> 16) & 0xff)
}

function getUint24(view: DataView, at: number): number {
  return view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16)
}

/** 把一条记录写进 `out` 的第 `at` 个字节：三个单元（u16 各一）· count u24 · offset u32。 */
function writeGramRecord(out: Uint8Array, at: number, row: GramRow): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint16(at, Math.floor(row.gram / HIGH_BASE), true)
  view.setUint16(at + 2, Math.floor(row.gram / UNIT_BASE) % UNIT_BASE, true)
  view.setUint16(at + 4, row.gram % UNIT_BASE, true)
  setUint24(view, at + 6, row.count)
  view.setUint32(at + 9, row.offset, true)
}

/** 字典的一条记录，13 字节定宽（宽度那份反推写在 `GRAM_RECORD_BYTES`）。 */
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
    count: getUint24(view, at + 6),
    offset: view.getUint32(at + 9, true),
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

/** 一份顺序号表按差分 varint（无符号 LEB128）写进 `out` 的第 `at` 个字节，返回写了几个字节。 */
function writeOrdinals(out: Uint8Array, at: number, ordinals: readonly number[]): number {
  let put = at
  let previous = 0
  for (const ordinal of ordinals) {
    let delta = ordinal - previous
    previous = ordinal
    for (;;) {
      const byte = delta % 128
      delta = Math.floor(delta / 128)
      if (delta === 0) {
        out[put++] = byte
        break
      }
      out[put++] = byte | 0x80
    }
  }
  return put - at
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
 *
 * `maxGrams` 是**收表这一趟的闸**（缺省就是出货那一套的 `grams`）：三字组数就是这一层的内存与
 * 时间那把尺（一个三字组一条记录 + 一个数组，量到约 0.3 KB），所以越限要在插入的当场止住，
 * 不能等收完表再判。
 */
export function buildTrigram(blobs: readonly BlobBytes[], maxGrams: number = INDEX_LIMITS.grams): TrigramParts {
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
      if (list === undefined) {
        // 越限的当场就止住：再往下是几十秒与几 GB，等收完表再判已经太晚（上限是允许的最大值）。
        if (lists.size >= maxGrams) {
          throw new IndexBudgetExceeded('grams', `三字组数超过这一档的上限：${lists.size + 1} > ${maxGrams}`)
        }
        lists.set(gram, [ordinal])
      } else if (list[list.length - 1] !== ordinal) list.push(ordinal)
    }
  })
  const grams = [...lists.keys()]
    .sort((a, b) => a - b)
    .map((gram) => ({ gram, ordinals: lists.get(gram) as number[] }))
  return { blobIds: ids, grams, textUnits }
}

/** postings 那一节会有多少字节：差分 varint 逐条算，一个字节都不分配。 */
function postingsBytesOf(parts: TrigramParts): number {
  let total = 0
  for (const g of parts.grams) {
    let previous = 0
    for (const ordinal of g.ordinals) {
      total += varintBytes(ordinal - previous)
      previous = ordinal
    }
  }
  return total
}

/**
 * 这一组载荷编出来会有多少字节（头部 + 节表 + 三节），**不分配**。
 *
 * 预算那一关据它判，而且必须判在分配之前——越过上限的那一边是几十 MB 的数组，先分配再判等于把
 * 上限做成了摆设。所以它算的是**真值**，不是上界（`budget.test.ts` ③ 拿真编出来的长度钉这一条）。
 */
export function encodedBytesOf(parts: TrigramParts): number {
  const idBytes = idBytesOf(parts.blobIds)
  return (
    indexHeadBytes(3) +
    (4 + parts.blobIds.length * idBytes) +
    parts.grams.length * GRAM_RECORD_BYTES +
    postingsBytesOf(parts)
  )
}

/**
 * 三节编成一份工件（容器那一层在 `format.ts`）。
 *
 * **两趟走，不给每个三字组造一个数组。** 先把 postings 那一块按算出来的长度一次要到手，再把 varint
 * 直接写进去。原先每个 gram 先编一段小 `Uint8Array` 再逐段拼起来：最杂那一档上要造 857k 个对象，
 * 量到瞬时堆 +230 MiB，而那 230 MiB 一个字节的信息都不多带。
 *
 * 代价是长度算了两遍（`store.ts` 的预算那一关也要它）：最杂那一档上多出来的一遍是几十毫秒量级，
 * 换的是"分配之前先判"。
 */
export function encodeTrigram(parts: TrigramParts): Uint8Array {
  const idBytes = idBytesOf(parts.blobIds)
  const dict = new Uint8Array(parts.grams.length * GRAM_RECORD_BYTES)
  const postings = new Uint8Array(postingsBytesOf(parts))
  let at = 0
  parts.grams.forEach((g, index) => {
    writeGramRecord(dict, gramRecordOffset(index), { gram: g.gram, count: g.ordinals.length, offset: at })
    at += writeOrdinals(postings, at, g.ordinals)
  })
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
 * 一份工件的三段载荷（原样字节）＋它认领的那组 id。**增量那一趟要的就是这几段**：合并只要旧的
 * blob 表 · 字典 · postings，不必把旧的那一组真源重读一遍。
 *
 * `blobIds` 由 `blobs` 那一节推出来（一处真相：它不是另存的一份，是同一段字节的读法）。
 */
export interface TrigramSections {
  readonly blobIds: readonly BlobId[]
  readonly blobs: Uint8Array
  readonly dict: Uint8Array
  readonly postings: Uint8Array
}

/**
 * 整份工件 → 三段载荷。**认不出的版本 · 缺节 · 摘要对不上 · 形状不对，一律 `null`**：
 * 调用方拿到 `null` 就重建，不硬读。
 *
 * 三节**载荷**的形状判据也在这里（blob 表读得回来 · 字典是整数条记录）：`decodeTrigram` 与增量
 * 那一趟共用这一句，于是「这份工件可读吗」只有一处答案。
 */
export function sectionsOf(bytes: Uint8Array): TrigramSections | null {
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
  const table = decodeBlobTable(bodies[0])
  if (table === null) return null
  if (bodies[1].byteLength % GRAM_RECORD_BYTES !== 0) return null
  return { blobIds: table.ids, blobs: bodies[0], dict: bodies[1], postings: bodies[2] }
}

/**
 * 整份工件 → `TrigramIndex`。**走同一句「这份工件可读吗」**（`sectionsOf`），再按三节的形状收成
 * 一个值。认不出的版本、缺节、摘要对不上、形状不对，一律 `null`：调用方拿到 `null` 就重建，不硬读。
 */
export function decodeTrigram(bytes: Uint8Array): TrigramIndex | null {
  const sections = sectionsOf(bytes)
  if (sections === null) return null
  return indexOfParts(sections.blobs, sections.dict, sections.postings)
}

// ── 增量：旧工件与这一趟新解的 gram 合并 ─────────────────────────────────────

/**
 * 旧工件的三段载荷**形状**读不出可用语义：字典不按键升序或有重复的键 · 同一个 gram 的顺序号
 * 不升序或越出旧 blob 表 · postings 段的范围越出那一节。
 *
 * **与"读到坏字节"分开报**：节摘要挡得住字节被改，挡不住一份形状自相矛盾的工件（今天的写者
 * 造不出它——形状这一层是给"合成一份工件"这一类输入留的判据）。这一类的去处是**回全量重建**
 * （变慢，不是出错），所以它有自己的类型：调用方按类型兜住它，而别的错（真的写错了）照旧抛出去，
 * 不被兜成"看起来成功了"。
 */
export class ArtifactShapeError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'ArtifactShapeError'
  }
}

/** 两份都升序的 id 名单：`from` 里每个 id 在 `to` 里的下标；不在 `to` 里的给 −1。 */
function ordinalsInto(from: readonly BlobId[], to: readonly BlobId[]): Int32Array {
  const out = new Int32Array(from.length).fill(-1)
  let at = 0
  for (let i = 0; i < from.length; i++) {
    while (at < to.length && to[at] < from[i]) at += 1
    if (at < to.length && to[at] === from[i]) out[i] = at
  }
  return out
}

/** 两份升序去重的顺序号表合成一份。**归并**——两路各自已经升序去重，只有两路相等的那一处要去。 */
function mergedOrdinals(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = []
  let x = 0
  let y = 0
  while (x < a.length || y < b.length) {
    const left = x < a.length ? a[x] : Number.POSITIVE_INFINITY
    const right = y < b.length ? b[y] : Number.POSITIVE_INFINITY
    const next = left <= right ? left : right
    if (left <= right) x += 1
    else y += 1
    if (out.length === 0 || out[out.length - 1] !== next) out.push(next)
  }
  return out
}

/**
 * 旧工件 + 这一趟新解的 gram + 这一份该说的那组 id → 合并后的 parts。**纯函数**：不碰文件系统、
 * 不读真源——增量路上旧那一组真源一个字节都不读，靠的就是这一句。
 *
 * `keep` 是这一份该说的那组 id（可以带重复、顺序任意，与 `buildTrigram` 的输入同一条口径）；
 * `fresh.blobIds` 必须是它的一部分。**旧工件形状读不出语义的那三种输入当场抛
 * `ArtifactShapeError`**（字典不按键升序或有重复的键 · 同一个 gram 的顺序号不升序或越出旧 blob
 * 表 · postings 段的范围越出那一节）：它们过不了四问的头一问（今天的写者造不出这种字节），却是
 * 「静默合并出一份错的工件」唯一的入口——错的工件不会自己报错，所以宁可当场回头重建。调用方
 * 按类型把它们收成"这一趟走不通"（回全量），别的错照旧抛出去。
 *
 * 三条能逐字节对照全量重建的等式（`incremental.test.ts` 逐条量）：
 *
 *   一 · blob 表 = `keep` 升序去重（**旧表里没有的那些就是"丢掉"**）。
 *   二 · 每个 gram 的顺序号 = 旧那一份的顺序号**按 id 映射到新的位置**，与新解的那一份归并
 *        （丢掉的 blob 不给位置，它的贡献于是自然消失）。
 *   三 · 键集合 = 两路键的并；一个 gram 若映射之后一个顺序号都不剩，它就不在新工件里——
 *        少了这一条，删光一份 blob 之后旧 gram 会留下一串空 postings。
 *
 * 于是 `encodeTrigram(mergeTrigram(...))` 与同一组 blob 走 `buildTrigram` 编出来的字节相同：
 * 两边的 parts 是同一个值，而 `encodeTrigram` 是纯函数。**这是「增量 = 全量」的底**，不是一句
 * 愿望——旧的顺序号不原样搬，是按 id 重排过的。
 */
export function mergeTrigram(
  old: TrigramSections,
  fresh: TrigramParts,
  keep: readonly BlobId[],
  maxGrams: number = INDEX_LIMITS.grams,
): TrigramParts {
  const ids = [...new Set(keep)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const into = ordinalsInto(old.blobIds, ids)
  const intoFresh = ordinalsInto(fresh.blobIds, ids)
  for (const at of intoFresh) {
    if (at < 0) throw new Error('这一趟新解的那些 blob 不在这一份该说的那组 id 里')
  }
  /** 旧那一份的顺序号 → 新的位置；丢掉的不给位置。**越界与不升序当场抛**（不静默丢）。 */
  const remapOld = (list: readonly number[]): number[] => {
    const out: number[] = []
    let previous = -1
    for (const ordinal of list) {
      if (ordinal <= previous) throw new ArtifactShapeError(`旧工件的顺序号在同一个 gram 里不升序：${ordinal}`)
      previous = ordinal
      if (ordinal >= into.length) throw new ArtifactShapeError(`旧工件的顺序号越出了 blob 表：${ordinal}`)
      const at = into[ordinal]
      if (at >= 0) out.push(at)
    }
    return out
  }
  const remapFresh = (list: readonly number[]): number[] => list.map((ordinal) => intoFresh[ordinal])
  const oldRows = old.dict.byteLength / GRAM_RECORD_BYTES
  const grams: { gram: Trigram; ordinals: number[] }[] = []
  /** 收一条 gram。**一个顺序号都不剩的那条不收**（等式三）；越限在收的当场止住（与 `buildTrigram` 同一句）。 */
  const take = (gram: Trigram, ordinals: number[]): void => {
    if (ordinals.length === 0) return
    if (grams.length >= maxGrams) {
      throw new IndexBudgetExceeded('grams', `三字组数超过这一档的上限：${grams.length + 1} > ${maxGrams}`)
    }
    grams.push({ gram, ordinals })
  }
  /** 旧字典第 `at` 条那一段 postings：**范围越出那一节当场抛**，不静默读一段空字节。 */
  const oldListAt = (at: number): number[] => {
    const row = decodeGramRecord(old.dict, gramRecordOffset(at))
    if (row === null) throw new ArtifactShapeError(`旧工件的字典在第 ${at} 条上读不回来`)
    const end = endOf(old.dict, at, old.postings.byteLength)
    if (row.offset < 0 || row.offset > end || end > old.postings.byteLength) {
      throw new ArtifactShapeError(`旧工件第 ${at} 条的 postings 段越出了那一节`)
    }
    return remapOld(decodeOrdinals(old.postings.subarray(row.offset, end)))
  }

  let i = 0
  let j = 0
  let last = -1
  while (i < oldRows || j < fresh.grams.length) {
    const row = i < oldRows ? decodeGramRecord(old.dict, gramRecordOffset(i)) : null
    const added = j < fresh.grams.length ? fresh.grams[j] : null
    const oldKey = row === null ? Number.POSITIVE_INFINITY : row.gram
    const newKey = added === null ? Number.POSITIVE_INFINITY : added.gram
    // 两路都必须严格升序：字典按键升序是二分查找与这一趟归并共用的前提，重复的键没有唯一答案。
    if (oldKey <= last || newKey <= last) throw new ArtifactShapeError('旧工件的字典不是按键升序，或者出现了重复的键')
    if (oldKey < newKey) {
      take(oldKey, oldListAt(i))
      i += 1
      last = oldKey
      continue
    }
    if (newKey < oldKey) {
      take(newKey, remapFresh(added === null ? [] : added.ordinals))
      j += 1
      last = newKey
      continue
    }
    take(oldKey, mergedOrdinals(oldListAt(i), remapFresh(added === null ? [] : added.ordinals)))
    i += 1
    j += 1
    last = oldKey
  }
  // `textUnits` 是**这一趟解码出来的单元数**：旧那些的单元在增量路上没被解码过（读数，不进判据）。
  return { blobIds: ids, grams, textUnits: fresh.textUnits }
}
