// 索引候选过滤绝不能漏掉 RegExp 的真命中；无法证明必需的 literal 就返回 null 扫描。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requiredLiteralTrigrams } from './regex-literal.ts'

function gramsOf(text: string): Set<string> {
  const grams = new Set<string>()
  for (let at = 0; at + 2 < text.length; at++) grams.add(text.slice(at, at + 3))
  return grams
}

test('plain literals, simple anchors and escaped punctuation produce required UTF-16 grams', () => {
  assert.deepEqual(requiredLiteralTrigrams('hello'), ['ell', 'hel', 'llo'])
  assert.deepEqual(requiredLiteralTrigrams('^hello$'), requiredLiteralTrigrams('hello'))
  assert.deepEqual(requiredLiteralTrigrams('a\\.b'), ['a.b'])
  assert.deepEqual(requiredLiteralTrigrams('a\\*b'), ['a*b'])
  assert.deepEqual(requiredLiteralTrigrams('a/b'), ['a/b'])
  assert.deepEqual(requiredLiteralTrigrams('a\\/b'), ['a/b'])
  assert.deepEqual(requiredLiteralTrigrams('a\\-b'), ['a-b'])
  assert.deepEqual(requiredLiteralTrigrams('\\^foo\\$'), [...gramsOf('^foo$')].sort())
  assert.deepEqual(requiredLiteralTrigrams('foo\\\\$'), [...gramsOf('foo\\')].sort())
  assert.deepEqual(requiredLiteralTrigrams(' ^foo '), null)
})

test('ambiguous regex syntax and all flags fail open to scanning', () => {
  for (const pattern of ['', 'a', 'ab', '^$', '.', 'foo|bar', 'abc|xyz', 'abc*', 'abc?', '(?!abc)xyz', 'abc(?!d)', '(?<!a)bc', '(?i:abc)', '(foo)', '(?:foo)', '(?=foo)', 'foo+', 'foo*', 'foo?', 'foo{2}', '[foo]', '\\wfoo', '\\bfoo', '(foo)\\1', '\\u0066oo', '\\x66oo', '\\nfoo', 'foo\\', '^foo$$']) {
    assert.equal(requiredLiteralTrigrams(pattern), null, pattern)
  }
  for (const flags of ['i', 'm', 'u', 'g', 's', 'y', 'v', 'unknown']) assert.equal(requiredLiteralTrigrams('hello', flags), null)
})

test('Unicode, replacement characters and surrogate boundaries share index code-unit semantics', () => {
  for (const literal of ['中😀文', '😀abc', '�hit', '\ud800abc', 'abc\udc00']) {
    assert.deepEqual(requiredLiteralTrigrams(literal), [...gramsOf(literal)].sort())
    assert.ok(requiredLiteralTrigrams(literal)!.every(gram => gram.length === 3))
  }
})

test('derived query work is bounded and never returns an empty exclusion set', () => {
  assert.equal(requiredLiteralTrigrams('x'.repeat(4097)), null)
  const many = Array.from({ length: 1000 }, (_, at) => String.fromCharCode(0x400 + at)).join('')
  const required = requiredLiteralTrigrams(many)!
  assert.ok(required.length > 0 && required.length <= 128)
  const available = gramsOf(many)
  for (const gram of required) assert.ok(available.has(gram))
  assert.deepEqual(requiredLiteralTrigrams('a'.repeat(100)), ['aaa'])
})

test('a seeded literal/reference matrix never excludes a matching line', () => {
  let seed = 0x12345678
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const alphabet = ['a', 'b', 'c', '.', '*', '$', '^', '[', ']', '\\', '-', '/', '中', '😀', '�']
  const escape = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (let turn = 0; turn < 3000; turn++) {
    const literal = Array.from({ length: 3 + next() % 20 }, () => alphabet[next() % alphabet.length]!).join('')
    const pattern = (next() % 2 ? '^' : '') + escape(literal) + (next() % 2 ? '$' : '')
    const required = requiredLiteralTrigrams(pattern)
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
