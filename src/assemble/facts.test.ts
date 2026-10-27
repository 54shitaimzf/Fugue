// 幕①的字节平价：**有序事实 → 现行整区文本，逐字节相同**。
//
// 黄金在 `__fixture__/c-parity.json`：17 案，每一案的 zoneC 是**改造前**那套拼法
// （`runtime` + `turns` + `signals` + `lastStep`）在 0.5.4 施工前的 main（7b23918）上装出来的。
// 事实与 `facts.ts` 的 `Fact` 同形；这一份从事实重建状态、**只按事实投影**，再与黄金比。
//
// 两条红断言（施工交接单 § 三 幕①）：
//   · **改投影器里一个字** → ② 的"同一份"与 ① 的黄金比当场红（下面 ④ 把这条灵敏度直接量出来）；
//   · **抽掉投影器（绕回现拼法）** → 那四栏输入已经不在状态上（③ 量它），绕回去读到的是
//     `undefined`，C 区不再是黄金那一串——① 红。施工时把 `sources.ts` 的 C 源临时改回
//     `s.runtime` / `s.turns` / `s.signals` / `s.lastStep` 跑这一份，失败输出留在停点报告里。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { assemble, hashOf } from './assemble.ts'
import { SUBAGENT_PROTOCOL } from './protocol.ts'
import { emptyState, sourcesFor } from './sources.ts'
import type { Fact } from './facts.ts'
import { factsAfterHandoff, humanTextOf, lastStepTextOf, rulingTextsOf, runtimeTextOf, turnsOf, withFact } from './facts.ts'

const GOLDEN = JSON.parse(readFileSync(new URL('./__fixture__/c-parity.json', import.meta.url), 'utf8')) as {
  readonly note: string
  readonly cases: readonly { readonly name: string; readonly facts: readonly Fact[]; readonly zoneC: string; readonly zoneCHash: string }[]
}

/** 一批事实 → 那一份状态（只带事实：C 区那三段没有别的输入）。 */
function stateOf(facts: readonly Fact[]) {
  return { ...emptyState(), facts }
}

