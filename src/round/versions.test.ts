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
//   ④ **逐节差异**（C5.b）：多了哪一节 · 少了哪一节 · 哪一节哪几栏变了；读不成草案就是 `null`
//   ⑤ **人面读数**（C5.b）：第几版 · 第几次落地 · 与上一版差在哪几节（重落那一趟逐字节相同）
//   ⑦ **回退那一档（A→B→A）**：比的是上一趟落地的那一版（第 2 版），不是按内容编号减一（那会指到
//      一个不存在的第 0 版）；`why` 分得清是**哪一版**读不成草案
//   ⑥ **按 `against` 走回第一版**：第 i 条的 `against` 就是第 i-1 条那一版的指纹（重落那一趟指向
//      自己），按它一步步往回走、每一步都取回得了正文——这就是「按坐标取回」今天走的那条路
//   ⑧ **负对照**（0.2.9 ④）：拿一版**不在这条链上**的来印制 → 当场红。原先那一句 `?? v.at`
//      会拿落点号顶内容的号，静默印一个错的"第 N 版"（而那一栏是给人看的）
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
import type { DistillVersion } from './versions.ts'
import { bodyOf, lastOf, roundFactsOf, sectionDiffOf, versionFaceOf, versionIndexOf } from './versions.ts'

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

/** 一节草案（与 `plan.test.ts` 的台子同一形状）：`kind` 加上契约字段表那几栏。 */
function section(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'implement',
    goal: '把解析器拆成独立模块',
    ownedPaths: ['src/parse.ts'],
    deliverables: [{ path: 'src/parse.ts', form: '模块' }],
    assertions: [{ action: 'ok', name: '单元测试全过' }],
    seed: [],
    ...over,
  }
}

/** 一份草案的正文：一段散文 + 逐节的 `json` 围栏块（`contract/draft.ts` 认的形状）。 */
function draftText(sections: readonly Record<string, unknown>[], prose = '为什么这么拆：两格可以并行。'): string {
  return `${prose}\n\n${sections.map((s, i) => `## 第 ${i + 1} 节\n\n\`\`\`json\n${JSON.stringify(s)}\n\`\`\``).join('\n\n')}\n`
}

test('④ 逐节差异：多了哪一节 · 少了哪一节 · 哪一节哪几栏变了（逐字节相同就是空的）', () => {
  const v1 = draftText([section()])
  const v2 = draftText([
    section({ assertions: [{ action: 'ok', name: '单元测试全过' }, { action: 'ok', name: '类型检查过' }] }),
    section({ goal: '把调用方改到新模块上', ownedPaths: ['src/callers'] }),
  ])
  assert.deepEqual(sectionDiffOf(v1, v1), [], '逐字节相同的两版 → 没有差异')
  assert.deepEqual(sectionDiffOf(v1, v2), ['~ 第 1 节：assertions 变了', '+ 第 2 节：把调用方改到新模块上'])
  assert.deepEqual(sectionDiffOf(v2, v1), ['~ 第 1 节：assertions 变了', '- 第 2 节：把调用方改到新模块上'])
  assert.deepEqual(sectionDiffOf(null, v1), ['+ 第 1 节：把解析器拆成独立模块'], '第一版：逐节全是加的')
  assert.deepEqual(sectionDiffOf(v1, draftText([section()], '换了个说法。')), ['~ 开头那段（为什么这么拆）变了'])
  assert.equal(sectionDiffOf(v1, '这一趟说的是话，不是草案。'), null, '这一版读不成草案 → null（不猜）')
  assert.equal(sectionDiffOf('上一版是话', v1), null, '上一版读不成草案 → null')
  assert.equal(sectionDiffOf(v1, draftText([section({ kind: '调查型' })])), null, '坏草案 → null（当场抛被接住了）')
  console.log('④ 读数：逐字节相同 → 0 行 · 改 1 栏 + 加 1 节 → 2 行 · 反过来 → 2 行 · 读不成草案 → null')
})

