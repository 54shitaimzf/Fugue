// 种子那一份的量：**在这一轮钉住的底上取一次内容**。出处：架构 § 8.12（`seed` 的两条准则 ·
// 上界是"总量（token 估账）"· 超限拒绝派发）· PLAN § 5.10 的 C1 断言④。
//
// 跑法：cd ~/fugue && node --test src/round/start.test.ts
//
//   ① **内容进得来**：`seedRulerOf` 在真 git 仓库的底上取到两份内容 → 账比"只量清单"大，且
//      恰好等于"清单 + 内容"那一段过尺的读数
//   ② **退化档**：树上一条都读不出来（`null`）→ 账掉回清单那一侧，不抛 · 不虚报（地板不降）
//   ③ **派发那一趟接上了**：`startRound` 不递 `seedTokens` 时，契约里那一份种子的账是按内容
//      量的数，读数里带"取到几份 · 哪几条树上没有"
//   ④ **缺的那一条只算它自己那一行**：清单里混一条只落在盘上、没进底的文件 → 那一份的账 =
//      清单 + 取得到的那两份内容，而 `missing` 点名了它
//
// 板子与 `round/driver.test.ts` 同一套（真 git 仓库 · 真对象库 · 真日志）；不联网。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import type { AgentId, BranchId, CommitId, RelPath, RoundId, WriterId } from '../terms.ts'
import { createRoots } from '../roots/roots.ts'
import { openLog } from '../log/log.ts'
import { openTruth } from '../truth/truth.ts'
import { estimateTokensOfText } from '../runtime/budget.ts'
import type { SplitAssignment } from '../contract/build.ts'
import { SEED_BUDGET, seedTextOf, seedTokensOf } from '../contract/build.ts'
import { identFor } from '../identity.ts'
import { seedRulerOf } from './seed.ts'
import { startRound } from './start.ts'

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
const B = 'docs/说明.md'
const CONTENT_A = 'export const parse = (s: string): string => s.trim()\n'
const CONTENT_B = '# 说明\n\n这一份是给模型读的中文文档，量它的是同一把尺。\n'
const SEED: readonly RelPath[] = [A, B]
/** **只落在盘上、没进底那个提交**的那一条（`readAt(base, ·)` 对它给 `null`）。 */
const LATER = 'src/later.ts'

const ROUND = 'r1' as RoundId
/** 第 0 个身份（构造次序里的第一格）——名字与分支一处给（架构 § 14.1 第 1 步）。 */
const AGENT = identFor(ROUND, 0).agent

interface Bench {
  readonly root: string
  readonly log: ReturnType<typeof openLog>
  readonly truth: ReturnType<typeof openTruth>
  readonly base: CommitId
  readonly close: () => Promise<void>
}

