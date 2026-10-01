// 索引候选过滤绝不能漏掉 RegExp 的真命中；无法证明必需的 literal 就返回 null 扫描。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_LITERAL_PATTERN_UNITS, MAX_REQUIRED_TRIGRAMS, requiredLiteralTrigrams } from './regex-literal.ts'

function gramsOf(text: string): Set<string> {
  const grams = new Set<string>()
  for (let at = 0; at + 2 < text.length; at++) grams.add(text.slice(at, at + 3))
  return grams
}

test('plain literals, simple anchors and escaped punctuation produce required UTF-16 grams', () => {
  assert.deepEqual(requiredLiteralTrigrams('hello', ''), ['ell', 'hel', 'llo'])
  assert.deepEqual(requiredLiteralTrigrams('^hello$', ''), requiredLiteralTrigrams('hello', ''))
  assert.deepEqual(requiredLiteralTrigrams('a\\.b', ''), ['a.b'])
  assert.deepEqual(requiredLiteralTrigrams('a\\*b', ''), ['a*b'])
  assert.deepEqual(requiredLiteralTrigrams('a/b', ''), ['a/b'])
  assert.deepEqual(requiredLiteralTrigrams('a\\/b', ''), ['a/b'])
  assert.deepEqual(requiredLiteralTrigrams('a\\-b', ''), ['a-b'])
  assert.deepEqual(requiredLiteralTrigrams('\\^foo\\$', ''), [...gramsOf('^foo$')].sort())
  assert.deepEqual(requiredLiteralTrigrams('foo\\\\$', ''), [...gramsOf('foo\\')].sort())
  assert.deepEqual(requiredLiteralTrigrams(' ^foo ', ''), null)
})

test('ambiguous regex syntax and all flags fail open to scanning', () => {
  for (const pattern of ['', 'a', 'ab', '^$', '.', 'foo|bar', 'abc|xyz', 'abc*', 'abc?', '(?!abc)xyz', 'abc(?!d)', '(?<!a)bc', '(?i:abc)', '(foo)', '(?:foo)', '(?=foo)', 'foo+', 'foo*', 'foo?', 'foo{2}', '[foo]', '\\wfoo', '\\bfoo', '(foo)\\1', '\\u0066oo', '\\x66oo', '\\nfoo', 'foo\\', '^foo$$']) {
    assert.equal(requiredLiteralTrigrams(pattern, ''), null, pattern)
  }
  for (const flags of ['i', 'm', 'u', 'g', 's', 'y', 'v', 'unknown']) assert.equal(requiredLiteralTrigrams('hello', flags), null)
})

test('an omitted flags argument cannot be read as a claim of no flags', () => {
  // /hello/i 匹配 "HELLO"，而 "hel" 不是它的子串：漏传一次 flags 就等于造出假必需条件。
  const forgetful = requiredLiteralTrigrams as unknown as (pattern: string) => readonly string[] | null
  assert.equal(forgetful('hello'), null)
  assert.equal(forgetful('^abcdef$'), null)
  assert.deepEqual(requiredLiteralTrigrams('hello', ''), ['ell', 'hel', 'llo'])
})

test('Unicode, replacement characters and surrogate boundaries share index code-unit semantics', () => {
  for (const literal of ['中😀文', '😀abc', '�hit', '\ud800abc', 'abc\udc00']) {
    assert.deepEqual(requiredLiteralTrigrams(literal, ''), [...gramsOf(literal)].sort())
    assert.ok(requiredLiteralTrigrams(literal, '')!.every(gram => gram.length === 3))
  }
})

test('derived query work is bounded and never returns an empty exclusion set', () => {
  assert.equal(requiredLiteralTrigrams('x'.repeat(MAX_LITERAL_PATTERN_UNITS + 1), ''), null)
  assert.deepEqual(requiredLiteralTrigrams('x'.repeat(MAX_LITERAL_PATTERN_UNITS), ''), ['xxx'])
  const many = Array.from({ length: 1000 }, (_, at) => String.fromCharCode(0x400 + at)).join('')
  const required = requiredLiteralTrigrams(many, '')!
  assert.ok(required.length > 0 && required.length <= MAX_REQUIRED_TRIGRAMS)
  const available = gramsOf(many)
  for (const gram of required) assert.ok(available.has(gram))
  assert.deepEqual(requiredLiteralTrigrams('a'.repeat(100), ''), ['aaa'])
})

