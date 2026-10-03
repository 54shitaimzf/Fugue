// JSON keys must remain data, including prototype-looking names.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { getConfig, readConfig, setConfig, configuredKeyPaths } from '../src/config.ts'
import { tmpDir } from './helpers/tmp.ts'

test('getConfig never exposes inherited keys at the root or an intermediate object', () => {
  assert.equal(getConfig({ config: {} }, 'config.constructor'), undefined)
  assert.equal(getConfig(Object.create({ config: { inherited: 1 } }), 'config.inherited'), undefined)
  assert.equal(getConfig({ config: Object.create({ inherited: 1 }) }, 'config.inherited'), undefined)
  const doc = JSON.parse('{"config":{"constructor":{"prototype":{"value":1}},"__proto__":{"value":2}}}')
  assert.equal(getConfig(doc, 'config.constructor.prototype.value'), 1)
  assert.equal(getConfig(doc, 'config.__proto__.value'), 2)
})

test('setConfig owns prototype-looking intermediate and terminal keys without global pollution', () => {
  const marker = 'fugueConfigOwnKeyControl', previous = Object.getOwnPropertyDescriptor(Object.prototype, marker)
  try {
    const doc = { config: {} }
    setConfig(doc, `config.__proto__.${marker}`, 'owned')
    assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, marker), previous)
    setConfig(doc, 'config.constructor.prototype.value', 2)
    setConfig(doc, 'config.toString', 'literal')
    setConfig(doc, 'config.terminal.__proto__', 3)
    const parsed = JSON.parse(JSON.stringify(doc))
    assert.equal(getConfig(parsed, `config.__proto__.${marker}`), 'owned')
    assert.equal(getConfig(parsed, 'config.constructor.prototype.value'), 2)
    assert.equal(getConfig(parsed, 'config.toString'), 'literal')
    assert.equal(getConfig(parsed, 'config.terminal.__proto__'), 3)
    for (const key of ['__proto__', 'constructor', 'toString']) {
      const descriptor = Object.getOwnPropertyDescriptor(doc.config, key)!
      assert.equal(descriptor.enumerable, true); assert.equal(descriptor.writable, true); assert.equal(descriptor.configurable, true)
    }
  } finally {
    if (previous === undefined) delete (Object.prototype as Record<string, unknown>)[marker]
    else Object.defineProperty(Object.prototype, marker, previous)
  }
})

test('two-level merge preserves literal own keys and ordinary object/array/null semantics', async () => {
  const root = tmpDir('fugue-config-own-merge-'), system = join(root, 'system'), workspace = join(root, 'workspace')
  mkdirSync(system); mkdirSync(join(workspace, '.fugue'), { recursive: true })
  writeFileSync(join(system, 'config'), '{"config":{"object":{"left":1,"shared":"system"},"array":[1],"nullable":true},"round":{"id":"system"}}')
  writeFileSync(join(workspace, '.fugue/config'), '{"config":{"__proto__":{"net":"literal"},"constructor":{"prototype":{"value":2}},"object":{"right":2,"shared":"workspace"},"array":[2],"nullable":null}}')
  const merged = await readConfig(workspace, system)
  assert.equal(getConfig(merged, 'config.net'), undefined, 'a serialized-absent key cannot secretly become effective')
  assert.equal(Object.getPrototypeOf(merged.config), Object.prototype)
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), JSON.parse('{"config":{"object":{"left":1,"shared":"workspace","right":2},"array":[2],"nullable":null,"__proto__":{"net":"literal"},"constructor":{"prototype":{"value":2}}},"round":{"id":"system"}}'))
  assert.equal(getConfig(merged, 'config.__proto__.net'), 'literal')
  assert.ok(configuredKeyPaths(merged).some(path => path.join('.') === 'config.__proto__.net'))
  assert.equal(getConfig(merged, 'config.array.0'), 2, 'existing array reads still work')
})
