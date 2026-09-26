// M0 的断言。四条对应 PLAN § 5 给 U1 的验收，其余几条守的是它周边的边界。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { LogEvent } from './events.ts'
import { LogCorruptError, logDir, openLog, type SyncLevel } from './log.ts'
import type { AgentId, BranchId, CommitId, LogPos, WriterId } from '../terms.ts'

const REPO = join(import.meta.dirname, '..', '..')
const HELPER = join(REPO, 'test', 'helpers', 'append-writer.ts')
const CLI = join(REPO, 'src', 'cli', 'fugue.ts')

const A = (s: string): AgentId => s as AgentId
const C = (s: string): CommitId => s as CommitId
const B = (s: string): BranchId => s as BranchId
const tmp = (): string => mkdtempSync(join(tmpdir(), 'fugue-log-'))
const logFile = (root: string, w: string): string => join(logDir(root), w + '.jsonl')

const ev = (i: number, agent: AgentId): LogEvent => ({
  t: 'view/write',
  agent,
  path: `src/f${i}.ts`,
  rev: i,
  blob: `b${i}`,
  mode: 420,
})

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) {
    // 只求读完
  }
}

function countRows(root: string, w: WriterId): Promise<number> {
  return (async () => {
    const log = openLog(root, { sync: 'never' })
    let n = 0
    for await (const _ of log.readByWriter(w)) n++
    await log.close()
    return n
  })()
}

// ────────────────────────────────── 断言 ① 单 writer 与重启

test('单 writer：序号从 1 起、连续，内容逐条回得来', async () => {
  const root = tmp()
  const log = openLog(root, { sync: 'never' })
  for (let i = 1; i <= 1000; i++) {
    assert.equal(await log.append('round', ev(i, A('round'))), i)
  }
  const back: LogEvent[] = []
  for await (const e of log.readByWriter('round')) back.push(e)
  assert.equal(back.length, 1000)
  assert.deepEqual(back[0], ev(1, A('round')))
  assert.deepEqual(back[999], ev(1000, A('round')))
  await log.close()
  rmSync(root, { recursive: true, force: true })
})

test('新开的句柄接上同一份日志：序号接着走，不重号', async () => {
  const root = tmp()
  const a = openLog(root, { sync: 'never' })
  await a.append('round', ev(1, A('round')))
  await a.append('round', ev(2, A('round')))
  await a.close()

  const b = openLog(root, { sync: 'never' })
  assert.equal(await b.append('round', ev(3, A('round'))), 3)
  await b.close()

  assert.equal(await countRows(root, 'round'), 3)
  rmSync(root, { recursive: true, force: true })
})

// ────────────────────────────────── 断言 ② 尾行截断

test('尾行截断：截到最后一个完整行内的任意字节，都止于该行', async () => {
  const root = tmp()
  const log = openLog(root, { sync: 'never' })
  for (let i = 1; i <= 20; i++) await log.append('round', ev(i, A('round')))
  await log.close()

  const bytes = readFileSync(logFile(root, 'round'))
  const lastStart = bytes.lastIndexOf(0x0a, bytes.length - 2) + 1
  assert.ok(lastStart > 0 && lastStart < bytes.length - 1, '样本应当有多行')

  let tried = 0
  for (let cut = lastStart; cut < bytes.length; cut++) {
    const other = tmp()
    const dst = logFile(other, 'round')
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, bytes.subarray(0, cut))
    assert.equal(await countRows(other, 'round'), 19, `截到第 ${cut} 字节`)
    rmSync(other, { recursive: true, force: true })
    tried++
  }
  assert.ok(tried > 10, `应当试过足够多的截点，实试 ${tried} 个`)
  rmSync(root, { recursive: true, force: true })
})

