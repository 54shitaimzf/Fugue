// 一次生成：**定义 + 来源 + 提交 C 的事实 → 逐页正文 → 渲染 → 校验 → 整批保存**。
//
// 这张图就是交接单 § 2.6 那一张，代码里的次序与它逐条对应：
//
//   1. 核定义（`config.ts`）——写错就停，指出该改的那一格
//   2. 取事实（`facts.ts`）——来源缺失就停，报出是哪一份、哪一条路径
//   3. 逐页取证（模型点名要读的文件与行段）→ 逐页写作（模型给 markdown）
//   4. 宿主校验与呈现：markdown → HTML（`markdown.ts`），套公共交互与主题（`page.ts`）
//   5. 整批替换 + 清单与指纹（`publish.ts`）；最近一次结果单独记（`last.json`）
//
// **两趟调用，材料不同。** 第一趟只要一份"要读哪几份文件"的 JSON；第二趟带上那几份的原文写
// 正文。取证那一趟拿到的文件**可能被截断**：截断的每一份进第二趟取证（"要后面哪几行"），
// 补读的行段与第一段一起进写作输入——"关键实现藏在文件后半部"因此取得着，而不是只能猜。
//
// **生成不等于可信**（交接单 § 2.5）：宿主机械核对的是形状、引用、锚点与整批一致；内容取舍
// 与交互适用性仍要人按读者任务复核。这一份的 `notes` 把"兑不掉的地方"逐条留给复核。
//
// **不回流**：这一份只读定义与提交，读一次旧清单只为算"旧深链接的去向"；旧 HTML 与旧正文
// 从不进写作输入（交接单 § 1.4 末段）。
import type { ConfigDoc } from '../config.ts'
import type { Usage } from '../model/contract.ts'
import type { Truth } from '../truth/contract.ts'
import type { CommitId, RefName } from '../terms.ts'
import { parseDocs } from './config.ts'
import { aliasPlan } from './address.ts'
import { attemptOf, recordAttempt } from './attempt.ts'
import { planAssets } from './assets.ts'
import { checkContent, citedOf } from './check.ts'
import { repoPathOf } from './paths.ts'
import { sumUsage } from './usage.ts'
import type { UsageSum } from './usage.ts'
import type {
  DocsPlan,
  EvidenceRange,
  Manifest,
  Materials,
  ModelFacts,
  PageContent,
  PageDef,
  RenderedPage,
  TreeFacts,
} from './contract.ts'
import { DocsError, MANIFEST_VERSION, PROMPT_VERSION, RENDERER_VERSION, docsRootOf } from './contract.ts'
import { excerptAt, sourceTextOf, treeFactsOf } from './facts.ts'
import type { Excerpt } from './facts.ts'
import { fingerprintOf, modelFactsOf } from './fingerprint.ts'
import type { DocCaller } from './contract.ts'
import { escapeHtml, renderMarkdown } from './markdown.ts'
import type { MdHeading, MdResult } from './markdown.ts'
import { HOST_IDS, renderIndexPage, renderPage } from './page.ts'
import type { SiteInfo } from './page.ts'
import {
  EVIDENCE_MAX,
  EXCERPT_BUDGET,
  EXCERPT_LIMIT,
  RANGE_MAX,
  RANGE_PREVIEW,
  chainOf,
} from './prompt.ts'
import type { PromptChain } from './prompt.ts'
import { digestOf, publishBatch, readManifest } from './publish.ts'
import type { BatchFile } from './publish.ts'
import { recoverPublish } from './publish.ts'
import { searchEntriesOf } from './search.ts'
import type { SearchEntry } from './search.ts'
import { THEME_IDS, themeOf } from './theme.ts'
import type { ThemeSpec } from './theme.ts'

