// markdown 子集 → HTML：**内容那一半的呈现**（交接单 § 2.1 · § 2.6 的那张图）。
//
// 为什么是一份小的、写死的子集，而不是一个完整 markdown 实现：**产物要离线、零依赖、可复现**
// （交接单 § 1.4 · § 5.4）。子集里每一样都由公共层兑现——模型写了子集之外的语法，它会被当成
// 字面文本保留下来，并记一条 `notes`（"无法兑现的表达如实说明并保留完整可读内容"），
// 而不是让页面悄悄少一块。
//
// 子集（与 `prompt.ts` 的写作合同逐条对应）：
//
//   标题 ## … ###### · 可带 {#stable-id}     段落 · 无序/有序列表（一层嵌套）
//   引用 > · 分隔线 --- · 表格 | … |        代码围栏 ``` lang
//   行内：`代码` · **粗** · *斜体* · [文字](地址) · ![说明](图片)
//   块：::: note|tip|warn|danger 标题 / details / tabs（内含 tab）/ steps / figure
//
// **所有正文一律转义**：模型写不出可执行的 HTML（它不能通过生成内容自授能力，交接单 § 2.1 末段）。
//
// **标题 ID 是稳定地址的一半**：`slugOf` 由标题文字推出来，同一主题重生成时不变；标题改了而
// 主题没变时，旧地址由 `aliases`（上一批清单里的 anchor 对照）落成 `<span id="旧">`。
import { MAX_TABS } from './style.ts'

/** 正文里的一个标题。 */
export interface MdHeading {
  readonly id: string
  readonly text: string
  readonly level: number
}

/** 一次引用（跨页校验与清单要用）。 */
export interface MdLink {
  readonly kind: 'page' | 'anchor' | 'external' | 'dropped'
  readonly href: string
  readonly text: string
}

export interface MdResult {
  readonly html: string
  readonly headings: readonly MdHeading[]
  readonly links: readonly MdLink[]
  /** 兑不掉、如实记下的地方（不可达的引用 · 未识别的块 · 截断的容器）。 */
  readonly notes: readonly string[]
}

/** 引用与图片怎么落到产物里。`null` = 兑不掉（保留文字，记一条 note）。 */
export type Resolver = (raw: string, kind: 'link' | 'image') => { readonly href: string; readonly note?: string } | null

export interface RenderOptions {
  readonly resolve?: Resolver
  /** 新标题 ID → 旧 ID（旧深链接的去向）。 */
  readonly aliases?: Readonly<Record<string, readonly string[]>>
  /** 标题从几级起算（正文页从 2：H1 由宿主按定义加）。 */
  readonly baseLevel?: number
  /** 一页里标题 ID 的起点（同一页内的去重表由调用方跨段共享时用）。 */
  readonly used?: Map<string, number>
}

/** 标题文字 → 稳定 ID。中文按字保留，空白与 `_` 折成连字符，其余标点丢掉。 */
export function slugOf(text: string): string {
  const plain = text
    .replace(/<[^>]+>/g, '')
    .replace(/\{#[^}]*\}/g, '')
    .trim()
    .toLowerCase()
  let out = ''
  for (const ch of plain) {
    if (/[\p{L}\p{N}]/u.test(ch)) out += ch
    else if (ch === ' ' || ch === '-' || ch === '_' || ch === '.') out += '-'
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '') || 'section'
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** 转义（**唯一一处**）：正文里的尖括号一律不成为标签。 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESC[c] ?? c)
}

interface Ctx {
  headings: MdHeading[]
  links: MdLink[]
  notes: string[]
  used: Map<string, number>
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === ''
}

function indentOf(line: string): number {
  const m = /^(\s*)/.exec(line)
  return m?.[1]?.length ?? 0
}

/** `::: kind 参数` 那一行。`null` = 这一行不是块的开头。 */
function containerOpen(line: string): { kind: string; arg: string } | null {
  const m = /^:::\s*([a-z][a-z0-9-]*)(?:\s+(.*))?$/.exec(line.trim())
  if (m === null) return null
  return { kind: m[1]!, arg: (m[2] ?? '').trim() }
}

function isClose(line: string): boolean {
  return line.trim() === ':::'
}

/**
 * 找一个块的结尾：按 `:::` 的深度配对。
 *
 * 没配对上就把剩下的都当成块内（`closed: false`）——丢内容比多一层框更坏：读者至少还能读到。
 */
function takeContainer(lines: readonly string[], at: number): { inner: string[]; next: number; closed: boolean } {
  let depth = 1
  let j = at + 1
  // **围栏里的 `:::` 是内容，不是块的边界**（代码块里举一个块的写法，是最常见的说明方式）。
  let inFence = false
  for (; j < lines.length; j++) {
    const line = lines[j]!
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (containerOpen(line) !== null) depth += 1
    else if (isClose(line)) {
      depth -= 1
      if (depth === 0) return { inner: lines.slice(at + 1, j), next: j + 1, closed: true }
    }
  }
  // **没写收尾时不吞到页末**：退到"下一个二级标题处收住"。
  //
  // 为什么：`details` 会藏内容、`tabs` 会一次只显示一块。把后面整页吞进一个没关的块里，
  // 读者看到的是"这一页怎么没了"——而模型漏写一个 `:::` 是常事（实测：一次 govuk 生成里
  // 三页都漏了；吞进去的那几节落在标签面板里，整段不可见）。收在下一个 `##` 之前，代价是
  // 那一段少一层框，换来的是后面每一节都还在。**只在"找不到收尾"这条退化路上生效**——
  // 正常闭合的块里放 `##` 不受影响。
  let end = lines.length
  inFence = false
  for (let k = at + 1; k < lines.length; k++) {
    const line = lines[k]!
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence && /^##\s/.test(line)) {
      end = k
      break
    }
  }
  return { inner: lines.slice(at + 1, end), next: end, closed: false }
}

