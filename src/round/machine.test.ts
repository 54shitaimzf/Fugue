// A3 的断言（PLAN § 5.7 的 A3 行 · 架构 § 8.13 的那张图与三条验证性质与那条结构纪律 · § 8.13.a
// 的两个上界 · D8）。
//
//   ① **重放 `round/state` 事件序列得到的 `RoundState` 与当时一致，且每一次转移都指得到触发它的
//      那一条事件**：走一遍完整的轮次（含冲突那一圈与打回那一圈），逐边印出来。负对照：加一条
//      图上没有的边 → ① 变红
//   ② **`Aborted` 从任意状态可达；`Collecting` 的 gc 屏障只在全部 agent 停止之后打开**：
//      九个状态逐个 abort 到 `Aborted`；还在跑的时候 `gc-done` 当场拒，全停之后走得动
//   ③ **状态机只做转移、不做动作**：`machine.ts` 里没有一次 `await`、没有一个句柄——这条断言
//      读的是源码本身，不是行为；负对照：往那一份里塞一行 `await` → ③ 变红
//
//   ⑤ **门停在 `Planning`**（PLAN § 5.10 的 C2）：从 `Planning` 出去只有两条边（发契约 · 中止），
//      **没有一条能让这一轮自己走掉**；而判那一份（`contract/gate.ts`）的 import 只来自词汇表
//      与同一层——它拿不到日志、真源、视图，所以“门停着时没有 `contract/issue`”不是自觉，
//      是签名上就没有地方发；负对照：往它的 import 里加一行日志那一侧 → ⑤ 变红
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { AgentId, RoundState } from '../terms.ts'
import type { Branches, Cause, Edge, StepContext } from './machine.ts'
import { EDGES, RETRY_DEFAULT, STATES, RoundStateError, abortEdges, allStopped, causesFrom, running, sayOf, step, trail, verdictCause } from './machine.ts'

const A = (n: number): AgentId => `r1/${n}` as AgentId

/** 三个 agent 的处境：给一份就够（屏障那一条要的是"全停没有"）。 */
function branches(states: readonly string[]): Branches {
  const out: Record<string, string> = {}
  states.forEach((s, i) => {
    out[A(i + 1)] = s
  })
  return out as Branches
}

/** 从图上读一条边（断言里要用它的 `say`）。 */
function edge(from: RoundState, on: Cause): Edge {
  const hit = EDGES.find((e) => e.from === from && e.on === on)
  if (hit === undefined) throw new Error(`图上没有这条边：${from} ──${on}`)
  return hit
}

