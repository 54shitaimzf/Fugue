// **一趟里只读并行 · 写串行 · 回执按原调用序**（0.5.0）。跑法：
// cd ~/fugue && node --test src/runtime/batch.test.ts
//
// 出处：架构 § 14.2 第 4 步（`results = calls.map(dispatch)`）· § 8.9 那张能力表（"这条工具跑一次
// 会不会动东西"是**一格一个**的判定，层名不是判据）· § 8.11（回执进 C 区那个积累段，次序即语义）。
//
// **这一份判的是"重叠发生了没有"，不是"快了多少"**（工作区约定：断言在位，不断言快慢）。判据是
// 一个**并发计数的最大值**：四条只读一起交下去时同时开着的条数。串行那一档恒为 1，而它恰好是
// 负对照——把批次那一栏摘掉，同一条断言当场翻成 1。
//
// 五条：
//
//   ① 只读并行：一趟四条 `read` → 同时开着的最多 4 条（而"一次一条"那一档恒为 1）
//   ② 写串行 · 读不越过写：`read` `read` `write` `read` `read` 那一趟里，写后面那两条读
//      **看得见写的字节**——批的边界就是写的边界（整批一起跑会静默地返回过期内容）
//   ③ 回执按原调用序：完成次序故意反过来（最后一条最先回），而下标 · `Turn` · C 区那一段
//      全部照原序对位
//   ④ 失败与收尾不留遗留工作：一条只读抛了，**其余在飞的都落定之后**这一步才返回 failed，
//      而日志里没有半截的一对起止事件（只读那四条本来就不落 `run/*`）
//   ⑤ 包装层转发那一栏：`holderFace` 与驱动那一份"还剩几步"的包装**不许吃掉批次**——
//      不转发就是只读并行唯一那个静默的漏斗（运行时看不见差别，只有墙钟看得出来）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentCoord } from '../assemble/sources.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { fixtureState } from '../model/fixture-state.ts'
import { openLog } from '../log/log.ts'
import type { LogHandle } from '../log/events.ts'
import { catalog, CATALOG_STATES } from '../tools/catalog.ts'
import type { ToolEntry } from '../tools/catalog.ts'
import type {
  ActionAsk,
  AskItem,
  DenyAsk,
  EditRaw,
  RunAsk,
  RunReply,
  ToolHost,
  ToolListing,
  TodoItem,
} from '../tools/execute.ts'
import type { PlanAsk } from '../search/plan.ts'
import { createToolExecutor } from '../capability/dispatch.ts'
import type { DispatchDeps } from '../capability/dispatch.ts'
import type { AgentHandle, ModelEvent, ToolExecutor, ToolResult } from './step.ts'
import { createRuntime, HarnessError, scriptedModel } from './step.ts'
import { holderFace } from '../round/plan.ts'
import { withStepsLeft } from '../round/driver.ts'
import type { AgentId, BranchId, ContractId, RelPath, WriterId } from '../terms.ts'
import type { ModelId } from '../model/contract.ts'

const TOOLS: readonly ToolEntry[] = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])
const WHO: AgentCoord = { id: 'agent-b', branch: 'refs/heads/agent-b', outputPaths: ['deliver/agent-b/'] }
const USAGE = { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: null, model: null }
/** 每次只读花多久：**40 ms 够把"重叠"与"串行"分开**，又不至于让这一份跑成几秒。 */
const READ_MS = 40

/** 一条工具调用（三段：起点 · 分片 · 收尾）。 */
function callOne(index: number, id: string, name: string, args: string): ModelEvent[] {
  return [
    { t: 'tool-start', index, id, name },
    { t: 'tool-delta', index, args },
    { t: 'tool-call', index, id, name, arguments: args },
  ]
}

