// 一次生成：**定义 + 来源 + 提交 C 的事实 → 逐页正文 → 渲染 → 校验 → 整批保存**。
//
// 这张图就是交接单 § 2.6 那一张，代码里的次序与它逐条对应：
//
//   1. 核定义（`config.ts`）——写错就停，指出该改的那一格
//   2. 取事实（`facts.ts`）——来源缺失就停，报出是哪一份、哪一条路径
//   3. 逐页取证（模型点名要读的文件）→ 逐页写作（模型给 markdown）
//   4. 宿主校验与呈现：markdown → HTML（`markdown.ts`），套公共交互与主题（`page.ts`）
//   5. 整批替换 + 清单与指纹（`publish.ts`）；最近一次结果单独记（`last.json`）
//
// **两趟调用，材料不同。** 第一趟只要一份"要读哪几份文件"的 JSON；第二趟带上那几份的原文写
// 正文。两趟都失败时按文档失败处理，旧批次一个字节不动（交接单 § 3.2 · § 3.5）。
//
// **生成不等于可信**（交接单 § 2.5）：宿主机械核对的是形状、引用、锚点与整批一致；内容取舍
// 与交互适用性仍要人按读者任务复核。这一份的 `notes` 把"兑不掉的地方"逐条留给复核。
//
// **不回流**：这一份只读定义与提交，读一次旧清单只为算"旧深链接的去向"；旧 HTML 与旧正文
// 从不进写作输入（交接单 § 1.4 末段）。
import { posix } from 'node:path'
import type { ConfigDoc } from '../config.ts'
import type { Usage } from '../model/contract.ts'
import type { Truth } from '../truth/contract.ts'
import type { CommitId, RefName } from '../terms.ts'
import { parseDocs } from './config.ts'
import type {
  DocsPlan,
  LastAttempt,
  Manifest,
  Materials,
  PageContent,
  PageDef,
  RenderedPage,
  TreeFacts,
} from './contract.ts'
import { DocsError, MANIFEST_VERSION, RENDERER_VERSION, docsRootOf } from './contract.ts'
import { excerptAt, sourceTextOf, treeFactsOf } from './facts.ts'
import type { Excerpt } from './facts.ts'
import { fingerprintOf } from './fingerprint.ts'
import type { DocCaller } from './contract.ts'
import { escapeHtml, renderMarkdown } from './markdown.ts'
import type { MdHeading, MdResult } from './markdown.ts'
import { renderIndexPage, renderPage } from './page.ts'
import type { SiteInfo } from './page.ts'
import { EVIDENCE_MAX, EXCERPT_LIMIT, CONTENT_TASK, contextOf, evidenceContextOf, evidenceSystemOf, systemOf } from './prompt.ts'
import { CONTENT_MIN_CHARS, EVIDENCE_TASK } from './prompt.ts'
import { digestOf, publishBatch, readManifest, writeLast } from './publish.ts'
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
  readonly now?: () => Date
}

