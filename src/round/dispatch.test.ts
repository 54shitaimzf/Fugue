// 放行那一趟：**门上那一批契约发出去**（`fugue round go`）。出处：架构 § 15.1.a 四步里的"派"与
// "门由人开" · 架构 § 8.13（`Planning ──contracts-issued──> Delegated ──branches-started──> Working`）
// · 架构 § 8.14 的 C7 前半（底是钉住的那一个）· PLAN § 5.10 的 C4 行。
//
// 跑法：cd ~/fugue && node --test src/round/dispatch.test.ts
//
//   ① **放行那一下**：逐条 `contract/issue`（正文与构造出来那一份逐字段相同——契约住日志里）·
//      `round/approve` 恰好一条（批号 + 那几份契约）· `Planning → Delegated` 恰好一条 ·
//      分支定在**钉住的那个底**上 · 处境走到 `Working`；而**不放行之前**这三样一条都没有
//   ② **再跑一次不重复触发**：处境不在门口时当场拒（说得出是哪一步），日志一条不增——
//      不是静默成功，也不发第二条契约
//   ③ **同一个批号的新一批照样重停**（这一条就是口径本身）：第二轮拆出来的那一批与第一轮
//      **同号**（`fingerprintOf` 只算拆分的形状），而它不会照上次放行——照旧停在门口等人再点一
//      次头。负对照：契约的 `id` 带着轮次号（两份不同），所以"同号"这件事不是身份带来的
//   ④ **判不成器一个字节都不落**（草案缺一个键 · 这一轮还没落地两档各自的话）
//   ⑤ **一趟放行读几遍轮次日志**（给了那一份读数就不读）· **⑥ 门口那一批只有一处读法**：界面上
//      那一行队列（不给树那一档）与放行那一趟读的是同一个函数——两处算出来的契约逐字节相同，
//      而换一个身份分配器就当场不同（门只认契约集合，而集合里带着身份）。
//   ⑦ **派发那一趟全程持着 N 把栅栏**（`--materialize`）：口是调用方的（`fenceSet.open`），
//      跑到第 n 格的时候前 n−1 把锁一把都不许少——中途同一把 writer 的 `holdWriter` 拿不进来
//
// 板子与 `round/start.test.ts` 同一套（真 git 仓库 · 真对象库 · 真日志）；不联网。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentId, CommitId, ContractId, RelPath, RoundId, WriterId } from '../terms.ts'
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import type { LogHandle } from '../log/log.ts'
import { createRoots } from '../roots/roots.ts'
import { openTruth } from '../truth/truth.ts'
import { identFor } from '../identity.ts'
import { fingerprintOf } from '../contract/gate.ts'
import { dispatchRound, issueAndStart, pendingOf, roundStateOf } from './dispatch.ts'
import { roundFactsOf } from './versions.ts'
import { compactOf } from './compact.ts'
import { acquireFences } from '../cli/cmd/fences.ts'
import { holdWriter } from '../log/hold.ts'
import { DEFAULT_MATERIALIZE } from '../materialize/contract.ts'

/** 计数版的读侧：`readByWriter` 被调几次就是「读了几遍日志」（其余几栏照旧）。 */
function countingLog(log: LogHandle, counter: { n: number }): LogHandle {
  return {
    ...log,
    readByWriter: (w, from) => {
      counter.n += 1
      return log.readByWriter(w, from)
    },
  }
}

/** 测试自己起 git 时用同一套隔离：用户级配置不该决定测试的读数。 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue',
  GIT_AUTHOR_EMAIL: 'fugue@localhost',
  GIT_COMMITTER_NAME: 'fugue',
  GIT_COMMITTER_EMAIL: 'fugue@localhost',
}

const A = 'src/parse.ts'
const GOAL = '把解析器拆出来'
const ROUND = 'r1' as RoundId
const ROUND2 = 'r2' as RoundId
const ROUND3 = 'r3' as RoundId
/** 第 0 个身份（构造次序里的第一格）——名字与分支一处给（架构 § 14.1 第 1 步）。 */
const AGENT = identFor(ROUND, 0).agent

interface Bench {
  readonly root: string
  readonly log: ReturnType<typeof openLog>
  readonly truth: ReturnType<typeof openTruth>
  readonly base: CommitId
  readonly close: () => Promise<void>
}

