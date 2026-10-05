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
//
// **只少不多是这一层的口径**：认不出、可省、重复次数不定，一律少取几条（少几条只是候选集不够小，
// 候选集大了只是慢）；取错一条才是漏报。所以下面有几条是"保守地取不到"，它们由注释点明，不写成
// 反向断言——`a{3}bc` 匹配的 `aaabc` 里其实有 `abc`，这一层不取它，是取舍不是错。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requiredTrigrams } from './pattern.ts'
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

// ── ① 性质：必须有 == 匹配文本里真有 ─────────────────────────────────────────

test('① 手写表：每一条模式的每一段匹配文本，都含抽出来的每一条三字组', () => {
  const cases: [string, string[]][] = [
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
  let checked = 0
  for (const [pattern, texts] of cases) {
    const re = new RegExp(pattern)
    for (const text of texts) {
      assert.ok(re.test(text), `${JSON.stringify(pattern)} 匹配不了 ${JSON.stringify(text)}——这一条对照是空话`)
      const missing = missingIn(pattern, text)
      assert.deepEqual(missing, [], `${JSON.stringify(pattern)} 在 ${JSON.stringify(text)} 上取错了：${missing.join(' · ')}`)
      checked += 1
    }
  }
  console.log(`① 读数：${cases.length} 条模式 · ${checked} 段匹配文本，抽出来的三字组一条不落都在文本里`)
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
