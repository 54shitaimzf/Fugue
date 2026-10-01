// Worker 只拿实际 byte window；借用 Buffer 的整块 backing store 可能包含其它数据。
import { MAX_SOURCE_BYTES } from './index-format.ts'
export function copyIndexSource(bytes: Uint8Array): Uint8Array | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_SOURCE_BYTES) return null
  return Uint8Array.from(bytes)
}
