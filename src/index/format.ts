// 索引的落盘容器格式。出处：ROADMAP § 4 的「索引落盘格式」那一行与 § 9 的「索引在盘格式（带版本号）」那一格；
// 目标是 TARGETS `T16` ②（blob 键控 trigram 索引，住 `.fugue/idx/`）。
//
// **这一份只有容器，没有语义。** 它认识的是"头部 + 节表 + 若干节"，不认识三字组、不认识
// postings、不认识顺序号——那些在 `trigram.ts`。分成两份的理由与 `roots/paths.ts` 和
// `roots/roots.ts` 分批的理由是同一条：换掉任何一份都不动另一份。
//
// 形状（全部小端）：
//
//   头部 16 字节
//     0   8   魔数 `FUGUEIDX`
//     8   4   格式版本 u32
//     12  4   节数 u32
//   节表 节数 × 56 字节，紧接头部
//     0   4   节类型 u32（`SECTION` 那一张表）
//     4   4   节编码 u32（`CODEC` 那一张表；认不出的编码 = 这一节读不回来）
//     8   8   节体起点 u64（相对文件头）
//     16  8   节体长度 u64
//     24  32  节体摘要 sha256
//   各节体依次相接
//
// 四条口径：
//
//   一 · **版本号住头部，认不出的版本当损坏。** `decodeIndexHeader` 给 `null`，不硬读：
//        调用方拿到 `null` 就重建（`store.ts` 的退化档），不猜。
//   二 · **摘要按节算，不按整份算。** 这是"固定开销瘦身"那条路的硬前提：要拿一个三字组的
//        计数只需读它所在的那一节，代价与读了多少字节成正比。整份一个摘要的话，读任何一节
//        都得先通读全文，那条路当场堵死。sha256 的常数代价因此只落在真正读到的字节上。
//   三 · **节表按类型找，顺序不是语义。** 谁先写、哪一节排在前，都不影响读到的东西——
//        `symbols`（`T1` 解禁时要加的那张表）作为第四节插进来时，既有三节的字节与读法一个
//        不动，变的只有版本号。扩展位就是这张带类型的表本身。
//   四 · **工件的每一个字节都要被查过。** 头部三栏由魔数、版本、节数决定；节表每一行由类型、
//        编码、范围与摘要决定；节体由摘要决定。于是"改动任意一个字节"与"读得回来"不会同时
//        成立——`format.test.ts` 逐字节验这一条。为此**不留"写 0 就行"的填空位**：那种位是
//        唯一能悄悄改掉语义、又不惊动任何判据的角落。
import { createHash } from 'node:crypto'

/** 魔数：认得出这份文件是什么。**长度写进常数**，读的一侧不数第二遍。 */
export const INDEX_MAGIC = 'FUGUEIDX'
export const INDEX_MAGIC_BYTES = 8
/**
 * 容器格式的版本。**语义一变就跳它**；读的一侧只认这一个值，认不出的一律当损坏。
 *
 * 跳它的两个时机：前三节里任何一节的编码或形状变了 · 某张今天可选的新表变成必须有的。
 * 只是"多带了一张表"不跳——那由节表按类型找这条性质接住。
 *
 * **跳过的两次**：0.3.1 起是 1；0.3.4 ⑥ 把字典记录从 18 字节收到 13 字节（计数 u24 · 偏移 u32），
 * 于是 2。盘上那些 1 的工件**按损坏处理**（上面那条口径），调用方回全量重建——迁移动作就是这一条，
 * 不必另写一段读旧格式的代码，也不必在盘上留两份。
 */
export const INDEX_VERSION = 2
export const HEADER_BYTES = 16
export const SECTION_ENTRY_BYTES = 56
export const DIGEST_BYTES = 32

/**
 * 节类型。**读者按类型找节，认不出的类型跳过**——"加一张表不惊动既有语义"落在字节上就是
 * 这一条。
 */
export const SECTION = {
  /** 顺序号 → blob id。 */
  blobs: 1,
  /** 三字组 → 计数与 postings 那一段在哪儿。**定宽、按键升序**，所以二分查找能按字节偏移做。 */
  dict: 2,
  /** 各三字组的 postings 依次相接（差分 + varint）。 */
  postings: 3,
  /**
   * "符号 → 位置"那一类表的预留号（TARGETS `T1` 解禁时才有写入者）。
   * **今天没有任何一份工件带它**；留着这个号，是为了那张表落地时只跳版本号、不动前三节。
   */
  symbols: 4,
} as const

/** 节体的编码。今天只有一种；认不出的编码 = 这一节读不回来（当损坏，不硬读）。 */
export const CODEC = { raw: 1 } as const

export interface SectionInput {
  readonly kind: number
  readonly codec: number
  readonly body: Uint8Array
}

export interface SectionRef {
  readonly kind: number
  readonly codec: number
  readonly offset: number
  readonly length: number
  readonly digest: Uint8Array
}

export interface IndexHeader {
  readonly version: number
  readonly sections: readonly SectionRef[]
}

export interface IndexParts {
  readonly sections: readonly SectionInput[]
}

/** 节体摘要。**按节算**（文件头那条口径二）。 */
export function digestOf(bytes: Uint8Array): Uint8Array {
  return createHash('sha256').update(bytes).digest()
}

/** 两段字节相同吗。摘要比对与读回比对共用这一处。 */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

