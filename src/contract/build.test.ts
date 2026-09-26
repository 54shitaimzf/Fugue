// A1 的断言（PLAN § 5.7 的 A1 行 · 架构 § 8.12「契约是不可变值；可变的是构造它的过程」·
// 第 3 级跨字段关系 · `seed` 那两条准则与"超限拒绝派发"）· 架构 § 14.1 的分配器。
//
//   ① **一份轮级意图构造得出三份契约，`id` 三份互异且不跨轮复用**（D9）：三份的
//      `id`/`agent`/`branch` 六个值两两不同；换一个轮次号重造一遍，三份 `id` 全换
//      ——负对照：把轮次号从 id 里去掉，跨轮不复用那一条当场红
//   ② **跨字段那条当场报出**：`actionOutputs` 里一条不在 `ownedPaths` 内 → 构造失败并指出
//      是哪一条，**事前**而不是动作跑到一半才被拒——负对照：把那条检查短路 → ② 变红
//   ③ **`seed` 超限 → 拒绝派发，不裁剪后照发**：话里带两个数（拿到多少 · 上限多少），
//      且整批一份都不落地（半批契约派出去，那一轮的分母就残了）
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BranchId, CommitId, RelPath, RoundId } from '../terms.ts'
import type { Intent, SplitAssignment } from './build.ts'
import { BuildError, SEED_BUDGET, build, evidenceFor, seedTokensOf } from './build.ts'
import { actionOutputsOutside, checkContract, seedLimitOf } from './types.ts'
import type { Assertion, Contract } from './types.ts'

const ROUND = 'r1' as RoundId
const BASE = 'beefcafe' as CommitId

const TEST_ASSERTION: Assertion = { action: 'test', name: '单元测试全过', expect: 0 }

const INTENT: Intent = {
  goal: '把解析器拆出来，并查清楚调用方有几处',
  question: 'src/parse.ts 被谁引用？',
  evidenceRequired: [{ note: 'callers' }],
}

const SPLIT: readonly SplitAssignment[] = [
  {
    goal: '把解析器拆成独立模块',
    ownedPaths: ['src/parse.ts', 'src/parse'],
    deliverables: [{ path: 'src/parse.ts', form: '模块' }],
    assertions: [TEST_ASSERTION],
  },
  {
    goal: '把调用方改到新模块上',
    ownedPaths: ['src/callers'],
    assertions: [TEST_ASSERTION],
  },
]

/** 身份分配器：`<轮次>/<n>`——架构 § 4 那张 ref 表里的写法。 */
function identities(round: string, n: number): { agent: string; branch: BranchId } {
  return { agent: `${round}/${n + 1}`, branch: `agent/${round}/${n + 1}` as BranchId }
}

function deps(over: Partial<Parameters<typeof build>[1]> = {}) {
  return {
    round: ROUND,
    base: BASE,
    identityFor: (n: number) => identities('r1', n),
    split: SPLIT,
    seedOf: () => ['src/parse.ts', 'src/callers/x.ts'] as readonly RelPath[],
    // 缺省一份产出都不声明：那样这一批只考"能不能造出来"。要考 `⊆` 那一条的地方各自覆盖。
    actionOutputsOf: () => ({}),
    ...over,
  }
}

/** 按变体取一份，取不到就当场报出——断言里少一层分支。 */
function pick(contracts: readonly Contract[], kind: Contract['kind']): Contract {
  const hit = contracts.find((c) => c.kind === kind)
  if (hit === undefined) throw new Error(`这一批里没有 ${kind}：${contracts.map((c) => c.kind).join(' · ')}`)
  return hit
}

