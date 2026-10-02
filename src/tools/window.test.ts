// T16 ① 的第二半：**`read` 的 offset/limit 下推（行窗口）**。出处：TARGETS `T16` ① ·
// ROADMAP § 3 里"read 的 offset/limit 下推"那一行 · 架构 § 8.10 硬纪律 1（公布了就要有人接）。跑法：
// cd ~/fugue && node --test src/tools/window.test.ts
//
//   ① 等价组（本单元的主断言）：一份覆盖语料 × 一窗矩阵——字节窗口的结果 === 字符串侧独立参照
//      （整段解码 → `split('\n')` → 切片 → 拼回）。参照写在测试里，与被测实现**不同源**。
//   ② 行号是**原文件行号**：错一位就是引错行（等价组抓得住，这里再点名断一次）。
//   ③ 只解码选中段：几兆的语料上取深处一个小窗，交给解码器的字节数是那一窗的大小。
//   ④ 两把尺同一个数：字节侧行数（`lineCountOfBytes`）与字符串侧（`lineCount`）逐份语料相等。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lineCount, lineCountOfBytes } from './receipt.ts'
import { lineWindow, windowNote } from './window.ts'

const bytesOf = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'))

/** 把这份字节放到一段大缓冲的中间（**非零 `byteOffset`**——git 批量流那边给回来的就是这个形状）。 */
function insideABiggerBuffer(inner: Uint8Array, pad = 7): Uint8Array {
  const buf = new Uint8Array(inner.byteLength + pad * 2)
  buf.set(inner, pad)
  return buf.subarray(pad, pad + inner.byteLength)
}

interface Sample {
  readonly name: string
  readonly bytes: Uint8Array
}

/** 覆盖语料：多行带尾换行 · 无尾换行 · CRLF · 中文多字节 · 空文件 · 单行 · 非法 UTF-8 · 子数组。 */
const CORPUS: readonly Sample[] = [
  { name: '多行带尾换行', bytes: bytesOf('a\nb\nc\nd\n') },
  { name: '无尾换行', bytes: bytesOf('a\nb\nc') },
  { name: 'CRLF', bytes: bytesOf('a\r\nb\r\nc\r\n') },
  { name: '中文多字节', bytes: bytesOf('第一行\n第二行你好\n第三行🌱\n') },
  { name: '空文件', bytes: new Uint8Array(0) },
  { name: '单行', bytes: bytesOf('only') },
  { name: '单个换行', bytes: bytesOf('\n') },
  { name: '连续空行', bytes: bytesOf('a\n\n\nb\n') },
  { name: '非法 UTF-8 字节', bytes: new Uint8Array([0x61, 0x0a, 0xff, 0xfe, 0x0a, 0x62, 0xe4, 0xbd, 0x0a]) },
  { name: '非零 byteOffset 的子数组', bytes: insideABiggerBuffer(bytesOf('头\n中\n尾\n')) },
]

/** 窗口矩阵：首 · 中 · 尾 · 越过尾 · limit 0 · limit 1 · limit 超余 · 只给一项。 */
const WINDOWS: readonly { readonly offset: number; readonly limit: number | null }[] = [
  { offset: 1, limit: null },
  { offset: 1, limit: 0 },
  { offset: 1, limit: 1 },
  { offset: 1, limit: 2 },
  { offset: 1, limit: 99 },
  { offset: 2, limit: null },
  { offset: 2, limit: 2 },
  { offset: 3, limit: null },
  { offset: 3, limit: 1 },
  { offset: 4, limit: 5 },
  { offset: 9, limit: null },
  { offset: 9, limit: 0 },
]

/**
 * **一份不同源的参照**：整段解码 → `split('\n')` → 切片 → 按本计划 § 5 的语义拼回。
 *
 * 它与被测那一份没有共用一行代码——两边都错才不会互相遮住。
 */
function referenceWindow(
  bytes: Uint8Array,
  offset: number,
  limit: number | null,
): {
  readonly shown: number
  readonly first: number | null
  readonly last: number | null
  readonly total: number
  readonly text: string
} {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')
  const all = text === '' ? [] : text.split('\n')
  if (text.endsWith('\n')) all.pop()
  const from = offset - 1
  const rest = Math.max(0, all.length - from)
  const n = limit === null ? rest : Math.min(limit, rest)
  const picked = n <= 0 ? [] : all.slice(from, from + n)
  return {
    shown: picked.length,
    first: picked.length === 0 ? null : offset,
    last: picked.length === 0 ? null : offset + picked.length - 1,
    total: all.length,
    text: picked.map((line, k) => `${offset + k}\t${line}`).join('\n'),
  }
}

