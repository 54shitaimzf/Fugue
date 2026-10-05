// 查询接线那一半的断言①：**模式 → 必须有那几条三字组**。
// 跑法：cd ~/fugue && node --test src/search/pattern.test.ts
//
// 这一份要量的是"跳过一个 blob 凭什么安全"：抽出来的每一条三字组都必须出现在**每一段**能被这条
// 模式匹配的文本里。所以主判据不是形状表，是那条性质（①②），形状表只是把边界一条条点出来。
//
//   ① 性质：表里每一条模式 × 它的每一段匹配文本，抽出来的三字组**一条不落**地出现在那段文本里
//      ——对手：把"必须有"做成"可能有"（择一取并集 · 可省的量词照收 · 环视里的字面量照收）
//   ② 性质（随机）：同一件事在伪随机生成的一大批模式与文本上重跑一遍，覆盖手写表想不到的组合
//   ③ 认不出来是空表，不是"空候选"：单汉字/两字 · 通配 · 空字符组 · 认不出的形状 → 空表
//   ④ 键空间与匹配器同一格：中文 · U+FFFD（非法 UTF-8 解码之后那一个单元）都在表里
//   ⑥ 必含字面量那一栏（②）：同一条性质在字面量上重跑一遍——**单汉字与两字在这一栏上有一条**
//      （三字组那一栏对它们是空表）；字面量含 U+FFFD 或落单代理时**整条交回空表**
//   ⑦ 连接处那三栏（0.3.4 提案 5）：择一紧挨着字面量时**跨过连接处**的那条三字组取出来了
//      ——`(get|set)Value` 的 `etV`；零增益那几条**一条都不许多**（`read(only|write)` 仍是两条）；
//      备选那一栏超上限（`MAX_EXACT = 7`）就退回"不知道"，而**开头/结尾那两栏接得住**
//
// **只少不多是这一层的口径**：认不出、可省、重复次数不定，一律少取几条（少几条只是候选集不够小，
// 候选集大了只是慢）；取错一条才是漏报。所以下面有几条是"保守地取不到"，它们由注释点明，不写成
// 反向断言——`a{3}bc` 匹配的 `aaabc` 里其实有 `abc`，这一层不取它，是取舍不是错。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requiredLiterals, requiredTrigrams } from './pattern.ts'
import { gramAt } from '../index/trigram.ts'

/** 一条三字组键 → 它那三个单元拼成的文本（与 `index/trigram.ts` 的取键同一条算术）。 */
function textOfGram(gram: number): string {
  const units = [
    Math.floor(gram / 0x1_0000_0000),
    Math.floor(gram / 0x1_0000) % 0x1_0000,
    gram % 0x1_0000,
  ]
  return String.fromCharCode(...units)
}

/** 这条模式抽出来的三字组，有没有一条不在这段文本里。 */
function missingIn(pattern: string, text: string): string[] {
  return requiredTrigrams(pattern)
    .map(textOfGram)
    .filter((g) => !text.includes(g))
}

/** 该抽到的抽到了（抓的是"取错"，不是"取少"）。 */
function has(pattern: string, ...grams: string[]): void {
  const got = new Set(requiredTrigrams(pattern).map(textOfGram))
  for (const g of grams) assert.ok(got.has(g), `${JSON.stringify(pattern)} 少取了 ${JSON.stringify(g)}：${[...got].join(' · ')}`)
}

function lacks(pattern: string, ...grams: string[]): void {
  const got = new Set(requiredTrigrams(pattern).map(textOfGram))
  for (const g of grams) assert.ok(!got.has(g), `${JSON.stringify(pattern)} 多取了 ${JSON.stringify(g)}——那一条不在每一段匹配文本里`)
}

/** 这条模式抽出来的三字组，**排过序**：这一格量的是"哪几条"，抽取的先后不是判据。 */
function gramsOf(pattern: string): string[] {
  return requiredTrigrams(pattern).map(textOfGram).sort()
}

