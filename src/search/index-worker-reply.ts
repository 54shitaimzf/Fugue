// 复用Worker的回执只归当前nonce；不把迟到/坏形状当成有效排除表。
import { MAX_INDEX_BYTES, MAX_TRIGRAMS } from './index-format.ts'
export interface IndexWorkerReply {
  readonly grams: ReadonlySet<number>
  readonly serializedBytes: number
  readonly stored: boolean
}
export function decodeIndexWorkerReply(message: unknown, temporaryId: string): IndexWorkerReply | null {
  if (message === null || typeof message !== 'object') return null
  const row = message as Record<string, unknown>
  if (row.temporaryId !== temporaryId || row.ok !== true || typeof row.stored !== 'boolean' ||
      !(row.keys instanceof Float64Array) || row.keys.length > MAX_TRIGRAMS ||
      !Number.isSafeInteger(row.serializedBytes) || (row.serializedBytes as number) < 0 ||
      (row.serializedBytes as number) > MAX_INDEX_BYTES) return null
  let previous = -1
  for (const key of row.keys) {
    if (!Number.isSafeInteger(key) || key < 0 || key > 0xffff_ffff_ffff || key <= previous) return null
    previous = key
  }
  return { grams: new Set(row.keys), serializedBytes: row.serializedBytes as number, stored: row.stored }
}

/** 确定性的构建失败（超预算）：同样的字节永远同样的结果，调用方可以记住不再重读重建。 */
export function isUnindexableReply(message: unknown, temporaryId: string): boolean {
  if (message === null || typeof message !== 'object') return false
  const row = message as Record<string, unknown>
  return row.temporaryId === temporaryId && row.ok === false && row.unindexable === true
}
