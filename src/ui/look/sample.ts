// 外观草稿（**素材，未接线**）· 色位落到真内容上：同一份快照，0.4.3 的样子。
//
// 出处：ROADMAP § 5 的 0.4.3 行 ②（色位怎么落）。`frame.ts` 的 `bodyOf` 出的是整句的字串——色位
// 落不进去；这一份照它的次序与措辞**重写成片**，把「哪几个字该上哪一格」一处写明：
//
//   · 轮次的状态按图上的位置落格：`Committed` 成功 · `Aborted` 错误 · `Idle` 正文 · 其余（规划 ·
//     派活 · 干活 · 验收 · 合并 · 重建）都是「运行中/等待」；
//   · 计数只在**非零**时上色：冲突 · 没过 · 打回 · 拒——零个错误就不该是红的；过了几条是绿的；
//   · 边上的箭头与「（跳步，经 …）」那半句是骨架，弱化；分子/分母弱化；
//   · 账尾 = 状态标记 + 永久行原文（`footerOf` 那一份，不另写）+ 靠右弱化的条数。
//
// **零数据路径**：进来的是已经折好的快照（`probe/status.ts` 的 `statusOf` 那一份）与界面那几样纯视图
// 状态；这一份一次 IO 都不做、一个字节都不写。它的消费者只有预览（`tools/look-preview.ts`）与
// `look.test.ts`。
import type { MetricValue } from '../../probe/metrics.ts'
import type { MetricReading } from '../../probe/round.ts'
import type { AgentStatus, RoundTrail, StatusSnapshot } from '../../probe/status.ts'
import type { RoundState } from '../../terms.ts'
import { footerOf, windowOf } from '../frame.ts'
import type { NavNode } from '../nav.ts'
import { iconOf } from './icons.ts'
import type { IconName } from './icons.ts'
import type { Column, FooterInput, LookInput } from './layout.ts'
import type { Line, Span } from './paint.ts'
import { foldNote, joinLine, sp } from './paint.ts'
import type { Slot } from './palette.ts'
import type { IconTier } from './tier.ts'

/** 轮次状态落哪一格。 */
function stateSlot(s: RoundState): Slot {
  if (s === 'Committed') return 'ok'
  if (s === 'Aborted') return 'bad'
  if (s === 'Idle') return 'body'
  return 'wait'
}

/** 轮次状态配哪个图标（`Idle` 不配：没有在发生的事）。`Planning` 是门停的地方（`stream.ts` 头注）。 */
function stateIcon(s: RoundState): IconName | null {
  if (s === 'Committed') return 'ok'
  if (s === 'Aborted') return 'fail'
  if (s === 'Idle') return null
  if (s === 'Planning') return 'gate'
  return 'run'
}

/** 一个计数：非零才上那一格。 */
function count(n: number, slot: Slot): Span {
  return sp(String(n), n > 0 ? slot : 'body')
}

/** 图标那一片 + 一个空格（空格给 Nerd Font 的字形溢出去）。 */
function iconSpans(name: IconName, icons: IconTier): Span[] {
  return [iconOf(name, icons), sp(' ')]
}

function roundLine(r: RoundTrail, current: string | null): Line {
  const parts: Line[] = [
    [sp(`轮次 ${r.round}`)],
    [sp('状态 '), sp(r.state, stateSlot(r.state))],
    [sp(`转移 ${r.transitions} 条`)],
  ]
  if (r.hops !== r.transitions) parts.push([sp(`跳步 ${r.hops - r.transitions}`)])
  parts.push([sp('打回 '), count(r.rejects, 'bad'), sp(' 次')])
  if (r.round === current) parts.push([sp('最近一条落在这一轮', 'muted')])
  return joinLine(parts)
}

/** 一条边：状态名是正文，箭头与括号里那半句是骨架。 */
function edgeLine(e: string): Line {
  return [sp('  '), ...e.split(/(──\S*?──>|⇒|（[^）]*）)/).map((x, i) => sp(x, i % 2 === 1 ? 'muted' : 'body'))]
}

