// 搜索回执只存有限的行；未扫描的命中/遗漏字节数一律不猜。
import { MAX_RECEIPT_BYTES } from './receipt.ts'

export const SEARCH_PREFETCH_ROWS = 32
export const SEARCH_PREFETCH_MAX_ROWS = 128

/**
 * 四条说明的原文**各自一处**。它们不是散在 `render` 里的字面量，因为行预算的留量要照着它们
 * 算（见 `SEARCH_ROW_BYTES`）——留量一旦是拍出来的，改一句措辞就能悄悄把回执挤出 8 KiB。
 */
const NOTE_STOPPED_KNOWN = (rest: number | string, label: string): string =>
  `Search stopped at the receipt budget; ${rest} more ${label} are not shown. Narrow the pattern or path.`
const NOTE_STOPPED_OMITTED =
  'Search stopped at the receipt budget; results are incomplete. Further matches are unknown. Narrow the pattern or path.'
const NOTE_STOPPED_EXACT =
  'Search stopped at the receipt budget; further matches and completeness are unknown. Narrow the pattern or path.'
const NOTE_SHORTENED = 'Last result line shortened to a complete UTF-8 prefix.'
const NOTE_INCOMPLETE = (limits: readonly string[]): string =>
  `Enumeration incomplete (${limits.join(', ')} limit); unvisited matches are unknown.`
const NOTE_UNKNOWN = 'Enumeration completeness unavailable: this host has no traversal-status capability.'

/**
 * 计数那几栏留几位数字。今天的枚举上限是 5,000 条（`host.ts` 的 `MAX_ROWS`），留 7 位
 * （一千万条）——这一层不 import 那个常量（它是 host 的私事），所以写明留量而不是跟着它走。
 */
const WIDEST_COUNT = '9'.repeat(7)

/** 说明块最长那一份：四条全上，每条前面一个换行（`render` 就是这么拼的）。 */
const MAX_NOTE_BYTES = [
  Math.max(
    Buffer.byteLength(NOTE_STOPPED_KNOWN(WIDEST_COUNT, 'paths')),
    Buffer.byteLength(NOTE_STOPPED_OMITTED),
    Buffer.byteLength(NOTE_STOPPED_EXACT),
  ),
  Buffer.byteLength(NOTE_SHORTENED),
  Buffer.byteLength(NOTE_INCOMPLETE(['rows', 'depth'])),
  Buffer.byteLength(NOTE_UNKNOWN),
].reduce((n, b) => n + 1 + b, 0)

/** 结果头最长那一份：`N of M paths shown:` 加它后面那个换行。 */
const MAX_HEADER_BYTES = Buffer.byteLength(`${WIDEST_COUNT} of ${WIDEST_COUNT} paths shown:\n`)

/**
 * 运行时在回执**后面**追加的那一句留多少（`src/round/driver.ts` 的 `withStepsLeft` 与
 * `src/round/plan.ts` 的 `holderFace` 各追加一次 `stepsLeftTail`，然后再过一次 `capReceipt`）。
 *
 * 那一句不在这一层，所以这里留一个常量，由 `search-stop.test.ts` 对着**两处真正的收工句子**
 * 核一遍（今天最长那一份是 220 字节：`AGENT_LAND_NOW` 配三个七位数）。
 */
export const MAX_RUNTIME_TAIL_BYTES = 256

/**
 * 结果行那一段的预算。**它是算出来的，不是拍出来的**：原先写 `MAX_RECEIPT_BYTES - 512`，而
 * 最坏情况下（头 + 四条说明 + 运行时那一句）已经会越界——实测只剩 42 字节余量，任何一句措辞
 * 加长就把搜索回执挤到 `capReceipt` 去中段截掉，**而那正是这一单元声称要避免的那件事**；
 * 更要紧的是没有任何测试能发现它，因为所有字节断言都落在追加那一句**之前**的 face 输出上。
 */
export const SEARCH_ROW_BYTES = MAX_RECEIPT_BYTES - (MAX_NOTE_BYTES + MAX_HEADER_BYTES + MAX_RUNTIME_TAIL_BYTES)

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
    if (this.bytes + length > SEARCH_ROW_BYTES) {
      if (this.rows.length === 0) {
        const partial = prefixBytes(row,SEARCH_ROW_BYTES - Buffer.byteLength('…')) + '…'
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
    if (this.bytes === SEARCH_ROW_BYTES) {
      this.stopped = true
      return false
    }
    return true
  }

  /**
   * `total` 是**确实知道的那个命中总数**，不知道就给 `null`。
   *
   * `glob` 只配路径、一个文件都不读，所以枚举完整时总数是白捡的——把可知的数说成 unknown 与
   * 这一单元"不猜未知、也不把已知说成未知"的立意相反，而且模型就此丢掉了「这个模式一共匹配
   * 5000 条、我该收紧」这个最有用的信号。`grep` 的 `content` / `count` / `files_with_matches`
   * 仍然给 `null`：不读完文件确实不知道还有多少命中。
   */
  render(label: 'lines'|'paths', empty: string, coverage: SearchCoverage, total: number | null = null): string {
    const rest = total === null ? null : Math.max(0, total - this.rows.length)
    // 知道总数时「截没截」由数说话；不知道就只能按「扫到预算了吗」说。
    const partial = this.shortened || coverage.truncated || !coverage.known || (rest === null ? this.stopped : rest > 0)
    let output = this.rows.length === 0
      ? partial ? `0 ${label} shown.` : empty
      : rest !== null && rest > 0
        ? `${this.rows.length} of ${total} ${label} shown:\n${this.rows.join('\n')}`
        : `${this.rows.length} ${label}${partial ? ' shown' : ''}:\n${this.rows.join('\n')}`
    const notes: string[] = []
    // `rest === 0` 是"总数已知而且一条都没少"：那一档没有"还剩多少"可说。
    if (this.stopped && rest !== 0) {
      notes.push(rest !== null
        ? NOTE_STOPPED_KNOWN(rest, label)
        : this.omitted ? NOTE_STOPPED_OMITTED : NOTE_STOPPED_EXACT)
    }
    if (this.shortened) notes.push(NOTE_SHORTENED)
    if (coverage.truncated) notes.push(NOTE_INCOMPLETE(coverage.limits))
    if (!coverage.known) notes.push(NOTE_UNKNOWN)
    if (notes.length > 0) output += '\n' + notes.join('\n')
    return output
  }
}
