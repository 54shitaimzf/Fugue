// 0.3.3 查询的保守前置：只提取能够证明每个真匹配都必需的 literal。
// 不理解的正则返回 null，调用者必须扫描；这份模块不查询/构建索引、不改工具回执。
export const MAX_LITERAL_PATTERN_UNITS = 4096
export const MAX_REQUIRED_TRIGRAMS = 128

const META = new Set('.^$*+?()[]{}|'.split(''))
const ESCAPED_LITERAL = new Set('\\.^$*+?()[]{}|/-'.split(''))

function endsWithAnchor(pattern: string): boolean {
  if (!pattern.endsWith('$')) return false
  let escapes = 0
  for (let at = pattern.length - 2; at >= 0 && pattern[at] === '\\'; at--) escapes++
  return escapes % 2 === 0
}

/**
 * 支持整段普通 literal、单个外层 ^/$ 与转义标点。量词、选择、类、分组、反向引用、
 * 字符/边界转义和任何 flags 都退回扫描。尤其不把一个量词后的 literal 当成必需的。
 * 返回非空的、去重有序的三个 UTF-16 code units；与 Buffer UTF-8 解码后的 JS RegExp 一致。
 */
export function requiredLiteralTrigrams(pattern: string, flags = ''): readonly string[] | null {
  if (typeof pattern !== 'string' || flags !== '' || pattern.length > MAX_LITERAL_PATTERN_UNITS) return null
  let source = pattern.startsWith('^') ? pattern.slice(1) : pattern
  if (endsWithAnchor(source)) source = source.slice(0, -1)

  let literal = ''
  for (let at = 0; at < source.length; at++) {
    const char = source[at]!
    if (char === '\\') {
      at++
      const escaped = source[at]
      if (escaped === undefined || !ESCAPED_LITERAL.has(escaped)) return null
      literal += escaped
    } else {
      if (META.has(char)) return null
      literal += char
    }
  }
  if (literal.length < 3) return null

  const grams = new Set<string>()
  for (let at = 0; at + 2 < literal.length; at++) {
    grams.add(literal.slice(at, at + 3))
    // 一个必需 gram 子集仍是安全的过滤条件，少取只会多扫描，不会漏掉真匹配。
    if (grams.size >= MAX_REQUIRED_TRIGRAMS) break
  }
  return [...grams].sort()
}