export interface BuildDeps {
  readonly root: string
  /** 合并读过的配置。 */
  readonly config: ConfigDoc
  /** 真源（只读：这一层不写提交、不动 ref）。 */
  readonly truth: Truth
  readonly caller: DocCaller
  /** 写作上下文的来源（自动收口 / 手动重建各一份）。 */
  readonly materials: Materials
  /** 指定提交；缺省 `refs/heads/main`（收口时它是刚写回的那个提交）。 */
  readonly at?: string
  /** 命令行给的主题（同一批内容换一套呈现，验收用）。 */
  readonly theme?: string
  /** 取证那一趟关掉（测试与"只有来源"的退化档）。 */
  readonly evidence?: boolean
  /**
   * **只重渲染**：用已经写好的正文代替模型那一趟（`tools/rerender-docs.js` 用）。
   * 清单语义与指纹口径不变：提交 · 定义 · 来源 · 模型声明照旧参与指纹；
   * 取证事实从上一批搬过来（它描述的是这些正文当时依据的材料）。
   */
  readonly reuse?: {
    readonly markdown: ReadonlyMap<string, string>
    readonly evidence: ReadonlyMap<string, PageContent['evidence']>
    readonly notes: ReadonlyMap<string, readonly string[]>
  }
  /** 记不记"最近一次"（重渲染不记：它不是一次模型生成）。 */
  readonly record?: boolean
  /** 旧地址的去向按这份清单算（重渲染迁移时用上一版真实清单；缺省读当前产物）。 */
  readonly prev?: Manifest | null
  /**
   * 迁移用：上一批只剩“说明”而没有机器记录时，把那些旧地址再拿来认一遍。
   * 只有 `tools/rerender-docs.js` 传它（从旧清单的 note 里取回 0.5.1 时代的地址）。
   */
  readonly revive?: ReadonlyMap<string, readonly string[]>
  readonly now?: () => Date
}

/** 这一趟的用量合计：逐页 + 合计。**真调用留下的读数**（交接单 § 2.5 的判据）。 */
export interface UsageTotal extends UsageSum {
  readonly pages: readonly {
    readonly id: string
    readonly usage: Usage | null
    readonly evidenceUsage: Usage | null
    readonly rangeUsage: Usage | null
  }[]
}

export interface BuildSuccess {
  readonly ok: true
  readonly commit: string
  readonly commitShort: string
  readonly fingerprint: string
  readonly theme: string
  readonly model: string
  readonly version: string | null
  readonly docsDir: string
  readonly generatedAt: string
  readonly materials: Materials
  readonly usage: UsageTotal
  readonly notes: readonly string[]
  readonly pages: readonly {
    readonly id: string
    readonly title: string
    readonly out: string
    readonly headings: readonly MdHeading[]
  }[]
}

export interface BuildFailure {
  readonly ok: false
  /** 失败落在哪一格（`config` · `facts` · `model` · `render` · `publish`）。 */
  readonly at_stage: string
  readonly reason: string
  readonly commit: string | null
  readonly docsDir: string
  readonly materials: Materials
  /** 失败之前已经花掉的调用（第 N 页失败时前 N−1 页的读数不许丢）。 */
  readonly usage: UsageTotal
}

export type BuildOutcome = BuildSuccess | BuildFailure

/** 一页在内存里的中间态。 */
interface Prepared {
  readonly def: PageDef
  readonly markdown: string
  readonly evidence: PageContent['evidence']
  readonly notes: string[]
  readonly usage: Usage | null
  readonly evidenceUsage: Usage | null
  readonly rangeUsage: Usage | null
  /** 第一遍渲染：只取标题表（引用兑不兑得掉还不知道）。 */
  readonly pass1: MdResult
  /** 第二遍：严格解析之后的正文与标题。 */
  pass2: MdResult
  rendered: RenderedPage
}

/** 缺失来源那一句话：**逐份列出是哪一份、哪一条路径**（交接单 § 2.3 的判据）。 */
function missingText(missing: readonly { id: string; source: string }[], commit: string): string {
  const lines = missing.map((m) => `  · 文档 ${m.id}：source 指向 ${m.source}`)
  return `来源在提交 ${commit.slice(0, 12)} 里缺失（${missing.length} 份）：\n${lines.join('\n')}\n  该改的是 ${missing.length === 1 ? '那一份定义' : '那几份定义'}的 source，或者把来源带进这个提交`
}

/** 一次取证点名：路径，可带一段行（`{path, from, to}`）。 */
interface PathAsk {
  readonly path: string
  readonly from: number | null
  readonly to: number | null
}

/** 模型那一趟的 JSON：取第一段 `{…}`。**解析不了就是空**。 */
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

