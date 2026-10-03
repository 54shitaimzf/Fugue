// 0.3.0 ④ · **成本台账的口径那一条**（本站的冻结面）。
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
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { TOOL_NAMES } from '../tools/catalog.ts'
import {
  EXCLUDED_CALLS,
  LEDGER_COLUMNS,
  LEDGER_HEAD,
  LEDGER_KINDS,
  LEDGER_SPAWNING_TOOLS,
  MONEY_HOW,
  TIME_HOW,
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
