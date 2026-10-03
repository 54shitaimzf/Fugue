// 内部不变量那张网。出处：ROADMAP § 3 的 0.2.9 行 ①（**先落网，再拆除**）——它守的正是
// ②③⑤⑥ 各条要撤掉的那些载入期核对。
//
// **它守的是"我们自己两份声明对不对得上"。** 这个仓库直跑 `.ts`（strip-only · 没有 tsc），
// 所以"两处声明漂移"这类错没有编译期报错；原先唯一的接手人是模块载入时的那几句 `throw`。
// 那些 throw 有两个毛病：**每一条 import 都付一遍**，而且**有一半是自证**——比的是自己那份
// 副本（`capability/table.ts` 拿自己文件里的名字字面量核自己的表），恒真，抓不住漂移。
// 0.2.9 把它们收进这里：网在测试里跑一次，红了就是红了，而生产路径上不再有那句恒真的话。
//
// **正半**：真状态喂进每一条判据，期望 0 处。真状态不是手搓的常量——能力表与工具目录各自
// 从产品那一份读，协议值 · 契约 · 装配后的段值都走产品自己的那条路（`build()` ·
// `sourcesFor()` · `assemble()`）。
// **负半**：逐类注入缺陷，期望每一条都报出来。报不出来的那一条就是空转的香炉——**这个工具
// 自己会为它红**（`FAIL` 一行 + 退出码 1）。负对照不是"故意让判据红一次"，是问每一条判据：
// 给它一份坏输入，它答不答得出"不对"。
//
// **撤掉一处生产检查，它守过的东西必须在这里先咬得住。** 每条负对照印出来的就是那个证据。
//
// 跑法：cd ~/fugue && node tools/check-invariants.ts
// 挂档：`test/check-invariants.test.ts`（fast 组）跑它、读退出码与逐条负对照的标签。
// `FUGUE_EVENTS` 可以指向另一份 `events.ts`（测试拿它做端到端的红负对照，与 `probe-assemble.ts`
// 的 `FUGUE_ARCH` 同一个用法）。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CapabilityRow } from '../src/capability/table.ts'
import { checkCapabilityInvariants } from './capability-invariants.ts'
import { CAPABILITY_TABLE, checkInvariant } from '../src/capability/table.ts'
import type { ToolEntry } from '../src/tools/catalog.ts'
import { TOOL_ENTRIES, TOOL_NAMES } from '../src/tools/catalog.ts'
import type { Protocol, SegmentId } from '../src/assemble/contract.ts'
import { HOLDER_B, ZONE_SEGMENTS } from '../src/assemble/contract.ts'
import { HOLDER_PROTOCOL, SUBAGENT_PROTOCOL, checkProtocolInvariant } from '../src/assemble/protocol.ts'
import { assemble } from '../src/assemble/assemble.ts'
import type { AgentCoord, AssembleState } from '../src/assemble/sources.ts'
import { SOURCE_NAMES, emptyState, sourcesFor } from '../src/assemble/sources.ts'
import { defaultModelOf, BUILTIN_CATALOG } from '../src/model/catalog.ts'
import type { BuildDeps, Intent } from '../src/contract/build.ts'
import { build, variantFieldsMatch } from '../src/contract/build.ts'
import type { Assertion, Contract } from '../src/contract/types.ts'
import { VARIANT_FIELDS } from '../src/contract/types.ts'
import type { LogEvent } from '../src/log/events.ts'
import { encodeEvent } from '../src/log/envelope.ts'
import type { BranchId, CommitId, LogSeq, RelPath, RoundId, WriterId } from '../src/terms.ts'

/** 代码工作区：这个工具就住在它底下，所以它由 `import.meta.url` 定，不由环境变量定。 */
const REPO = fileURLToPath(new URL('..', import.meta.url))
const EVENTS = process.env['FUGUE_EVENTS'] ?? join(REPO, 'src', 'log', 'events.ts')

