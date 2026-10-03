// 本站 ④ · **成本台账的口径那一条**（本站的冻结面）。
//
// 跑法：`cd ~/fugue && node --test src/probe/ledger.test.ts`
//
// 它量的是**口径自不自足**，不是"实现跑得动"（从日志重算那一段随下一个提交进来）：
//
//   ① 两类调用 · 每一栏都指得出源，而且源点到的事件名**真在事件联合里**——口径写了一条联合里
//      没有的事件，当场红（"一处真相"要能被指着问出来；那条联合住 `src/log/events.ts`）。
//   ② 不进账的那几类逐条带理由与"什么条件下改主意"；**目录里不起进程的工具一个都不许漏**
//      （拿 `TOOL_NAMES` 当那一侧的尺：目录加了新工具而账没点名 → 红）。
//   ③ 钱写的是重算、耗时写的是区间读数，两条口径句都在，且都写了"没量到不拿 0 顶"。
//   ④ 这本账是**派生体**：模块自己不落盘（读它，看它有没有碰文件系统）。
//
// ⑤⑥ 量的是**从日志重算那一处折法**（`ledgerOf`）：两条路各配各的 · 分组键从同格同一步那条
//     `llm/call` 补 · 旧账那一档是「未量到」不是 0；以及「走法」那一栏两半各认什么（本站 ④
//     收口的那个缺口）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { LogEvent } from '../log/events.ts'
import { BUILTIN_CATALOG } from '../model/catalog.ts'
import { TOOL_NAMES } from '../tools/catalog.ts'
import { looksLikeDetour } from './metrics.ts'
import {
  EXCLUDED_CALLS,
  LEDGER_COLUMNS,
  LEDGER_HEAD,
  LEDGER_KINDS,
  LEDGER_SPAWNING_TOOLS,
  MONEY_HOW,
  TIME_HOW,
  ledgerLines,
  ledgerOf,
} from './ledger.ts'

const LEDGER_SRC = readFileSync(new URL('./ledger.ts', import.meta.url), 'utf8')
const EVENT_SRC = readFileSync(new URL('../log/events.ts', import.meta.url), 'utf8')

/** 事件联合里的名字——**从源里读**，与 `tools/check-events.js` 同一把尺，不另抄一份。 */
function unionNames(): string[] {
  const out: string[] = []
  for (const m of EVENT_SRC.matchAll(/t:\s*'([a-zA-Z]+\/[a-zA-Z]+)'/g)) {
    if (!out.includes(m[1] as string)) out.push(m[1] as string)
  }
  return out
}

test('① 两类调用 · 每一栏都指得出源，而且源点到的事件真在联合里', () => {
  assert.deepEqual([...LEDGER_KINDS], ['model', 'tool'], '一次「调用」就是这两类，没有第三类')
  const names = unionNames()
  const mentioned = new Set<string>()
  for (const kind of LEDGER_KINDS) {
    const cols = LEDGER_COLUMNS[kind]
    assert.ok(cols.length > 0, `${kind} 那一类一栏都没有`)
    for (const c of cols) {
      assert.notEqual(c.name, '', `${kind} 有一栏没有名字`)
      assert.ok(c.from.length > 8, `${kind} 的「${c.name}」那一栏没有写清源：${c.from}`)
      assert.notEqual(c.missing, '', `${kind} 的「${c.name}」那一栏没说清没量到时印什么`)
      // 先把"文件名"那一类抹掉（`probe/metrics.ts` 与事件名 `llm/call` 长得一样）——留下的是事件名。
      const text = c.from.replace(/[\w-]+\/[\w-]+\.(ts|js)\b/g, '')
      for (const m of text.matchAll(/([a-z]+\/[a-z]+)/g)) mentioned.add(m[1] as string)
    }
  }
  const unknown = [...mentioned].filter((n) => !names.includes(n))
  assert.deepEqual(unknown, [], `口径点到了事件联合里没有的事件：${unknown.join(' · ')}`)
  for (const n of ['llm/call', 'run/start', 'run/end']) {
    assert.ok(mentioned.has(n), `${n} 那一栏没有源点——两类调用各有一条主源`)
  }
  const total = LEDGER_KINDS.reduce((n, k) => n + LEDGER_COLUMNS[k].length, 0)
  console.log(`① 读数：两类共 ${total} 栏，源点到 ${mentioned.size} 个事件名，全在联合里；联合共 ${names.length} 个名字`)
})