test('整份文件就是一条半行：当作 0 条，序号从 1 重新起', async () => {
  const root = tmp()
  const log = openLog(root, { sync: 'never' })
  await log.append('round', ev(1, A('round')))
  await log.close()

  const file = logFile(root, 'round')
  const bytes = readFileSync(file)
  writeFileSync(file, bytes.subarray(0, bytes.length - 5)) // 去掉结尾换行与若干字节

  assert.equal(await countRows(root, 'round'), 0)
  const again = openLog(root, { sync: 'never' })
  assert.equal(await again.append('round', ev(1, A('round'))), 1)
  await again.close()
  rmSync(root, { recursive: true, force: true })
})

// ────────────────────────────────── 断言 ③ 中段损坏必须拒绝

test('中段一字节损坏 → 拒绝加载并指出行号', async () => {
  const root = tmp()
  const log = openLog(root, { sync: 'never' })
  for (let i = 1; i <= 20; i++) await log.append('round', ev(i, A('round')))
  await log.close()

  const file = logFile(root, 'round')
  const lines = readFileSync(file, 'utf8').split('\n')
  const row = 10
  const at = lines[row - 1].indexOf('src/f10.ts')
  lines[row - 1] = lines[row - 1].slice(0, at + 4) + 'X' + lines[row - 1].slice(at + 5)
  writeFileSync(file, lines.join('\n'))

  await assert.rejects(drain(openLog(root, { sync: 'never' }).readByWriter('round')), (err) => {
    assert.ok(err instanceof LogCorruptError, `应是 LogCorruptError，实得 ${String(err)}`)
    assert.equal(err.line, row)
    return true
  })
  rmSync(root, { recursive: true, force: true })
})

test('完整的末行坏了也拒绝——半行截断只管没有行终止符的那一段', async () => {
  const root = tmp()
  const log = openLog(root, { sync: 'never' })
  for (let i = 1; i <= 5; i++) await log.append('round', ev(i, A('round')))
  await log.close()

  const file = logFile(root, 'round')
  const lines = readFileSync(file, 'utf8').split('\n')
  const last = lines.length - 2
  const at = lines[last].indexOf('src/f5.ts')
  lines[last] = lines[last].slice(0, at + 4) + 'X' + lines[last].slice(at + 5)
  writeFileSync(file, lines.join('\n'))

  await assert.rejects(drain(openLog(root, { sync: 'never' }).readByWriter('round')), LogCorruptError)
  // 追加也必须失败：损坏的日志上继续写只会更糟
  await assert.rejects(
    openLog(root, { sync: 'never' }).append('round', ev(6, A('round'))),
    LogCorruptError,
  )
  rmSync(root, { recursive: true, force: true })
})

test('信封里的 writer 与文件名不符 → 拒绝加载', async () => {
  const root = tmp()
  const log = openLog(root, { sync: 'never' })
  await log.append(A('agent/r1/1'), ev(1, A('agent/r1/1')))
  await log.close()

  const good = logFile(root, 'agent/r1/1')
  const renamed = logFile(root, 'agent/r1/2')
  mkdirSync(dirname(renamed), { recursive: true })
  writeFileSync(renamed, readFileSync(good))
  rmSync(good)

  await assert.rejects(
    drain(openLog(root, { sync: 'never' }).readByWriter(A('agent/r1/2'))),
    /writer 与文件名不符/,
  )
  rmSync(root, { recursive: true, force: true })
})

// ────────────────────────────────── 断言 ④ 并发与全序