function agentLine(a: AgentStatus, icons: IconTier): Line {
  const stop: Line =
    a.stopped === null ? [sp('没停', 'wait')] : [sp(`${a.stopSteps ?? '?'} 步 · `), sp(a.stopped, 'ok')]
  return [
    ...iconSpans(a.stopped === null ? 'run' : 'ok', icons),
    ...joinLine([
      [sp(`格 ${a.agent}`)],
      [sp(`调 ${a.calls} 次`)],
      [sp(`${a.steps} 步`)],
      [sp(`工具调用 ${a.invocations}`)],
      [sp(`动作 ${a.actions}`)],
      [sp('停：'), ...stop],
    ]),
  ]
}

/** 用量那一栏的一个数：量到的和 + 没量到的条数（与 `frame.ts` 的 `usageText` 同口径）。 */
function usage(t: { readonly total: number; readonly missing: number }): Line {
  return t.missing > 0 ? [sp(String(t.total)), sp(`（缺 ${t.missing} 条）`, 'muted')] : [sp(String(t.total))]
}

/** 右栏：读数（次序与 `frame.ts` 的 `bodyOf` 相同——先记账，再八元，再打回三数）。 */
function readingsOf(s: StatusSnapshot, metrics: readonly MetricValue[], report: readonly MetricReading[]): Line[] {
  const out: Line[] = []
  out.push(
    joinLine([
      [sp(`契约 ${s.contracts}`)],
      [sp(`折叠尝试 ${s.attempts}`)],
      [sp('冲突 '), count(s.conflicts, 'bad')],
      [
        sp(`验收 ${s.accepts.accepts} 次（过 `),
        count(s.accepts.pass, 'ok'),
        sp(' / 没过 '),
        count(s.accepts.fail, 'bad'),
        sp('）'),
      ],
    ]),
  )
  const u = s.usage
  out.push(
    joinLine([
      [sp(`用量 调用 ${u.calls}`)],
      [sp('input '), ...usage(u.inputTokens)],
      [sp('cacheRead '), ...usage(u.cacheReadTokens)],
      [sp('cacheWrite '), ...usage(u.cacheWriteTokens)],
      [sp('output '), ...usage(u.outputTokens)],
      [sp('思考 '), ...usage(u.reasoningTokens)],
    ]),
  )
  for (const m of metrics) {
    out.push([
      sp(`${m.metric} `),
      m.value === null ? sp('算不出来', 'muted') : sp(String(m.value)),
      sp(`（${m.numerator ?? '—'}/${m.denominator ?? '—'}）`, 'muted'),
    ])
  }
  if (report.length > 0) {
    out.push([sp('打回 '), ...joinLine(report.map((r) => [sp(`${r.metric} `), count(r.count, 'bad')]))])
  }
  return out
}

/** 树那几行：选中那个落命中格（`▸`），节点配图标（主线 · 在跑 · 停了）。 */
function navLinesOf(nodes: readonly NavNode[], at: number, s: StatusSnapshot, icons: IconTier): Line[] {
  const win = windowOf(nodes.length, at, 4)
  const out: Line[] = []
  for (let i = win.from; i < win.from + win.count; i += 1) {
    const n = nodes[i] as NavNode
    const agent = s.agents.find((a) => a.agent === n.writer)
    const icon: IconName = n.depth === 0 ? 'line' : agent === undefined ? 'agent' : agent.stopped === null ? 'run' : 'ok'
    const sel = i === at
    out.push([
      sp(sel ? '▸ ' : '  ', sel ? 'hit' : 'body'),
      sp(' '.repeat(n.depth * 2)),
      ...iconSpans(icon, icons),
      sp(n.label, sel ? 'hit' : 'body'),
    ])
  }
  if (win.summary) out.push(foldNote(win.above + win.below, '条', ['Tab 循环', 'Alt-1…9 直选']))
  return out
}

/** 候选那一层：候选落弹层格，选中那条落命中格；装不下开窗，末行是折叠标记。 */
function menuLinesOf(rows: readonly string[], sel: number, cap: number): Line[] {
  if (rows.length === 0) return [[sp('（没有匹配的）', 'muted')]]
  const at = Math.max(0, Math.min(rows.length - 1, sel))
  const win = windowOf(rows.length, at, cap)
  const out: Line[] = []
  for (let i = win.from; i < win.from + win.count; i += 1) {
    out.push(i === at ? [sp(`▸ ${rows[i] as string}`, 'hit')] : [sp(`  ${rows[i] as string}`, 'overlay')])
  }
  if (win.summary) out.push(foldNote(win.above + win.below, '条', ['↑↓ 翻', `选中第 ${at + 1} 条`]))
  return out
}

