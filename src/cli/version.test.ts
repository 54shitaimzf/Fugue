// 安装版本是 package.json 的读数，不是工作区状态；报告问题时在任何目录都能查。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { PROTOCOL_VERSION } from '../protocol.ts'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const CLI = join(REPO, 'src', 'cli', 'fugue.ts')
const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))

function fugue(cwd: string, args: string[], cli = CLI) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', input: '' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

test('--version：非仓库目录 · 不存在的 --root · 不碰任何工作区文件', () => {
  const cwd = tmpDir('fugue-version-')
  // 当前目录自己的 package.json 不能冒充安装版本。
  const unrelated = '{"name":"other-project","version":"99.99.99"}\n'
  writeFileSync(join(cwd, 'package.json'), unrelated)
  const missing = join(cwd, 'not-created')
  const expected = { code: 0, stdout: `${manifest.name} ${manifest.version}\n`, stderr: '' }

  assert.deepEqual(fugue(cwd, ['--version']), expected)
  assert.deepEqual(fugue(cwd, ['--root', missing, '--version']), expected)
  assert.deepEqual(readdirSync(cwd), ['package.json'])
  assert.equal(readFileSync(join(cwd, 'package.json'), 'utf8'), unrelated)
  assert.equal(existsSync(missing), false)
})

test('--version --json：一行 {name, version, protocol}，与人面同源且不初始化工作区', () => {
  const cwd = tmpDir('fugue-version-json-')
  const missing = join(cwd, 'missing')
  for (const args of [['--json', '--version'], ['--version', '--json', `--root=${missing}`]]) {
    assert.deepEqual(fugue(cwd, args), {
      code: 0,
      // `protocol` 是 **serve 协议的版本**（架构 § 9.11）：机器 pin 行为的查询点。它比产品版本稳
      // ——协议只在报文形状与语义变时跳，所以它住 `src/protocol.ts`，不跟 `package.json` 走。
      stdout: JSON.stringify({ name: manifest.name, version: manifest.version, protocol: PROTOCOL_VERSION }) + '\n',
      stderr: '',
    })
  }
  assert.deepEqual(readdirSync(cwd), [])
})

test('--version：只改安装目录的 package.json 就换版本，不靠生成文件或 git', () => {
  const installed = tmpDir('fugue-version-install-')
  cpSync(join(REPO, 'src'), join(installed, 'src'), { recursive: true })
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ ...manifest, version: '7.8.9-test' }))
  const cwd = tmpDir('fugue-version-outside-')
  const cli = join(installed, 'src', 'cli', 'fugue.ts')

  assert.deepEqual(fugue(cwd, ['--version'], cli), {
    code: 0, stdout: `${manifest.name} 7.8.9-test\n`, stderr: '',
  })
  // **产品版本换了，协议版本不动**：两者各自一个计数器（这正是"外部按协议版本 pin"要的性质）。
  assert.deepEqual(JSON.parse(fugue(cwd, ['--version', '--json'], cli).stdout), {
    name: manifest.name, version: '7.8.9-test', protocol: PROTOCOL_VERSION,
  })
  assert.deepEqual(readdirSync(cwd), [])
  assert.deepEqual(readdirSync(installed).sort(), ['package.json', 'src'])
})

test('--version 不吞错命令、未知开关、缺值或 -- 后面的参数（§ 9.8）', () => {
  const cwd = tmpDir('fugue-version-usage-')
  for (const args of [
    ['--version=1'],
    ['--version', 'status'],
    ['write', 'a.txt', '--stdin', '--version'],
    ['--version', '--typo'],
    ['--version', '--root'],
    ['--version', '--root='],
    ['--version', '--', 'extra'],
    [],
    ['--versoin'],
    ['unknown-command'],
  ]) {
    for (const json of [false, true]) {
      const r = fugue(cwd, [...(json ? ['--json'] : []), ...args])
      assert.equal(r.code, 2, `fugue ${args.join(' ')}：${r.stderr}`)
      assert.equal(r.stdout, '')
      if (json) assert.equal(JSON.parse(r.stderr).code, 2)
      else assert.match(r.stderr, /用法: fugue/)
    }
  }
  assert.deepEqual(readdirSync(cwd), [])
})

test('--help 列出 --version；原来的帮助优先级不变', () => {
  const cwd = tmpDir('fugue-version-help-')
  const help = fugue(cwd, ['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /--version/)
  assert.deepEqual(fugue(cwd, ['--help', '--version']), help)
  assert.deepEqual(readdirSync(cwd), [])
})
