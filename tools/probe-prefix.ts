// 探针：前缀那笔账。出处：PLAN § 5.8 的站前读数表第四条 · 口径一里"这道闸是什么"那一段 ·
// 架构 § 8.11 的验证性质（相邻两步仅 C 变化 · 跨 N 个 agent `hash(zoneA)` 全等）· 架构 § 8.10
// 的硬纪律 2（工具目录在状态切换前后不变）· 架构 § 8.12 的两条准则（`seed` 的上界）。
// **取证用，不是产品的一部分**（仓库约定 § 七）。
//
// 跑法：`cd ~/fugue && node tools/probe-prefix.ts`
//
// **它是进入真流程之前的那道闸。** 装配是纯函数（架构 § 13.4 的 P1），所以这一整份**不碰网络、
// 不碰凭据、不花钱**——账不对就不进真流程，理由是那三样不成立时真调用的读数不可解释
// （缓存没命中看起来像模型不稳，装不下看起来像模型不听话）。
//
// 六节，判据是**三条相等与一条差额**：
//   一 · 三区各多少字节与指纹（拿的是这个仓库自己的真实状态：`AGENTS.md` · 配置 · 真源码 ·
//        真提交序列）
//   二 · 段与段的边界：逐段字节，以及"三区 = 各段之和"这条对账
//   三 · 相邻两步：`hash(A+B)` 逐字节相同 + 复用比例 + 首个分叉偏移（负对照：动一下 B 区）
//   四 · 跨 N=4 个 agent：`hash(zoneA)` 全等（负对照：往 A 区的源里掺一次宿主路径）
//   五 · 工具 schema 哈希在状态切换前后不变（架构 § 8.10 的硬纪律 2）
//   六 · token 估账与余量：`Zone A + Zone B + seed + 交接余量` 与 `contextLimit` 的差额；
//        **超限时报"超了多少"，不裁剪后照发**
//
// **"每步新增多少字节"是按 `B7` 那条口径算的**：`1 − 新增字节 / 整条前缀`。它今天必然接近 1
// （A 区与 B 区都不动），而**真实值要等 `prefix-hit-rate`**：那个数由提供方报（钱），这个数由
// 我们自己算（账）——两者不是一回事，账不成立时钱不可能对，所以先量账。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ModelId } from '../src/assemble/contract.ts'
import type { SegmentId, SegmentValue, Zone } from '../src/assemble/contract.ts'
import { HOLDER_B, ZONE_SEGMENTS } from '../src/assemble/contract.ts'
import { HOLDER_PROTOCOL, SUBAGENT_PROTOCOL } from '../src/assemble/protocol.ts'
import { assemble, firstDivergence, hashOf, readPrefix } from '../src/assemble/assemble.ts'
import { render } from '../src/assemble/render.ts'
import type { AgentCoord, AssembleState } from '../src/assemble/sources.ts'
import { emptyState, readPolicy, sourcesFor } from '../src/assemble/sources.ts'
import { stateWithState } from '../src/assemble/sources-state.ts'
import { readConfig } from '../src/config.ts'
import { CATALOG_STATES, TOOL_ENTRIES, catalog, catalogHash } from '../src/tools/catalog.ts'
import { HANDOFF_MARGIN, ZONE_A_BUDGET, seedLimitOf } from '../src/contract/types.ts'
import { MODEL_DECLS, MODEL_IDS, providerOf } from '../src/model/contract.ts'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const MODEL_ID = MODEL_DECLS[MODEL_IDS[0] as string]?.id as ModelId

