// A2 的断言（PLAN § 5.7 的 A2 行 · 架构 § 8.12 的写入集预检那一段与验证性质 · 架构 § 8.14 的
// 第 1 步 · D6 · PLAN § 5.7 的口径一）。
//
//   ① **两个契约的写入集相交 → 报出是哪两份契约、哪几条路径**：判据是路径的`包含`而不是相等
//      （写入集是上界）。负对照：把判据换成"只比第一级目录"→ ① 变红（漏掉深层那一对）
//   ② **第一版不拒派发**（PLAN § 5.7 的口径一）：`Planning` 那一档报出相交而 `ok` 仍为真；
//      而合并前那一档**报出即拒**（不可逆点，兜底那一侧 fail-closed）。两档的判据是同一个函数
//   ③ **同一个函数在两处给出同一答案**：`Planning` 与合并前的 `intersections` 逐条相同；
//      而调查型的产物目录**不与任何契约相交**——它靠的是 `evidence` 那一段归构造器，
//      所以这一条同时量"那个前缀有没有被守卫"
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentId, BranchId, CommitId, ContractId, RelPath } from '../terms.ts'
import type { Contract } from './types.ts'
import { EVIDENCE_PREFIX, checkContract } from './types.ts'
import { covers, evidenceIsReserved, intersect, mergeGate, planningGate, precheck, writeSetOf } from './precheck.ts'
import { build, seedTokensOf } from './build.ts'

const A = (n: number): AgentId => `r1/${n}` as AgentId
const B = (n: number): BranchId => `agent/r1/${n}` as BranchId

function implement(n: number, owned: readonly RelPath[]): Contract {
  return {
    kind: 'implement',
    id: `r1.implement.${n}` as ContractId,
    agent: A(n),
    branch: B(n),
    goal: `第 ${n} 份`,
    ownedPaths: owned,
    deliverables: [],
    assertions: [{ action: 'test', name: 'n' }],
    seed: [],
    actionOutputs: {},
  }
}

function investigate(n: number): Contract {
  return {
    kind: 'investigate',
    id: `r1.investigate.${n}` as ContractId,
    agent: A(n),
    branch: B(n),
    goal: '查清楚',
    question: '谁在用它？',
    evidenceRequired: [{ artifact: `${EVIDENCE_PREFIX}/r1/${n}/callers`, note: 'callers' }],
    seed: [],
  }
}

function resolve(n: number, conflictPaths: readonly RelPath[]): Contract {
  return {
    kind: 'resolve',
    id: `r1.resolve.${n}` as ContractId,
    agent: A(n),
    branch: B(n),
    goal: '解冲突',
    base: 'beefcafe' as CommitId,
    conflictPaths,
    assertions: [{ action: 'test', name: 'n' }],
  }
}

