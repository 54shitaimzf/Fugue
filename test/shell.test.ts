// U7 的断言：**PATH 上那个 `fugue` 与仓库里那个命令行是同一次调用**（§ 9.6 · § 24 纪律 13）。
//
// 判据是逐字节：stdout · stderr · 退出码三者，报错的那几条同样。壳不做翻译——它一次 exec，
// argv 原样过去，所以"手边那一面"与"仓库里那一面"不可能漂移成两套语义：只有一套。
//
// 这里真的把它装到 PATH 上：一个临时目录 + 一条软链（就是 `bin/fugue` 顶上写的那一条装法），
// 再从**别的目录**敲它。"我在哪"与"工作区在哪"因此是两件事——这正是壳要成立的条件，也是
// 那条把日志目录读成 cwd 的老路会露馅的地方（最后一条那样比）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PROTOCOL_VERSION } from '../src/protocol.ts'

const REPO = join(import.meta.dirname, '..')
const CLI = join(REPO, 'src', 'cli', 'fugue.ts')
const SHELL = join(REPO, 'bin', 'fugue')

interface Run {
  code: number
  stdout: string
  stderr: string
}

/**
 * 提交时间钉住。两个工作区各自提交一次，要比的是行为，不是时钟——不钉的话，
 * 提交点（内容寻址）会差在秒上，逐字节比就变成比运气。
 */
const PINNED: NodeJS.ProcessEnv = {
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_DATE: '1700000000 +0000',
}

test('U7 · 壳：任意目录敲 fugue，与在仓库里敲 node src/cli/fugue.ts 逐字节相同（§ 9.6）', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'fugue-shell-'))
  t.after(() => rmSync(work, { recursive: true, force: true }))

  // 装法：一条软链。壳顺着它找自己，再往上退一层就是仓库根。
  const bin = join(work, 'bin')
  mkdirSync(bin)
  symlinkSync(SHELL, join(bin, 'fugue'))
  const elsewhere = join(work, 'elsewhere')
  mkdirSync(elsewhere)

  // 两个一模一样的工作区：同一批命令各敲一遍，两边同步前进，所以每一步都还能逐字节比。
  const a = join(work, 'a')
  const b = join(work, 'b')
  for (const root of [a, b]) {
    mkdirSync(root)
    const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)
  }

  function run(binary: string, prefix: string[], cwd: string, root: string, args: string[], stdin = ''): Run {
    const r = spawnSync(binary, [...prefix, '--root', root, ...args], {
      cwd,
      input: stdin,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      env: {
        ...process.env,
        ...PINNED,
        // 同一个解释器：要比的是两条路，不是两个 node。
        FUGUE_NODE: process.execPath,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    })
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
  }

  /** 手边那一面：PATH 上敲 `fugue`，站在与仓库无关的目录里。 */
  const hand = (root: string, args: string[], stdin = ''): Run =>
    run('fugue', [], elsewhere, root, args, stdin)
  /** 仓库里那一面：敲 `node <仓库>/src/cli/fugue.ts`，站在仓库里。 */
  const inRepo = (root: string, args: string[], stdin = ''): Run =>
    run(process.execPath, [CLI], REPO, root, args, stdin)

  /** 两个工作区各敲一遍，比三个字节面。 */
  const same = (what: string, args: string[], stdin = ''): void => {
    assert.deepEqual(
      hand(a, args, stdin),
      inRepo(b, args, stdin),
      `${what}：两条路给的不是同一份输出 —— fugue ${args.join(' ')}`,
    )
  }

  // 底稿：两个工作区各写两个文件、改一个模式、提交一次。
  for (const root of [a, b]) {
    assert.equal(inRepo(root, ['write', 'notes/one.txt', '--stdin'], '第一份\n').code, 0)
    assert.equal(inRepo(root, ['write', 'notes/two.txt', '--stdin'], '第二份\n').code, 0)
    assert.equal(inRepo(root, ['chmod', 'notes/two.txt', '755']).code, 0)
    assert.equal(inRepo(root, ['commit', '-m', '壳 · 底稿']).code, 0)
  }

  // 读 · 检视 · 重放：不改状态的那些。
  same('--help', ['--help'])
  same('--version', ['--version'])
  same('--version 的机器那一面', ['--version', '--json'])
  same('revs', ['revs'])
  same('revs 的机器那一面', ['--json', 'revs'])
  same('read', ['read', 'notes/one.txt'])
  same('list', ['list', 'notes'])
  same('stat', ['--json', 'stat', 'notes/two.txt'])
  same('log', ['log'])
  same('diff', ['diff'])
  same('diff --since', ['--json', 'diff', '--since', '2'])
  same('replay', ['replay'])
  same('replay --verify', ['--json', 'replay', '--verify'])

  // 写 · 提交 · 配置：两个工作区各自前进一格，rev 与提交点（内容寻址）都还逐字节对得上。
  same('write', ['write', 'notes/three.txt', '--stdin'], '第三份\n')
  same('chmod', ['chmod', 'notes/three.txt', '755'])
  same('commit', ['commit', '-m', '壳 · 一次提交'])
  same('config set', ['config', 'set', 'shell.probe', 'true'])
  same('config get', ['config', 'get', 'shell.probe'])
  same('config show', ['config', 'show'])

  // 报错的那几条同样逐字节：1 是"做不成"，2 是"命令行不成立"（§ 9.8）。
  same('读不到', ['read', '没有这个'])
  same('stat 不到', ['stat', '没有这个'])
  same('用法错 · 少了来源', ['write', 'notes/four.txt'])
  same('用法错 · 模式不是八进制', ['chmod', 'notes/one.txt', '999'])
  same('用法错 · 少一个参数', ['rename', 'notes/one.txt'])
  same('用法错 · 未知命令', ['把目录挪走'])
  same('用法错 · --to', ['replay', '--to', 'x'])

  // 日志损坏那一条**在同一个工作区上比两次**（读是幂等的）：它印出来的日志目录由 `--root`
  // 算得，而两次的 cwd 不一样。把 `--root` 读成 cwd 的那条路，就死在这一条上。
  appendFileSync(join(a, '.fugue', 'log', 'round.jsonl'), '{"这不是信封":1}\n')
  const broken = hand(a, ['read', 'notes/one.txt'])
  assert.deepEqual(broken, inRepo(a, ['read', 'notes/one.txt']), '日志损坏时两条路印的日志目录不一样')
  assert.equal(broken.code, 1)
  assert.match(broken.stderr, /^日志损坏，拒绝加载 —— round 第 \d+ 行：/)
  assert.equal(broken.stderr.includes(join(a, '.fugue', 'log')), true, '日志目录要按 --root 算')
})