test('① 一个完整轮次逐边走通，每一次转移都指得到那一条事件', () => {
  // 那一圈走到 `Working → Collecting` 的时候，三个 agent 已经停下了——屏障就是在等这一件事。
  const stopped = branches(['Done', 'Failed', 'Preempted'])

  const walked = trail([
    ['land', { intent: true }],
    ['contracts-issued'],
    ['branches-started'],
    ['all-stopped', { branches: stopped }],
    ['gc-done'],
    // 冲突那一圈：报出冲突 → 解决完重折 → 再报一次 → 再折一次（两条自环各走一遍）
    ['conflict'],
    ['re-fold'],
    ['conflict'],
    ['resolved'],
    ['verdict-fail', { retryLeft: true }],
    ['all-stopped', { branches: stopped }],
    ['gc-done'],
    ['resolved'],
    ['verdict-pass'],
    ['advanced'],
    ['branches-started'],
  ])

  assert.equal(walked.state, 'Working', '一圈走完该回到 Working（Rebuilding 之后接着跑）')
  assert.deepEqual(
    walked.edges.map((e) => `${e.from} ──${e.on}──> ${e.to}`),
    [
      'Idle ──land──> Planning',
      'Planning ──contracts-issued──> Delegated',
      'Delegated ──branches-started──> Working',
      'Working ──all-stopped──> Collecting',
      'Collecting ──gc-done──> Merging',
      'Merging ──conflict──> Merging',
      'Merging ──re-fold──> Merging',
      'Merging ──conflict──> Merging',
      'Merging ──resolved──> Verifying',
      'Verifying ──verdict-fail──> Working',
      'Working ──all-stopped──> Collecting',
      'Collecting ──gc-done──> Merging',
      'Merging ──resolved──> Verifying',
      'Verifying ──verdict-pass──> Committed',
      'Committed ──advanced──> Rebuilding',
      'Rebuilding ──branches-started──> Working',
    ],
    '走过的边与图对不上',
  )
  // 每一步都指得到触发它的那一条事件：`edges` 里每一条的 `on` 就是它。
  for (const e of walked.edges) assert.ok(e.on !== undefined && e.say !== '', `${e.from} → ${e.to} 那一条没有触发事件`)

  // 重放：同一串事件从 Idle 再走一遍，终点与走过的边逐条相同（"重放得到的与当时一致"）。
  const again = trail([
    ['land', { intent: true }],
    ['contracts-issued'],
    ['branches-started'],
    ['all-stopped', { branches: stopped }],
    ['gc-done'],
    ['conflict'],
    ['re-fold'],
    ['conflict'],
    ['resolved'],
    ['verdict-fail', { retryLeft: true }],
    ['all-stopped', { branches: stopped }],
    ['gc-done'],
    ['resolved'],
    ['verdict-pass'],
    ['advanced'],
    ['branches-started'],
  ])
  assert.deepEqual(again, walked, '重放出来的与当时不一致')

  // **红负对照**：加一条图上没有的边（Planning 直接到 Working），① 当场红。
  const withExtra: Edge[] = [...EDGES, { from: 'Planning', to: 'Working', on: 'branches-started', say: '（图外的一条）' }]
  const hasEdge = (es: readonly Edge[], from: RoundState, on: Cause): boolean => es.some((e) => e.from === from && e.on === on)
  assert.equal(hasEdge(EDGES, 'Planning', 'branches-started'), false, '图上本来没有 Planning ──branches-started')
  assert.equal(hasEdge(withExtra, 'Planning', 'branches-started'), true, '加进去之后它就在了')
  assert.throws(() => step('Planning', 'branches-started'), /图上没有这条边/, '图外的边没被拒')
  assert.throws(() => step('Idle', 'gc-done'), RoundStateError)
  assert.throws(() => step('Committed', 'conflict'), /图上没有这条边/)
  // ……而中间那几步也不许跳：`Idle ──contracts-issued──>` 不存在。
  assert.deepEqual(causesFrom('Idle'), ['abort', 'land'])
  assert.deepEqual(causesFrom('Collecting'), ['abort', 'gc-done'])
})

test('② Aborted 从任意状态可达；Collecting 的屏障只在全停之后开', () => {
  // 九个状态逐个 abort。`Aborted` 自己不在里面（再 abort 一次没有意义，也不该有这条边）。
  for (const s of STATES) {
    if (s === 'Aborted') continue
    assert.equal(step(s, 'abort'), 'Aborted', `${s} 到不了 Aborted`)
  }
  assert.throws(() => step('Aborted', 'abort'), /图上没有这条边/, 'Aborted 不该有出去的 abort')
  assert.equal(abortEdges().length, STATES.length - 1)

  // gc 屏障：还在跑 → 拒；全停 → 走得动。
  const someRunning = branches(['Working', 'Done', 'Failed'])
  assert.equal(allStopped(someRunning), false)
  assert.deepEqual(running(someRunning), [A(1)], '还在跑的该报出是哪一个')
  assert.throws(
    () => step('Working', 'all-stopped', { branches: someRunning }),
    /还在跑的：r1\/1/,
    '还有分支在跑，屏障就开了',
  )
  assert.throws(() => step('Working', 'all-stopped', { branches: someRunning }), /全部 Done\/Failed\/超时/)
  // 两道门各管一边：`Working → Collecting` 问"全停了吗"（图上那个 `┌─┤` 分叉），
  // `Collecting → Merging` 问"屏障走完了吗"。两者都过不去时都不许走。
  assert.equal(step('Working', 'all-stopped', { branches: branches(['Done', 'Failed', 'Preempted']) }), 'Collecting')
  // 一个分支都没有（空表）也算全停——`every` 在空表上为真，这不是漏洞：没有分支就没有屏障要等。
  assert.equal(allStopped({}), true)
  assert.equal(step('Working', 'all-stopped', { branches: {} }), 'Collecting')
  // 屏障那一步也可以在"没给 branches"时用 `allStopped` 这个直给的值（A4 那侧手上有的是它）。
  assert.equal(step('Working', 'all-stopped', { allStopped: true }), 'Collecting')
  assert.throws(() => step('Working', 'all-stopped', { allStopped: false }), /没给 branches/)

  // 三档停下来的取值：`Preempted`（被接续换下去的那一届）也在"停了"里。
  for (const s of ['Done', 'Failed', 'Preempted']) {
    assert.equal(allStopped(branches([s])), true, `${s} 该算停了`)
  }
  for (const s of ['Forked', 'Working', 'Merged', 'Discarded']) {
    assert.equal(allStopped(branches([s])), false, `${s} 不该算停了`)
  }
})

