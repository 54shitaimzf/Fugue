// `read` 的行窗口：**offset/limit 在工具面下推**。出处：架构 § 8.10 硬纪律 1（只公布能兑现的
// 选项——`read` 公布的 `offset`/`limit` 到这一站才有人接）· TARGETS `T16` ①「`read` 的
// offset/limit 下推」。
//
// **字节仍是整对象**（内容寻址的那层 LRU 取回来的就是那一份），省下来的是**解码与行切按窗口
// 付费**：只把选中那段交给解码器——不是"全量解码再 split"。`decodedBytes` 那一栏报的就是交给
// 解码器的字节数，它是这句的度量。
//
// **一次扫描，两件事一起做。** 回执头里的「L 行」统计的是**整个文件**，所以窗口再浅也得从头扫
// 一遍——那就顺便在这一次里把窗口的字节区间定下来（`total` 与 `first`/`last` 出自同一趟）。
// 于是窗口档总共只扫一遍：内容是"几兆的字节 + 一小段解码"。
//
// **扫行用 `Buffer.indexOf`（原生 memchr），不是 JS 逐字节循环**：这一条不是风格，是"深处的小窗
// 也比整读便宜"能不能成立的那一半。3 MB / 40000 行的语料上实测——逐字节循环 1.91 ms，`indexOf`
// 0.62 ms，整段 `toString('utf8')` 0.84 ms、再加一次 `split('\n')` 2.33 ms。于是窗口档（一遍
// 扫描 + 2 KB 解码）比整读（解码 + 数行 + 拼串）便宜；读数在 `tools/bench-walk-read.js` 的第四组。
//
// 三条口径（与 `receipt.lineCount` 同一把尺）：
//   · 末尾那个 LF 不另算一行；CRLF 的 CR 留在行内（`\n` 是唯一的分隔符）。
//   · 非法 UTF-8 按 `Buffer.toString('utf8')` 的替代字符。**切点落在 LF 上**，而 LF 不可能是
//     多字节序列的一部分——所以"按窗口切着解"与"整段解完再切"给出同一串文本。
//   · 行号是**原文件行号**（1-based）：窗口里每一行都带它，错一位就是引错行。

/**
 * 一窗的读数。`shown`/`first`/`last` 是这一窗的行号侧事实（空窗口三栏分别是 0/null/null）·
 * `total` 是**整个文件**的行数（回执头那一栏要它，与 `receipt.lineCountOfBytes` 同一把尺）·
 * `text` 是已经拼好的正文 · `decodedBytes` 是交给解码器的那几字节。
 */
export interface LineWindow {
  readonly shown: number
  readonly first: number | null
  readonly last: number | null
  readonly total: number
  readonly decodedBytes: number
  readonly text: string
}

const EMPTY = (total: number): LineWindow => ({ shown: 0, first: null, last: null, total, decodedBytes: 0, text: '' })

/**
 * 从 `bytes` 里取第 `offset` 行起的至多 `limit` 行（`limit: null` = 读到末尾），顺带报出整个
 * 文件的行数。
 *
 * 前提（调用方已经拒过坏参数）：`offset >= 1` 且 `limit === null || limit >= 0`，两者都是安全
 * 整数——所以这里不再防一次，窗口算术只做一件事。
 */
export function lineWindow(bytes: Uint8Array, offset: number, limit: number | null): LineWindow {
  const n = bytes.byteLength
  if (n === 0) return EMPTY(0)
  const want = limit === null ? Number.POSITIVE_INFINITY : limit
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, n)

  let at = 0 // 当前行的首字节
  let no = 1 // 当前行的行号
  let start = 0 // 窗口首行的首字节
  let end = 0 // 窗口末行的内容末（**不含**那个 LF）
  let shown = 0
  for (;;) {
    const nl = buf.indexOf(0x0a, at)
    // 末尾没有收尾 LF 的那一段也是一行；文件以 LF 收尾时最后那一次循环不是一行。
    if (nl !== -1 || at < n) {
      if (want > 0 && no >= offset && shown < want) {
        if (shown === 0) start = at
        end = nl === -1 ? n : nl
        shown += 1
      }
      no += 1
    }
    if (nl === -1) break
    at = nl + 1
  }
  // 行数就是走下来的那个计数（末尾那个 LF 不另算一行，所以 `no - 1` 就是行数）。
  const total = no - 1
  if (shown === 0) return EMPTY(total)

  // **只解这一段**：`byteOffset` 一起带进去（视图那边给回来的可能是某个大缓冲的视图）。
  const piece = buf.subarray(start, end)
  const parts = piece.toString('utf8').split('\n')
  return {
    shown,
    first: offset,
    last: offset + shown - 1,
    total,
    decodedBytes: piece.byteLength,
    text: parts.map((line, k) => `${offset + k}\t${line}`).join('\n'),
  }
}

/**
 * 回执头上那一句窗口标注（挂在原句尾上）：一行 · 多行 · 空窗口三档。
 *
 * **它是给模型看的**（走英文，与回执其余各栏同一档）：整档读不带标注也不带行号——整读的产物
 * 是 `edit`/`write` 的底稿，`old_string` 要逐字取自原文，每行一个 `N\t` 前缀是每行都付的剥离税。
 */
export function windowNote(w: LineWindow): string {
  if (w.shown === 0) return ' · no lines shown'
  if (w.shown === 1) return ` · line ${w.first} shown`
  return ` · lines ${w.first}–${w.last} shown`
}
