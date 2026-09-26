// 版本链取回：一次读出来的那一份读数。出处：架构 § 15.1.a（`against` 链）· § 9.4（重放口径）·
// PLAN § 5.12 的 C5.a（"同一轮的草案历史留在日志里按坐标取回" · "一次读"）。
//
// 跑法：cd ~/fugue && node --test src/round/versions.test.ts
//
//   ① **一条链**：三次落地（v1 → v2 → v2 重落）→ 链上三格 · `against` 各指上一版 · 第一版没有它 ·
//      "第几版"按**内容**编号（重落同一版不涨号）· 另一轮那一条进不来
//   ② **一次读**：`roundFactsOf` 只读一遍日志，而它一次给全那几样；`roundStateOf` 与 `loggedOf`
//      是它的两个投影——读出来的与原先那两个读者逐字段相同（这才是"合成一次读"不是"换个地方读"）
//   ③ **空账不抛**：这一轮一条都没有 → `Idle` · 没有底 · 空串 · 空链（读得出"还没有"，不是报错）
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentId, CommitId, RoundId, WriterId } from '../terms.ts'
import type { LogReader } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import { loggedOf, roundStateOf } from './dispatch.ts'
import { bodyOf, lastOf, roundFactsOf, versionIndexOf } from './versions.ts'

const R = 'r1' as RoundId
const R2 = 'r2' as RoundId
const BASE = 'beefcafe' as CommitId
/** 持有者那一个身份（`round`）——链上的每一条都记着它。 */
const HOLDER = 'round' as AgentId

/** 正文的指纹：与 `runtime/restart.ts` 的 `digestOf` 同一个口径（sha256 前十六位）。 */
const digestOf = (body: string): string => createHash('sha256').update(body).digest('hex').slice(0, 16)

interface Bench {
  readonly root: string
  readonly log: ReturnType<typeof openLog>
  readonly close: () => Promise<void>
}