let failed = 0
function ok(msg: string): void {
  console.log(`  ok   ${msg}`)
}
function bad(msg: string): void {
  failed++
  console.log(`  FAIL ${msg}`)
}
function eq<T>(what: string, got: T, want: T): void {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) ok(`${what}：${g}`)
  else bad(`${what}：拿到 ${g}，要的是 ${w}`)
}
function say(msg: string): void {
  console.log(`  ·    ${msg}`)
}
function note(msg: string): void {
  console.log(`  --   ${msg}`)
}

/**
 * 一条负对照的判据：**给一份坏输入，它必须报出那一处。**
 *
 * 报 0 处 = 这条判据恒真（空转的香炉）；报了几处但不含预期那一串 = 报的是别的事，仍然不算
 * 咬住了。`needle` 由外面给，是从缺陷那一处长出来的名字——不这样要求的话，"什么都报"的
 * 判据也能过。
 */
function expectProblems(what: string, got: readonly string[], needle: string): void {
  if (got.length === 0) {
    bad(`${what}：一处都没报——这条判据恒真`)
    return
  }
  if (!got.some((m) => m.includes(needle))) {
    bad(`${what}：报了 ${got.length} 处，没有一处提到「${needle}」：${got.join(' | ')}`)
    return
  }
  ok(`${what} → ${got.length} 处，其中一处：${got.find((m) => m.includes(needle))}`)
}

/** 段序里有没有哪个段压根没有源。少了它的后果是装配静默少一段，没有别的报错。 */
function missingSources(order: readonly SegmentId[], have: readonly SegmentId[]): string[] {
  return order.filter((id) => !have.includes(id)).map((id) => `这一段没有源：${id}`)
}

console.log('0.2.9 · 内部不变量那张网：正半（真状态 0 处）与负半（逐类注入必须红）\n')

// ── 一 · 能力表 ↔ 工具目录 ──────────────────────────────────────────────────────
//
// 两道声明分居两个文件：`capability/table.ts` 的 `LAYER_TABLE`（谁落在哪一层）与
// `tools/catalog.ts` 的 `TOOL_ENTRIES`（名字的值域）。两边不一致的后果**只有一种**——某个
// 工具的推论静默地少一条，或者表里有一格谁也查不到。架构 § 8.9 的原话是「少了这一层都
// 编译不过」，而这里没有 tsc，所以那句话的机器可读形态就是这一节。
console.log('一 · 能力表 ↔ 工具目录（§ 8.9 全函数 · § 8.10 唯一定义处）')
{
  const names: string[] = [...TOOL_NAMES]
  eq('真状态：能力表对得上目录那份名字', checkInvariant(CAPABILITY_TABLE, names), [])
  eq('真状态：目录重名、层域、能力身份与声明集类型', checkCapabilityInvariants(), [])
  eq(
    '真状态：目录那份名字就是从 `TOOL_ENTRIES` 算出来的（名字只有一处）',
    names,
    TOOL_ENTRIES.map((t: ToolEntry) => t.name),
  )
  say(`能力表 ${Object.keys(CAPABILITY_TABLE).length} 行 · 目录 ${TOOL_ENTRIES.length} 条`)

  const short = names.slice(0, names.length - 1)
  const gone = names[names.length - 1] ?? ''
  expectProblems('负对照（截短名表一格）', checkInvariant(CAPABILITY_TABLE, short), gone)

  const invented = 'invented_tool'
  const withExtra: Record<string, CapabilityRow> = {
    ...CAPABILITY_TABLE,
    [invented]: { layer: 'view', capability: invented, decl: false },
  }
  expectProblems('负对照（层表里多一个目录没有的名字）', checkInvariant(withExtra, names), invented)

  const wrongDecl: Record<string, CapabilityRow> = {
    ...CAPABILITY_TABLE,
    read: { layer: 'view', capability: 'read', decl: true },
  }
  expectProblems('负对照（声明集挂到了视图层）', checkInvariant(wrongDecl, names), 'read')

  expectProblems('负对照（目录重名）', checkCapabilityInvariants([...TOOL_ENTRIES, TOOL_ENTRIES[0]!]), '工具目录重名')
  const unknownLayer = {
    ...CAPABILITY_TABLE, read: { ...CAPABILITY_TABLE.read!, layer: 'unknown', decl: false },
  } as unknown as Readonly<Record<string, CapabilityRow>>
  expectProblems('负对照（层域未声明）', checkCapabilityInvariants(TOOL_ENTRIES, unknownLayer), '层未声明')
  const duplicateCapability = { ...CAPABILITY_TABLE, read: { ...CAPABILITY_TABLE.read!, capability: 'write' } }
  expectProblems('负对照（能力标识重名）', checkCapabilityInvariants(TOOL_ENTRIES, duplicateCapability), '能力标识重名')
  const nonBooleanDecl = {
    ...CAPABILITY_TABLE, bash: { ...CAPABILITY_TABLE.bash!, decl: 'false' },
  } as unknown as Readonly<Record<string, CapabilityRow>>
  expectProblems('负对照（声明集标记非布尔）', checkCapabilityInvariants(TOOL_ENTRIES, nonBooleanDecl), '不是布尔值')
}