test('① 相交报出是哪两份契约、哪几条路径；判据是包含而不是相等', () => {
  // 相等那一档：两份都声明同一条路径。
  const same = precheck([implement(1, ['src/parse.ts']), implement(2, ['src/parse.ts'])])
  assert.equal(same.intersections.length, 1)
  assert.deepEqual([same.intersections[0].a, same.intersections[0].b], ['r1.implement.1', 'r1.implement.2'])
  assert.deepEqual(same.intersections[0].hits[0].paths, ['src/parse.ts', 'src/parse.ts'])
  assert.deepEqual(same.intersections[0].kinds, ['implement', 'implement'])

  // **包含那一档（深层）**：一份声明目录，另一份声明那底下的一个文件。
  const deep = precheck([implement(1, ['src/parse']), implement(2, ['src/parse/lexer/x.ts'])])
  assert.equal(deep.intersections.length, 1, '深层那一对没报出来')
  assert.deepEqual(deep.intersections[0].hits[0].paths, ['src/parse', 'src/parse/lexer/x.ts'])
  assert.match(deep.issues[0], /r1\.implement\.1 与 r1\.implement\.2/)
  assert.match(deep.issues[0], /src\/parse ↔ src\/parse\/lexer\/x\.ts/)

  // 段要对齐：`src/parse` 不覆盖 `src/parser.ts`。
  assert.equal(precheck([implement(1, ['src/parse']), implement(2, ['src/parser.ts'])]).intersections.length, 0)
  assert.equal(covers('src/parse', 'src/parsley.ts'), false)
  assert.equal(covers('src/parse', 'src/parse/x.ts'), true)
  assert.equal(covers('src/parse/x.ts', 'src/parse'), false)

  // 三种来源都进得来：实现型 × 解决型。
  const mixed = precheck([implement(1, ['src/parse.ts', 'src/callers']), resolve(2, ['src/parse.ts'])])
  assert.equal(mixed.intersections.length, 1)
  assert.deepEqual(mixed.intersections[0].kinds, ['implement', 'resolve'])
  assert.match(mixed.intersections[0].hits[0].paths[0], /^src\/parse\.ts$/)

  // 自相交：一份契约自己那两条路径就互相包含——它比两两相交更早该被发现。
  const self = precheck([implement(1, ['src/parse', 'src/parse/x.ts'])])
  assert.equal(self.intersections.length, 1)
  assert.equal(self.intersections[0].self, true)
  assert.match(self.issues[0], /契约自己也说不清/)
  assert.equal(intersect([implement(1, ['src/a', 'src/b'])]).length, 0)

  // 多对相交时逐对都报出来，且**有序**（按入参位置）。
  const many = precheck([implement(1, ['src/a']), implement(2, ['src/a']), implement(3, ['src/a'])])
  assert.deepEqual(
    many.intersections.map((x) => `${x.a}|${x.b}`),
    ['r1.implement.1|r1.implement.2', 'r1.implement.1|r1.implement.3', 'r1.implement.2|r1.implement.3'],
  )

  // **红负对照**：把判据换成"只比第一级目录"，深层那一对当场漏掉。
  const onlyTopLevel = (cs: readonly Contract[]): number => {
    const tops = cs.map((c) => new Set(writeSetOf(c).paths.map((p) => p.split('/')[0])))
    let n = 0
    for (let i = 0; i < tops.length; i++) {
      for (let j = i + 1; j < tops.length; j++) {
        if ([...tops[i]].some((t) => tops[j].has(t))) n++
      }
    }
    return n
  }
  assert.equal(onlyTopLevel([implement(1, ['src/parse']), implement(2, ['src/parse/lexer/x.ts'])]), 1, '第一级目录都不同')
  assert.equal(
    onlyTopLevel([implement(1, ['src/parse/x.ts']), implement(2, ['src/parse/y.ts'])]),
    1,
    '第一级目录相同——这一档分不出"同一个目录下两条不同的文件"',
  )
  // 而真品在那一对上答案相反：它们是两条不相交的路径。
  assert.equal(precheck([implement(1, ['src/parse/x.ts']), implement(2, ['src/parse/y.ts'])]).intersections.length, 0)
})

test('② Planning 那一档报出而照发；合并前那一档报出即拒', () => {
  const hit = [implement(1, ['src/parse']), implement(2, ['src/parse/x.ts'])]

  const plan = planningGate(hit)
  assert.equal(plan.result.intersections.length, 1, '判据没抓到')
  assert.equal(plan.ok, true, 'Planning 那一档这一站的口径是"报出来、照发"')
  assert.match(plan.say, /照发/)
  assert.match(plan.say, /r1\.implement\.1 与 r1\.implement\.2/)

  const merge = mergeGate(hit)
  assert.equal(merge.ok, false, '合并前那一档该 fail-closed')
  assert.match(merge.say, /拒绝合并/)
  // 两档的判据逐条相同——判决不同，判据同一份。
  assert.deepEqual(plan.result.intersections, merge.result.intersections)
  assert.deepEqual(plan.result.lines, merge.result.lines)

  // 不相交时两档都放行。
  const clean = [implement(1, ['src/parse']), implement(2, ['src/callers'])]
  assert.equal(planningGate(clean).ok, true)
  assert.equal(mergeGate(clean).ok, true)
  assert.deepEqual(planningGate(clean).result.intersections, [])
})

