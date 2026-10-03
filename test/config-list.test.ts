// Pure key projection and formatting; no process or Git dependency.
import assert from 'node:assert/strict'
import test from 'node:test'
import { configuredKeyPaths, configKeyPathsJson, formatConfigKeyPath, type ConfigDoc } from '../src/config.ts'

test('present keys use deterministic segment order and preserve terminal JSON values', () => {
  const doc = { ui: { keys: { read: 'secret', menu: 'other' } }, config: { a: [], z: {}, no: null }, round: { id: 'r1' } }
  const before = structuredClone(doc)
  assert.deepEqual(configuredKeyPaths(doc), [['config', 'a'], ['config', 'no'], ['config', 'z'], ['round', 'id'], ['ui', 'keys', 'menu'], ['ui', 'keys', 'read']])
  assert.deepEqual(doc, before)
  assert.deepEqual(configuredKeyPaths({}), [])
})

test('literal dots, empty and control segments cannot be confused with dotted paths', () => {
  const doc = JSON.parse('{"docs":{"a.b":{"path":"secret"},"":{"path":null},"line\\nname":[]},"config":{"__proto__":false}}')
  const paths = configuredKeyPaths(doc)
  assert.deepEqual(paths, [['config', '__proto__'], ['docs', '', 'path'], ['docs', 'a.b', 'path'], ['docs', 'line\nname']])
  assert.equal(formatConfigKeyPath(paths[0]!), 'config.__proto__')
  for (const path of paths.slice(1)) assert.deepEqual(JSON.parse(formatConfigKeyPath(path)), path)
  assert.equal(formatConfigKeyPath(['round', 'id']), 'round.id')
  const controls = ['docs', 'C1\u009b-bidi\u202e-tag\u{e0001}']
  assert.deepEqual(JSON.parse(formatConfigKeyPath(controls)), controls)
  assert.doesNotMatch(formatConfigKeyPath(controls), /\p{C}/u)
  assert.deepEqual(JSON.parse(configKeyPathsJson([controls])), [controls])
  assert.doesNotMatch(configKeyPathsJson([controls]), /\p{C}/u)
})

test('deep valid configuration is traversed without recursive call-stack growth or exposed values', () => {
  const doc: ConfigDoc = {}, depth = 2500
  let current = doc
  for (let i = 0; i < depth; i++) current = current.next = {} as ConfigDoc
  current.value = 'private-value-sentinel'
  const paths = configuredKeyPaths(doc)
  assert.equal(paths.length, 1); assert.equal(paths[0]!.length, depth + 1)
  assert.doesNotMatch(JSON.stringify(paths), /private-value-sentinel/)
})