/** 一份台子：一个真对象库 · 一个底（轮次要有 HEAD）· 一份种子的内容在底里。 */
async function bench(): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-go-'))
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const truth = openTruth(root)
  const log = openLog(root, { write: 'round' as WriterId, sync: 'each' })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, A), 'export const parse = (s: string): string => s.trim()\n')
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  const made = spawnSync('git', ['commit', '-qm', '底'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(made.status, 0, made.stderr)
  const base = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim() as CommitId
  assert.equal(base.length, 40, `读不出底那个提交：${base}`)
  // **底要推进去**：`baseFor(truth, 'round')` 读的是 `refs/heads/main`（`refFor` 一处给）。
  await truth.advance('refs/heads/main' as never, base, null)
  return {
    root,
    log,
    truth,
    base,
    close: async () => {
      await log.close()
      await truth.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** 一节的草案（键就是契约的键）：给一栏就换一栏，`delete` 一栏就少一栏。 */
function section(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'implement',
    goal: '拆成独立模块',
    ownedPaths: [A],
    deliverables: [{ path: A, form: '模块' }],
    assertions: [{ name: '单元测试全过', action: 'test' }],
    seed: [A],
    ...over,
  }
}

/** 一份草案的正文：一个任务一节（标 `json` 的围栏块），块外是模型自己那句话。 */
function draftText(one: Record<string, unknown> = section()): string {
  return ['## 一 · 解析器', '', '为什么这么拆：一句话。', '', '```json', JSON.stringify(one, null, 2), '```'].join('\n')
}

/** 把这一轮摆在门口：`round/intent`（钉住的底 + 意图）· `Idle → Planning` · `holder/distill`（草案）。 */
async function atGate(b: Bench, round: RoundId, draft: string): Promise<void> {
  await b.log.append('round', { t: 'round/intent', round, base: b.base, digest: 'd'.repeat(16), body: JSON.stringify({ goal: GOAL }) })
  await b.log.append('round', { t: 'round/state', round, from: 'Idle', to: 'Planning' })
  await b.log.append('round', { t: 'holder/distill', round, agent: 'round' as AgentId, digest: 'e'.repeat(16), body: draft })
}

/** 放行那一趟的输入。**与判那一趟同一个分配器**（`round plan` 那一趟用的也是它）。 */
function goDeps(b: Bench, round: RoundId = ROUND, over: Record<string, unknown> = {}) {
  return {
    roots: createRoots(b.root as never),
    truth: b.truth,
    log: b.log,
    round,
    identityFor: (n: number) => identFor(round, n),
    actions: { test: [] as readonly RelPath[] },
    ...over,
  } as Parameters<typeof dispatchRound>[0]
}

/** 日志里全部事件（按写入次序）。 */
async function events(b: Bench): Promise<LogEvent[]> {
  const out: LogEvent[] = []
  for await (const e of b.log.readByWriter('round')) out.push(e)
  return out
}

/** 盘上那几条分支（`for-each-ref`：分支头是 git 那一侧的事实，不是我们记的账）。 */
function branchesOf(root: string): string[] {
  const r = spawnSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.split('\n').filter((l) => l !== '').sort()
}

test('① 停在门口时一个契约都不发；放行那一下逐条发 · 批号一条 · Planning→Delegated 恰好一条', async () => {
  const b = await bench()
  try {
    await atGate(b, ROUND, draftText())

    // **不放行**：判那一趟（`round plan`）之后的样子——门口三样一条都没有。
    const before = await events(b)
    assert.equal(await roundStateOf(b.log, ROUND), 'Planning', '停在门口那一档的处境该是 Planning')
    for (const t of ['round/approve', 'contract/issue']) {
      assert.equal(before.some((e) => e.t === t), false, `还没放行，日志里就有了 ${t}`)
    }
    assert.deepEqual(branchesOf(b.root), ['refs/heads/main', 'refs/heads/master'], '放行之前一条分支都不该起')

    // **放行**。
    const r = await dispatchRound(goDeps(b))
    assert.equal(r.base, b.base, '放行那一趟的底不是钉住的那一个')
    assert.equal(r.built.contracts.length, 1)
    assert.equal(r.built.contracts[0]?.id, 'r1.implement.1')
    assert.equal(r.fingerprint, fingerprintOf(r.built), '批号不是 `fingerprintOf` 算的那个')
    assert.equal(r.seedRead.from, 'tree')
    assert.equal(r.seedRead.loaded, 1, '种子的内容该在钉住的底上取到')
    assert.deepEqual(
      r.trail.map((t) => `${t.from} ──${t.on}──> ${t.to}`),
      ['Planning ──contracts-issued──> Delegated', 'Delegated ──branches-started──> Working'],
      '放行那一趟走过的边与图上对不上',
    )

    const after = await events(b)
    const issues = after.filter((e) => e.t === 'contract/issue')
    assert.equal(issues.length, 1, `contract/issue 有 ${issues.length} 条`)
    const one = issues[0] as Extract<LogEvent, { t: 'contract/issue' }>
    // **契约住日志里**（架构 § 8.12）：事件正文与构造出来那一份逐字段相同。
    assert.deepEqual(JSON.parse(one.body), JSON.parse(JSON.stringify(r.built.contracts[0])), '日志里那一份与发出去的不是同一份')
    assert.equal(one.owner, AGENT)
    assert.deepEqual(one.paths, [A])
    // 放行那一笔：批号与那几份契约一处给。
    const approves = after.filter((e) => e.t === 'round/approve')
    assert.equal(approves.length, 1, `round/approve 有 ${approves.length} 条`)
    const ap = approves[0] as Extract<LogEvent, { t: 'round/approve' }>
    assert.equal(ap.round, ROUND)
    assert.equal(ap.fingerprint, r.fingerprint)
    assert.deepEqual(ap.contracts, ['r1.implement.1'])
    // 那两条边各自恰好一条（不多不少）。
    const states = after.filter((e) => e.t === 'round/state' && e.round === ROUND)
    assert.equal(states.filter((e) => e.from === 'Planning' && e.to === 'Delegated').length, 1)
    assert.equal(states.filter((e) => e.from === 'Delegated' && e.to === 'Working').length, 1)
    // 分支定在**同一个底**上。
    assert.equal(await b.truth.resolve(`refs/heads/${AGENT}` as never), b.base, '分支的底不是钉住的那一个')
    assert.equal(await roundStateOf(b.log, ROUND), 'Working')
    // 这一趟放行的是哪一轮：命令行那一层印的第一个栏就是它（漏了就是 `undefined`）。
    assert.equal(r.round, ROUND, '放行那一趟没把轮次号交回来')
    console.log(
      `① 读数：停着时 contract/issue 0 条 · 放行 ${r.built.contracts.length} 条（${r.built.contracts[0]?.id}）· ` +
        `批号 ${r.fingerprint} · 分支 ${branchesOf(b.root).length - 2} 条定在 ${r.base.slice(0, 7)} · 处境 Working`,
    )
  } finally {
    await b.close()
  }
})

test('② 再跑一次不重复触发：处境不在门口时当场拒，日志一条不增', async () => {
  const b = await bench()
  try {
    await atGate(b, ROUND, draftText())
    await dispatchRound(goDeps(b))
    const after = await events(b)
    await assert.rejects(
      () => dispatchRound(goDeps(b)),
      (err: Error) => {
        assert.match(err.message, /这一轮的处境是 Working/)
        assert.match(err.message, /已经发过了/)
        assert.match(err.message, /放行只在 Planning 那一处走/)
        return true
      },
      '第二次放行没有当场拒',
    )
    assert.equal((await events(b)).length, after.length, '第二次放行落了事件')
    console.log(`② 读数：第二次 round go 当场拒（处境 Working）· 日志仍是 ${after.length} 条（一条不增）`)
  } finally {
    await b.close()
  }
})

test('③ 同一个批号的新一批照样重停：编号不是放行过的凭证', async () => {
  const b = await bench()
  try {
    // 第一轮：同一份草案，放行。
    await atGate(b, ROUND, draftText())
    const one = await dispatchRound(goDeps(b, ROUND))
    // 第二轮：**同一份草案**（换了个轮次号）——拆分的形状一个字没变。
    await atGate(b, ROUND2, draftText())
    assert.equal(await roundStateOf(b.log, ROUND2), 'Planning', '第二轮该停在门口')
    const between = await events(b)
    assert.equal(between.filter((e) => e.round === ROUND2 && e.t === 'contract/issue').length, 0, '第二轮还没放行就发了契约')
    assert.equal(between.filter((e) => e.round === ROUND2 && e.t === 'round/approve').length, 0, '第二轮还没放行就有放行那一笔')

    // 要发它就得**再放行一次**：同号换不来放行。
    const two = await dispatchRound(goDeps(b, ROUND2))
    assert.equal(two.fingerprint, one.fingerprint, '两轮的批号该相同（拆分的形状一样）')
    // **负对照**：契约的 `id` 带着轮次号，两份不同——所以"同号"这件事与身份无关，
    // 它算的只是拆分的形状（`fingerprintOf` 不把 `id`/`agent`/`branch`/`base` 算进去）。
    assert.notEqual(two.built.contracts[0]?.id, one.built.contracts[0]?.id, '两轮的契约 id 该不同')
    assert.equal(one.built.contracts[0]?.id, 'r1.implement.1')
    assert.equal(two.built.contracts[0]?.id, 'r2.implement.1')
    // 两轮各一条放行记录 —— 同号的两批各自被人点过一次头。
    const approves = (await events(b)).filter((e) => e.t === 'round/approve')
    assert.deepEqual(approves.map((e) => (e as Extract<LogEvent, { t: 'round/approve' }>).round), [ROUND, ROUND2])
    console.log(
      `③ 读数：两轮的批号都是 ${one.fingerprint} · 契约 id ${one.built.contracts[0]?.id} 与 ${two.built.contracts[0]?.id} · ` +
        `放行记录 ${approves.length} 条（第二轮照样停在门口等人点头）`,
    )
  } finally {
    await b.close()
  }
})

test('④ 判不成器一个字节都不落；这一轮还没落地那一档也说得出话', async () => {
  const b = await bench()
  try {
    // **还没落地**（日志里没有 `round/intent`）：放行说得出该先干什么。
    await assert.rejects(
      () => dispatchRound(goDeps(b)),
      (err: Error) => {
        assert.match(err.message, /这一轮的处境是 Idle/)
        assert.match(err.message, /先跑 `fugue round plan <目标>`/)
        return true
      },
    )

    // **缺一个键**（第 1 节少了 deliverables）：退回并报出是哪一节哪一个键。
    const bad = section()
    delete bad['deliverables']
    await atGate(b, ROUND, draftText(bad))
    await assert.rejects(
      () => dispatchRound(goDeps(b)),
      (err: Error) => {
        assert.match(err.message, /第 1 节缺一个键：deliverables/)
        assert.match(err.message, /构造器不猜、不补/)
        return true
      },
      '草案缺一个键却放行了',
    )
    const after = await events(b)
    for (const t of ['round/approve', 'contract/issue']) {
      assert.equal(after.some((e) => e.t === t), false, `判不成器却落了 ${t}`)
    }
    assert.equal(await roundStateOf(b.log, ROUND), 'Planning', '判不成器却动了处境')
    assert.deepEqual(branchesOf(b.root), ['refs/heads/main', 'refs/heads/master'], '判不成器却起了分支')
    console.log(`④ 读数：Idle 那一档 → 指出先跑 round plan · 缺键那一档 → 报出「第 1 节缺一个键：deliverables」· 日志与分支一个字节没动`)
  } finally {
    await b.close()
  }
})

test('⑤ 放行那一趟只读一遍轮次日志；给了那一份读数就一遍都不读', async () => {
  const b = await bench()
  try {
    const draft = draftText()
    // 第一轮：**把读数递进去**——这一趟一遍都不该读日志。
    await atGate(b, ROUND, draft)
    const c1 = { n: 0 }
    const facts = await roundFactsOf(b.log, ROUND)
    const r1 = await dispatchRound(goDeps(b, ROUND, { log: countingLog(b.log, c1), facts }))
    assert.equal(c1.n, 0, `给了读数还去读日志：${c1.n} 遍`)
    assert.equal(r1.base, b.base)
    // 第二轮（同一份日志里的另一轮）：**不给读数**——自己读，且只读一遍。
    await atGate(b, ROUND2, draft)
    const c2 = { n: 0 }
    const r2 = await dispatchRound(goDeps(b, ROUND2, { log: countingLog(b.log, c2) }))
    assert.equal(c2.n, 1, `不给读数时该只读一遍轮次日志，实际 ${c2.n} 遍`)
    console.log(`⑤ 读数：一趟放行读 ${c1.n} 遍轮次日志（给了那一份读数）· ${c2.n} 遍（不给）`)
  } finally {
    await b.close()
  }
})

// ── ⑥ 门口那一批只有一处读法（`T6` 的队列行与放行读同一份）──────────────────────────
//
// 门上那一批契约**不是存下来的，是重算出来的**。于是"界面印的那批契约与 `round go` 真发出去的
// 是同一批"这句话，只有两处走同一个函数（`pendingOf`）才成立。这一条量的就是它：同一份日志，从
// 队列行那一档（只读账、不给树）与放行那一档（给树）各算一次，再与 `round go` 真落下的那一批
// 对。负对照是**换一个身份分配器**——门只认契约集合，而集合里带着身份。
test('⑥ 队列行印的那批契约与 `round go` 真发出去的是同一批（逐字节）', async () => {
  const b = await bench()
  try {
    await atGate(b, ROUND, draftText())
    const alloc = (r: RoundId) => (n: number) => identFor(r, n)
    const queue = { log: b.log, round: ROUND, identityFor: alloc(ROUND), actions: { test: [] as readonly RelPath[] } }

    // 一 · **队列行那一档**：只读账，不给树（观察者不开真源）。
    const seen = await pendingOf(queue)
    assert.equal(
      seen.kind,
      'held',
      `门该停着：${seen.kind === 'none' ? seen.why : seen.kind === 'broken' ? seen.problems.join(' · ') : ''}`,
    )
    if (seen.kind !== 'held') return
    assert.ok(seen.pending.built.contracts.length > 0, '这一批该有契约')
    assert.equal(seen.pending.seedRead.from, 'given', '观察者不给树：那一条读数说的是"这一份没量"')
    assert.deepEqual(seen.pending.same, [], '还没放过：与这一批同号的那几轮是空的')

    // 二 · **两档不是两种答案**：同一份日志，把树给上（放行那一档）——契约集合一字不差，只有种子
    //     那一条读数从 `given` 换成 `tree`（"给不给树"影响的是读数，不是这一批是谁）。
    const withTree = await pendingOf({ ...queue, truth: b.truth })
    assert.equal(withTree.kind, 'held')
    if (withTree.kind !== 'held') return
    assert.equal(
      JSON.stringify(withTree.pending.built.contracts),
      JSON.stringify(seen.pending.built.contracts),
      '给不给树算出来的契约不同——那"同一批"这句话就不成立了',
    )
    assert.equal(withTree.pending.seedRead.from, 'tree', '给了树就真在钉住的底上取内容')
    assert.equal(withTree.pending.fingerprint, seen.pending.fingerprint, '批号也该是同一个')

    // 三 · **负对照**：换一个身份分配器（`r2` 那一套）→ 同一份草案算出另一批 agent。界面与放行
    //     必须用同一个分配器，不然"我批的"与"它发的"当场不是一批（而这一步不会报错，只会发错）。
    const wrong = await pendingOf({ ...queue, identityFor: alloc(ROUND2) })
    assert.equal(wrong.kind, 'held')
    if (wrong.kind !== 'held') return
    assert.notDeepEqual(
      wrong.pending.built.contracts.map((c) => c.agent),
      seen.pending.built.contracts.map((c) => c.agent),
      '换一个分配器还是同一批 agent——那这条负对照就抓不住',
    )

    // 四 · **放行那一头**：真发。发出去的那一批就是队列行印的那一批。
    const r = await dispatchRound(goDeps(b))
    const approvals = (await events(b)).filter((e) => e.t === 'round/approve')
    assert.equal(approvals.length, 1, `round/approve 该恰好一条：${approvals.length}`)
    const ids = (approvals[0] as { contracts: readonly ContractId[] }).contracts
    assert.deepEqual(
      seen.pending.built.contracts.map((c) => c.id),
      [...ids],
      '队列行印的那批契约与 `round/approve` 记下的那一批不同',
    )
    assert.equal(
      JSON.stringify(seen.pending.built.contracts),
      JSON.stringify(r.built.contracts),
      '两份契约值的字节不同（id 一样不代表写入面 · 交付物 · 断言 · seed 一样）',
    )
    assert.equal(seen.pending.fingerprint, r.fingerprint, '批号该是同一个（同一个 `fingerprintOf`）')
    assert.equal(seen.pending.base, r.base, '底该是同一个（轮次钉住的那一个）')

    // 五 · 发过之后**门口什么都没有**：队列行那一档说得出"发过了"，而不是照旧画一批已经发出去的。
    const after = await pendingOf(queue)
    assert.equal(after.kind, 'none', '发过之后门口该是空的')
    if (after.kind !== 'none') return
    assert.ok(after.why.includes('已经发过'), `那一句该说清"发过了"：${after.why}`)
    console.log(
      `⑥ 读数：队列行那一批 ${seen.pending.built.contracts.length} 份（批号 ${seen.pending.fingerprint}）· ` +
        `与放行落下的 ${ids.length} 份逐字节相同 · 给树与不给树两份契约一字不差（种子读数 given → tree）· ` +
        `换分配器那份 agent ${wrong.pending.built.contracts.map((c) => c.agent).join(' · ')} 与它不同 · ` +
        '发过之后门口是空的',
    )
  } finally {
    await b.close()
  }
})

// ── ⑦ 派发那一趟不许中途放锁（`--materialize` 那一档）──────────────────────────────────
//
// 判据一句话：**命令还在跑的时候，它拿着的 N 把栅栏一把都不许少**。派发那一趟要 N 个 agent 的口
// （`logForAgent`），而那些口是从调用方那份预取的栅栏里开的（`fenceSet.open`——架构 § 9.11 的
// "要 N 把先拿全再开口"）。**口是调用方的**：这里顺手 `close()` 一次就会连**外置的那把锁**一起
// 放掉（`openLog` 的 `hold`），后面那几个口于是都在没锁的状态下追加——中途进来的第二个写者谁也
// 拦不住。`logForAgent` 按 agent 逐个回调，那正好是"跑到一半"的那个观察点。

/** 两节的草案（两个 agent——这一条断言要"跑完第 1 格再进第 2 格"才观察得到）。 */
function draftTwo(): string {
  const box = (title: string, one: Record<string, unknown>): string =>
    [`## ${title}`, '', '为什么这么拆：一句话。', '', '```json', JSON.stringify(one, null, 2), '```'].join('\n')
  const second = section({
    goal: '第二格：渲染器',
    ownedPaths: ['src/render.ts'],
    deliverables: [{ path: 'src/render.ts', form: '模块' }],
  })
  return `${box('一 · 解析器', section())}\n\n${box('二 · 渲染器', second)}`
}

test('⑦ `--materialize` 那一趟全程持着 N 把栅栏：中途同一把 writer 的 holdWriter 拿不进来', async () => {
  const b = await bench()
  try {
    await atGate(b, ROUND, draftTwo())
    const alloc = (n: number): ReturnType<typeof identFor> => identFor(ROUND, n)
    const verdict = await pendingOf({
      log: b.log,
      round: ROUND,
      identityFor: alloc,
      actions: { test: [] as readonly RelPath[] },
    })
    assert.equal(verdict.kind, 'held', `门该停着：${verdict.kind === 'none' ? verdict.why : verdict.kind}`)
    if (verdict.kind !== 'held') return
    const agents = [...new Set(verdict.pending.built.contracts.map((c) => c.agent as AgentId))]
    assert.equal(agents.length, 2, `这一份夹具要两格，实际 ${agents.length}`)

    const set = acquireFences(b.root, agents as readonly WriterId[], { sync: 'each' })
    const seen: string[] = []
    let forks = 0
    try {
      const issued = await issueAndStart(verdict.pending.built, b.base, 'Planning', {
        roots: createRoots(b.root as never),
        truth: b.truth,
        log: b.log,
        round: ROUND,
        materialize: true,
        // **铺法点成 copy**：这一条量的是"口与锁归谁"，与铺法无关——不点名就按平台探一档，
        // 探到 overlayfs 需要挂载权限（那是铺法自己那一份单的活）。copy 那一档在这台机器上
        // 不挂任何东西，于是同一条断言在没有挂载权限的机器上也跑得动。
        forkOpt: { ...DEFAULT_MATERIALIZE, preferredStrategy: 'copy' },
        logForAgent: (a) => {
          // **这一下就是"跑到一半"**：第 2 格开口的时候，第 1 把栅栏必须还在手上。
          if (seen.length > 0) {
            const first = seen[0] as string
            assert.throws(
              () => holdWriter(b.root, first as WriterId).release(),
              /已经有写者/,
              `跑到第 ${seen.length + 1} 格时，第 ${first} 把栅栏已经被放掉了`,
            )
          }
          seen.push(String(a))
          // **同一个口**：`open` 幂等，池里存的就是这一份（不许留一个已经关掉的口）。
          assert.equal(set.open(a as WriterId), set.open(a as WriterId), '同一个 writer 的口该是同一个')
          return set.open(a as WriterId)
        },
      })
      forks = issued.forks.length
      assert.deepEqual(seen, agents.map(String), '`logForAgent` 的次序与这一批的 agent 对不上')
      assert.equal(forks, 2, `两格该各铺一次，实际 ${forks}`)
    } finally {
      // **收尾恰好放一次**：口先关、锁后放（`fenceSet.closeAll` 那一份的次序）。
      await set.closeAll()
    }
    // 钥匙还回来之后 N 把都拿得回来——"放一次"的另一半：没漏（还扣着），也没多（放了两遍）。
    for (const a of agents) {
      const again = holdWriter(b.root, a as WriterId)
      again.release()
    }
    console.log(
      `⑦ 读数：${agents.length} 格 · 跑到第 2 格开口时第 1 把仍在手上（同 writer 的 holdWriter 被拒）· ` +
        `铺了 ${forks} 次 · 收尾之后 ${agents.length} 把都拿得回来`,
    )
  } finally {
    await b.close()
  }
})

// ── ⑧ 门槛上那一批对上一批：**真内容差**（不是身份差）────────────────────────────────
//
// 判据一句话：C 对 B 报出来的差额是**内容**上的——`id` 里那一段轮次号（身份）不许冒充内容差。
// 三批都走真路：A 放行 · B 放行（同一份草案 → 同号）· C 改一句 `goal` 停在门口，然后拿真账算
// 浓缩件。B 那一批的正文必须先取得回来——取不回来时那一栏会拿空集去算，于是每一件都被报成
// "多了一件"（那是这一版修掉的第二种面孔）。
test('⑧ 跨轮停门：C 对 B 报出真内容差额（id 里的轮次号不冒充内容差）', async () => {
  const b = await bench()
  try {
    await atGate(b, ROUND, draftText())
    await dispatchRound(goDeps(b, ROUND))
    await atGate(b, ROUND2, draftText())
    await dispatchRound(goDeps(b, ROUND2))
    await atGate(b, ROUND3, draftText(section({ goal: '拆成独立模块（第二版）' })))

    const facts = await roundFactsOf(b.log, ROUND3)
    const last = facts.approvals[facts.approvals.length - 1]
    assert.equal(last?.round, ROUND2, '账上最后一条放行该是 B 轮')
    assert.deepEqual(
      last?.contracts.map((c) => c.goal),
      ['拆成独立模块'],
      'B 那一批的正文没取回来（差额会拿空集去算：每一件都成了"多了一件"）',
    )
    assert.deepEqual([...(last?.missing ?? [])], [], '正文在账上，不该报缺证')

    const verdict = await pendingOf({
      log: b.log,
      round: ROUND3,
      identityFor: (n) => identFor(ROUND3, n),
      actions: { test: [] as readonly RelPath[] },
    })
    assert.equal(verdict.kind, 'held', `C 该停在门口：${verdict.kind === 'none' ? verdict.why : verdict.kind}`)
    if (verdict.kind !== 'held') return
    const c = compactOf(verdict.pending, facts)
    assert.equal(c.compare, 'changed', '改了一句 goal 的下一批该是 changed')
    assert.deepEqual(
      [...c.diff],
      ['r3.implement.1\t目标变了：拆成独立模块 → 拆成独立模块（第二版）'],
      `差额不是真内容差：${c.diff.join(' | ')}`,
    )
    assert.equal(
      c.diff.some((d) => d.includes('多了一件') || d.includes('少了')),
      false,
      '轮次号带来的身份差冒充了内容差',
    )
    console.log(`⑧ 读数：C 对 B（${String(last?.round)}）报出 ${c.diff.length} 处真内容差：${c.diff.join(' | ')}`)
  } finally {
    await b.close()
  }
})