/** 取证第一趟：路径清单；每一条可以是字符串，也可以是 `{path, from, to}`（已经知道要哪几行）。 */
function pathAsksOf(text: string): PathAsk[] {
  const v = jsonOf(text)
  if (v === null || !Array.isArray(v.paths)) return []
  const out: PathAsk[] = []
  for (const raw of v.paths) {
    if (typeof raw === 'string' && raw.trim() !== '') {
      out.push({ path: raw.trim(), from: null, to: null })
      continue
    }
    if (typeof raw === 'object' && raw !== null) {
      const o = raw as { path?: unknown; from?: unknown; to?: unknown }
      if (typeof o.path !== 'string' || o.path.trim() === '') continue
      const from = typeof o.from === 'number' && Number.isInteger(o.from) && o.from > 0 ? o.from : null
      const to = typeof o.to === 'number' && Number.isInteger(o.to) && o.to >= (from ?? 0) ? o.to : null
      out.push({ path: o.path.trim(), from, to: from === null ? null : to })
    }
  }
  return out
}

/** 取证第二趟：补读的行段。 */
function rangesOf(text: string): PathAsk[] {
  const v = jsonOf(text)
  if (v === null || !Array.isArray(v.ranges)) return []
  return pathAsksOf(JSON.stringify({ paths: v.ranges })).slice(0, RANGE_MAX)
}

/**
 * 取证那一趟：模型点名要读的路径 → 真读到的原文；被截断的再问一次"要后面哪几行"。
 *
 * **两次取证，一次写作**：第二趟只在"有文件被截断"时才发。它把截断那几份的开头一小段与总行数
 * 摆在模型面前，让它按行段点名——于是"关键实现放在文件后半部"取得着，而不是只能靠第一段猜。
 */
async function gatherEvidence(o: {
  readonly def: PageDef
  readonly plan: DocsPlan
  readonly facts: TreeFacts
  readonly source: string
  readonly truth: Truth
  readonly commit: CommitId
  readonly caller: DocCaller
  readonly prompt: PromptChain
}): Promise<{ evidence: PageContent['evidence']; excerpts: Excerpt[]; note: string | null; usage: Usage | null; rangeUsage: Usage | null }> {
  const empty: PageContent['evidence'] = { mode: 'skipped', requested: [], found: [], missing: [], ranges: [] }
  let text: string
  let usage: Usage | null = null
  try {
    const ask = o.prompt.evidence({ page: o.def, plan: o.plan, source: o.source })
    const call = await o.caller.call({
      system: ask.shared,
      context: ask.page,
      task: ask.task,
      maxTokens: 4096,
      thinking: 'low',
    })
    text = call.text
    usage = call.usage
  } catch (err) {
    // **退到"只有来源与索引"那一档**：写得少，不是跑不起来（交接单 § 2.5 的地板）。
    return { evidence: empty, excerpts: [], note: `取证这一趟没成，这一页按来源与索引写：${(err as Error).message}`, usage: null, rangeUsage: null }
  }
  const asks = pathAsksOf(text).slice(0, EVIDENCE_MAX)
  if (asks.length === 0) return { evidence: empty, excerpts: [], note: null, usage, rangeUsage: null }

  const known = new Set(o.facts.paths)
  const missing: string[] = []
  const requested: string[] = []
  const excerpts: Excerpt[] = []
  let budget = EXCERPT_BUDGET
  for (const ask of asks) {
    requested.push(ask.path)
    if (!known.has(ask.path)) {
      missing.push(ask.path)
      continue
    }
    const x = await excerptAt(o.truth, o.commit, ask.path, {
      limit: Math.min(EXCERPT_LIMIT, Math.max(1, budget)),
      ...(ask.from === null ? {} : { ranges: [{ from: ask.from, to: ask.to ?? ask.from + 200 }] }),
    })
    if (x === null) {
      missing.push(ask.path)
      continue
    }
    budget -= x.text.length
    excerpts.push(x)
  }

  // 第二趟：截断的那几份问行段。**一次都问不出来就退到"只有第一段"**，并记一条 note。
  let rangeUsage: Usage | null = null
  let note: string | null = null
  const cut = excerpts.filter((x) => x.truncated)
  if (cut.length > 0 && budget > 0) {
    try {
      const ask = o.prompt.ranges({ page: o.def, excerpts: cut })
      const call = await o.caller.call({
        system: ask.shared,
        context: ask.page,
        task: ask.task,
        maxTokens: 2048,
        thinking: 'low',
      })
      rangeUsage = call.usage
      const asks2 = rangesOf(call.text)
      for (const ask of asks2) {
        const at = excerpts.findIndex((x) => x.path === ask.path)
        if (at < 0) continue
        const more = await excerptAt(o.truth, o.commit, ask.path, {
          limit: Math.min(EXCERPT_LIMIT, Math.max(1, budget)),
          ranges: [{ from: ask.from ?? 1, to: ask.to ?? (ask.from ?? 1) + 200 }],
        })
        if (more === null) continue
        budget -= Math.max(0, more.text.length - excerpts[at]!.text.length)
        excerpts[at] = more
      }
    } catch (err) {
      note = `补读行段那一趟没成，截断的文件只有第一段：${(err as Error).message}`
    }
  }
  if (cut.length > 0) {
    const still = excerpts.filter((x) => x.truncated).map((x) => `${x.path}（共 ${x.lines} 行，只贴了 ${x.shown.map((r) => `${r.from}–${r.to}`).join(' · ')}）`)
    if (still.length > 0) {
      note = `${note === null ? '' : `${note}；`}有文件没读全：${still.join(' · ')}——正文里引用后面的内容时写明缺哪一段`
    }
  }
  const truncated: EvidenceRange[] = excerpts.map((x) => ({ path: x.path, lines: x.lines, chars: x.chars, shown: x.shown, truncated: x.truncated }))
  return { evidence: { mode: 'requested', requested, found: excerpts.map((x) => x.path), missing, ranges: truncated }, excerpts, note, usage, rangeUsage }
}