/** 一份状态 → 装配出来的三区。 */
function prefixOf(facts: readonly Fact[]) {
  return assemble({
    protocol: SUBAGENT_PROTOCOL,
    model: 'golden' as never,
    segments: sourcesFor(SUBAGENT_PROTOCOL, stateOf(facts), null),
  })
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

test('① 17 案的 C 区与改造前逐字节相同（有序事实 → 现行整区文本）', () => {
  assert.ok(GOLDEN.cases.length >= 15, `黄金只有 ${GOLDEN.cases.length} 案——覆盖面不够`)
  // 黄金本身不是一串空串：最长那一案要真的装出走查能读的一大段。
  assert.ok(
    GOLDEN.cases.some((c) => Buffer.from(c.zoneC, 'base64').length > 100),
    '黄金里没有一案超过 100 字节——这一份比的是空气',
  )
  for (const c of GOLDEN.cases) {
    const prefix = prefixOf(c.facts)
    assert.equal(b64(prefix.zoneC), c.zoneC, `「${c.name}」的 C 区与改造前不同（${c.facts.length} 条事实）`)
    assert.equal(hashOf(prefix.zoneC), c.zoneCHash, `「${c.name}」的 C 区指纹不同`)
  }
  console.log(
    `① 读数：${GOLDEN.cases.length} 案逐字节相同（最长 ${Math.max(...GOLDEN.cases.map((c) => Buffer.from(c.zoneC, 'base64').length))} 字节）· ` +
      `黄金 ${GOLDEN.note.length} 字说明`,
  )
})

test('② 同一份事实：C 区三段就是三个投影器的返回值（没有第四处拼法）', () => {
  const facts: readonly Fact[] = [
    { kind: 'human', text: '人说的那一句。' },
    {
      kind: 'turn',
      turn: { text: '先看一眼。', calls: [{ id: 't1', name: 'read', arguments: '{"path":"a.ts"}' }], results: [{ id: 't1', output: '读到了。', isError: false }] },
    },
    { kind: 'ruling', text: '第一问的判词' },
    { kind: 'turn', turn: { text: '干完了。', calls: [], results: [] } },
    { kind: 'ruling', text: '第二问的判词' },
  ]
  const segs = sourcesFor(SUBAGENT_PROTOCOL, stateOf(facts), null)
  assert.equal(segs['运行时上下文'], runtimeTextOf(facts), '「运行时上下文」不是投影器的返回值')
  assert.deepEqual(segs['信号摘要'], [...rulingTextsOf(facts)], '「信号摘要」不是投影器的返回值')
  assert.equal(segs['上一步结果'], lastStepTextOf(facts), '「上一步结果」不是投影器的返回值')

  // 顺序：判词按发生序，回合按发生序——事实的序就是两个投影器的序。
  assert.deepEqual(rulingTextsOf(facts), ['第一问的判词', '第二问的判词'])
  assert.deepEqual(turnsOf(facts).map((t) => t.text), ['先看一眼。', '干完了。'])
  assert.equal(humanTextOf(facts), '人说的那一句。')
  // 「上一步结果」是**最后一条回合**的文本投影，不是另存的一份字符串：它的开头就是那一条的话。
  assert.match(lastStepTextOf(facts), /^Model: 干完了。$/)
  console.log(`② 读数：C 区 ${runtimeTextOf(facts).length + rulingTextsOf(facts).join('\n').length + lastStepTextOf(facts).length} 字 · 三处读数同源`)
})

test('③ 第二份组合规则的输入不在状态上：runtime · turns · signals · lastStep 四栏都删了', () => {
  const s = emptyState() as unknown as Record<string, unknown>
  assert.ok(Array.isArray(s['facts']), '空状态里没有 facts 这一栏')
  for (const gone of ['runtime', 'turns', 'signals', 'lastStep']) {
    assert.equal(gone in s, false, `空状态里还留着 \`${gone}\`——那第二份组合规则就还能绕回去`)
  }
  // 而 facts 是**唯一**那一栏：C 区那三段之外，状态里没有第二处字符串/结构化历史。
  assert.equal('facts' in s, true)
  console.log(`③ 读数：空状态的键 ${Object.keys(s).length} 个，四栏旧字段一个不剩`)
})

test('④ 黄金的灵敏度：投影器里改一个字，① 那一比当场红', () => {
  // 拿最长那一案（它有回合、有回执、有换行），在「运行时上下文」的末尾加一个字——
  // 这正是"改投影器里一个字"在值上的形状。装配出来的字节与黄金立刻不同。
  const c = [...GOLDEN.cases].sort((a, b) => b.zoneC.length - a.zoneC.length)[0] as (typeof GOLDEN.cases)[number]
  const segs = sourcesFor(SUBAGENT_PROTOCOL, stateOf(c.facts), null)
  const clean = prefixOf(c.facts)
  const changed = assemble({
    protocol: SUBAGENT_PROTOCOL,
    model: 'golden' as never,
    segments: { ...segs, 运行时上下文: `${String(segs['运行时上下文'])}改` },
  })
  assert.equal(b64(clean.zoneC), c.zoneC, '干净的那一份先要与黄金相同（不然下面量的是别的东西）')
  assert.notEqual(b64(changed.zoneC), c.zoneC, '加了一个字，C 区竟然还与黄金逐字节相同——那 ① 的平价抓不住投影器的改动')
  assert.notEqual(hashOf(changed.zoneC), c.zoneCHash)
  console.log(`④ 读数：「${c.name}」加一个字 → ${hashOf(clean.zoneC)} → ${hashOf(changed.zoneC)}（${clean.zoneC.length} → ${changed.zoneC.length} 字节）`)
})

test('⑤ 只追加与交接：withFact 往后长 · factsAfterHandoff 留人话与判词、丢前任回合', () => {
  const opening = { text: '【接手】从这一步开始。上面"交接"那一段是前任留下的。', calls: [], results: [] }
  const facts: readonly Fact[] = [
    { kind: 'human', text: '人说的那一句。' },
    { kind: 'turn', turn: { text: '前任干了一半。', calls: [], results: [] } },
    { kind: 'ruling', text: '前任收到的一条判词' },
  ]
  const grown = withFact(facts, { kind: 'turn', turn: { text: '又走了一步。', calls: [], results: [] } })
  assert.deepEqual(grown.slice(0, facts.length), facts, '追一条之后前缀变了——那不是只追加')
  assert.equal(grown.length, facts.length + 1)
  // 中部改写：同一长度、换掉中间那一条 → 与只追加那一份不同（负对照：这一条量得出"改中部"）。
  const rewritten = [facts[0], { kind: 'turn', turn: { text: '换了一条。', calls: [], results: [] } } as Fact, facts[2]]
  assert.notEqual(runtimeTextOf(rewritten), runtimeTextOf(facts), '换掉中部那一条，文本竟然没变')

  const after = factsAfterHandoff(grown, opening)
  assert.deepEqual(after.map((f) => f.kind), ['human', 'ruling', 'handoff'], '交接之后事实的种类不对')
  assert.equal(runtimeTextOf(after), `人说的那一句。\nModel: ${opening.text}`, '交接那一格的开场不是人话 + 接手那一句')
  assert.equal(lastStepTextOf(after), '', '前任的上一步回执不该跟到下一格')
  assert.deepEqual(rulingTextsOf(after), ['前任收到的一条判词'], '判词该留在下一格')
  console.log(`⑤ 读数：交接后 ${after.length} 条（${after.map((f) => f.kind).join(' · ')}）· C 区 ${runtimeTextOf(after).length} 字`)
})
