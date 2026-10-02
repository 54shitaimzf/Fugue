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

interface LiteralFacts {
  /** Non-null only when the entire child matches exactly this fixed text. */
  readonly fixed: string | null
  readonly runs: readonly string[]
  readonly quantified: boolean
}

function sequenceFacts(children: readonly LiteralFacts[]): LiteralFacts {
  const runs: string[] = []
  let fixed = '', variable = false
  for (const child of children) {
    if (child.fixed !== null) fixed += child.fixed
    else {
      if (fixed !== '') runs.push(fixed)
      fixed = ''
      variable = true
      runs.push(...child.runs)
    }
  }
  if (!variable) return { fixed, runs: [], quantified: false }
  if (fixed !== '') runs.push(fixed)
  return { fixed: null, runs, quantified: false }
}

/**
 * 固定 literal/分组连接；dot 是未知字符边界，?/* 丢掉前一个完整 atom/group 的全部条件。
 * 绝不跨可变/可选边界造连续 literal。其他量词、选择、类、分组、反向引用、
 * 字符/边界转义和任何 flags 都退回扫描。
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

  // One frame per group, at most 64 deep and 4096 source units in total.
  const frames: LiteralFacts[][] = [[]]
  for (let at = 0; at < source.length; at++) {
    const char = source[at]!
    const children = frames[frames.length - 1]!
    if (char === '\\') {
      at++
      const escaped = source[at]
      if (escaped === undefined || !ESCAPED_LITERAL.has(escaped)) return null
      children.push({ fixed: escaped, runs: [], quantified: false })
    } else if (char === '(') {
      if (frames.length > MAX_LITERAL_GROUP_DEPTH) return null
      if (source[at + 1] === '?') {
        if (source[at + 2] !== ':') return null
        at += 2
      }
      frames.push([])
    } else if (char === ')') {
      if (frames.length === 1) return null
      const group = sequenceFacts(frames.pop()!)
      frames[frames.length - 1]!.push(group)
    } else if (char === '?' || char === '*') {
      const child = children[children.length - 1]
      if (child === undefined || child.quantified) return null
      // Zero occurrences are possible, so NO fact from this child is mandatory.
      children[children.length - 1] = { fixed: null, runs: [], quantified: true }
    } else if (char === '.') {
      children.push({ fixed: null, runs: [], quantified: false })
    } else {
      if (META.has(char)) return null
      children.push({ fixed: char, runs: [], quantified: false })
    }
  }
  if (frames.length !== 1) return null
  const facts = sequenceFacts(frames[0]!)
  const runs = facts.fixed === null ? facts.runs : [facts.fixed]

  const grams = new Set<string>()
  collect: for (const literal of runs) {
    for (let at = 0; at + 2 < literal.length; at++) {
      grams.add(literal.slice(at, at + 3))
      // A bounded mandatory subset only admits extra candidates, never excludes a match.
      if (grams.size >= MAX_REQUIRED_TRIGRAMS) break collect
    }
  }
  return grams.size === 0 ? null : [...grams].sort()
}
