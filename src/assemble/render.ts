// 段的渲染：一个段的值 → 一段字节。出处：架构 § 8.11 的 `renderers`，形状在 `.fugue/backlog/s6-stitch.md`
// § 3（四种渲染器）与 § 4（段与段之间不掺分隔符）。PLAN § 5.6 的 Z0。
//
// **这一份是"值 → 字节"的唯一一处，而它是 A 区字节稳定的承重项。** 区域的划分是"从头到第一个
// 变化的字节"，所以同一份值渲染两次必须逐字节相同：文本与列表要固定末尾那一个换行，对象要
// 固定键序——**不固定键序，`hash(zoneA)` 就会随构造顺序漂移，而漂移不报错。**
//
// **分隔符属于渲染器，不属于拼接。** 拼接那一层（Z1 的 `assemble.ts`）只按段序把字节首尾相接；
// 段与段之间的分界就是渲染器输出的边界。这样"换一种渲染规则"只改这一份，"换一个段序"只改
// 协议值，两件事没有共同的交汇点。
//
// 依赖为零：不读环境、不查文件、不认协议——给一份值就出一份字节。
import type { RendererId, SegmentValue } from './contract.ts'

/** 渲染不出来：值与渲染器对不上，或者值里带着渲染器表达不了的形状。 */
export class RenderError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `readonly T[]` 与 `T[]` 都是数组；这里的判据只有"是不是数组"。 */
function isList(v: SegmentValue): v is readonly unknown[] {
  return Array.isArray(v)
}

/** 围栏块那一项的输入形状（协议值里的 `file-block`）。 */
function isFileBlock(v: SegmentValue): v is readonly { readonly path: string; readonly text: string }[] {
  if (!isList(v)) return false
  if (v.length === 0) return true
  return v.every(
    (b) =>
      isRecord(b) &&
      typeof (b as { path?: unknown }).path === 'string' &&
      typeof (b as { text?: unknown }).text === 'string',
  )
}

/**
 * 稳定序列化：键按**字典序**、**没有空格**、末尾**没有**换行。
 *
 * 两处刻意与 `JSON.stringify` 不同：对象的键序由排序定（不随构造顺序变），数组的**元素序照旧**
 * （那是值的语义，不是实现的偶然）。缩进与空白一律去掉——前缀里的字节每一个都要进缓存。
 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v) as string
  if (typeof v === 'string') return JSON.stringify(v) as string
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  if (isRecord(v)) {
    const keys = Object.keys(v).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
  }
  throw new RenderError(`这一种值序列化不了：${typeof v}`)
}

/** 一个围栏块：路径一行，原文跟在后面。 */
function fileBlock(b: { readonly path: string; readonly text: string }): string {
  return `--- ${b.path} ---\n${b.text}\n`
}

/**
 * 渲染一段。`id` 只出现在报错里——渲染规则不知道段叫什么，这正是"换渲染规则不动协议"的那一半。
 *
 * 四种渲染器各自的形状（末尾那一个换行是**渲染器**给的，拼接那一层不加）：
 * - `text`：原文 + 换行。
 * - `file-block`：每个文件一个块，块与块之间没有空行。
 * - `list`：一行一条 + 末尾一个换行。
 * - `json`：稳定序列化，**不补换行**——它是机器读的那一种，多一个字节都是多一个字节。
 */
export function render(id: RendererId, v: SegmentValue): Uint8Array {
  switch (id) {
    case 'text': {
      if (typeof v !== 'string') throw new RenderError(`text 那一种要的是字符串，拿到 ${typeof v}`)
      return new TextEncoder().encode(v + '\n')
    }
    case 'list': {
      if (!isList(v) || v.some((x) => typeof x !== 'string')) throw new RenderError('list 那一种要的是一串字符串')
      return new TextEncoder().encode(v.map((x) => String(x) + '\n').join(''))
    }
    case 'file-block': {
      if (!isFileBlock(v)) throw new RenderError('file-block 那一种要的是一串 { path, text }')
      return new TextEncoder().encode(v.map(fileBlock).join(''))
    }
    case 'json':
      return new TextEncoder().encode(stableStringify(v))
    default: {
      // 形状上的穷尽：往 `RendererId` 里加一个值而不在这里补一条，是编译不过的。
      const never: never = id
      throw new RenderError(`没有这一种渲染器：${String(never)}`)
    }
  }
}
