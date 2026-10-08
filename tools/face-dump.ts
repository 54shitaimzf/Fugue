// TUI 人读面的**样张转储**（取证件，不是产品的一部分）。出处：0.4.3 施工单 § 一 的硬顺序第一条
// ——主面改词与布局重排之前，先把今天的人读面按一张固定的输入转储成文本，改完再转一次，
// 两份对着读就是交付要求里的"改词前后并排"。
//
// 跑法：cd ~/fugue && node tools/face-dump.ts [--width <列>]
//
// 它只做三件事：拼一份固定的账（下面 `ROWS`）· 按几张固定的尺寸与几种弹层状态各折一帧 ·
// 把帧与它下面那块区域的**字节流**原样印出来。**它一个断言都不下**——判决归 `src/ui/*.test.ts`
// 那几处，这一份只给人看。
//
// 高度取**真终端上框的那 10 行**（`ui/layout.ts` 的 `FRAME_ROWS`，一处真源）：第二幕 ⑦ 起框自己
// 就填满这一屏，给一个更大的高度画出来的只是「内容几行 + 其余全空」，不是人真正看见的那一眼。
//
// 输入是**这一份自己的**（不 import 任何 `.test.ts`）：样张要能独立于断言长出来，两边同时漂
// 才说明不了问题。折法与渲染一律走产品那几处（`probe/status.ts` · `ui/frame.ts` · `ui/term.ts`），
// 这一份不另写一份排版。
import type { LogEvent } from '../src/log/events.ts'
import type { StatusRow } from '../src/probe/status.ts'
import { statusOf } from '../src/probe/status.ts'
import { frameOf } from '../src/ui/frame.ts'
import type { FrameInput } from '../src/ui/frame.ts'
import { permanentLinesOf } from '../src/ui/stream.ts'
import { openTerm } from '../src/ui/term.ts'
import type { TermOut } from '../src/ui/term.ts'
import { FRAME_ROWS } from '../src/ui/layout.ts'

let seq = 0
const row = (e: LogEvent, w = 'round'): StatusRow => ({ pos: { writer: w, seq: (seq += 1) }, e })

/** 一份小账：一条轮次链 · 两格的调用 · 两条契约 · 一次冲突 · 一次带三条验收的合并。 */
function rowsOf(): StatusRow[] {
  seq = 0
  const out: StatusRow[] = []
  const chain: readonly (readonly [string, string])[] = [
    ['Idle', 'Planning'],
    ['Planning', 'Delegated'],
    ['Delegated', 'Working'],
    ['Verifying', 'Working'],
    ['Verifying', 'Rebuilding'],
  ]
  for (const [from, to] of chain) {
    out.push(row({ t: 'round/state', round: 'r1' as never, from: from as never, to: to as never }))
  }
  out.push(row({ t: 'round/intent', round: 'r1' as never, base: 'deadbee' as never, digest: 'd0', body: '把外观草稿的色位落到账尾' }))
  const calls: readonly (readonly [string, string, number, number | null])[] = [
    ['agent/r1/1', '1', 2, 2048],
    ['agent/r1/1', '2', 1, 2048],
    ['agent/r1/2', '1', 3, 0],
  ]
  for (const [agent, step, invocations, cacheRead] of calls) {
    out.push(
      row(
        {
          t: 'llm/call',
          agent: agent as never,
          step: step as never,
          model: 'deepseek-flash/anthropic' as never,
          wire: 'anthropic-messages',
          toolCount: 9,
          invocations,
          status: null,
          headers: null,
          usage: { inputTokens: 1000, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 40 },
          rawStop: 'end_turn',
          stop: 'end-turn',
        },
        agent,
      ),
    )
  }
  out.push(row({ t: 'agent/stop', agent: 'agent/r1/1' as never, steps: 2, stopped: '收敛', handoffs: 0 }, 'agent/r1/1'))
  out.push(
    row({
      t: 'contract/issue',
      round: 'r1' as never,
      contract: 'r1.implement.1' as never,
      owner: 'agent/r1/1' as never,
      paths: [],
      body: '{}',
    }),
  )
  out.push(
    row({
      t: 'contract/issue',
      round: 'r1' as never,
      contract: 'r1.implement.2' as never,
      owner: 'agent/r1/2' as never,
      paths: [],
      body: '{}',
    }),
  )
  out.push(row({ t: 'merge/attempt', round: 'r1' as never, branches: [] as never, conflicts: 0 }))
  out.push(
    row({
      t: 'merge/accept',
      round: 'r1' as never,
      commit: 'abc1234d' as never,
      assertions: [
        { assertion: '缺省那一档', verdict: 'pass', note: '' },
        { assertion: 'options 那一档', verdict: 'pass', note: '' },
        { assertion: 'README 用法那一句', verdict: 'fail', note: '' },
      ],
    } as never),
  )
  return out
}

