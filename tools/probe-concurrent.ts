// 探针：**并发这一维**（S3 前检查）。取证用，不是产品的一部分。
//
// 三问，每一问都真起进程（走 CLI，不是调用库函数）——要撞的正是"两个进程"这一维：
//
//   A · 一个 agent 两路并发 `ensure`：盘上 · 日志里 · 挂载态各发生什么
//   B · 四个 agent 各自一条分支，并发 `fork` + `ensure`：互相看不见吗，各自的树对吗
//   C · 一个 agent 两路并发 `write`：日志里的序号还唯一吗
//
// 每一例收尾都跑 `replay --verify` 与 `verify-mat`——那两条正是"重放一致"与"清单相等"的
// 验收口，所以它们同时是这一维的检测器。
//
// 实测（内核 6.18 · WSL2 · ext4 · Node v24.21.0，2026-02）：
//
//   A · 两路并发 `ensure`（同一个 agent）：**5 次全部**有一路 exit 1，文案是
//       "overlay 卸不下来：sudo -n umount … not mounted"——它把"另一个进程已经卸过了"报成了
//       "卸不下来"。盘上没坏（树对 · 挂载在 · verify-mat 0），但一次成功的操作被报成失败。
//   B · 四个 agent 并发 `ensure`（各自一条分支）：四个都 exit 0，并发总耗时 215 ms 而逐个都是
//       213–215 ms（真并行）；各自的树对 · 别人的一条看不见 · verify-mat 全 ok · 序号无重复。
//   C · 两路并发 `write`（同一个 agent）：序号有时 [1,1]（重复）有时 [1,2] —— **是竞态**。
//   C2 · 有快照之后两路并发写：序号 [1,2,3,3]，重复不报错，`replay --verify` 也照样 0。
//   C3 · 一个进程提交、一个进程写：序号 [1,2,3] 唯一，但快照的戳（3）比另一个进程那条事件的
//       序号（2）晚 —— 从快照重放**把它整条丢掉**，`replay --verify` 退 1 才把它抓出来。
//   D · 四个 agent 并发 `fork`（同一个工作区）：四个都 exit 0；唯一那个共享的可变文件
//       `<root>/.fugue/config`（平台事实的缓存）读得回来、人写的那条键还在。
//
// 结论一句话：**N 个不同 agent 的并发今天就是通的；同一个 agent 的两个写者今天没有栅栏**
// （序号会重复，快照的戳与内容会错位），而 M3 连身份模型里的名字都装不下（`agent/r1/1` 被拒）。
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'src', 'cli', 'fugue.ts')
const MADE: string[] = []

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

/** 一棵真仓库，工作树与 HEAD 逐字节一致。 */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-conc-'))
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
  return dir
}

interface R {
  readonly code: number
  readonly out: string
  readonly err: string
  readonly ms: number
}

