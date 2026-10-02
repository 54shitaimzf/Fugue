// 0.2.8 U4 · 收尾钩子：**挂的时机是这一份的性质**。
// 跑法：cd ~/fugue && node --test src/ui/exit-hooks.test.ts
//
//   ① **挂什么**：`SIGTERM` / `SIGHUP` 经 `on` · `exit` 经 `once`（那一条只该来一次）；两条分别接到
//      「递给在途那一趟」与「把终端还原回去」；`close()` 把信号那两个摘掉而且幂等（收尾那一路正常退
//      与 `finally` 都会走到它）。负对照：`removeListener` 那一句删掉 → ① 红。
//   ② **挂的时机**：`observe.ts` 里这一组排在 `openTui(` 与 `openKeys(` 之前——首帧之前收到的
//      `SIGTERM` 会走缺省的杀进程路径，`--full` 那一档那台终端就被留在另一块屏上（还原终端全靠
//      `term.close()`）。负对照：把那一块挪到 `ui.tui = tui` 之后（U4 之前那个顺序）→ ② 当场红。
//
// 顺序为什么在**源码里**量：它就是"哪一行在前"这件事本身，而主进程上那几条真信号要开一个真终端
// 才量得到——那正是路线图 0.2.8 行说的"视觉验收归实现者"那一档，程序侧不建快照出口。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { EXIT_SIGNALS, openExitHooks } from './exit-hooks.ts'
import type { HookHost } from './exit-hooks.ts'

/** 一个只记账的假 `process`：挂了什么 · 摘了什么 · 触发时调到了谁。 */
function hostOf(): { host: HookHost; calls: string[]; fire: (ev: string) => void } {
  const handlers = new Map<string, (() => void)[]>()
  const calls: string[] = []
  const add = (ev: string, f: () => void): void => {
    handlers.set(ev, [...(handlers.get(ev) ?? []), f])
  }
  return {
    calls,
    host: {
      on(ev: 'SIGTERM' | 'SIGHUP', f: () => void): void {
        calls.push(`on ${ev}`)
        add(ev, f)
      },
      once(ev: 'exit', f: () => void): void {
        calls.push(`once ${ev}`)
        add(ev, f)
      },
      removeListener(ev: 'SIGTERM' | 'SIGHUP', f: () => void): void {
        calls.push(`off ${ev}`)
        handlers.set(ev, (handlers.get(ev) ?? []).filter((one) => one !== f))
      },
    },
    fire(ev: string): void {
      for (const f of handlers.get(ev) ?? []) f()
    },
  }
}

test('① 挂什么：两条信号经 `on` · `exit` 经 `once` · 各接该接的那一个；`close()` 摘信号且幂等', () => {
  const { host, calls, fire } = hostOf()
  let signalled = 0
  let exited = 0
  const hooks = openExitHooks(host, {
    onSignal: () => {
      signalled += 1
    },
    onExit: () => {
      exited += 1
    },
  })

  assert.deepEqual([...hooks.signals], [...EXIT_SIGNALS], '信号名单只有一处（`EXIT_SIGNALS`）')
  assert.deepEqual([...calls], ['on SIGTERM', 'on SIGHUP', 'once exit'], '挂的顺序与形状：两条信号 + 一条 exit')
  fire('SIGTERM')
  fire('SIGHUP')
  assert.equal(signalled, 2, '两条信号都递到 `onSignal`（一条都不许漏）')
  assert.equal(exited, 0, '信号那条路不该走到"还原终端"上')
  fire('exit')
  assert.equal(exited, 1, '`exit` 那一条接到 `onExit`')

  const before = calls.length
  hooks.close()
  assert.deepEqual(calls.slice(before), ['off SIGTERM', 'off SIGHUP'], '`close()` 把两条信号摘掉')
  hooks.close()
  assert.equal(calls.length, before + 2, '`close()` 幂等（第二遍一个字节都不动）')
  assert.ok(!calls.includes('off exit'), '`exit` 那一条不摘（它是 `once`，本来只来一次）')
  // **负对照**：`removeListener` 那一句删掉 → 上面那两条 `off …` 当场不在（跑一遍就能看见）。
  console.log(`① 读数：${calls.join(' → ')} · 信号 2 条各递到一次 · exit 一次 · close 幂等`)
})

/** `src` 里含 `needle` 的第一行是第几行（1 基）；找不到是 `-1`。 */
function at(src: string, needle: string): number {
  const list = src.split('\n')
  return list.findIndex((l) => l.includes(needle)) + 1
}

test('② 挂的时机：`observe.ts` 里这一组排在开首帧与进 raw mode 之前（负对照：挪回旧顺序当场红）', () => {
  const src = readFileSync(new URL('../cli/cmd/observe.ts', import.meta.url), 'utf8')
  const hook = at(src, 'openExitHooks(process')
  const frame = at(src, 'const tui = openTui({')
  const typing = at(src, 'keys = openKeys({')
  const decl = at(src, 'let keys: KeySource | null = null')
  assert.ok(hook > 0 && frame > 0 && typing > 0 && decl > 0, `四个锚点都要找得到（${hook}/${frame}/${typing}/${decl}）`)
  console.log(`② 读数：observe.ts 第 ${decl} 行声明 keys · 第 ${hook} 行挂钩子 · 第 ${frame} 行开首帧 · 第 ${typing} 行进 raw mode`)
  assert.ok(hook < frame, `钩子要挂在开首帧之前（第 ${hook} 行 vs 第 ${frame} 行）`)
  assert.ok(hook < typing, `也要挂在进 raw mode 之前（第 ${hook} 行 vs 第 ${typing} 行）`)
  assert.ok(decl < hook, '`keys` 先声明再挂钩子（钩子那一下引用它，落在 TDZ 里会当场抛）')
  assert.ok(at(src, 'hooks?.close()') > frame, '收尾那一处照旧在 `finally` 里（挂在前面不等于收尾挪走）')

  // **负对照**：把 `const hooks = … : null` 那一块挪到 `ui.tui = tui` 之后（U4 之前那个顺序）——
  // 同一条判据当场翻假。这一条证明上面那个 `hook < frame` 抓得住"还原旧顺序"这个变异。
  const lines = src.split('\n')
  const from = lines.findIndex((l) => l.includes('const hooks ='))
  const span = lines.slice(from).findIndex((l) => l.trim() === ': null')
  assert.ok(from > 0 && span >= 0, '那一块的起止都找得到')
  const block = lines.slice(from, from + span + 1)
  const rest = [...lines.slice(0, from), ...lines.slice(from + span + 1)]
  const after = rest.findIndex((l) => l.includes('ui.tui = tui')) + 1
  const old = [...rest.slice(0, after), ...block, ...rest.slice(after)].join('\n')
  assert.ok(at(old, 'ui.tui = tui') > 0, '挪过去之后 `ui.tui = tui` 还在')
  assert.ok(
    at(old, 'openExitHooks(process') > at(old, 'const tui = openTui({'),
    '旧顺序：钩子排在开首帧之后——这条判据抓得住它',
  )
})