// ── 二 · 协议的两份声明 ────────────────────────────────────────────────────────
//
// 段序 · 区 · 渲染规则三者分居两处（`protocol.ts` 的 `protocolOf` 与 `contract.ts` 的
// `ZONE_SEGMENTS`）。不一致的后果同样只有一种：前缀的字节不同——少一段（有源没人排它的序）、
// 多一段（排了序没有源）、重复一段、渲染规则缺一条，四种都只是"哈希变了"，没有任何一方报错。
console.log('\n二 · 协议的两份声明：段序 · 区 · 渲染规则（§ 8.11）')
{
  eq('真状态：子 agent 那份与区表对得上', checkProtocolInvariant(SUBAGENT_PROTOCOL, ZONE_SEGMENTS.B), [])
  eq('真状态：持轮者那份与区表对得上', checkProtocolInvariant(HOLDER_PROTOCOL, HOLDER_B), [])
  say(
    `子 agent ${SUBAGENT_PROTOCOL.segmentOrder.length} 段 · 持轮者 ${HOLDER_PROTOCOL.segmentOrder.length} 段 · ` +
      `渲染规则 ${Object.keys(SUBAGENT_PROTOCOL.renderers).length} 条`,
  )

  /** 一份坏声明：改哪一处由外面给。**深拷一层**——不许碰到产品那两个真值。 */
  const broken = (
    mutate: (p: { version: string; segmentOrder: SegmentId[]; toolCatalog: string[]; renderers: Record<string, string> }) => void,
  ): string[] => {
    const p = {
      version: SUBAGENT_PROTOCOL.version,
      segmentOrder: [...SUBAGENT_PROTOCOL.segmentOrder],
      toolCatalog: [...SUBAGENT_PROTOCOL.toolCatalog],
      renderers: { ...(SUBAGENT_PROTOCOL.renderers as unknown as Record<string, string>) },
    }
    mutate(p)
    return checkProtocolInvariant(p as unknown as Protocol, ZONE_SEGMENTS.B)
  }

  const lastId = SUBAGENT_PROTOCOL.segmentOrder[SUBAGENT_PROTOCOL.segmentOrder.length - 1] as SegmentId
  const cases: readonly (readonly [string, string, () => string[]])[] = [
    ['短一段（从段序里去掉最后一节）', lastId, () => broken((p) => { p.segmentOrder = p.segmentOrder.filter((s) => s !== lastId) })],
    ['多一段（把持轮者独占的那一段排进来）', '凝聚理解', () => broken((p) => { p.segmentOrder = [...p.segmentOrder, '凝聚理解' as SegmentId] })],
    ['重复一段', '代码树', () => broken((p) => { p.segmentOrder = [...p.segmentOrder, '代码树' as SegmentId] })],
    ['缺一条渲染规则', '信号摘要', () => broken((p) => { delete p.renderers['信号摘要'] })],
    ['多一段不属于任何一个区的', '凭空一段', () => broken((p) => { p.segmentOrder = [...p.segmentOrder, '凭空一段' as SegmentId] })],
    ['工具目录是空的', '工具目录', () => broken((p) => { p.toolCatalog = [] })],
  ]
  for (const [what, needle, run] of cases) expectProblems(`负对照（${what}）`, run(), needle)
}

