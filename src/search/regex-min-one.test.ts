// Pure native-match witnesses for bounded minimum-one candidate facts.
import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_LITERAL_GROUP_DEPTH, MAX_LITERAL_PATTERN_UNITS, requiredLiteralTrigrams } from './regex-literal.ts'

function grams(text: string): string[] {
  return [...new Set(Array.from({ length: Math.max(0, text.length - 2) }, (_, at) => text.slice(at, at + 3)))].sort()
}

test('minimum-one fixed groups retain internal facts and make both boundaries variable', () => {
  assert.deepEqual(requiredLiteralTrigrams('rare(_hit)+', ''), ['_hi', 'are', 'hit', 'rar'])
  assert.deepEqual(requiredLiteralTrigrams('^foo(?:bar)+tail$', ''), ['ail', 'bar', 'foo', 'tai'])
  assert.deepEqual(requiredLiteralTrigrams('needleab(c)+de', ''), grams('needleab'))
  assert.equal(requiredLiteralTrigrams('ab(c)+de', ''), null, 'short neighbors cannot invent bcd')
  assert.deepEqual(requiredLiteralTrigrams('rare\\++', ''), ['are', 'rar'])
  assert.deepEqual(requiredLiteralTrigrams('rare.+hit', ''), ['are', 'hit', 'rar'])
  assert.deepEqual(requiredLiteralTrigrams('(中😀文)+', ''), grams('中😀文'))
})

test('a repeated variable child retains only its already-proven mandatory runs', () => {
  assert.deepEqual(requiredLiteralTrigrams('foo(needle.*tail)+bar', ''), [...new Set([...grams('foo'), ...grams('needle'), ...grams('tail'), ...grams('bar')])].sort())
  assert.deepEqual(requiredLiteralTrigrams('foo(needle(_hit)?)+bar', ''), [...new Set([...grams('foo'), ...grams('needle'), ...grams('bar')])].sort())
  const pattern = '^foo(needle(_hit)?)+bar$', required = requiredLiteralTrigrams(pattern, '')!
  for (const subject of ['fooneedlebar', 'fooneedleneedlebar', 'fooneedle_hitneedlebar']) {
    assert.ok(new RegExp(pattern).test(subject))
    for (const gram of required) assert.ok(subject.includes(gram), `${subject} lacks ${gram}`)
  }
})

test('repetition cannot join short atoms or leak optional descendants', () => {
  for (const [pattern, subjects] of [
    ['^needleab(c)+de$', ['needleabcde', 'needleabccde', 'needleabcccde']],
    ['^prefix(a(b)?c)+tail$', ['prefixactail', 'prefixacactail', 'prefixabcactail']],
    ['^prefix(a?needle)+tail$', ['prefixneedletail', 'prefixneedleneedletail', 'prefixaneedleneedletail']],
  ] as const) {
    const required = requiredLiteralTrigrams(pattern, '')
    assert.ok(required !== null, pattern)
    for (const subject of subjects) {
      assert.ok(new RegExp(pattern).test(subject), subject)
      for (const gram of required) assert.ok(subject.includes(gram), JSON.stringify({ pattern, subject, gram }))
    }
  }
  assert.equal('needleabccde'.includes('bcd'), false, 'fixed-child mutant would exclude this true match')
})

test('empty groups, stacked/lazy quantifiers, unknown syntax and existing caps stay conservative', () => {
  for (const pattern of ['()+', 'rare()+', '(?:)+', '.+', 'ab+', '+abc', 'abc++', 'abc+?', 'abc+*', 'abc*+', 'abc?+', '(abc)+?', '(abc)++', '(abc){1}', '(abc|def)+', 'abc[xyz]+', 'abc(?=def)+', 'abc\\w+']) {
    assert.equal(requiredLiteralTrigrams(pattern, ''), null, pattern)
  }
  for (const flags of ['g', 'i', 'm', 's', 'u', 'v', 'y']) assert.equal(requiredLiteralTrigrams('(needle)+', flags), null)
  const atLimit = '('.repeat(MAX_LITERAL_GROUP_DEPTH) + 'needle' + ')'.repeat(MAX_LITERAL_GROUP_DEPTH) + '+'
  assert.deepEqual(requiredLiteralTrigrams(atLimit, ''), grams('needle'))
  assert.equal(requiredLiteralTrigrams('(' + atLimit + ')', ''), null)
  assert.equal(requiredLiteralTrigrams('x'.repeat(MAX_LITERAL_PATTERN_UNITS) + '+', ''), null)
})

test('seeded escaped Unicode repetitions prove native match implies every retained gram', () => {
  let seed = 0x411abcd, matching = 0
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const alphabet = ['a', '.', '$', '^', '(', ')', '|', '\\', '中', '😀', '�', '\ud800']
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const word = (minimum: number) => Array.from({ length: minimum + next() % 4 }, () => alphabet[next() % alphabet.length]!).join('')
  for (let turn = 0; turn < 1000; turn++) {
    const before = word(3), middle = word(1), after = word(3)
    const pattern = '^' + escape(before) + '(?:' + escape(middle) + ')+' + escape(after) + '$'
    const required = requiredLiteralTrigrams(pattern, '')
    assert.ok(required !== null, pattern)
    const regex = new RegExp(pattern)
    for (let repeats = 1; repeats <= 4; repeats++) {
      const subject = before + middle.repeat(repeats) + after
      assert.ok(regex.test(subject))
      matching++
      for (const gram of required) assert.ok(subject.includes(gram), JSON.stringify({ pattern, subject, gram }))
    }
  }
  assert.equal(matching, 4000)
})
