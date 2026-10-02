// 索引候选过滤绝不能漏掉 RegExp 的真命中；无法证明必需的 literal 就返回 null 扫描。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_LITERAL_GROUP_DEPTH, MAX_LITERAL_PATTERN_UNITS, MAX_REQUIRED_TRIGRAMS, requiredLiteralTrigrams } from './regex-literal.ts'

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

test('balanced unquantified literal groups preserve concatenation across their boundaries', () => {
  for (const pattern of ['rare(?:_hit)', 'rare(_hit)', '(rare)(?:_)(hit)', '^(?:ra(r))e(?:_h(it))$', '()rare(?:)(?:_hit)']) {
    assert.deepEqual(requiredLiteralTrigrams(pattern, ''), requiredLiteralTrigrams('rare_hit', ''), pattern)
  }
  assert.deepEqual(requiredLiteralTrigrams('(?:中)(😀)文', ''), requiredLiteralTrigrams('中😀文', ''))
  assert.deepEqual(requiredLiteralTrigrams('(?:a\\(b\\))\\|\\$', ''), requiredLiteralTrigrams('a\\(b\\)\\|\\$', ''))
  assert.deepEqual(requiredLiteralTrigrams('abc(?:)', ''), ['abc'])
  assert.equal(requiredLiteralTrigrams('(?:ab)', ''), null)
})

test('unsupported or malformed group contents refuse the entire index condition', () => {
  for (const pattern of ['(abc){1}', '(abc|xyz)',
    '(?:abc|xyz)', '(abc*)', '(?:[abc])', '(?=abc)', '(?!abc)', '(?<=abc)',
    '(?<!abc)', '(?<name>abc)', '(?i:abc)', '(abc)\\1', '(?:\\wabc)', '(?:^abc)', '(abc$)',
    'abc)', '(abc', '(?:abc', '(?abc)', '(?:abc)$$']) {
    assert.equal(requiredLiteralTrigrams(pattern, ''), null, pattern)
  }
  for (const flags of ['i', 'm', 'u', 'g', 's', 'y', 'v']) assert.equal(requiredLiteralTrigrams('rare(?:_hit)', flags), null)
})

test('mandatory runs stop at optional children and variable atoms without false bridges', () => {
  for (const pattern of ['rare(_hit)?', 'rare(?:_hit)*', '^(rare)(?:_hit)?$']) {
    assert.deepEqual(requiredLiteralTrigrams(pattern, ''), ['are', 'rar'], pattern)
  }
  assert.deepEqual(requiredLiteralTrigrams('rare.*hit', ''), ['are', 'hit', 'rar'])
  assert.deepEqual(requiredLiteralTrigrams('abc?def', ''), ['def'])
  assert.equal(requiredLiteralTrigrams('ab(c)?de', ''), null)
  assert.deepEqual(requiredLiteralTrigrams('foo(needle.*tail)?bar', ''), ['bar', 'foo'])
  assert.deepEqual(requiredLiteralTrigrams('abc(?:x(y)?z)?def', ''), ['abc', 'def'])
  assert.deepEqual(requiredLiteralTrigrams('abc()*def', ''), ['abc', 'def'])
  assert.deepEqual(requiredLiteralTrigrams('abc.def', ''), ['abc', 'def'])
  assert.deepEqual(requiredLiteralTrigrams('(?:abc.)', ''), ['abc'])
  assert.equal(requiredLiteralTrigrams('(abc)*', ''), null)
  assert.equal(requiredLiteralTrigrams('.*', ''), null)
  // No flags means the quantifier applies to the LOW surrogate atom, not the whole emoji.
  assert.deepEqual(requiredLiteralTrigrams('ab😀?def', ''), ['ab\ud83d', 'def'])
  for (const subject of ['ab😀def', 'ab\ud83ddef']) {
    assert.ok(new RegExp('ab😀?def').test(subject))
    for (const gram of requiredLiteralTrigrams('ab😀?def', '')!) assert.ok(subject.includes(gram))
  }
})

