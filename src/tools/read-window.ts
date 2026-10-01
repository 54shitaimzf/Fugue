// read 的行窗口：先按 LF 找字节边界，后只解选中的那段 UTF-8。
// 原文件的字节/行数仍完整计；这不是 git 对象的范围读取，完整 blob 仍由读口取回。

export interface ReadWindow {
  /** 1-based；调用面验证为正的安全整数。 */
  readonly offset: number
  /** 缺省读到末尾；0 是空窗口。 */
  readonly limit?: number
}

export interface ReadText {
  readonly text: string
  readonly byteLength: number
  readonly lines: number
  readonly selectedLines: number
}

/**
 * LF 是 UTF-8 的单字节边界，因此选段不会劈开有效多字节字符。
 * 非法 UTF-8 仍按原 read 的 Buffer.toString('utf8') 替换，不改变整文件读法。
 * 末尾 LF 不另生一条空行，CRLF 里的 CR 原样保留。
 */
export function textWindowOf(bytes: Uint8Array, window: ReadWindow): ReadText {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let lines = 0
  let start = 0
  let selectedStart = -1
  let selectedEnd = -1
  let selectedLines = 0
  while (start < buffer.byteLength) {
    const newline = buffer.indexOf(0x0a, start)
    const end = newline === -1 ? buffer.byteLength : newline
    lines += 1
    if (lines >= window.offset && (window.limit === undefined || selectedLines < window.limit)) {
      if (selectedStart === -1) selectedStart = start
      selectedEnd = end
      selectedLines += 1
    }
    start = end + 1
  }
  return {
    text: selectedStart === -1 ? '' : buffer.toString('utf8', selectedStart, selectedEnd),
    byteLength: bytes.byteLength,
    lines,
    selectedLines,
  }
}

/** 只给窗口内的行加原文件行号；空窗口不虚构一条空行。 */
export function numberedWindowOf(got: ReadText, offset: number): string {
  if (got.selectedLines === 0) return ''
  return got.text.split('\n').map((line, index) => `${offset + index}\t${line}`).join('\n')
}
