// W3 的断言：**身份名的形状——一处实现，两处调用**。四条，逐条对 PLAN § 5.3 的 W3 行。
//
//   ① 同一个名字在 M0 与 M3 得同一个答案（表驱动：合法的与非法的各一串，**而且两侧给的理由相同**）
//   ② 按段展开：`mat/agent/r1/1/` 下三个坐标齐 · `log/agent/r1/1.jsonl` · `snap/agent/r1/1/`
//   ③ 带 `/` 的名字上 `branch` → `fork` → `write` → `ensure` → `verify-mat` 端到端走通
//   ④ `dispose` 之后四个坐标一个不剩
//
// **这条规矩原先两边各写一遍，已经漂移过一次**：日志那一侧收 `agent/r1/1`（逐段判），物化那一侧
// 拒它（只认一个段）——同一个名字在两处得到两个答案，而架构 § 4 的命名方案写的就是
// `agent/<round>/<n>`（三层）。W3 把它收到 `identity.ts` 一处：`M0` 的 `assertWriterId` 与 `M3` 的
// `matRoot` 各调它一次。①比"两侧同不同"而不只是"某一侧对不对"，抓的正是"又被人各写一遍"。
//
// **`cache` 是四个坐标里的第四个，而 S3 里没有一条路建它**：`fork` 只建 `upper` · `merged` ·
// `tmp`（§ 8.4 · § 8.6——`cache` 是 M5 的）。所以②量的是"三个齐 + 第四个还没人来建"，而 `dispose`
// 照旧按四个名字一起删：它是删除，四个名字一起算才画得干净。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { assertWriterId } from './log/log.ts'
import { removeTree } from './materialize/mount.ts'
import { createRoots } from './roots/roots.ts'
import type { AgentId, WriterId } from './terms.ts'

const CLI = join(import.meta.dirname, 'cli', 'fugue.ts')
/** 架构 § 4 的命名方案就是它：三层，带 `/`。 */
const AGENT = 'agent/r1/1'

/** 夹具登记：跑完先卸后删。 */
const MADE: string[] = []

after(() => {
  for (const dir of MADE) {
    spawnSync(process.execPath, [CLI, '--root', dir, '--agent', AGENT, 'dispose'], { encoding: 'utf8' })
    try {
      removeTree(dir)
    } catch {
      spawnSync('sudo', ['-n', 'rm', '-rf', dir])
    }
  }
})