/** 一份台子：一个真对象库 · 一个底（轮次要有 HEAD）· 两份种子的内容在底里。 */
async function bench(): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-seed-'))
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const truth = openTruth(root)
  const log = openLog(root, { write: 'round' as WriterId, sync: 'each' })
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, A), CONTENT_A)
  writeFileSync(join(root, B), CONTENT_B)
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  const made = spawnSync('git', ['commit', '-qm', '底'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(made.status, 0, made.stderr)
  const base = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim() as CommitId
  assert.equal(base.length, 40, `读不出底那个提交：${base}`)
  // **底要推进去**：`baseFor(truth, 'round')` 读的是 `refs/heads/main`（`refFor` 一处给），
  // 而轮次的底就是它——工作树上有一个提交不等于那条 ref 存在。
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

/** 一整份种子那段正文过尺的读数：清单一行 + 取到的每一份内容各占一段。 */
const tokensOfSeedAnd = (...contents: readonly string[]): number => estimateTokensOfText([seedTextOf(SEED), ...contents].join('\n'))

const SPLIT: SplitAssignment[] = [
  {
    goal: '把解析器拆成独立模块',
    ownedPaths: [A],
    deliverables: [{ path: A, form: '模块' }],
    assertions: [{ action: 'test' as never, name: '单元测试全过' }],
  },
]

/** 派发那一趟的输入。种子与量法都由这一份给——`startRound` 的缺省量法就是被测的那一处。 */
function startDeps(b: Bench, seed: readonly RelPath[], over: Record<string, unknown> = {}) {
  return {
    roots: createRoots(b.root as never),
    truth: b.truth,
    log: b.log,
    round: ROUND,
    intent: { goal: '把解析器拆出来' },
    split: SPLIT,
    // **身份按构造次序问**（一处给）：这一批只有一份实现型，所以第 0 格就是 `AGENT`。
    identityFor: (n: number) => identFor(ROUND, n),
    seeds: [seed],
    ...over,
  } as Parameters<typeof startRound>[0]
}

test('① 内容进得来：账是"清单 + 在底上取到的那两份内容"，比只量清单大', async () => {
  const b = await bench()
  try {
    const ruler = seedRulerOf((p) => b.truth.readAt(b.base, p))
    await ruler.load(SEED)
    const pointers = seedTokensOf(SEED)
    const got = ruler.tokensOf(SEED)
    assert.equal(got, tokensOfSeedAnd(CONTENT_A, CONTENT_B), '账不是那份正文过尺的读数')
    assert.ok(got > pointers, `内容没进量：${got} 与只量清单的 ${pointers}`)
    assert.equal(ruler.reading.loaded, 2, '两份内容该都取到')
    assert.deepEqual(ruler.reading.missing, [], '底里那两条不该报"树上没有"')
    console.log(`① 读数：只量清单 ${pointers} token → 清单 + 内容 ${got} token（${A} + ${B}）`)
  } finally {
    await b.close()
  }
})

test('② 退化档：树上一条都读不出来时，账掉回清单那一侧（不抛 · 不虚报）', async () => {
  const b = await bench()
  try {
    const ruler = seedRulerOf(async () => null)
    await ruler.load(SEED)
    assert.equal(ruler.tokensOf(SEED), seedTokensOf(SEED), '读不出内容时给的该是清单那一侧')
    assert.deepEqual(ruler.reading.missing, [A, B], '两条都该报"这一棵树上没有"')
    assert.equal(ruler.reading.loaded, 0)
    console.log(`② 读数：读不出内容 → 账 ${ruler.tokensOf(SEED)} token（= 只量清单那一侧）· 树上没有 2 条`)
  } finally {
    await b.close()
  }
})

test('③ 派发那一趟接上了：不递量法时，契约里那份种子的账是按内容量的数', async () => {
  const b = await bench()
  try {
    const started = await startRound(startDeps(b, SEED))
    const got = started.built.seedTokens[0]
    assert.equal(got, tokensOfSeedAnd(CONTENT_A, CONTENT_B), '派发那一趟量的不是内容')
    assert.ok((got ?? 0) > seedTokensOf(SEED), '与"只量清单"分不开——那一档等于没量')
    assert.equal(started.seedRead.from, 'tree')
    assert.equal(started.seedRead.loaded, 2)
    assert.deepEqual(started.seedRead.missing, [])
    // 上限那条式子是架构 § 8.12 的：模型上限 − Zone A − 交接余量。**逐项写出来核**，
    // 不写死一个数——那三个数各自会动，而这条关系不该动。
    assert.equal(
      started.built.seedLimit,
      SEED_BUDGET.modelLimit - SEED_BUDGET.zoneA - SEED_BUDGET.handoffMargin,
      '上限不是那条式子给的',
    )
    console.log(
      `③ 读数：契约 ${started.built.contracts[0]?.id} 的种子 ${got} token` +
        `（只量清单是 ${seedTokensOf(SEED)}）· 上限 ${started.built.seedLimit} · 取到 2 份内容`,
    )
  } finally {
    await b.close()
  }
})

test('⑤ 超限拒绝派发：闸是按内容量的那一份判的，不是按清单判的', async () => {
  const b = await bench()
  try {
    // 上限卡在**清单量与内容量之间**：只量清单那一侧看得过去，取过内容就顶穿了。
    const pointers = seedTokensOf(SEED)
    const withContent = tokensOfSeedAnd(CONTENT_A, CONTENT_B)
    const limit = pointers + 10
    await assert.rejects(
      () => startRound(startDeps(b, SEED, { seedLimit: limit })),
      (err: Error) => {
        assert.match(err.message, /种子超限：\d+ token > 上限 \d+ token/, `报的不是种子超限：${err.message}`)
        assert.match(err.message, new RegExp(`种子超限：${withContent} token > 上限 ${limit} token`), '那两个数不是按内容量的那一份')
        assert.match(err.message, /超限要拒绝派发，不是裁剪后照发/)
        return true
      },
      '种子顶穿了上限却照发',
    )
    // **负对照**：同一个上限，量法换成"只量清单"（这一份之前的全部行为）→ 它看得过去。
    // 两半合起来说明这一条闸判的是内容那一份，而不是清单长短。
    const started = await startRound(startDeps(b, SEED, { seedLimit: limit, seedTokens: seedTokensOf }))
    assert.equal(started.seedRead.from, 'given', '递了量法就该报"这一份没量"')
    assert.equal(started.built.seedTokens[0], pointers)
    console.log(`⑤ 读数：上限 ${limit} token（清单 ${pointers} / 内容 ${withContent}）→ 按内容量当场拒（${withContent} > ${limit}）；递"只量清单"那一份则放行`)
  } finally {
    await b.close()
  }
})

test('④ 清单里混一条不在底上的：它只算自己那一行，而 missing 点名了它', async () => {
  const b = await bench()
  try {
    writeFileSync(join(b.root, LATER), '（只落在盘上）\n')
    const seed: readonly RelPath[] = [...SEED, LATER]
    const started = await startRound(startDeps(b, seed))
    const got = started.built.seedTokens[0]
    assert.equal(got, estimateTokensOfText([seedTextOf(seed), CONTENT_A, CONTENT_B].join('\n')), '缺的那一条不该把账带偏')
    assert.deepEqual(started.seedRead.missing, [LATER], '该点名那一条不在底上的')
    assert.equal(started.seedRead.loaded, 2)
    console.log(`④ 读数：三条种子里 ${started.seedRead.loaded} 条取到内容 · missing=${started.seedRead.missing.join(' · ')} · 账 ${got} token`)
  } finally {
    await b.close()
  }
})