test('② 不进账的那几类逐条带理由，目录里不起进程的工具一个都不许漏', () => {
  assert.ok(EXCLUDED_CALLS.length >= 4, `不进账的类别该逐条列出来：现在 ${EXCLUDED_CALLS.length} 条`)
  for (const x of EXCLUDED_CALLS) {
    assert.ok(x.calls.length > 4, `有一类没写名字：${JSON.stringify(x)}`)
    assert.ok(x.why.length > 20, `「${x.calls}」没说清为什么：${x.why}`)
    assert.ok(x.when.length > 10, `「${x.calls}」没写什么条件下改主意：${x.when}`)
  }
  const nonSpawning = TOOL_NAMES.filter((n) => !LEDGER_SPAWNING_TOOLS.includes(n))
  const head = EXCLUDED_CALLS[0]?.calls ?? ''
  const unlisted = nonSpawning.filter((n) => !head.includes(n))
  assert.deepEqual(unlisted, [], `目录里这几条不起进程、账上一条事件都没有，却没说：${unlisted.join(' · ')}`)
  console.log(`② 读数：不进账 ${EXCLUDED_CALLS.length} 类；目录 ${TOOL_NAMES.length} 条工具，起进程 ${LEDGER_SPAWNING_TOOLS.length} 条，其余 ${nonSpawning.length} 条在第一条里逐条点名`)
})

test('③ 钱是重算 · 耗时是区间读数，且都写了没量到时不算 0', () => {
  assert.ok(MONEY_HOW.includes('重算'), '钱那一栏的口径要说得出"读的时候重算"')
  assert.ok(/算不出来/.test(MONEY_HOW), '价目里没有这个模型要说"算不出来"')
  assert.ok(/不拿 0 顶/.test(MONEY_HOW), '缺一档不许拿 0 顶上去')
  assert.ok(TIME_HOW.includes('区间'), '耗时是区间读数')
  assert.ok(/不落任何时刻/.test(TIME_HOW), '信封上不落时刻这一条要写出来')
  assert.ok(/未量到/.test(TIME_HOW), '没量到的那一档是"未量到"')
  assert.ok(/重算/.test(LEDGER_HEAD), '表头那句话说得出这一本账是重算来的')
  assert.ok(/不采集/.test(LEDGER_HEAD), '表头那句话说得出它不是采集来的')
  console.log(`③ 读数：钱的进账口径 ${MONEY_HOW.length} 字，耗时的 ${TIME_HOW.length} 字，两条都在`)
})

test('④ 这本账是派生体：模块自己不落盘', () => {
  assert.ok(!/node:fs|node:fs\/promises/.test(LEDGER_SRC), '口径那一份不许碰文件系统')
  assert.ok(!/writeFileSync|appendFileSync|createWriteStream/.test(LEDGER_SRC), '账不落盘、不追加')
  // 读面那一句话：从日志重算。它得写在口径这一份里，读账的人不必去翻实现。
  assert.ok(/从日志重算/.test(LEDGER_HEAD), '表头要写明"从日志重算"')
  console.log('④ 读数：ledger.ts 不碰文件系统（不落盘、不追加），账是读的时候算出来的')
})

// ── ⑤⑥ 从日志重算那一处折法（`ledgerOf`）────────────────────────────────────

/** 一条 `llm/call`：只给这一份测试要读的那几栏。**不给 `ms` 就是旧账那一档**。 */
function llmOf(
  agent: string,
  step: string,
  o: { ms?: number; input?: number | null; cacheRead?: number | null; output?: number | null; model?: string } = {},
): LogEvent {
  return {
    t: 'llm/call',
    agent: agent as never,
    step: step as never,
    model: (o.model ?? 'deepseek-flash/anthropic') as never,
    wire: 'anthropic-messages',
    thinking: null,
    toolCount: 9,
    invocations: 0,
    usage: {
      inputTokens: o.input ?? 100,
      cacheReadTokens: o.cacheRead ?? 0,
      cacheWriteTokens: 0,
      outputTokens: o.output ?? 10,
      reasoningTokens: null,
    },
    rawStop: 'end_turn',
    stop: 'end-turn',
    status: null,
    headers: null,
    ...(o.ms === undefined ? {} : { ms: o.ms }),
  } as LogEvent
}

/** 起一次进程（`bash` 那一条的绑定名就是 `bash`·`round/driver.ts` 那一处）。 */
function runStartOf(agent: string, step: string, argv: readonly string[]): LogEvent {
  return { t: 'run/start', agent: agent as never, step: step as never, action: 'bash', argv0: argv[0] ?? '', argv } as LogEvent
}

/** 那一趟收尾（耗时与退出码的源）。 */
function runEndOf(agent: string, step: string, ms: number): LogEvent {
  return { t: 'run/end', agent: agent as never, step: step as never, exit: 0, ms, denied: false } as LogEvent
}

/** 读账的人递进来的那几样：价目 + 峰谷档（钱那一栏的源）。 */
const INPUTS = { cat: BUILTIN_CATALOG, phase: 'off-peak' as const }