test('① 一份意图造出三份契约，id 三份互异且不跨轮复用', () => {
  const built = build(INTENT, deps({ conflicts: { base: BASE, conflictPaths: ['src/parse.ts'], assertions: [TEST_ASSERTION] } }))

  assert.deepEqual(built.counts, { implement: 2, investigate: 1, resolve: 1 }, '三种变体各该几份')
  assert.equal(built.contracts.length, 4)
  assert.deepEqual(
    built.contracts.map((c) => c.id),
    ['r1.investigate.1', 'r1.implement.1', 'r1.implement.2', 'r1.resolve.1'],
    'id 的形状是 <轮次>.<变体>.<序号>，逐变体从 1 起',
  )

  // 六个值两两不同：id 三份互异，身份也逐份不同。
  const ids = built.contracts.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, 'id 有重的')
  const who = built.contracts.map((c) => `${c.agent}|${c.branch}`)
  assert.equal(new Set(who).size, who.length, '两个契约分到了同一个身份')

  // 逐份的身份就是分配器给的那一份（构造器不认识它是怎么发出来的）。
  built.contracts.forEach((c, i) => {
    assert.deepEqual({ agent: c.agent, branch: c.branch }, identities('r1', i), `第 ${i + 1} 份的身份不是分配器给的那一份`)
  })

  // 调查型的产物目录按位置定名：逐 agent 不同、逐 agent 稳定，且不与任何契约相交。
  const inv = pick(built.contracts, 'investigate')
  assert.deepEqual(inv.ownedPaths, undefined, 'investigate 不该有写入集')
  assert.deepEqual(
    (inv as { evidenceRequired: readonly { artifact: string }[] }).evidenceRequired.map((e) => e.artifact),
    ['evidence/r1/1/callers'],
  )
  for (const c of built.contracts) {
    if (c.kind === 'investigate') continue
    const paths = c.kind === 'implement' ? c.ownedPaths : c.conflictPaths
    for (const p of paths) {
      assert.equal(p === 'evidence' || p.startsWith('evidence/'), false, `写入集里出现了构造器留给调查型的位置：${p}`)
    }
  }

  // **不跨轮复用**（D9）：换个轮次号重造一遍，三份 id 全换。
  const again = build(INTENT, deps({ round: 'r2' as RoundId, identityFor: (n: number) => identities('r2', n) }))
  assert.deepEqual(
    again.contracts.map((c) => c.id),
    ['r2.investigate.1', 'r2.implement.1', 'r2.implement.2'],
  )
  const overlap = again.contracts.map((c) => c.id).filter((id) => ids.includes(id))
  assert.deepEqual(overlap, [], '两个轮次之间重用了 id')

  // 负对照：把轮次号从 id 里去掉（模拟"序号全局单调就够了"那种写法），跨轮不复用当场红。
  const roundless = (kind: string, n: number): string => `${kind}.${n}`
  const collide = again.contracts.map((c) => roundless(c.kind, Number(c.id.split('.').pop())))
  assert.ok(
    collide.some((id) => ids.some((old) => roundless(old.split('.')[1], Number(old.split('.').pop())) === id)),
    '去掉轮次号之后两轮居然不撞——那说明这条负对照测不出东西',
  )
})

