// 搜索回执只存有限的行；未扫描的命中/遗漏字节数一律不猜。
import { MAX_RECEIPT_BYTES } from './receipt.ts'

// 给结果头、限制说明与运行时追加的步预算留余量，最终仍经过统一 capReceipt 出口。
const ROW_BYTES = MAX_RECEIPT_BYTES - 512
export const SEARCH_PREFETCH_ROWS = 32
export const SEARCH_PREFETCH_MAX_ROWS = 128

export interface SearchCoverage {
  readonly known: boolean
  readonly truncated: boolean
  readonly limits: readonly ('rows' | 'depth')[]
}

/** 不拆出整文件行数组，保留旧 grep split('\n') 的末尾空段和空文件一段语义。 */
export function* searchLines(text: string): Generator<{ readonly line: string; readonly number: number }> {
  let start = 0
  let number = 1
  while (start <= text.length) {
    const newline = text.indexOf('\n', start)
    if (newline === -1) { yield { line: text.slice(start), number }; return }
    yield { line: text.slice(start,newline), number }
    start = newline + 1
    number += 1
  }
}

function prefixBytes(text: string, limit: number): string {
  let bytes = 0
  let out = ''
  for (const char of text) {
    const length = Buffer.byteLength(char)
    if (bytes + length > limit) break
    out += char
    bytes += length
  }
  return out
}

export class SearchRows {
  private rows: string[] = []
  private bytes = 0
  private stopped = false
  private shortened = false
  private omitted = false

  /** 仅供候选预取提示；不是输入字节/内存预算。 */
  get fillRatio(): number { return this.bytes / ROW_BYTES }

  /** 返回 false 就停止扫描；第一条过长时仍给 UTF-8 完整前缀，并如实说明它缩短了。 */
  add(row: string): boolean {
    const length = Buffer.byteLength(row) + (this.rows.length === 0 ? 0 : 1)
    if (this.bytes + length > ROW_BYTES) {
      if (this.rows.length === 0) {
        const partial = prefixBytes(row,ROW_BYTES - Buffer.byteLength('…')) + '…'
        this.rows.push(partial)
        this.bytes = Buffer.byteLength(partial)
        this.shortened = true
      }
      this.stopped = true
      this.omitted = true
      return false
    }
    this.rows.push(row)
    this.bytes += length
    if (this.bytes === ROW_BYTES) {
      this.stopped = true
      return false
    }
    return true
  }

  render(label: 'lines'|'paths', empty: string, coverage: SearchCoverage): string {
    const partial = this.stopped || coverage.truncated || !coverage.known
    let output = this.rows.length === 0
      ? partial ? `0 ${label} shown.` : empty
      : `${this.rows.length} ${label}${partial ? ' shown' : ''}:\n${this.rows.join('\n')}`
    const notes: string[] = []
    if (this.stopped) notes.push(this.omitted
      ? 'Search stopped at the receipt budget; results are incomplete. Further matches are unknown. Narrow the pattern or path.'
      : 'Search stopped at the receipt budget; further matches and completeness are unknown. Narrow the pattern or path.')
    if (this.shortened) notes.push('Last result line shortened to a complete UTF-8 prefix.')
    if (coverage.truncated) notes.push(`Enumeration incomplete (${coverage.limits.join(', ')} limit); unvisited matches are unknown.`)
    if (!coverage.known) notes.push('Enumeration completeness unavailable: this host has no traversal-status capability.')
    if (notes.length > 0) output += '\n' + notes.join('\n')
    return output
  }
}
