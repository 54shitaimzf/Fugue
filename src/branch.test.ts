// W1 的断言：**分出去——一条线的起点定格在一个提交上**。五条，逐条对 PLAN § 5.3 的 W1 行。
//
//   ① 分出去之后 `View.base` 与 `mat/fork.base` 是同一个提交（两处各读一次，逐字相等）
//   ② 幂等：再敲一次 ref 不动、日志不多一条
//   ③ 指着别处就拒绝，文案给出两条路；`--agent round` 在主线前移之后同样拒绝
//   ④ `fork <base>` 在分支头不是它时拒绝并指路（负对照：是它时照常落地）
//   ⑤ 端到端：`branch` → `fork` → `write` → `ensure` → `verify-mat` 三集合相等
//
// **①②③量的是动作**（ref 那一侧），**④⑤量的是那条不变式**（视图的底与物化的底是同一个提交）。
//
// **⑤ 有两路读数**：一路敲 `fugue branch`，一路用 `git update-ref` 直接指。后者是这一单元的
// 地板（PLAN § 5.3：分支头是一条方便的路，不是一个前提）——两路都走到底，比三集合与合并树的
// 全树摘要。**这是"那个机制死掉时系统是变慢，不是跑不起来"的走通一次**：`branch` 没了，这条路
// 照跑，只是要多记一条 git 命令。
//
// **②的并发那一路是加码**：它要抓的是"两个进程同时分出去"，而那不是每一轮都撞得上。确定性
// 那一半（再敲一次）每一轮都会红，所以举证由它承担；并发那一半的通过条件是"每一轮不变式成立"
// ——恰一个把它定下去。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { WORKSPACE_STATE, scanTree } from './materialize/diffstat.ts'
import { removeTree } from './materialize/mount.ts'

const CLI = join(import.meta.dirname, 'cli', 'fugue.ts')

/**
 * 夹具登记：这一份跑完，先把每个 agent 的物化卸干净再删目录。
 *
 * **不能只 `rmSync`**：挂着 overlay 的 `merged` 底下摊的是真源，而内核在 `work/` 里建的
 * `work/work`（`root:root 000`）普通删除进不去——`dispose` 那条路就是为这个存在的。
 */
const MADE: string[] = []
const AGENTS = ['a1', 'a2', 'a3']

