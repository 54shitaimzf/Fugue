// 查询模式 → **匹配文本一定含有的那些三字组**。出处：ROADMAP § 4 的 0.3.3 行（trigram 候选 ∩
// 视图 blob 集 → 验证）；手艺是 Russ Cox《Regular Expression Matching with a Trigram Index》
// （Google Code Search 的 `regexp.go`：模式里的字面量段取三字组当筛子，认不出来就整条回退）与
// Sourcegraph Zoekt 的 n-gram 查询计划。
//
// 三条口径：
//
//   一 · **只取"必须有"的，不取"可能有"的。** 抽出来的一条三字组，凡是能被这条模式匹配的文本
//        里**一定**含它。于是"不含它的 blob 不可能匹配"成立，跳过那些 blob 是安全的——候选集多了
//        只是慢，少了才是漏报（`index/trigram.ts` 口径一）。
//   二 · **认不出来是"没把握"，不是"没有"。** 点号 · 字符组 · 锚点 · 环视 · 反向引用 · 可以一次
//        都不出现的量词——一律当"这几条不知道"，绝不反过来当"这三字组不可能在"。整条模式取不出
//        一条有把握的三字组（单汉字/两字查询就是这一档）→ 交回空表，调用方照旧走扫描。
//   三 · **与匹配器同一个空间。** `new RegExp(pattern)` 那一侧看到的是解码之后的 UTF-16 单元
//        （`tools/execute.ts` 的 `utf8Of`），这一份抽的也是单元（`index/trigram.ts` 口径五）。
//
// 两处组合律（把"必须有"这件事按结构传下去，`regexp.go` 的同一套算法）：
//
//   串联  A B        → 两边的集合**并**起来（匹配 = A 的一段接 B 的一段，两边都完整出现）
//   择一  A | B      → 两边的集合**交**起来（哪一支都含它，才是"必须有"）
//   量词  A* A? A{0,n} → 空集（那一段可以完全不出现）
//        A+ A{n,} A{1,n} → A 那一份（至少出现一次，而匹配文本里就完整含着那一次）
//
// **串联那一支不跨过被量词打断的衔接**：`ab{2}c` 匹配的是 `abbc`/`abbbc`，里面没有 `abc` 那一段，
// 所以量词一出现就把攒着的字面量段收掉、从这个原子之后重新起段。宁可少取几条（少几条只是不够
// 挑，不会漏报），也不取一条匹配文本里其实没有的。
import { TRIGRAM_UNITS, gramAt } from '../index/trigram.ts'
import type { Trigram } from '../index/trigram.ts'

/** 一个原子的两支：它是不是一段字面量（是的话，字面量段可以接着攒），以及它自己那几条必须三字组。 */
interface Atom {
  /** 字面量原子的文本（转义解过之后）；不是字面量时是 `null`。 */
  readonly literal: string | null
  /** 这个原子自己交出来的"必须有"的三字组。 */
  readonly grams: ReadonlySet<Trigram>
}

interface Cursor {
  at: number
}

/** 解析中途撞上认不出来的形状：这一条模式整条不当筛子用（`bail.bad`）。 */
interface Bail {
  bad: boolean
}

const NONE: ReadonlySet<Trigram> = new Set<Trigram>()

/** 一个字面量段里的全部三字组（少于三个单元的一段一条都不产出）。 */
function addRun(into: Set<Trigram>, run: string): void {
  for (let at = 0; at + TRIGRAM_UNITS <= run.length; at++) into.add(gramAt(run, at))
}

/** 量词：最少出现几次 · 最多几次（`null` = 没有上限）。形状不合（`{` 不是量词）时给 `null`。 */
interface Quantifier {
  readonly min: number
  readonly max: number | null
}

