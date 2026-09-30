// § 9.8：显式给了落点/视图开关却没给值，是用法错，不是「使用缺省值」。
// 负对照：去掉分发前的两条检查，读命令会成功，write 会把内容写进 cwd / round 的账。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { runCli } from '../../test/helpers/run-cli.ts'

const CLI = fileURLToPath(new URL('./fugue.ts', import.meta.url))

function cli(root: string, args: readonly string[], input = '') {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
  })
  assert.equal(r.error, undefined, r.error?.message)
  assert.equal(r.signal, null, '命令该自己退出')
  return r
}

function repo(root = tmpDir('fugue-routing-')): string {
  mkdirSync(root, { recursive: true })
  const r = spawnSync('git', ['init', '-q', '.'], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  writeFileSync(join(root, 'keep.txt'), '原来的文件\n')
  return root
}

/** 包括 .git：错误不能写账，也不能动 git 对象或用户文件。 */
function tree(root: string): readonly (readonly [string, string])[] {
  return readdirSync(root, { recursive: true }).map(String).sort().map((name) => {
    const p = join(root, name)
    return [name, statSync(p).isDirectory() ? 'dir' : createHash('sha256').update(readFileSync(p)).digest('hex')] as const
  })
}

test('缺 --root / --agent 值：末尾、下一项是开关与空串都退 2，两种错误面一致', async () => {
  const root = tmpDir('fugue-routing-')
  for (const flag of ['--root', '--agent']) {
    for (const malformed of [[flag], [flag, '--metrics'], [`${flag}=`], [flag, '']]) {
      for (const json of [false, true]) {
        const args = ['--root', root, 'status', '--once', ...(json ? ['--json'] : []), ...malformed]
        const r = await runCli(args)
        assert.equal(r.code, 2, `${args.join(' ')} 必须拒绝缺值：${r.stderr}`)
        assert.equal(r.stdout, '', '用法错不写 stdout')
        if (json) {
          assert.equal(r.stderr.trim().split('\n').length, 1, '机器错误恰好一行')
          const e = JSON.parse(r.stderr)
          assert.equal(e.code, 2)
          assert.ok(e.message.includes(flag), '错误指向缺值的开关')
          assert.ok(e.hint.includes('--help'), '错误给出用法入口')
        } else {
          assert.ok(r.stderr.includes(flag))
          assert.match(r.stderr, /\n\n用法: fugue/)
        }
      }
    }
  }
})

test('缺落点/视图值的 write 在分发前拒绝：工作树、git 与日志都不变', () => {
  for (const flag of ['--root', '--agent']) {
    for (const malformed of [[flag], [flag, '--json'], [`${flag}=`], [flag, '']]) {
      const root = repo()
      const before = tree(root)
      const r = cli(root, ['write', 'new.txt', '--stdin', ...malformed], '不该写进默认视图\n')
      assert.equal(r.status, 2, `${flag} 缺值不许继续 write：${r.stderr}`)
      assert.equal(r.stdout, '')
      assert.deepEqual(tree(root), before, '错误命令不许留下 .fugue 或改动仓库')
    }
  }
})

test('合法落点/视图写法照常路由：空格、等号、命令前后与省略缺省值', () => {
  const parent = tmpDir('fugue-routing-')
  const root = repo(join(parent, '   '))
  const other = tmpDir('fugue-routing-cwd-')
  for (const [agent, file, bytes] of [['round', 'main.txt', '主线\n'], ['agent/r1/1', 'sub.txt', '子视图\n']]) {
    const seeded = cli(root, ['--root', root, '--agent', agent, 'write', file, '--stdin'], bytes)
    assert.equal(seeded.status, 0, seeded.stderr)
    for (const args of [
      ['--root', root, '--agent', agent, 'read', file],
      [`--root=${root}`, `--agent=${agent}`, 'read', file],
      ['read', file, '--root', root, '--agent', agent],
    ]) {
      const r = cli(other, args)
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, bytes, '真正读到所选根与所选视图')
      assert.equal(r.stderr, '')
    }
  }
  const defaulted = cli(root, ['read', 'main.txt'])
  assert.equal(defaulted.status, 0, defaulted.stderr)
  assert.equal(defaulted.stdout, '主线\n', '没给开关时仍默认 cwd 与 round')
  const whitespace = cli(parent, ['--root', '   ', 'status', '--once', '--json'])
  assert.equal(whitespace.status, 0, whitespace.stderr)
  assert.ok(JSON.parse(whitespace.stdout).snapshot.events > 0, '空格组成的目录名有效，不把它 trim 成空串或读成 cwd')
})

test('--help 保持优先：缺路由值也能看帮助', async () => {
  for (const flag of ['--root', '--agent']) {
    const r = await runCli(['--help', flag])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /^用法: fugue/)
    assert.equal(r.stderr, '')
  }
})