/** 这条模式抽出来的字面量（② 那一栏）。 */
function literalsOf(pattern: string, flags = ''): Set<string> {
  return new Set(requiredLiterals(pattern, flags))
}

/** 字面量那一栏该抽到的抽到了（抓的是"取错"，不是"取少"）。 */
function hasLiteral(pattern: string, ...want: string[]): void {
  const got = literalsOf(pattern)
  for (const w of want) {
    assert.ok(got.has(w), `${JSON.stringify(pattern)} 少取了字面量 ${JSON.stringify(w)}：${[...got].join(' · ')}`)
  }
}

/** 这条模式抽出来的字面量，有没有一条不在这段文本里（⑥ 的性质，与 `missingIn` 同一件事的另一栏）。 */
function missingLiteralsIn(pattern: string, text: string): string[] {
  return requiredLiterals(pattern).filter((run) => !text.includes(run))
}

/**
 * 手写表：① 与 ⑥ 共用同一张（**一处真相**——两栏抽取各抄一份，迟早有一份落后）。
 * 每一条是 `[模式, 它能匹配的那几段文本]`。
 */
const PATTERN_CASES: readonly (readonly [string, readonly string[]])[] = [
  ['export function', ['export function alpha()', 'export function', 'xx export function yy']],
  ['导出索引落盘', ['导出索引落盘格式', 'a 导出索引落盘 b']],
  ['foo\\.bar', ['foo.bar', 'x foo.bar y', 'foo.barbaz']],
  ['foo.*bar', ['foobar', 'foo---bar']],
  ['export function|export class', ['export function f()', 'export class C {}']],
  ['^[abc]def', ['adef', 'cdef']],
  ['(foo|bar)baz', ['foobaz', 'barbaz']],
  ['(?:ab)+cde', ['abcde', 'ababcde', 'abababcde']],
  ['ab{2}c', ['abbc', 'xabbcy']],
  ['ab{1}c', ['abc']],
  ['a{3}bc', ['aaabc']],
  ['\\u0041bcdef', ['Abcdef']],
  ['(?=foo)foobar', ['foobar']],
  ['foo$', ['foo']],
  ['\\d\\d\\d\\d', ['1234', '9999']],
  ['[\\s]defg', [' defg', 'x defg']],
  ['x[^y]zabc', ['xqzabc', 'xazabc']],
  ['foo(?:bar)?bazqux', ['foobazqux', 'foobarbazqux']],
  ['\\bword\\b', ['a word here', 'word']],
  ['foo\\1', ['foo\u0001', 'xfoo\u0001']],
]

// ── ① 性质：必须有 == 匹配文本里真有 ─────────────────────────────────────────

test('① 手写表：每一条模式的每一段匹配文本，都含抽出来的每一条三字组', () => {
  let checked = 0
  for (const [pattern, texts] of PATTERN_CASES) {
    const re = new RegExp(pattern)
    for (const text of texts) {
      assert.ok(re.test(text), `${JSON.stringify(pattern)} 匹配不了 ${JSON.stringify(text)}——这一条对照是空话`)
      const missing = missingIn(pattern, text)
      assert.deepEqual(missing, [], `${JSON.stringify(pattern)} 在 ${JSON.stringify(text)} 上取错了：${missing.join(' · ')}`)
      checked += 1
    }
  }
  console.log(`① 读数：${PATTERN_CASES.length} 条模式 · ${checked} 段匹配文本，抽出来的三字组一条不落都在文本里`)
})

test('①b 该抽到的抽到了（不是"空表也过"）', () => {
  has('export function', 'exp', 'xpo', 'por', 'ort', 'rt ', 't f', ' fu', 'fun', 'unc', 'nct', 'cti', 'tio', 'ion')
  has('导出索引落盘', '导出索', '出索引', '索引落', '引落盘')
  has('foo\\.bar', 'foo', 'oo.', 'o.b', '.ba', 'bar')
  has('foo.*bar', 'foo', 'bar')
  has('export function|export class', 'exp', 'xpo', 'por', 'ort', 'rt ')
  lacks('export function|export class', 'ion', 'fun', 'las', 'ass')
  has('^[abc]def', 'def')
  has('(?:ab)+cde', 'cde')
  has('ab{1}c', 'abc')
  has('foo\\1', 'foo')
  has('(?=foo)foobar', 'foo', 'oob', 'oba', 'bar')
})