// ── 三 · 段源覆盖 ──────────────────────────────────────────────────────────────
//
// 每个协议声明的段都要有一份源。少了它的后果是装配给一个空值照跑（那正是 0.2.9 ④ 要熄掉的
// 那处兜底）——段短了，而前缀照样算得出来，没有一处报错。所以这一条必须在兜底撤掉之前咬住。
console.log('\n三 · 段源：每个协议声明的段都有一份源（走了产品自己那条装配路）')
{
  const MODEL = defaultModelOf(BUILTIN_CATALOG).id
  const WHO: AgentCoord = { id: 'agent-2', branch: 'agent-2', outputPaths: ['deliver/agent-2/report.md'] }
  const both: readonly (readonly [string, Protocol, readonly SegmentId[], AgentCoord | null])[] = [
    ['subagent', SUBAGENT_PROTOCOL, ZONE_SEGMENTS.B, WHO],
    ['holder', HOLDER_PROTOCOL, HOLDER_B, null],
  ]
  for (const [name, protocol, , who] of both) {
    eq(`真状态：${name} 的段序每一个都有源`, missingSources(protocol.segmentOrder, SOURCE_NAMES), [])
    const state: AssembleState = emptyState()
    const values = sourcesFor(protocol, state, who)
    eq(`真状态：${name} 走产品那份源之后，键域 == 段序`, Object.keys(values), [...protocol.segmentOrder])
    const prefix = assemble({ protocol, model: MODEL, segments: values })
    say(`${name}：A ${prefix.zoneA.length} 字节 · B ${prefix.zoneB.length} 字节 · C ${prefix.zoneC.length} 字节`)
  }
  expectProblems(
    '负对照（段序里排了一个没有源的段）',
    missingSources([...SUBAGENT_PROTOCOL.segmentOrder, '凭空一段' as SegmentId], SOURCE_NAMES),
    '凭空一段',
  )
}