/** 行内那几样。**先切链接与图片，再在剩下的文字段里做强调**——否则 `*` 会伸进 href 里。 */
function inline(raw: string, ctx: Ctx, opts: RenderOptions): string {
  const out: string[] = []
  const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    out.push(emphasis(raw.slice(last, m.index)))
    if (m[1] !== undefined) {
      const alt = m[1]
      const src = m[2]!
      const hit = opts.resolve?.(src, 'image') ?? null
      if (hit === null) {
        // 图片兑不掉（外链 · 提交里没有）：**能外链的印成链接**，读者仍知道图说的是什么。
        //
        // **不算白名单的地址就只留文字**：这一段是正文里唯一一处把源串直接放进 `href` 的地方，
        // `javascript:` 与 `data:text/html` 点一下就执行。链接那一路的白名单在 `build.ts`，
        // 这一处自己也要有——兑不掉的图不值得换一个可执行地址。
        const text = alt === '' ? src : alt
        if (/^(https?:|mailto:)/i.test(src)) {
          out.push(`<a href="${escapeHtml(src)}" rel="noopener noreferrer">${escapeHtml(text)}</a>`)
          ctx.notes.push(`图片不在提交里，已印成链接：${src}`)
        } else {
          out.push(emphasis(text))
          ctx.notes.push(`图片地址既不在提交里、也不是 http(s)/mailto，已印成纯文字：${src}`)
        }
        ctx.links.push({ kind: 'dropped', href: src, text: alt })
      } else {
        if (hit.note !== undefined) ctx.notes.push(hit.note)
        out.push(`<img src="${escapeHtml(hit.href)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`)
      }
    } else {
      const text = m[4]!
      const href = m[5]!
      const hit = opts.resolve?.(href, 'link') ?? null
      if (hit === null) {
        out.push(emphasis(text))
        ctx.notes.push(`引用兑不掉，正文保留文字：${href}`)
        ctx.links.push({ kind: 'dropped', href, text })
      } else {
        if (hit.note !== undefined) ctx.notes.push(hit.note)
        const ext = /^https?:\/\//.test(href)
        out.push(
          `<a href="${escapeHtml(hit.href)}"${ext ? ' rel="noopener noreferrer"' : ''}>${emphasis(text)}</a>`,
        )
        ctx.links.push({ kind: ext ? 'external' : href.startsWith('#') ? 'anchor' : 'page', href: hit.href, text })
      }
    }
    last = m.index + m[0].length
  }
  out.push(emphasis(raw.slice(last)))
  return out.join('')
}

/** 转义过的反引号在这一趟里的占位符（`\`` 不参与配对）。`\u0001` 不会出现在正文里。 */
const ESC_TICK = '\u0001'