test('unsupported quantifiers and optional-group contents still refuse the whole condition', () => {
  for (const pattern of ['?abc', '*abc', 'abc??', 'abc**', 'abc?*', 'abc*?', 'abc.*?', 'abc.+?',
    'abc{0}def', 'abc(?:x|y)?def', 'abc(?:x++)?def', 'abc(?=x)?def', 'abc[xyz]?def', 'abc\\s*def']) {
    assert.equal(requiredLiteralTrigrams(pattern, ''), null, pattern)
  }
  const invalidTail = 'x'.repeat(MAX_LITERAL_PATTERN_UNITS - 1) + '|'
  assert.equal(requiredLiteralTrigrams(invalidTail, ''), null, 'early gram cap cannot hide an unsupported tail')
})

test('exhaustive variable-barrier subjects preserve every mandatory-run condition', () => {
  const subjects = ['']
  for (let length = 1; length <= 8; length++) {
    for (let bits = 0; bits < 2 ** length; bits++) subjects.push(bits.toString(2).padStart(length, '0').replace(/0/g, 'a').replace(/1/g, 'b'))
  }
  let matching = 0, accepted = 0
  for (const before of ['', 'ab', 'aab', 'abab']) {
    for (const after of ['', 'ba', 'bba', 'baba']) {
      for (const barrier of ['a?', 'b*', '.', '.*', '(ab)?', '(?:ab)*', '(?:a(b)?a)?', '()?', '(?:)']) {
        for (const anchors of [false, true]) {
          const pattern = (anchors ? '^' : '') + before + barrier + after + (anchors ? '$' : '')
          const required = requiredLiteralTrigrams(pattern, '')
          if (required === null) continue
          accepted++
          const regex = new RegExp(pattern)
          for (const subject of subjects) {
            if (!regex.test(subject)) continue
            matching++
            for (const gram of required) assert.ok(subject.includes(gram), JSON.stringify({ pattern, subject, gram }))
          }
        }
      }
    }
  }
  assert.ok(accepted > 100, `accepted conditions must be exercised: ${accepted}`)
  assert.ok(matching > 1000, `true matches must be exercised: ${matching}`)
})

test('seeded Unicode optional subtrees never leak their conditions or bridge their neighbors', () => {
  let seed = 0x3ab142
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const alphabet = ['a', '.', '$', '^', '(', ')', '|', '\\', '中', '😀', '�', '\ud800']
  const word = () => Array.from({ length: 3 + next() % 5 }, () => alphabet[next() % alphabet.length]!).join('')
  const escape = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let matching = 0
  for (let turn = 0; turn < 2000; turn++) {
    const before = word(), middle = word(), after = word()
    const optional = next() % 2 ? '?' : '*'
    const pattern = '^' + escape(before) + '(' + escape(middle) + ')' + optional + escape(after) + '$'
    const required = requiredLiteralTrigrams(pattern, '')
    assert.ok(required !== null)
    const regex = new RegExp(pattern)
    for (const subject of [before + after, before + middle + after, before + middle + middle + after, before, after]) {
      if (!regex.test(subject)) continue
      matching++
      for (const gram of required) assert.ok(subject.includes(gram), JSON.stringify({ pattern, subject, gram }))
    }
  }
  assert.ok(matching >= 4000)
})

test('group admission is iterative and bounded without rejecting the original regex', () => {
  const atLimit = '('.repeat(MAX_LITERAL_GROUP_DEPTH) + 'abc' + ')'.repeat(MAX_LITERAL_GROUP_DEPTH)
  assert.deepEqual(requiredLiteralTrigrams(atLimit, ''), ['abc'])
  const tooDeep = '(' + atLimit + ')'
  assert.equal(requiredLiteralTrigrams(tooDeep, ''), null)
  assert.ok(new RegExp(tooDeep).test('abc'), 'unsupported index depth still has a valid native scanner')
  const tooLong = '(?:' + 'a'.repeat(MAX_LITERAL_PATTERN_UNITS) + ')'
  assert.equal(requiredLiteralTrigrams(tooLong, ''), null)
  assert.equal(requiredLiteralTrigrams('('.repeat(MAX_LITERAL_PATTERN_UNITS), ''), null)
})