/** 一次 CLI 调用。stdin 一次性喂进去再关。 */
function cli(root: string, args: readonly string[], stdin = ''): Promise<R> {
  return new Promise((res) => {
    const t0 = Date.now()
    const p = spawn('node', [CLI, '--root', root, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (b: Buffer) => (out += b.toString()))
    p.stderr.on('data', (b: Buffer) => (err += b.toString()))
    p.on('close', (code) => res({ code: code ?? -1, out, err, ms: Date.now() - t0 }))
    p.stdin.end(stdin)
  })
}

function lines(r: R): string {
  return r.err.trim().split('\n').join(' | ')
}

/** 该 writer 的日志里出现过的序号，按文件顺序。 */
function seqs(root: string, w: string): number[] {
  const f = join(root, '.fugue', 'log', w + '.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => (JSON.parse(l) as { seq: number }).seq)
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

function mounted(root: string, agent: string): boolean {
  const merged = join(root, '.fugue', 'mat', agent, 'merged')
  return readFileSync('/proc/self/mounts', 'utf8').split('\n').some((l) => l.includes(' ' + merged + ' '))
}

function has(p: string): boolean {
  return existsSync(p)
}

function body(p: string): string {
  try {
    return JSON.stringify(readFileSync(p, 'utf8'))
  } catch (err) {
    return `读不动（${(err as Error).message}）`
  }
}

const AGENTS = ['a1', 'a2', 'a3', 'a4']

/** 分枝：把该 agent 的分支头定格在 base 上。今天没有一条命令做这件事，所以探针自己来。 */
function branch(root: string, agent: string, commit: string): void {
  git(root, ['update-ref', 'refs/heads/' + agent, commit])
}

async function caseA(): Promise<void> {
  console.log('A · 两路并发 ensure（同一个 agent，同一批 delta）· 跑 5 次')
  for (let i = 1; i <= 5; i++) {
    const root = fixture()
    const commit = git(root, ['rev-parse', 'HEAD'])
    const a = AGENTS[0]
    branch(root, a, commit)
    await cli(root, ['--agent', a, 'fork', commit])
    await cli(root, ['--agent', a, 'write', 'src/own.ts', '--stdin'], 'export const own = 1\n')
    await cli(root, ['--agent', a, 'write', 'src/a.ts', '--stdin'], 'export const a = 42\n')
    const [r1, r2] = await Promise.all([
      cli(root, ['--agent', a, 'ensure']),
      cli(root, ['--agent', a, 'ensure']),
    ])
    const s = seqs(root, a)
    const v = await cli(root, ['--agent', a, 'replay', '--verify'])
    const m = await cli(root, ['--agent', a, 'verify-mat'])
    const merged = join(root, '.fugue', 'mat', a, 'merged')
    const syncs = readFileSync(join(root, '.fugue', 'log', a + '.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0 && (JSON.parse(l) as { t: string }).t === 'mat/sync').length
    const okTree =
      body(join(merged, 'src/a.ts')) === JSON.stringify('export const a = 42\n') && has(join(merged, 'src/own.ts'))
    console.log(
      `  ${i} · exit ${r1.code}/${r2.code} · 序号重复 ${JSON.stringify(dups(s))} · mat/sync ${syncs} 条` +
        ` · verify ${v.code} · verify-mat ${m.code} · 挂载 ${mounted(root, a) ? '挂' : '没挂'} · 树 ${okTree ? '对' : '不对'}`,
    )
    const bad = [r1, r2].filter((r) => r.code !== 0)
    for (const r of bad) console.log(`      失败文案：${lines(r)}`)
  }
  console.log('')
}

async function caseB(): Promise<void> {
  const root = fixture()
  const commit = git(root, ['rev-parse', 'HEAD'])
  for (const a of AGENTS) {
    branch(root, a, commit)
    const f = await cli(root, ['--agent', a, 'fork', commit])
    const w = await cli(root, ['--agent', a, 'write', `own/${a.split('/').pop()}.txt`, '--stdin'], 'mine\n')
    if (f.code !== 0 || w.code !== 0) console.log(`  [准备] ${a} fork ${f.code}（${lines(f)}）· write ${w.code}（${lines(w)}）`)
  }
  const t0 = Date.now()
  const rs = await Promise.all(AGENTS.map((a) => cli(root, ['--agent', a, 'ensure'])))
  const ms = Date.now() - t0

  console.log('B · 四个 agent 并发 ensure（各自一条分支，底同一棵树）')
  console.log(`  四个进程 exit ${JSON.stringify(rs.map((r) => r.code))} · 并发总耗时 ${ms} ms（逐个 ${JSON.stringify(rs.map((r) => r.ms))}）`)
  for (const a of AGENTS) {
    const v = await cli(root, ['--agent', a, 'replay', '--verify'])
    const m = await cli(root, ['--agent', a, 'verify-mat'])
    const merged = join(root, '.fugue', 'mat', a, 'merged')
    const mine = a.split('/').pop() ?? ''
    const others = AGENTS.filter((x) => x !== a).map((x) => (x.split('/').pop() ?? '') + '.txt')
    const leaked = others.filter((o) => has(join(merged, 'own', o)))
    const s = seqs(root, a)
    console.log(
      `  ${a} 序号 ${JSON.stringify(s)} 重复 ${JSON.stringify(dups(s))} · verify exit ${v.code} · verify-mat ${m.out.trim().split('\t')[0]}` +
        ` · 自己的 ${has(join(merged, 'own', mine + '.txt')) ? '在' : '不在'}` +
        ` · 别人的 ${leaked.length === 0 ? '一条都没有' : JSON.stringify(leaked)}` +
        ` · 底里的 src/b.ts ${has(join(merged, 'src/b.ts')) ? '在' : '不在'} · 挂载 ${mounted(root, a) ? '挂' : '没挂'}`,
    )
  }
  console.log('')
}

async function caseC(): Promise<void> {
  const root = fixture()
  const commit = git(root, ['rev-parse', 'HEAD'])
  const a = AGENTS[0]
  branch(root, a, commit)
  const [r1, r2] = await Promise.all([
    cli(root, ['--agent', a, 'write', 'src/p.ts', '--stdin'], 'export const p = 1\n'),
    cli(root, ['--agent', a, 'write', 'src/q.ts', '--stdin'], 'export const q = 1\n'),
  ])
  const s = seqs(root, a)
  const v = await cli(root, ['--agent', a, 'replay', '--verify'])
  const d = await cli(root, ['--agent', a, 'diff'])
  console.log('C · 两路并发 write（同一个 agent）')
  console.log(`  两个进程 exit ${r1.code} ${r2.code} · 日志序号 ${JSON.stringify(s)} · 重复 ${JSON.stringify(dups(s))}`)
  console.log(`  replay --verify exit ${v.code} · ${v.out.trim()}`)
  console.log(`  diff 报出 ${d.out.trim().split('\n').filter((l) => l.length > 0).length} 条：${d.out.trim().split('\n').join(' | ')}`)
  console.log('')
}

async function caseC2(): Promise<void> {
  const root = fixture()
  const commit = git(root, ['rev-parse', 'HEAD'])
  const a = AGENTS[0]
  branch(root, a, commit)
  await cli(root, ['--agent', a, 'write', 'src/p.ts', '--stdin'], 'export const p = 1\n')
  const c = await cli(root, ['--agent', a, 'commit', '-m', '第一个提交点'])
  const snapDir = join(root, '.fugue', 'snap', a)
  const snapFiles = existsSync(snapDir) ? readdirSync(snapDir).sort() : []
  const snapSeq = snapFiles.length === 0 ? null : snapFiles.join(' · ')
  const [r1, r2] = await Promise.all([
    cli(root, ['--agent', a, 'write', 'src/x1.ts', '--stdin'], 'export const x1 = 1\n'),
    cli(root, ['--agent', a, 'write', 'src/x2.ts', '--stdin'], 'export const x2 = 1\n'),
  ])
  const s = seqs(root, a)
  const v = await cli(root, ['--agent', a, 'replay', '--verify'])
  const names = readFileSync(join(root, '.fugue', 'log', a + '.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => (JSON.parse(l) as { t: string; path?: string }).t + '/' + ((JSON.parse(l) as { path?: string }).path ?? ''))
  console.log('C2 · 提交点（有快照）之后两路并发 write')
  console.log(`  commit exit ${c.code} · 快照 seq ${snapSeq} · 两个写进程 exit ${r1.code} ${r2.code}`)
  console.log(`  日志序号 ${JSON.stringify(s)} · 重复 ${JSON.stringify(dups(s))}`)
  console.log(`  日志事件 ${JSON.stringify(names)}`)
  console.log(`  replay --verify exit ${v.code} · ${v.out.trim().split('\n').join(' | ')}`)
  const d = await cli(root, ['--agent', a, 'diff'])
  console.log(`  diff 报出 ${d.out.trim().split('\n').filter((l) => l.length > 0).length} 条`)
  console.log('')
}

async function caseC3(): Promise<void> {
  const root = fixture()
  const commit = git(root, ['rev-parse', 'HEAD'])
  const a = AGENTS[0]
  branch(root, a, commit)
  await cli(root, ['--agent', a, 'write', 'src/p.ts', '--stdin'], 'export const p = 1\n')
  const [r1, r2] = await Promise.all([
    cli(root, ['--agent', a, 'commit', '-m', '并发里的提交点']),
    cli(root, ['--agent', a, 'write', 'src/x.ts', '--stdin'], 'export const x = 1\n'),
  ])
  const s = seqs(root, a)
  const snapDir = join(root, '.fugue', 'snap', a)
  const snapFiles = existsSync(snapDir) ? readdirSync(snapDir).sort() : []
  const v = await cli(root, ['--agent', a, 'replay', '--verify'])
  const full = await cli(root, ['--agent', a, 'list', 'src'])
  console.log('C3 · 一个进程提交、一个进程写（两个进程抢同一个序号）')
  console.log(`  commit exit ${r1.code} · write exit ${r2.code} · 日志序号 ${JSON.stringify(s)} · 重复 ${JSON.stringify(dups(s))}`)
  console.log(`  快照文件 ${JSON.stringify(snapFiles)}`)
  console.log(`  replay --verify exit ${v.code} · ${v.out.trim().split('\n').join(' | ')}`)
  console.log(`  从 0 重放看到的 src/：${JSON.stringify(full.out.trim().split('\n').map((l) => l.split('\t').pop()))}`)
  console.log('')
}

async function caseD(): Promise<void> {
  const root = fixture()
  const commit = git(root, ['rev-parse', 'HEAD'])
  await cli(root, ['config', 'set', 'docs.trace.path', 'traces'])
  for (const a of AGENTS) branch(root, a, commit)
  const t0 = Date.now()
  const rs = await Promise.all(AGENTS.map((a) => cli(root, ['--agent', a, 'fork', commit])))
  const ms = Date.now() - t0
  let cfg = '(读不动)'
  let kept = false
  try {
    cfg = readFileSync(join(root, '.fugue', 'config'), 'utf8')
    kept = (JSON.parse(cfg) as { docs?: { trace?: { path?: string } } }).docs?.trace?.path === 'traces'
  } catch (err) {
    cfg = `坏文件：${(err as Error).message}`
  }
  const platforms = cfg.includes('platform') ? 'platform 键在' : 'platform 键不在'
  console.log('D · 四个 agent 并发 fork（同一个工作区）')
  console.log(`  四个进程 exit ${JSON.stringify(rs.map((r) => r.code))} · 并发总耗时 ${ms} ms（逐个 ${JSON.stringify(rs.map((r) => r.ms))}）`)
  console.log(`  配置：${platforms} · 人写的那条键 ${kept ? '还在' : '丢了'} · 文件长度 ${cfg.length}`)
  for (let i = 0; i < AGENTS.length; i++) {
    const a = AGENTS[i]
    const merged = join(root, '.fugue', 'mat', a, 'merged')
    console.log(`  ${a} 挂载 ${mounted(root, a) ? '挂' : '没挂'} · 底里的 src/b.ts ${has(join(merged, 'src/b.ts')) ? '在' : '不在'}`)
  }
  console.log('')
}

async function main(): Promise<void> {
  try {
    await caseA()
    await caseB()
    await caseC()
    await caseC2()
    await caseC3()
    await caseD()
  } finally {
    for (const d of MADE) {
      for (const line of readFileSync('/proc/self/mounts', 'utf8').split('\n')) {
        const [what, where] = line.split(' ')
        if (where !== undefined && where.startsWith(d + '/')) spawnSync('sudo', ['-n', 'umount', '-l', where])
        void what
      }
      try {
        rmSync(d, { recursive: true, force: true })
      } catch (err) {
        // 懒卸载之后 overlay 的 work 目录（内核建的，模式 0000）还在，普通 rm 进不去。
        if (spawnSync('sudo', ['-n', 'rm', '-rf', d]).status !== 0) {
          console.log(`（收尾：${d} 删不动——${(err as Error).message}）`)
        }
      }
    }
  }
}

await main()