/** 转义之后再做行内强调：代码 → 粗 → 斜体。顺序是承重的（粗体里的星号不再当斜体）。 */
function emphasis(text: string): string {
  let s = escapeHtml(text).replace(/\\`/g, ESC_TICK)
  // 代码段里的转义反引号就是字面反引号（模型写 `编号 \`T1\`–\`T19\`` 时的意思）。
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => `<code>${code.trim().replaceAll(ESC_TICK, '`')}</code>`)
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  // 落单的转义反引号：印成一个“反引号字符”的代码段——可见文字里不留裸反引号。
  s = s.replaceAll(ESC_TICK, '<code>`</code>')
  return s
}

/** 标题那一行：`## 文字 {#id}`。 */
function headingOf(line: string, ctx: Ctx, opts: RenderOptions): { level: number; text: string; want: string | null } {
  const m = /^(#{1,6})\s+(.*)$/.exec(line.trim())
  const hashes = m?.[1]?.length ?? 2
  const base = opts.baseLevel ?? 2
  const level = Math.min(6, Math.max(base, hashes))
  let text = (m?.[2] ?? '').trim()
  let want: string | null = null
  const explicit = /^(.*?)\s*\{#([^}]+)\}\s*$/.exec(text)
  if (explicit !== null) {
    text = explicit[1]!.trim()
    const id = explicit[2]!.trim()
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) want = id
    else ctx.notes.push(`标题上的稳定 ID 不合法，已按文字生成：{${id}}`)
  }
  return { level, text, want }
}

function uniqueId(want: string, ctx: Ctx): string {
  const n = ctx.used.get(want) ?? 0
  ctx.used.set(want, n + 1)
  return n === 0 ? want : `${want}-${n + 1}`
}

function renderHeading(line: string, ctx: Ctx, opts: RenderOptions): string {
  const { level, text, want } = headingOf(line, ctx, opts)
  const id = uniqueId(want ?? slugOf(text), ctx)
  ctx.headings.push({ id, text, level })
  const anchor = `<a class="anchor" href="#${escapeHtml(id)}" aria-label="这一节的链接">#</a>`
  const alias = (opts.aliases?.[id] ?? [])
    .map((old) => `<span class="anchor-alias" id="${escapeHtml(old)}"></span>`)
    .join('')
  return `<h${level} id="${escapeHtml(id)}">${inline(text, ctx, opts)}${anchor}${alias}</h${level}>`
}

/** 表格：表头 + `| --- |` 分隔行。 */
function tableAt(lines: readonly string[], at: number, ctx: Ctx, opts: RenderOptions): { html: string; next: number } | null {
  const head = lines[at]!
  // 判据是两行：表头里有 |，紧跟着的那一行是分隔行。少一样就不是表格（当段落读）。
  if (!head.includes('|')) return null
  if (!/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[at + 1] ?? '')) return null
  // **`\|` 是表格里的一个竖线，不是列边界**（GFM 的写法；模型在单元格里写 `[all\|fast\|real]`
  // 是常事）。按裸 `|` 切会把一行切成比表头多几格，多出来的格原先直接不渲染——正文静默丢一截。
  const cellsOf = (line: string): string[] => {
    let s = line.trim()
    if (s.startsWith('|')) s = s.slice(1)
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
    const cells: string[] = []
    let cur = ''
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!
      if (ch === '\\' && s[i + 1] === '|') {
        cur += '\\|'
        i += 1
        continue
      }
      if (ch === '|') {
        cells.push(cur)
        cur = ''
        continue
      }
      cur += ch
    }
    cells.push(cur)
    return cells.map((c) => c.trim().replace(/\\\|/g, '|'))
  }
  const headers = cellsOf(head)
  const rows: string[][] = []
  let j = at + 2
  for (; j < lines.length; j++) {
    const line = lines[j]!
    if (isBlank(line) || !line.includes('|')) break
    rows.push(cellsOf(line))
  }
  const th = headers.map((h) => `<th scope="col">${inline(h, ctx, opts)}</th>`).join('')
  // 行比表头多格时不丢字：前 n-1 格照放，多出来的并进末格，并记一条 note。
  const rowOf = (r: string[]): string => {
    if (r.length <= headers.length) return headers.map((_h, i) => `<td>${inline(r[i] ?? '', ctx, opts)}</td>`).join('')
    ctx.notes.push(`表格有一行比表头多 ${r.length - headers.length} 格，多出来的文字并进了最后一格`)
    const head = r.slice(0, Math.max(0, headers.length - 1))
    const tail = r.slice(Math.max(0, headers.length - 1))
    return [...head, tail.join(' | ')].map((c) => `<td>${inline(c, ctx, opts)}</td>`).join('')
  }
  const body = rows.map((r) => `<tr>${rowOf(r)}</tr>`).join('\n')
  return {
    html: `<div class="table-wrap"><table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table></div>`,
    next: j,
  }
}

