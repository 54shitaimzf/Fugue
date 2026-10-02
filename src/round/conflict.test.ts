// 0.2.9 ④ 的负对照：冲突环里那一份「解决型」契约的身份从哪来。
// 出处：ROADMAP § 3 的 0.2.9 行 ④（兜底造值去）· 架构 § 8.12 那张值域持有者表。
//
// **为什么单开这一份**：`round/execute.ts` 的 `resolveContractOf` 原先有三个兜底值——`'r1'` ·
// `'round'` · `'agent/round/0'`，系统里不存在的三个。它们把"这一批一份契约都没有"这件事变成
// 一份看起来合法的解决型契约，于是那一批的身份从此没有人知道。**这一条要会红**：拿一批真契约
// （走产品那个构造器造出来）走一遍，身份必须逐字段等于这批的第一份；拿空批走，必须当场红。
//
// 跑法：cd ~/fugue && node --test src/round/conflict.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Assertion, Contract, ImplementContract, ResolveContract } from '../contract/types.ts'
import type { BuildDeps, Intent } from '../contract/build.ts'
import { build } from '../contract/build.ts'
import type { BranchId, CommitId, RelPath, RoundId } from '../terms.ts'
import { RoundRunError, resolveContractOf } from './execute.ts'

const BASE = '0'.repeat(40) as CommitId
/** 实际冲突集：解决型那一份的写入面就是它，一个字节都不多。 */
const CONFLICTS: readonly RelPath[] = ['src/render.ts' as RelPath, 'src/parse.ts' as RelPath]

/** 一批真契约：调查型 + 两份实现型，全走产品那个构造器（`build()`），不手搓。 */
function batch(): Contract[] {
  const intent: Intent = {
    goal: '把合并那一段改到新模块上。',
    question: '冲突落在哪几条路径上？',
    evidenceRequired: [{ note: '一份读数' }],
  }
  const deps: BuildDeps = {
    round: 'r1' as RoundId,
    base: BASE,
    identityFor: (n: number) => ({ agent: `agent-${n + 1}`, branch: `agent-${n + 1}` as BranchId }),
    seedOf: () => [],
    split: [
      {
        goal: '改实现。',
        ownedPaths: ['src/render.ts' as RelPath],
        assertions: [{ action: 'test' as Assertion['action'], name: 'renders' }],
      },
      {
        goal: '改解析。',
        ownedPaths: ['src/parse.ts' as RelPath],
        assertions: [{ action: 'test' as Assertion['action'], name: 'parses' }],
      },
    ],
  }
  return [...build(intent, deps).contracts]
}

test('① 真契约走一遍：身份逐字段从这批的第一份来，conflictPaths 就是实际冲突集', () => {
  const contracts = batch()
  const first = contracts[0]
  assert.ok(first !== undefined)
  const c = resolveContractOf(contracts, CONFLICTS, BASE) as ResolveContract

  assert.equal(c.kind, 'resolve')
  assert.equal(c.id, `${first.id}#resolve`, '解决型的 id 不是从这批第一份长出来的')
  assert.equal(c.agent, first.agent, '解决型的 agent 不是从这批第一份抄的')
  assert.equal(c.branch, first.branch, '解决型的 branch 不是从这批第一份抄的')
  assert.equal(c.base, BASE, '解决型的 base 该是冲突报告给的那棵树')
  assert.deepEqual([...c.conflictPaths], [...CONFLICTS], 'conflictPaths 不是实际冲突集的拷贝')
  // 这批第一份是**调查型**：它的键域里没有断言（`VARIANT_FIELDS.investigate`），所以解决型
  // 那一份也不该凭空带上几条。
  assert.deepEqual([...c.assertions], [], '调查型那一节没有断言，解决型不该带上几条')

  // 第一份是**实现型**时（把调查型那一条摘掉），断言要抄过来——这是同一个函数的另一半。
  const implOnly = contracts.filter((k) => k.kind === 'implement')
  const f2 = implOnly[0] as ImplementContract
  const c2 = resolveContractOf(implOnly, CONFLICTS, BASE) as ResolveContract
  assert.equal(c2.id, `${f2.id}#resolve`)
  assert.equal(c2.agent, f2.agent)
  assert.deepEqual([...c2.assertions], [...f2.assertions], '实现型那一节的断言没有抄过来')

  console.log(
    `① 读数：第一批 ${first.kind}(${first.id}) → ${c.id} / agent ${String(c.agent)} / branch ${String(c.branch)}` +
      ` · 实现型那一批 → ${c2.id}（断言 ${c2.assertions.length} 条）`,
  )
})

test('② 负对照：一份契约都没有的批 → 当场红，那三个系统里不存在的值一个都不出现', () => {
  let thrown: unknown = null
  try {
    resolveContractOf([], CONFLICTS, BASE)
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown instanceof RoundRunError, `该抛 RoundRunError，实得 ${String(thrown)}`)
  assert.match((thrown as Error).message, /一份契约都没有/, `报出来的话没说是哪一件事：${(thrown as Error).message}`)

  // 原先那三个兜底值，逐处各问一次：它们一个都不该再出现在任何一份产物里。
  const real = resolveContractOf(batch(), CONFLICTS, BASE) as ResolveContract
  assert.notEqual(real.id, 'r1#resolve', '`r1#resolve` 那个兜底值还在（系统里没有这个 id）')
  assert.notEqual(real.agent, 'round', '`round` 那个兜底身份还在（系统里没有这个 agent）')
  assert.notEqual(real.branch, 'agent/round/0', '`agent/round/0` 那个兜底分支还在（系统里没有这条分支）')
  console.log(`② 读数：空批 → ${(thrown as Error).name}「${(thrown as Error).message.slice(0, 24)}…」`)
})