// ── 四 · 契约的字段表 ↔ 造出来的契约 ────────────────────────────────────────────
//
// `VARIANT_FIELDS` 说"三个变体各该有哪几笔"，而契约值由 `build()` 一处造出来。两者不一致的
// 后果是某一份契约多带一个字段（读的人当它有意义）或少带一个（`checkContract` 报出来时指向
// 的是别人）。造契约走产品那个构造器，**不手搓**。
console.log('\n四 · 契约：造出来的每一份，字段与它那一个变体的字段表逐字相同（§ 8.12）')
{
  const BASE = '0'.repeat(40) as CommitId
  const INTENT: Intent = {
    goal: '把这一站的断言落下来。',
    question: '这一条断言守的是什么？',
    evidenceRequired: [{ note: '一份读数' }],
  }
  const DEPS: BuildDeps = {
    round: 'r1' as RoundId,
    base: BASE,
    identityFor: (n: number) => ({ agent: `agent-${n + 1}`, branch: `agent-${n + 1}` as BranchId }),
    seedOf: () => [],
    split: [
      {
        goal: '实现第一段。',
        ownedPaths: ['src/a.ts' as RelPath],
        assertions: [{ action: 'test' as Assertion['action'], name: 'a' }],
      },
      {
        goal: '实现第二段。',
        ownedPaths: ['src/b.ts' as RelPath],
        deliverables: [{ path: 'src/b.ts' as RelPath, form: '一个文件' }],
        assertions: [{ action: 'test' as Assertion['action'], name: 'b' }],
      },
    ],
    conflicts: {
      base: BASE,
      conflictPaths: ['src/c.ts' as RelPath],
      assertions: [{ action: 'test' as Assertion['action'], name: 'c' }],
    },
  }
  const built = build(INTENT, DEPS)
  eq(
    '真状态：三个变体各造了几份',
    [built.counts.implement, built.counts.investigate, built.counts.resolve],
    [2, 1, 1],
  )
  eq('真状态：造出来的契约与变体字段表对得上', variantFieldsMatch(VARIANT_FIELDS, built.contracts), [])
  say(`造出来的契约：${built.contracts.map((c: Contract) => `${c.id}(${c.kind})`).join(' · ')}`)

  const impl = built.contracts.find((c: Contract) => c.kind === 'implement') as Contract
  expectProblems(
    '负对照（给实现型多塞一个字段）',
    variantFieldsMatch(VARIANT_FIELDS, [{ ...impl, question: '多余的' } as unknown as Contract]),
    impl.id,
  )
  const dropped: Record<string, unknown> = { ...impl }
  delete dropped['seed']
  expectProblems(
    '负对照（从实现型里去掉一个必有的字段）',
    variantFieldsMatch(VARIANT_FIELDS, [dropped as unknown as Contract]),
    impl.id,
  )
}

// ── 五 · 事件载荷键 ↔ 信封字段 ─────────────────────────────────────────────────
//
// 信封自己的四个键（`seq` · `writer` · `crc` · `t`）与事件的载荷在同一层上：编码时
// `{...payload}` 排在信封那几栏**后面**，所以载荷里同名的键会把信封顶掉——一行读出来是什么
// 从根上就不确定。它是**我们自己两份声明之间**的事（`events.ts` 的联合 ↔ `envelope.ts` 的
// 信封形状），所以判据落在声明上，不落在每一次编码上。
//
// 信封的那几个键**从编码器的输出里读出来**，不在这里另抄一份：抄一份就是第二处真相。
console.log('\n五 · 事件载荷键 ↔ 信封字段（§ 9.2）')
{
  const reserved = Object.keys(
    JSON.parse(encodeEvent(1 as LogSeq, 'round' as WriterId, { t: 'probe' } as unknown as LogEvent)) as Record<string, unknown>,
  )
  say(`信封自己的键（从编码器输出读出来）：${reserved.join(' · ')}`)

  if (!existsSync(EVENTS)) {
    bad(`事件联合那一份不在：${EVENTS}`)
  } else {
    const text = readFileSync(EVENTS, 'utf8')
    const declared = [...text.matchAll(/\bt\s*:\s*'([^']+)'/g)].map((m) => m[1] ?? '')
    const variants = variantsOf(text)
    eq('正半：解析出来的格数 == 源里 `t` 那一栏的条数（解析器一格都没漏）', variants.length, declared.length)
    ok(`一共 ${variants.length} 格事件：${variants.map((v) => v.tag ?? '(没有 t)').join(' · ')}`)
    eq('真状态：没有一格的载荷字段与信封字段重名', envelopeKeyProblems(variants, reserved), [])
    eq(
      '真状态：解析出来的判别名与源里那一栏逐字相同',
      variants.map((v) => v.tag),
      declared,
    )
    eq(
      '真状态：每一格都写出了判别名（没写出来的那一格上面那条会报）',
      variants.filter((v) => v.tag === null).length,
      0,
    )

    // **负对照拿真源改一处**：光搓一份假联合只能证判据本身，证不了"它读的是那一份真文件"。
    const mutated = text.replace(
      "t: 'view/write'; agent: AgentId",
      "t: 'view/write'; crc: string; agent: AgentId",
    )
    eq('负对照的前置：真源改得动', mutated === text, false)
    expectProblems('负对照（真源里给一格加一个信封字段 crc）', envelopeKeyProblems(variantsOf(mutated), reserved), 'crc')
    const noTag = text.replace("t: 'view/write'; ", '')
    eq('负对照的前置：真源里那一格改得动', noTag === text, false)
    expectProblems('负对照（真源里一格没有 `t`）', envelopeKeyProblems(variantsOf(noTag), reserved), '没有 `t`')

    // 判据自己那一问：一组不是事件的联合，它答不答得出"不对"。
    const FAKE = "export type LogEvent =\n  | { t: 'a/b'; agent: AgentId; seq: number }\n  | { t: 'c/d'; agent: AgentId }\n"
    eq('负对照的前置：假联合解析出两格', variantsOf(FAKE).length, 2)
    expectProblems('负对照（载荷里出现信封字段 seq）', envelopeKeyProblems(variantsOf(FAKE), reserved), 'seq')
    const NO_T = "export type LogEvent =\n  | { agent: AgentId }\n"
    eq('负对照的前置：这一份假联合没有判别名', variantsOf(NO_T)[0]?.tag ?? null, null)
    expectProblems('负对照（一格压根没有 `t`）', envelopeKeyProblems(variantsOf(NO_T), reserved), '没有 `t`')
    // 空输入：解析器给 0 格（上面那条"格数 == t 那一栏条数"是它不会静默通过的保证）。
    eq('负对照：空文本解析出 0 格（不会静默给一份空的联合）', variantsOf('').length, 0)
  }
}

