// 前缀纪律那三条判据的断言（PLAN § 5.6 的 Z0/Z1 · 架构 § 8.11 的三区 · § 8.15 的"不采集，只重算"）。
// 跑法：cd ~/fugue && node --test src/probe/prefix.test.ts
//
//   ① 合规的一条链（三个 writer · 七次装配 · A 区共用一份 · B 区逐 writer 一份 · C 区逐次新增）：
//      三栏读数对得上，而且**一条 `!` 都没有**——它是这份读数的"绿"那一边
//   ② 负对照 · A 区多一份（运行中途有人往 A 区里放了会变的东西）：`aShared` 变假 · 报出两份哈希
//   ③ 负对照 · B 区漂移（同一个 agent 的处境中途换了）：`bStable` 变假 · A 区照旧一份
//   ④ 负对照 · C 区没长（有一步没往积累段里加东西）：`cGrew` 变假
//   ⑤ 缺账那一条：调用了 n 次而一条装配都没有 → 红（它是"前缀账不完整"，与上三条分开报）
//   ⑥ 纯读：同一串事件折两次同值 · 输入数组一个字节不动
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogEvent } from '../log/events.ts'
import type { AgentId } from '../terms.ts'
import { prefixOf } from './prefix.ts'
import type { PrefixRow } from './prefix.ts'

let seq = 0
const row = (e: LogEvent, w: string): PrefixRow => ({ pos: { writer: w, seq: (seq += 1) }, e })

/** A 区：**同一次运行里一份**（三个 writer 共用它）。 */
const A = 'aaaa1111aaaa1111'
const H = (x: string): string => x.padEnd(16, x.slice(-1))

/** 一次装配：三区各一份哈希。 */
const asm = (w: string, a: string, b: string, c: string): PrefixRow =>
  row({ t: 'prefix/assemble', agent: w as AgentId, zoneAHash: a, zoneBHash: b, zoneCHash: c }, w)

/** 一次调用：这一份读数只数条数，所以用法四个数都填 `null` 那一档（缺项不拿 0 顶）。 */
const call = (w: string, step: string): PrefixRow =>
  row(
    {
      t: 'llm/call',
      agent: w as AgentId,
      step: step as never,
      model: 'deepseek-chat' as never,
      wire: 'anthropic-messages',
      toolCount: 9,
      invocations: 1,
      status: null,
      headers: null,
      usage: { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null },
      rawStop: 'end_turn',
      stop: 'end-turn',
    },
    w,
  )

/** 一条合规链：持轮者 2 步 · agent/r1/1 三步 · agent/r1/2 两步。C 区逐次都不同。 */
function good(): PrefixRow[] {
  return [
    asm('round', A, H('b0'), H('c1')),
    call('round', 's1'),
    asm('round', A, H('b0'), H('c2')),
    call('round', 's2'),
    asm('agent/r1/1', A, H('b1'), H('d1')),
    call('agent/r1/1', 's1'),
    asm('agent/r1/1', A, H('b1'), H('d2')),
    call('agent/r1/1', 's2'),
    asm('agent/r1/1', A, H('b1'), H('d3')),
    call('agent/r1/1', 's3'),
    asm('agent/r1/2', A, H('b2'), H('e1')),
    call('agent/r1/2', 's1'),
    asm('agent/r1/2', A, H('b2'), H('e2')),
    call('agent/r1/2', 's2'),
  ]
}

const bad = (r: { readonly lines: readonly string[] }): readonly string[] => r.lines.filter((l) => l.includes('!'))

test('① 合规链：A 区跨三个 writer 一份 · B 区逐 writer 一份 · C 区逐次新增 —— 一条 ! 都没有', () => {
  const r = prefixOf(good())
  assert.equal(r.assembles, 7, `装配数不对：${r.assembles}`)
  assert.equal(r.calls, 7, `调用数不对：${r.calls}`)
  assert.equal(r.aShared, true, 'A 区该跨全部 writer 共用一份')
  assert.deepEqual(
    r.writers.map((w) => w.writer),
    ['round', 'agent/r1/1', 'agent/r1/2'],
    'writer 的次序该是首次出现的次序',
  )
  for (const w of r.writers) {
    assert.equal(w.aStable, true, `${w.writer} 的 A 区该是常量`)
    assert.equal(w.bStable, true, `${w.writer} 的 B 区该是常量`)
    assert.equal(w.cGrew, true, `${w.writer} 的 C 区该逐次新增`)
  }
  assert.deepEqual(bad(r), [], `合规链上不该有 ! 那几行：\n${bad(r).join('\n')}`)
  assert.deepEqual(r.lines, [
    '前缀纪律：装配 7 次 · 调用 7 次 · A 区 1 份（跨 3 个 writer 共用 · aaaa1111aaaa…）',
    '  round：装配 2 次 · 调用 2 次 · A aaaa1111aaaa… · B b00000000000… · C 2 份',
    '  agent/r1/1：装配 3 次 · 调用 3 次 · A aaaa1111aaaa… · B b11111111111… · C 3 份',
    '  agent/r1/2：装配 2 次 · 调用 2 次 · A aaaa1111aaaa… · B b22222222222… · C 2 份',
  ])
  console.log(`① 读数：${r.lines[0]}`)
})