/** 一份台子：一个真日志目录（只读那一半被测，所以只开 `round` 那一个写者口）。 */
async function bench(): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-versions-'))
  const log = openLog(root, { write: 'round' as WriterId, sync: 'each' })
  return {
    root,
    log,
    close: async () => {
      await log.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('① 一条链：三格 · against 指回上一版 · 第几版按内容编号（重落不涨号）', async () => {
  const b = await bench()
  try {
    const v1 = '为什么这么拆：两格可以并行。'
    const v2 = '为什么这么拆：三格，第三格等第二格。'
    const d1 = digestOf(v1)
    const d2 = digestOf(v2)
    await b.log.append('round', {
      t: 'round/intent',
      round: R,
      base: BASE,
      digest: d1,
      body: JSON.stringify({ goal: '把解析器拆出来' }),
    })
    await b.log.append('round', { t: 'holder/distill', round: R, agent: HOLDER, digest: d1, body: v1 })
    await b.log.append('round', { t: 'holder/distill', round: R, agent: HOLDER, digest: d2, against: d1, body: v2 })
    // 第三格：**正文与第二版逐字节相同**（"只判不跑"那一趟）——`against` 照旧指向上一版，而号不涨。
    await b.log.append('round', { t: 'holder/distill', round: R, agent: HOLDER, digest: d2, against: d2, body: v2 })
    await b.log.append('round', { t: 'round/state', round: R, from: 'Idle', to: 'Planning' })
    // 另一轮落在同一份日志里：**按轮次号选**，它不该进这一轮的链，也不该改这一轮的处境。
    await b.log.append('round', { t: 'holder/distill', round: R2, agent: HOLDER, digest: digestOf('另外一轮'), body: '另外一轮' })
    await b.log.append('round', { t: 'round/state', round: R2, from: 'Idle', to: 'Working' })

    const f = await roundFactsOf(b.log, R)
    assert.equal(f.round, R)
    assert.equal(f.state, 'Planning', '另一轮的 Working 不该改这一轮的处境')
    assert.equal(f.base, BASE)
    assert.equal(f.goal, '把解析器拆出来')
    assert.deepEqual(
      f.versions.map((v) => v.at),
      [1, 2, 3],
      '链上按落地次序，重落也占一格（那是日志里的事实）',
    )
    assert.deepEqual(
      f.versions.map((v) => v.body),
      [v1, v2, v2],
    )
    assert.equal(f.versions[0]?.against, null, '第一版没有 against')
    assert.equal(f.versions[1]?.against, d1, '第二版记着第一版')
    assert.equal(f.versions[2]?.against, d2, '第三版记着第二版（虽然正文相同）')
    assert.equal(lastOf(f)?.body, v2, '当下那一版是最后一次落地')
    assert.equal(versionIndexOf(f, d1), 1)
    assert.equal(versionIndexOf(f, d2), 2, '重落同一版不涨号：号是内容的号')
    assert.equal(versionIndexOf(f, 'deadbeefdeadbeef'), null, '不在链上的指纹给 null')
    assert.equal(bodyOf(f, d2), v2, '按坐标（digest）取回正文')
    assert.equal(bodyOf(f, d1), v1)
    console.log(
      `① 读数：链上 ${f.versions.length} 格（重落 1）· 第几版 1→${String(versionIndexOf(f, d1))} ` +
        `2→${String(versionIndexOf(f, d2))} · 另一轮那一条没进来 · 处境 ${f.state}`,
    )
  } finally {
    await b.close()
  }
})

test('② 一次读：roundFactsOf 只读一遍日志，那两个投影与它逐字段相同', async () => {
  const b = await bench()
  try {
    const body = '草案正文：一格写 src/parse.ts。'
    const d = digestOf(body)
    await b.log.append('round', {
      t: 'round/intent',
      round: R,
      base: BASE,
      digest: d,
      body: JSON.stringify({ goal: '把解析器拆出来' }),
    })
    await b.log.append('round', { t: 'holder/distill', round: R, agent: HOLDER, digest: d, body })
    await b.log.append('round', { t: 'round/state', round: R, from: 'Idle', to: 'Planning' })

    let calls = 0
    /** 计数版的读侧：`readByWriter` 被调几次就是"读了几遍日志"。 */
    const counting: LogReader = {
      readByWriter: (w, from) => {
        calls += 1
        return b.log.readByWriter(w, from)
      },
    }

    const f = await roundFactsOf(counting, R)
    assert.equal(calls, 1, `这一份该只读一遍日志，实际 ${calls} 遍`)
    // 五样都是从那一遍里出来的：再多读一遍（比如某一样自己又去读了一次）这条就红。
    assert.equal(f.state, 'Planning')
    assert.equal(f.base, BASE)
    assert.equal(f.goal, '把解析器拆出来')
    assert.equal(f.versions.length, 1)
    assert.equal(lastOf(f)?.body, body)
    assert.equal(calls, 1)

    // **两个投影与原来的读者等价**：替换掉的那几处读的是同一份东西，不是"另一份"。
    calls = 0
    assert.equal(await roundStateOf(counting, R), f.state, 'roundStateOf 与 facts.state 不同')
    assert.equal((await loggedOf(counting, R)).draft, lastOf(f)?.body ?? null, 'loggedOf 的草案与链尾不同')
    assert.equal((await loggedOf(counting, R)).base, f.base)
    assert.equal((await loggedOf(counting, R)).goal, f.goal)
    assert.equal(calls, 4, '两处投影各读一遍（它们不是"顺手"读的：每一处调用读一次）')
    console.log(`② 读数：roundFactsOf 读 1 遍给全五样 · roundStateOf + loggedOf（×3 次调用）共 ${calls} 遍，逐字段相同`)
  } finally {
    await b.close()
  }
})

test('③ 空账不抛：这一轮一条都没有 → Idle · 没有底 · 空串 · 空链', async () => {
  const b = await bench()
  try {
    const f = await roundFactsOf(b.log, R)
    assert.equal(f.state, 'Idle', '一条 round/state 都没有 = 这一轮还没落地')
    assert.equal(f.base, null)
    assert.equal(f.goal, '')
    assert.deepEqual([...f.versions], [])
    assert.equal(lastOf(f), null)
    assert.equal(versionIndexOf(f, 'x'), null)
    assert.equal(bodyOf(f, 'x'), null)
    console.log('③ 读数：空账 → Idle · base null · goal 空串 · 链 0 格（读得出"还没有"，不是报错）')
  } finally {
    await b.close()
  }
})
