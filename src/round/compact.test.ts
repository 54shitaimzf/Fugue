// **浓缩件**（本版· 验收锚 ①）。跑法：cd ~/fugue && node --test src/round/compact.test.ts
//
// 出处：路线图 § 5 的本版行（`T14` 门视图浓缩件）· 架构 § 15.1.a（门由人开 · 放行的是这一批 ·
// 新的一批一律重停）· § 9.2（账是唯一的观察对象）。
//
// 这一份量四件事，各配一条会红的判据：
//
//   ① **三种档分得开**：账上一条放行都没有 → `first`；与上一批同号 → `same`；不同 → `changed`
//      并逐处说差在哪。
//   ② **零 diff 与同号不是一回事**：改一句 `goal`、别的一个字不动 → 编号变（`changed`）而
//      `diff` 逐条相同（空）——两句话都印得出来。
//   ③ **可重算**：同一份账算两遍，规范化原文与 `digest` 逐字节相同；**换一个进程**算一遍
//      （`spawnSync` 跑同一段）也逐字节相同——这一条是"跨进程"那半句的判据。
//   ④ **纯**：浓缩件只从入参那两份值来——把账上的底改掉，出来的底跟着改；不看当下工作区。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import type { Contract } from '../contract/types.ts'
import type { Pending } from './dispatch.ts'
import type { ApprovedBatch, RoundFacts } from './versions.ts'
import { canonicalOf, compactLinesOf, compactOf, countsOf, diffOf } from './compact.ts'

/** 一份 implement 契约（只要这一份用得到的几栏）。 */
function implement(id: string, goal: string, owned: string[] = ['a.ts'], assertions = ['总是过']): Contract {
  return {
    id,
    agent: 'agent/r1/1',
    branch: 'refs/heads/agent/r1/1',
    kind: 'implement',
    goal,
    ownedPaths: owned,
    deliverables: [{ path: owned[0] ?? 'a.ts', form: '一份文件' }],
    assertions: assertions.map((name) => ({ action: name, name })),
    seed: [],
    actionOutputs: {},
  } as unknown as Contract
}

/** 一份 resolve 契约（只带冲突路径与断言）。 */
function resolve(id: string, conflictPaths: string[], assertions: string[] = []): Contract {
  return {
    id,
    agent: 'agent/r1/1',
    branch: 'refs/heads/agent/r1/1',
    kind: 'resolve',
    goal: `解 ${id}`,
    conflictPaths,
    base: '0'.repeat(40),
    assertions: assertions.map((name) => ({ action: name, name })),
    seed: [],
    actionOutputs: {},
  } as unknown as Contract
}

/**
 * 一份放行过的批（账上那一条 `round/approve` 的读数 + **它后面那几条 `contract/issue` 收回来的正文**）。
 * `missing` 是"账上点了名、而正文取不回来"的那几个 id——缺证那一档的输入。
 */
function approved(
  round: string,
  fingerprint: string,
  contracts: readonly Contract[],
  missing: readonly string[] = [],
): ApprovedBatch {
  return { round, fingerprint, contracts, missing }
}

/** 一份账的读数（这一份只读那几栏）。 */
function factsOf(over: Partial<RoundFacts> = {}): RoundFacts {
  return {
    round: 'r1' as RoundFacts['round'],
    state: 'Planning',
    base: 'a'.repeat(40) as RoundFacts['base'],
    goal: '把这件事做完',
    versions: [],
    approvals: [],
    ...over,
  }
}

/** 门口那一批（`pendingOf` 的产出形状；这一份只读那几栏）。 */
function pendingOfContracts(contracts: readonly Contract[], fingerprint: string): Pending {
  return {
    round: 'r1' as Pending['round'],
    base: 'a'.repeat(40) as Pending['base'],
    goal: '把这件事做完',
    built: { contracts, seedLimit: 1, seedTokens: [], seedRead: { from: 'given', loaded: 0, missing: [] } },
    precheck: { lines: [], intersections: [] },
    fingerprint,
    seedRead: { from: 'given', loaded: 0, missing: [] },
    same: [],
  } as unknown as Pending
}