after(() => {
  for (const dir of MADE) {
    for (const a of AGENTS) {
      spawnSync(process.execPath, [CLI, '--root', dir, '--agent', a, 'dispose'], { encoding: 'utf8' })
    }
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

/** 一棵真仓库：工作树与 `main` 那个提交逐字节一致（`fork` 的底就是它，§ 8.4）。 */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-branch-'))
  MADE.push(dir)
  const put = (rel: string, body: string): void => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  put('src/a.ts', 'export const a = 1\n')
  put('src/b.ts', 'export const b = 2\n')
  symlinkSync('src/a.ts', join(dir, 'link.ts'))
  put('bin/run.sh', '#!/bin/sh\necho hi\n')
  chmodSync(join(dir, 'bin/run.sh'), 0o755)
  git(dir, ['init', '-q', '-b', 'main', '.'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  assert.equal(git(dir, ['status', '--porcelain']), '', '夹具的工作树要是干净的')
  return dir
}

/** 再造一个提交，**不动任何 ref**：③④要拒的那一半需要一个"别处"的提交。 */
function commitAt(dir: string, parent: string, msg: string): string {
  return git(dir, ['commit-tree', git(dir, ['rev-parse', parent + '^{tree}']), '-p', parent, '-m', msg])
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

function cliAsync(root: string, args: readonly string[]): Promise<Run> {
  return new Promise((res) => {
    const p = spawn(process.execPath, [CLI, '--root', root, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (b: Buffer) => (out += b.toString()))
    p.stderr.on('data', (b: Buffer) => (err += b.toString()))
    p.on('close', (code) => res({ code: code ?? -1, out, err }))
    p.stdin.end('')
  })
}

/** 视图的底：`replay` 报的是 ref 现在指着的那个提交（视图那一侧的读口）。 */
function viewBase(dir: string, agent: string): string | null {
  const r = cli(dir, ['--agent', agent, '--json', 'replay'])
  assert.equal(r.code, 0, r.err)
  return (JSON.parse(r.out) as { base: string | null }).base
}

/** 物化的底：`mat/fork.base`（日志那一侧的读口）。 */
function matForkOf(dir: string, agent: string): { base: string; strategy: string } | null {
  const r = cli(dir, ['--agent', agent, '--json', 'log', '--agent', agent])
  assert.equal(r.code, 0, r.err)
  for (const line of r.out.split('\n')) {
    if (line === '') continue
    const { e } = JSON.parse(line) as { e: { t: string; base?: string; strategy?: string } }
    if (e.t === 'mat/fork') return { base: e.base ?? '', strategy: e.strategy ?? '' }
  }
  return null
}

/** 该 writer 的日志有几行（文件不存在＝0）。 */
function lines(dir: string, w: string): number {
  const f = join(dir, '.fugue', 'log', w + '.jsonl')
  if (!existsSync(f)) return 0
  return readFileSync(f, 'utf8').split('\n').filter((l) => l !== '').length
}

/** 合并树的全树摘要：**路径 · 模式 · 内容哈希**，不比时间戳（两棵树的年龄本来就不一样）。 */
function mergedDigest(dir: string, agent: string): string {
  const merged = join(dir, '.fugue', 'mat', agent, 'merged')
  const rows = scanTree(merged, { skip: WORKSPACE_STATE }).leaves
    .map((l) => `${l.path}\t${l.mode.toString(8)}\t${l.hash}`)
    .sort()
  return createHash('sha256').update(rows.join('\n')).digest('hex')
}

/** `verify-mat` 那一行里的三个数：清单 · 差异集 · 落地。 */
function setsOf(out: string): number[] {
  return [...out.matchAll(/(\d+) 条/g)].map((m) => Number(m[1]))
}

test('① 分出去之后：视图的底与物化的底是同一个提交（两处各读一次）', () => {
  const dir = fixture()
  const c1 = git(dir, ['rev-parse', 'HEAD'])
  assert.equal(viewBase(dir, 'a1'), null, '还没分出去时视图的底不存在——那正是 ④ 拦下的一种')

  const b = cli(dir, ['--agent', 'a1', 'branch', c1])
  assert.equal(b.code, 0, b.err)
  assert.equal(viewBase(dir, 'a1'), c1, '分出去之后，ref 指着它')

  const f = cli(dir, ['--agent', 'a1', 'fork', c1])
  assert.equal(f.code, 0, f.err)
  const forked = matForkOf(dir, 'a1')
  assert.notEqual(forked, null, '日志里该有 mat/fork 那一行')
  assert.equal(forked?.base, c1)
  assert.equal(viewBase(dir, 'a1'), forked?.base, '两处读出来的逐字相等')

  // 底真的在：视图读得出 base 里那一条。分支头没定时它读不出来（下层是空的——④ 拦的就是它）。
  const r = cli(dir, ['--agent', 'a1', 'read', 'src/a.ts'])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, 'export const a = 1\n')
})

test('② 幂等：再敲一次 ref 不动、日志不多一条；两个进程同时分出去，恰一个把它定下去', async () => {
  const dir = fixture()
  const c1 = git(dir, ['rev-parse', 'HEAD'])
  const first = cli(dir, ['--agent', 'a1', 'branch', c1])
  assert.equal(first.code, 0, first.err)
  assert.match(first.err, /定格/)
  assert.equal(git(dir, ['rev-parse', 'refs/heads/a1']), c1)
  assert.equal(lines(dir, 'a1'), 0, '分出去不落日志')

  const again = cli(dir, ['--agent', 'a1', 'branch', c1])
  assert.equal(again.code, 0, again.err)
  assert.match(again.err, /幂等/)
  assert.equal(git(dir, ['rev-parse', 'refs/heads/a1']), c1, 'ref 不动')
  assert.equal(lines(dir, 'a1'), 0, '日志不多一条')

  // 并发那一路：两个进程同时把同一个 agent 分出去。**两个都退 0，恰一个报"定格"**——判据不是
  // "没人同时敲"，是"不管谁先到，结果都是它指着 c1"（输掉 CAS 的那个再看一眼 ref，看到的就是它）。
  const rs = await Promise.all([
    cliAsync(dir, ['--agent', 'a2', 'branch', c1]),
    cliAsync(dir, ['--agent', 'a2', 'branch', c1]),
  ])
  for (const r of rs) assert.equal(r.code, 0, r.err)
  assert.equal(rs.filter((r) => /定格/.test(r.err)).length, 1, '恰一个把它定下去')
  assert.equal(git(dir, ['rev-parse', 'refs/heads/a2']), c1)
  assert.equal(lines(dir, 'a2'), 0, '并发也不落日志')
})

test('③ 指着别处就拒绝，文案给出两条路；主线前移之后同样拒绝', () => {
  const dir = fixture()
  const c1 = git(dir, ['rev-parse', 'HEAD'])
  assert.equal(cli(dir, ['--agent', 'a1', 'branch', c1]).code, 0)

  // 造一个"别处"：写一条、提交一次——主线因此前移，而 a1 那条线还定在 c1 上。
  const w = cli(dir, ['write', 'note.txt', '--stdin'], '第二版\n')
  assert.equal(w.code, 0, w.err)
  const c2 = cli(dir, ['commit', '-m', '第二个提交点']).out.trim().split('\t')[0] as string
  assert.notEqual(c2, c1)
  assert.equal(git(dir, ['rev-parse', 'refs/heads/main']), c2)

  const bad = cli(dir, ['--agent', 'a1', 'branch', c2])
  assert.equal(bad.code, 1, '拒绝是 1（做不成），不是 2（敲错了）')
  assert.match(bad.err, /不搬已有的分支头/)
  assert.match(bad.err, new RegExp(`update-ref refs/heads/a1 ${c2}`), '路一：拿 git 直接指过去')
  assert.match(bad.err, new RegExp(`fork ${c1}`), '路二：拿它现在指着的那个提交当 base')
  assert.equal(git(dir, ['rev-parse', 'refs/heads/a1']), c1, '被拒的那一次一个字节没动')
  assert.equal(lines(dir, 'a1'), 0)

  // 主线自己：指着它时幂等，前移之后拿前移之前的那个提交来分 → 同样拒绝。
  assert.equal(cli(dir, ['branch', c2]).code, 0, '主线自己指着它——幂等')
  const badMain = cli(dir, ['branch', c1])
  assert.equal(badMain.code, 1)
  assert.match(badMain.err, /update-ref refs\/heads\/main/)
  assert.match(badMain.err, new RegExp(`fork ${c2}`))
  assert.equal(git(dir, ['rev-parse', 'refs/heads/main']), c2, '拒绝不改 ref')
})

test('④ fork：分支头不是它就拒绝并指路（负对照：是它时照常落地）', () => {
  const dir = fixture()
  const c1 = git(dir, ['rev-parse', 'HEAD'])
  const c2 = commitAt(dir, c1, '别处')

  // 负对照：先分出去再 fork，照常。
  assert.equal(cli(dir, ['--agent', 'a1', 'branch', c1]).code, 0)
  const ok = cli(dir, ['--agent', 'a1', 'fork', c1])
  assert.equal(ok.code, 0, ok.err)

  // 还没有分支头：拒绝，指路先分出去。
  const none = cli(dir, ['--agent', 'a2', 'fork', c1])
  assert.equal(none.code, 1)
  assert.match(none.err, /不是这个 agent 的分支头/)
  assert.match(none.err, /还没有定/)
  assert.match(none.err, new RegExp(`branch ${c1}`), '指路：先分出去')

  // 分支头指着别处：拒绝 + 两条路。
  assert.equal(cli(dir, ['--agent', 'a3', 'branch', c1]).code, 0)
  const wrong = cli(dir, ['--agent', 'a3', 'fork', c2])
  assert.equal(wrong.code, 1)
  assert.match(wrong.err, new RegExp(`branch ${c2}`))
  assert.match(wrong.err, new RegExp(`fork ${c1}`))
  assert.equal(git(dir, ['rev-parse', 'refs/heads/a3']), c1, '被拒的那一次不改 ref')

  // **拦在落地之前**：四个坐标一个都没建，日志里也没有 mat/fork 那一行。
  for (const a of ['a2', 'a3']) {
    assert.equal(existsSync(join(dir, '.fugue', 'mat', a)), false, `${a}：一个坐标都不该建`)
    assert.equal(matForkOf(dir, a), null, `${a}：不该有 mat/fork`)
  }
})

interface End {
  readonly sets: readonly number[]
  readonly digest: string
  readonly verify: Run
}

/**
 * 一路走到底：定分支头 → `fork` → 写两条 → `ensure` → `verify-mat`。
 * `viaCli` 为 false 时用 `git update-ref` 直接指——**那是这一单元的地板**。
 */
function endToEnd(viaCli: boolean): End {
  const dir = fixture()
  const agent = 'a1'
  const c1 = git(dir, ['rev-parse', 'HEAD'])
  if (viaCli) {
    const b = cli(dir, ['--agent', agent, 'branch', c1])
    assert.equal(b.code, 0, b.err)
  } else {
    git(dir, ['update-ref', `refs/heads/${agent}`, c1])
  }
  const f = cli(dir, ['--agent', agent, 'fork', c1])
  assert.equal(f.code, 0, f.err)
  for (const [path, body] of [
    ['own/mine.txt', 'mine\n'],
    ['src/a.ts', 'export const a = 42\n'],
  ] as const) {
    const w = cli(dir, ['--agent', agent, 'write', path, '--stdin'], body)
    assert.equal(w.code, 0, w.err)
  }
  const e = cli(dir, ['--agent', agent, 'ensure'])
  assert.equal(e.code, 0, e.err)
  const verify = cli(dir, ['--agent', agent, 'verify-mat'])
  return { sets: setsOf(verify.out), digest: mergedDigest(dir, agent), verify }
}

test('⑤ 端到端：branch → fork → write → ensure → verify-mat 三集合相等（退化档那一路相同）', () => {
  const a = endToEnd(true)
  assert.equal(a.verify.code, 0, a.verify.out + a.verify.err)
  assert.match(a.verify.out, /^ok\t/)
  assert.equal(a.sets.length, 3, `三个数都该报出来：${a.verify.out}`)
  assert.deepEqual(a.sets, [2, 2, 2], '写了两条：清单 · 差异集 · 落地各 2 条')

  const b = endToEnd(false)
  assert.equal(b.verify.code, 0, b.verify.out + b.verify.err)
  assert.deepEqual(b.sets, a.sets, '不敲 branch、用 git 直接指：三集合相同')
  assert.equal(b.digest, a.digest, '合并树的全树摘要也相同')
})
