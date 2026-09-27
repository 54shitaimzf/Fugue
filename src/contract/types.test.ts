// A0 的断言（PLAN § 5.7 的 A0 行 · 架构 § 23 U9「S7 前必须补」· 架构 § 8.12 的三种变体 ·
// 值域持有者表 · 可验性的三级分工 · § 8.12 末段的三档）。
//
//   ① **三个形状逐字段定下来，每个字段的值域持有者指名**：三个变体的每一笔在 `FIELD_RULES`
//      里都有一格；载入时那道封口抓得住"变体里加了字段而持有者没跟着加"（那是这一站唯一
//      一处静默失效）。红负对照：把一格持有者摘掉，那一格的检查当场不跑了——断言 ① 变红
//   ② **三种契约的差别落在形状上而不是缺省上**：`investigate` 的字段里没有 `ownedPaths`
//      （它的写入面由构造器按位置定名，**不可能与任何契约相交**），`resolve` 的字段里没有
//      `deliverables`；每一笔的**值域持有者指得出它的写入面从哪来**
//   ③ **`AssertionResult` 三档各能报出来，且"跑不起来"与"没通过"分得开**：负对照——把一条
//      命令不存在的断言塞进契约 → 报"跑不起来"，不进"没通过"的计数
//   ④ **站前三处读数**在 `tools/probe-round.ts` 里（读数不是断言，落进 A0 的提交信息）
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Contract, ImplementContract, InvestigateContract, ResolveContract } from './types.ts'
import {
  DEFAULT_MODEL_LIMIT,
  FIELD_RULES,
  HANDOFF_MARGIN,
  VARIANT_FIELDS,
  checkContract,
  contractFields,
  idShapeOf,
  passing,
  resultOf,
  seedBudgetOf,
  seedLimitOf,
  unownedFields,
  zoneABudgetOf,
} from './types.ts'

/** 测试自己的一份量法：这一份量的是"给不给得出那个数"，不是产品那把尺（那一条归 `build.ts`）。 */
function tokensOf(paths: readonly string[]): number {
  return paths.reduce((n, p) => n + p.length, 0)
}

const IMPLEMENT: ImplementContract = {
  kind: 'implement',
  id: 'r1.implement.1',
  agent: 'a1',
  branch: 'b1',
  goal: '把解析器拆出来',
  ownedPaths: ['src/parse.ts', 'src/parse'],
  deliverables: [{ path: 'src/parse.ts', form: '模块' }],
  assertions: [{ action: 'test', name: '单元测试全过', where: '', expect: 0 }],
  seed: ['src/parse.ts'],
  actionOutputs: { test: ['src/parse'] },
}

const INVESTIGATE: InvestigateContract = {
  kind: 'investigate',
  id: 'r1.investigate.2',
  agent: 'a2',
  branch: 'b2',
  goal: '查清楚调用方有几处',
  question: 'src/parse.ts 被谁引用？',
  evidenceRequired: [{ artifact: 'evidence/a2/callers.md', note: '逐处列出调用点' }],
  seed: ['src'],
}

const RESOLVE: ResolveContract = {
  kind: 'resolve',
  id: 'r1.resolve.3',
  agent: 'a3',
  branch: 'b3',
  goal: '解掉 src/parse.ts 的冲突',
  base: 'c0ffee',
  conflictPaths: ['src/parse.ts'],
  assertions: [{ action: 'test', name: '单元测试全过' }],
}

/** 那一跑递进去的上下文：种子的量给得出来，于是"超限"那一条判得了。 */
const CTX = { seedTokens: tokensOf }
const CTX_BIG = { seedTokens: () => 10_000_000 }

/** 三份好契约：一份一个变体。 */
const GOOD: readonly Contract[] = [IMPLEMENT, INVESTIGATE, RESOLVE]

/** 值域持有者那一列的键集。**它不许比变体多**——多一格就是"有人写了检查而没人有那个字段"。 */
function ruleKeys(): string[] {
  return Object.keys(FIELD_RULES).sort()
}

