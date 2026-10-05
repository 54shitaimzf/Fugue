// 查询模式 → **匹配文本一定含有的那些三字组**。出处：ROADMAP § 4 的查询接线那一行（trigram 候选 ∩
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
//
// **连接处那三栏（提案 5）。** 上面那条"遇到组就收段"会把跨过连接处的三字组整批丢掉：
// `(get|set)Value` 的 `etV` 前两个单元来自择一那一支、后一个来自 `Value`，两边的"自己含什么"
// 里都没有它。所以每个原子除了 `grams`/`runs` 之外还带一栏**边界长什么样**（上面那个 `Edges`），
// 位置相邻的两段在连接处做叉积，**备选那一栏的叉积取交**——每一条备选都含的三字组才是"必须有"的。
//
// 这是 `regexp4.html` 那张分析表里能在"候选逐条取交"这条路上用的那一半：codesearch 测试里
// `abc(def|ghi)` 抽出 `bcd` `cde` `bcg` `cgh` 走的是**择一档（析取）**，而本站的派发是逐条三字组
// 取交，那四个三字组在这里一个都不是"必须有"的（`abcghi` 里没有 `bcd`），所以本站只取公共的那
// 一部分。`MAX_EXACT = 7` / `MAX_SET = 20` 与 codesearch 同值：超了就往回退，`exact` 那一栏交回
// "不知道"——**少取几条只是不够挑，多取一条是漏报**。改主意的条件：出现"析取档"的派发（候选取并）
// 时，那四个三字组才有地方去，那时这张表要按析取那一半重取。
//
// **两种抽取，一趟解析。** `requiredTrigrams` 取"必须含有的三字组"（问索引那一侧用），
// `requiredLiterals` 取"必须含有的字面量段"（按原始字节预筛那一侧用）。下面每个节点交回的都是
// `Required`——两栏一起攒、一起并、一起交，组合律只有这一份；各写一份解析就多一处会漂的口径。
import { TRIGRAM_UNITS, gramAt } from '../index/trigram.ts'
import type { Trigram } from '../index/trigram.ts'

/**
 * 一段东西在**连接处**的那三栏（Russ Cox《Regular Expression Matching with a Trigram Index》的
 * 分析表 · google/codesearch 的 `regexpInfo{canEmpty, exact, prefix, suffix}`）。
 *
 * 它说的不是"这一段含什么"，而是"这一段匹配的文本在边界上长什么样"——跨过连接处的三字组只能从
 * 这里拼出来：`(get|set)Value` 里 `etV` 的前两个单元来自择一那一支、后一个来自 `Value`，两边的
 * "自己含什么"里都没有它。
 *
 *   exact       整段等于其中某一条（**择一**：哪一条都可能，所以每一条都含的三字组才算"必须有"）
 *   prefix      每一条都必须是这一段匹配文本的**开头**（合取：并起来都是"必须有"）
 *   suffix      每一条都必须是……的**结尾**（同上）
 *   canEmpty    这一段**可能**匹配空串（备选那一栏的岔路要用它）
 *   alwaysEmpty 这一段**一定**匹配空串（零宽那几样）——`prefix`/`suffix` 那条继承律的前提
 *
 * `null` 与空集都表示"不知道"。**三栏一律只往"少取几条"的方向退**：这一层多取一条就是漏报。
 *
 * **「可能空」与「一定空」是两件事，混起来就是漏报**：`.*` 可能匹配空串，但 `foo.*` 的结尾并不
 * 因此被 `foo` 定住——`foo---bar` 里没有 `obar`。只有那一段**一定**空，另一边那一栏才轮得到继承
 * （`foo^` 那种零宽拼接）。
 */
interface Edges {
  readonly exact: ReadonlySet<string> | null
  readonly prefix: ReadonlySet<string>
  readonly suffix: ReadonlySet<string>
  readonly canEmpty: boolean
  readonly alwaysEmpty: boolean
}

const NO_STRINGS: ReadonlySet<string> = new Set<string>()

