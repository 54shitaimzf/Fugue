// 作者：**一页正文是怎么写出来的**（交接单 § 2.5）。这一份把"读"与"写"接起来，并决定读几轮。
//
// 两条策略，**同一处接缝**：
//
//   · `loop`（缺省）——一轮轮点名，直到模型说读够了或预算用完，再写。
//   · `two-pass`——一次取证点名 + 一次补读行段 + 一次写作；可选的那一档。同一个读取层、
//     同一份提示词链、同一条写作调用，只是"问几次"不同。
//
// 新能力换策略，不换代码路径：`docs.read` 选一条，`build.ts` 只认 `Author` 这个接口。
import { checkContent } from './check.ts'
import type { DocCaller, DocsPlan, Materials, PageContent, PageDef, ReadStrategy, TreeFacts } from './contract.ts'
import { EVIDENCE_MAX } from './prompt.ts'
import type { PromptChain } from './prompt.ts'
import { openRead, LOOP_BUDGET, TWO_PASS_BUDGET } from './reader.ts'
import type { ReadAsk } from './reader.ts'
import { sumUsage } from './usage.ts'
import type { Excerpt } from './facts.ts'
import type { Usage } from '../model/contract.ts'
import type { Truth } from '../truth/contract.ts'
import type { CommitId } from '../terms.ts'
import type { ThemeSpec } from './theme.ts'

/** 自由读最多几轮（第一轮照取证合同收 12 处，之后每轮最多 6 处，见 `LOOP_BUDGET`）。 */
const LOOP_ROUNDS = 8

export interface AuthorInput {
  readonly page: PageDef
  readonly plan: DocsPlan
  readonly theme: ThemeSpec
  readonly facts: TreeFacts
  readonly source: string
  readonly materials: Materials
  readonly prompt: PromptChain
  readonly caller: DocCaller
  readonly truth: Truth
  readonly commit: CommitId
  /** 取证那一趟发不发（`--no-evidence` 与测试的退化档）。 */
  readonly read: boolean
}

export interface Authored {
  readonly markdown: string
  readonly evidence: PageContent['evidence']
  readonly notes: readonly string[]
  readonly usage: Usage | null
  readonly evidenceUsage: Usage | null
  readonly rangeUsage: Usage | null
  /** 这一页真发出去的模型调用次数（自由读的一轮轮都算）。 */
  readonly calls: number
}

export interface Author {
  readonly name: ReadStrategy
  write(input: AuthorInput): Promise<Authored>
}

/** 模型给的那一段 JSON：取第一段 `{…}`。**解析不了就是空**。 */
function jsonOf(text: string): Record<string, unknown> | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (m === null) return null
  try {
    const v = JSON.parse(m[0]) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 一份清单里的条目：字符串，或 `{path, from, to}`（已经知道要哪几行）。 */
function asksOf(raw: unknown): ReadAsk[] {
  if (!Array.isArray(raw)) return []
  const out: ReadAsk[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item.trim() !== '') {
      out.push({ path: item.trim(), from: null, to: null })
      continue
    }
    if (typeof item === 'object' && item !== null) {
      const o = item as { path?: unknown; from?: unknown; to?: unknown }
      if (typeof o.path !== 'string' || o.path.trim() === '') continue
      const from = typeof o.from === 'number' && Number.isInteger(o.from) && o.from > 0 ? o.from : null
      const to = typeof o.to === 'number' && Number.isInteger(o.to) && o.to >= (from ?? 0) ? o.to : null
      out.push({ path: o.path.trim(), from, to: from === null ? null : to })
    }
  }
  return out
}

/** 取证那一趟的 JSON：`{"paths":[…]}`。 */
function pathsOf(text: string): ReadAsk[] {
  const v = jsonOf(text)
  return v === null ? [] : asksOf(v.paths)
}

/** 补读那一趟的 JSON：`{"ranges":[…]}`。 */
function rangesOf(text: string): ReadAsk[] {
  const v = jsonOf(text)
  return v === null ? [] : asksOf(v.ranges)
}

/** 几次取证的用量合起来（自由读会有好几轮）。`null` 不当 0。 */
function addUsage(list: readonly (Usage | null)[]): Usage | null {
  if (list.length === 0) return null
  const s = sumUsage(list)
  if (s.inputTokens === null && s.cacheReadTokens === null && s.cacheWriteTokens === null && s.outputTokens === null) return null
  return {
    inputTokens: s.inputTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheWriteTokens: s.cacheWriteTokens,
    outputTokens: s.outputTokens,
    reasoningTokens: null,
    model: null,
  }
}
/** 所有策略共用的收尾：拿摘录去写那一趟，再核正文形状。 */
async function writeWith(input: {
  readonly page: PageDef
  readonly plan: DocsPlan
  readonly theme: ThemeSpec
  readonly source: string
  readonly materials: Materials
  readonly prompt: PromptChain
  readonly caller: DocCaller
  readonly excerpts: readonly Excerpt[]
  readonly missing: readonly string[]
  readonly notes: string[]
}): Promise<{ markdown: string; usage: Usage | null }> {
  const words = input.prompt.writing({
    page: input.page,
    plan: input.plan,
    theme: input.theme,
    source: input.source,
    materials: input.materials,
    excerpts: input.excerpts,
    evidenceMissing: input.missing,
  })
  const call = await input.caller.call({
    system: words.shared,
    context: words.page,
    task: words.task,
    ...(input.plan.maxTokens === undefined ? {} : { maxTokens: input.plan.maxTokens }),
  })
  input.notes.push(...checkContent(input.page, call.text))
  return { markdown: call.text, usage: call.usage }
}