test('② actionOutputs 里一条不在 ownedPaths 内 → 构造失败并指出是哪一条', () => {
  const built = build(INTENT, deps())
  assert.deepEqual(built.counts, { implement: 2, investigate: 1, resolve: 0 })
  assert.deepEqual(checkContract(pick(built.contracts, 'implement'), { seedTokens: seedTokensOf }), [])
  // 声明得对的那一份：产出落在写入集里，清单一声不响。
  const declared = build(
    INTENT,
    deps({
      split: [SPLIT[0]],
      actionOutputsOf: () => ({ test: ['src/parse'] }),
    }),
  )
  assert.deepEqual(checkContract(pick(declared.contracts, 'implement'), { seedTokens: seedTokensOf }), [])

  // 越界的那一条：动作 `build` 的产出 `dist` 不在 `src/parse*` 里。
  assert.throws(
    () => build(INTENT, deps({ actionOutputsOf: () => ({ test: ['src/parse'], build: ['dist'] }) })),
    (err: unknown) => {
      assert.ok(err instanceof BuildError, `要的是 BuildError，拿到 ${String(err)}`)
      assert.match((err as Error).message, /actionOutputs/)
      assert.match((err as Error).message, /build/)
      assert.match((err as Error).message, /dist/)
      return true
    },
  )

  // 前缀那一侧的边界：`src/parse` 覆盖 `src/parse/x.ts`，不覆盖 `src/parser.ts`。
  // 前缀那一侧的边界：`src/parse` 覆盖 `src/parse/x.ts`。逐份给各自的产出——
  // 同一份产出套在每一份契约上，那是把"产出 ⊆ 这一份的写入集"这条判据用错了地方。
  assert.deepEqual(
    build(
      INTENT,
      deps({
        actionOutputsOf: (n: number) => (n === 1 ? { t: ['src/parse/x.ts'] } : {}),
      }),
    ).counts,
    { implement: 2, investigate: 1, resolve: 0 },
  )
  assert.throws(
    () => build(INTENT, deps({ actionOutputsOf: (n: number) => (n === 1 ? { t: ['src/parser.ts'] } : {}) })),
    BuildError,
  )

  // **红负对照**：把那条检查短路（判据改成"什么都算在内"），② 当场变红——
  // 说明"事前报出"这件事是那条检查在做，不是别的东西顺手拦下的。
  const shortCircuited = (owned: readonly RelPath[], outputs: Readonly<Record<string, readonly RelPath[]>>): string[] => {
    void owned
    void outputs
    return []
  }
  const c: Contract = { ...pick(built.contracts, 'implement'), actionOutputs: { build: ['dist'] } }
  assert.equal(actionOutputsOutside(c.kind === 'implement' ? c.ownedPaths : [], c.kind === 'implement' ? c.actionOutputs : {}).length, 1)
  assert.deepEqual(
    shortCircuited(c.kind === 'implement' ? c.ownedPaths : [], c.kind === 'implement' ? c.actionOutputs : {}),
    [],
    '短路之后仍然报出了问题——那一条不是它抓的',
  )
  // ……而真品那条路对同一份契约报得出来：短路版与真品在这一份上答案不同，正是"它抓的"。
  assert.notDeepEqual(
    actionOutputsOutside(c.kind === 'implement' ? c.ownedPaths : [], c.kind === 'implement' ? c.actionOutputs : {}),
    shortCircuited([], {}),
  )
})

test('③ seed 超限 → 拒绝派发，不裁剪后照发', () => {
  // 上限：模型上限 − Zone A − 交接余量。
  assert.equal(seedLimitOf({}), SEED_BUDGET.model - SEED_BUDGET.zoneA - SEED_BUDGET.handoff)

  const seed = ['src/parse.ts', 'src/callers/x.ts'] as readonly RelPath[]
  const small = build(INTENT, deps())
  assert.deepEqual(
    small.seedTokens,
    [seedTokensOf(seed), seedTokensOf(seed), seedTokensOf(seed)],
    '三份契约各算一次：调查型 · 两份实现型',
  )
  assert.equal(small.seedLimit, seedLimitOf({}))

  // 超限：一份 20 万 token 量级的种子（模型上限那个量级）。**量它的是尺**：ASCII 每四个字节
  // 一个 token，所以摊到清单上就是八十万字符。
  const fat = ['x'.repeat(4 * 200_000)] as readonly RelPath[]
  assert.throws(
    () => build(INTENT, deps({ seedOf: () => fat })),
    (err: unknown) => {
      assert.ok(err instanceof BuildError)
      assert.match(
        (err as Error).message,
        new RegExp(`${seedTokensOf(fat)} token > 上限 ${seedLimitOf({})} token`),
      )
      assert.match((err as Error).message, /拒绝派发/)
      return true
    },
  )

  // 恰好到上限：不拒。**判据是"大于"而不是"大于等于"**——一个字都不许裁，但也不许多拒一个。
  const just = seedTokensOf(fat)
  const exact = build(INTENT, deps({ seedOf: () => fat, seedLimit: just }))
  assert.equal(exact.seedLimit, just)
  assert.deepEqual(exact.seedTokens, [just, just, just])
  assert.throws(() => build(INTENT, deps({ seedOf: () => fat, seedLimit: just - 1 })), BuildError)

  // **整批退回**：超限发生在第二份草案上时，第一份也不落地——半批契约派出去，那一轮的分母就残了。
  let served = 0
  assert.throws(() =>
    build(
      INTENT,
      deps({
        seedOf: (n: number) => {
          served = n
          return n < 1 ? (['src/parse.ts'] as readonly RelPath[]) : fat
        },
      }),
    ),
  )
  assert.equal(served, 1, '第二份就读到超限的种子了（顺序：先调查型，再逐份实现型）')
  // 出口只有那一个：抛出来的时候调用方手里一份都没有。
  let got: unknown = null
  try {
    build(INTENT, deps({ seedOf: () => fat }))
  } catch (err) {
    got = err
  }
  assert.ok(got instanceof BuildError, '超限那一档没有抛出来')
})

