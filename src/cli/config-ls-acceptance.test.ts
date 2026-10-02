// tier: real —— 独立 CLI 子进程、两级配置与字节/锁文件只读证据。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'

const CLI = fileURLToPath(new URL('./fugue.ts', import.meta.url))
const SECRET = 'CONFIG_VALUE_MUST_NOT_BE_PRINTED_7319'
function fixture() {
  const parent = tmpDir('fugue-config-ls-acceptance-')
  const root = join(parent, 'workspace'), system = join(parent, 'system'), home = join(parent, 'home'), cwd = join(parent, 'other-cwd')
  for (const directory of [root, system, home, cwd]) mkdirSync(directory)
  mkdirSync(join(home, '.fugue')); mkdirSync(join(cwd, '.fugue'))
  writeFileSync(join(home, '.fugue', 'config'), JSON.stringify({ wrongHome: SECRET }))
  writeFileSync(join(cwd, '.fugue', 'config'), JSON.stringify({ wrongCwd: SECRET }))
  function configure(layer: 'system' | 'workspace', value: unknown, raw = false) {
    const directory = layer === 'system' ? system : join(root, '.fugue')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'config'), raw ? String(value) : JSON.stringify(value), { mode: 0o640 })
  }
  return { parent, root, system, home, cwd, configure }
}
type Fixture = ReturnType<typeof fixture>
function snapshot(root: string) {
  return readdirSync(root, { recursive: true }).map(String).sort().map(name => {
    const path = join(root, name), stat = lstatSync(path)
    const data = stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? `link:${readlinkSync(path)}`
      : createHash('sha256').update(readFileSync(path)).digest('hex')
    return [name, data, stat.mode, stat.mtimeMs] as const
  })
}
function run(f: Fixture, args: readonly string[]) {
  const before = snapshot(f.parent)
  const result = spawnSync(process.execPath, [CLI, '--root', f.root, ...args], {
    cwd: f.cwd, input: '', encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: f.home, FUGUE_SYSTEM_DIR: f.system,
      LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.signal, null, 'the CLI must settle without timeout or signal')
  assert.deepEqual(snapshot(f.parent), before, 'configuration bytes, modes, history, locks and directory entries remain unchanged')
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}
function success(f: Fixture, paths: readonly (readonly string[])[], text: readonly string[], jsonBytes = JSON.stringify(paths) + '\n') {
  for (const args of [['config', 'ls', '--json'], ['--json', 'config', 'ls']]) {
    const result = run(f, args)
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '')
    assert.equal(result.stdout, jsonBytes)
    assert.deepEqual(JSON.parse(result.stdout), paths, 'visible escapes preserve exact original key segments')
    assert.doesNotMatch(result.stdout, new RegExp(SECRET))
  }
  const result = run(f, ['config', 'ls'])
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '')
  assert.equal(result.stdout, text.length === 0 ? '' : text.join('\n') + '\n')
  assert.doesNotMatch(result.stdout, new RegExp(SECRET))
}

test('config ls lists only effective merged terminal keys without values, defaults, writes or log locking', () => {
  const f = fixture()
  f.configure('system', {
    actions: { build: { argv: ['make', SECRET], outputs: [SECRET], env: { keep: SECRET } } },
    boundary: { env: { inherit: 'core', set: { SYSTEM_ONLY: SECRET, BOTH: SECRET } }, network: SECRET },
    config: { branch: { sysOnly: 11, override: { oldChild: SECRET } }, branchToScalar: { removed: SECRET },
      scalarToObject: SECRET, arraySwitch: { removed: SECRET }, emptyMerge: { survivor: SECRET } },
    credentials: { primary: SECRET }, ports: [7319], workspace: { title: SECRET },
  })
  f.configure('workspace', {
    actions: { build: { argv: [SECRET], env: { local: SECRET } } },
    boundary: { env: { set: { BOTH: SECRET, WORKSPACE_ONLY: SECRET } } },
    config: { branch: { workspaceOnly: 22, override: null }, branchToScalar: false, scalarToObject: { newChild: SECRET },
      arraySwitch: [SECRET], emptyMerge: {}, empty: {}, nil: null },
    credentials: { secondary: SECRET }, ports: [], workspace: { title: SECRET },
  })
  mkdirSync(join(f.root, '.fugue', 'log'))
  writeFileSync(join(f.root, '.fugue', 'log', 'round.lock'), 'existing invalid lock must remain untouched\n')
  writeFileSync(join(f.root, '.fugue', 'log', 'round.jsonl'), 'unreadable-as-log sentinel\n')
  writeFileSync(join(f.root, '.fugue', 'config-history'), 'existing workspace history\n')
  writeFileSync(join(f.system, 'config-history'), 'existing system history\n')
  const names = ['actions.build.argv', 'actions.build.env.keep', 'actions.build.env.local', 'actions.build.outputs',
    'boundary.env.inherit', 'boundary.env.set.BOTH', 'boundary.env.set.SYSTEM_ONLY', 'boundary.env.set.WORKSPACE_ONLY',
    'boundary.network', 'config.arraySwitch', 'config.branch.override', 'config.branch.sysOnly', 'config.branch.workspaceOnly',
    'config.branchToScalar', 'config.empty', 'config.emptyMerge.survivor', 'config.nil', 'config.scalarToObject.newChild',
    'credentials.primary', 'credentials.secondary', 'ports', 'workspace.title']
  success(f, names.map(name => name.split('.')), names)
})