/**
 * 一段围栏：`at` 指向开围栏那一行，返回 HTML 与下一行。
 *
 * **顶层的块与列表项里的块共用这一个**：围栏的收尾判据、语言类名与“没写收尾”的 note
 * 只有一处，两种位置不会读出两种结果。
 */
function fenceAt(lines: readonly string[], at: number, ctx: Ctx): { html: string; next: number } {
  const fence = /^\s*```\s*([\w-]*)\s*$/.exec(lines[at]!)
  const lang = fence?.[1] ?? ''
  // **按围栏自己的缩进去掉一层**：列表项里的代码块缩进属于容器，不属于命令原文。
  const pad = indentOf(lines[at]!)
  const body: string[] = []
  let j = at + 1
  for (; j < lines.length; j++) {
    if (/^\s*```\s*$/.test(lines[j]!)) break
    const line = lines[j]!
    let cut = 0
    while (cut < pad && line[cut] === ' ') cut += 1
    body.push(line.slice(cut))
  }
  if (j >= lines.length) ctx.notes.push('代码围栏没有收尾：后面一直读到页末')
  const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`
  return { html: `<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`, next: j + 1 }
}

/** 列表：一层缩进嵌套；`steps` 里换一种包法（每项一个 `.step`）。 */
function listAt(
  lines: readonly string[],
  at: number,
  ctx: Ctx,
  opts: RenderOptions,
  asSteps = false,
): { html: string; next: number } {
  const indent = indentOf(lines[at]!)
  const ordered = /^\s*\d+\.\s/.test(lines[at]!)
  // 一项里可能混着文字与块（代码围栏）：文字攒一段一起做行内，块按块拼回原位。
  const items: { parts: { html: boolean; s: string }[]; nested: string[] }[] = []
  let j = at
  while (j < lines.length) {
    const line = lines[j]!
    if (isBlank(line)) break
    const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line)
    if (m === null) {
      // **围栏是块，不是续行**：列表项里的代码块按块渲染。
      // 原先当续行读，围栏标记会漏进正文（实测：`\`\`\`sh` 与反引号一起出现在句子里）。
      if (items.length > 0 && indentOf(line) > indent && /^\s*```\s*[\w-]*\s*$/.test(line)) {
        const f = fenceAt(lines, j, ctx)
        items[items.length - 1]!.parts.push({ html: true, s: f.html })
        j = f.next
        continue
      }
      // 续行：算上一条的一部分（列表项里的换行不是新段落）
      if (items.length > 0 && indentOf(line) >= indent) {
        items[items.length - 1]!.parts.push({ html: false, s: line.trim() })
        j += 1
        continue
      }
      break
    }
    const ind = m[1]!.length
    if (ind < indent) break
    if (ind > indent) {
      const sub = listAt(lines, j, ctx, opts, asSteps)
      items[items.length - 1]?.nested.push(sub.html)
      j = sub.next
      continue
    }
    if (items.length > 0 && /^\s*\d+\.\s/.test(line) !== ordered) break
    items.push({ parts: [{ html: false, s: m[3]! }], nested: [] })
    j += 1
  }
  const lis = items
    .map((it) => {
      const pieces: string[] = []
      let text = ''
      for (const part of it.parts) {
        if (part.html) {
          if (text !== '') {
            pieces.push(inline(text, ctx, opts))
            text = ''
          }
          pieces.push(part.s)
        } else {
          text = text === '' ? part.s : `${text} ${part.s}`
        }
      }
      if (text !== '') pieces.push(inline(text, ctx, opts))
      const body = pieces.join('') + it.nested.join('')
      return asSteps ? `<li class="step">${body}</li>` : `<li>${body}</li>`
    })
    .join('')
  const tag = ordered ? 'ol' : 'ul'
  return { html: `<${tag}>${lis}</${tag}>`, next: j }
}

/**
 * `tabs` 里的一段：`::: tab 标签`。
 *
 * **`tab` 的收尾可以省**：下一个 `::: tab` 也算上一段的收尾。实测模型常写成
 * `::: tabs` + 三个 `::: tab …` + 一个 `:::`（每段不各写收尾），严格按嵌套读会把三段读成一段、
 * 还会把后面的正文一起吞进去。这里按"下一个 tab 或第一个 `:::` 收尾"读，两种写法都成立。
 */
function splitTabs(inner: readonly string[]): { label: string; inner: string[] }[] {
  const out: { label: string; inner: string[] }[] = []
  let i = 0
  while (i < inner.length) {
    const open = containerOpen(inner[i]!)
    if (open === null || open.kind !== 'tab') {
      i += 1
      continue
    }
    const body: string[] = []
    let inFence = false
    i += 1
    while (i < inner.length) {
      const line = inner[i]!
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        body.push(line)
        i += 1
        continue
      }
      if (inFence) {
        body.push(line)
        i += 1
        continue
      }
      const next = containerOpen(line)
      if (next !== null && next.kind === 'tab') break
      if (isClose(line)) {
        i += 1
        break
      }
      body.push(line)
      i += 1
    }
    out.push({ label: open.arg, inner: body })
  }
  return out
}

/** 一个块。`at` 已经指向 `:::` 那一行。 */
function renderContainer(lines: readonly string[], at: number, ctx: Ctx, opts: RenderOptions, group: { n: number }): { html: string; next: number } {
  const open = containerOpen(lines[at]!)!
  const took = takeContainer(lines, at)
  if (!took.closed) ctx.notes.push(`块没有收尾（::: ${open.kind}）：在下一个二级标题处收住，后面照常读`)
  // **块内内容按需渲染，不预先渲染一遍**：`tabs` 里面是若干 `::: tab`，先整体渲染一遍会把
  // 每个 tab 都当成"不在 tabs 里的孤立块"，既多记两条 note，也让标题表多收一遍。
  const blockOf = (body: readonly string[]): string => renderBlocks(body, ctx, opts, group)
  switch (open.kind) {
    case 'note':
    case 'tip':
    case 'warn':
    case 'danger': {
      const title = open.arg === '' ? '' : `<p class="callout-title">${inline(open.arg, ctx, opts)}</p>`
      return { html: `<div class="callout ${open.kind}">${title}${blockOf(took.inner)}</div>`, next: took.next }
    }
    case 'details': {
      const summary = open.arg === '' ? '更多信息' : inline(open.arg, ctx, opts)
      return { html: `<details>\n<summary>${summary}</summary>\n${blockOf(took.inner)}\n</details>`, next: took.next }
    }
    case 'steps': {
      const at2 = firstItem(took.inner)
      if (at2 < 0) return { html: `<div class="steps">${blockOf(took.inner)}</div>`, next: took.next }
      const list = listAt(took.inner, at2, ctx, opts, true)
      return { html: `<div class="steps">${list.html}</div>`, next: took.next }
    }
    case 'figure': {
      const cap = open.arg === '' ? '' : `<figcaption>${inline(open.arg, ctx, opts)}</figcaption>`
      return { html: `<figure class="figure"><div class="figure-body">${blockOf(took.inner)}</div>${cap}</figure>`, next: took.next }
    }
    case 'tabs': {
      const tabs = splitTabs(took.inner)
      if (tabs.length === 0) {
        ctx.notes.push('tabs 里没有 ::: tab 段，已按普通内容呈现')
        return { html: blockOf(took.inner), next: took.next }
      }
      group.n += 1
      const gid = `tabs-${group.n}`
      const keep = tabs.slice(0, MAX_TABS)
      if (tabs.length > MAX_TABS) ctx.notes.push(`标签超过 ${MAX_TABS} 个，后面的按普通内容接在下面`)
      // **收音机与标签必须紧挨着**：`:checked + label` 是"选中态"唯一的判据（无 JS 时属性不会变）。
      const pairs = keep
        .map(
          (t, i) =>
            `<input class="tabin" type="radio" name="${gid}" id="${gid}-${i + 1}"${i === 0 ? ' checked' : ''}>` +
            `<label for="${gid}-${i + 1}">${inline(t.label, ctx, opts)}</label>`,
        )
        .join('')
      const panels = keep
        .map((t, i) => `<div class="tabpanel" role="group" aria-label="${escapeHtml(t.label)}" data-tab-for="${gid}-${i + 1}">${renderBlocks(t.inner, ctx, opts, group)}</div>`)
        .join('\n')
      const rest = tabs.slice(MAX_TABS).map((t) => renderBlocks(t.inner, ctx, opts, group)).join('')
      return { html: `<div class="tabs" role="group">${pairs}${panels}</div>${rest}`, next: took.next }
    }
    case 'tab': {
      // 没有 tabs 包着的孤立 tab：内容是正文，别丢。
      ctx.notes.push('::: tab 不在 ::: tabs 里，已按普通内容呈现')
      return { html: blockOf(took.inner), next: took.next }
    }
    default: {
      ctx.notes.push(`未识别的块：::: ${open.kind}（内容原样保留）`)
      const title = `<p class="callout-title">${escapeHtml(open.kind)}</p>`
      return { html: `<div class="callout">${title}${blockOf(took.inner)}</div>`, next: took.next }
    }
  }
}

/** `steps` 里第一条列表项在第几行；一行都没有时 `-1`（那一段按普通内容呈现，别丢）。 */
function firstItem(lines: readonly string[]): number {
  for (let i = 0; i < lines.length; i++) if (/^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) return i
  return -1
}

/** 一段行 → HTML。块与块之间不插空行（紧凑输出，逐字节可复现）。 */
function renderBlocks(lines: readonly string[], ctx: Ctx, opts: RenderOptions, group: { n: number }): string {
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (isBlank(line)) {
      i += 1
      continue
    }
    // 代码围栏
    if (/^\s*```\s*([\w-]*)\s*$/.test(line)) {
      const f = fenceAt(lines, i, ctx)
      out.push(f.html)
      i = f.next
      continue
    }
    // 块
    if (containerOpen(line) !== null) {
      const c = renderContainer(lines, i, ctx, opts, group)
      out.push(c.html)
      i = c.next
      continue
    }
    // 标题
    if (/^#{1,6}\s+/.test(line.trim())) {
      out.push(renderHeading(line, ctx, opts))
      i += 1
      continue
    }
    // 分隔线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('<hr>')
      i += 1
      continue
    }
    // 表格
    const table = tableAt(lines, i, ctx, opts)
    if (table !== null) {
      out.push(table.html)
      i = table.next
      continue
    }
    // 列表
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const list = listAt(lines, i, ctx, opts)
      out.push(list.html)
      i = list.next
      continue
    }
    // 引用
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      let j = i
      for (; j < lines.length; j++) {
        const quote = /^\s*>\s?(.*)$/.exec(lines[j]!)
        if (quote === null) break
        body.push(quote[1]!)
      }
      out.push(`<blockquote>${renderBlocks(body, ctx, opts, group)}</blockquote>`)
      i = j
      continue
    }
    // 段落：读到空行或另一个块的起点
    const para: string[] = []
    let j = i
    for (; j < lines.length; j++) {
      const l = lines[j]!
      if (isBlank(l)) break
      if (j > i && startsBlock(lines, j)) break
      para.push(l.trim())
    }
    out.push(`<p>${inline(para.join(' '), ctx, opts)}</p>`)
    i = j
  }
  return out.join('\n')
}

function startsBlock(lines: readonly string[], at: number): boolean {
  const l = lines[at]!
  return (
    /^\s*```/.test(l) ||
    containerOpen(l) !== null ||
    /^#{1,6}\s+/.test(l.trim()) ||
    /^\s*>/.test(l) ||
    /^\s*([-*]|\d+\.)\s+/.test(l) ||
    /^\s*(-{3,}|\*{3,})\s*$/.test(l) ||
    (l.includes('|') && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[at + 1] ?? ''))
  )
}

/**
 * 一份正文 → HTML + 标题表 + 引用表 + 兑不掉的清单。
 *
 * **同一份输入两次调用逐字节相同**：这是"宿主那一半可复现"的最小那块（交接单 § 1.4）。
 */
export function renderMarkdown(md: string, opts: RenderOptions = {}): MdResult {
  const ctx: Ctx = { headings: [], links: [], notes: [], used: opts.used ?? new Map() }
  const text = md.replace(/\r\n/g, '\n').replace(/\t/g, '  ')
  const html = renderBlocks(text.split('\n'), ctx, opts, { n: 0 })
  return { html, headings: ctx.headings, links: ctx.links, notes: ctx.notes }
}