test('4 个 writer 各 1000 条并发追加：全序唯一、稳定、每路连续', async () => {
  const root = tmp()
  const N = 1000
  const agents = [1, 2, 3, 4].map((n) => `agent/r1/${n}`)

  const kids = agents.map((w) =>
    spawn(process.execPath, [HELPER, root, w, String(N)], { stdio: 'inherit' }),
  )
  await Promise.all(
    kids.map(
      (k) =>
        new Promise<void>((res, rej) => {
          k.on('error', rej)
          k.on('exit', (code) => (code === 0 ? res() : rej(new Error(`子进程退出码 ${code}`))))
        }),
    ),
  )

  const log = openLog(root, { sync: 'never' })
  const rows: { pos: LogPos }[] = []
  for await (const r of log.readMerged()) rows.push(r)
  assert.equal(rows.length, agents.length * N)

  assert.equal(
    new Set(rows.map((r) => `${r.pos.writer}:${r.pos.seq}`)).size,
    rows.length,
    '位置必须唯一',
  )
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].pos
    const b = rows[i].pos
    assert.ok(a.seq < b.seq || (a.seq === b.seq && a.writer < b.writer), `第 ${i} 条不单调`)
  }
  for (const w of agents) {
    const seqs = rows.filter((r) => r.pos.writer === w).map((r) => r.pos.seq)
    assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1), `${w} 的序号应连续`)
  }

  const sig = (rs: { pos: LogPos }[]): string =>
    rs.map((r) => `${r.pos.writer}:${r.pos.seq}`).join(',')
  const want = sig(rows)
  for (let k = 0; k < 10; k++) {
    const again: { pos: LogPos }[] = []
    for await (const r of log.readMerged()) again.push(r)
    assert.equal(sig(again), want, `第 ${k + 1} 次重读的序不同`)
  }
  await log.close()
  rmSync(root, { recursive: true, force: true })
})

test('readMerged(fromSeq) 只回 seq 大于它的事件', async () => {
  const root = tmp()
  const log = openLog(root, { sync: 'never' })
  for (let i = 1; i <= 5; i++) {
    for (const w of ['agent/r1/1', 'agent/r1/2']) {
      await log.append(A(w), ev(i, A(w)))
    }
  }
  const seen: string[] = []
  for await (const r of log.readMerged(3)) seen.push(`${r.pos.writer}:${r.pos.seq}`)
  assert.deepEqual(seen, [
    'agent/r1/1:4',
    'agent/r1/2:4',
    'agent/r1/1:5',
    'agent/r1/2:5',
  ])
  await log.close()
  rmSync(root, { recursive: true, force: true })
})

// ────────────────────────────────── 耐久档位与边界

test('sync 三档：读回来的字节完全相同', async () => {
  const bodies: string[] = []
  for (const sync of ['each', 'batch', 'never'] as SyncLevel[]) {
    const root = tmp()
    const log = openLog(root, { sync })
    for (let i = 1; i <= 20; i++) await log.append('round', ev(i, A('round')))
    await log.close()
    bodies.push(readFileSync(logFile(root, 'round'), 'utf8'))
    rmSync(root, { recursive: true, force: true })
  }
  assert.equal(bodies[0], bodies[1], 'each 与 batch 的内容应逐字节相同')
  assert.equal(bodies[1], bodies[2], 'batch 与 never 的内容应逐字节相同')
})

test('writer 标识非法 → 拒绝，且不写出 log 目录', async () => {
  const root = tmp()
  const log = openLog(root, { sync: 'never' })
  const bad = ['', '/abs', 'a/../b', '../x', '.hidden', 'a//b', 'a\\b', 'a\0b']
  for (const w of bad) {
    await assert.rejects(() => log.append(w as WriterId, ev(1, A('round'))), /writer 标识非法/)
  }
  await log.close()
  assert.equal(existsSync(logDir(root)), false, '非法标识不应创建出任何文件')
  rmSync(root, { recursive: true, force: true })
})

// ────────────────────────────────── 命令：它是这一步"可用"的凭据

test('CLI：fugue log 列出全部事件；日志损坏时非零退出并说明原因', async () => {
  const root = tmp()
  const log = openLog(root, { sync: 'never' })
  for (let i = 1; i <= 3; i++) await log.append('round', ev(i, A('round')))
  await log.close()

  const ok = spawnSync(process.execPath, [CLI, '--root', root, '--json', 'log'], {
    encoding: 'utf8',
  })
  assert.equal(ok.status, 0, ok.stderr)
  const lines = ok.stdout.trim().split('\n')
  assert.equal(lines.length, 3)
  assert.deepEqual(JSON.parse(lines[0]).pos, { writer: 'round', seq: 1 })

  const file = logFile(root, 'round')
  writeFileSync(file, readFileSync(file, 'utf8').replace('src/f2.ts', 'src/fX.ts'))
  const bad = spawnSync(process.execPath, [CLI, '--root', root, 'log'], { encoding: 'utf8' })
  assert.notEqual(bad.status, 0, '损坏的日志必须非零退出')
  assert.match(bad.stderr, /日志损坏/)
  rmSync(root, { recursive: true, force: true })
})