/** 头部加节表占多少字节——**给按偏移读的那条路用**（`store.ts` 只读这一段就能开一份索引）。 */
export function indexHeadBytes(sectionCount: number): number {
  return HEADER_BYTES + sectionCount * SECTION_ENTRY_BYTES
}

/**
 * 编一份工件。**节的顺序就是传进来的顺序**（顺序不是语义，见口径三），节体依次相接。
 *
 * 版本号不由调用方给：能写出来的只有当前版本这一种。要造一个"认不出的版本"，把字节改掉
 * 再说——那样量到的才是读者那一侧的判断，不是写者被吩咐去撒谎。
 */
export function encodeIndex(parts: IndexParts): Uint8Array {
  const count = parts.sections.length
  let total = indexHeadBytes(count)
  for (const s of parts.sections) total += s.body.byteLength
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  for (let i = 0; i < INDEX_MAGIC_BYTES; i++) out[i] = INDEX_MAGIC.charCodeAt(i)
  view.setUint32(8, INDEX_VERSION, true)
  view.setUint32(12, count, true)
  let at = indexHeadBytes(count)
  for (let i = 0; i < count; i++) {
    const s = parts.sections[i]
    const row = HEADER_BYTES + i * SECTION_ENTRY_BYTES
    view.setUint32(row, s.kind, true)
    view.setUint32(row + 4, s.codec, true)
    view.setBigUint64(row + 8, BigInt(at), true)
    view.setBigUint64(row + 16, BigInt(s.body.byteLength), true)
    out.set(digestOf(s.body), row + 24)
    out.set(s.body, at)
    at += s.body.byteLength
  }
  return out
}

/**
 * 读头部与节表。**认不出、放不下、对不上，一律 `null`**——调用方按损坏处理。
 *
 * 这里不认识的只有容器这一层：版本、魔数、节表形状、类型重复。**哪几节是必须有的由上层说**
 * （`trigram.ts` 认前三节）——容器不该知道索引需要三字组。
 *
 * 第二个参数是**整份文件有多大**，给"只读了头部与节表"的那条路用（`store.ts` 的句柄：打开
 * 一份索引只读这两段，节体按需再读）。缺省就是手里这段字节的长度——整份读回来那一侧照旧。
 */
export function decodeIndexHeader(bytes: Uint8Array, fileBytes: number = bytes.byteLength): IndexHeader | null {
  if (bytes.byteLength < HEADER_BYTES) return null
  for (let i = 0; i < INDEX_MAGIC_BYTES; i++) if (bytes[i] !== INDEX_MAGIC.charCodeAt(i)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(8, true)
  if (version !== INDEX_VERSION) return null
  const count = view.getUint32(12, true)
  // 三个字段之外没有第四样可读的东西，所以"节表放得下"就是这一条的全部判据。
  if (count === 0 || indexHeadBytes(count) > bytes.byteLength) return null
  const sections: SectionRef[] = []
  const seen = new Set<number>()
  for (let i = 0; i < count; i++) {
    const row = HEADER_BYTES + i * SECTION_ENTRY_BYTES
    const kind = view.getUint32(row, true)
    const codec = view.getUint32(row + 4, true)
    const offset = Number(view.getBigUint64(row + 8, true))
    const length = Number(view.getBigUint64(row + 16, true))
    // 同一个类型出现两次，"按类型找"就没有唯一的答案——那不是一个可读的形状。
    if (seen.has(kind)) return null
    seen.add(kind)
    // 节体只能落在节表之后、文件之内。两条一起判，"表中表"与"越过末尾"都当场落空。
    if (offset < indexHeadBytes(count) || offset + length > fileBytes) return null
    sections.push({ kind, codec, offset, length, digest: bytes.slice(row + 24, row + 24 + DIGEST_BYTES) })
  }
  // **节体把文件铺满，不留缝。** 按起点排一遍，要求第一段紧接节表、段段相接、末段正好到末尾
  // ——于是文件里每一个字节要么在头部与节表里，要么在某一个被声明过的节体里，没有"没人认领"
  // 的尾巴。少了这一条，把节数由 4 改成 3 就能留下一段谁也不看的字节而整份照旧读得回来
  // （`format.test.ts` ③ 那一格当场抓到过）。
  const byOffset = [...sections].sort((a, b) => a.offset - b.offset)
  let at = indexHeadBytes(count)
  for (const s of byOffset) {
    if (s.offset !== at) return null
    at += s.length
  }
  if (at !== fileBytes) return null
  return { version, sections }
}

/** 按类型找一节。**找不到给 `null`**（"没带这一节"与"带了但读不了"由调用方分开判）。 */
export function sectionRefOf(header: IndexHeader, kind: number): SectionRef | null {
  for (const s of header.sections) if (s.kind === kind) return s
  return null
}

/**
 * 从整份字节里取一节的节体，**顺带按摘要核对**。对不上给 `null`。
 *
 * 给回来的是那块字节里的一个视图（不拷贝）——它是只读用的；要留住的内容由调用方自己拷。
 * 按偏移读的那条路（`store.ts` 的句柄）不走这里，但核对的判据是同一句（`digestOf` 比对）。
 */
export function sectionBody(bytes: Uint8Array, ref: SectionRef): Uint8Array | null {
  if (ref.codec !== CODEC.raw) return null
  const body = bytes.subarray(ref.offset, ref.offset + ref.length)
  if (body.byteLength !== ref.length) return null
  return sameBytes(digestOf(body), ref.digest) ? body : null
}