test('③ 同一个函数两处同答；调查型的产物目录不与任何契约相交', () => {
  // 一个真造的批次：调查型 + 两份实现型。**调查型自己那一条不与谁相交。**
  const deps = {
    round: 'r1',
    base: 'beefcafe' as CommitId,
    identityFor: (n: number) => ({ agent: `r1/${n + 1}`, branch: B(n + 1) }),
    split: [
      { goal: '拆解析器', ownedPaths: ['src/parse.ts', 'src/parse'], assertions: [{ action: 'test', name: 't' }] },
      { goal: '改调用方', ownedPaths: ['src/callers'], assertions: [{ action: 'test', name: 't' }] },
    ],
    seedOf: () => [] as readonly RelPath[],
    actionOutputsOf: () => ({}),
  }
  const built = build({ goal: '拆出来', question: '谁在用它？', evidenceRequired: [{ note: 'callers' }] }, deps)
  assert.equal(built.contracts.length, 3)

  const one = precheck(built.contracts)
  assert.deepEqual(one.intersections, [], `这一批本来两两不相交：${one.issues.join(' / ')}`)
  // 两处调用：同一个答案，逐字节比。
  assert.deepEqual(planningGate(built.contracts).result.intersections, mergeGate(built.contracts).result.intersections)
  assert.deepEqual(planningGate(built.contracts).result.lines, precheck(built.contracts).lines)

  // 调查型占住的是一条目录路径 `evidence/<agent 的每一段>`——**一条，不是它祖先那几层**。
  const inv = built.contracts.find((c) => c.kind === 'investigate')
  assert.ok(inv !== undefined)
  assert.deepEqual(writeSetOf(inv).paths, ['evidence/r1/1'])
  // ……而它自己是自己的写入面，不该报自相交（祖先那几层列进来才会）。
  assert.deepEqual(intersect([inv]), [])

  // **那个前缀有守卫**：两份调查型（不同 agent）也不相交——一个不是另一个的前缀。
  const two = precheck([investigate(1), investigate(2)])
  assert.deepEqual(two.intersections, [], `两份调查型不该相交：${two.issues.join(' / ')}`)
  assert.deepEqual(writeSetOf(two === null ? investigate(1) : investigate(1)).paths, ['evidence/r1/1'])

  // 而一份实现型占住 `evidence` 那一段 → 当场报出（`ownedPaths` 那一格与这里同一件事）。
  // 占住的得是**盖得住**调查型那一条的那一层：`evidence/r1` 覆盖 `evidence/r1/1`。
  const squat = implement(3, [`${EVIDENCE_PREFIX}/r1`])
  assert.deepEqual(evidenceIsReserved([squat]).length, 1)
  assert.match(evidenceIsReserved([squat])[0], /留给调查型的位置/)
  assert.ok(
    checkContract(squat, { seedTokens: () => 0 }).some((m) => m.includes('ownedPaths') && m.includes(EVIDENCE_PREFIX)),
    'ownedPaths 那一格没拒这一条',
  )
  assert.deepEqual(evidenceIsReserved([implement(4, ['src/a'])]), [])
  // 一份占住前缀的实现型与一份调查型**相交**——这正是那条守卫要防的静默。
  assert.equal(precheck([squat, investigate(1)]).intersections.length, 1)
  // 构造器造出来的那一批里，没有一份占住那个前缀（`build` 走的是同一格检查）。
  assert.deepEqual(evidenceIsReserved(built.contracts), [])
  assert.deepEqual(checkContract(built.contracts[1], { seedTokens: seedTokensOf }), [])
})

test('写入集的三种来源各自指得出：谁给的、什么来源', () => {
  assert.equal(writeSetOf(implement(1, ['src/a'])).from, 'ownedPaths（持轮者声明）')
  assert.equal(writeSetOf(resolve(1, ['src/a'])).from, 'conflictPaths（冲突报告给的那个集合）')
  assert.equal(writeSetOf(investigate(1)).from, '构造器按位置定名的专属目录')
  // 解决型的写入集**就是**冲突路径集，不是另一个字段。
  assert.deepEqual(writeSetOf(resolve(1, ['src/a', 'src/b'])).paths, ['src/a', 'src/b'])
})