test('① 三种档：没有放行 → first · 同号 → same · 不同 → changed 并逐处说差', () => {
  const now = implement('r1.implement.1', '写一份 a.ts')
  const p = pendingOfContracts([now], 'fp-new')

  const first = compactOf(p, factsOf())
  assert.equal(first.compare, 'first')
  assert.equal(first.lastApproved, null)
  assert.deepEqual(first.diff, [])
  assert.match(compactLinesOf(first).join('\n'), /第一确认/)

  const same = compactOf(p, factsOf({ approvals: [approved('r1', 'fp-new', [now])] }))
  assert.equal(same.compare, 'same')
  assert.deepEqual(same.diff, [], '同号那一档不该有差异（编号相同就是同一批）')
  assert.match(compactLinesOf(same).join('\n'), /同号/)

  const changed = compactOf(
    p,
    factsOf({ approvals: [approved('r1', 'fp-old', [implement('r1.implement.1', '写一份 b.ts', ['b.ts'])])] }),
  )
  assert.equal(changed.compare, 'changed')
  assert.equal(changed.diff.length, 3, `该有三处（目标 · 写入面 · 交付物）：${changed.diff.join(' | ')}`)
  assert.ok(
    changed.diff.some((d) => d.includes('目标变了')),
    `该说出目标变了：${changed.diff.join(' | ')}`,
  )
  const lines = compactLinesOf(changed).join('\n')
  assert.match(lines, /不同/)
  assert.match(lines, /3 处/)
  console.log(`① 读数：first/same/changed 三档各一条 · changed 的差异 ${changed.diff.length} 处`)
})

test('② 零 diff 与同号不是一回事：只改一句 goal → 编号变而面逐条相同', () => {
  const before = implement('r1.implement.1', '写一份 a.ts')
  const after = implement('r1.implement.1', '写一份 a.ts') // 面逐字相同，编号不同（构造那一侧给的）
  const diff = diffOf([before], [after])
  assert.deepEqual(diff, [], `面逐条相同该是空的：${diff.join(' | ')}`)
  const a = compactOf(pendingOfContracts([after], 'fp-2'), factsOf({ approvals: [approved('r1', 'fp-1', [before])] }))
  assert.equal(a.compare, 'changed', '编号不同就是 changed（同号判据看的是编号）')
  assert.deepEqual(a.diff, [], '面相同就是零 diff')
  const lines = compactLinesOf(a).join('\n')
  assert.match(lines, /零 diff/, `人面该说出"零 diff"这件事：${lines}`)
  console.log('② 读数：编号变（changed）而 diff 为空 · 人面印出"零 diff——面逐条相同，只有编号变了"')
})

test('③ 可重算：同账两遍逐字节相同；**换一个进程**算一遍也逐字节相同', () => {
  const contracts = [
    implement('r1.implement.1', '写一份 a.ts'),
    resolve('r1.resolve.1', ['src/a.ts', 'src/b.ts'], ['总是过']),
  ]
  const p = pendingOfContracts(contracts, 'fp-x')
  const f = factsOf({ approvals: [approved('r1', 'fp-old', [implement('r1.implement.1', '旧的')])] })
  const a = compactOf(p, f)
  const b = compactOf(p, f)
  assert.equal(canonicalOf(a), canonicalOf(b), '同一份入参两遍该逐字节相同')
  assert.equal(a.digest, b.digest)

  // **跨进程**：把同一份规范化原文交给另一个 node 进程算 sha256 前十六位，必须同一个串。
  const probe = `const {createHash}=require('node:crypto');process.stdout.write(createHash('sha256').update(process.argv[1],'utf8').digest('hex').slice(0,16))`
  const other = spawnSync(process.execPath, ['-e', probe, canonicalOf(a)], { encoding: 'utf8' })
  assert.equal(other.status, 0, other.stderr)
  assert.equal(other.stdout.trim(), a.digest, '换一个进程算出来的指纹该逐字节相同（跨进程重算那一句）')
  // 覆盖计数与验收计数（`countsOf` 一处算术）：1 条 implement + 1 条 resolve。
  assert.deepEqual(countsOf(contracts), { paths: 3, accepts: 2 })
  console.log(`③ 读数：两遍同串 · 换进程同串（${a.digest}）· 覆盖 3 条路径 / 验收 2 条`)
})

test('④ 纯：底与件数只从入参来（同一批换一份账，出来的底跟着账走）', () => {
  const contracts = [implement('r1.implement.1', '写一份 a.ts')]
  const p = pendingOfContracts(contracts, 'fp-p')
  const one = compactOf(p, factsOf({ base: 'a'.repeat(40) as RoundFacts['base'] }))
  const two = compactOf(p, factsOf({ base: 'b'.repeat(40) as RoundFacts['base'] }))
  assert.notEqual(one.base, two.base, '账上的底不同，浓缩件那一栏就该不同')
  assert.notEqual(one.digest, two.digest, '不同的账该出不同的指纹')
  assert.equal(one.tasks, 1)
  console.log(`④ 读数：同一批 · 两份账 → 两个底与两个指纹（${one.digest} ≠ ${two.digest}）`)
})