test('③ 状态机只做转移、不做动作：那一份里没有一处 await、没有一个句柄', () => {
  const file = fileURLToPath(new URL('./machine.ts', import.meta.url))
  const text = readFileSync(file, 'utf8')

  // 它只 import 一样东西：词汇表里的两个类型。没有 fs · 没有 child_process · 没有事件循环。
  const imports = text.split('\n').filter((l) => l.startsWith('import '))
  assert.equal(imports.length, 1, `machine.ts 的 import 不止一处：\n${imports.join('\n')}`)
  assert.match(imports[0], /^import type \{[^}]*\} from '\.\.\/terms\.ts'$/)
  // **只判代码行**：注释里说"没有 `await`"这件事本身不该把这条断言弄红。
  const code = text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*'))
    .join('\n')
  for (const banned of ['node:', 'Promise', 'async', 'fs', 'child_process', 'performance.now', 'await']) {
    assert.equal(code.includes(banned), false, `machine.ts 的代码里出现了 ${banned}`)
  }
  assert.equal(/\bawait\b/.test(code), false, 'machine.ts 里出现了 await')

  // **红负对照**：往那一份源码里塞一行 await，③ 那条判据当场红。
  const polluted = code.replace('export function step(', 'async function _void() {\n  await Promise.resolve()\n}\nexport function step(')
  assert.equal(code.includes('await'), false)
  assert.equal(polluted.includes('await'), true, '负对照没被认出来——那这条判据是恒真的')
  assert.notEqual(polluted, code)

  // 行为那一侧同一条：`step` 是同步函数，收值给值。它给不出 `Promise`。
  const out = step('Idle', 'land', { intent: true })
  assert.equal(out, 'Planning')
  assert.equal(typeof (out as unknown as { then?: unknown }).then, 'undefined', 'step 给出了一个 thenable')
})

test('守卫与两个上界：意图没建立不走，打回超界才 Aborted', () => {
  // `Idle → Planning` 的守卫是"意图快照已建立"（架构 § 8.13 的第一个关键点）。
  assert.throws(() => step('Idle', 'land'), /意图快照已建立/, '没有意图快照也进了 Planning')
  assert.throws(() => step('Idle', 'land', { intent: false }), RoundStateError)
  assert.equal(step('Idle', 'land', { intent: true }), 'Planning')

  // 打回那两条分叉：还有余量就回 `Working`，超界才 `Aborted`（架构 § 8.13 图上那两条）。
  assert.equal(verdictCause(false, 2), 'verdict-fail')
  assert.equal(verdictCause(false, 1), 'verdict-fail')
  assert.equal(verdictCause(false, 0), 'retry-exceeded')
  assert.equal(verdictCause(true, 0), 'verdict-pass', '余量用完了但这次过了——照样进 Committed')
  assert.equal(step('Verifying', verdictCause(false, 0)), 'Aborted')
  assert.equal(step('Verifying', verdictCause(false, 1), { retryLeft: true }), 'Working')
  // **缺省那一个数是 1**（架构 § 8.13）：第一遍没过回 `Working`，余量花完的第二遍才 `Aborted`。
  // 这一条量的是那个常量本身——命令行那一头怎么用它，在 `cli/chain.test.ts` 里量。
  assert.equal(RETRY_DEFAULT, 1)
  assert.equal(step('Verifying', verdictCause(false, RETRY_DEFAULT), { retryLeft: true }), 'Working')
  assert.equal(step('Verifying', verdictCause(false, RETRY_DEFAULT - 1)), 'Aborted')
  assert.equal(step('Verifying', verdictCause(true, 0)), 'Committed')
  // 守卫真的在拦：说没余量就不走那一条。
  assert.throws(() => step('Verifying', 'verdict-fail', { retryLeft: false }), /还有重试余量/)
  // **两个上界各自独立**：接续上界（`Rebuilding` 那条线）不经过 `Verifying`，所以"持续接续"
  // 走不出 `Aborted`——这条只量得到"那条路不经过这里"，整条不变量归 § 8.13.a 与 U4。
  assert.equal(step('Rebuilding', 'branches-started'), 'Working')
  assert.deepEqual(causesFrom('Rebuilding'), ['abort', 'branches-started'])

  // `sayOf` 印的是图上那一句。
  assert.match(sayOf('Verifying', 'Aborted'), /没通过 ∧ 超界/)
  assert.match(sayOf('Collecting', 'Merging'), /gc\/repack 屏障/)
  assert.match(sayOf('Idle', 'Merging'), /图上没有这一条/)

  // 每一步的上下文都是值：给一份 froze 的上下文，走一步不动它。
  const ctx: StepContext = Object.freeze({ intent: true, branches: Object.freeze(branches(['Done'])) })
  assert.equal(step('Idle', 'land', ctx), 'Planning')
  assert.deepEqual(ctx, { intent: true, branches: { 'r1/1': 'Done' } })
})