test('壳：--version 在非仓库目录可用，--root 不存在也不初始化工作区', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'fugue-shell-version-'))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  const bin = join(work, 'bin')
  mkdirSync(bin)
  symlinkSync(SHELL, join(bin, 'fugue'))
  const elsewhere = join(work, 'elsewhere')
  mkdirSync(elsewhere)
  const missing = join(elsewhere, 'missing')
  const { name, version } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))

  for (const args of [
    ['--version'],
    ['--root', missing, '--version'],
    ['--version', '--json'],
    ['--root', missing, '--json', '--version'],
  ]) {
    const options = {
      cwd: elsewhere,
      encoding: 'utf8' as const,
      env: { ...process.env, FUGUE_NODE: process.execPath, PATH: `${bin}:${process.env.PATH ?? ''}` },
    }
    const hand = spawnSync('fugue', args, options)
    const direct = spawnSync(process.execPath, [CLI, ...args], options)
    const result = (r: typeof hand) => ({ code: r.status, stdout: r.stdout, stderr: r.stderr })
    assert.deepEqual(result(hand), result(direct), `fugue ${args.join(' ')}`)
    assert.deepEqual(result(hand), {
      code: 0,
      // `--json` 那一面多一栏 `protocol`（serve 协议的版本，架构 § 9.11）：机器 pin 行为的查询点。
      stdout:
        (args.includes('--json')
          ? JSON.stringify({ name, version, protocol: PROTOCOL_VERSION })
          : `${name} ${version}`) + '\n',
      stderr: '',
    })
  }
  assert.deepEqual(readdirSync(elsewhere), [])
})
