// 按根的**尾部索引**（施工单 § 五 ③）。出处：架构 § 9.11「服务端可以记住派生物」那一段——
// 「一份按 writer 的尾部索引（追加即推进，重建只花时间）。它们的共同性质是**可弃**——重启 ·
// 换一个进程 · 删掉重算，读出来的东西逐字节不变」。
//
// 盯四条，每条都点得出自己的对手：
//
//   ① **一趟扫描、N 个客户端共用**：并发的那些 `pass()`（以及 `advance()`）合并在**同一次在飞的
//      扫描**上——数的是一次扫描走了几遍，不是墙钟（**不断言快慢**，AGENTS § 二）；
//   ② **弃掉重建逐字节相同**：同一个游标，丢之前那条路与从零重建那条路，答出来的字节相同——
//      这是「可弃可重算」的判据；**负对照**是把客户端那一层筛拆掉（`filterOff`）：它当场把
//      「增量那条路」变成「全部行」，判据立刻红；
//   ③ **晚出现的 writer**：第二条 writer 的第一条就是 `seq = 1`，而第一条已经到 5 了——增量
//      推进不会把它整段漏掉（裸 `seq` 的写法会，`probe/watch.ts` 头上那句写的就是这个坑）；
//   ④ **筛在答的那一层，不在收的那一层**：一个客户端带着大于零的游标问过之后，另一个客户端
//      带零游标问，照样拿得到全部——缓存里存的是"读到哪了"，不是"谁读过什么"。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import type { StatusRow } from '../probe/status.ts'
import { tokenOf } from '../probe/watch.ts'
import type { Cursors } from '../probe/watch.ts'
import { createRootTail, posKey, tailStateOf } from './tail.ts'
import type { TailReader } from './tail.ts'
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

/** 第一条 writer 的 5 条（第二条留给需要它的那一条用例自己加）。 */
async function seeded(root: string) {
  const log = openLog(root, { sync: 'never', clock: false })
  for (let i = 1; i <= 5; i++) await log.append(A('agent/r1/1'), ev(i, A('agent/r1/1')))
  return log
}

/** 数「走了几遍全量」的读源：包着真账本，进出都数。**不做时长断言**。 */
function counting(log: ReturnType<typeof openLog>): { reader: TailReader; walks: () => number } {
  let walks = 0
  const reader: TailReader = {
    async *readMerged(fromSeq = 0) {
      walks++
      yield* log.readMerged(fromSeq)
    },
  }
  return { reader, walks: () => walks }
}

/** 一份答案的字节（`writer:seq` 按答案里的次序连起来）——「逐字节相同」量的是它。 */
const bytesOf = (rows: readonly StatusRow[]): string => rows.map((r) => posKey(r.pos)).join(',')

