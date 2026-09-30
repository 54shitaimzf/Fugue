// --root 是相对调用者 cwd 的目录；进 git 子进程后不能再把同一段目录算一次。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'

const CLI = fileURLToPath(new URL('./fugue.ts', import.meta.url))
function cli(cwd: string, args: string[], input = '') {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: 'utf8' })
  assert.equal(r.error, undefined)
  return r
}

test('--root 相对路径：读写都指向同一份仓库，不在 cwd 另开账', () => {
  const parent = tmpDir('fugue-relative-root-')
  const root = join(parent, 'nested project')
  const other = join(parent, 'other')
  mkdirSync(root)
  mkdirSync(other)
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const seeded = cli(parent, ['--root', root, 'write', 'a.txt', '--stdin'], '第一份\n')
  assert.equal(seeded.status, 0, seeded.stderr)

  for (const [cwd, rel] of [[parent, 'nested project'], [parent, './nested project'], [other, '../nested project']]) {
    const r = cli(cwd, ['--root', rel, 'read', 'a.txt'])
    assert.equal(r.status, 0, `${rel}: ${r.stderr}`)
    assert.equal(r.stdout, '第一份\n')
  }
  const written = cli(other, ['--root=../nested project', 'write', 'b.txt', '--stdin'], '第二份\n')
  assert.equal(written.status, 0, written.stderr)
  const read = cli(parent, ['--root', root, 'read', 'b.txt'])
  assert.equal(read.status, 0, read.stderr)
  assert.equal(read.stdout, '第二份\n')
  const committed = cli(parent, ['--root', 'nested project', 'commit', '-m', '相对路径提交'])
  assert.equal(committed.status, 0, committed.stderr)
  assert.equal(existsSync(join(parent, '.fugue')), false, '调用者 cwd 不应出现日志')
  assert.equal(existsSync(join(other, '.fugue')), false, '另一个调用目录也不应出现日志')
})