/** 认不出来的那一段（点号 · 字符组 · 转义类 · 锚点 · 环视 · 反向引用）：三栏全不知道。 */
const NO_EDGES: Edges = {
  exact: null,
  prefix: NO_STRINGS,
  suffix: NO_STRINGS,
  canEmpty: false,
  alwaysEmpty: false,
}

/** 空串联那一份（连接律的单位元）：整段就是空串。 */
const EMPTY_EDGES: Edges = {
  exact: new Set(['']),
  prefix: NO_STRINGS,
  suffix: NO_STRINGS,
  canEmpty: true,
  alwaysEmpty: true,
}

/** 一个单元的段：整段就是它自己。 */
function unitEdges(unit: string): Edges {
  return {
    exact: new Set([unit]),
    prefix: new Set([unit]),
    suffix: new Set([unit]),
    canEmpty: false,
    alwaysEmpty: false,
  }
}

/**
 * 备选那一栏的条数上限，**与 codesearch 的 `maxExact = 7` 同值**。超了整栏作废：备选少记一条
 * 就是"其实不必有"的错报，这一栏没有安全的截断法。
 */
const MAX_EXACT = 7
/** 合取那两栏的条数上限（codesearch 的 `maxSet = 20` 同值）。 */
const MAX_SET = 20
/** `exact` 里单条的长度上限：**裁字符串 = 错报**，所以超了也是整栏作废。 */
const MAX_EXACT_UNITS = 64
/**
 * `prefix`/`suffix` 里单条的长度上限。**裁短是安全的**：强制前缀的前缀仍然强制（后缀同理），
 * 而一个三字组在连接处最多用到边界两侧各两个单元。
 */
const MAX_EDGE_UNITS = 8

/** 只留最长的 `MAX_SET` 条：合取那两栏丢掉短的只是少几条"必须有"，方向是安全的。 */
function longestOf(set: ReadonlySet<string>): ReadonlySet<string> {
  if (set.size <= MAX_SET) return set
  return new Set([...set].sort((x, y) => y.length - x.length).slice(0, MAX_SET))
}

/** 强制前缀裁到前 `MAX_EDGE_UNITS` 个单元（前缀的前缀仍然强制）。 */
function clipHeads(set: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set<string>()
  for (const s of set) out.add(s.slice(0, MAX_EDGE_UNITS))
  return longestOf(out)
}

/** 强制后缀裁到后 `MAX_EDGE_UNITS` 个单元（后缀的后缀仍然强制）。 */
function clipTails(set: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set<string>()
  for (const s of set) out.add(s.slice(-MAX_EDGE_UNITS))
  return longestOf(out)
}