test('⑤ 人面读数：第几版 · 第几次落地 · 与上一版差在哪几节（重落那一趟逐字节相同）', async () => {
  const b = await bench()
  try {
    const v1 = draftText([section()])
    const v2 = draftText([section({ ownedPaths: ['src/parse.ts', 'src/parse'] })])
    const d1 = digestOf(v1)
    const d2 = digestOf(v2)
    await b.log.append('round', { t: 'holder/distill', round: R, agent: HOLDER, digest: d1, body: v1 })
    await b.log.append('round', { t: 'holder/distill', round: R, agent: HOLDER, digest: d2, against: d1, body: v2 })
    await b.log.append('round', { t: 'holder/distill', round: R, agent: HOLDER, digest: d2, against: d2, body: v2 })
    const f = await roundFactsOf(b.log, R)
    const [first, second, third] = f.versions
    assert.ok(first !== undefined && second !== undefined && third !== undefined)
    const fa = versionFaceOf(f, first)
    assert.equal(fa.version, 1)
    assert.equal(fa.landing, 1)
    assert.equal(fa.same, false)
    assert.deepEqual(fa.lines, ['+ 第 1 节：把解析器拆成独立模块'], '第一版：逐节全是加的')
    assert.equal(fa.why, null)
    assert.equal(fa.againstVersion, null, '第一版没有可比的那一版')
    const fb = versionFaceOf(f, second)
    assert.equal(fb.version, 2, '内容变了 → 第 2 版')
    assert.equal(fb.landing, 2)
    assert.equal(fb.same, false)
    assert.deepEqual(fb.lines, ['~ 第 1 节：ownedPaths 变了'])
    assert.equal(fb.againstVersion, 1, '第 2 版比的是上一趟落地的那一版（第 1 版）')
    const fc = versionFaceOf(f, third)
    assert.equal(fc.version, 2, '重落同一版不涨号')
    assert.equal(fc.landing, 3)
    assert.equal(fc.same, true, '与上一趟逐字节相同')
    assert.deepEqual(fc.lines, [], '逐字节相同就没有差异可印')
    assert.equal(fc.againstVersion, null, '没有印差异就没有"比的是哪一版"')
    // 讨论态那一档：一段话读不成草案 → 印得出"第几版"，而差异那一栏给的是原因。
    await b.log.append('round', { t: 'holder/distill', round: R, agent: HOLDER, digest: digestOf('这是一段话。'), body: '这是一段话。' })
    const f2 = await roundFactsOf(b.log, R)
    const prose = f2.versions[3]
    assert.ok(prose !== undefined)
    const fd = versionFaceOf(f2, prose)
    assert.equal(fd.version, 3, '链上第 3 个不同的内容 → 第 3 版（落地序号是 4，不是它）')
    assert.equal(fd.landing, 4)
    assert.deepEqual(fd.lines, [])
    assert.match(String(fd.why), /不是一份草案/, `why 没说是哪一档：${String(fd.why)}`)
    console.log(
      `⑤ 读数：第 1 版/第 1 次落地 → 加 1 节 · 第 2 版/第 2 次落地 → 1 处 · ` +
        `第 2 版/第 3 次落地 → 与上一趟逐字节相同 · 一段话那一版（第 4 次落地）→ why「${String(fd.why)}」`,
    )
  } finally {
    await b.close()
  }
})

test('⑥ 按 `against` 走回第一版：第 i 条指着第 i-1 条那一版（重落那一趟指着自己）', async () => {
  const b = await bench()
  try {
    const bodies = ['第一版：一段话。', '第二版：改了开头。', '第三版：再加一格。']
    const ds = bodies.map(digestOf)
    for (const [i, body] of bodies.entries()) {
      await b.log.append('round', {
        t: 'holder/distill',
        round: R,
        agent: HOLDER,
        digest: ds[i] as string,
        ...(i === 0 ? {} : { against: ds[i - 1] as string }),
        body,
      })
    }
    // 第四格：**重落第三版**——`against` 指着自己（「上一趟落地」就是它，不是「上一个不同的内容」）。
    await b.log.append('round', {
      t: 'holder/distill',
      round: R,
      agent: HOLDER,
      digest: ds[2] as string,
      against: ds[2] as string,
      body: bodies[2] as string,
    })

    const f = await roundFactsOf(b.log, R)
    assert.equal(f.versions.length, 4)
    assert.equal(f.versions[0]?.against, null, '第一版没有来处')
    assert.equal(f.versions[3]?.against, ds[2], '重落那一趟该指回自己')
    // **口径那一句**：按落地次序一步步往回走，每一步的来处都写在 `against` 那一栏里。
    for (let i = f.versions.length - 1; i > 0; i--) {
      const v = f.versions[i]
      const prev = f.versions[i - 1]
      assert.equal(v?.against, prev?.digest, `第 ${i + 1} 条的 against 指不回第 ${i} 条`)
      assert.equal(bodyOf(f, v?.against ?? ''), prev?.body, `第 ${i + 1} 条的来处取不回正文`)
    }
    console.log(
      `⑥ 读数：链上 ${f.versions.length} 格（重落 1）· 每一条的 against 都是上一条那一版的指纹 · ` +
        `从链尾走 ${f.versions.length - 1} 步回到第一版（${String(ds[0])}）`,
    )
  } finally {
    await b.close()
  }
})