test('构造器不猜、不补：草案缺键就退回，且退回的话指得出是哪一份', () => {
  // 零条断言：拒。
  assert.throws(() => build(INTENT, deps({ split: [{ goal: 'g', ownedPaths: ['src/a'], assertions: [] }] })), /没有断言/)
  // 空写入集：拒。
  assert.throws(() => build(INTENT, deps({ split: [{ goal: 'g', ownedPaths: [], assertions: [TEST_ASSERTION] }] })), /ownedPaths/)
  // 空目标：拒。
  assert.throws(() => build(INTENT, deps({ split: [{ goal: '', ownedPaths: ['src/a'], assertions: [TEST_ASSERTION] }] })), /目标/)
  // 身份给不出：拒，且不拿"默认名字"顶上。
  assert.throws(() => build(INTENT, deps({ identityFor: () => ({ agent: '', branch: 'b' as BranchId }) })), /agent 的名字/)
  // 冲突报告里没有冲突路径：拒（那就没有要解的冲突）。
  assert.throws(() => build(INTENT, deps({ conflicts: { base: BASE, conflictPaths: [], assertions: [TEST_ASSERTION] } })), /冲突路径/)
  // 解决型没有断言：拒。
  assert.throws(
    () => build(INTENT, deps({ conflicts: { base: BASE, conflictPaths: ['src/a.ts'], assertions: [] } })),
    /解决型契约没有断言/,
  )

  // 不派调查型：`question` 不给就是不派（不是"派一个空问题的"）。
  const noSurvey = build({ goal: '只做实现' }, deps())
  assert.deepEqual(noSurvey.counts, { implement: 2, investigate: 0, resolve: 0 })
  assert.equal(pick(noSurvey.contracts, 'implement').goal, SPLIT[0].goal)

  // 证据目录的段名过 `identSegments`：备注是一个段，带斜杠 · 带点 · `..` 当场被拒
  // （与 `mat/<agent>/` 同一条规矩）。
  for (const bad of ['a/b', '../../etc', '.hidden', 'a\\b', '..', 'a//b']) {
    assert.throws(
      () => evidenceFor('r1/1', { goal: 'g', evidenceRequired: [{ note: bad }] }),
      /要是一个段|非法/,
      `这个备注不该被收下：${JSON.stringify(bad)}`,
    )
  }
  // agent 的每一段落成一层目录：`evidence/r1/1/<备注>` 是一个目录，不是三个。
  assert.deepEqual(evidenceFor('r1/1', { goal: 'g', evidenceRequired: [{ note: 'callers' }] }), [
    { artifact: 'evidence/r1/1/callers', note: 'callers' },
  ])
  // 备注留空：给一个位置名，不拒——"要交证据但没说叫什么"是合法的一档。
  assert.deepEqual(evidenceFor('r1/1', { goal: 'g', evidenceRequired: [{ note: '' }] }), [
    { artifact: 'evidence/r1/1/note-1', note: '' },
  ])
  // 备注里带一个点不是"以点开头"——它是那一段里的一个字符，照收。
  assert.deepEqual(evidenceFor('r1/1', { goal: 'g', evidenceRequired: [{ note: 'callers.md' }] }), [
    { artifact: 'evidence/r1/1/callers.md', note: 'callers.md' },
  ])
})
