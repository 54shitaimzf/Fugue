// TUI 的第二格：**哪一族事件配得上一行历史**（PLAN § 5.19 第五段 `UI1` 那一行 ·
// 「永久行那一栏的分法（第一版）」那一段 · 架构 § 9.8 的可附着 TUI · PLAN § 5.18 的三面表）。
// 跑法：cd ~/fugue && node --test src/ui/stream.test.ts
//
// 这一份量的六样：
//
//   ① **表与联合逐字对得上**：拿 `src/log/events.ts` 的源码当输入（与 `tools/check-events.js`
//      同一把尺），族名一个不多一个不少。
//   ② **负对照 · 表漏一族**：把 `round/state` 从表里拆掉 → `unclassified()` 当场报出它；
//      联合那边多长一族（`round/gate`）也被报出。这是"漏了不报错"那一类漏的判据。
//   ③ **负对照 · 挪一格**：把 `round/state` 从"永久"挪进"只计数" → 那一趟历史里一条轮次转移
//      都没有（正着那趟有）；反面：把只计数的 `llm/call` 挪进"永久" → 当场抛（分法说它配得上
//      一行历史，而渲染里没有那一行的写法）。
//   ④ **一条事件 = 一行**：夹着只计数那几族的账 → 进历史的行逐字等于那一份原文、按到达序；
//      正文里带换行的折成一行；截断**按族**（U10b：意图与交接信 80，兜 `BODY_CHARS`=40）。
//   ⑤ **一族一行都不少**：夹具覆盖 30 族，进历史的正好那 10 族——每一行带账上的坐标
//      `(writer, seq)` · 不是空行 · 没有 `undefined`。新增一族而这里没跟上，①与这一条都会红。
//   ⑥ **纯**：同一份行两次逐字节相同、进去的 rows 一个字段都没被改；空账给空历史。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { LogEvent } from '../log/events.ts'
import type { StatusRow } from '../probe/status.ts'
import { BODY_CHARS, BODY_LIMIT, FAMILY_KIND, permanentLinesOf, unclassified } from './stream.ts'
import type { EventFamily, FamilyKind } from './stream.ts'

/** 类型上不必较真的那几栏（品牌类型与几个值域）：这些行是喂给渲染的，不是账上真发生过的。 */
const brand = (v: string): never => v as never

/** 每个 writer 各数各的 seq——账上就是这样的（`(seq, writer)` 的全序由两处给）。 */
const counters: Record<string, number> = {}
const row = (e: LogEvent, w = 'round'): StatusRow => {
  counters[w] = (counters[w] ?? 0) + 1
  return { pos: { writer: w, seq: counters[w] as number }, e }
}
/** 起一份夹具：计数器清空，于是同一份账两次折出来的坐标对得上。 */
function reset(): void {
  for (const k of Object.keys(counters)) delete counters[k]
}

/**
 * 联合里那 30 个族名。**与 `tools/check-events.js` 同一把尺**：源码里 `t: 'x/y'` 全抽出来，
 * 外加不带斜杠的那一族 `signal`（它在联合里的写法与别的族不同）。
 */
function familiesInSource(): string[] {
  const src = readFileSync(new URL('../log/events.ts', import.meta.url), 'utf8')
  const out: string[] = []
  for (const m of src.matchAll(/t:\s*'([a-zA-Z]+\/[a-zA-Z]+)'/g)) if (!out.includes(m[1])) out.push(m[1])
  if (/t:\s*'signal'/.test(src) && !out.includes('signal')) out.push('signal')
  return out.sort()
}

/** 表里拆掉一族（负对照用）。 */
function withoutFamily(family: string): Record<string, FamilyKind | undefined> {
  const copy: Record<string, FamilyKind | undefined> = { ...FAMILY_KIND }
  delete copy[family]
  return copy
}

/** 一次调用：只计数那一族的代表。 */
function llmCall(agent: string, step: string): LogEvent {
  return {
    t: 'llm/call',
    agent: brand(agent),
    step: brand(step),
    model: brand('deepseek-flash/anthropic'),
    wire: 'anthropic-messages',
    thinking: null,
    toolCount: 9,
    invocations: 1,
    status: null,
    headers: null,
    usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 40 },
    rawStop: 'end_turn',
    stop: brand('end-turn'),
  }
}

