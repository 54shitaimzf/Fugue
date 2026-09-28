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
//
// 板子与 `round/start.test.ts` 同一套（真 git 仓库 · 真对象库 · 真日志）；不联网。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentId, CommitId, RelPath, RoundId, WriterId } from '../terms.ts'
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import type { LogHandle } from '../log/log.ts'
import { createRoots } from '../roots/roots.ts'
import { openTruth } from '../truth/truth.ts'
import { identFor } from '../identity.ts'
import { fingerprintOf } from '../contract/gate.ts'
import { dispatchRound, roundStateOf } from './dispatch.ts'
import { roundFactsOf } from './versions.ts'

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