/** 一个脚本：第一步调这几条，第二步说完。 */
function scriptsOf(
  calls: readonly { readonly id: string; readonly name: string; readonly args: string }[],
): readonly (readonly ModelEvent[])[] {
  return [
    [
      ...calls.flatMap((c, i) => callOne(i, c.id, c.name, c.args)),
      { t: 'usage', usage: USAGE },
      { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
    ],
    [{ t: 'delta', text: '好了。' }, { t: 'usage', usage: USAGE }, { t: 'stop', reason: 'end-turn', raw: 'end_turn' }],
  ]
}

/**
 * 一个假的工具宿主：**只实现这一份要用的那几条**（读 · 写 · 列清单）。
 *
 * 它同时是**读数**：`active` / `maxActive` 数的是"此刻有几条 read 在飞"——这就是"重叠发生了
 * 没有"的判据。`files` 是盘上那份内容，`write` 改它——② 量的正是"写之后那一段读看见了新字节"。
 */
interface Bench {
  readonly host: ToolHost
  readonly files: Map<string, string>
  readonly started: string[]
  readonly seen: Map<string, string[]>
  readonly maxActive: () => number
  readonly active: () => number
  readonly throwOn: (path: string | null) => void
}

function bench(init: Readonly<Record<string, string>>, wait: Readonly<Record<string, number>> = {}): Bench {
  const files = new Map<string, string>(Object.entries(init))
  const seen = new Map<string, string[]>()
  const started: string[] = []
  let active = 0
  let max = 0
  let boom: string | null = null
  const rest = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
  const notHere = (what: string) => async (): Promise<never> => {
    throw new Error(`这一份测试不该走到 ${what}`)
  }
  const host: ToolHost = {
    async readBytes(rel: string) {
      started.push(rel)
      active += 1
      if (active > max) max = active
      try {
        await rest(wait[rel] ?? READ_MS)
        if (boom === rel) throw new Error(`这一条读炸了：${rel}`)
        const text = files.get(rel)
        if (text === undefined) return null
        const rows = seen.get(rel) ?? []
        rows.push(text)
        seen.set(rel, rows)
        return { bytes: new TextEncoder().encode(text), mode: 0o100644 }
      } finally {
        active -= 1
      }
    },
    async writeBytes(rel: string, bytes: Uint8Array) {
      files.set(rel, new TextDecoder().decode(bytes))
      return { rev: files.size }
    },
    async list(): Promise<readonly ToolListing[]> {
      return [...files.keys()].map((name) => ({ name, kind: 'file' as const, size: 0 }))
    },
    async walk(): Promise<readonly string[]> {
      return [...files.keys()]
    },
    async edit(rel: string, raw: EditRaw) {
      const before = files.get(rel)
      if (before === undefined) throw new Error(`这一份测试不该 edit 一条不存在的路径：${rel}`)
      files.set(rel, before.replace(raw.find, raw.replace))
      return { rev: files.size, changed: true }
    },
    execCwd: notHere('execCwd') as unknown as ToolHost['execCwd'],
    run: notHere('run') as unknown as (req: RunAsk) => Promise<RunReply>,
    checkpoint: notHere('checkpoint') as unknown as (msg: string) => Promise<{ readonly commit: string }>,
    runAction: notHere('runAction') as unknown as (req: ActionAsk) => Promise<RunReply>,
    setTodos: notHere('setTodos') as unknown as (t: readonly TodoItem[]) => Promise<{ readonly count: number }>,
    declarePlan: notHere('declarePlan') as unknown as (ask: PlanAsk) => Promise<void>,
    askUser: notHere('askUser') as unknown as (a: readonly AskItem[]) => Promise<void>,
    deny: async (_d: DenyAsk) => undefined,
  }
  return {
    host,
    files,
    started,
    seen,
    maxActive: () => max,
    active: () => active,
    throwOn: (path) => {
      boom = path
    },
  }
}

/** 这一格的句柄（只读字段；路径围栏由 `fenceOf` 那一档给）。 */
function handleOf(step = 0, cwd = ''): AgentHandle {
  return {
    agent: 'agent-b' as AgentId,
    coord: WHO,
    branch: 'refs/heads/agent-b' as BranchId,
    contract: 'c-1' as ContractId,
    protocol: SUBAGENT_PROTOCOL,
    model: 'deepseek-flash/anthropic' as ModelId,
    wireModel: 'deepseek-flash',
    // **夹具那一档**：`from: 'fixture'` 的 Target 不会被真发出去（`scriptedModel` 根本不看它）。
    target: {
      providerId: 'fixture',
      host: '',
      wire: { name: 'anthropic-messages' },
      path: '',
      model: 'deepseek-flash',
      from: 'fixture',
      headers: {},
    },
    adapter: { name: 'anthropic-messages' },
    state: { ...fixtureState(step), step, cwd },
    cwd,
  } as AgentHandle
}

/** 产品那一档的执行器：接的是那个假宿主 + 一条只做形状检查的围栏。 */
function executorOf(b: Bench, log: LogHandle): ToolExecutor {
  const deps: DispatchDeps = {
    logOf: () => log,
    host: b.host,
    fenceOf: (raw: string) => ({ ok: true as const, value: raw as RelPath }),
    ensureOf: async () => undefined,
  }
  return createToolExecutor(deps)
}

/** 一条只读（四条 `read`）那一趟。 */
const FOUR_READS: readonly { readonly id: string; readonly name: string; readonly args: string }[] = [
  { id: 'c1', name: 'read', args: '{"path":"a.txt"}' },
  { id: 'c2', name: 'read', args: '{"path":"b.txt"}' },
  { id: 'c3', name: 'read', args: '{"path":"c.txt"}' },
  { id: 'c4', name: 'read', args: '{"path":"d.txt"}' },
]

/** 那四条按调用那一份（`executeAll` 收的形状）。 */
function fourCalls(): { id: string; name: string; arguments: string }[] {
  return FOUR_READS.map((c) => ({ id: c.id, name: c.name, arguments: c.args }))
}

/** 回执正文里第二行（`read` 的人读那一面：头一行是尺寸 · 行数 · 模式）。 */
function bodyOf(out: string): string {
  return out.split('\n')[1] ?? ''
}

/** 一个临时工作区 + 一个写口（跑完关掉删掉）。 */
async function withRoot<T>(fn: (log: LogHandle) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-batch-'))
  const log = openLog(root, { write: 'agent-b' as WriterId })
  try {
    return await fn(log)
  } finally {
    await log.close()
    rmSync(root, { recursive: true, force: true })
  }
}

/** 跑一步：把那个脚本喂给运行时，拿回结果。 */
async function oneStep(
  log: LogHandle,
  scripts: readonly (readonly ModelEvent[])[],
  execute: ToolExecutor,
  h = handleOf(),
) {
  const rt = createRuntime({ logOf: () => log, call: scriptedModel(scripts), execute, tools: TOOLS })
  return await rt.step(h, new AbortController().signal)
}

// ── ① 只读并行 ────────────────────────────────────────────────────────────────

test('① 只读并行：一趟四条 `read`，同时开着的最多 4 条；"一次一条"那一档恒为 1', async () => {
  await withRoot(async (log) => {
    const b = bench({ 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C', 'd.txt': 'D' })
    const r = await oneStep(log, scriptsOf(FOUR_READS), executorOf(b, log))
    assert.equal(r.outcome.kind, 'continue', '四条只读那条路该走到"它还要接着调工具"')
    assert.equal(b.started.length, 4, `四条只读都该被调用：${b.started.join(' · ')}`)
    assert.equal(b.maxActive(), 4, `四条只读该同时开着（实际最多 ${b.maxActive()} 条）——它退成了串行`)

    // **负对照**：把批次那一栏摘掉（就是"一次一条"那一档）。
    const serial = bench({ 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C', 'd.txt': 'D' })
    const plain = executorOf(serial, log)
    const noBatch: ToolExecutor = { execute: (c, h) => plain.execute(c, h) }
    const r2 = await oneStep(log, scriptsOf(FOUR_READS), noBatch)
    assert.equal(r2.outcome.kind, 'continue')
    assert.equal(serial.started.length, 4)
    assert.equal(serial.maxActive(), 1, `没有批次那一栏就该恒为 1（实际 ${serial.maxActive()}）——负对照没成立`)
    console.log(
      `① 读数：四条 read 挨着跑 → 同时最多 ${b.maxActive()} 条 · 一次一条那一档 ${serial.maxActive()} 条` +
        `（每条 ${READ_MS} ms）`,
    )
  })
})

// ── ② 写串行 · 读不越过写 ─────────────────────────────────────────────────────

test('② 写串行 · 读不越过写：写后面那两条读看得见写的字节，批的边界就是写的边界', async () => {
  await withRoot(async (log) => {
    const b = bench({ 'a.txt': '旧-A', 'b.txt': '旧-B', 'c.txt': '旧-C' })
    const calls = [
      { id: 'c1', name: 'read', args: '{"path":"a.txt"}' },
      { id: 'c2', name: 'read', args: '{"path":"b.txt"}' },
      { id: 'c3', name: 'write', args: '{"path":"a.txt","content":"新-A"}' },
      { id: 'c4', name: 'read', args: '{"path":"a.txt"}' },
      { id: 'c5', name: 'read', args: '{"path":"c.txt"}' },
    ]
    const r = await oneStep(log, scriptsOf(calls), executorOf(b, log))
    assert.equal(r.outcome.kind, 'continue')

    // a.txt 那两次读：写之前一次（旧字节）· 写之后一次（新字节）。**这就是"读不越过写"的读数。**
    assert.deepEqual(
      b.seen.get('a.txt'),
      ['旧-A', '新-A'],
      `a.txt 两次读到的字节：${JSON.stringify(b.seen.get('a.txt'))}`,
    )
    const turn = (r.next.turns ?? [])[0]
    assert.ok(turn !== undefined, '这一步该留下一条往返')
    assert.deepEqual(
      turn.results.map((x) => (x.output.startsWith('wrote ') ? x.output : bodyOf(x.output))),
      ['旧-A', '旧-B', 'wrote a.txt (5 bytes).', '新-A', '旧-C'],
      `五条回执按原调用序该是这一串：${JSON.stringify(turn.results.map((x) => x.output.split('\n')[0]))}`,
    )
    assert.deepEqual(turn.results.map((x) => x.isError), [false, false, false, false, false])
    // **写没有与任何一条读叠着跑**：写那一趟里活动着的读计数从没超过 2（前一段那两条）。
    assert.ok(b.maxActive() <= 2, `写与读叠在一起了（同时最多 ${b.maxActive()} 条）`)
    console.log(
      `② 读数：read·read·write·read·read → a.txt 读到 ${JSON.stringify(b.seen.get('a.txt'))}` +
        ` · 同时最多 ${b.maxActive()} 条（前一段那两条）· 写不与任何读重叠`,
    )
  })
})

// ── ③ 回执按原调用序 ─────────────────────────────────────────────────────────

test('③ 回执按原调用序：完成次序反过来（最后一条最先回），下标 · Turn · C 区全照原序', async () => {
  await withRoot(async (log) => {
    // d 最先回（0 ms）· a 最慢（120 ms）：完成次序与原调用序相反。
    const b = bench(
      { 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C', 'd.txt': 'D' },
      { 'a.txt': 120, 'b.txt': 80, 'c.txt': 40, 'd.txt': 0 },
    )
    const r = await oneStep(log, scriptsOf(FOUR_READS), executorOf(b, log))
    assert.equal(r.outcome.kind, 'continue')
    // 发起次序是原调用序（批内一起发）——而落定的次序与它相反，下面那一条才有内容。
    assert.deepEqual(b.started, ['a.txt', 'b.txt', 'c.txt', 'd.txt'], '发起次序该是原调用序（批内一起发）')
    const turn = (r.next.turns ?? [])[0]
    assert.ok(turn !== undefined, '这一步该留下一条往返')
    // 下标对位：`calls[i]` 就是 `results[i]`（回执按原调用序归位）。
    assert.deepEqual(turn.calls.map((c) => c.id), ['c1', 'c2', 'c3', 'c4'])
    assert.deepEqual(turn.results.map((x) => x.id), ['c1', 'c2', 'c3', 'c4'])
    assert.deepEqual(
      turn.results.map((x) => bodyOf(x.output)),
      ['A', 'B', 'C', 'D'],
      `回执没有按原调用序归位：${JSON.stringify(turn.results.map((x) => bodyOf(x.output)))}`,
    )
    // C 区那一段（`lastStep` 是它的一个投影）也照原序。
    const last = r.next.lastStep
    const at = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((p) => last.indexOf(p))
    assert.deepEqual([...at].sort((x, y) => x - y), at, `C 区那一段里四条回执的次序不是原调用序：${JSON.stringify(at)}`)
    console.log(
      `③ 读数：等待 ${[120, 80, 40, 0].join('/')} ms（完成次序与原调用序相反）· 回执 ${turn.results.map((x) => x.id).join(' ')}` +
        ` · C 区次序照原样（${at.join(' < ')}）`,
    )
  })
})

// ── ④ 失败与收尾不留遗留工作 ─────────────────────────────────────────────────

test('④ 一条只读抛了：其余在飞的都落定之后这一步才返回；日志里没有半截的一对起止事件', async () => {
  await withRoot(async (log) => {
    const b = bench(
      { 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C', 'd.txt': 'D' },
      { 'a.txt': 80, 'b.txt': 20, 'c.txt': 20, 'd.txt': 20 },
    )
    // c.txt 那条读抛。
    b.throwOn('c.txt')
    const t0 = Date.now()
    const r = await oneStep(log, scriptsOf(FOUR_READS), executorOf(b, log))
    const wall = Date.now() - t0
    assert.equal(r.outcome.kind, 'failed', `该收成 failed，实际 ${r.outcome.kind}`)
    assert.equal((r.outcome as { error: HarnessError }).error.why, 'tool-threw')
    assert.match((r.outcome as { error: HarnessError }).error.message, /这一条读炸了：c\.txt/)
    assert.equal(b.active(), 0, `返回的时候还有 ${b.active()} 条在读——"失败不留遗留工作"没成立`)
    assert.ok(wall >= 80, `不到最慢那一条（80 ms）就返回了（${wall} ms）——有活儿被丢在半路`)
    // 只读那四条**本来就不落 `run/*`**（那是执行类的事）：日志里因此没有半截的一对。
    const events: string[] = []
    for await (const e of log.readByWriter('agent-b' as WriterId)) events.push(e.t)
    assert.deepEqual(
      events.filter((t) => t === 'run/start' || t === 'run/end'),
      [],
      `日志里出现了执行类的那一对：${events.join(' · ')}`,
    )
    assert.deepEqual(events, ['prefix/assemble', 'llm/call'], `这一趟该只落那两条：${events.join(' · ')}`)
    console.log(
      `④ 读数：最慢一条 80 ms · 抛的那一条 20 ms · 整个 step 花了 ${wall} ms（等到在飞的都落定）` +
        ` · 日志 ${events.join(' · ')}`,
    )
  })
})

// ── ⑤ 包装层不许吃掉批次 ─────────────────────────────────────────────────────

test('⑤ 包装层转发那一栏：`holderFace` 与"还剩几步"那一层都不许把批次吃掉', async () => {
  await withRoot(async (log) => {
    // 一 · 持轮者那一格（`plan.ts` 的 `holderFace`）：只读那四条照旧并行。
    const b = bench({ 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C', 'd.txt': 'D' })
    const wrapped = holderFace(executorOf(b, log), { maxSteps: 8 })
    // **第 5 步**：`stepsLeftTail` 只在"还剩 ≤ 3 步"时才说那一句（`STEPS_HINT_AT`），
    // 8 − 5 − 1 = 2 —— 这一档那一句在场，于是"包装层没把它弄丢"这句话量得到。
    const h = handleOf(5)
    const got = await wrapped.executeAll?.(fourCalls(), h)
    assert.equal(got?.length, 4, '包装之后那一批回执该还是四条')
    assert.equal(b.maxActive(), 4, `holderFace 把批次吃掉了（同时最多 ${b.maxActive()} 条）——只读并行在这一格静默地没了`)
    // 而"还剩几步"那一句照旧在每条回执上（包装层没把它的本职弄丢）。
    assert.ok(
      (got?.[0]?.output ?? '').includes('2 left.'),
      `包装之后那一句该照旧：${JSON.stringify((got?.[0]?.output ?? '').slice(-90))}`,
    )
    assert.ok((got?.[3]?.output ?? '').includes('2 left.'), '那一句该补在**每条**回执上，不只第一条')

    // 二 · 驱动那一份（`driver.ts` 的 `withStepsLeft`）：产品里那一份本体，同一条判据。
    const b2 = bench({ 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C', 'd.txt': 'D' })
    const wrapped2 = withStepsLeft(executorOf(b2, log), 8)
    const got2 = await wrapped2.executeAll?.(fourCalls(), handleOf(5))
    assert.equal(got2?.length, 4)
    assert.equal(b2.maxActive(), 4, `"还剩几步"那一层把批次吃掉了（同时最多 ${b2.maxActive()} 条）`)
    assert.ok((got2?.[1]?.output ?? '').includes('2 left.'), '驱动那一层那一句该照旧补上')

    // 三 · **负对照**：不转发那一栏的包装（内层有批次也被挡住）→ 并行当场没了。
    const b3 = bench({ 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C', 'd.txt': 'D' })
    const inner3 = executorOf(b3, log)
    const blind: ToolExecutor = { execute: (c, hh) => inner3.execute(c, hh) }
    const viaBlind: ToolResult[] = []
    for (const c of fourCalls()) viaBlind.push(await blind.execute(c, handleOf()))
    assert.equal(viaBlind.length, 4)
    assert.equal(b3.maxActive(), 1, `不转发的包装该退成串行（实际 ${b3.maxActive()}）——负对照没成立`)
    console.log(
      `⑤ 读数：holderFace 之后最多 ${b.maxActive()} 条 · withStepsLeft 之后 ${b2.maxActive()} 条` +
        ` · 不转发那一档 ${b3.maxActive()} 条（负对照）· 那一句 ${JSON.stringify((got?.[0]?.output ?? '').slice(-40))}`,
    )
  })
})