/**
 * 30 族各一条。**族名从事件自己读**（`e.t`）——测试拿它这份夹具的族与源码那把尺对，
 * 于是"联合长了一族而夹具没跟上"也是红的。
 */
function oneOfEach(): StatusRow[] {
  reset()
  return [
    row({ t: 'view/write', agent: brand('agent/r1/1'), path: 'src/a.ts', rev: brand('v1'), blob: brand('bl1'), mode: 0o644 }, 'agent/r1/1'),
    row({ t: 'view/symlink', agent: brand('agent/r1/1'), path: 'src/link', rev: brand('v2'), target: 'src/a.ts' }, 'agent/r1/1'),
    row({ t: 'view/remove', agent: brand('agent/r1/1'), path: 'src/old.ts', rev: brand('v3') }, 'agent/r1/1'),
    row({ t: 'view/rename', agent: brand('agent/r1/1'), from: 'src/a.ts', to: 'src/b.ts', rev: brand('v4') }, 'agent/r1/1'),
    row({ t: 'view/chmod', agent: brand('agent/r1/1'), path: 'tools/x.sh', rev: brand('v5'), mode: 0o755 }, 'agent/r1/1'),
    row({ t: 'ckpt/commit', agent: brand('agent/r1/1'), commit: brand('c1'), rev: brand('v6'), msg: '写完了' }, 'agent/r1/1'),
    row({ t: 'mat/fork', agent: brand('agent/r1/1'), base: brand('c0'), strategy: brand('hardlink'), paths: [], hashes: [], ms: 12 }, 'agent/r1/1'),
    row({ t: 'mat/sync', agent: brand('agent/r1/1'), from: brand('v6'), to: brand('v7'), paths: ['src/b.ts'], hashes: ['h1'], ms: 8 }, 'agent/r1/1'),
    row({ t: 'mat/reclaim', agent: brand('agent/r1/1'), declared: ['src/b.ts'], changed: [] }, 'agent/r1/1'),
    row({ t: 'run/start', agent: brand('agent/r1/1'), step: brand('3'), action: 'bash', argv0: 'bash' }, 'agent/r1/1'),
    row({ t: 'run/end', agent: brand('agent/r1/1'), step: brand('3'), exit: 0, ms: 40, denied: false }, 'agent/r1/1'),
    row(
      {
        t: 'run/confined',
        agent: brand('agent/r1/1'),
        mode: brand('workspace-write'),
        enforcement: brand('full'),
        net: brand('none'),
        layers: [],
        reach: [],
      },
      'agent/r1/1',
    ),
    row({ t: 'agent/stop', agent: brand('agent/r1/1'), steps: 3, stopped: '收敛', handoffs: 0 }, 'agent/r1/1'),
    row(
      {
        t: 'agent/handoff',
        agent: brand('agent/r1/1'),
        successor: brand('agent/r1/2'),
        contract: brand('r1.implement.1'),
        digest: 'd1',
        body: '这一格干完了：src/a.ts 写完，断言在 tools/x.sh 里',
      },
      'agent/r1/1',
    ),
    row({ t: 'bound/deny', agent: brand('agent/r1/1'), path: 'src/c.ts', space: 'virtual', rule: 'contract-scope' }, 'agent/r1/1'),
    row({ t: 'signal', agent: brand('agent/r1/1'), id: 'sig1', kind: 'done', digest: 'd2' }, 'agent/r1/1'),
    row({ t: 'round/state', round: brand('r1'), from: brand('Idle'), to: brand('Planning') }),
    row({ t: 'round/intent', round: brand('r1'), base: brand('c0'), digest: 'd3', body: '给记账库加一条按天汇总' }),
    row({ t: 'holder/distill', round: brand('r1'), agent: brand('round'), digest: 'd4', body: '草案一版' }),
    row({ t: 'holder/todos', agent: brand('round'), digest: 'd5', body: '1 写 src/report.ts' }),
    row({ t: 'holder/plan', agent: brand('round'), digest: 'd6', body: '预备态做完了' }),
    row({ t: 'holder/ask', agent: brand('round'), digest: 'd7', body: '这条约束与目标冲突' }),
    row(
      { t: 'ask/raised', agent: brand('agent/r1/1'), contract: brand('r1.implement.1'), digest: 'd8', body: '{"questions":[]}' },
      'agent/r1/1',
    ),
    row(
      { t: 'ask/ruling', agent: brand('agent/r1/1'), asked: 'd8', forwarded: true, tier: 'design', ruler: 'ask-ruler-2', digest: 'd9', body: '{}' },
      'agent/r1/1',
    ),
    row({
      t: 'round/approve',
      round: brand('r1'),
      fingerprint: 'f0123456789abcdef',
      contracts: [brand('r1.implement.1'), brand('r1.implement.2')],
    }),
    row({
      t: 'contract/issue',
      round: brand('r1'),
      contract: brand('r1.implement.1'),
      owner: brand('agent/r1/1'),
      paths: ['src/report.ts', 'src/format.ts', 'tools/x.sh', 'README.md'],
      body: '{}',
    }),
    row({ t: 'merge/attempt', round: brand('r1'), branches: [brand('b1'), brand('b2')], conflicts: 0 }),
    row({
      t: 'merge/accept',
      round: brand('r1'),
      commit: brand('abcdef0123456789'),
      assertions: [
        { assertion: '缺省那一档', verdict: 'pass' },
        { assertion: '空表那一档', verdict: 'fail' },
        { assertion: '选项那一档', verdict: 'unrunnable' },
      ],
    }),
    row({ t: 'prefix/assemble', agent: brand('agent/r1/1'), zoneAHash: 'a', zoneBHash: 'b', zoneCHash: 'c' }, 'agent/r1/1'),
    row(llmCall('agent/r1/1', '1'), 'agent/r1/1'),
  ]
}

