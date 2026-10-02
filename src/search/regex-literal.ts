// 0.3.3 查询的保守前置：只提取能够证明每个真匹配都必需的 literal。
// 不理解的正则返回 null，调用者必须扫描；这份模块不查询/构建索引、不改工具回执。
export const MAX_LITERAL_PATTERN_UNITS = 4096
export const MAX_REQUIRED_TRIGRAMS = 128
export const MAX_LITERAL_GROUP_DEPTH = 64

const META = new Set('.^$*+?()[]{}|'.split(''))
const ESCAPED_LITERAL = new Set('\\.^$*+?()[]{}|/-'.split(''))

function endsWithAnchor(pattern: string): boolean {
  if (!pattern.endsWith('$')) return false
  let escapes = 0
  for (let at = pattern.length - 2; at >= 0 && pattern[at] === '\\'; at--) escapes++
  return escapes % 2 === 0
}

/**
 * 支持普通 literal、单个外层 ^/$、转义标点与不带量词的 literal 捕获/非捕获分组。
 * 分组只连接固定文本，不改变必需子串。量词、选择、类、其他分组、反向引用、
 * 字符/边界转义和任何 flags 都退回扫描。尤其不把一个量词后的 literal 当成必需的。
 * 返回非空的、去重有序的三个 UTF-16 code units；与 Buffer UTF-8 解码后的 JS RegExp 一致。
 *
 * `flags` **必传**，而且要从编译这条 RegExp 的同一处传进来：整个模块的安全性建立在「任何
 * flags 都退回 null」之上，而 `i` 是致命的——`/hello/i` 匹配 `"HELLO"`，但 `hel` 不是
 * `"HELLO"` 的子串，把 `i` 当成「无 flags」立刻产出假必需条件并漏命中。所以这里不给缺省值：
 * 漏传的实参是 `undefined`，`!== ''` 当场退回扫描，而不是替调用方声称「没有 flags」。
 */
export function requiredLiteralTrigrams(pattern: string, flags: string): readonly string[] | null {
  if (typeof pattern !== 'string' || flags !== '' || pattern.length > MAX_LITERAL_PATTERN_UNITS) return null
  let source = pattern.startsWith('^') ? pattern.slice(1) : pattern
  if (endsWithAnchor(source)) source = source.slice(0, -1)

  let literal = ''
  let depth = 0
  for (let at = 0; at < source.length; at++) {
    const char = source[at]!
    if (char === '\\') {
      at++
      const escaped = source[at]
      if (escaped === undefined || !ESCAPED_LITERAL.has(escaped)) return null
      literal += escaped
    } else if (char === '(') {
      if (++depth > MAX_LITERAL_GROUP_DEPTH) return null
      if (source[at + 1] === '?') {
        if (source[at + 2] !== ':') return null
        at += 2
      }
    } else if (char === ')') {
      if (depth === 0) return null
      depth--
    } else {
      if (META.has(char)) return null
      literal += char
    }
  }
  if (depth !== 0 || literal.length < 3) return null

  const grams = new Set<string>()
  for (let at = 0; at + 2 < literal.length; at++) {
    grams.add(literal.slice(at, at + 3))
    // 一个必需 gram 子集仍是安全的过滤条件，少取只会多扫描，不会漏掉真匹配。
    if (grams.size >= MAX_REQUIRED_TRIGRAMS) break
  }
  return [...grams].sort()
}
