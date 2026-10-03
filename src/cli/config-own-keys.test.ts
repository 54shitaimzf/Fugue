// tier: real —— actual isolated CLI children and persisted JSON roundtrips.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'

const CLI = fileURLToPath(new URL('./fugue.ts', import.meta.url))
function fixture() {
  const root = tmpDir('fugue-cli-own-config-'), system = join(root, 'system'), home = join(root, 'home')
  mkdirSync(system); mkdirSync(home)
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, '--root', root, '--json', ...args], {
      cwd: root, input: '', encoding: 'utf8', timeout: 10_000, maxBuffer: 1 << 20,
      env: { PATH: process.env.PATH, HOME: home, FUGUE_SYSTEM_DIR: system, LANG: 'C', LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })
    assert.ifError(result.error); assert.equal(result.signal, null)
    return { code: result.status, out: result.stdout, err: result.stderr }
  }
  return { root, system, run }
}

test('actual config set/get/show/ls persists prototype-looking keys as literal data', () => {
  const f = fixture()
  for (const [key, value] of [['config.__proto__.value', 1], ['config.constructor.prototype.value', 2], ['config.prototype', 3]] as const) {
    const wrote = f.run('config', 'set', key, String(value)); assert.equal(wrote.code, 0, wrote.err)
    const read = f.run('config', 'get', key); assert.equal(read.code, 0, read.err); assert.equal(JSON.parse(read.out), value)
  }
  const stored = JSON.parse(readFileSync(join(f.root, '.fugue/config'), 'utf8'))
  assert.equal(stored.config.__proto__.value, 1); assert.equal(stored.config.constructor.prototype.value, 2)
  assert.equal(stored.config.prototype, 3)
  assert.deepEqual(JSON.parse(f.run('config', 'show').out), stored)
  assert.deepEqual(JSON.parse(f.run('config', 'ls').out), [['config', '__proto__', 'value'], ['config', 'constructor', 'prototype', 'value'], ['config', 'prototype']])
})

test('merged CLI config has no inherited reads or hidden values absent from show and ls', () => {
  const f = fixture(); mkdirSync(join(f.root, '.fugue'))
  writeFileSync(join(f.system, 'config'), '{"config":{"ordinary":1}}')
  writeFileSync(join(f.root, '.fugue/config'), '{"config":{"__proto__":{"hidden":"literal"}}}')
  const missing = f.run('config', 'get', 'config.hidden'); assert.equal(missing.code, 1)
  const inherited = f.run('config', 'get', 'config.toString'); assert.equal(inherited.code, 1)
  const literal = f.run('config', 'get', 'config.__proto__.hidden'); assert.equal(literal.code, 0); assert.equal(JSON.parse(literal.out), 'literal')
  assert.deepEqual(JSON.parse(f.run('config', 'show').out), JSON.parse('{"config":{"ordinary":1,"__proto__":{"hidden":"literal"}}}'))
  assert.deepEqual(JSON.parse(f.run('config', 'ls').out), [['config', '__proto__', 'hidden'], ['config', 'ordinary']])
})