test('① 一趟扫描、N 个客户端共用：并发的那些问合并在同一次在飞的扫描上', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-tail-one-'))
  try {
    const log = await seeded(root)
    const c = counting(log)
    const tail = createRootTail(root, { reader: c.reader })
    // **同一个 tick 上发五条不会等**：`pass()` 与 `advance()` 都并到那一次在飞的扫描上。
    const five = await Promise.all([tail.pass({}), tail.pass({}), tail.advance(), tail.pass({}), tail.advance()])
    assert.equal(c.walks(), 1, `五条并发调用只该走一遍全量，实际 ${c.walks()} 遍`)
    const first = five[0] as readonly StatusRow[]
    assert.equal(first.length, 5, '第一条问拿到 5 条')
    for (const r of five.slice(1)) {
      if (Array.isArray(r)) assert.equal(bytesOf(r), bytesOf(first), '同一次扫描的几条问答案逐字节相同')
    }
    // 账往前动一条：**追加即推进**——再推一趟，只多那一条
    await log.append(A('agent/r1/1'), ev(6, A('agent/r1/1')))
    const solo = await tail.pass({})
    assert.equal(c.walks(), 2, '账动了之后独立的一趟再走一遍（并发的那些才有得合）')
    assert.equal(solo.length, 6, '第二趟多出那一条')
    assert.deepEqual({ ...tail.cursors() }, { 'agent/r1/1': 6 }, '索引推到 6 了')
    const at5 = await tail.pass({ 'agent/r1/1': 5 })
    assert.equal(bytesOf(at5), 'agent/r1/1:6', '按客户端那一份游标筛：只交第 6 条')
    const marks = JSON.stringify(tailStateOf(tail).cursors)
    await tail.dispose()
    await log.close()
    console.log(`① 读数：五条并发调用 → 全量走 1 遍（不是 5 遍）· 追加之后再推一趟 → 第 2 遍 · 索引 ${marks}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('② 弃掉重建逐字节相同：同一个游标，增量那条路与从零重建那条路（负对照：筛拆掉就红）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-tail-rebuild-'))
  try {
    const log = await seeded(root)
    const c = counting(log)
    const from: Cursors = { 'agent/r1/1': 2 }
    // 增量那条路：推一趟、按游标筛
    const incremental = createRootTail(root, { reader: c.reader })
    const a1 = await incremental.pass(from)
    const marks = tokenOf(incremental.cursors())
    // **弃掉再重建**（关的句柄不是它开的——这一份里那只真句柄归用例）：从零走一遍
    await incremental.dispose()
    const rebuilt = createRootTail(root, { reader: c.reader })
    const a2 = await rebuilt.pass(from)
    assert.equal(bytesOf(a1), 'agent/r1/1:3,agent/r1/1:4,agent/r1/1:5', '按排他下界 2 筛：3 · 4 · 5')
    assert.equal(bytesOf(a2), bytesOf(a1), '重建之后同一个游标答出来的字节要逐字节相同')
    assert.equal(tokenOf(rebuilt.cursors()), marks, '走到哪了也要一样')
    assert.equal(tokenOf(incremental.cursors()), '', '弃掉之后索引是空的（可弃）')
    // **负对照**：把客户端那一层筛拆掉——「增量那条路」当场变成「全部行」，② 的判据立刻红。
    const unfiltered = createRootTail(root, { reader: c.reader, filterOff: true })
    const bad = await unfiltered.pass(from)
    assert.notEqual(bytesOf(bad), bytesOf(a1), '不按游标筛那一档与增量那条路必须不同（否则判据是空的）')
    assert.throws(() => assert.equal(bytesOf(bad), bytesOf(a1)), '筛一旦拆掉，这条判据必须红')
    await rebuilt.dispose()
    await unfiltered.dispose()
    await log.close()
    console.log(
      `② 读数：游标 ${tokenOf(from)} → 增量 ${bytesOf(a1)} · 重建 ${bytesOf(a2)}（逐字节相同）· ` +
        `筛拆掉那一档 ${bytesOf(bad)}（不同——判据抓得住）`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('③ 晚出现的 writer：第二条的第一条就是 seq = 1，增量推进不会把它整段漏掉', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-tail-late-'))
  try {
    const log = await seeded(root)
    const tail = createRootTail(root, { reader: log })
    const first = await tail.pass({})
    assert.equal(first.length, 5)
    for (let i = 1; i <= 3; i++) await log.append(A('agent/r1/2'), ev(i, A('agent/r1/2')))
    const resumed = await tail.pass(tail.cursors())
    assert.deepEqual(
      resumed.map((r) => posKey(r.pos)),
      ['agent/r1/2:1', 'agent/r1/2:2', 'agent/r1/2:3'],
      '晚出现的 writer 要从它的第一条起全给出来',
    )
    await tail.dispose()
    await log.close()
    console.log(`③ 读数：先读 ${first.length} 条 · 晚出现的 writer 接着读 ${resumed.length} 条（1 · 2 · 3 一条不漏）`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('④ 筛在答的那一层：一端读到 5 之后，另一端带零游标问照样拿得到全部', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-tail-scope-'))
  try {
    const log = await seeded(root)
    const tail = createRootTail(root, { reader: log })
    const one = await tail.pass({})
    const two = await tail.pass({ 'agent/r1/1': 5 })
    assert.equal(one.length, 5)
    assert.equal(two.length, 0, '带 5 的那一端没有新东西')
    const all = await tail.pass({})
    assert.equal(bytesOf(all), bytesOf(one), '另一端从零问，答案与第一次相同（缓存记的是"读到哪了"）')
    await tail.dispose()
    await log.close()
    console.log(`④ 读数：先问 ${one.length} 条 · 带游标 5 的那一端 ${two.length} 条 · 再带零游标 ${all.length} 条（同一份）`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('⑤ 命令面：同一条 `watch --json` 两条路逐字节相同（CLI 自己不共享，也不受影响）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-tail-cli-'))
  try {
    const log = await seeded(root)
    await log.close()
    const cli = (args: readonly string[]): string => {
      const r = spawnSync(process.execPath, [CLI, '--root', root, '--json', ...args], { encoding: 'utf8' })
      assert.equal(r.status, 0, String(r.stderr))
      return String(r.stdout)
    }
    const one = cli(['watch'])
    const two = cli(['watch'])
    assert.equal(two, one, '同一条命令两条路的字节相同')
    const resumed = cli(['watch', '--resume', 'agent/r1/1:3'])
    assert.equal(resumed.split('\n').filter((l) => l !== '').length, 2, '按游标筛之后只剩两条')
    console.log(
      `⑤ 读数：全量 ${one.split('\n').filter((l) => l !== '').length} 行（两条路逐字节相同）· --resume 之后 2 行`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