function parseQuantifier(src: string, pos: Cursor): Quantifier | null {
  const ch = src[pos.at]
  if (ch === '*') {
    pos.at += 1
    if (src[pos.at] === '?') pos.at += 1
    return { min: 0, max: null }
  }
  if (ch === '+') {
    pos.at += 1
    if (src[pos.at] === '?') pos.at += 1
    return { min: 1, max: null }
  }
  if (ch === '?') {
    pos.at += 1
    if (src[pos.at] === '?') pos.at += 1
    return { min: 0, max: 1 }
  }
  if (ch !== '{') return null
  // `{n}` · `{n,}` · `{n,m}` 才是量词；别的一律当字面量的 `{`（JS 的 Annex B 允许它当字面量）
  const rest = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(pos.at))
  if (rest === null) return null
  const min = Number(rest[1])
  const max = rest[2] === undefined ? min : rest[3] === '' ? null : Number(rest[3])
  pos.at += rest[0].length
  if (src[pos.at] === '?') pos.at += 1
  return { min, max }
}

/** `[` 之后那一段（含转义）跳到配对的 `]`：字符组恒不产出三字组，但游标要停在它后面。 */
function skipClass(src: string, pos: Cursor, bail: Bail): void {
  // `[]` 在 JS 里是**空字符组**（谁都匹配不上），而 POSIX 那一套把开头的 `]` 当字面量——
  // 两套读法在那一个字节上分岔，分岔之后游标就停在错的位置上。整条不当筛子（回扫描）。
  if (src[pos.at] === ']') {
    bail.bad = true
    return
  }
  while (pos.at < src.length) {
    const ch = src[pos.at]
    pos.at += 1
    if (ch === '\\') {
      pos.at += 1
      continue
    }
    if (ch === ']') return
  }
  bail.bad = true
}

const HEX = /^[0-9a-fA-F]$/

/** `\` 之后那一个字符：能给一个字面单元就给，认不出（`\d` · `\b` · `\1` …）给 `null`。 */
function escapedUnit(src: string, pos: Cursor, bail: Bail): string | null {
  const ch = src[pos.at]
  pos.at += 1
  if (ch === undefined) {
    bail.bad = true
    return null
  }
  const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v', '0': '\0' }
  const named = simple[ch]
  if (named !== undefined) return named
  if (ch === 'x' || ch === 'u') {
    const width = ch === 'x' ? 2 : 4
    const body = src.slice(pos.at, pos.at + width)
    if (body.length === width && [...body].every((c) => HEX.test(c))) {
      pos.at += width
      return String.fromCharCode(Number.parseInt(body, 16))
    }
    // `\u{…}`（码点转义）：多单元的那一档照样是字面量，交给上面那条"解出来的文本"
    if (ch === 'u' && src[pos.at] === '{') {
      const close = src.indexOf('}', pos.at)
      const hex = close === -1 ? '' : src.slice(pos.at + 1, close)
      const code = hex !== '' && [...hex].every((c) => HEX.test(c)) ? Number.parseInt(hex, 16) : -1
      // 码点越界（`\u{110000}`）当场当认不出：`String.fromCodePoint` 对它是抛，而这一层不许抛。
      if (code >= 0 && code <= 0x10ffff) {
        pos.at = close + 1
        return String.fromCodePoint(code)
      }
    }
    bail.bad = true
    return null
  }
  // 字母数字那几样是转义类（`\d` · `\w` · `\b` · `\1` …）：认不出内容，但它不是字面量。
  if (/[a-zA-Z0-9]/.test(ch)) return null
  return ch
}

function parseAtom(src: string, pos: Cursor, bail: Bail): Atom {
  const ch = src[pos.at]
  pos.at += 1
  if (ch === '^' || ch === '$' || ch === '.') return { literal: null, grams: NONE }
  if (ch === '[') {
    skipClass(src, pos, bail)
    return { literal: null, grams: NONE }
  }
  if (ch === '(') return parseGroup(src, pos, bail)
  if (ch === '\\') {
    const unit = escapedUnit(src, pos, bail)
    return unit === null ? { literal: null, grams: NONE } : { literal: unit, grams: NONE }
  }
  // 剩下的都是字面量（`{` · `}` · `]` 这几个在 JS 里也能当字面量，这里当"认不出"处理：
  // 断开字面量段，少取几条，绝不会多取）
  if (ch === '{' || ch === '}' || ch === ']') return { literal: null, grams: NONE }
  return { literal: ch, grams: NONE }
}