/** 门口那一块：预览是正文，队列行落等待格（门在等你），选项行落弹层格。 */
function gateLinesOf(g: GateInput, icons: IconTier): Line[] {
  return [
    ...g.preview.map((one) => [sp(one)]),
    [...iconSpans('gate', icons), sp(g.queue, 'wait')],
    [sp(g.option, 'overlay')],
  ]
}

/** 账尾：状态标记（当前那一轮的状态）+ 永久行原文 + 靠右的条数。 */
function footerInputOf(s: StatusSnapshot, permanent: readonly string[] | undefined, icons: IconTier): FooterInput {
  const now = s.rounds.find((r) => r.round === s.current)
  const name = now === undefined ? null : stateIcon(now.state)
  return {
    mark: name === null ? null : iconOf(name, icons),
    text: [sp(footerOf(s, permanent))],
    tail: [sp(`事件 ${s.events} 条`, 'muted')],
  }
}

export interface GateInput {
  readonly preview: readonly string[]
  readonly queue: string
  readonly option: string
}

export interface SampleInput {
  readonly snapshot: StatusSnapshot
  readonly metrics?: readonly MetricValue[]
  readonly report?: readonly MetricReading[]
  /** 永久行那一栏（账尾印它最后一条，`footerOf` 那一条规矩）。 */
  readonly permanent?: readonly string[]
  readonly nav?: { readonly nodes: readonly NavNode[]; readonly at: number }
  readonly menu?: { readonly rows: readonly string[]; readonly sel: number; readonly cap?: number }
  readonly gate?: GateInput
  /** 阅读面：开着时整块地方给它（单栏 · 框名落标题格），与 `frame.ts` 同一条。 */
  readonly read?: { readonly rows: readonly Line[]; readonly top?: number }
  readonly hint?: string
  /** 图标那一档；不给就是 ASCII（地板——「没有图标这一档」与开关关着是同一份输出）。 */
  readonly icons?: IconTier
  readonly width: number
  readonly height?: number
}

/** 同一份快照 → 0.4.3 的样子（`layout.ts` 的入参）。 */
export function sampleLookOf(o: SampleInput): LookInput {
  const s = o.snapshot
  const icons: IconTier = o.icons ?? 'ascii'
  const situation: Line[] = []
  if (s.rounds.length === 0) situation.push([sp('还没开过轮次（账上一条 round/state 都没有）', 'muted')])
  for (const r of s.rounds) {
    situation.push(roundLine(r, s.current))
    for (const e of r.edges) situation.push(edgeLine(e))
    if (r.unrouted > 0) situation.push([sp(`  （图上走不通的 ${r.unrouted} 条：账与图对不上）`, 'bad')])
  }
  const agents = s.agents.map((a) => agentLine(a, icons))
  const tree = o.nav === undefined ? [] : navLinesOf(o.nav.nodes, o.nav.at, s, icons)

  let columns: readonly Column[]
  if (o.read !== undefined && o.read.rows.length > 0) {
    const top = Math.max(0, Math.min(o.read.top ?? 0, o.read.rows.length - 1))
    columns = [{ name: '阅读面', heading: true, blocks: [o.read.rows.slice(top)], fold: ['↑↓ 翻', 'Esc 收起'] }]
  } else {
    columns = [
      { name: '处境', blocks: [tree, situation, agents] },
      { name: '读数', blocks: [readingsOf(s, o.metrics ?? [], o.report ?? [])] },
    ]
  }
  const wide = [
    ...(o.menu === undefined ? [] : menuLinesOf(o.menu.rows, o.menu.sel, o.menu.cap ?? 6)),
    ...(o.gate === undefined ? [] : gateLinesOf(o.gate, icons)),
  ]
  return {
    columns,
    ...(wide.length > 0 ? { wide, wideKeep: o.gate === undefined ? 0 : 2 } : {}),
    footer: footerInputOf(s, o.permanent, icons),
    ...(o.hint === undefined ? {} : { hint: [sp(o.hint, 'muted')] }),
    width: o.width,
    ...(o.height === undefined ? {} : { height: o.height }),
  }
}
