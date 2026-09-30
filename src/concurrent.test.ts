// W2 的断言：**N 路并发落地——无交叉污染**。四条，逐条对 PLAN § 5.3 的 W2 行。
//
//   ① 四个 agent（同一个 base）四路并发 `fork` + 四路并发 `ensure`：四个都成功；各自的合并树
//      全树摘要 == "base ⊕ 这一路自己的改动"；别人写过的一条都看不见
//   ② 并发与串行逐字节一致：同一批工作跑两遍（四路并发 / 逐个），逐 agent 比全树摘要与日志事件
//   ③ 四个 writer 的序号各自唯一，四个视图 `replay --verify` 全过
//   ④ `dispose` 一个不影响其余三个：挂载表里不留它的挂载点，另外三条逐条不变
//
// **② 是这一单元的中心。** 并发本身不稀奇——S3 前那次检查（`tools/probe-concurrent.ts`）量过
// 四个 agent 并发当时就是通的；稀奇的是"并发跑出来的东西与一个个跑出来的**逐字节**一样"。
// 夹具里那个提交的时间戳因此被钉死（`GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`）：两趟的 base 是
// 同一个 `CommitId`，日志里那些字段才谈得上逐字节比。**`ms` 与信封的 `crc` 是读数，不比**——
// 一个是耗时，另一个覆盖着耗时。
//
// **四条路线两两不同**，所以任何一条漏到别人的树上都看得见：各自的新文件（`own/<agent>.txt`，
// a3 的还多两层目录）· 各自对同一条共享路径的改写（`src/a.ts`）· 各自只删自己那条底文件
// （`src/b.ts` 与 `docs/manual.md`）· 一条只有自己改的模式（`bin/run.sh`）。
//
// **检测器与产物是两份东西**：期望的那棵树由 `git clone` + fs 铺出来（`expectedDigest`），
// 不经过 M3 的一行代码；盘上那棵树是 M3 物化出来的。两边比的是同一条尺子（`scanTree`：路径 ·
// 模式 · 内容哈希，**不比时间戳**——两棵树的年龄本来就不一样）。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { WORKSPACE_STATE, scanTree } from './materialize/diffstat.ts'
import { removeTree } from './materialize/mount.ts'
import { gitModeOf } from './delta.ts'

const CLI = join(import.meta.dirname, 'cli', 'fugue.ts')

type Op =
  | { readonly k: 'write'; readonly path: string; readonly body: string }
  | { readonly k: 'remove'; readonly path: string }
  | { readonly k: 'chmod'; readonly path: string; readonly mode: string }

interface Route {
  readonly agent: string
  readonly ops: readonly Op[]
}

/**
 * 这一批工作。**四条两两不同**（见文件头）：漏过去一条，别人的树就变了。
 * 顺序有讲究——第一条总是那个只属于自己的路径，它是"别人看得见我吗"的那根探针。
 */
const ROUTES: readonly Route[] = [
  {
    agent: 'a1',
    ops: [
      { k: 'write', path: 'own/a1.txt', body: 'a1 的\n' },
      { k: 'write', path: 'src/a.ts', body: "export const a = 'a1'\n" },
      { k: 'remove', path: 'src/b.ts' },
    ],
  },
  {
    agent: 'a2',
    ops: [
      { k: 'write', path: 'own/a2.txt', body: 'a2 的\n' },
      { k: 'write', path: 'src/a.ts', body: "export const a = 'a2'\n" },
      { k: 'remove', path: 'docs/manual.md' },
    ],
  },
  {
    agent: 'a3',
    ops: [
      { k: 'write', path: 'own/deep/nested/a3.txt', body: 'a3 的\n' },
      { k: 'write', path: 'src/a.ts', body: "export const a = 'a3'\n" },
    ],
  },
  {
    agent: 'a4',
    ops: [
      { k: 'write', path: 'own/a4.txt', body: 'a4 的\n' },
      { k: 'write', path: 'src/a.ts', body: "export const a = 'a4'\n" },
      // **模式这一维只认两种**（`delta.ts` 的 `normMode`：有执行位就是 755）——`chmod 700` 与 755 是同一件事，
      // 量出来的是『没有变化』（`ensure` 会把它报成原样一条）。所以这里去掉执行位：644。
      { k: 'chmod', path: 'bin/run.sh', mode: '644' },
    ],
  },
]

const IDS: readonly string[] = ROUTES.map((r) => r.agent)

/** 夹具登记：跑完先把每个 agent 的物化卸干净再删目录（挂着 overlay 的 `merged` 底下摊的是真源）。 */
const MADE: string[] = []
/** 参照树：纯 git + fs，没有挂载，直接删。 */
const REFS: string[] = []