test('a seeded literal/reference matrix never excludes a matching line', () => {
  let seed = 0x12345678
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const alphabet = ['a', 'b', 'c', '.', '*', '$', '^', '[', ']', '\\', '-', '/', '中', '😀', '�']
  const escape = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (let turn = 0; turn < 3000; turn++) {
    const literal = Array.from({ length: 3 + next() % 20 }, () => alphabet[next() % alphabet.length]!).join('')
    const pattern = (next() % 2 ? '^' : '') + escape(literal) + (next() % 2 ? '$' : '')
    const required = requiredLiteralTrigrams(pattern, '')
    if (required === null) continue
    const regex = new RegExp(pattern)
    for (const line of [literal, 'prefix' + literal, literal + 'suffix', 'other', '中😀' + literal + '\r']) {
      if (regex.test(line)) {
        const available = gramsOf(line)
        for (const gram of required) assert.ok(available.has(gram), JSON.stringify({ pattern, line, gram }))
      }
    }
  }
})

test('a seeded adversarial matrix never requires a gram some matching string lacks', () => {
  // 上一个矩阵的 pattern 是整段转义得到的，所以任何命中行必然含整段 literal——它验的是「不多取」。
  // 这一个反过来：直接拼提取器**会接受**的 token（转义标点 + 内外锚点），再对抗性采样 subject。
  let seed = 0xc0ffee
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  // 每个 token 是「pattern 里的写法 → 它实际匹配的那一个字符」。
  const tokens: readonly (readonly [string, string])[] = [['a', 'a'], ['b', 'b'], ['c', 'c'], ['\\.', '.'], ['\\$', '$'], ['\\^', '^'], ['\\\\', '\\'], ['\\*', '*'], ['\\+', '+'], ['\\?', '?'], ['\\(', '('], ['\\)', ')'], ['\\[', '['], ['\\]', ']'], ['\\{', '{'], ['\\}', '}'], ['\\|', '|'], ['\\/', '/'], ['\\-', '-'], ['/', '/'], ['-', '-']]
  const pool = ['a', 'b', 'c', '.', '$', '^', '\\', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/', '-']
  let accepted = 0
  let matching = 0
  for (let turn = 0; turn < 2000; turn++) {
    const anchorStart = next() % 2 === 0
    let pattern = anchorStart ? '^' : ''
    let literal = ''
    for (let piece = 0, pieces = 3 + next() % 4; piece < pieces; piece++) {
      const token = tokens[next() % tokens.length]!
      pattern += token[0]
      literal += token[1]
    }
    if (next() % 2) pattern += '$'
    const required = requiredLiteralTrigrams(pattern, '')
    if (required === null) continue
    accepted++
    const regex = new RegExp(pattern)
    // subject 从那段 literal 变异而来（删一个 · 换一个 · 插一个 · 加前后缀），
    // 否则纯随机串几乎永不命中，断言就空跑了。
    for (let probe = 0; probe < 24; probe++) {
      const at = next() % literal.length
      const filler = pool[next() % pool.length]!
      const mutated = [
        literal,
        literal.slice(0, at) + literal.slice(at + 1),
        literal.slice(0, at) + filler + literal.slice(at + 1),
        literal.slice(0, at) + filler + literal.slice(at),
        filler + literal,
        literal + filler,
      ][next() % 6]!
      if (!regex.test(mutated)) continue
      matching++
      for (const gram of required) assert.ok(mutated.includes(gram), JSON.stringify({ pattern, subject: mutated, gram }))
    }
  }
  assert.ok(accepted > 100, `the matrix must not be vacuous, accepted ${accepted}`)
  assert.ok(matching > 1000, `matching subjects must actually exercise the assertion, got ${matching}`)
})

test('inserting any metacharacter into an accepted literal forces the scan path', () => {
  assert.deepEqual(requiredLiteralTrigrams('abcabc', ''), ['abc', 'bca', 'cab'])
  for (const meta of ['*', '?', '+', '|', '[a]', '(?:x)', '(x)', '{2}', '.', '(?=x)', '(?!x)']) {
    for (let at = 0; at <= 6; at++) {
      const pattern = 'abcabc'.slice(0, at) + meta + 'abcabc'.slice(at)
      assert.equal(requiredLiteralTrigrams(pattern, ''), null, pattern)
    }
  }
})