/** 备选那一栏的叉积。**超过上限当场交回 `null`**（宁可少取几条，不许多取一条）。 */
function crossExact(a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> | null {
  if (a.size * b.size > MAX_EXACT) return null
  const out = new Set<string>()
  for (const x of a) for (const y of b) out.add(x + y)
  return out
}

/**
 * 一串**备选**（析取）× 一串强制前缀/后缀（合取）的叉积：**每一条备选都要产出的那几条**才留下。
 *
 * 这是这一份里最容易写错、而且写错就是漏报的一处：`suffix("xbc")` 是 `{"c","bc","xbc"}`，
 * `exact((a|b))` 是 `{a,b}`——直接做叉积会得到 `bca`，而 `^xbc(a|b)` 匹配 `xbcb` 时里面根本
 * 没有 `bca`。备选那一栏说的是"哪一种都可能"，所以只有**每一条备选都产出**的那几条才是
 * "必须有"的。
 */
function crossAlts(alts: ReadonlySet<string>, fixed: ReadonlySet<string>, altFirst: boolean): ReadonlySet<string> {
  let common: Set<string> | null = null
  for (const y of alts) {
    const here = new Set<string>()
    for (const x of fixed) here.add(altFirst ? y + x : x + y)
    if (common === null) common = here
    else {
      const out = new Set<string>()
      for (const s of common) if (here.has(s)) out.add(s)
      common = out
    }
  }
  return common ?? new Set<string>()
}

/** 两栏取交（择一：哪一支都强制的那一条才留下）。 */
function meetStrings(a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set<string>()
  for (const s of a) if (b.has(s)) out.add(s)
  return out
}

/** 串联 A B 的备选那一栏：两边都是已知的整段时才有答案。 */
function joinExact(a: Edges, b: Edges): ReadonlySet<string> | null {
  if (a.exact === null || b.exact === null) return null
  const cross = crossExact(a.exact, b.exact)
  if (cross === null) return null
  const out = new Set<string>(cross)
  // 可以匹配空串的那一侧：它那一份自己也算一种可能（`a?bc` 的备选是 `bc` 与 `abc`）。
  if (a.canEmpty) for (const s of b.exact) out.add(s)
  if (b.canEmpty) for (const s of a.exact) out.add(s)
  for (const s of out) if (s.length > MAX_EXACT_UNITS) return null
  return out.size > MAX_EXACT ? null : out
}

/** 串联 A B 的合取那两栏。 */
function joinEdges(a: Edges, b: Edges): Edges {
  const heads = new Set<string>(a.prefix)
  const tails = new Set<string>(b.suffix)
  if (a.exact !== null) for (const s of crossAlts(a.exact, b.prefix, true)) heads.add(s)
  // **一定空**才轮到继承：`可能是空` 那一档继承过来就是错报（`foo.*` 的结尾定不住）。
  if (a.alwaysEmpty) for (const s of b.prefix) heads.add(s)
  if (b.exact !== null) for (const s of crossAlts(b.exact, a.suffix, false)) tails.add(s)
  if (b.alwaysEmpty) for (const s of a.suffix) tails.add(s)
  return {
    exact: joinExact(a, b),
    prefix: clipHeads(heads),
    suffix: clipTails(tails),
    canEmpty: a.canEmpty && b.canEmpty,
    alwaysEmpty: a.alwaysEmpty && b.alwaysEmpty,
  }
}

/** 择一 A | B 的那三栏：哪一支都强制的那一条才留下。 */
function meetEdges(a: Edges, b: Edges): Edges {
  let exact: ReadonlySet<string> | null = null
  if (a.exact !== null && b.exact !== null) {
    const out = new Set([...a.exact, ...b.exact])
    exact = out.size > MAX_EXACT ? null : out
  }
  return {
    exact,
    prefix: meetStrings(a.prefix, b.prefix),
    suffix: meetStrings(a.suffix, b.suffix),
    canEmpty: a.canEmpty || b.canEmpty,
    alwaysEmpty: a.alwaysEmpty && b.alwaysEmpty,
  }
}

/**
 * 量词落在三栏上。`min = 0` 那一档全交回"不知道"（那一段可以完全不出现）；`min ≥ 1` 时第一次
 * 重复与前面接得上，**开头**照旧、**结尾**照旧（末次重复仍然是那个原子）——中间几次重复接不上，
 * 所以 `exact` 交回"不知道"。
 */
function quantEdges(e: Edges, quant: Quantifier): Edges {
  if (quant.min === 1 && quant.max === 1) return e
  if (quant.min === 0) {
    // 可以一次都不出现：三栏里只剩"可能空"；**它不是"一定空"**，所以开头/结尾那两栏一个字不留。
    return { exact: null, prefix: NO_STRINGS, suffix: NO_STRINGS, canEmpty: true, alwaysEmpty: false }
  }
  return { exact: null, prefix: e.prefix, suffix: e.suffix, canEmpty: false, alwaysEmpty: e.alwaysEmpty }
}

/**
 * 一趟解析攒下来的三栏：**必须有**的三字组（问索引那一侧用）· **必须有**的字面量段（按原始
 * 字节预筛那一侧用）· 这一段在连接处的三栏（`Edges`，跨过连接处的三字组从它拼出来）。
 */
interface Required {
  readonly grams: Set<Trigram>
  readonly runs: Set<string>
  readonly edges: Edges
}

/** 空集那一份。**只读**：任何一处都是往新的一份里并，谁也不就地改它。 */
const NOTHING: Required = { grams: new Set<Trigram>(), runs: new Set<string>(), edges: NO_EDGES }

/** 把 `other` 两栏都并进 `into`（串联：两边的"必须有"合起来还是"必须有"）。 */
function union(into: Required, other: Required): void {
  for (const g of other.grams) into.grams.add(g)
  for (const r of other.runs) into.runs.add(r)
}

/** 两栏各自取交（择一：哪一支都含它，才是"必须有"），连接处那三栏也取交。 */
function intersect(a: Required, b: Required): Required {
  const grams = new Set<Trigram>()
  for (const g of a.grams) if (b.grams.has(g)) grams.add(g)
  const runs = new Set<string>()
  for (const r of a.runs) if (b.runs.has(r)) runs.add(r)
  return { grams, runs, edges: meetEdges(a.edges, b.edges) }
}

/** 一个原子的三支：它是不是一段字面量（是的话，字面量段可以接着攒）· 它自己那几条必须项 ·
 *  它在连接处的三栏（下一段要从它这里跨过去）。 */
interface Atom {
  /** 字面量原子的文本（转义解过之后）；不是字面量时是 `null`。 */
  readonly literal: string | null
  /** 这个原子自己交出来的"必须有"。 */
  readonly must: Required
  /** 这个原子在连接处的三栏；认不出来的形状给 `NO_EDGES`。 */
  readonly edges: Edges
}

interface Cursor {
  at: number
}

/** 解析中途撞上认不出来的形状：这一条模式整条不当筛子用（`bail.bad`）。 */
interface Bail {
  bad: boolean
  /** 此刻的组嵌套深度（`parseGroup` 进出各记一次；封顶见 `MAX_GROUP_DEPTH`）。 */
  depth: number
}

/**
 * 收下一段字面量：**三字组那一栏**收它的全部三单元窗口（少于三个单元的一段一条三字组都不产出），
 * **字面量那一栏**收这一段自己——一个单元的段也是"必须有"的一段，单汉字/两字查询要的正是它。
 */
function addRun(into: Required, run: string): void {
  if (run === '') return
  for (const g of windowsOf(run)) into.grams.add(g)
  into.runs.add(run)
}

/** 一段文本里所有三单元窗口（少于三个单元的一段给空集）。 */
function windowsOf(s: string): Set<Trigram> {
  const out = new Set<Trigram>()
  for (let at = 0; at + TRIGRAM_UNITS <= s.length; at++) out.add(gramAt(s, at))
  return out
}

/**
 * 把连接处那三栏里"必须有"的三字组并进 `into.grams`。
 *
 * `exact` 那一栏是**择一**，所以取交：每一条备选都含的三字组才是"必须有"的——`(get|set)Value`
 * 的 `etV` 就是从这里出来的（`getValue` 与 `setValue` 都有它，而 `get` 与 `set` 各自都没有）。
 * `prefix`/`suffix` 那两栏是**合取**，各条自己那一串里的每个窗口都是"必须有"的。
 *
 * **只加不减**：它往 `grams` 里添的都是"匹配文本一定含"的，`runs` 那一栏一个字不动（按字节预筛
 * 那一侧照旧）。
 */
function addEdges(into: Required, e: Edges): void {
  if (e.exact !== null) {
    let common: Set<Trigram> | null = null
    for (const s of e.exact) {
      const here = windowsOf(s)
      if (common === null) common = here
      else {
        const out = new Set<Trigram>()
        for (const g of common) if (here.has(g)) out.add(g)
        common = out
      }
    }
    for (const g of common ?? []) into.grams.add(g)
  }
  for (const s of e.prefix) for (const g of windowsOf(s)) into.grams.add(g)
  for (const s of e.suffix) for (const g of windowsOf(s)) into.grams.add(g)
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
  if (ch === '^' || ch === '$' || ch === '.') return { literal: null, must: NOTHING, edges: NO_EDGES }
  if (ch === '[') {
    skipClass(src, pos, bail)
    return { literal: null, must: NOTHING, edges: NO_EDGES }
  }
  if (ch === '(') return parseGroup(src, pos, bail)
  if (ch === '\\') {
    const unit = escapedUnit(src, pos, bail)
    return unit === null
      ? { literal: null, must: NOTHING, edges: NO_EDGES }
      : { literal: unit, must: NOTHING, edges: unitEdges(unit) }
  }
  // 剩下的都是字面量（`{` · `}` · `]` 这几个在 JS 里也能当字面量，这里当"认不出"处理：
  // 断开字面量段，少取几条，绝不会多取）
  if (ch === '{' || ch === '}' || ch === ']') return { literal: null, must: NOTHING, edges: NO_EDGES }
  return { literal: ch, must: NOTHING, edges: unitEdges(ch) }
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
          return { literal: null, must: NOTHING, edges: NO_EDGES }
        }
        pos.at += 1
      }
    } else {
      bail.bad = true
      return { literal: null, must: NOTHING, edges: NO_EDGES }
    }
  }
  // **组的嵌套深度在这儿封顶**（`MAX_GROUP_DEPTH`）：递归下降吃的是引擎的调用栈，超限与其它
  // 认不出的形状走同一条出口——整条不当筛子用，调用方走扫描。
  bail.depth += 1
  if (bail.depth > MAX_GROUP_DEPTH) {
    bail.depth -= 1
    bail.bad = true
    return { literal: null, must: NOTHING, edges: NO_EDGES }
  }
  const inner = parseAlt(src, pos, bail)
  bail.depth -= 1
  if (src[pos.at] !== ')') {
    bail.bad = true
    return { literal: null, must: NOTHING, edges: NO_EDGES }
  }
  pos.at += 1
  // 环视匹配的是"旁边有没有"，它自己不消费文本：里面的字面量**不一定**出现在匹配文本里，
  // 连接处那三栏也一并作废（拿它去跨边界就是错报）。
  return look ? { literal: null, must: NOTHING, edges: NO_EDGES } : { literal: null, must: inner, edges: inner.edges }
}