// ── 解析器 ────────────────────────────────────────────────────────────────────
//
// 联合类型在运行时不存在，所以这一条只能在源码文本上判。**跳注释与字符串**是必须的：
// `'view/write'` 那种字面量里有 `/`，注释里有 `:`，两者都会把朴素的扫描带偏。
// `probe-assemble.ts` § 二与 `src/ui/stream.test.ts` 走的是同一条路（读源码文本当判据的输入）。

/** 跳过空白 · 行注释 · 块注释；返回下一处有内容的偏移。 */
function skipTrivia(text: string, from: number): number {
  let i = from
  for (;;) {
    const c = text[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    return i
  }
}

/** 从 `from` 处那个引号起跳到收尾引号之后（认转义）。 */
function skipString(text: string, from: number): number {
  const quote = text[from]
  let i = from + 1
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === quote) return i + 1
    i += 1
  }
  return i
}

/**
 * `export type LogEvent =` 那一整段联合的正文（到最后一个变体为止）。
 *
 * 收尾的判据是"括号回到 0 层、而且下一处有内容的字符不是 `|`"——不是"第一对括号闭合"：
 * 一份联合是 `{…} | {…} | …`，按后者收的话只会拿到第一格。
 */
function unionSourceOf(text: string): string {
  const head = text.indexOf('export type LogEvent =')
  if (head === -1) return ''
  const start = text.indexOf('=', head) + 1
  let i = start
  let depth = 0
  let started = false
  while (i < text.length) {
    const c = text[i] as string
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(text, i)
      continue
    }
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = skipTrivia(text, i)
      continue
    }
    if (c === '{' || c === '[' || c === '(') {
      depth += 1
      started = true
    } else if (c === '}' || c === ']' || c === ')') {
      depth -= 1
      if (started && depth === 0) {
        const next = skipTrivia(text, i + 1)
        if (text[next] !== '|') return text.slice(start, i + 1)
        i = next
        continue
      }
    }
    i += 1
  }
  return text.slice(start)
}