test('① 每个字段都有值域持有者，且持有者那一格真的在跑', () => {
  // 三个变体的字段清单：逐笔都有持有者。
  for (const [kind, names] of Object.entries(VARIANT_FIELDS)) {
    assert.equal(names.length, new Set(names).size, `${kind} 的字段清单里有重复`)
    assert.deepEqual(unownedFields({ [kind]: names }, FIELD_RULES), [], `${kind} 有字段没有持有者`)
  }

  // 反方向：持有者那一列不许有变体里没有的键——它意味着一个永远跑不起来的检查。
  const declared = new Set(Object.values(VARIANT_FIELDS).flat())
  const extra = ruleKeys().filter((k) => !declared.has(k))
  assert.deepEqual(extra, [], `持有者表里有字段是三个变体都没有的：${extra.join(' · ')}`)

  // 每一格都能被指认：`holder` 是一句人话，不是空串；而**每一格都要有一句形状**——那一句是
  // 发给模型的那段提示念的那一份（`draftRuleTextOf`），少一格只是那一段里印成 `undefined`。
  for (const [field, rule] of Object.entries(FIELD_RULES)) {
    assert.ok(rule.holder.trim().length > 0, `${field} 的持有者没写出来`)
    assert.ok(rule.shape.trim().length > 0, `${field} 没有一句形状`)
    assert.equal(typeof rule.check, 'function', `${field} 没有自己的检查`)
  }

  // 三份好契约：一份问题都不该报出来。
  for (const c of GOOD) assert.deepEqual(checkContract(c, CTX), [], `${c.id} 报出了问题`)

  // 载入时那道封口：给一个变体加一笔而持有者表不动 → 当场报出那一笔。
  const withNewField = { ...VARIANT_FIELDS, implement: [...VARIANT_FIELDS.implement, 'retryLimit'] }
  assert.deepEqual(unownedFields(withNewField, FIELD_RULES), ['implement 的 retryLimit 没有值域持有者'])
  // ……而它真的会炸：把那句话摆在一个会抛的地方。
  assert.throws(() => {
    const bad = unownedFields(withNewField, FIELD_RULES)
    if (bad.length > 0) throw new Error(`契约的字段与值域持有者对不上：\n  ${bad.join('\n  ')}`)
  }, /retryLimit/)

  // **红负对照**：把 `where` 那一格摘掉，一条 `where: '../x'` 的断言当场不再被检查——
  // 说明"持有者那一格真的在跑"这句话测得出来，而不是恒真。
  const escape = { ...IMPLEMENT, assertions: [{ action: 'test', name: 'n', where: '../x' }] }
  assert.ok(
    checkContract(escape, CTX).some((m) => m.startsWith('assertions：') && m.includes('where')),
    '带 `..` 的 where 没被拒',
  )
  const saved = FIELD_RULES.assertions
  try {
    delete (FIELD_RULES as Record<string, unknown>).assertions
    // 那一格不再检查它的值：报出来的只剩"没有持有者"（封口那一句），值域那一句没了。
    const naked = checkContract(escape, CTX)
    assert.equal(naked.some((m) => m.includes('where')), false, '摘掉持有者之后，值域那一句还在跑')
    assert.deepEqual(naked, ['assertions 没有值域持有者：这一格一个检查都不跑'])
    // ……而"多出来的字段被静默放过"这一条也真的会炸：`checkContract` 当场报出那一笔。
    const extra = { ...IMPLEMENT, retryLimit: 3 } as unknown as Contract
    assert.ok(
      checkContract(extra, CTX).some((m) => m.includes('retryLimit') && m.includes('没有值域持有者')),
      '绕开载入时那道封口之后，多出来的字段被静默放过了',
    )
  } finally {
    ;(FIELD_RULES as Record<string, unknown>).assertions = saved
  }
  assert.ok(checkContract(escape, CTX).some((m) => m.includes('where')), '摘掉又装回去之后，那一格没接着跑')
})

