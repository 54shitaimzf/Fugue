#!/usr/bin/env node
// 环节黑箱档案：**把每个环节当黑箱，把它实际发出去的输入纪律与它交出来的输出契约摆在一起**。
// 跑法：cd ~/fugue && node tools/stage-io.ts <工作区根> [--json]
//
// 由头（逐环节黑箱校正那一站的第一条命令）：调提示词之前要有一个**可对比的基准面**——同一个
// 环节两次之间变的是哪几样：三区字节（`prefixOf`）· 输出契约（`contract/issue` 的正文）·
// 停因（收敛还是撞上界）· 成本（调用数与四个 token 数）。没有这个面，改一句话只能靠感觉。
//
// **纯读**：只 `openLog` 读，不发一次网、不写一个字节、不加运行时依赖。三样各有唯一取值处，
// 一处都不在这里另立：三区纪律在 `src/probe/prefix.ts`，处境与用量在 `src/probe/status.ts`，
// 打回三数在 `src/probe/round.ts`。
//
// 环节是**从日志里认出来的**，不另立一张表：`round` 那一份日志上是持轮者之拆；每个
// `agent/r<轮>/<序>` 是那一格，它干什么由 `contract/issue` 的 `owner` 指回契约（正文里那个
// `kind` 就是"改码/查现状/解冲突"）。
import { openLog } from '../src/log/log.ts'
import type { LogEvent } from '../src/log/events.ts'
import { prefixOf } from '../src/probe/prefix.ts'
import type { PrefixRow } from '../src/probe/prefix.ts'
import { statusOf } from '../src/probe/status.ts'
import { computeAll } from '../src/probe/round.ts'

const args = process.argv.slice(2)
const root = args.find((a) => a !== '--json')
const asJson = args.includes('--json')
if (root === undefined || root === '') {
  console.error('跑法：node tools/stage-io.ts <工作区根> [--json]')
  process.exit(2)
}

const rows: PrefixRow[] = []
for await (const r of openLog(root).readMerged()) rows.push(r)
const st = statusOf(rows)
const prefix = prefixOf(rows)
const readings = await computeAll(async function* () {
  for (const r of rows) yield r
}, {})

/** 一份契约的正文（JSON）——**只有它说了这一格该交什么**。解析不了就如实说，不当成没有。 */
function parsedBody(e: LogEvent): Record<string, unknown> | null {
  if (e.t !== 'contract/issue') return null
  try {
    return JSON.parse(e.body) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 契约里那三栏的名字（`deliverables` 取 `path` · `assertions` 取 `name` · `evidenceRequired` 取 `note`）。 */
function namesIn(body: Record<string, unknown> | null, key: string, field: string): readonly string[] {
  const list = body?.[key]
  if (!Array.isArray(list)) return []
  return list.map((x) => {
    const o = x as Record<string, unknown> | null
    return String(o?.[field] ?? x)
  })
}

interface Stage {
  readonly writer: string
  readonly stage: string
  readonly contract: string | null
  readonly kind: string
  readonly paths: readonly string[]
  readonly deliverables: readonly string[]
  readonly assertions: readonly string[]
  readonly evidence: readonly string[]
  readonly assembles: number
  readonly calls: number
  readonly stopped: string | null
  readonly stopSteps: number | null
}

const byOwner = new Map<string, Omit<Stage, 'writer' | 'stage' | 'assembles' | 'calls' | 'stopped' | 'stopSteps'>>()
for (const { e } of rows) {
  if (e.t !== 'contract/issue') continue
  const b = parsedBody(e)
  byOwner.set(String(e.owner), {
    contract: String(e.contract),
    kind: b === null ? '（正文读不出来）' : String(b['kind'] ?? '（没有 kind）'),
    paths: e.paths,
    deliverables: namesIn(b, 'deliverables', 'path'),
    assertions: namesIn(b, 'assertions', 'name'),
    evidence: namesIn(b, 'evidenceRequired', 'note'),
  })
}

const KIND_CN: Readonly<Record<string, string>> = { implement: '改码', investigate: '查现状', resolve: '解冲突' }
const stages: Stage[] = prefix.writers.map((w) => {
  const one = byOwner.get(w.writer)
  const agent = st.agents.find((a) => a.agent === w.writer)
  const what = one === undefined ? '没有契约那一栏' : (KIND_CN[one.kind] ?? one.kind)
  return {
    writer: w.writer,
    // `round` 那一份日志上装的是持轮者自己；其余按契约那一栏认。
    stage: w.writer === 'round' ? '持轮者之拆（round plan）' : `跑格 ${w.writer}（${what}）`,
    contract: one?.contract ?? null,
    kind: one?.kind ?? '（没有契约）',
    paths: one?.paths ?? [],
    deliverables: one?.deliverables ?? [],
    assertions: one?.assertions ?? [],
    evidence: one?.evidence ?? [],
    assembles: w.assembles,
    calls: w.calls,
    stopped: agent?.stopped ?? null,
    stopSteps: agent?.stopSteps ?? null,
  }
})

const lines: string[] = []
lines.push('环节黑箱档案（读日志重算 · 不发网 · 不改一个字节）')
lines.push('一 · 前缀纪律')
for (const l of prefix.lines) lines.push('  ' + l)
lines.push('二 · 逐个环节')
if (stages.length === 0) lines.push('  · 一条 prefix/assemble 都没有：这一份日志上还没有真驱动跑过的环节')
for (const s of stages) {
  lines.push('  ' + s.stage + (s.contract === null ? '' : ' · 契约 ' + s.contract))
  lines.push(`    输入：装配 ${s.assembles} 次 · 调用 ${s.calls} 次` + (s.paths.length === 0 ? '' : ' · 声明要动的路径 ' + s.paths.join(' · ')))
  const out: string[] = []
  if (s.deliverables.length > 0) out.push('交付物 ' + s.deliverables.join(' · '))
  if (s.assertions.length > 0) out.push('断言 ' + s.assertions.join(' · '))
  if (s.evidence.length > 0) out.push('要交的证据 ' + s.evidence.join(' · '))
  lines.push('    输出契约：' + (out.length === 0 ? '（这一档没有那三栏）' : out.join(' ｜ ')))
  lines.push('    结果：' + (s.stopped === null ? '（没有 agent/stop：这一格没停）' : `${String(s.stopSteps)} 步 · ${s.stopped}`))
}
lines.push('三 · 打回三数（判据在 `src/probe/round.ts`）')
for (const r of readings) lines.push(`  ${r.metric}\t${r.count}\t${r.how}`)
const u = st.usage
lines.push('四 · 成本（缺项不拿 0 顶）')
lines.push(
  `  调用 ${u.calls} 次 · input ${u.inputTokens.total}（缺 ${u.inputTokens.missing}）· ` +
    `cacheRead ${u.cacheReadTokens.total}（缺 ${u.cacheReadTokens.missing}）· ` +
    `cacheWrite ${u.cacheWriteTokens.total}（缺 ${u.cacheWriteTokens.missing}）· ` +
    `output ${u.outputTokens.total}（缺 ${u.outputTokens.missing}）`,
)

if (asJson) {
  console.log(JSON.stringify({ root, prefix, stages, readings, usage: u, lines }, null, 2))
} else {
  for (const l of lines) console.log(l)
}