function parseGroup(src: string, pos: Cursor, bail: Bail): Atom {
  let look = false
  if (src[pos.at] === '?') {
    pos.at += 1
    const kind = src[pos.at]
    if (kind === ':') pos.at += 1
    else if (kind === '=' || kind === '!') {
      pos.at += 1
      look = true
    } else if (kind === '<') {
      pos.at += 1
      const after = src[pos.at]
      if (after === '=' || after === '!') {
        pos.at += 1
        look = true
      } else {
        // 具名组 `(?<name>`：跳到那个 `>`（名字本身不参与匹配）
        while (pos.at < src.length && src[pos.at] !== '>') pos.at += 1
        if (pos.at >= src.length) {
          bail.bad = true
          return { literal: null, grams: NONE }
        }
        pos.at += 1
      }
    } else {
      bail.bad = true
      return { literal: null, grams: NONE }
    }
  }
  const inner = parseAlt(src, pos, bail)
  if (src[pos.at] !== ')') {
    bail.bad = true
    return { literal: null, grams: NONE }
  }
  pos.at += 1
  // 环视匹配的是"旁边有没有"，它自己不消费文本：里面的字面量**不一定**出现在匹配文本里。
  return { literal: null, grams: look ? NONE : inner }
}

/** 一段串联：字面量段攒在一起取三字组，别的原子各交各的，两边并起来。 */
function parseConcat(src: string, pos: Cursor, bail: Bail): Set<Trigram> {
  const grams = new Set<Trigram>()
  let run = ''
  const flush = (): void => {
    addRun(grams, run)
    run = ''
  }
  while (pos.at < src.length) {
    const ch = src[pos.at]
    if (ch === '|' || ch === ')') break
    const before = pos.at
    const atom = parseAtom(src, pos, bail)
    if (bail.bad) return grams
    const quant = parseQuantifier(src, pos)
    if (quant === null) {
      // 没有量词：这个原子接得上前面攒着的那一段。
      if (atom.literal !== null) run += atom.literal
      else {
        flush()
        for (const g of atom.grams) grams.add(g)
      }
    } else if (quant.min === 0) {
      // 可以一次都不出现：攒着的那一段到此为止，它自己不贡献（`fo?o` 里没有 `foo`）。
      flush()
    } else if (atom.literal !== null) {
      // 至少出现一次：**第一次**重复与前面接得上，于是"前面那一段 + 它"仍然是一段子串；
      // 但重复几次不知道，后面的字面量从那一次之后再接就不一定成立了（`ab{2}c` 匹配 `abbc`，
      // 里面没有 `abc`）——所以到这里就把段收掉，后面另起一段。
      run += atom.literal
      if (!(quant.min === 1 && quant.max === 1)) flush()
    } else {
      flush()
      if (quant.min >= 1) for (const g of atom.grams) grams.add(g)
    }
    if (pos.at === before) {
      // 解析器一步都没前进——形状认不出来，整条不当筛子（防死循环）
      bail.bad = true
      return grams
    }
  }
  flush()
  return grams
}

/** 一段择一：每一条分支都含的三字组才留（交集）。 */
function parseAlt(src: string, pos: Cursor, bail: Bail): Set<Trigram> {
  let out = parseConcat(src, pos, bail)
  while (src[pos.at] === '|' && !bail.bad) {
    pos.at += 1
    const next = parseConcat(src, pos, bail)
    const kept = new Set<Trigram>()
    for (const g of out) if (next.has(g)) kept.add(g)
    out = kept
  }
  return out
}

/**
 * 这条模式"必须含有"的三字组（去重，按第一次出现的顺序）。
 *
 * **空表是正常答案**：单汉字/两字查询 · 全是通配 · 整条形状认不出来，都给空表——调用方据此
 * 走扫描（这是"短查询走扫描"那条定稿规格的落点，不是一条特例分支）。
 */
export function requiredTrigrams(pattern: string): Trigram[] {
  const bail: Bail = { bad: false }
  const pos: Cursor = { at: 0 }
  const grams = parseAlt(pattern, pos, bail)
  if (bail.bad || pos.at !== pattern.length) return []
  return [...grams]
}