/** 一次生成。**成功与失败都是返回值**：失败时旧批次留在原处，`last.json` 记下原因。 */
export async function buildDocs(deps: BuildDeps): Promise<BuildOutcome> {
  const docsDir = docsRootOf(deps.root)
  const now = (): Date => (deps.now === undefined ? new Date() : deps.now())
  let commit: CommitId | null = null
  let plan: DocsPlan | null = null
  let theme: ThemeSpec | null = null
  /** 走到哪一步花掉了什么：**失败时也要带上已完成页的用量**（复审 R8）。 */
  const allUsage: (Usage | null)[] = []
  const usagePages: UsageTotal['pages'][number][] = []
  let factsForFail: TreeFacts | null = null

  const modelFacts = (p: DocsPlan | null): ModelFacts => modelFactsOf(deps.caller, p?.maxTokens)

  const fail = async (err: unknown): Promise<BuildFailure> => {
    const e = err instanceof DocsError ? err : new DocsError('build', (err as Error).message)
    const total = sumUsage(allUsage)
    const attempt = attemptOf({
      ok: false,
      at: now().toISOString(),
      commit: commit === null ? null : String(commit),
      fingerprint: null,
      pages: 0,
      theme: theme === null ? null : theme.id,
      model: deps.caller.model,
      materials: deps.materials,
      reason: e.message,
      at_stage: e.at,
      usage: total,
      ...(usagePages.length === 0 ? {} : { usagePages }),
    })
    try {
      await recordAttempt(deps.root, attempt)
    } catch {
      // 连"失败"都写不进去时，把原因留在返回的那一句里——不吞掉。
    }
    return {
      ok: false,
      at_stage: e.at,
      reason: e.message,
      commit: commit === null ? null : String(commit),
      docsDir,
      materials: deps.materials,
      usage: { ...total, pages: usagePages },
    }
  }

  try {
    // 零 · 收上次没走完的切换（只收没被指向的批次；当前那一批一个字节都不动）。
    await recoverPublish(deps.root)

    // 一 · 定义
    plan = parseDocs(deps.config)
    if (plan === null) {
      throw new DocsError(
        'config',
        '文档能力没有启用：工作区配置里没有 docs 键（架构 § 15.3.a）。要启用就写 docs.theme 与 docs.pages；' +
          '收口在 docs 键缺席时只做归并与验收',
      )
    }
    const themeId = deps.theme ?? plan.theme
    theme = themeOf(themeId)
    if (theme === null) {
      throw new DocsError('config', `没有这套视觉语言：${JSON.stringify(themeId)}（带进来的有 ${THEME_IDS.join(' · ')}）`)
    }

    // 二 · 事实
    const at = deps.at ?? 'refs/heads/main'
    try {
      commit = await deps.truth.resolve(at as RefName)
    } catch (err) {
      throw new DocsError('facts', `找不到提交 ${JSON.stringify(at)}：${(err as Error).message}`)
    }
    const facts = await treeFactsOf(deps.truth, commit, plan)
    factsForFail = facts
    if (facts.missing.length > 0) throw new DocsError('facts', missingText(facts.missing, String(commit)))

    const sources = new Map<string, string>()
    for (const p of plan.pages) sources.set(p.id, await sourceTextOf(deps.truth, commit, p.id, p.source))

    // 提示词链：**A 区在这里装一次**，取证两趟与写作那一趟都发这一份字节。
    const prompt = chainOf(facts)

    // 三 · 逐页取证 + 写作
    const prepared: Prepared[] = []
    const prev = deps.prev !== undefined ? deps.prev : await readManifest(deps.root).catch(() => null)
    for (const def of plan.pages) {
      if (deps.reuse !== undefined) {
        // **只重渲染**：正文与取证事实都是上一批的，这一趟一个模型调用都不发。
        const md = deps.reuse.markdown.get(def.id)
        if (md === undefined) throw new DocsError('render', `重渲染缺少这一页的正文：content/${def.id}.md`)
        const evidence = deps.reuse.evidence.get(def.id) ?? { mode: 'skipped' as const, requested: [], found: [], missing: [], ranges: [] }
        // **只搬“取证”那几条**（它们不属于渲染，重渲染不会重算）；渲染得出的 note（旧地址去向 ·
        // 不可达引用 · 形状）这一趟会自己重新生成，搬过来的话每重渲染一次就多一份重复。
        const kept = (deps.reuse.notes.get(def.id) ?? []).filter((n) => /取证|补读|没读全/.test(n))
        const notes = [...kept, ...checkContent(def, md)]
        const pass1 = renderMarkdown(md, { resolve: (raw) => ({ href: raw }), reserved: HOST_IDS })
        prepared.push({
          def,
          markdown: md,
          evidence,
          notes,
          usage: null,
          evidenceUsage: null,
          rangeUsage: null,
          pass1,
          pass2: pass1,
          rendered: { id: def.id, title: def.title, out: def.out, html: '', headings: pass1.headings, anchors: {}, notes: [] },
        })
        continue
      }
      const ev =
        deps.evidence === false
          ? {
              evidence: { mode: 'skipped' as const, requested: [], found: [], missing: [], ranges: [] },
              excerpts: [],
              note: null,
              usage: null,
              rangeUsage: null,
            }
          : await gatherEvidence({ def, plan, facts, source: sources.get(def.id)!, truth: deps.truth, commit, caller: deps.caller, prompt })
      const words = prompt.writing({
        page: def,
        plan,
        theme,
        source: sources.get(def.id)!,
        materials: deps.materials,
        excerpts: ev.excerpts,
        evidenceMissing: ev.evidence.missing,
      })
      const call = await deps.caller.call({
        system: words.shared,
        context: words.page,
        task: words.task,
        ...(plan.maxTokens === undefined ? {} : { maxTokens: plan.maxTokens }),
      })
      const contentNotes = checkContent(def, call.text)
      allUsage.push(call.usage)
      // **取证那几趟只数真发出去的调用**：`--no-evidence` 这一次一次都没发，不该算进读数。
      if (deps.evidence !== false) {
        allUsage.push(ev.usage)
        if (ev.rangeUsage !== null) allUsage.push(ev.rangeUsage)
      }
      usagePages.push({ id: def.id, usage: call.usage, evidenceUsage: ev.usage, rangeUsage: ev.rangeUsage })
      const pass1 = renderMarkdown(call.text, { resolve: (raw) => ({ href: raw }), reserved: HOST_IDS })
      prepared.push({
        def,
        markdown: call.text,
        evidence: ev.evidence,
        notes: [...contentNotes, ...(ev.note === null ? [] : [ev.note])],
        usage: call.usage,
        evidenceUsage: ev.usage,
        rangeUsage: ev.rangeUsage,
        pass1,
        pass2: pass1,
        rendered: {
          id: def.id,
          title: def.title,
          out: def.out,
          html: '',
          headings: pass1.headings,
          anchors: {},
          notes: [],
        },
      })
    }

    // 四 · 校验与呈现（需要全批的标题表：跨页引用要判锚点在不在）
    const fresh = new Map(prepared.map((p) => [p.def.id, p.pass1.headings]))
    const alias = aliasPlan(prev, fresh, deps.revive)
    const idsOf = (pageId: string): Set<string> => {
      const set = new Set((fresh.get(pageId) ?? []).map((h) => h.id))
      for (const [old] of Object.entries(alias.get(pageId)?.anchors ?? {})) set.add(old)
      return set
    }
    const byOut = new Map(plan.pages.map((p) => [p.out, p]))
    const bySource = new Map(plan.pages.map((p) => [p.source, p]))
    const assets = await planAssets({
      pages: prepared.map((p) => ({ def: p.def, markdown: p.markdown })),
      facts,
      truth: deps.truth,
      commit,
    })

    const resolverFor = (def: PageDef): ((raw: string, kind: 'link' | 'image') => { href: string; note?: string } | null) => {
      const ids = idsOf(def.id)
      return (raw, kind) => {
        if (kind === 'image') {
          const href = assets.hrefOf(def.id, raw)
          return href === null ? null : { href }
        }
        if (/^https?:\/\//i.test(raw) || /^mailto:/i.test(raw)) return { href: raw }
        if (raw.startsWith('#')) {
          const id = raw.slice(1)
          return ids.has(id) ? { href: raw } : null
        }
        const cut = raw.indexOf('#')
        const path = cut < 0 ? raw : raw.slice(0, cut)
        const hash = cut < 0 ? '' : raw.slice(cut + 1)
        const target = byOut.get(path)
        if (target !== undefined) {
          if (hash === '' || idsOf(target.id).has(hash)) return { href: raw }
          return { href: path, note: `跨页引用 ${raw} 的锚点不在目标页，已落成页链接` }
        }
        const asSource = bySource.get(repoPathOf(def.source, path) ?? path)
        if (asSource !== undefined) {
          // 来源那一页也要校锚点：指向不存在的节时落成页链接并记 note，不交给读者一条死深链。
          if (hash === '' || idsOf(asSource.id).has(hash)) return { href: asSource.out + (hash === '' ? '' : `#${hash}`) }
          return { href: asSource.out, note: `跨页引用 ${raw} 的锚点不在目标页，已落成页链接` }
        }
        return null
      }
    }

    for (const p of prepared) {
      p.pass2 = renderMarkdown(p.markdown, {
        resolve: resolverFor(p.def),
        aliases: alias.get(p.def.id)?.aliases ?? {},
        reserved: HOST_IDS,
        headingIds: p.pass1.headings.map((h) => h.id),
      })
      p.notes.push(...p.pass2.notes)
      // **旧地址的去向要说得出来**（交接单 § 2.1）：没有后继的那几条进清单，不静默丢掉。
      const dropped = alias.get(p.def.id)?.dropped ?? []
      if (dropped.length > 0) {
        const shown = dropped.slice(0, 8).join(' · ')
        p.notes.push(`旧深链接没有后继（这一版没有对应内容）：${shown}${dropped.length > 8 ? ` …共 ${dropped.length} 条（完整列表见 manifest.json 的 pages[].dropped）` : ''}`)
      }
    }

    // 五 · 清单 · 首页 · 保存
    const factsOfModel = modelFacts(plan)
    const fingerprint = fingerprintOf({ commit: String(commit), plan, sources: facts.sources, theme, model: factsOfModel })
    const siteInfo: SiteInfo = {
      project: plan.title ?? facts.name ?? '文档',
      version: facts.version,
      commit: String(commit),
      commitShort: facts.commitShort,
      fingerprint,
      files: facts.files,
      theme,
    }
    const index: SearchEntry[] = []
    for (const p of prepared) index.push(...searchEntriesOf(p.def, p.pass2.blocks))

    const files: BatchFile[] = []
    const manifestPages: Manifest['pages'] = []
    for (const p of prepared) {
      const anchors = alias.get(p.def.id)?.anchors ?? {}
      p.rendered = renderPage({
        site: siteInfo,
        plan,
        page: p.def,
        html: p.pass2.html,
        headings: p.pass2.headings,
        notes: p.notes,
        sourceSha: facts.sources.find((s) => s.id === p.def.id)?.sha ?? null,
        index,
        anchors,
      })
      files.push({ path: p.def.out, bytes: new TextEncoder().encode(p.rendered.html) })
      files.push({ path: `content/${p.def.id}.md`, bytes: new TextEncoder().encode(p.markdown) })
      manifestPages.push({
        id: p.def.id,
        title: p.def.title,
        out: p.def.out,
        source: p.def.source,
        sourceSha: facts.sources.find((s) => s.id === p.def.id)?.sha ?? null,
        content: `content/${p.def.id}.md`,
        evidence: p.evidence,
        cited: citedOf(p.markdown, facts),
        headings: p.pass2.headings,
        anchors,
        dropped: alias.get(p.def.id)?.dropped ?? [],
        notes: p.notes,
      })
    }
    files.push(
      {
        path: 'index.html',
        bytes: new TextEncoder().encode(
          renderIndexPage({
            site: siteInfo,
            plan,
            index,
            pages: plan.pages.map((page) => ({ page })),
          }),
        ),
      },
      ...assets.files,
    )

    const generatedAt = now().toISOString()
    const manifest: Manifest = {
      version: MANIFEST_VERSION,
      commit: String(commit),
      commitShort: facts.commitShort,
      projectVersion: facts.version,
      fingerprint,
      generatedAt,
      theme: theme.id,
      themeVersion: theme.version,
      renderer: RENDERER_VERSION,
      prompt: PROMPT_VERSION,
      model: deps.caller.model,
      modelFacts: factsOfModel,
      materials: deps.materials,
      pages: manifestPages,
      files: digestOf(files),
    }
    files.push({ path: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n') })
    await publishBatch(deps.root, files)

    const total = sumUsage(allUsage)
    const attempt = attemptOf({
      ok: true,
      at: generatedAt,
      commit: String(commit),
      fingerprint,
      pages: prepared.length,
      theme: theme.id,
      model: deps.caller.model,
      materials: deps.materials,
      usage: total,
      usagePages,
      reason: null,
      at_stage: null,
    })
    try {
      if (deps.record !== false) await recordAttempt(deps.root, attempt)
    } catch (err) {
      // 批次已经发布：这一条写不进去只影响"最近一次"那一栏，把话说在返回里。
      return {
        ok: true,
        commit: String(commit),
        commitShort: facts.commitShort,
        fingerprint,
        theme: theme.id,
        model: deps.caller.model,
        version: facts.version,
        docsDir,
        generatedAt,
        materials: deps.materials,
        usage: {
          ...total,
          pages: prepared.map((p) => ({ id: p.def.id, usage: p.usage, evidenceUsage: p.evidenceUsage, rangeUsage: p.rangeUsage })),
        },
        notes: [`最近一次生成的结果写不进去：${(err as Error).message}`],
        pages: prepared.map((p) => ({ id: p.def.id, title: p.def.title, out: p.def.out, headings: p.pass2.headings })),
      }
    }
    return {
      ok: true,
      commit: String(commit),
      commitShort: facts.commitShort,
      fingerprint,
      theme: theme.id,
      model: deps.caller.model,
      version: facts.version,
      docsDir,
      generatedAt,
      materials: deps.materials,
      usage: {
        ...total,
        pages: prepared.map((p) => ({ id: p.def.id, usage: p.usage, evidenceUsage: p.evidenceUsage, rangeUsage: p.rangeUsage })),
      },
      notes: prepared.flatMap((p) => p.notes),
      pages: prepared.map((p) => ({ id: p.def.id, title: p.def.title, out: p.def.out, headings: p.pass2.headings })),
    }
  } catch (err) {
    void factsForFail
    return fail(err)
  }
}

/** 从 CLI 那一层看得到的一行：这一批之后，文档住在哪儿（`Fugue 的产物位置`）。 */
export function docsHintOf(root: string): string {
  return `${docsRootOf(root)}/index.html（用浏览器打开；file:// 即可）`
}

/** 首页文件名（`docs status` 与 `docs build` 的出口指它）。 */
export const INDEX_FILE = 'index.html'

/** 一个 HTML 转义的小工具再导出：CLI 那一层拼人面时用它，不必再 import markdown。 */
export { escapeHtml }