/** 按 0 层上的 `|` 切开一份联合；注释与字符串里的 `|` 不算。 */
function splitVariants(union: string): string[] {
  const out: string[] = []
  let from = 0
  let depth = 0
  let i = 0
  while (i < union.length) {
    const c = union[i] as string
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(union, i)
      continue
    }
    if (c === '/' && (union[i + 1] === '/' || union[i + 1] === '*')) {
      i = skipTrivia(union, i)
      continue
    }
    if (c === '{' || c === '[' || c === '(') depth += 1
    else if (c === '}' || c === ']' || c === ')') depth -= 1
    else if (c === '|' && depth === 0) {
      out.push(union.slice(from, i))
      from = i + 1
    }
    i += 1
  }
  out.push(union.slice(from))
  return out.map((s) => s.trim()).filter((s) => s !== '')
}

/**
 * 一格事件对象里**第 1 层**的成员名。
 *
 * 只认第 1 层：载荷里嵌一层对象（`usage: {…}`）时，里面那些名字不是信封的同层竞争者——
 * 把它们也算上就是误伤。判据是"这个标识符后面（跳过 `?` 与空白）紧跟一个 `:`"。
 */
function membersOf(variant: string): string[] {
  const out: string[] = []
  let depth = 0
  let i = 0
  const isStart = (c: string): boolean => /[A-Za-z_$]/.test(c)
  const isPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c)
  while (i < variant.length) {
    const c = variant[i] as string
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(variant, i)
      continue
    }
    if (c === '/' && (variant[i + 1] === '/' || variant[i + 1] === '*')) {
      i = skipTrivia(variant, i)
      continue
    }
    if (c === '{' || c === '[' || c === '(') {
      depth += 1
      i += 1
      continue
    }
    if (c === '}' || c === ']' || c === ')') {
      depth -= 1
      i += 1
      continue
    }
    if (depth === 1 && isStart(c)) {
      const start = i
      while (i < variant.length && isPart(variant[i] as string)) i += 1
      const name = variant.slice(start, i)
      let j = i
      if (variant[j] === '?') j += 1
      j = skipTrivia(variant, j)
      if (variant[j] === ':') {
        out.push(name)
        i = j + 1
        continue
      }
      continue
    }
    i += 1
  }
  return out
}

/** 一份联合文本 → 逐格的判别名与成员名。**判别名读不出来也给一格**（`tag: null`）—— */
/** 静默丢掉它的话，"这一格没有 `t`"就永远报不出来，而那正是信封认行的依据。 */
function variantsOf(text: string): { tag: string | null; fields: string[] }[] {
  const union = unionSourceOf(text)
  if (union === '') return []
  const out: { tag: string | null; fields: string[] }[] = []
  for (const one of splitVariants(union)) {
    out.push({ tag: /t\s*:\s*'([^']*)'/.exec(one)?.[1] ?? null, fields: membersOf(one) })
  }
  return out
}

/**
 * 逐格问两件事：**它带 `t` 吗**（信封靠它认这一行是什么事件），以及**它的载荷字段有没有
 * 撞上信封自己的键**。撞上的那一格编码时会静默改掉信封，所以它是这一节的全部。
 */
function envelopeKeyProblems(
  variants: readonly { tag: string | null; fields: readonly string[] }[],
  reserved: readonly string[],
): string[] {
  const out: string[] = []
  variants.forEach((v, i) => {
    const where = v.tag === null ? `第 ${i + 1} 格（没写出判别名）` : v.tag
    if (!v.fields.includes('t')) out.push(`${where} 那一格没有 \`t\`：信封靠它认这一行是什么事件`)
    const hits = v.fields.filter((f) => f !== 't' && reserved.includes(f))
    if (hits.length > 0) out.push(`${where} 的载荷字段与信封字段重名：${hits.join(' · ')}——编码时信封那一栏会被载荷顶掉`)
  })
  return out
}

if (failed === 0) note('这张网里的每一条判据都报得出来（负对照逐条印在上面）')
console.log(`\n${failed === 0 ? '全部通过' : `FAIL ${failed} 处`}`)
process.exit(failed === 0 ? 0 : 1)