// ── ② 性质（随机）────────────────────────────────────────────────────────────

test('② 伪随机模式 × 伪随机文本：同一条性质重跑一遍', () => {
  // 确定性 LCG：同一份种子跑出同一批模式，读数可复现（不是时间种）。
  let seed = 20261005
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 0x8000_0000
    return seed / 0x8000_0000
  }
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
  const pieces = ['a', 'b', 'c', 'ab', 'bc', 'abc', 'abcd', '.', '[ab]', '[^a]', 'a?', 'b*', 'c+', 'a{2}', '(?:ab)', '(a|b)', 'ab|bc', '^', '$', '\\d', '\\.', 'x']
  const texts: string[] = []
  for (let i = 0; i < 400; i++) {
    let line = ''
    const width = 4 + Math.floor(rnd() * 12)
    for (let j = 0; j < width; j++) line += pick(['a', 'b', 'c', 'd', 'x', '.', '1'])
    texts.push(line)
  }
  let valid = 0
  let matched = 0
  for (let i = 0; i < 300; i++) {
    let pattern = ''
    const width = 1 + Math.floor(rnd() * 4)
    for (let j = 0; j < width; j++) pattern += pick(pieces)
    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch {
      continue
    }
    valid += 1
    for (const text of texts) {
      if (!re.test(text)) continue
      matched += 1
      const missing = missingIn(pattern, text)
      assert.deepEqual(missing, [], `模式 ${JSON.stringify(pattern)} 在 ${JSON.stringify(text)} 上取错了：${missing.join(' · ')}`)
    }
  }
  assert.ok(valid >= 200, `合起来只有 ${valid} 条模式编得过——这一趟没量到东西`)
  assert.ok(matched >= 200, `匹配上的（模式 · 文本）只有 ${matched} 对——这一趟没量到东西`)
  console.log(`② 读数：${valid} 条模式 × ${texts.length} 段文本，匹配上的 ${matched} 对，全部通过`)
})

// ── ③ 短查询与认不出来的形状 ────────────────────────────────────────────────

test('③ 单汉字/两字与认不出的形状：空表（调用方照旧走扫描）', () => {
  for (const pattern of ['', 'a', '导', '导出', 'ab', '.', '..', '.*', '^$', '\\d\\d', '[abc][def]', 'a|b', '\\b', '(?=x)', 'x(?=y)', '(unclosed', 'a)', '[]a]defg']) {
    assert.deepEqual(requiredTrigrams(pattern), [], `${JSON.stringify(pattern)} 取出了三字组——它没有"必须有"的那一条`)
  }
  // 边界：正好三个字面单元取得到；两个取不到（单汉字/两字就是这一档）。
  assert.equal(requiredTrigrams('abc').length, 1)
  assert.deepEqual(requiredTrigrams('ab'), [])
})