after(() => {
  for (const dir of MADE) {
    for (const a of IDS) {
      spawnSync(process.execPath, [CLI, '--root', dir, '--agent', a, 'dispose'], { encoding: 'utf8' })
    }
    try {
      removeTree(dir)
    } catch {
      spawnSync('sudo', ['-n', 'rm', '-rf', dir])
    }
  }
  for (const ref of REFS) rmSync(ref, { recursive: true, force: true })
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
      // **钉死时间戳**：②要比两趟的日志事件，而日志里存着 CommitId。
      GIT_AUTHOR_DATE: '2026-02-01T00:00:00+0000',
      GIT_COMMITTER_DATE: '2026-02-01T00:00:00+0000',
    },
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 退 ${r.status}：${r.stderr}`)
  return r.stdout.trim()
}

/** 一棵真仓库：工作树与 HEAD 逐字节一致（`fork` 的底就是它，架构 § 8.4）。 */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-nway-'))
  MADE.push(dir)
  const put = (rel: string, body: string): void => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  put('src/a.ts', 'export const a = 1\n')
  put('src/b.ts', 'export const b = 2\n')
  put('docs/manual.md', '# 手册\n')
  symlinkSync('src/a.ts', join(dir, 'link.ts'))
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

function cliAsync(root: string, args: readonly string[], stdin = ''): Promise<Run> {
  return new Promise((res) => {
    const p = spawn(process.execPath, [CLI, '--root', root, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (b: Buffer) => (out += b.toString()))
    p.stderr.on('data', (b: Buffer) => (err += b.toString()))
    p.on('close', (code) => res({ code: code ?? -1, out, err }))
    p.stdin.end(stdin)
  })
}

/** 挂载表里落在这个工作区下的挂载点（排过序）。**内核给的，不经过 CLI。** */
function mountPoints(root: string): string[] {
  return readFileSync('/proc/self/mounts', 'utf8')
    .split('\n')
    .map((l) => l.split(' ')[1])
    .filter((where): where is string => typeof where === 'string' && where.startsWith(root + '/'))
    .sort()
}

/**
 * 一棵树的全树摘要：**路径 · 模式 · 内容哈希**，不比时间戳。模式按树上那一档（`gitModeOf`）：
 * 参照树是 `git clone` 按 umask 铺的，物化树是落地按树上模式 chmod 的——整模式比的是两台
 * 机器的 umask，不是两棵树。
 */
function digestOf(root: string): string {
  const rows = scanTree(root, { skip: WORKSPACE_STATE }).leaves
    .map((l) => `${l.path}\t${gitModeOf(l.mode).toString(8)}\t${l.hash}`)
    .sort()
  return createHash('sha256').update(rows.join('\n')).digest('hex')
}

function mergedDigest(dir: string, agent: string): string {
  return digestOf(join(dir, '.fugue', 'mat', agent, 'merged'))
}

/**
 * 期望的那棵树：**另一条路**——`base` 那一份由 git 铺（clone），这一路的改动由 fs 落，
 * 全程不经过 M3。摘要的口径与 `mergedDigest` 是同一条尺子。
 */
function expectedDigest(dir: string, ops: readonly Op[]): string {
  const ref = mkdtempSync(join(tmpdir(), 'fugue-ref-'))
  REFS.push(ref)
  git(tmpdir(), ['clone', '-q', '--no-hardlinks', dir, ref])
  rmSync(join(ref, '.git'), { recursive: true, force: true })
  for (const op of ops) {
    const abs = join(ref, op.path)
    if (op.k === 'write') {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, op.body)
    } else if (op.k === 'remove') {
      rmSync(abs, { force: true })
    } else {
      chmodSync(abs, parseInt(op.mode, 8))
    }
  }
  return digestOf(ref)
}

/** 该 writer 的日志里出现过的序号，按文件顺序。 */
function seqsOf(dir: string, agent: string): number[] {
  const f = join(dir, '.fugue', 'log', agent + '.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => (JSON.parse(l) as { seq: number }).seq)
}

/** 日志事件，去掉信封的 `crc` 与读数 `ms`——两趟之间只有这两样该不一样。 */
function eventsOf(dir: string, agent: string): string[] {
  const f = join(dir, '.fugue', 'log', agent + '.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const o = JSON.parse(l) as Record<string, unknown>
      delete o.crc
      delete o.ms
      return JSON.stringify(o)
    })
}

/** 这一趟选的哪一档（`mat/fork` 事件里那一格）。**两趟比事件之前先比它。** */
function strategyOf(dir: string, agent: string): string {
  const f = join(dir, '.fugue', 'log', agent + '.jsonl')
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (line === '') continue
    const o = JSON.parse(line) as { t: string; strategy?: string }
    if (o.t === 'mat/fork') return o.strategy ?? ''
  }
  return ''
}

function dups(list: readonly number[]): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const n of list) {
    if (seen.has(n)) out.push(n)
    seen.add(n)
  }
  return out
}

/** `verify-mat` 那一行里的三个数：清单 · 差异集 · 落地。 */
function setsOf(out: string): number[] {
  return [...out.matchAll(/(\d+) 条/g)].map((m) => Number(m[1]))
}

/** 这一路的全部工作，按序（同一个 agent 的操作不并发——那是 W0 那道栅栏的事）。 */
async function work(dir: string, route: Route): Promise<void> {
  for (const op of route.ops) {
    const args =
      op.k === 'write'
        ? ['--agent', route.agent, 'write', op.path, '--stdin']
        : op.k === 'remove'
          ? ['--agent', route.agent, 'remove', op.path]
          : ['--agent', route.agent, 'chmod', op.path, op.mode]
    const stdin = op.k === 'write' ? op.body : ''
    const r = await cliAsync(dir, args, stdin)
    assert.equal(r.code, 0, `${route.agent} ${op.k} ${op.path}：${r.err}`)
  }
}

interface Pass {
  readonly dir: string
  readonly base: string
  readonly fork: readonly Run[]
  readonly ensure: readonly Run[]
}

/**
 * 一趟：定四条分支头（`fugue branch`）→ 四路并发 `fork` → 各写各的 → 四路并发 `ensure`。
 * `concurrent` 为 false 时四路逐个来——② 比的正是这两趟。
 */
async function pass(concurrent: boolean): Promise<Pass> {
  const dir = fixture()
  const base = git(dir, ['rev-parse', 'HEAD'])
  for (const route of ROUTES) {
    const b = cli(dir, ['--agent', route.agent, 'branch', base])
    assert.equal(b.code, 0, `${route.agent} branch ${base}：${b.err}`)
  }
  if (concurrent) {
    const fork = await Promise.all(ROUTES.map((r) => cliAsync(dir, ['--agent', r.agent, 'fork', base])))
    await Promise.all(ROUTES.map((r) => work(dir, r)))
    const ensure = await Promise.all(ROUTES.map((r) => cliAsync(dir, ['--agent', r.agent, 'ensure'])))
    return { dir, base, fork, ensure }
  }
  const fork: Run[] = []
  const ensure: Run[] = []
  for (const route of ROUTES) {
    fork.push(await cliAsync(dir, ['--agent', route.agent, 'fork', base]))
    await work(dir, route)
    ensure.push(await cliAsync(dir, ['--agent', route.agent, 'ensure']))
  }
  return { dir, base, fork, ensure }
}

test('① 四路并发 fork + 四路并发 ensure：四个都成，各自的树 == base ⊕ 自己的改动', async () => {
  const p = await pass(true)
  for (let i = 0; i < ROUTES.length; i++) {
    assert.equal(p.fork[i].code, 0, `${ROUTES[i].agent} 并发 fork：${p.fork[i].err}`)
    assert.equal(p.ensure[i].code, 0, `${ROUTES[i].agent} 并发 ensure：${p.ensure[i].err}`)
  }
  for (const route of ROUTES) {
    const a = route.agent
    const merged = join(p.dir, '.fugue', 'mat', a, 'merged')

    // 全树摘要 == base ⊕ 这一路自己的改动。参照树是 clone + fs 铺的，跨过 M3。
    assert.equal(
      mergedDigest(p.dir, a),
      expectedDigest(p.dir, route.ops),
      `${a} 的合并树不等于 base ⊕ 自己的改动`,
    )

    // 自己那条在，且是自己的内容。
    const mine = route.ops[0]
    assert.equal(mine.k, 'write')
    if (mine.k === 'write') {
      assert.equal(readFileSync(join(merged, mine.path), 'utf8'), mine.body, `${a} 自己的文件内容不对`)
    }

    // 别人的：盘上看不见，视图里也读不出来。
    for (const other of ROUTES) {
      if (other.agent === a) continue
      const mark = other.ops[0].path
      assert.equal(
        existsSync(join(merged, mark)),
        false,
        `${a} 的合并树里看见了 ${other.agent} 的 ${mark}`,
      )
      const r = cli(p.dir, ['--agent', a, 'read', mark])
      assert.equal(r.code, 1, `${a} 的视图里读得出 ${other.agent} 的 ${mark}：${r.out}`)
    }

    // 删除这一维：自己删的不在，别人删的还在。
    for (const other of ROUTES) {
      const del = other.ops.find((op) => op.k === 'remove')
      if (del === undefined) continue
      const gone = join(merged, del.path)
      if (other.agent === a) {
        assert.equal(existsSync(gone), false, `${a} 自己删掉的 ${del.path} 还在`)
      } else {
        assert.equal(existsSync(gone), true, `${a} 替 ${other.agent} 把 ${del.path} 删了`)
      }
    }

    // 三集合相等，条数就是这一路自己那几条（日志重放 · 差异集 · 盘上落地，三个来源两两独立）。
    const verify = cli(p.dir, ['--agent', a, 'verify-mat'])
    assert.equal(verify.code, 0, `${a} verify-mat：${verify.out}${verify.err}`)
    assert.match(verify.out, /^ok\t/)
    assert.deepEqual(
      setsOf(verify.out),
      [route.ops.length, route.ops.length, route.ops.length],
      `${a} 三集合该各是 ${route.ops.length} 条：${verify.out}`,
    )
  }
})

test('② 并发与串行逐字节一致：全树摘要 · 日志事件（ms 与 crc 是读数，不比）', async () => {
  const c = await pass(true)
  const s = await pass(false)
  assert.equal(c.base, s.base, '两趟夹具的 base 该是同一个提交（时间戳钉死了）')
  for (const route of ROUTES) {
    const a = route.agent
    // 先比档：两趟要是选了不同的档（平台探测的读数，不是并发的事），下面那条会以一种说不清
    // 由头的方式红——所以这一条把由头先摆出来。
    assert.equal(
      strategyOf(c.dir, a),
      strategyOf(s.dir, a),
      `${a} 两趟选中的档不同——那是平台探测的读数，与并发无关（换个时间重跑）`,
    )
    assert.deepEqual(seqsOf(c.dir, a), seqsOf(s.dir, a), `${a} 两趟的序号该一样`)
    assert.deepEqual(eventsOf(c.dir, a), eventsOf(s.dir, a), `${a} 两趟的日志事件该逐字节一致`)
    assert.equal(
      mergedDigest(c.dir, a),
      mergedDigest(s.dir, a),
      `${a} 两趟的全树摘要该逐字节一致`,
    )
  }
})

test('③ 四个 writer 的序号各自唯一，四个视图 replay --verify 全过', async () => {
  const p = await pass(true)
  const files = readdirSync(join(p.dir, '.fugue', 'log'))
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
  assert.deepEqual(
    files,
    IDS.map((a) => a + '.jsonl').sort(),
    '四个 writer 该是四份日志（一份日志一个写者进程，架构 § 9.2）',
  )
  for (const route of ROUTES) {
    const a = route.agent
    const seqs = seqsOf(p.dir, a)
    // **不数条数**：一条操作不一定一条事件——下层里已有的路径上 `chmod` 是『拷上来』加『改模式』
    // 两条（见 `ROUTES` 里那一处注释）。要判的是这份日志是一个 1..n 的连续序列，重复与空洞都在这两条里。
    assert.deepEqual(dups(seqs), [], `${a} 的序号有重复：${JSON.stringify(seqs)}`)
    assert.deepEqual(
      seqs,
      seqs.map((_, i) => i + 1),
      `${a} 的序号该是 1..n：${JSON.stringify(seqs)}`,
    )
    const v = cli(p.dir, ['--agent', a, 'replay', '--verify'])
    assert.equal(v.code, 0, `${a} replay --verify 退 ${v.code}：${v.out}${v.err}`)
  }
})

test('④ dispose 一个不影响其余三个：挂载表里不留它的挂载点', async () => {
  const p = await pass(true)
  const before = mountPoints(p.dir)
  const mergedOf = (a: string): string => join(p.dir, '.fugue', 'mat', a, 'merged')
  assert.equal(before.length, ROUTES.length, `四路都该挂着：${JSON.stringify(before)}`)

  const others = IDS.filter((a) => a !== 'a1')
  const digests = others.map((a) => mergedDigest(p.dir, a))
  const d = cli(p.dir, ['--agent', 'a1', 'dispose'])
  assert.equal(d.code, 0, `a1 dispose：${d.err}`)

  const after = mountPoints(p.dir)
  assert.equal(existsSync(join(p.dir, '.fugue', 'mat', 'a1')), false, 'a1 的物化根该跟着走')
  assert.deepEqual(
    after.filter((where) => where.includes('/mat/a1/')),
    [],
    `挂载表里不留 a1 的挂载点：${JSON.stringify(after)}`,
  )
  assert.deepEqual(
    after,
    before.filter((where) => where !== mergedOf('a1')),
    '别人的挂载点该逐条不变',
  )
  for (let i = 0; i < others.length; i++) {
    const a = others[i]
    assert.equal(after.includes(mergedOf(a)), true, `${a} 的合并树还该挂着`)
    assert.equal(mergedDigest(p.dir, a), digests[i], `${a} 的树被 a1 的 dispose 动过了`)
    const v = cli(p.dir, ['--agent', a, 'verify-mat'])
    assert.equal(v.code, 0, `${a} verify-mat：${v.out}${v.err}`)
  }
})