/** 这一趟的用量合计：逐页 + 合计。**真调用留下的读数**（交接单 § 2.5 的判据）。 */
export interface UsageTotal {
  readonly calls: number
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly pages: readonly {
    readonly id: string
    readonly usage: Usage | null
    readonly evidenceUsage: Usage | null
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
  /** 第一遍渲染：只取标题表（引用兑不兑得掉还不知道）。 */
  readonly pass1: MdResult
  /** 第二遍：严格解析之后的正文与标题。 */
  pass2: MdResult
  rendered: RenderedPage
}

/** 一串用量求和：**缺的那几项不当 0**（`null` 是"没量到"，与 0 是两件事）。 */
function sumUsage(usages: readonly (Usage | null)[]): { calls: number; inputTokens: number | null; outputTokens: number | null } {
  let input: number | null = null
  let output: number | null = null
  for (const u of usages) {
    if (u === null) continue
    if (u.inputTokens !== null) input = (input ?? 0) + u.inputTokens
    if (u.outputTokens !== null) output = (output ?? 0) + u.outputTokens
  }
  return { calls: usages.length, inputTokens: input, outputTokens: output }
}

/** 缺失来源那一句话：**逐份列出是哪一份、哪一条路径**（交接单 § 2.3 的判据）。 */
function missingText(missing: readonly { id: string; source: string }[], commit: string): string {
  const lines = missing.map((m) => `  · 文档 ${m.id}：source 指向 ${m.source}`)
  return `来源在提交 ${commit.slice(0, 12)} 里缺失（${missing.length} 份）：\n${lines.join('\n')}\n  该改的是 ${missing.length === 1 ? '那一份定义' : '那几份定义'}的 source，或者把来源带进这个提交`
}

/** 取证那一趟：模型点名要读的路径 → 真读到的那几份原文。 */
async function gatherEvidence(o: {
  readonly def: PageDef
  readonly plan: DocsPlan
  readonly facts: TreeFacts
  readonly source: string
  readonly truth: Truth
  readonly commit: CommitId
  readonly caller: DocCaller
}): Promise<{ evidence: PageContent['evidence']; excerpts: Excerpt[]; note: string | null; usage: Usage | null }> {
  const empty: PageContent['evidence'] = { mode: 'skipped', requested: [], found: [], missing: [] }
  let text: string
  let usage: Usage | null = null
  try {
    const call = await o.caller.call({
      system: evidenceSystemOf(),
      context: evidenceContextOf({ page: o.def, plan: o.plan, facts: o.facts, source: o.source }),
      task: EVIDENCE_TASK,
      maxTokens: 4096,
      thinking: 'low',
    })
    text = call.text
    usage = call.usage
  } catch (err) {
    // **退到"只有来源与索引"那一档**：写得少，不是跑不起来（交接单 § 2.5 的地板）。
    return { evidence: empty, excerpts: [], note: `取证这一趟没成，这一页按来源与索引写：${(err as Error).message}`, usage: null }
  }
  const requested = pathsOf(text).slice(0, EVIDENCE_MAX)
  const known = new Set(o.facts.paths)
  const found: string[] = []
  const missing: string[] = []
  const excerpts: Excerpt[] = []
  for (const p of requested) {
    if (!known.has(p)) {
      missing.push(p)
      continue
    }
    const x = await excerptAt(o.truth, o.commit, p, EXCERPT_LIMIT)
    if (x === null) missing.push(p)
    else {
      excerpts.push(x)
      found.push(p)
    }
  }
  if (requested.length === 0) {
    return { evidence: { mode: 'skipped', requested: [], found: [], missing: [] }, excerpts: [], note: null, usage }
  }
  return { evidence: { mode: 'requested', requested, found, missing }, excerpts, note: null, usage }
}

/** 模型那一趟的 JSON：取第一段 `{…}`，只认 `paths` 那一栏。**解析不了就是空数组**。 */
function pathsOf(text: string): string[] {
  const m = /\{[\s\S]*\}/.exec(text)
  if (m === null) return []
  try {
    const v = JSON.parse(m[0]) as { paths?: unknown }
    if (!Array.isArray(v.paths)) return []
    return v.paths.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
  } catch {
    return []
  }
}

/** 正文的形状核对：**宿主只判可机械核对的那几条**（内容取舍留给复核）。返回兑不掉的 note。 */
function checkContent(def: PageDef, md: string): string[] {
  const notes: string[] = []
  const text = md.trim()
  if (text === '') throw new DocsError('render', `第 ${def.id} 页（${def.title}）的正文是空的`)
  if (text.length < CONTENT_MIN_CHARS) {
    throw new DocsError('render', `第 ${def.id} 页（${def.title}）的正文只有 ${text.length} 个字符，短于 ${CONTENT_MIN_CHARS}：这一页没写出来`)
  }
  const hasH1 = /^\s*#\s+/m.test(text)
  const hasH2 = /^\s*#{2,}\s+/m.test(text)
  // **只写 H1 时先说清这一条**：它同时满足“没有 ##”，但真正该改的是“从 ## 起”。
  if (hasH1 && !hasH2) {
    throw new DocsError('render', `第 ${def.id} 页（${def.title}）只写了 H1：页标题由宿主加，正文要从 ## 起`)
  }
  if (!/^\s*#{2,6}\s+/m.test(text)) {
    throw new DocsError('render', `第 ${def.id} 页（${def.title}）的正文里一个章节标题都没有（## 起）：读者无法按节读`)
  }
  // **H1 与 ## 同时出现时不拒**（那一段仍有完整可读内容），但要如实记下来：它会被宿主按 H2 呈现。
  if (hasH1) notes.push('正文里写了 H1（页标题由宿主按定义加）：这一行按 H2 呈现')
  return notes
}

/** 两个标题的相似度（汉字按二字组，英文按词）：旧深链接的去向靠它判"同一主题"。 */
function similarity(a: string, b: string): number {
  const norm = (s: string): string[] => {
    const clean = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const words = clean.split(' ').filter(Boolean)
    const grams: string[] = []
    for (const w of words) {
      if (w.length <= 2) grams.push(w)
      else for (let i = 0; i < w.length - 1; i++) grams.push(w.slice(i, i + 2))
    }
    return grams
  }
  const A = norm(a)
  const B = norm(b)
  if (A.length === 0 || B.length === 0) return 0
  const count = new Map<string, number>()
  for (const g of A) count.set(g, (count.get(g) ?? 0) + 1)
  let hit = 0
  for (const g of B) {
    const n = count.get(g) ?? 0
    if (n > 0) {
      hit += 1
      count.set(g, n - 1)
    }
  }
  return (2 * hit) / (A.length + B.length)
}

/** 旧标题 → 新标题：**同一主题换了标题**时，旧深链接仍到达内容（交接单 § 2.1 末段）。 */
function aliasPlan(
  prev: Manifest | null,
  fresh: Map<string, readonly MdHeading[]>,
): Map<string, { aliases: Record<string, string[]>; anchors: Record<string, string>; dropped: string[] }> {
  const out = new Map<string, { aliases: Record<string, string[]>; anchors: Record<string, string>; dropped: string[] }>()
  for (const [pageId, headings] of fresh) {
    const ids = new Set(headings.map((h) => h.id))
    const anchors: Record<string, string> = {}
    const aliases: Record<string, string[]> = {}
    const add = (old: string, target: string): void => {
      if (old === target || ids.has(old)) return
      anchors[old] = target
      const list = aliases[target] ?? []
      if (!list.includes(old)) list.push(old)
      aliases[target] = list
    }
    const prior = prev?.pages.find((p) => p.id === pageId)
    if (prior !== undefined) {
      // 一 · 上一批的对照链不断：目标还在就照旧；目标没了但旧 id 本身成了真标题，就落回它。
      for (const [old, target] of Object.entries(prior.anchors ?? {})) {
        if (ids.has(target)) add(old, target)
        else if (ids.has(old)) continue
      }
      // 二 · 上一批有、这一批没有的标题：按文字相似度找最像的那一节。
      for (const h of prior.headings) {
        if (ids.has(h.id) || anchors[h.id] !== undefined) continue
        let best: MdHeading | null = null
        let bestScore = 0
        let tie = false
        for (const now of headings) {
          if (anchors[now.id] !== undefined && !ids.has(now.id)) continue
          const s = similarity(h.text, now.text)
          if (s > bestScore + 1e-9) {
            bestScore = s
            best = now
            tie = false
          } else if (Math.abs(s - bestScore) < 1e-9 && best !== null) tie = true
        }
        if (best !== null && bestScore >= 0.5 && !tie) add(h.id, best.id)
      }
    }
    // **旧 id 包括了上一批自己就是别名的那几条**（一代代改标题的链）：它们也要么有后继、
    // 要么被报出来。只看 `prior.headings` 会漏掉“上一批就已经是个旧名字”的那一层。
    const priorIds = new Set<string>()
    if (prior !== undefined) {
      for (const h of prior.headings) priorIds.add(h.id)
      for (const old of Object.keys(prior.anchors ?? {})) priorIds.add(old)
    }
    const dropped = [...priorIds].filter((old) => !ids.has(old) && anchors[old] === undefined)
    out.set(pageId, { aliases, anchors, dropped })
  }
  return out
}

/** 图片的落点：从提交里复制到 `_assets/`，名字按内容哈希（同一张图只存一份）。 */
interface AssetPlan {
  readonly files: BatchFile[]
  readonly hrefOf: (pageId: string, raw: string) => string | null
}

async function planAssets(o: {
  readonly pages: readonly { def: PageDef; markdown: string }[]
  readonly facts: TreeFacts
  readonly truth: Truth
  readonly commit: CommitId
}): Promise<AssetPlan> {
  const enc = new TextEncoder()
  const byPath = new Map<string, { href: string; bytes: Uint8Array }>()
  const byPage = new Map<string, Map<string, string>>()
  const known = new Set(o.facts.paths)
  for (const { def, markdown } of o.pages) {
    const map = new Map<string, string>()
    const re = /!\[([^\]]*)\]\(([^)\s]+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(markdown)) !== null) {
      const raw = m[2]!
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue
      const path = repoPathOf(def.source, raw)
      if (path === null || !known.has(path)) continue
      const hit = byPath.get(path)
      if (hit !== undefined) {
        map.set(raw, hit.href)
        continue
      }
      const bytes = await o.truth.readAt(o.commit, path as never)
      if (bytes === null) continue
      const href = `_assets/${await assetNameOf(bytes, path)}`
      byPath.set(path, { href, bytes })
      map.set(raw, href)
    }
    byPage.set(def.id, map)
  }
  return {
    files: [...byPath.values()].map((v) => ({ path: v.href, bytes: v.bytes })),
    hrefOf: (pageId, raw) => byPage.get(pageId)?.get(raw) ?? null,
  }
}