// ────────────────────────────────── M0 不解释事件

const V = A('agent/r1/1')

const SAMPLES: LogEvent[] = [
  { t: 'view/write', agent: V, path: 'src/a.ts', rev: 1, blob: 'bl1', mode: 420 },
  { t: 'view/symlink', agent: V, path: 'link', rev: 2, target: '../x' },
  { t: 'view/remove', agent: V, path: 'src/b.ts', rev: 3 },
  { t: 'view/rename', agent: V, from: 'src/c.ts', to: 'src/d.ts', rev: 4 },
  { t: 'view/chmod', agent: V, path: 'src/e.ts', rev: 5, mode: 493 },
  { t: 'ckpt/commit', agent: V, commit: C('c0ffee'), rev: 6, msg: '第一次提交' },
  {
    t: 'mat/fork',
    agent: V,
    base: C('c0ffee'),
    strategy: 'overlayfs',
    paths: ['src/a.ts'],
    hashes: ['h1'],
    ms: 12.5,
  },
  {
    t: 'mat/sync',
    agent: V,
    from: 6,
    to: 9,
    paths: ['src/a.ts', 'src/b.ts'],
    hashes: ['h1', 'h2'],
    ms: 3.25,
  },
  { t: 'mat/reclaim', agent: V, declared: ['src/a.ts'], changed: ['src/a.ts'] },
  { t: 'run/start', agent: V, step: 's1', action: 'tsc', argv0: 'node' },
  { t: 'run/end', agent: V, step: 's1', exit: 0, ms: 812.5, denied: false },
  { t: 'run/confined', agent: V, mode: 'read-only', enforcement: 'full' },
  { t: 'bound/deny', agent: V, path: '/etc/passwd', space: 'physical', rule: 'ro-bind' },
  { t: 'signal', agent: V, id: 'sig1', kind: 'done', digest: 'd1' },
  {
    t: 'agent/handoff',
    agent: V,
    successor: A('agent/r1/2'),
    contract: 'ct1',
    digest: 'd2',
    body: '交接提示词',
  },
  { t: 'round/state', round: 'r1', from: 'Working', to: 'Collecting' },
  // 轮次开始那一条带着**钉住的那个底**（C7 前半）：放行那一趟要拿同一个底重算同一批契约。
  { t: 'round/intent', round: 'r1', base: C('c0ffee'), digest: 'd3', body: '意图原文' },
  // 草案带轮次号：同一份日志里住着好几轮，重放要选得出是哪一份。
  { t: 'holder/distill', round: 'r1', agent: V, digest: 'd4', body: '凝聚理解' },
  // 放行那一笔（`round go`）：批号 + 这一批发出去的那几份契约。
  { t: 'round/approve', round: 'r1', fingerprint: '0f1e2d3c4b5a6978', contracts: ['ct1'] },
  { t: 'contract/issue', round: 'r1', contract: 'ct1', owner: V, paths: ['src/a.ts'] },
  { t: 'merge/attempt', round: 'r1', branches: [B('agent/r1/1')], conflicts: 1 },
  { t: 'merge/accept', round: 'r1', commit: C('c0ffee'), assertions: [] },
  {
    t: 'prefix/assemble',
    agent: V,
    zoneAHash: 'za',
    zoneBHash: 'zb',
    zoneCHash: 'zc',
  },
]

test('全部事件类型往返：M0 不解释事件，也一个字段都不丢', async () => {
  const root = tmp()
  const log = openLog(root, { sync: 'never' })
  for (const e of SAMPLES) await log.append(V, e)
  const back: LogEvent[] = []
  for await (const e of log.readByWriter(V)) back.push(e)
  assert.equal(back.length, SAMPLES.length)
  assert.deepEqual(back, SAMPLES)
  await log.close()
  rmSync(root, { recursive: true, force: true })
})