test('② 负对照 · A 区多一份：aShared 变假，并报出那两份哈希', () => {
  const rows = good()
  // 第二次装配的 A 区换了：**这就是"运行中途有人在 A 区里放了会变的东西"那个坏动作**。
  const i = rows.findIndex((x) => x.e.t === 'prefix/assemble' && x.pos.writer === 'round')
  const second = rows.findIndex((x, k) => k > i && x.e.t === 'prefix/assemble')
  rows[second] = asm('round', H('9'), H('b0'), H('c2'))
  const r = prefixOf(rows)
  assert.equal(r.aShared, false, 'A 区有两份却报成共用一份')
  assert.equal(r.zoneA.length, 2, `A 区该是两份：${r.zoneA.length}`)
  assert.deepEqual(r.writers[0]?.zoneA.length, 2, 'round 那一份上 A 区该记到两份')
  assert.ok(
    bad(r).some((l) => l.includes('A 区出现了 2 份')),
    `没报出 A 区那两份：\n${bad(r).join('\n')}`,
  )
  console.log(`② 读数：${bad(r).find((l) => l.includes('A 区出现了')) ?? '（没报）'}`)
})

test('③ 负对照 · B 区漂移：那个 writer 的 bStable 变假，A 区照旧一份', () => {
  const rows = good()
  const i = rows.findIndex((x) => x.e.t === 'prefix/assemble' && x.pos.writer === 'agent/r1/1')
  const j = rows.findIndex((x, k) => k > i && x.e.t === 'prefix/assemble' && x.pos.writer === 'agent/r1/1')
  rows[j] = asm('agent/r1/1', A, H('b9'), H('d2'))
  const r = prefixOf(rows)
  assert.equal(r.aShared, true, 'A 区不该因为 B 区漂了而变假')
  const one = r.writers.find((w) => w.writer === 'agent/r1/1')
  assert.equal(one?.bStable, false, 'B 区漂了却报成常量')
  assert.equal(one?.cGrew, true, 'B 区漂了不该把 C 区那一栏带倒')
  assert.ok(
    bad(r).some((l) => l.includes('agent/r1/1 的 B 区有 2 份')),
    `没报出 B 区那一份：\n${bad(r).join('\n')}`,
  )
  console.log(`③ 读数：${bad(r).find((l) => l.includes('的 B 区有')) ?? '（没报）'}`)
})

test('④ 负对照 · C 区没长：那一次装配与上一次同哈希 → cGrew 变假', () => {
  const rows = good()
  // 第二次装配的 C 区与第一次相同：**"这一步没往积累段里加东西"那个坏动作**。
  const i = rows.findIndex((x) => x.e.t === 'prefix/assemble' && x.pos.writer === 'round')
  const j = rows.findIndex((x, k) => k > i && x.e.t === 'prefix/assemble' && x.pos.writer === 'round')
  rows[j] = asm('round', A, H('b0'), H('c1'))
  const r = prefixOf(rows)
  const one = r.writers.find((w) => w.writer === 'round')
  assert.equal(one?.cGrew, false, 'C 区两份而装配两次，该判红')
  assert.equal(one?.bStable, true, 'C 区没长不该把 B 区那一栏带倒')
  assert.ok(
    bad(r).some((l) => l.includes('的 C 区有 1 份而装配了 2 次')),
    `没报出 C 区那一份：\n${bad(r).join('\n')}`,
  )
  console.log(`④ 读数：${bad(r).find((l) => l.includes('的 C 区有')) ?? '（没报）'}`)
})

test('⑤ 缺账：调用了 3 次而一条装配都没有 → 红，而且与上面三条分开报', () => {
  const r = prefixOf([call('agent/r1/9', 's1'), call('agent/r1/9', 's2'), call('agent/r1/9', 's3')])
  assert.equal(r.assembles, 0, '这一串里没有装配')
  assert.equal(r.calls, 3, `调用数不对：${r.calls}`)
  assert.equal(r.writers[0]?.aStable, false, '一份装配都没有时 aStable 不该报成真')
  assert.ok(
    bad(r).some((l) => l.includes('调用了 3 次而一条装配都没有')),
    `没报出缺账那一条：\n${bad(r).join('\n')}`,
  )
  console.log(`⑤ 读数：${r.lines.join(' ｜ ')}`)
})

test('⑥ 纯读：同一串折两次同值 · 输入数组一条不动', () => {
  const rows = good()
  const snapshot = rows.map((x) => JSON.stringify(x.e)).join('\n')
  const a = prefixOf(rows)
  const b = prefixOf(rows)
  assert.deepEqual(a, b, '同一串事件折两次该同值')
  assert.deepEqual(
    rows.map((x) => JSON.stringify(x.e)).join('\n'),
    snapshot,
    '读一遍不该改输入',
  )
  console.log(`⑥ 读数：折两次同值（${a.lines.length} 行）· 输入 ${rows.length} 条一条不动`)
})