test('config ls preserves literal dotted, empty, whitespace, control and Unicode segments without collisions', () => {
  const f = fixture()
  f.configure('workspace', { config: { '\ud800': SECRET, '日本語': SECRET, 'with space': { leaf: SECRET },
    plain: [], 'a.b': SECRET, a: { b: SECRET }, '\u001b': [SECRET], '\n': null, '': {} } })
  const paths = [['config', ''], ['config', '\n'], ['config', '\u001b'], ['config', 'a', 'b'], ['config', 'a.b'],
    ['config', 'plain'], ['config', 'with space', 'leaf'], ['config', '日本語'], ['config', '\ud800']]
  const text = [JSON.stringify(paths[0]), JSON.stringify(paths[1]), JSON.stringify(paths[2]), 'config.a.b',
    JSON.stringify(paths[4]), 'config.plain', JSON.stringify(paths[6]), 'config.日本語', JSON.stringify(paths[8])]
  success(f, paths, text)
  const output = run(f, ['config', 'ls']).stdout
  assert.equal(output.split('\n').length, paths.length + 1, 'embedded controls never become extra terminal lines')
  assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f]/)
})

test('arrays, nulls, empty objects and scalar values are terminals; an empty root has no implicit registry keys', () => {
  const f = fixture()
  for (const raw of [undefined, '', '  \n', '{}']) {
    if (raw !== undefined) f.configure('workspace', raw, true)
    success(f, [], [])
  }
  f.configure('workspace', { docs: [{ path: SECRET, prompt: SECRET }], ui: {}, workspace: { text: '', number: 0,
    no: false, nil: null, empty: {}, array: [{ nestedValue: SECRET }] } })
  const names = ['docs', 'ui', 'workspace.array', 'workspace.empty', 'workspace.nil', 'workspace.no', 'workspace.number', 'workspace.text']
  success(f, names.map(name => name.split('.')), names)
})

test('extra config ls positional arguments fail as usage before either malformed configuration is read', () => {
  const f = fixture()
  f.configure('system', '{', true); f.configure('workspace', '{', true)
  for (const extra of [['extra'], [''], ['one', 'two']]) {
    for (const json of [false, true]) {
      const result = run(f, ['config', 'ls', ...extra, ...(json ? ['--json'] : [])])
      assert.equal(result.code, 2); assert.equal(result.stdout, '')
      const message = json ? JSON.parse(result.stderr).message : result.stderr
      assert.match(message, /config ls/); assert.doesNotMatch(message, /配置不是|配置读不出来/)
      if (json) { assert.equal(JSON.parse(result.stderr).code, 2); assert.equal(result.stderr.trim().split('\n').length, 1) }
    }
  }
})

test('config ls preserves config show read failures for each layer and both error formats', () => {
  for (const layer of ['system', 'workspace'] as const) {
    for (const bad of ['{', '[]', 'null', '{"unknown_top":true}', '{"ui":null}', '{"ui":{"keys":{"accept":17}}}']) {
      const f = fixture(); f.configure(layer, bad, true)
      for (const json of [false, true]) {
        const flags = json ? ['--json'] : []
        const listed = run(f, ['config', 'ls', ...flags]), shown = run(f, ['config', 'show', ...flags])
        assert.equal(listed.code, 1); assert.equal(listed.stdout, '')
        assert.deepEqual(listed, shown, 'existing readConfig failure message and exit face remain authoritative')
        if (json) assert.equal(JSON.parse(listed.stderr).code, 1)
      }
    }
  }
})

test('unreadable config directories still fail read-only and system errors retain precedence over workspace errors', () => {
  const f = fixture()
  mkdirSync(join(f.system, 'config')); f.configure('workspace', '{"unknown_top":true}', true)
  for (const json of [false, true]) {
    const flags = json ? ['--json'] : []
    const listed = run(f, ['config', 'ls', ...flags]), shown = run(f, ['config', 'show', ...flags])
    assert.equal(listed.code, 1); assert.equal(listed.stdout, ''); assert.deepEqual(listed, shown)
    const message = json ? JSON.parse(listed.stderr).message : listed.stderr
    assert.ok(message.includes(join(f.system, 'config'))); assert.doesNotMatch(message, /unknown_top/)
  }
})

test('C1, bidi and supplementary format controls are visibly escaped in text and JSON while exact keys roundtrip', () => {
  const f = fixture()
  f.configure('workspace', { config: { '\u{e0061}': SECRET, '\u202e': SECRET, '\u0085': SECRET } })
  const paths = [['config', '\u0085'], ['config', '\u202e'], ['config', '\u{e0061}']]
  const text = ['["config","\\u0085"]', '["config","\\u202e"]', '["config","\\udb40\\udc61"]']
  success(f, paths, text, '[' + text.join(',') + ']\n')
  for (const args of [['config', 'ls'], ['config', 'ls', '--json']]) {
    const output = run(f, args).stdout
    assert.doesNotMatch(output, /[\u0080-\u009f\u202a-\u202e]|\u{e0061}/u, 'terminal-affecting key controls are never emitted literally')
  }
})