/** 一段串联：字面量段攒在一起收，别的原子各交各的，三栏都并起来。 */
function parseConcat(src: string, pos: Cursor, bail: Bail): Required {
  const must: Required = { grams: new Set<Trigram>(), runs: new Set<string>(), edges: NO_EDGES }
  let run = ''
  /** 这一段串联在连接处的三栏：**按位拼**（串联的结合律），跨过连接处的三字组最后一起取。 */
  let edges = EMPTY_EDGES
  const flush = (): void => {
    addRun(must, run)
    run = ''
  }
  while (pos.at < src.length) {
    const ch = src[pos.at]
    if (ch === '|' || ch === ')') break
    const before = pos.at
    const atom = parseAtom(src, pos, bail)
    if (bail.bad) return must
    const quant = parseQuantifier(src, pos)
    edges = joinEdges(edges, quant === null ? atom.edges : quantEdges(atom.edges, quant))
    if (quant === null) {
      // 没有量词：这个原子接得上前面攒着的那一段。
      if (atom.literal !== null) run += atom.literal
      else {
        flush()
        union(must, atom.must)
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
      if (quant.min >= 1) union(must, atom.must)
    }
    if (pos.at === before) {
      // 解析器一步都没前进——形状认不出来，整条不当筛子（防死循环）
      bail.bad = true
      return must
    }
  }
  flush()
  addEdges(must, edges)
  return { grams: must.grams, runs: must.runs, edges }
}

/** 一段择一：每一条分支都含的那几条才留（两栏各自取交，连接处那三栏也取交）。 */
function parseAlt(src: string, pos: Cursor, bail: Bail): Required {
  let out = parseConcat(src, pos, bail)
  while (src[pos.at] === '|' && !bail.bad) {
    pos.at += 1
    out = intersect(out, parseConcat(src, pos, bail))
  }
  return out
}

/**
 * 组的嵌套深度上限。**这是地板，不是性能常数**：抽取器是递归下降的（组里还是组），递归吃的是
 * 引擎的调用栈。本地实测（把这行闸拆掉之后量的）：1000 层还抽得出，2000 层就抛 `RangeError: Maximum
 * call stack size exceeded`——同一形状 `new RegExp` 那一侧能扛得多（实测四万层才抛 `SyntaxError`），
 * 所以这不是模式的毛病，是这一份实现的毛病。超限与其它认不出的形状走同一条出口：
 * 交回空表，调用方走扫描——**纯解析函数不该把"认不出"与"炸了"混成一件事**，也不该靠调用方兜异常。
 *
 * 256 的来处：人手写的模式深不过几层（真实查询在 10 层以内），而 256 层离栈顶还有一个量级。
 * **改主意的条件**：出现真有几百层嵌套的查询（那说明模式是机器生成的）——要么抬高这条线，
 * 要么把解析改成显式栈（那时这条常数可以删）。
 */
const MAX_GROUP_DEPTH = 256

/**
 * 这一趟解析（两种抽取共用）。**认不出来 · 带 flags → `null`**，两个调用方各按自己的空表出口走。
 *
 * `flags` 那一栏是**要调用点证明它没有**：`new RegExp(pattern, 'i')` 那一侧大小写不敏感，而这里抽的
 * 东西按原样比——带着 flags 的模式抽出来的不再"必须有"，那是候选集少了的那一类漏报，最难查。
 * 所以非空 flags 与"认不出"同一条出口。
 */
function requiredOf(pattern: string, flags: string): Required | null {
  if (flags !== '') return null
  const bail: Bail = { bad: false, depth: 0 }
  const pos: Cursor = { at: 0 }
  const must = parseAlt(pattern, pos, bail)
  if (bail.bad || pos.at !== pattern.length) return null
  return must
}

/**
 * 这条模式"必须含有"的三字组（去重，按第一次出现的顺序）。
 *
 * **空表是正常答案**：单汉字/两字查询 · 全是通配 · 整条形状认不出来 · **带着 flags**，都给空表
 * ——调用方据此走扫描（这是"短查询走扫描"那条定稿规格的落点，不是一条特例分支）。
 *
 * 缺省 `''` 只给这一份自己的单测用；生产那一条路（`plan.ts`）把匹配器身上的 `re.flags` 一路传进来。
 */
export function requiredTrigrams(pattern: string, flags = ''): Trigram[] {
  const must = requiredOf(pattern, flags)
  return must === null ? [] : [...must.grams]
}

/**
 * 这一段文本编回字节、再解回来还是它自己吗。**两道都要**：
 *
 *   · **U+FFFD** 那一档是本站 ② 单列的那一条：一份非法 UTF-8 的文件解码之后会出现 U+FFFD，而查询串
 *     里的 U+FFFD 编回 UTF-8 是 `EF BF BD`——那三个字节不在那份文件的字节里。按字节判就会把一份
 *     **真能匹配**的文件判成"不含"，那是漏报（`index/trigram.ts` 口径五为同一件事付过一次代价）。
 *   · **往返**那一档挡的是落单的代理（`\uD83D` 这种）：它编出来是 `EF BF BD`、解回来是 U+FFFD，
 *     与它自己不同——落到字节面上同样是"字节里有、解出来没有"。
 *
 * 这两档排掉之后，"字节里有它"与"解出来有它"等价：解出来的每一个非 U+FFFD 字符，它在原始字节里
 * 就是它自己那一段（解码器只认规范编码，过长的写法当场落成 U+FFFD）。
 */
function byteClean(run: string): boolean {
  if (run.includes('\uFFFD')) return false
  return Buffer.from(run, 'utf8').toString('utf8') === run
}

/**
 * 这条模式"必须含有"的字面量段（去重，按第一次出现的顺序）——**按原始字节预筛那一侧用它**。
 *
 * 与 `requiredTrigrams` 同一趟解析、同一套组合律，取的却是"这一整段字面量"而不是它的三单元窗口：
 * 一个单元的段也是"必须有"的一段，所以**单汉字/两字查询在这一栏上有一条**（三字组那一栏对它们
 * 是空表——那正是短查询走扫描的来处，这一栏不改变那件事）。
 *
 * **空表是正常答案**，而且比三字组那一栏多一种：抽出来的每一条只要有一条过不了字节面
 * （`byteClean`），**整条交回空表**——调用方落到"整段先试"那一条路上，绝不拿一条判不准的字面量
 * 去跳一份文件。
 */
export function requiredLiterals(pattern: string, flags = ''): string[] {
  const must = requiredOf(pattern, flags)
  if (must === null) return []
  const out = [...must.runs]
  for (const run of out) if (!byteClean(run)) return []
  return out
}