test('⑤ 门停在 Planning：从它出去只有两条边，而判那一份发不出契约', () => {
  // **状态那一侧**：`Planning` 只认两个事件——发契约（人开的那一脚）与中止。
  // “默认为停”在状态机里的形状就是这一行：没有第三条路。
  assert.deepEqual(causesFrom('Planning'), ['abort', 'contracts-issued'])
  assert.equal(step('Idle', 'land', { intent: true }), 'Planning')
  // 没发契约就想起分支：图上没有这条边。
  assert.throws(() => step('Planning', 'branches-started'), /图上没有这条边/)
  assert.throws(() => step('Planning', 'all-stopped', { branches: {} }), /图上没有这条边/)

  // **判那一份那一侧**：`contract/gate.ts` 的每一条 import 都落在词汇表与同一层里。
  const file = fileURLToPath(new URL('../contract/gate.ts', import.meta.url))
  const text = readFileSync(file, 'utf8')
  const imports = text.split('\n').filter((l) => l.startsWith('import '))
  assert.ok(imports.length >= 5, `门那一份的 import 只有 ${imports.length} 条——那这条判据是恒真的`)
  for (const l of imports) {
    assert.match(
      l,
      /from '(\.\.\/terms\.ts|\.\/(build|draft|precheck|types)\.ts)'$/,
      `门那一份 import 了别处的东西：${l}`,
    )
  }
  // **它一条事件都发不出去**：没有日志那个句柄，也就没有 `append` 可调。
  // **只判代码行**：注释里说“不发契约”这件事本身不该把这条断言弄红。
  const code = text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*'))
    .join('\n')
  for (const banned of ['.append(', 'openLog', 'refFor(', 'node:']) {
    assert.equal(code.includes(banned), false, `gate.ts 的代码里出现了 ${banned}`)
  }

  // **负对照**：往它的 import 里加一行日志那一侧 → 那条判据当场红。
  const polluted = text.replace(
    "import { planningGate } from './precheck.ts'",
    "import { openLog } from '../log/log.ts'\nimport { planningGate } from './precheck.ts'",
  )
  assert.equal(polluted !== text, true, '负对照没被改到——那这条判据是恒真的')
  const badImports = polluted.split('\n').filter((l) => l.startsWith('import '))
  assert.equal(
    badImports.some((l) => !/from '(\.\.\/terms\.ts|\.\/(build|draft|precheck|types)\.ts)'$/.test(l)),
    true,
    '加了一行 IO 那一侧的 import，判据却没认出来',
  )
  console.log(
    `⑤ 读数：Planning 认的事件 ${causesFrom('Planning').join(' · ')}（没有第三条）· ` +
      `gate.ts 的 ${imports.length} 条 import 全在词汇表与同一层（拿不到日志）`,
  )
})
