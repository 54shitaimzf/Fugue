// ROADMAP § 4 / 0.3.1 · 不可变 blob 的派生索引格式；不接查询，不扩展真源契约。
import { createHash } from 'node:crypto'
import type { BlobId } from '../terms.ts'

export const INDEX_VERSION = 1
export const MAX_INDEX_BYTES = 8 * 1024 * 1024
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024
export const MAX_TRIGRAMS = 200_000

export interface BlobIndex {
  readonly format: 'fugue-blob-trigrams'
  readonly version: 1
  readonly blob: BlobId
  readonly sourceBytes: number
  readonly textUnits: number
  readonly tables: {
    /** 三个 UTF-16 code units，排序、去重；与 JS grep 的解码/正则语言相同。 */
    readonly trigrams: readonly string[]
    /** T1 尚未解禁：只留表位，不抽取、推断或查询符号。 */
    readonly symbols: null
  }
}

function isBlobId(id: unknown): id is BlobId {
  return typeof id === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)
}
function boundedCount(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

/** 验证形状与格式约束；内容正确性来自构建时的真实 blob，校验和不提供来源认证。 */
function valid(value: unknown): value is BlobIndex {
  if (value === null || typeof value !== 'object') return false
  const index = value as BlobIndex
  if (index.format !== 'fugue-blob-trigrams' || index.version !== INDEX_VERSION || !isBlobId(index.blob)) return false
  if (!boundedCount(index.sourceBytes, MAX_SOURCE_BYTES) || !boundedCount(index.textUnits, index.sourceBytes)) return false
  if ((index.sourceBytes === 0) !== (index.textUnits === 0)) return false
  const tables = index.tables
  if (tables === null || typeof tables !== 'object' || tables.symbols !== null || !Array.isArray(tables.trigrams)) return false
  if (tables.trigrams.length > MAX_TRIGRAMS || tables.trigrams.length > Math.max(0, index.textUnits - 2)) return false
  if (index.textUnits >= 3 && tables.trigrams.length === 0) return false
  let previous: string | undefined
  for (const gram of tables.trigrams) {
    if (typeof gram !== 'string' || gram.length !== 3 || (previous !== undefined && previous >= gram)) return false
    previous = gram
  }
  return true
}

function payloadOf(index: BlobIndex): BlobIndex {
  // 固定字段顺序，丢掉任何原型/扩展字段；解码时完整字节比较会拒绝额外字段。
  return { format: 'fugue-blob-trigrams', version: 1, blob: index.blob,
    sourceBytes: index.sourceBytes, textUnits: index.textUnits,
    tables: { trigrams: [...index.tables.trigrams], symbols: null } }
}

export function buildBlobIndex(blob: BlobId, bytes: Uint8Array): BlobIndex {
  if (!isBlobId(blob)) throw new Error('index requires a complete lowercase Git blob ID')
  if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('index source byte budget exceeded')
  const source = Buffer.from(bytes)
  const hash = createHash(blob.length === 40 ? 'sha1' : 'sha256')
  hash.update(`blob ${source.byteLength}\0`)
  hash.update(source)
  if (hash.digest('hex') !== blob) throw new Error('index source does not match its Git blob ID')
  // 必须先按 grep 同一条路解码。原始字节的 trigram 会漏掉非法 UTF-8 的替换字符。
  const text = source.toString('utf8')
  // 三个UTF-16单元恰好48位，仍在Number精确整数范围内。
  // 只为唯一项造字符串，避免给源文本每个位置分配slice。
  const grams = new Set<number>()
  for (let at = 0; at + 2 < text.length; at++) {
    grams.add(text.charCodeAt(at) * 0x1_0000_0000 + text.charCodeAt(at + 1) * 0x1_0000 + text.charCodeAt(at + 2))
    if (grams.size > MAX_TRIGRAMS) throw new Error('index trigram budget exceeded')
  }
  return { format: 'fugue-blob-trigrams', version: 1, blob, sourceBytes: source.byteLength,
    textUnits: text.length, tables: { trigrams: [...grams].sort((a, b) => a - b).map((key) =>
      String.fromCharCode(Math.floor(key / 0x1_0000_0000), Math.floor(key / 0x1_0000) % 0x1_0000, key % 0x1_0000)), symbols: null } }
}

export function encodeBlobIndex(index: BlobIndex): Uint8Array {
  if (!valid(index)) throw new Error('invalid blob index shape')
  const payload = payloadOf(index)
  const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const encoded = Buffer.from(`${JSON.stringify({ ...payload, checksum })}\n`, 'utf8')
  if (encoded.byteLength > MAX_INDEX_BYTES) throw new Error('encoded index byte budget exceeded')
  return encoded
}

/** 损坏、不同版本/对象、未知形状都是 miss。调用方必须回扫描或重建，不影响真源。 */
export function decodeBlobIndex(bytes: Uint8Array, expectedBlob: BlobId): BlobIndex | null {
  if (!isBlobId(expectedBlob) || bytes.byteLength > MAX_INDEX_BYTES) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
    if (!valid(parsed) || parsed.blob !== expectedBlob) return null
    const index = payloadOf(parsed)
    // 核校验和、严格字段面/次序、重复键、排序与唯一性；不是对构建来源的认证。
    if (!Buffer.from(encodeBlobIndex(index)).equals(Buffer.from(bytes))) return null
    return index
  } catch {
    return null
  }
}