test('⑤ 差异的行序不看输入的次序：多 · 少 · 逐面，各按 id 排', () => {
  const before = [implement('r1.implement.2', '二'), implement('r1.implement.1', '一'), resolve('r1.resolve.9', ['x'])]
  const after = [implement('r1.implement.1', '一'), implement('r1.implement.2', '二改了'), implement('r1.implement.9', '九')]
  const diff = diffOf(before, after)
  assert.deepEqual(diff, [
    '多了一件 r1.implement.9',
    '少了 r1.resolve.9',
    'r1.implement.2\t目标变了：二 → 二改了',
  ])
  // 反过来算：行的集合相同（差异是**有向**的，所以不要求逐字反过来一致，只要求两侧都说得清）。
  const back = diffOf(after, before)
  assert.ok(back.includes('多了一件 r1.resolve.9'), back.join(' | '))
  assert.ok(back.includes('少了 r1.implement.9'), back.join(' | '))
  console.log('⑤ 读数：行序固定（先多后少再按 id）· 反向算得出反向的三条')
})

// ── ⑥ 跨轮对齐：按"拆分的形状那一格"比，不按整个 id 比 ─────────────────────────────
//
// 判据一句话：**换一轮（id 里那一段轮次号变了）不许被报成内容差**。同一格（第 n 节 · 同一变体）在
// 两轮里是两个不同的 id，按整个 id 对齐时它会被算成「多了一件 + 少了一件」——真正的目标 · 写入面 ·
// 验收差别就被那两行埋掉。负对照是另一半：**真的多了一格 / 少了一格照旧报得出来**（对齐不等于抹平）。
test('⑥ 跨轮同一格按形状对齐：身份差（轮次号）不冒充内容差；真多真少照旧报', () => {
  const before = [implement('r2.implement.1', '写一份 a.ts')]
  const after = [implement('r3.implement.1', '写一份 b.ts', ['b.ts'])]
  const diff = diffOf(before, after)
  assert.equal(
    diff.some((d) => d.includes('多了一件') || d.includes('少了')),
    false,
    `换一轮被报成了身份差（多/少）：${diff.join(' | ')}`,
  )
  assert.ok(
    diff.some((d) => d.startsWith('r3.implement.1\t目标变了')),
    `同一格的那条内容差没报出来：${diff.join(' | ')}`,
  )
  assert.ok(diff.some((d) => d.includes('写入面变了')), `写入面那一处没报出来：${diff.join(' | ')}`)
  // **负对照**：真多一格 · 真少一格。
  const added = diffOf(before, [...after, implement('r3.implement.2', '第二格')])
  assert.ok(added.includes('多了一件 r3.implement.2'), `真多了一格没报出来：${added.join(' | ')}`)
  const removed = diffOf([...before, implement('r2.implement.2', '第二格')], after)
  assert.ok(removed.includes('少了 r2.implement.2'), `真少了一格没报出来：${removed.join(' | ')}`)
  console.log(`⑥ 读数：跨轮同一格 → ${diff.length} 处（${diff[0] ?? ''}）· 真多/真少各一条`)
})

// ── ⑦ 缺证那一档：正文取不回来 → 差额算不出来 ─────────────────────────────────────
//
// 判据一句话：**取不回正文是一个显式的档**——不补齐（不猜正文）、不跳批（那一条批准照旧在）、
// 也不冒充同号（编号相同只说形状相同，而"差在哪"要的是正文）。
test('⑦ 缺证那一档：同号而正文取不回来 → 差额算不出来，人面逐条说是哪几件', () => {
  const now = implement('r3.implement.1', '写一份 a.ts')
  const p = pendingOfContracts([now], 'fp-x')
  const unproven = compactOf(p, factsOf({ approvals: [approved('r2', 'fp-x', [], ['r2.implement.1'])] }))
  assert.equal(unproven.compare, 'unproven', '缺证那一档没分出来（同号把它盖过去了）')
  assert.deepEqual(unproven.diff, [], '缺证时差额算不出来，就不该给一份差额')
  assert.deepEqual([...unproven.missing], ['r2.implement.1'])
  const lines = compactLinesOf(unproven).join('\n')
  assert.match(lines, /缺证，不补齐/, lines)
  assert.match(lines, /取不回来：r2\.implement\.1/, lines)
  assert.match(lines, /同号/, lines)
  // **缺证与否是两份不同的件**：它进指纹，"同一个账跨进程重算一致"那句话罩得住它。
  const fine = compactOf(p, factsOf({ approvals: [approved('r2', 'fp-x', [now])] }))
  assert.equal(fine.compare, 'same', '正文在手上、编号又相同 → 同号')
  assert.notEqual(unproven.digest, fine.digest, '缺证与不缺证出了同一个指纹——那一栏没进指纹')
  console.log(
    `⑦ 读数：同号而缺证 → compare=${unproven.compare} · 取不回来 ${unproven.missing.join(' · ')} · ` +
      `指纹 ${unproven.digest} ≠ 不缺证的 ${fine.digest}`,
  )
})