/**
 * ④ 那一份交错的账：只计数那几族夹在中间（跟随给的就是这种次序：一条路径流水夹在两条骨架之间）。
 * **这一份的正文都短**，所以那几行可以逐字写下来当黄金——太长的截断在下面单独量一处。
 */
function mix(): StatusRow[] {
  reset()
  return [
    row({
      t: 'round/intent',
      round: brand('r1'),
      base: brand('0123456789abcdef'),
      digest: 'd1',
      body: '给记账库加一条按天汇总\n第二条约束：别越界写',
    }),
    row(llmCall('agent/r1/1', '1'), 'agent/r1/1'),
    row({ t: 'round/state', round: brand('r1'), from: brand('Idle'), to: brand('Planning') }),
    row(
      { t: 'view/write', agent: brand('agent/r1/1'), path: 'src/report.ts', rev: brand('v1'), blob: brand('bl1'), mode: 0o644 },
      'agent/r1/1',
    ),
    row({ t: 'agent/stop', agent: brand('agent/r1/1'), steps: 3, stopped: '收敛', handoffs: 2 }, 'agent/r1/1'),
    row({ t: 'merge/attempt', round: brand('r1'), branches: [brand('b1'), brand('b2')], conflicts: 1 }),
    row({
      t: 'merge/accept',
      round: brand('r1'),
      commit: brand('abcdef0123456789'),
      assertions: [
        { assertion: '缺省那一档', verdict: 'pass' },
        { assertion: '空表那一档', verdict: 'pass' },
        { assertion: '选项那一档', verdict: 'unrunnable' },
      ],
    }),
  ]
}

/** ④ 的黄金：只计数那三族（`llm/call` · `view/write`）一条都不进历史。 */
const MIX_GOLDEN: readonly string[] = [
  'round 1 · 轮次 r1 · 意图「给记账库加一条按天汇总 第二条约束：别越界写」· 底 01234567…',
  'round 2 · 轮次 r1 · Idle → Planning',
  'agent/r1/1 3 · 格 agent/r1/1 · 3 步 · 停：收敛 · 交过 2 次接',
  'round 3 · 轮次 r1 · 合并尝试 2 条分支 · 冲突 1',
  'round 4 · 轮次 r1 · 合并接受 abcdef01… · 断言 3 条（过 2 / 没过 0 / 跑不起来 1）',
]