function git(cwd: string, args: readonly string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'fugue',
      GIT_AUTHOR_EMAIL: 'fugue@localhost',
      GIT_COMMITTER_NAME: 'fugue',
      GIT_COMMITTER_EMAIL: 'fugue@localhost',
    },
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 退 ${r.status}：${r.stderr}`)
  return r.stdout.trim()
}

/** 一棵真仓库：工作树与 HEAD 逐字节一致（`fork` 的底就是它，架构 § 8.4）。 */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-ident-'))
  MADE.push(dir)
  const put = (rel: string, body: string): void => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  put('src/a.ts', 'export const a = 1\n')
  put('bin/run.sh', '#!/bin/sh\necho hi\n')
  chmodSync(join(dir, 'bin/run.sh'), 0o755)
  git(dir, ['init', '-q', '-b', 'main', '.'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  assert.equal(git(dir, ['status', '--porcelain']), '', '夹具的工作树要是干净的')
  return dir
}

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

function cli(root: string, args: readonly string[], stdin = ''): Run {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: stdin,
    maxBuffer: 1 << 26,
  })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr }
}

/** `verify-mat` 那一行里的三个数：清单 · 差异集 · 落地。 */
function setsOf(out: string): number[] {
  return [...out.matchAll(/(\d+) 条/g)].map((m) => Number(m[1]))
}

/** 一侧收不收这个名字；不收的话，理由是哪一句（括号里那一段）。 */
function verdict(fn: () => unknown): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  try {
    fn()
    return { ok: true }
  } catch (err) {
    const message = (err as Error).message
    const open = message.indexOf('（')
    const close = message.lastIndexOf('）')
    return { ok: false, reason: open === -1 || close <= open ? message : message.slice(open + 1, close) }
  }
}

/** 表：名字 → 收不收。**带 `/` 的合法名字在头几条**，因为那正是漂移过的那一处。 */
const NAMES: readonly (readonly [string, boolean])[] = [
  ['round', true],
  ['a1', true],
  ['agent/r1/1', true],
  ['agent/1/2', true],
  ['a.b', true],
  ['x-y_z', true],
  ['', false],
  ['.', false],
  ['..', false],
  ['.hidden', false],
  ['a/.hidden', false],
  ['a/../b', false],
  ['a/./b', false],
  ['a//b', false],
  ['a/', false],
  ['/abs', false],
  ['a\\b', false],
  ['a\0b', false],
]

test('① 同一个名字在 M0 与 M3 得同一个答案（表驱动）', () => {
  // 纯路径算术，不碰文件系统：`createRoots` 只做检查与拼接。
  const roots = createRoots('/tmp/fugue-ident-probe')
  for (const [name, want] of NAMES) {
    const m0 = verdict(() => assertWriterId(name as WriterId))
    const m3 = verdict(() => roots.scratchRoot(name as AgentId))
    assert.equal(m0.ok, want, `M0 那一侧收不收：${JSON.stringify(name)}`)
    assert.equal(m3.ok, want, `M3 那一侧收不收：${JSON.stringify(name)}`)
    if (!m0.ok && !m3.ok) {
      // 两侧调同一个函数，所以理由必须逐字相同——这一条抓的是"又被人各写一遍"
      assert.equal(m0.reason, m3.reason, `${JSON.stringify(name)}：两侧给的理由该是同一个`)
    }
  }
  // 带 `/` 的名字真的按段展开，而不是被当成一个"名字里带斜杠"的单段
  assert.equal(
    roots.scratchRoot(AGENT as AgentId),
    join('/tmp/fugue-ident-probe', '.fugue', 'mat', 'agent', 'r1', '1', 'upper'),
    'M3 那一侧按段展开',
  )
})

test('② 按段展开：mat/<agent>/ 三个坐标齐，log/ 与 snap/ 同形状', () => {
  const dir = fixture()
  const base = git(dir, ['rev-parse', 'HEAD'])
  assert.equal(cli(dir, ['--agent', AGENT, 'branch', base]).code, 0)
  const f = cli(dir, ['--agent', AGENT, 'fork', base])
  assert.equal(f.code, 0, f.err)
  const w = cli(dir, ['--agent', AGENT, 'write', 'src/own.ts', '--stdin'], 'export const own = 1\n')
  assert.equal(w.code, 0, w.err)
  // 提交一次：快照是提交点那一步留下的（§ 9.4），不是 `write` 留下的
  const c = cli(dir, ['--agent', AGENT, 'commit', '-m', '第一个提交点'])
  assert.equal(c.code, 0, c.err)
  const e = cli(dir, ['--agent', AGENT, 'ensure'])
  assert.equal(e.code, 0, e.err)

  const fugue = join(dir, '.fugue')
  const leaf = join(fugue, 'mat', 'agent', 'r1', '1')
  assert.deepEqual(
    readdirSync(leaf).sort(),
    ['merged', 'tmp', 'upper'],
    '物化那一侧：三个坐标齐（cache 是 M5 的，S3 里没有一条路建它）',
  )
  assert.equal(existsSync(join(fugue, 'log', 'agent', 'r1', '1.jsonl')), true, '日志那一侧：一份文件')
  const snaps = readdirSync(join(fugue, 'snap', 'agent', 'r1', '1'))
  assert.equal(
    snaps.some((n) => n.endsWith('.json')),
    true,
    `快照那一侧：一份目录，里面是 <seq>.json——实得 ${JSON.stringify(snaps)}`,
  )
  // 三处共享同一段中间目录——"身份名同时是一条路径"这句话的可测形式
  for (const area of ['mat', 'log', 'snap']) {
    assert.equal(statSync(join(fugue, area, 'agent', 'r1')).isDirectory(), true, `${area}/agent/r1/ 该是目录`)
  }
})

test('③ 带 / 的名字：branch → fork → write → ensure → verify-mat 端到端走通', () => {
  const dir = fixture()
  const base = git(dir, ['rev-parse', 'HEAD'])
  const b = cli(dir, ['--agent', AGENT, 'branch', base])
  assert.equal(b.code, 0, b.err)
  const f = cli(dir, ['--agent', AGENT, 'fork', base])
  assert.equal(f.code, 0, f.err)
  for (const [path, body] of [
    ['src/own.ts', 'export const own = 1\n'],
    ['src/a.ts', 'export const a = 42\n'],
  ] as const) {
    const w = cli(dir, ['--agent', AGENT, 'write', path, '--stdin'], body)
    assert.equal(w.code, 0, w.err)
  }
  const e = cli(dir, ['--agent', AGENT, 'ensure'])
  assert.equal(e.code, 0, e.err)
  const v = cli(dir, ['--agent', AGENT, 'verify-mat'])
  assert.equal(v.code, 0, v.out + v.err)
  assert.match(v.out, /^ok\t/)
  assert.deepEqual(setsOf(v.out), [2, 2, 2], `写了两条：清单 · 差异集 · 落地各 2 条——实得 ${v.out}`)

  // 两半都验：视图那一侧读得回来，物化那一侧落得下去
  const r = cli(dir, ['--agent', AGENT, 'read', 'src/a.ts'])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, 'export const a = 42\n')
  assert.equal(
    readFileSync(join(dir, '.fugue', 'mat', 'agent', 'r1', '1', 'merged', 'src', 'own.ts'), 'utf8'),
    'export const own = 1\n',
    '新写的那一条该在合并树里',
  )
})

test('④ dispose 之后四个坐标一个不剩（日志与快照照旧）', () => {
  const dir = fixture()
  const base = git(dir, ['rev-parse', 'HEAD'])
  assert.equal(cli(dir, ['--agent', AGENT, 'branch', base]).code, 0)
  assert.equal(cli(dir, ['--agent', AGENT, 'fork', base]).code, 0)
  assert.equal(cli(dir, ['--agent', AGENT, 'write', 'src/own.ts', '--stdin'], 'export const own = 1\n').code, 0)
  // 提交一次：下面要判"快照不该被 dispose 碰"，得先有一份快照（§ 9.4）
  assert.equal(cli(dir, ['--agent', AGENT, 'commit', '-m', '第一个提交点']).code, 0)
  assert.equal(cli(dir, ['--agent', AGENT, 'ensure']).code, 0)

  const fugue = join(dir, '.fugue')
  const leaf = join(fugue, 'mat', 'agent', 'r1', '1')
  assert.equal(existsSync(leaf), true, 'dispose 之前物化根该在')

  const d = cli(dir, ['--agent', AGENT, 'dispose'])
  assert.equal(d.code, 0, d.err)
  for (const part of ['upper', 'merged', 'tmp', 'cache']) {
    assert.equal(existsSync(join(leaf, part)), false, `dispose 之后 ${part} 还在`)
  }
  assert.equal(existsSync(leaf), false, '容器自己也该跟着走')
  // 父目录留着：它是同一轮里所有 agent 共用的那一段（`agent/r1/2` 也住在它底下）
  assert.equal(statSync(join(fugue, 'mat', 'agent', 'r1')).isDirectory(), true, '父目录留着给同轮的其他 agent')
  // dispose 删的是物化：日志与快照是两个不同的东西，一个字节都不该动
  assert.equal(existsSync(join(fugue, 'log', 'agent', 'r1', '1.jsonl')), true, '日志不该被 dispose 碰')
  assert.equal(existsSync(join(fugue, 'snap', 'agent', 'r1', '1')), true, '快照不该被 dispose 碰')
  // 幂等：再删一次照样 0（删除的后置条件是"这些坐标下不留东西"，它已经成立了）
  assert.equal(cli(dir, ['--agent', AGENT, 'dispose']).code, 0)
})