let failed = 0
function ok(msg: string): void {
  console.log(`  ok   ${msg}`)
}
function bad(msg: string): void {
  failed++
  console.log(`  FAIL ${msg}`)
}
function say(msg: string): void {
  console.log(`  ·    ${msg}`)
}
function eq<T>(what: string, got: T, want: T): void {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) ok(`${what}：${g}`)
  else bad(`${what}：拿到 ${g}，要的是 ${w}`)
}
/** 一个数的样子：千分位分开——读数要能一眼看出量级。 */
function n(x: number): string {
  return x.toLocaleString('en-US')
}
/** 每 4 字节一个 token 那类**粗系数**：只判量级与余量，不报成本（PLAN § 5.8 的疑点清单）。 */
function estTokens(bytes: number): number {
  return Math.round(bytes / 4)
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// ── 一份真实状态：这个仓库自己 ─────────────────────────────────────────────────
//
// 段值全部来自盘上真实的东西：`AGENTS.md` 的字节 · `.fugue/config` 的投影 · 真源码 · 真提交
// 序列（`git log --oneline`）· 一份真契约（B0 这一段本身的交付物）。**不是打桩**——打桩的段值
// 量不出"这个仓库的前缀有多大"。
//
// B 区的三段（`工作总目标` · `文件内容` · `提交序列`）**刻意在步与步之间不动**：架构 § 8.11 的
// 验证性质说的就是"相邻两步仅 C 变化"，它们动一次就是一次缓存失效——第三节的负对照量的正是
// 那一下。

const REAL_FILES = ['src/assemble/assemble.ts', 'src/assemble/contract.ts', 'AGENTS.md']

/** 一个文件的前若干行：`文件内容` 那一段的取值（整份会有几万字节，那不是这条读数的重点）。 */
function headOf(rel: string, lines: number): { path: string; text: string } {
  return { path: rel, text: readFileSync(join(REPO, rel), 'utf8').split('\n').slice(0, lines).join('\n') }
}

/** 真提交序列：`git log --oneline` 的前几条。 */
function commitsIn(n: number): string[] {
  const out = execFileSync('git', ['log', `-n${n}`, '--format=%h %s'], { cwd: REPO, encoding: 'utf8' })
  return out.split('\n').filter((l) => l !== '')
}

const POLICY = readPolicy(REPO)
const COMMITS = commitsIn(20)

/** 那一份真契约：`B0` 自己要交的东西（`我的任务` 那一段的源）。 */
const TASK: AssembleState['task'] = {
  goal: 'S8 的 B0：立模型与提供方的声明，并在进真流程之前把前缀这笔账量出来',
  question: '',
  deliverables: ['src/model/contract.ts', 'src/model/contract.test.ts', 'tools/probe-prefix.ts'],
  evidenceRequired: ['node tools/probe-prefix.ts 的六节读数'],
  assertions: [
    '相邻两步 hash(A+B) 逐字节相同',
    '跨 4 个 agent hash(zoneA) 全等',
    '工具 schema 哈希在状态切换前后不变',
  ],
}

/**
 * 某一步的状态：**只有 C 区那三段随步走**。
 *
 * C 区那三段（`运行时上下文` · `信号摘要` · `上一步结果`）是只追加的，于是"每步新增多少字节"
 * 在这条读数里就是 C 区那一段的增长。
 */
function stepState(base: AssembleState, step: number): AssembleState {
  return {
    ...base,
    runtime: `第 ${step} 步 · 沙箱策略 none · 可用工具 ${TOOL_ENTRIES.length} 条 · 上界 ${MODEL_DECLS[MODEL_IDS[0] as string]?.contextLimit}`,
    signals: Array.from({ length: step + 1 }, (_, i) => `sig-${i + 1} · B0 的站前读数：前缀那笔账`),
    lastStep: step === 0 ? '（这一步还没有上一步）' : `第 ${step - 1} 步的结果：装配 · 调用 · 工具，三条事件各一条`,
  }
}

/** 一份坐标：四个 agent 只有 `id` 与产物路径不同——A 区的全等要在这个差别之下仍然成立。 */
function coordOf(agent: string): AgentCoord {
  return { id: agent, branch: `refs/heads/${agent}`, outputPaths: [`deliver/${agent}/`] }
}

const AGENTS = ['agent-1', 'agent-2', 'agent-3', 'agent-4'].map(coordOf)
const CONFIG = await readConfig(REPO)
const BASE: AssembleState = {
  ...stateWithState(emptyState(), CONFIG, REPO),
  goal: 'S8「接模型可用」按 PLAN § 5.8 的 B0–B7 做完（这份状态取自 S8 的 B0 那一步）',
  files: REAL_FILES.map((f) => headOf(f, 120)),
  commits: COMMITS,
  handoff: '',
  task: TASK,
}
const STEPS = [0, 1, 2].map((k) => stepState(BASE, k))
const SEGMENTS = STEPS.map((s) => sourcesFor(SUBAGENT_PROTOCOL, s, AGENTS[0] as AgentCoord))
const PREFIXES = SEGMENTS.map((segs) => assemble({ protocol: SUBAGENT_PROTOCOL, model: MODEL_ID, segments: segs }))

console.log('B0 · 前缀那笔账（进入真流程之前的那道闸）\n')
say(`状态取自这个仓库本身：${REPO}`)
say(`项目方针 ${n(Buffer.byteLength(POLICY, 'utf8'))} 字节 · 配置 ${Object.keys(CONFIG).length} 栏 · 文件内容 ${REAL_FILES.length} 份 · 提交序列 ${COMMITS.length} 条 · agent ${AGENTS.length} 个 · 步 ${STEPS.length} 步`)
say(`模型：${MODEL_IDS.join(' · ')}（上限 ${MODEL_DECLS[MODEL_IDS[0] as string]?.contextLimit} · 提供方 ${providerOf(MODEL_DECLS[MODEL_IDS[0] as string]?.provider ?? '').host}）`)

// ── 一 · 三区 ──────────────────────────────────────────────────────────────────
console.log('\n一 · 三区各多少字节与指纹（第 0 步）')

const first = PREFIXES[0] as (typeof PREFIXES)[number]
const reading = readPrefix(first)
for (const z of ['A', 'B', 'C'] as Zone[]) {
  const r = z === 'A' ? reading.zoneA : z === 'B' ? reading.zoneB : reading.zoneC
  say(`${z} 区：${String(r.bytes).padStart(8)} 字节 · ${r.hash} · ${n(estTokens(r.bytes))} token（估）`)
}
say(`A+B：${String(reading.ab.bytes).padStart(8)} 字节 · ${reading.ab.hash}`)
say(`整条前缀：${String(reading.whole.bytes).padStart(8)} 字节 · ${reading.whole.hash}`)
eq('三区之和 == 整条前缀的字节数', reading.zoneA.bytes + reading.zoneB.bytes + reading.zoneC.bytes, reading.whole.bytes)

// ── 二 · 段与段的边界 ──────────────────────────────────────────────────────────
console.log('\n二 · 段与段的边界：逐段字节，以及"三区 = 各段之和"这条对账')

const PER_SEGMENT: Record<string, number> = {}
{
  const zoneOf = (z: Zone): readonly SegmentId[] => (z === 'A' ? ZONE_SEGMENTS.A : z === 'B' ? ZONE_SEGMENTS.B : ZONE_SEGMENTS.C)
  const measured: Record<Zone, number> = { A: first.zoneA.length, B: first.zoneB.length, C: first.zoneC.length }
  const values = SEGMENTS[0] as Record<SegmentId, SegmentValue>
  for (const z of ['A', 'B', 'C'] as Zone[]) {
    let at = 0
    const parts: string[] = []
    for (const id of zoneOf(z)) {
      const bytes = render(SUBAGENT_PROTOCOL.renderers[id], values[id])
      at += bytes.length
      PER_SEGMENT[id] = bytes.length
      parts.push(`${id} ${n(bytes.length)}`)
    }
    say(`${z} 区：${n(measured[z])} 字节 = 各段之和 ${n(at)}`)
    say(`      ${parts.join(' · ')}`)
    eq(`${z} 区：各段之和 == 那一区的字节数`, at, measured[z])
  }
  eq('逐段字节之和 == 整条前缀', Object.values(PER_SEGMENT).reduce((a, b) => a + b, 0), reading.whole.bytes)
  say('段的边界：三区首尾相接，区与区之间不掺分隔符（分隔符属于渲染器）——所以偏移落在哪里就说明变化发生在哪个区')
  say(`段的顺序：${SUBAGENT_PROTOCOL.segmentOrder.join(' → ')}`)
}

// ── 三 · 相邻两步 ──────────────────────────────────────────────────────────────
console.log('\n三 · 相邻两步：hash(A+B) 逐字节相同 · 复用比例 · 首个分叉偏移')

for (let k = 1; k < PREFIXES.length; k++) {
  const before = PREFIXES[k - 1] as (typeof PREFIXES)[number]
  const after = PREFIXES[k] as (typeof PREFIXES)[number]
  const ab = (p: typeof before): Uint8Array => concat([p.zoneA, p.zoneB])
  const whole = (p: typeof before): Uint8Array => concat([p.zoneA, p.zoneB, p.zoneC])
  const cStart = before.zoneA.length + before.zoneB.length
  const at = firstDivergence(ab(before), ab(after))
  const wholeAt = firstDivergence(whole(before), whole(after))
  const added = whole(after).length - whole(before).length
  const reuse = 1 - added / whole(after).length

  eq(`第 ${k - 1} → ${k} 步：hash(A+B) 相等`, hashOf(ab(before)), hashOf(ab(after)))
  if (at === -1) ok(`第 ${k - 1} → ${k} 步：A+B 逐字节相同（firstDivergence = -1，一个字节都没变）`)
  else bad(`第 ${k - 1} → ${k} 步：A+B 在偏移 ${at} 处就不同了`)
  if (at === -1 && wholeAt >= cStart) ok(`首个分叉偏移 ${wholeAt} ≥ C 区起点 ${cStart}——变化只落在 C 区`)
  else bad(`首个分叉偏移要落在 C 区起点（${cStart}）之后，拿到 ${wholeAt}`)
  say(`新增 ${n(added)} 字节 · 复用比例 ${(reuse * 100).toFixed(2)}%（1 − 新增 ${n(added)} / 整条 ${n(whole(after).length)}）`)
}
{
  // 负对照：动一下 B 区（一份文件的正文加一行）→ `hash(A+B)` 当场变，而 **A 区一个字都不变**。
  const last = PREFIXES[2] as (typeof PREFIXES)[number]
  const changed: AssembleState = {
    ...(STEPS[2] as AssembleState),
    files: REAL_FILES.map((f, i) => (i === 0 ? { path: f, text: `${headOf(f, 120).text}\n// 一行注释。\n` } : headOf(f, 120))),
  }
  const p = assemble({ protocol: SUBAGENT_PROTOCOL, model: MODEL_ID, segments: sourcesFor(SUBAGENT_PROTOCOL, changed, AGENTS[0] as AgentCoord) })
  eq('负对照：动一下 B 区之后 hash(A) 不变', hashOf(p.zoneA), hashOf(last.zoneA))
  eq('负对照：动一下 B 区之后 A 区的字节数不变（分界线没挪）', p.zoneA.length, last.zoneA.length)
  if (hashOf(concat([p.zoneA, p.zoneB])) !== hashOf(concat([last.zoneA, last.zoneB]))) {
    ok('负对照：动一下 B 区之后 hash(A+B) 变了——第三节那条相等不是恒等式')
  } else {
    bad('负对照：动了 B 区，hash(A+B) 却没变——那条相等量不出东西')
  }
}

// ── 四 · 跨 N 个 agent ─────────────────────────────────────────────────────────
console.log('\n四 · 跨 N=4 个 agent：hash(zoneA) 全等（A 区不取决于读它的那个 agent）')

{
  const four = AGENTS.map((who) => {
    const prefix = assemble({ protocol: SUBAGENT_PROTOCOL, model: MODEL_ID, segments: sourcesFor(SUBAGENT_PROTOCOL, STEPS[0] as AssembleState, who) })
    return { who, prefix }
  })
  const hashes = [...new Set(four.map((f) => hashOf(f.prefix.zoneA)))]
  eq('4 个 agent 的 hash(zoneA)（去重之后的个数）', hashes.length, 1)
  const one = four[0] as (typeof four)[number]
  say(`那一个值：${hashes[0]}（${n(one.prefix.zoneA.length)} 字节 ≈ ${n(estTokens(one.prefix.zoneA.length))} token（估））`)
  const bHashes = four.map((f) => hashOf(f.prefix.zoneB))
  eq('4 个 agent 的 hash(zoneB) 各不相同（B 区里有 agent 自己的那一段）', [...new Set(bHashes)].length, 4)
  say(`B 区那 4 个值：${bHashes.join(' · ')}（坐标只差 id 与产物路径）`)

  // 负对照：往 A 区的源里掺一次宿主路径 → `hash(zoneA)` 当场变。
  const dirty = { ...(STEPS[0] as AssembleState), policy: `${POLICY}\n<!-- ${REPO} -->\n` }
  const dirtyA = hashOf(assemble({ protocol: SUBAGENT_PROTOCOL, model: MODEL_ID, segments: sourcesFor(SUBAGENT_PROTOCOL, dirty, AGENTS[0] as AgentCoord) }).zoneA)
  if (dirtyA !== hashes[0]) ok(`负对照：往项目方针里掺一次宿主路径（${REPO}）→ hash(zoneA) 变了`)
  else bad('负对照：往 A 区掺宿主路径却没变——第四节那条全等量不出东西')

  // 持轮者那一份：同一份状态，同一个 A 区，B 区多一段少一段（架构 § 8.11 的第二张表）。
  const holder = assemble({ protocol: HOLDER_PROTOCOL, model: MODEL_ID, segments: sourcesFor(HOLDER_PROTOCOL, STEPS[0] as AssembleState, null) })
  eq('持轮者的 hash(zoneA) 与子 agent 的相同', hashOf(holder.zoneA), hashes[0])
  say(`持轮者：段序 ${HOLDER_PROTOCOL.segmentOrder.length} 段 · B 区 ${n(holder.zoneB.length)} 字节（子 agent 的 B 区 ${n(one.prefix.zoneB.length)} 字节）`)
  say(`两者 B 区的差别：多 ${HOLDER_B.filter((s) => !ZONE_SEGMENTS.B.includes(s)).join(' · ')} · 少 ${ZONE_SEGMENTS.B.filter((s) => !HOLDER_B.includes(s)).join(' · ')}`)
}

// ── 五 · 工具 schema ───────────────────────────────────────────────────────────
console.log('\n五 · 工具 schema 哈希在状态切换前后不变（架构 § 8.10 的硬纪律 2）')

{
  const state0 = CATALOG_STATES[0] as (typeof CATALOG_STATES)[number]
  const hashes = CATALOG_STATES.map((s) => catalogHash(catalog(s)))
  eq('三种状态下工具目录的指纹（去重之后的个数）', [...new Set(hashes)].length, 1)
  say(`工具 schema：${TOOL_ENTRIES.length} 条 · 指纹 ${hashes[0]} · ${n(Buffer.byteLength(JSON.stringify(catalog(state0)), 'utf8'))} 字节的 JSON（≈ ${n(estTokens(Buffer.byteLength(JSON.stringify(catalog(state0)), 'utf8')))} token 估）`)
  say(`三种状态：${CATALOG_STATES.map((s) => `planMode=${s.planMode}/pendingTodos=${s.pendingTodos}`).join(' · ')}`)

  // 它不在 A 区里：`toolCatalog` 是随请求走的那份 schema，位置由提供方定（架构 § 8.11 的头注）。
  eq('段序里的段数（工具目录不在其中）', SUBAGENT_PROTOCOL.segmentOrder.length, 11)
  eq('协议值里工具目录的条数', SUBAGENT_PROTOCOL.toolCatalog.length, 15)
  // 负对照：给一份目录补一个字段 → 指纹当场变。
  const grown = catalog(state0).map((t, i) => (i === 0 ? { ...t, extra: 1 } : t))
  if (catalogHash(grown as never) !== hashes[0]) ok('负对照：给目录补一个字段 → 指纹变了')
  else bad('负对照：给目录补一个字段却没变——第五节那条不变是恒等式')
}

// ── 六 · token 估账与余量 ──────────────────────────────────────────────────────
console.log('\n六 · token 估账与余量：Zone A + Zone B + seed + 交接余量 与 contextLimit 的差额')

{
  const m = MODEL_DECLS[MODEL_IDS[0] as string]
  if (m === undefined) {
    bad('拿不到第一条声明——第六节量不了')
  } else {
    const seed = TASK.deliverables.reduce((a, p) => a + Buffer.byteLength(readFileSync(join(REPO, p), 'utf8'), 'utf8'), 0)
    const limit = seedLimitOf({ modelLimit: m.contextLimit })
    const zoneA = first.zoneA.length
    const zoneB = first.zoneB.length
    const handoff = m.budget.handoffMargin
    const used = zoneA + zoneB + seed + handoff
    const room = m.contextLimit - used

    say(`上界 ${n(m.contextLimit)} · Zone A ${n(zoneA)} · Zone B ${n(zoneB)} · C ${n(first.zoneC.length)} · seed ${n(seed)}（${TASK.deliverables.length} 份交付物的当下字节）· 交接余量 ${n(handoff)}`)
    say(`已经占住 ${n(used)} 字节 ≈ ${n(estTokens(used))} token（估）· 占比 ${((used / m.contextLimit) * 100).toFixed(1)}% · 余量 ${n(room)} 字节 ≈ ${n(estTokens(room))} token（估）`)
    say(`预算触发点：${n(m.budget.trigger)}（上限的四分之三）——C 区今天 ${n(first.zoneC.length)} 字节，离它还远`)
    say(`seed 那一条的判据（架构 § 8.12）：上限 ${n(limit)} 字节 = 模型上限 ${n(m.contextLimit)} − Zone A 预算 ${n(ZONE_A_BUDGET)} − 交接余量 ${n(HANDOFF_MARGIN)}（Zone A 那一项用**预算**，不是当下的 ${n(zoneA)}）`)
    say('token 那一栏是**粗系数**（每 4 字节一个 token）：只判量级与余量，不报成本——真实计量等 B3 拿回用量的四个数（PLAN § 5.8 的疑点清单）')

    eq('估账：用到的那四项之和 == Zone A + Zone B + seed + 交接余量', used, zoneA + zoneB + seed + handoff)
    eq('差额（余量）== contextLimit − 用到的那四项', m.contextLimit - used, room)
    if (room > 0) ok(`装得下：还余 ${n(room)} 字节 ≈ ${n(estTokens(room))} token（估）——差额印得出来，这是进真流程的前提`)
    else bad(`装不下：超了 ${n(-room)} 字节——**报"超了多少"，不裁剪后照发**（架构 § 8.12：带着超限的种子派发等于派发一次立刻触发的接续）`)

    // 负对照：seed 顶到真正超限（超过 `seedLimitOf` 给的上限）→ 差额是负的，"超了多少"算得出来。
    const over = limit + 1
    const overRoom = m.contextLimit - (zoneA + zoneB + over + handoff)
    if (over > limit && overRoom < 0) {
      ok(`负对照：seed 顶到 ${n(over)} 字节（上限 ${n(limit)} + 1）→ 差额 −${n(-overRoom)} 字节 = 超了多少`)
    } else {
      bad(`负对照：seed 顶到 ${n(over)} 字节时没算出超限（limit=${n(limit)} · room=${n(overRoom)}）——那算式没接上`)
    }
  }
}

console.log(`\n${failed === 0 ? '全部通过' : `FAIL ${failed} 处`}`)
process.exit(failed === 0 ? 0 : 1)