test('① 表与联合逐字对得上：30 族一个不多一个不少', () => {
  const src = familiesInSource()
  assert.deepEqual([...Object.keys(FAMILY_KIND)].sort(), src, '表的键与联合的族名不逐字相同（漏一族或多一族）')
  assert.equal(src.length, 30, `联合该是 30 族，源码里数出 ${src.length} 族`)
  const permanent = src.filter((f) => FAMILY_KIND[f as EventFamily] === 'permanent')
  assert.equal(permanent.length, 10, `进历史的那几族该是 10 族，表里数出 ${permanent.length} 族`)
  assert.deepEqual([...unclassified(src)], [], '表漏了这一族（联合里有、表上没有）')
  console.log(
    `① 读数：联合 ${src.length} 族 · 进历史 ${permanent.length} 族（${permanent.join(' · ')}）` +
      ` · 只进瞬态区 ${src.length - permanent.length} 族`,
  )
})

test('② 负对照 · 表漏一族：拆掉 round/state 当场报出它，联合那边多一族也报出', () => {
  const src = familiesInSource()
  const missing = unclassified(src, withoutFamily('round/state'))
  assert.deepEqual([...missing], ['round/state'], '把 round/state 从表里拆掉，却没有人报出来')
  const grown = unclassified([...src, 'round/gate'])
  assert.deepEqual([...grown], ['round/gate'], '联合长了一族（门自己那一条），表没跟上却没报出来')
  console.log(`② 读数：正着 ${unclassified(src).length} 族没分到 · 拆掉一族报出 ${missing.join(' · ')} · 联合多一族报出 ${grown.join(' · ')}`)
})

test('③ 负对照 · 挪一格：round/state 挪进"只计数"，那一趟历史里一条轮次转移都没有', () => {
  const m = mix()
  const lines = permanentLinesOf(m)
  assert.equal(lines.length, MIX_GOLDEN.length, '正着那一趟进历史的行数')
  assert.ok(lines.some((l) => l.includes('Idle → Planning')), `正着那一趟该有那条转移：${lines.join(' ｜ ')}`)
  const moved = permanentLinesOf(m, { ...FAMILY_KIND, 'round/state': 'transient' })
  assert.equal(moved.length, lines.length - 1, '挪走一族，历史该正好少一行')
  assert.equal(moved.some((l) => l.includes('Idle → Planning')), false, '挪进只计数了，历史里却还有那条转移')
  // 反面：只计数的那一族挪进"永久"——分法说它配得上一行历史，而渲染里没有它的写法，当场抛。
  assert.throws(
    () => permanentLinesOf([row(llmCall('agent/r1/1', '1'), 'agent/r1/1')], { ...FAMILY_KIND, 'llm/call': 'permanent' }),
    /这一族没有分到永久行：llm\/call/,
    'llm/call 挪进永久却没抛——那就成了静默给一个空行',
  )
  console.log(`③ 读数：正着 ${lines.length} 行（含 Idle → Planning）· round/state 挪进只计数 → ${moved.length} 行、转移没了 · llm/call 挪进永久 → 当场抛`)
})