/** `_assets/` 里那份文件叫什么：内容哈希前 8 位 + 原名（同名不同内容也撞不上）。 */
async function assetNameOf(bytes: Uint8Array, path: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const base = posix.basename(path).replace(/[^\w.-]/g, '_')
  return `${sha}-${base}`
}

/** 来源文件里的相对路径 → 提交里的仓库相对路径（越界与空路径都是 `null`）。 */
function repoPathOf(source: string, raw: string): string | null {
  const clean = raw.split('#')[0]!.split('?')[0]!
  if (clean === '' || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null
  const p = clean.startsWith('/') ? clean.slice(1) : posix.normalize(posix.join(posix.dirname(source), clean))
  if (p.startsWith('..') || p === '' || p === '.') return null
  return p
}

/** 正文里引用的路径（清单里的"取证依据"）：行内代码里出现的、提交里真有的那些。 */
function citedOf(markdown: string, facts: TreeFacts): string[] {
  const known = new Set(facts.paths)
  const found = new Set<string>()
  const re = /`([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    const p = m[1]!
    if (known.has(p)) found.add(p)
  }
  return [...found].sort()
}

/** 一次生成。**成功与失败都是返回值**：失败时旧批次留在原处，`last.json` 记下原因。 */
export async function buildDocs(deps: BuildDeps): Promise<BuildOutcome> {
  const docsDir = docsRootOf(deps.root)
  const now = (): Date => (deps.now === undefined ? new Date() : deps.now())
  let commit: CommitId | null = null
  let plan: DocsPlan | null = null
  let theme: ThemeSpec | null = null

  const fail = async (err: unknown): Promise<BuildFailure> => {
    const e = err instanceof DocsError ? err : new DocsError('build', (err as Error).message)
    const attempt: LastAttempt = {
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
    }
    try {
      await writeLast(deps.root, attempt)
    } catch {
      // 连"失败"都写不进去时，把原因留在返回的那一句里——不吞掉。
    }
    return { ok: false, at_stage: e.at, reason: e.message, commit: commit === null ? null : String(commit), docsDir, materials: deps.materials }
  }

  try {
    // 零 · 收上次没走完的切换（两次改名之间被杀的那一档）。
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
    if (facts.missing.length > 0) throw new DocsError('facts', missingText(facts.missing, String(commit)))

    const sources = new Map<string, string>()
    for (const p of plan.pages) sources.set(p.id, await sourceTextOf(deps.truth, commit, p.id, p.source))

    // 三 · 逐页取证 + 写作
    const prepared: Prepared[] = []
    /** 两趟（取证 + 写作）的用量都收：读数要说得清"这一次一共花了几次调用"。 */
    const allUsage: (Usage | null)[] = []
    const prev = await readManifest(deps.root).catch(() => null)
    for (const def of plan.pages) {
      const ev =
        deps.evidence === false
          ? { evidence: { mode: 'skipped' as const, requested: [], found: [], missing: [] }, excerpts: [], note: null, usage: null }
          : await gatherEvidence({ def, plan, facts, source: sources.get(def.id)!, truth: deps.truth, commit, caller: deps.caller })
      const call = await deps.caller.call({
        system: systemOf(theme),
        context: contextOf({
          page: def,
          plan,
          facts,
          source: sources.get(def.id)!,
          materials: deps.materials,
          excerpts: ev.excerpts,
          evidenceMissing: ev.evidence.missing,
        }),
        task: CONTENT_TASK,
        ...(plan.maxTokens === undefined ? {} : { maxTokens: plan.maxTokens }),
      })
      const contentNotes = checkContent(def, call.text)
      allUsage.push(call.usage)
      // **取证那一趟只数真发出去的调用**：`--no-evidence` 这一次一次都没发，不该算进读数。
      if (deps.evidence !== false) allUsage.push(ev.usage)
      const pass1 = renderMarkdown(call.text, { resolve: (raw) => ({ href: raw }) })
      prepared.push({
        def,
        markdown: call.text,
        evidence: ev.evidence,
        notes: [...contentNotes, ...(ev.note === null ? [] : [ev.note])],
        usage: call.usage,
        evidenceUsage: ev.usage,
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
    const alias = aliasPlan(prev, fresh)
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
      })
      p.notes.push(...p.pass2.notes)
      // **旧地址的去向要说得出来**（交接单 § 2.1）：没有后继的那几条进清单的 note，
      // 不静默丢掉。页面里落不成锚点，去向就是“这一版没有对应内容”。
      const dropped = alias.get(p.def.id)?.dropped ?? []
      if (dropped.length > 0) {
        const shown = dropped.slice(0, 6).join(' · ')
        p.notes.push(`旧深链接没有后继（这一版没有对应内容）：${shown}${dropped.length > 6 ? ` …共 ${dropped.length} 条` : ''}`)
      }
    }

    // 五 · 清单 · 首页 · 保存
    const fingerprint = fingerprintOf({ commit: String(commit), plan, sources: facts.sources, theme, model: deps.caller.model })
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
    for (const p of prepared) index.push(...searchEntriesOf(p.def, p.markdown, p.pass2.headings))

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
      model: deps.caller.model,
      materials: deps.materials,
      pages: manifestPages,
      files: digestOf(files),
    }
    files.push({ path: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n') })
    await publishBatch(deps.root, files)

    const total = sumUsage(allUsage)
    const attempt: LastAttempt = {
      ok: true,
      at: generatedAt,
      commit: String(commit),
      fingerprint,
      pages: prepared.length,
      theme: theme.id,
      model: deps.caller.model,
      materials: deps.materials,
      usage: { calls: total.calls, inputTokens: total.inputTokens, outputTokens: total.outputTokens },
      reason: null,
      at_stage: null,
    }
    try {
      await writeLast(deps.root, attempt)
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
          calls: total.calls,
          inputTokens: total.inputTokens,
          outputTokens: total.outputTokens,
          pages: prepared.map((p) => ({ id: p.def.id, usage: p.usage, evidenceUsage: p.evidenceUsage })),
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
        calls: total.calls,
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        pages: prepared.map((p) => ({ id: p.def.id, usage: p.usage, evidenceUsage: p.evidenceUsage })),
      },
      notes: prepared.flatMap((p) => p.notes),
      pages: prepared.map((p) => ({ id: p.def.id, title: p.def.title, out: p.def.out, headings: p.pass2.headings })),
    }
  } catch (err) {
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