test('exhaustive grouped binary literals imply every required gram on matching subjects', () => {
  const words = ['']
  for (let length = 1; length <= 6; length++) {
    for (let bits = 0; bits < 2 ** length; bits++) words.push(bits.toString(2).padStart(length, '0').replace(/0/g, 'a').replace(/1/g, 'b'))
  }
  let matching = 0
  for (const literal of words.filter(word => word.length >= 3 && word.length <= 4)) {
    for (let cut = 0; cut <= literal.length; cut++) {
      for (const pattern of [literal.slice(0, cut) + '(?:' + literal.slice(cut) + ')',
        '(' + literal.slice(0, cut) + ')(' + literal.slice(cut) + ')', '^(?:(' + literal + '))$']) {
        const required = requiredLiteralTrigrams(pattern, '')
        assert.ok(required !== null, pattern)
        const regex = new RegExp(pattern)
        for (const subject of words) {
          if (!regex.test(subject)) continue
          matching++
          for (const gram of required) assert.ok(subject.includes(gram), JSON.stringify({ pattern, subject, gram }))
        }
      }
    }
  }
  assert.ok(matching > 1000, `matching coverage must be non-vacuous: ${matching}`)
})

test('seeded escaped Unicode grouped patterns never exclude a true native match', () => {
  let seed = 0x709541
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const alphabet = ['a', '.', '$', '^', '(', ')', '|', '\\', '中', '😀', '�', '\ud800']
  const escape = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let matching = 0
  for (let turn = 0; turn < 2000; turn++) {
    const pieces = Array.from({ length: 3 + next() % 8 }, () => alphabet[next() % alphabet.length]!)
    const literal = pieces.join('')
    const body = pieces.map(piece => next() % 2 ? '(' + escape(piece) + ')' : '(?:' + escape(piece) + ')').join('')
    const pattern = (next() % 2 ? '^' : '') + body + (next() % 2 ? '$' : '')
    const required = requiredLiteralTrigrams(pattern, '')
    assert.ok(required !== null, pattern)
    const regex = new RegExp(pattern)
    for (const subject of [literal, 'prefix' + literal, literal + 'suffix', literal.slice(1), 'other']) {
      if (!regex.test(subject)) continue
      matching++
      for (const gram of required) assert.ok(subject.includes(gram), JSON.stringify({ pattern, subject, gram }))
    }
  }
  assert.ok(matching >= 2000)
})

test('ambiguous regex syntax and all flags fail open to scanning', () => {
  for (const pattern of ['', 'a', 'ab', '^$', '.', 'foo|bar', 'abc|xyz', 'abc*', 'abc?', '(?!abc)xyz', 'abc(?!d)', '(?<!a)bc', '(?i:abc)', '(?=foo)', 'foo+', 'foo*', 'foo?', 'foo{2}', '[foo]', '\\wfoo', '\\bfoo', '(foo)\\1', '\\u0066oo', '\\x66oo', '\\nfoo', 'foo\\', '^foo$$']) {
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

test('inserting unsupported regex syntax into an accepted literal forces the scan path', () => {
  assert.deepEqual(requiredLiteralTrigrams('abcabc', ''), ['abc', 'bca', 'cab'])
  for (const meta of ['+?', '|', '[a]', '(?:x)+?', '(x)++', '{2}', '(?=x)', '(?!x)']) {
    for (let at = 0; at <= 6; at++) {
      const pattern = 'abcabc'.slice(0, at) + meta + 'abcabc'.slice(at)
      assert.equal(requiredLiteralTrigrams(pattern, ''), null, pattern)
    }
  }
})