test('⑧ 负对照：一版不在这条链上 → 当场红，不拿落点号顶内容的号', async () => {
  const b = await bench()
  try {
    const a = draftText([section()])
    await b.log.append('round', { t: 'holder/distill', round: R, agent: HOLDER, digest: digestOf(a), body: a })
    const f = await roundFactsOf(b.log, R)
    const on = f.versions[0]
    assert.ok(on !== undefined)
    // 正对照：链上那一版印得出来，号是内容的号。
    assert.equal(versionFaceOf(f, on).version, 1, '链上那一版印不出第 1 版')
    // 负对照：一版不在这条链上的（比如另一轮的那一版）。`at` 是落点号、`version` 是内容的号——
    // 拿落点号顶上就是印一个错的版本号。
    const stray: DistillVersion = { at: 3, digest: 'deadbeefdeadbeef', against: null, body: a }
    assert.throws(
      () => versionFaceOf(f, stray),
      /不在这一轮的链上/,
      '不在链上的那一版没有被当场拒——`?? v.at` 那个兜底还在',
    )
    console.log(`⑧ 读数：链上那一版 → 第 ${versionFaceOf(f, on).version} 版；不在这条链上的一版 → 当场红`)
  } finally {
    await b.close()
  }
})

test('⑦ 回退那一档（A→B→A）：比的是上一趟落地的那一版，不是按内容编号减一', async () => {
  const b = await bench()
  try {
    // A（一节）→ B（改了那一节的 goal 与开头那段）→ A（逐字节回到第一版）。
    const a = draftText([section()])
    const bb = draftText([section({ goal: '把调用方改到新模块上' })], '换了个说法。')
    const d = (t: string): string => digestOf(t)
    await b.log.append('round', { t: 'holder/distill', round: R, agent: HOLDER, digest: d(a), body: a })
    await b.log.append('round', { t: 'holder/distill', round: R, agent: HOLDER, digest: d(bb), against: d(a), body: bb })
    await b.log.append('round', { t: 'holder/distill', round: R, agent: HOLDER, digest: d(a), against: d(bb), body: a })

    const f = await roundFactsOf(b.log, R)
    const back = f.versions[2]
    assert.ok(back !== undefined)
    const face = versionFaceOf(f, back)
    assert.equal(face.version, 1, '内容回到了第一版：号退回 1（这一栏是内容的号）')
    assert.equal(face.landing, 3)
    assert.equal(face.same, false, '与上一趟（B）不是逐字节相同')
    assert.equal(face.againstVersion, 2, '比的是它真正改自的那一版（B = 第 2 版），不是第 0 版')
    assert.deepEqual(
      face.lines,
      ['~ 开头那段（为什么这么拆）变了', '~ 第 1 节：goal 变了'],
      '回退不是「第一版：逐节全是加的」——那是按内容编号减一那一档印出来的假形状',
    )
    assert.equal(face.why, null)

    // 一段话落在草案之后，草案又落在话之后：**上一版**读不成，`why` 该说的是上一版（不是这一版）。
    const prose = '这一趟说的是话，不是草案。'
    await b.log.append('round', { t: 'holder/distill', round: R, agent: HOLDER, digest: d(prose), against: d(a), body: prose })
    await b.log.append('round', { t: 'holder/distill', round: R, agent: HOLDER, digest: d(a), against: d(prose), body: a })
    const f2 = await roundFactsOf(b.log, R)
    const after = f2.versions[4]
    assert.ok(after !== undefined)
    const face2 = versionFaceOf(f2, after)
    assert.equal(face2.version, 1, '这一版的内容又是 A（内容的号照旧是 1）')
    assert.equal(face2.againstVersion, null, '印不出差异就没有"比的是哪一版"')
    assert.match(String(face2.why), /上一趟落的那一版不是一份草案/, `why 没说是哪一版：${String(face2.why)}`)
    assert.ok(!String(face2.why).includes('这一版不是'), `why 把它说成这一版读不成：${String(face2.why)}`)
    console.log(
      `⑦ 读数：回退（A→B→A）→ 第 ${face.version} 版 / 第 ${face.landing} 次落地 · 与第 ${String(face.againstVersion)} 版比 ${face.lines.length} 处` +
        ` · 一段话落在草案之后 → why「${String(face2.why)}」`,
    )
  } finally {
    await b.close()
  }
})