test('⑤ flags 与深嵌套：认不出就交空表，绝不抛、也绝不猜', () => {
  // flags 那一栏是"要调用点证明它没有"：`/hel/i` 匹配 `HELLO`，而 `hel` 不是 `HELLO` 的子串——
  // 拿不敏感模式抽出来的三字组去筛，就是候选集少了的那一类漏报。
  assert.deepEqual(requiredTrigrams('abcdef', 'i'), [], '带着 flags 还抽了三字组——那是漏报那一类')
  assert.ok(requiredTrigrams('abcdef', '').length > 0, '空串那一档该照常抽（这一条是"两边都有东西"那一半）')
  // 深嵌套：递归下降吃调用栈，超限与其它认不出的形状同一条出口（交空表，不抛）。
  const deep = '('.repeat(600) + 'abc' + ')'.repeat(600)
  assert.deepEqual(requiredTrigrams(deep), [], '深嵌套没有当场交出空表')
  const wild = '('.repeat(5000) + 'abc' + ')'.repeat(5000)
  assert.deepEqual(requiredTrigrams(wild), [], '五千层没有当场交出空表——这一块要么抛栈、要么算很久')
  // 浅的那一档照常抽（上限不是"一律不抽"）。
  assert.deepEqual(requiredTrigrams('('.repeat(20) + 'abc' + ')'.repeat(20)), requiredTrigrams('abc'))
  console.log('⑤ 读数：flags 非空 → 空表 · 20 层嵌套照常抽 · 600 层与 5000 层 → 空表（不抛）')
})

test('④ 键空间与匹配器同一格：中文 · U+FFFD · 码点转义', () => {
  const replacement = 'a\uFFFDb'
  has(replacement, replacement)
  // 非法 UTF-8 解码之后是 U+FFFD：那一段文本里含 U+FFFD 这一条三字组，与查询串里的 U+FFFD 同一格。
  const decoded = Buffer.from([0x61, 0xc3, 0x62]).toString('utf8')
  assert.equal(decoded, 'a\uFFFDb')
  assert.deepEqual(missingIn(replacement, decoded), [])
  // `\u{…}` 与代理对：宽码点照样按单元取键
  has('\\u{1F600}x', '\u{1F600}x')
  has('\\uD83D\\uDE00x', '\u{1F600}x')
})

// ── ⑥ 必含字面量（② 的抽取器一侧）────────────────────────────────────────────

test('⑦ 连接处那三栏：跨过连接处的三字组取出来了 · 零增益的一条不多 · 超上限退回"不知道"', () => {
  // **批复的那一条断言**：`(get|set)Value` 抽出来的"必须有"里要含 `etV`——它前两个单元来自择一
  // 那一支、后一个来自 `Value`，两边的"自己含什么"里都没有它（只有跨过连接处才算得出来）。
  // 整张表一起钉住：多一条就是"其实不必有"的错报，少一条就是没拿到这一项的增益。
  assert.deepEqual(gramsOf('(get|set)Value'), ['Val', 'alu', 'etV', 'lue', 'tVa'])
  // 零增益那一条**一条都不许多**（把"备选"当"合取"做叉积，就会在这儿多出一族不必有的）。
  assert.deepEqual(gramsOf('read(only|write)'), ['ead', 'rea'])
  assert.deepEqual(gramsOf('(async|await) function'), [' fu', 'cti', 'fun', 'ion', 'nct', 'tio', 'unc'])
  assert.deepEqual(gramsOf('trigram(s|es)?'), ['gra', 'igr', 'ram', 'rig', 'tri'])
  // 同名那一份是"备选之间一个单元都不共享"的那一档：跨边界那条取不出来。
  assert.deepEqual(gramsOf('x(Value|Vector)'), [])
  // **codesearch 测试里那四个三字组在本站一个都不是"必须有"的**：它走的是择一档（析取），本站的
  // 派发是逐条取交——`abcghi` 里没有 `bcd`。取公共的那一部分才是这一条路上安全的一半。
  assert.deepEqual(gramsOf('abc(def|ghi)'), ['abc'])
  // 两条性质测试抓回来的形状**单列在这儿**（它们各自值一条负对照）：
  //   一 · `xbc` 的结尾是"备选"、`(a|b)` 的整体也是"备选"——两层备选直接做叉积会得到 `bca`，
  //        而 `^xbc(a|b)` 匹配 `xbcb` 时里面没有 `bca`。
  assert.deepEqual(gramsOf('^xbc(a|b)'), ['xbc'])
  //   二 · `.*` **可能**匹配空串，于是 `foo.*` 的结尾差一点被 `foo` 定住——`foo---bar` 里没有
  //        `obar`。只有那一段**一定**空（零宽）才轮得到继承。
  assert.deepEqual(gramsOf('foo.*bar'), ['bar', 'foo'])
  // 括号不是连接处的墙：`(foo)bar` 与 `foobar` 一样跨得过去（多出来的是 `oba` `oob`）。
  assert.deepEqual(gramsOf('(foo)bar'), ['bar', 'foo', 'oba', 'oob'])
  // **备选那一栏的上限**：7 条备选时 `exact` 还在（`(get|set|put|let|net|bet|vet)Value` 里其实
  // 只有 `tVa` 是每一条备选都产出的）；8 条就把 `exact` 顶掉（`MAX_EXACT = 7`），而**开头/结尾那
  // 两栏接得住**——八条备选全都以 `t` 结尾，所以 `tVa` 照旧取出来。这正是三栏比"只做备选叉积"
  // 多出来的那一块：备选一多就退回"不知道"的那一栏，恰是它接住了。
  assert.deepEqual(gramsOf('(get|set|put|let|net|bet|vet)Value'), ['Val', 'alu', 'lue', 'tVa'])
  assert.deepEqual(gramsOf('(get|set|put|let|net|bet|vet|met)Value'), ['Val', 'alu', 'lue', 'tVa'])
  // 顶着上限那一档是**退回"不知道"**，不是"顺手多报一条"：八条首字母互不相同的备选跨不过去。
  assert.deepEqual(gramsOf('(a|b|c|d|e|f|g|h)xyz'), ['xyz'])
  console.log(
    '⑦ 读数：跨边界取出来了（`(get|set)Value` 5 条，含 `etV`）· 零增益那三条一条不多（`read(only|write)` 2 条 · ' +
      '`(async|await) function` 7 条 · `trigram(s|es)?` 5 条）· 备选 8 条时 `exact` 退回而 `suffix` 接住（仍是 `tVa`）',
  )
})