test('⑤ 重算一本账：两条路各配各的 · 分组键从同格同一步那条 llm/call 补 · 没量到就是 null', () => {
  const rows = [
    llmOf('a1', '0', { ms: 41 }),
    runStartOf('a1', '0', ['/bin/sh', '-c', 'echo hi']),
    runEndOf('a1', '0', 3),
    llmOf('a1', '1'),
    runStartOf('a1', '1', ['/bin/sh', '-c', 'sleep 1']),
  ].map((e) => ({ e }))
  const l = ledgerOf(rows, INPUTS)
  assert.equal(l.calls.length, 4, `两条模型调用 + 两次起进程，实际 ${l.calls.length} 条`)
  assert.equal(l.events, 5)
  assert.deepEqual(
    l.calls.map((c) => c.kind),
    ['model', 'tool', 'model', 'tool'],
  )
  // 一 · `run/end` 那一条：耗时与退出码来自它自己，分组键来自同格同一步那条 `llm/call`。
  const t0 = l.calls[1]
  assert.equal(t0?.ms, 3)
  assert.equal(t0?.model, 'deepseek-flash/anthropic')
  assert.equal(t0?.wire, 'anthropic-messages')
  assert.equal(t0?.tool?.name, 'bash')
  assert.equal(t0?.tool?.exit, 0)
  assert.equal(t0?.tool?.denied, false)
  // 二 · 起了没落地那一条（日志从半截起读那一档）：**照样进账**，耗时与退出码是「未量到」。
  assert.equal(l.calls[3]?.tool?.name, 'bash')
  assert.equal(l.calls[3]?.ms, null)
  assert.equal(l.calls[3]?.tool?.exit, null)
  // 三 · 旧账那一档（没有 `ms` 那一栏）：未量到，而它数得出来。
  assert.equal(l.calls[2]?.ms, null)
  assert.equal(l.msSeen, 1)
  assert.equal(l.msMissing, 1)
  // 四 · 分组：这一份全在同一个（模型 · 线协议）里。
  assert.equal(l.groups.length, 1)
  const g = l.groups[0]
  assert.equal(g?.calls, 2)
  assert.equal(g?.toolCalls, 2)
  assert.equal(g?.ms, 44)
  assert.equal(g?.msMissing, 2)
  assert.equal(g?.tokens.input, 200)
  assert.equal(g?.usdMissing, 0)
  assert.ok((g?.usd ?? 0) > 0, `这一组该算得出钱：${String(g?.usd)}`)
  // 五 · **派生体**：同一串行重算两次逐字相同（不缓存、不碰时钟）。
  assert.deepEqual(ledgerOf(rows, INPUTS), l)
  // 六 · 价目里没有这个名字 → **算不出来**，不是 0。
  const unknown = ledgerOf([{ e: llmOf('a1', '0', { ms: 1, model: '（价目里没有这个名字）' }) }], INPUTS)
  assert.equal(unknown.calls[0]?.usd, null)
  assert.equal(unknown.groups[0]?.usdMissing, 1)
  console.log(
    `⑤ 读数：4 条调用（模型 2 · 工具 2）· 耗时合计 ${String(g?.ms)} ms（未量到 2 条）· 钱 ${String(g?.usd)}` +
      ` · 价目里没有的名字那一档 usd=${String(unknown.calls[0]?.usd)}`,
  )
})

test('⑥ 走法那一栏：老判据一个字没变，加进来的那一半只认「原样抄了那条命令行」', () => {
  const one = (bindings: readonly string[]): ReturnType<typeof ledgerOf> =>
    ledgerOf([{ e: runStartOf('a1', '0', ['make', 'build']) }], { ...INPUTS, bindings })
  // 一 · 老那一半：这一行里没有工具名 → 不判绕行（既有可见形态的读数不因修而变）。
  assert.equal(looksLikeDetour(['make', 'build']), false)
  assert.equal(one([]).calls[0]?.tool?.detour, false)
  // 二 · 新那一半：这一行就是**清单里那条命令行原样抄下来的** → 计入（归档 § 5.20 点的那个缺口）。
  assert.equal(one(['make build']).calls[0]?.tool?.detour, true)
  // 三 · 抄的不是那一条（多一个参数）就不认：判据是「原文在不在这一行里」，不是「像不像」。
  assert.equal(one(['make -j8 build']).calls[0]?.tool?.detour, false)
  // 四 · 老那一半照旧抓得住：命令里提到工具名，两半都不给也判绕行。
  const g = ledgerOf([{ e: runStartOf('a1', '0', ['/bin/sh', '-c', 'grep -n x a.ts']) }], INPUTS)
  assert.equal(g.calls[0]?.tool?.detour, true)
  // 五 · 读账的人没递绑定：账自己把「只有一半」说出来（**少一份读数不许静默**）。
  assert.equal(g.boundCommands, 0)
  assert.ok(
    ledgerLines(g).some((t) => t.includes('走法那一栏只用了')),
    `少了那一半要说出来：\n${ledgerLines(g).join('\n')}`,
  )
  assert.equal(
    ledgerLines(one(['make build'])).some((t) => t.includes('走法那一栏只用了')),
    false,
    '递了绑定就不该说少',
  )
  console.log(
    '⑥ 读数：`make build` 原样抄给 bash —— 不给绑定 false · 给绑定 true · 多一个参数 false；' +
      '命令里有工具名那一半照旧 true',
  )
})