test('② 三种契约的差别落在形状上：investigate 没有 ownedPaths，resolve 没有 deliverables', () => {
  // 逐变体的字段清单与合成值实际带着的字段**两个方向都相等**。
  for (const c of GOOD) {
    assert.deepEqual(contractFields(c), [...VARIANT_FIELDS[c.kind]].sort(), `${c.id} 的字段与清单对不上`)
  }

  // `investigate` 的写入面走另一条路：产物目录由构造器按位置定名，因此**不可能与任何契约相交**。
  const inv = contractFields(INVESTIGATE)
  for (const absent of ['ownedPaths', 'deliverables', 'assertions', 'actionOutputs']) {
    assert.equal(inv.includes(absent), false, `investigate 的字段里不该有 ${absent}`)
  }
  assert.deepEqual(
    INVESTIGATE.evidenceRequired.map((e) => e.artifact),
    ['evidence/a2/callers.md'],
    '证据的产物目录由构造器按位置定名——这一份就是那个位置的形状',
  )

  // `resolve` 没有交付物，写入面就是冲突路径集（一个集合，不是一个新字段）。
  const res = contractFields(RESOLVE)
  for (const absent of ['deliverables', 'ownedPaths', 'seed']) {
    assert.equal(res.includes(absent), false, `resolve 的字段里不该有 ${absent}`)
  }
  assert.deepEqual(
    RESOLVE.conflictPaths,
    ['src/parse.ts'],
    'resolve 的写入面 = 冲突路径集，不另立一个字段',
  )

  // `implement` 是唯一同时带写入集与交付物的那个。
  const imp = contractFields(IMPLEMENT)
  for (const present of ['ownedPaths', 'deliverables', 'actionOutputs', 'seed']) {
    assert.ok(imp.includes(present), `implement 的字段里该有 ${present}`)
  }

  // 三个变体的形状互不相同——压成一个"字段全带、多数为空"的记录时，这一条当场红。
  const shapes = GOOD.map((c) => contractFields(c).join(' '))
  assert.equal(new Set(shapes).size, 3, '三个变体的字段清单不是三份')

  // `id` 的形状定在这里，三种变体共用：A1 按它发号。
  assert.deepEqual(idShapeOf('r1.implement.1'), { round: 'r1', kind: 'implement', n: 1 })
  for (const bad of ['implement.1', 'r1.implement.0', 'r1.implement.-1', 'r1.implement.x', 'r1/2.implement.1', '']) {
    assert.equal(idShapeOf(bad), null, `这个 id 不该被认成合法：${JSON.stringify(bad)}`)
  }
})

test('③ AssertionResult 三档报得出来，"跑不起来"与"没通过"分得开', () => {
  const a = IMPLEMENT.assertions[0]

  // 通过：跑成了，退出码等于期望。
  const ok = resultOf(a, { kind: 'ran', ms: 12, exit: 0, note: 'exit 0' })
  assert.equal(ok.verdict, 'pass')
  assert.equal(passing(ok), true)
  assert.equal(ok.exit, 0)
  assert.equal(ok.expect, 0)
  assert.equal(ok.ms, 12)

  // 没通过：跑成了，退出码不等于期望。**它进打回计数。**
  const no = resultOf(a, { kind: 'ran', ms: 30, exit: 1, note: '1 个用例失败' })
  assert.equal(no.verdict, 'fail')
  assert.equal(passing(no), false)
  assert.equal(no.exit, 1)
  assert.equal(no.expect, 0)

  // 期望不是 0 的那一档：`expect: 3` 时退出码 3 是通过。
  const three = resultOf({ action: 'test', name: 'n', expect: 3 }, { kind: 'ran', ms: 1, exit: 3, note: '' })
  assert.equal(three.verdict, 'pass')

  // **负对照**：命令不存在（配置里没这个动作 / 退出码 127 那一类）→ 跑不起来，不是没通过。
  const dead = resultOf(a, { kind: 'not-run', note: '配置里没有这个动作：nosuchaction' })
  assert.equal(dead.verdict, 'unrunnable')
  assert.equal(passing(dead), false)
  assert.notEqual(dead.verdict, no.verdict, '"跑不起来"与"没通过"必须是两档')
  assert.equal(dead.exit, undefined, '跑不起来的那一档不该有退出码——它根本没跑')
  assert.match(dead.note, /nosuchaction/)

  // 三档各报得出来，三档的名字是那三个字。
  assert.deepEqual([ok.verdict, no.verdict, dead.verdict], ['pass', 'fail', 'unrunnable'])

  // 它进事件（`merge/accept` 的 `assertions`），所以它得是一份能原样 JSON 化的值。
  for (const r of [ok, no, dead]) {
    assert.deepEqual(JSON.parse(JSON.stringify(r)), r, '判决不是一份原样进得了日志的值')
  }
  assert.equal(dead.assertion, a.name, '报出来的时候要指得出是哪一条断言')

  // 契约那一侧的清单：一条断言的形状不对时，报出来的是它自己。
  for (const bad of [
    { action: '', name: 'n' },
    { action: 'test' },
    { action: 'test', name: 'n', where: 'a/../b' },
    { action: 'test', name: 'n', where: '/abs' },
    { action: 'test', name: 'n', expect: 999 },
    { action: 'test', name: 'n', expect: 1.5 },
  ]) {
    const c = { ...IMPLEMENT, assertions: [bad] } as unknown as Contract
    assert.ok(checkContract(c, CTX).some((m) => m.startsWith('assertions：')), `这个断言不该被收下：${JSON.stringify(bad)}`)
  }
})