test('① 等价组：覆盖语料 × 窗口矩阵，字节窗口的结果 === 字符串侧独立参照', () => {
  let checked = 0
  for (const one of CORPUS) {
    for (const w of WINDOWS) {
      const got = lineWindow(one.bytes, w.offset, w.limit)
      const want = referenceWindow(one.bytes, w.offset, w.limit)
      const where = `${one.name} offset=${w.offset} limit=${String(w.limit)}`
      assert.equal(got.shown, want.shown, `${where}：显示的行数`)
      assert.equal(got.first, want.first, `${where}：首行行号`)
      assert.equal(got.last, want.last, `${where}：末行行号`)
      // **整个文件的行数**（回执头那一栏）：一次扫描顺带数出来的，与字符串侧参照同一个数。
      assert.equal(got.total, want.total, `${where}：整个文件的行数`)
      assert.equal(got.text, want.text, `${where}：正文`)
      assert.equal(windowNote(got).includes('no lines shown'), want.shown === 0, `${where}：空窗口那一句标注`)
      checked += 1
    }
  }
  assert.equal(checked, CORPUS.length * WINDOWS.length)
  // 三档标注逐字（多行那一档是**连接号**，不是减号）。
  assert.equal(windowNote({ shown: 0, first: null, last: null, total: 4, decodedBytes: 0, text: '' }), ' · no lines shown')
  assert.equal(windowNote({ shown: 1, first: 7, last: 7, total: 9, decodedBytes: 3, text: '' }), ' · line 7 shown')
  assert.equal(windowNote({ shown: 3, first: 7, last: 9, total: 9, decodedBytes: 9, text: '' }), ' · lines 7–9 shown')
  console.log(`① 读数：${CORPUS.length} 份语料 × ${WINDOWS.length} 个窗口 = ${checked} 组，逐组与参照相同`)
})

test('② 行号是原文件行号（不是窗口内序号）：中段那一窗逐字看一遍', () => {
  const w = lineWindow(bytesOf('a\nb\nc\nd\ne\n'), 3, 2)
  assert.equal(w.text, '3\tc\n4\td', `窗口里的行号该是原文件的 3 与 4：${JSON.stringify(w.text)}`)
  assert.equal(w.first, 3)
  assert.equal(w.last, 4)
  // 只给 offset：读到末尾，行号照样是原文件那一串。
  assert.equal(lineWindow(bytesOf('a\nb\nc\n'), 2, null).text, '2\tb\n3\tc')
  // CRLF：CR 留在行内（`\r` 不是分隔符），行号照旧。
  assert.equal(lineWindow(bytesOf('a\r\nb\r\n'), 1, 2).text, '1\ta\r\n2\tb\r')
  console.log(`② 读数：offset=3 limit=2 → ${JSON.stringify(w.text)}`)
})

test('③ 只解码选中段：几兆的语料上取深处一个小窗', () => {
  const lines = 40000
  const text = Array.from({ length: lines }, (_, i) => `第 ${i + 1} 行：一份够长的语料，好让它真的超过两兆字节。`).join('\n') + '\n'
  const bytes = bytesOf(text)
  assert.ok(bytes.byteLength > 2_000_000, `语料要够大：${bytes.byteLength} 字节`)

  const w = lineWindow(bytes, lines - 1, 1)
  assert.equal(w.shown, 1)
  assert.equal(w.first, lines - 1)
  assert.equal(w.text, `${lines - 1}\t第 ${lines - 1} 行：一份够长的语料，好让它真的超过两兆字节。`)
  // **这一句就是"只解码选中段"**：整份两兆多，交给解码器的只有那一行。
  assert.ok(w.decodedBytes < 256, `交给解码器的那一段该只有那一行：实际 ${w.decodedBytes} 字节（整份 ${bytes.byteLength}）`)
  assert.equal(w.total, lines, '整个文件的行数是这一次扫描顺带数出来的（窗口再浅也要它）')
  assert.equal(lineCountOfBytes(bytes), lines, '整份的行数照样数得出来（数 LF，不解码）')
  console.log(`③ 读数：语料 ${bytes.byteLength} 字节 / ${lines} 行 · 一行的窗口交给解码器 ${w.decodedBytes} 字节`)
})

test('④ 两把尺同一个数：字节侧行数 === 字符串侧行数（逐份语料）', () => {
  for (const one of CORPUS) {
    const text = Buffer.from(one.bytes.buffer, one.bytes.byteOffset, one.bytes.byteLength).toString('utf8')
    assert.equal(
      lineCountOfBytes(one.bytes),
      lineCount(text),
      `${one.name}：字节侧数出 ${lineCountOfBytes(one.bytes)} 行，字符串侧数出 ${lineCount(text)} 行`,
    )
  }
  // 负对照：两把尺真的是两把——把"末尾 LF 不另算"这一条只在一边去掉，当场分家。
  assert.equal(lineCountOfBytes(bytesOf('a\n')), 1)
  assert.notEqual(bytesOf('a\n').byteLength, 1, '先确认这段字节不止一个字节')
  console.log(`④ 读数：${CORPUS.length} 份语料上两把尺逐份相同（含非法 UTF-8 与空文件）`)
})