test('⑥ 必含字面量：每一条都出现在每一段匹配文本里；含 U+FFFD 或落单代理时整条交回空表', () => {
  // 一 · 手写表（与 ① 共用同一张）：抽出来的每一条字面量都在每一段匹配文本里。对手是**漏报**：
  // 字面量不必需 ⇒ 整份文件被误跳。
  let checked = 0
  for (const [pattern, texts] of PATTERN_CASES) {
    const re = new RegExp(pattern)
    for (const text of texts) {
      assert.ok(re.test(text), `${JSON.stringify(pattern)} 匹配不了 ${JSON.stringify(text)}——这一条对照是空话`)
      const missing = missingLiteralsIn(pattern, text)
      assert.deepEqual(missing, [], `${JSON.stringify(pattern)} 在 ${JSON.stringify(text)} 上取错了：${missing.join(' · ')}`)
      checked += 1
    }
  }

  // 二 · **不是"空表也过"**：该抽到的抽到了——含单汉字与两字那一档（三字组那一栏对它们是空表，
  // 而这一栏有一条，那正是短查询按字节预筛的落点）。
  hasLiteral('export function', 'export function')
  hasLiteral('ab', 'ab')
  hasLiteral('导', '导')
  hasLiteral('导出', '导出')
  hasLiteral('foo.*bar', 'foo', 'bar')
  hasLiteral('(get|set)Value', 'Value')
  hasLiteral('(foo|bar)baz', 'baz')
  hasLiteral('ab{2}c', 'ab', 'c')
  hasLiteral('\\u0041bcdef', 'Abcdef')
  assert.equal(literalsOf('(foo|bar)baz').has('foo'), false, '择一取交：`foo` 不是每一条分支都含')
  assert.equal(literalsOf('(foo|bar)baz').has('bar'), false, '择一取交：`bar` 也不是')
  // 可省那一档的边界（`min = 0` 收段那条律的落点）：**可以一次都不出现的那一段不许收**。
  assert.deepEqual([...literalsOf('abc?')].sort(), ['ab'], '`c?` 可以一次都不出现——`c` 不是"必须有"的')
  assert.deepEqual([...literalsOf('fo?o')].sort(), ['f', 'o'], '`o?` 不收，而它两侧各有一个单元的字面量')
  // 认不出来那一档照旧是空表（与三字组同一扇门）。
  for (const pattern of ['', '\\d\\d\\d', '.*', '^$', '[abc][def]', 'a|b', '(?=x)']) {
    assert.deepEqual(requiredLiterals(pattern), [], `${JSON.stringify(pattern)} 取出了字面量——它不是"必须有"的`)
  }
  assert.deepEqual(requiredLiterals('abcdef', 'i'), [], '带着 flags 还抽了字面量——那是漏报那一类')
  assert.ok(requiredLiterals('abcdef').length > 0, '空串 flags 那一档该照常抽（这一条是"两边都有东西"那一半）')

  // 三 · **字节面判不了的那两档：整条交回空表**（调用方落到整段试那一条路上）。
  assert.deepEqual(requiredLiterals('a\uFFFDb'), [], '字面量含 U+FFFD：交回空表（非法 UTF-8 的文件解码之后会出现它）')
  assert.deepEqual(requiredLiterals('\\uFFFDabc'), [], '源里写 `\\uFFFD` 是同一件事')
  assert.deepEqual(requiredLiterals('\\uD83Dabc'), [], '落单的代理：编回字节是 EF BF BD、解回来是 U+FFFD，字节面同样判不准')
  // 干净那一档照旧抽得出来（"两边都有东西"那一半）。
  assert.deepEqual(requiredLiterals('abc'), ['abc'])
  assert.deepEqual(requiredLiterals('\\u{1F600}xy'), ['\u{1F600}xy'])

  // 四 · 伪随机：同一件事在大批模式与文本上重跑一遍（种子与 ② 不同——两条性质各扫自己那一批）。
  let seed = 20261006
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 0x8000_0000
    return seed / 0x8000_0000
  }
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
  const pieces = ['a', 'b', 'c', 'ab', 'bc', 'abc', 'abcd', '.', '[ab]', '[^a]', 'a?', 'b*', 'c+', 'a{2}', '(?:ab)', '(a|b)', 'ab|bc', '^', '$', '\\d', '\\.', 'x']
  const texts: string[] = []
  for (let i = 0; i < 400; i++) {
    let line = ''
    const width = 4 + Math.floor(rnd() * 12)
    for (let j = 0; j < width; j++) line += pick(['a', 'b', 'c', 'd', 'x', '.', '1'])
    texts.push(line)
  }
  let valid = 0
  let matched = 0
  let taken = 0
  for (let i = 0; i < 300; i++) {
    let pattern = ''
    const width = 1 + Math.floor(rnd() * 4)
    for (let j = 0; j < width; j++) pattern += pick(pieces)
    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch {
      continue
    }
    valid += 1
    for (const text of texts) {
      if (!re.test(text)) continue
      matched += 1
      taken += requiredLiterals(pattern).length
      const missing = missingLiteralsIn(pattern, text)
      assert.deepEqual(missing, [], `模式 ${JSON.stringify(pattern)} 在 ${JSON.stringify(text)} 上取错了：${missing.join(' · ')}`)
    }
  }
  assert.ok(valid >= 200, `合起来只有 ${valid} 条模式编得过——这一趟没量到东西`)
  assert.ok(matched >= 200, `匹配上的（模式 · 文本）只有 ${matched} 对——这一趟没量到东西`)
  assert.ok(taken >= 200, `抽出来的字面量一共只有 ${taken} 条——这一趟没量到东西（空表也过）`)
  console.log(
    `⑥ 读数：手写表 ${checked} 段匹配文本 · 伪随机 ${valid} 条模式 × ${texts.length} 段文本（匹配 ${matched} 对 · 抽到字面量 ${taken} 条）` +
      ' 一条不落都在文本里 · U+FFFD 与落单代理两档整条交回空表',
  )
})