const ROWS = rowsOf()
const SNAPSHOT = statusOf(ROWS)
const PERMANENT = permanentLinesOf(ROWS)
const METRICS = [
  { metric: 'detour-rate' as never, value: 0, numerator: 0, denominator: 2, how: '' },
  { metric: 'prefix-hit-rate' as never, value: 1, numerator: 3, denominator: 3, how: '' },
]
const REPORT = [
  { metric: 'conflicts' as never, count: 0, how: '' },
  { metric: 'rejects' as never, count: 1, how: '' },
  { metric: 'denied' as never, count: 0, how: '' },
]

const base = (width: number, height: number): FrameInput => ({
  snapshot: SNAPSHOT,
  metrics: METRICS,
  report: REPORT,
  permanent: PERMANENT,
  width,
  height,
})

/**
 * 几张样张（第二幕 ⑦ 之后是三档视图各一张，加窄屏 · 矮屏 · 太矮 · 候选那一层 · 阅读面 ·
 * 门口那一块 + 树）。**三档各印一张**是这一份的主要用处：交付要求里的「主面样张改词前后
 * 并排」看的就是对话视图那一张，另两档是 `Tab` 轮换出去的视图。
 */
function corpus(width: number): readonly (readonly [string, FrameInput])[] {
  const wide = width
  const narrow = Math.max(20, Math.min(40, width))
  return [
    ['主面 · 对话视图（缺省那一档）', base(wide, FRAME_ROWS)],
    ['对话视图（80 列）', base(80, FRAME_ROWS)],
    ['对话视图（窄屏）', base(narrow, FRAME_ROWS)],
    ['进展视图（`Tab` 第一档）', { ...base(wide, FRAME_ROWS), view: 'progress' }],
    ['结果与花费视图（`Tab` 第二档）', { ...base(wide, FRAME_ROWS), view: 'spending' }],
    ['矮屏（高度 8）', base(wide, 8)],
    ['太矮（高度 4）', base(wide, 4)],
    [
      '候选那一层（/ 菜单开着）',
      {
        ...base(wide, FRAME_ROWS),
        menu: { rows: ['/status 一次快照', '/watch 跟着看', '/tui 第二档渲染', '/log 抄本', '/read 读一份', '/diff 看差异', '/commit 提交'], sel: 2 },
      },
    ],
    [
      '阅读面（T9）',
      {
        ...base(wide, FRAME_ROWS),
        read: { rows: ['阅读面 · 轮次 r1', '  第 1 行', '  第 2 行', '  第 3 行', '  第 4 行', '  第 5 行', '  第 6 行', '  第 7 行', '  第 8 行', '  第 9 行'], top: 0 },
      },
    ],
    [
      '门口那一块 + 树（在进展视图里——对话视图那一档不印树）',
      {
        ...base(wide, FRAME_ROWS),
        view: 'progress',
        nav: { rows: ['▸ 主线', '  agent/r1/1', '  agent/r1/2'], sel: 0 },
        bottom: { rows: ['门口停着：2 份契约等你点头', '  r1.implement.1 → agent/r1/1', '  r1.implement.2 → agent/r1/2', 'y 放行 · n 拒 · Esc 中止'], keep: 2 },
      },
    ],
  ]
}

/** 假终端：收下每一笔，`--full` 那两笔之外原样留着。 */
function fakeOut(columns: number, rows: number): TermOut & { written: string[] } {
  const written: string[] = []
  return { written, isTTY: true, columns, rows, write: (s: string) => void written.push(s) }
}

function main(): void {
  const at = process.argv.indexOf('--width')
  const width = at === -1 ? 100 : Number(process.argv[at + 1])
  const out: string[] = []
  for (const [name, input] of corpus(width)) {
    const f = frameOf(input)
    out.push(`=== ${name} · ${input.width}x${input.height} → ${f.lines.length} 行 ===`)
    for (const line of f.lines) out.push(line)
    out.push(`--- 行角色：${f.roles.join(' ')}`)
    out.push('')
  }
  // 字节流那一档：真终端那一块区域摆出来的**字节**（面板 K 行 + 一行输入行）。
  const f = fakeOut(width, 40)
  const term = openTerm({ out: f, term: 'xterm-256color' })
  term.draw([], (size) => frameOf({ ...base(size.columns, size.height), width: size.columns, height: size.height }).lines)
  out.push(`=== 字节流（真终端那一档 · K=${term.height} · ${width} 列） ===`)
  out.push(JSON.stringify(f.written.join('')))
  out.push('')
  process.stdout.write(out.join('\n'))
}

main()