test('清单里那三条第三级的关系：actionOutputs ⊆ ownedPaths · seed 不判就说出来 · 超限报出两个数', () => {
  const c: Contract = { ...IMPLEMENT, actionOutputs: { test: ['src/parse'], build: ['dist'] } }
  const issues = checkContract(c, CTX)
  assert.equal(issues.length, 1, `该恰好报一条：${issues.join(' / ')}`)
  assert.match(issues[0], /build/)
  assert.match(issues[0], /dist/)

  // 前缀那一侧的边界：`src/parse` 覆盖 `src/parse/x.ts`，不覆盖 `src/parser.ts`。
  assert.deepEqual(checkContract({ ...IMPLEMENT, actionOutputs: { t: ['src/parse/x.ts'] } }, CTX), [])
  assert.equal(
    checkContract({ ...IMPLEMENT, actionOutputs: { t: ['src/parser.ts'] } }, CTX).length,
    1,
    'src/parser.ts 不该被 src/parse 覆盖',
  )

  // `seed` 那一条：不判就说出来，超限就报出两个数。**超限要拒绝派发，不裁剪后照发。**
  assert.ok(
    checkContract(IMPLEMENT, {}).some((m) => m.includes('seed') && m.includes('没判超限')),
    '没给 seedTokens 时该说出"没判"，而不是默认放行',
  )
  const over = checkContract(IMPLEMENT, CTX_BIG)
  assert.equal(over.length, 1, `该恰好报一条：${over.join(' / ')}`)
  assert.match(over[0], /10000000 token 超过上限/)
  assert.equal(seedLimitOf({}), 904_000, '1 000 000 那一档：模型上限 − 固定段 80 000 − 交接余量 16 000')
})

// ⑤ 的那一条断言（计划 § 5.12 的序 14 · 架构 § 8.12）：**Zone A 那一项是一个比例，不是一个常数**，
// 而那条式子有一块地板——算出来为负就取 0，并把这件事报出来。
test('⑤ Zone A 按当前上限的 8% 算 · 算出来为负取地板 0 并报出来', () => {
  // 1 000 000 那一档：固定段 80 000（8%）· 交接余量 16 000 → 种子上限 904 000。
  assert.equal(zoneABudgetOf(DEFAULT_MODEL_LIMIT), 80_000)
  assert.equal(seedLimitOf({}), 904_000)
  assert.deepEqual(seedBudgetOf({}), {
    modelLimit: DEFAULT_MODEL_LIMIT,
    zoneA: 80_000,
    handoffMargin: HANDOFF_MARGIN,
    limit: 904_000,
    shortfall: 0,
  })

  // 窗口换一档，那一段跟着走——**它按当前上限算，不按一个写死的数**。
  assert.equal(zoneABudgetOf(128_000), 10_240)
  assert.equal(seedLimitOf({ modelLimit: 128_000 }), 128_000 - 10_240 - HANDOFF_MARGIN)
  assert.equal(seedLimitOf({ modelLimit: 128_000 }), 101_760)
  // 比例落到整数上：8% 的 999 是 79.92 → 取整往大取 80（估账宁可多留一点）。
  assert.equal(zoneABudgetOf(999), 80)
  // 显式窄化仍然最优先（架构 § 8.12 的"只可收窄"）。
  assert.equal(seedLimitOf({ modelLimit: 128_000, seedLimit: 1_000 }), 1_000)

  // 地板：上限 8 000 连固定段 640 与交接余量 16 000 都盖不住 → 那条式子取 0，且这件事报得出来。
  const tiny = seedBudgetOf({ modelLimit: 8_000 })
  assert.equal(tiny.zoneA, 640)
  assert.equal(tiny.limit, 0, `地板该是 0，拿到 ${tiny.limit}`)
  assert.equal(tiny.shortfall, 8_640)
  const floor = checkContract(IMPLEMENT, { modelLimit: 8_000, seedTokens: () => 0 })
  assert.equal(floor.length, 1, `该恰好报一条：${floor.join(' / ')}`)
  const said = floor[0] as string
  assert.match(said, /自己配错了/)
  assert.ok(said.includes('上限 8000 token') && said.includes('固定段 640 token'), said)
  assert.ok(said.includes('8640 token') && said.includes('地板取 0'), said)

  // **负对照**：把 Zone A 写回固定 24 000（就是把比例换回一个常数）→ 1 000 000 那一档算出
  // 960 000，与 904 000 分得开——"它是一个比例"这句话因此不是恒真的。
  const fixedZoneA = (limit: number): number => limit - 24_000 - HANDOFF_MARGIN
  assert.equal(fixedZoneA(DEFAULT_MODEL_LIMIT), 960_000)
  assert.notEqual(fixedZoneA(DEFAULT_MODEL_LIMIT), seedLimitOf({}))
})