test('④ 一条事件一行：逐字等于那一份原文 · 按到达序 · 换行折平 · 截断按族（意图与交接信 80，兜 40）', () => {
  const lines = permanentLinesOf(mix())
  assert.deepEqual([...lines], [...MIX_GOLDEN], '那一趟历史与黄金那一份不逐字节相同')
  assert.equal(lines.some((l) => l.includes('\n')), false, '有一行里带换行——终端历史里那就是两行')
  // 只计数那几族一条都不进历史：`llm/call` 与 `view/write` 各有一条夹在中间，黄金里没有它们。
  assert.equal(lines.some((l) => l.includes('src/report.ts')), false, '视图流水那一族进了历史')
  assert.equal(lines.some((l) => l.includes('调用')), false, '一次调用进了历史')

  reset()
  /** 「」之间的那一段正文。 */
  const bodyOf = (line: string): string => line.slice(line.indexOf('「') + 1, line.lastIndexOf('」'))
  // 45 字：旧限（40）会截在半句上，80 那一档放得下——**不再有 …**。
  const mid = bodyOf(
    (permanentLinesOf([
      row({ t: 'round/intent', round: brand('r1'), base: brand('c0'), digest: 'd', body: `第一行\n${'长'.repeat(45)}` }),
    ])[0] as string),
  )
  assert.ok(!mid.endsWith('…'), `45 字在按族那一档（80）不该再截：${mid}`)
  assert.equal([...mid].length, 49, `折平后该是「第一行 」3+1 加 45 字：${mid}`)
  // 100 字：超出 80 那一档照截，80 个字符加一个 …。
  const long = bodyOf(
    (permanentLinesOf([
      row({ t: 'round/intent', round: brand('r1'), base: brand('c0'), digest: 'd', body: '长'.repeat(100) }),
    ])[0] as string),
  )
  assert.ok(long.endsWith('…'), `太长的那一截该留一个 …：${long}`)
  assert.equal([...long].length, BODY_LIMIT['round/intent']! + 1, `正文该是 80 个字符加一个 …：${long}`)
  assert.equal(BODY_LIMIT['round/intent'], 80)
  assert.equal(BODY_LIMIT['agent/handoff'], 80, '交接信与意图同一档')
  console.log(`④ 读数：${lines.length} 行逐字等于黄金 · 45 字不截（49 字全文）· 100 字截成 80+… · 兜的默认 ${BODY_CHARS}`)
})

test('⑤ 一族一行都不少：夹具覆盖 30 族、进历史的正好那 10 族', () => {
  const rows = oneOfEach()
  const families = [...new Set(rows.map((r) => r.e.t))].sort()
  assert.deepEqual(families, familiesInSource(), '夹具没覆盖到每一族（新长的一族没有被喂进来）')
  const permanent = rows.filter((r) => FAMILY_KIND[r.e.t] === 'permanent')
  const lines = permanentLinesOf(rows)
  assert.equal(lines.length, permanent.length, '进历史的行数与表上分到永久那几族的条数对不上')
  assert.equal(lines.length, 10, `这一份夹具该有 10 条永久行，拿到 ${lines.length} 条`)
  for (let i = 0; i < permanent.length; i += 1) {
    const r = permanent[i] as StatusRow
    const line = lines[i] as string
    const prefix = `${r.pos.writer} ${r.pos.seq} · `
    assert.ok(line.startsWith(prefix), `第 ${i + 1} 行的前缀不是账上的坐标：${line}`)
    assert.ok(line.length > prefix.length, `第 ${i + 1} 行只有坐标、没有内容：${line}`)
    assert.equal(line.includes('undefined'), false, `第 ${i + 1} 行里漏了一栏（那一族没有写法）：${line}`)
    assert.equal(line.includes('\n'), false, `第 ${i + 1} 行里带换行：${line}`)
  }
  console.log(`⑤ 读数：夹具 ${families.length} 族 · 永久 ${lines.length} 行 · 逐行带坐标 · 最长 ${Math.max(...lines.map((l) => [...l].length))} 字`)
  console.log(`⑤ 那一趟历史：\n    ${lines.join('\n    ')}`)
})

test('⑥ 纯：两次逐字节相同、进去的 rows 一个字段都没被改 · 空账给空历史', () => {
  const rows = oneOfEach()
  const before = JSON.stringify(rows)
  const one = permanentLinesOf(rows)
  const two = permanentLinesOf([...rows])
  assert.deepEqual([...one], [...two], '同一份行两次不一样——那就不是纯函数')
  assert.equal(JSON.stringify(rows), before, '行被这一份改过了（读面不许写）')
  assert.deepEqual([...permanentLinesOf([])], [], '账上一条都没有时该给空历史')
  assert.equal(permanentLinesOf([row(llmCall('agent/r1/1', '1'), 'agent/r1/1')]).length, 0, '只有只计数那一族时该给空历史')
  console.log(`⑥ 读数：两次逐字节相同（${one.length} 行 · ${before.length} 字节的行两趟同值）· 空账 0 行 · 只有 llm/call 0 行 · 截断按族（80）兜 ${BODY_CHARS}`)
})