/** 没读成的那一句：**退到"只有来源与索引"那一档**，不是跑不起来（交接单 § 2.5 的地板）。 */
function degradeNote(err: unknown): string {
  return `取证这一趟没成，这一页按来源与索引写：${(err as Error).message}`
}

const EMPTY: PageContent['evidence'] = { mode: 'skipped', requested: [], found: [], missing: [], ranges: [] }

/** 两趟：点名 → 读 → 截断的补行段 → 写。 */
const twoPass: Author = {
  name: 'two-pass',
  async write(input: AuthorInput): Promise<Authored> {
    const notes: string[] = []
    const session = openRead({ truth: input.truth, commit: input.commit, known: new Set(input.facts.paths), budget: TWO_PASS_BUDGET })
    let evidence: PageContent['evidence'] = EMPTY
    let evidenceUsage: Usage | null = null
    let rangeUsage: Usage | null = null
    let calls = 1 // 写作那一趟
    if (input.read) {
      let text = ''
      try {
        const words = input.prompt.evidence({ page: input.page, plan: input.plan, source: input.source })
        const call = await input.caller.call({
          system: words.shared,
          context: words.page,
          task: words.task,
          maxTokens: 4096,
          thinking: 'low',
        })
        text = call.text
        evidenceUsage = call.usage
        calls += 1
      } catch (err) {
        notes.push(degradeNote(err))
      }
      const asks = pathsOf(text).slice(0, TWO_PASS_BUDGET.paths)
      if (asks.length > 0) {
        await session.read(asks)
        const cut = session.excerpts.filter((x) => x.truncated)
        let rangeNote: string | null = null
        if (cut.length > 0 && session.room) {
          try {
            const words = input.prompt.ranges({ page: input.page, excerpts: cut })
            const call = await input.caller.call({
              system: words.shared,
              context: words.page,
              task: words.task,
              maxTokens: 2048,
              thinking: 'low',
            })
            rangeUsage = call.usage
            calls += 1
            await session.extend(rangesOf(call.text))
          } catch (err) {
            rangeNote = `补读行段那一趟没成，截断的文件只有第一段：${(err as Error).message}`
          }
        }
        const unread = session.unread()
        if (rangeNote !== null) notes.push(unread.length === 0 ? rangeNote : `${rangeNote}；${unread[0]!}`)
        else notes.push(...unread)
        evidence = { mode: 'requested', ...session.log }
      }
    }
    const written = await writeWith({
      page: input.page,
      plan: input.plan,
      theme: input.theme,
      source: input.source,
      materials: input.materials,
      prompt: input.prompt,
      caller: input.caller,
      excerpts: session.excerpts,
      missing: evidence.missing,
      notes,
    })
    return { markdown: written.markdown, evidence, notes, usage: written.usage, evidenceUsage, rangeUsage, calls }
  },
}

/** 自由读：一轮轮点名（新的读开头，读过的补行段），直到读够了或预算用完，再写。 */
const loop: Author = {
  name: 'loop',
  async write(input: AuthorInput): Promise<Authored> {
    const notes: string[] = []
    const session = openRead({ truth: input.truth, commit: input.commit, known: new Set(input.facts.paths), budget: LOOP_BUDGET })
    let evidence: PageContent['evidence'] = EMPTY
    let evidenceUsage: Usage | null = null
    let calls = 1 // 写作那一趟
    if (input.read) {
      evidenceUsage = null
      const usages: Usage[] = []
      let askedAny = false
      for (let round = 0; round < LOOP_ROUNDS; round++) {
        if (!session.room) break
        let text = ''
        try {
          const words =
            round === 0
              ? input.prompt.evidence({ page: input.page, plan: input.plan, source: input.source })
              : input.prompt.again({ page: input.page, plan: input.plan, source: input.source, excerpts: session.excerpts, round })
          const call = await input.caller.call({
            system: words.shared,
            context: words.page,
            task: words.task,
            maxTokens: round === 0 ? 4096 : 2048,
            thinking: 'low',
          })
          text = call.text
          calls += 1
          if (call.usage !== null) usages.push(call.usage)
        } catch (err) {
          notes.push(round === 0 ? degradeNote(err) : `继续取证那一趟没成，按已经读到的写：${(err as Error).message}`)
          break
        }
        // 第一轮问的是取证合同（“最多 12 条”），之后各轮问的是继续取证合同（“最多 6 条”）：
        // 收几处跟着那一轮发出去的合同走，不然模型点了 12 处、宿主只看 6 处，后 6 处连清单都不进。
        const cap = round === 0 ? EVIDENCE_MAX : LOOP_BUDGET.paths
        const asks = pathsOf(text).slice(0, cap)
        if (asks.length === 0) break
        const before = session.chars
        await session.ask(asks, cap)
        if (session.log.requested.length > 0) askedAny = true
        if (session.chars === before) break // 这一轮没读到任何新东西：再问也是同一份
      }
      evidenceUsage = addUsage(usages)
      if (askedAny) {
        notes.push(...session.unread())
        evidence = { mode: 'requested', ...session.log }
      }
    }
    const written = await writeWith({
      page: input.page,
      plan: input.plan,
      theme: input.theme,
      source: input.source,
      materials: input.materials,
      prompt: input.prompt,
      caller: input.caller,
      excerpts: session.excerpts,
      missing: evidence.missing,
      notes,
    })
    return { markdown: written.markdown, evidence, notes, usage: written.usage, evidenceUsage, rangeUsage: null, calls }
  },
}

/** 按配置选一条策略。**默认自由读**：验过之后翻的默认；两趟是可选的那一档。 */
export function authorOf(name: ReadStrategy): Author {
  return name === 'loop' ? loop : twoPass
}
