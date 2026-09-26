// 回执的上界：**模型看到的每一个字节都要么是它该看的，要么是实话**（PLAN § 5.17 处一）。
//
// **为什么要有这一层**：`read` 整文件 · `grep` 全命中 · `bash` 全量 stdout/stderr 原先一字节不截
// 地灌进 C 区，而 C 区**只追加**（架构 § 8.11）——一次大输出就把前缀账与注意力一起打爆，而且它
// 留在后续每一步的视野里，每一步都重付一遍缓存写。
//
// **四个口定死在 PLAN § 5.17 那一段里，这一份就是它们的实现**：
//
//   · 上限与比例：单条回执 8 KiB；头 4 KiB · 尾 4 KiB，中段略去。
//   · 标记逐字：`\n…（中段略去 M 字节 · 全文共 N 字节 L 行）…\n`，头与尾之间就夹这一句；
//     M · N · L 按**原文**计。
//   · UTF-8 边界：切点落在多字节序列中间就**回退到上一个完整字符**——半个汉字不许出现在回执里。
//   · 切在**回执那一层**：文本工具统一走一个 `capReceipt(text)`。host 的字节层不懂文本，
//     不该它切（`read_image` 取字节那条路不受影响）。
//
// **上限与切法是架构的常量，不给模型选**（规则 2：有判据处的判断归架构）。截断之后那份字节
// 就是模型看到的全部事实——标记本身不许有噪声：只有一句，说清略去了多少、全文多大、多少行。
//
// **错误路径不单独立限**：头尾各留已经同时保住"最初那句"（stderr 的头）与"栈顶那几帧"
// （trace 的尾）；回执头里的 `退出码 N` 在截断之前拼上，永远在。

/** 单条回执的上限（字节）。 */
export const MAX_RECEIPT_BYTES = 8192
/** 头留多少（字节）。 */
export const RECEIPT_HEAD_BYTES = 4096
/** 尾留多少（字节）。 */
export const RECEIPT_TAIL_BYTES = 4096

/**
 * 一段文本的行数。**读数与截断标记共用这一处**：`read` 的回执头里写着"L 行"，而标记里也写着
 * "共 L 行"——两处各算一次，两个数就迟早不一样（施工当场撞到过：头里 401 行、标记里 400 行）。
 *
 * 口径与 `read` 那一格原来那句 `body === '' ? 0 : body.split('\n').length` 逐字一致：
 * 空文本 0 行；有内容时按换行分段，末尾那个换行自己不算一行。
 */
export function lineCount(text: string): number {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/** 从 `at` 起往前找最近的**字符边界**（那个位置本身就是一个 UTF-8 首字节，或者是 0）。 */
function boundaryAt(bytes: Uint8Array, at: number): number {
  let i = Math.max(0, Math.min(at, bytes.byteLength))
  while (i > 0) {
    const b = bytes[i] as number
    // 首字节（`0xxxxxxx` / `11xxxxxx`）→ 这就是一个边界。续字节（`10xxxxxx`）→ 再往前。
    if ((b & 0xc0) !== 0x80) return i
    i -= 1
  }
  return 0
}

/**
 * **头**那一段的切点：从 `bytes[from]` 往后，切在**下一个**完整字符之前。
 *
 * 它保证两件事：头以完整字符结尾；`head + tail` 不相交（尾从 `from` 或更后起）。
 */
function headCut(bytes: Uint8Array, from: number): number {
  let i = Math.max(0, Math.min(from, bytes.byteLength))
  while (i < bytes.byteLength) {
    const b = bytes[i] as number
    if ((b & 0xc0) !== 0x80) {
      // 一个首字节：它开的那个字符有多长？整段都在 `from` 之前就收下它，否则停在它前面。
      const lead = b
      const size = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2
      return i + size <= from ? i + size : i
    }
    i += 1
  }
  return bytes.byteLength
}

/**
 * **尾**那一段的切点：尾**至多** `from` 那个位置那么多字节，而且以**完整字符**开头。
 *
 * 站在 `from` 上：它正好是首字节就收下（尾恰好到那儿）；它落在某个字符中间就**往前走到下一个
 * 首字节**（尾少几个字节，而那个字符整个留给中段）。**不是往回退**——往回退会把那个字符劈开，
 * 尾就比 `from` 还长（施工当场撞到过：尾 4097 字节）。
 */
function tailCut(bytes: Uint8Array, from: number): number {
  let i = Math.max(0, Math.min(from, bytes.byteLength))
  while (i < bytes.byteLength && ((bytes[i] as number) & 0xc0) === 0x80) i += 1
  return i
}

/**
 * 一条回执的正文 → 它的上界那一份。**不到上限就逐字节原样返回**（截断不许误伤小输出）。
 *
 * 参数 `limit` 只给负对照用（把上限调成 0 → 小输出当场被截，判据 ② 因此红）。产品路径上
 * 没有人传它：上限是常量，不是开关。
 *
 * 三条边界写死在这儿：**头尾不许交叠**（`M` 永远是正数）· **切点落在完整字符上** ·
 * **`head + mark + tail` 恰好等于回执总长**（那一条是"三个数按原文计"能被逐条对上的前提）。
 */
export function capReceipt(text: string, limit: number = MAX_RECEIPT_BYTES): string {
  const bytes = Buffer.from(text, 'utf8')
  const n = bytes.byteLength
  if (n <= limit) return text

  // 头与尾各从"上限的一半"里分，但都不许超过原文——小上限（负对照那一档）因此也自洽。
  const headWant = Math.min(RECEIPT_HEAD_BYTES, Math.ceil(limit / 2), n)
  const tailWant = Math.min(RECEIPT_TAIL_BYTES, limit - headWant, headWant)
  const cut = headCut(bytes, headWant)
  const from = Math.max(cut, tailCut(bytes, n - tailWant))
  const head = bytes.subarray(0, cut)
  const tail = bytes.subarray(from)
  const omitted = n - head.byteLength - tail.byteLength
  const mark = `\n…（中段略去 ${omitted} 字节 · 全文共 ${n} 字节 ${lineCount(text)} 行）…\n`
  return Buffer.concat([head, Buffer.from(mark, 'utf8'), tail]).toString('utf8')
}
