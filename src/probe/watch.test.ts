// **续读游标串**（可读性五件之一）。出处：ROADMAP § 5 的 serve 协议那一行（`watch --follow` 退出印
// writer→seq 游标 · `--resume` 接着读——**「按 writer 分游标」那个坑从读文档变成拿 token**）·
// 架构 § 9.11 的事件通道（游标是每个 writer 一个，语义是排他下界；游标串要能被外部构造）。
//
// 判据只有一条：**续读读出的事件集与一次读全不多不少**——漏一个红，重一个也红。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import type { StatusRow } from './status.ts'
import { cursorsOf, readNew, tokenOf } from './watch.ts'
import type { Cursors } from './watch.ts'
import type { AgentId } from '../terms.ts'

const REPO = join(import.meta.dirname, '..', '..')
const CLI = join(REPO, 'src', 'cli', 'fugue.ts')
const A = (s: string): AgentId => s as AgentId
const ev = (i: number, agent: AgentId): LogEvent => ({
  t: 'view/write',
  agent,
  path: `src/f${i}.ts`,
  rev: i,
  blob: `b${i}`,
  mode: 420,
})
const keys = (rows: readonly StatusRow[]): string[] => rows.map((r) => `${r.pos.writer}:${r.pos.seq}`).sort()

/**
 * 判据本身：把"先读的那一份"与"接着读的那一份"并起来，必须**正好**是全量那一份。
 * 漏一个（并集短）或重一个（并集长）都不等——两条负对照打的就是这里。
 */
function sameEvents(parts: readonly (readonly StatusRow[])[], all: readonly StatusRow[]): void {
  assert.deepEqual(keys(parts.flat()), keys(all))
}

async function twoWriters(root: string): Promise<ReturnType<typeof openLog>> {
  const log = openLog(root, { sync: 'never', clock: false })
  for (let i = 1; i <= 5; i++) await log.append(A('agent/r1/1'), ev(i, A('agent/r1/1')))
  return log
}

test('游标串 ⇄ Cursors：印出来再吃回去一个不差；读不动的游标串给一句话，不猜', () => {
  const cursors: Cursors = { round: 3, 'agent/r1/2': 7, 'agent/r1/1': 12 }
  const token = tokenOf(cursors)
  assert.equal(token, 'agent/r1/1:12,agent/r1/2:7,round:3', '游标串要按 writer 排序——顺序不稳就不是可构造的')
  assert.deepEqual(cursorsOf(token), cursors)
  assert.deepEqual(cursorsOf(''), {})
  // 读不动的三种：没有冒号 · 序号不是数 · 序号是负的。
  for (const bad of ['nope', 'round:x', 'round:-1']) {
    assert.equal(typeof cursorsOf(bad), 'string', `该报读不动：${bad}`)
  }
})

test('续读游标串：接着读读出的事件集与一次读全不多不少（晚出现的 writer 那条坑在里面）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-resume-'))
  try {
    const log = await twoWriters(root)
    const first = await readNew(log, {})
    assert.equal(first.rows.length, 5)
    const token = tokenOf(first.cursors)
    // **第二个 writer 是晚出现的**：它的第一条就是 `seq = 1`，而 `agent/r1/1` 已经到 5 了——
    // 「按裸 seq 接着读」会把它整段永久漏掉；按 writer 分的游标串不会。
    for (let i = 1; i <= 3; i++) await log.append(A('agent/r1/2'), ev(i, A('agent/r1/2')))
    const resumed = await readNew(log, cursorsOf(token) as Cursors)
    assert.deepEqual(keys(resumed.rows), ['agent/r1/2:1', 'agent/r1/2:2', 'agent/r1/2:3'])
    const all = await readNew(log, {})
    sameEvents([first.rows, resumed.rows], all.rows)
    console.log(
      `读数：全量 ${all.rows.length} 条 · 先读 ${first.rows.length} 条 · 接着读 ${resumed.rows.length} 条 · ` +
        `游标串 ${token}`,
    )
    await log.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('续读游标串 负对照：漏一个 writer → 并集多出来；游标给小了 → 同一条读两遍（两条都被判据抓住）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-resume-neg-'))
  try {
    const log = await twoWriters(root)
    for (let i = 1; i <= 3; i++) await log.append(A('agent/r1/2'), ev(i, A('agent/r1/2')))
    const all = await readNew(log, {})
    const full = cursorsOf(tokenOf(all.cursors)) as Record<string, number>

    // 一 · **漏**：游标串里少了 `agent/r1/2` 那一格 → 它那几条会被当成新行再读一遍。
    const dropped: Record<string, number> = { ...full }
    delete dropped['agent/r1/2']
    const missed = await readNew(log, dropped)
    assert.throws(
      () => sameEvents([missed.rows], all.rows),
      '漏掉一个 writer 却判成"不多不少"——那这条判据是空的',
    )

    // 二 · **重**：把 `agent/r1/1` 的游标调小 → 那几条读第二遍。
    const behind = await readNew(log, { ...full, 'agent/r1/1': 2 })
    assert.throws(() => sameEvents([behind.rows], all.rows), '游标调小却判成"不多不少"')
    console.log(
      `负对照读数：漏 writer → 并集 ${keys(missed.rows).length} 条 · 游标调小 → ${keys(behind.rows).length} 条 · ` +
        `全量 ${keys(all.rows).length} 条——两条都不等于全量`,
    )
    await log.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('命令面：`watch --resume <游标串>` 接得上（游标串由外部构造，原样吃回去）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-resume-cli-'))
  try {
    const log = await twoWriters(root)
    for (let i = 1; i <= 3; i++) await log.append(A('agent/r1/2'), ev(i, A('agent/r1/2')))
    await log.close()
    const cli = (args: readonly string[]): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, [CLI, '--root', root, '--json', ...args], { encoding: 'utf8' })
    const all = cli(['watch'])
    assert.equal(all.status, 0, String(all.stderr))
    const rows = String(all.stdout).trim().split('\n')
    assert.equal(rows.length, 8, '两半该是 8 条（5 + 3）')

    // 游标串：`agent/r1/1` 读到 5、`agent/r1/2` 读到 1——外部自己构造的（不是从 `--follow` 抄的）。
    const resumed = cli(['watch', '--resume', 'agent/r1/1:5,agent/r1/2:1'])
    assert.equal(resumed.status, 0, String(resumed.stderr))
    const rest = String(resumed.stdout).trim().split('\n')
    assert.equal(rest.length, 2, `该只剩 agent/r1/2 的后两条：${rest.join(' | ')}`)
    assert.deepEqual(
      rest.map((l) => (JSON.parse(l) as { pos: { writer: string; seq: number } }).pos),
      [
        { writer: 'agent/r1/2', seq: 2 },
        { writer: 'agent/r1/2', seq: 3 },
      ],
    )
    // 读不动的游标串是用法错（退 2），不是"从零读"。
    const bad = cli(['watch', '--resume', 'nope'])
    assert.equal(bad.status, 2, String(bad.stderr))
    console.log(`读数：全量 ${rows.length} 行 · --resume agent/r1/1:5,agent/r1/2:1 之后 ${rest.length} 行 · 坏游标串退 2`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
