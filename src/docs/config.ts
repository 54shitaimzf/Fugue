// 文档定义：**工作区配置里 `docs` 那一份的读法与核对**（交接单 § 2.3 · § 4.4 · 架构 § 15.3.a）。
//
// 这一层只回答一个问题：这份配置说的是不是一份**能拿来生成**的文档计划。它不读提交、不读
// 来源、不碰网络——那些是 `facts.ts` 与 `build.ts` 的事。
//
// **写错就当场拒，并指出该改的那一格。** 话里带点分键（`docs.pages[2].source`），人照着那一格
// 改就行。这一条与配置顶层键域那条纪律同一个由来（架构 § 15.3.a）：一个被静默读成"没配"的
// 定义，会让下一次生成跑在一套与写下时不同的规则上。
//
// **`docs` 键不在 = 文档能力没启用**（交接单 § 3.5 末段）。它返回 `null`，不返回一份空计划：
// "没配"与"配了但一份文档都没有"是两件事，后者是写错了。
//
// **定义住配置 = 位置就是规则**（架构 § 24 纪律 13）：模型够不到这里，人改这里。
import type { ConfigDoc } from '../config.ts'
import { getConfig } from '../config.ts'
import type { DocsPlan, PageDef } from './contract.ts'
import { DocsError } from './contract.ts'
import { DEFAULT_THEME, THEME_IDS, themeOf } from './theme.ts'

/** `docs` 那一节认得的键（拼错的键当场拒，不静默忽略）。 */
export const DOCS_KEYS: readonly string[] = ['title', 'theme', 'pages', 'model', 'maxTokens']

/** `docs.pages` 一条认得的键。 */
export const PAGE_KEYS: readonly string[] = ['id', 'title', 'source', 'audience', 'role', 'prompt', 'out']

/** 页面标识能长什么样：小写字母数字与连字符，不以连字符开头。它同时是文件名与深链接的一段。 */
const ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/

/** 一页缺省的落盘文件名。 */
export function outOf(id: string): string {
  return `${id}.html`
}

/** 一份配置没有 `docs` 键：返回 `null`（能力未启用）。 */
export function docsOf(config: ConfigDoc): unknown {
  return getConfig(config, 'docs')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 一条给人看的指路：`配置 docs.pages[1].source 要…`。 */
function bad(cell: string, why: string, fix: string): DocsError {
  return new DocsError('config', `配置 ${cell} ${why}\n  该改的那一格：${cell} —— ${fix}`)
}

/**
 * 仓库相对路径的核对：**生成只读提交里的路径**，所以写绝对路径或 `..` 都是把生成接到别处去。
 * 这里只判形状；"提交里有没有这一份"由 `facts.ts` 当场报（那是另一类失败：配置对、材料缺）。
 */
function repoPath(cell: string, v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') throw bad(cell, '要是「仓库里的哪一份文件」的路径', '写一个相对路径，如 README.md')
  const p = v.trim()
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) throw bad(cell, '不接受绝对路径', '写仓库相对路径，如 design/ARCHITECTURE.md')
  if (p.includes('\\')) throw bad(cell, '用正斜杠分隔', '把 \\ 换成 /')
  const segs = p.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..')) {
    throw bad(cell, '里有空段或 . / .. 段', '写一条提交里真实存在的相对路径')
  }
  return p
}

/** 产物文件名的核对：**它决定文档目录的形状**（架构 § 9.9），所以不许指到子目录或清单上。 */
function outName(cell: string, v: unknown, id: string): string {
  const p = v === undefined ? outOf(id) : v
  if (typeof p !== 'string' || p.trim() === '') throw bad(cell, '要是产物文件名', `写成 ${outOf(id)} 这种`)
  const name = p.trim()
  if (name.includes('/') || name.includes('\\')) throw bad(cell, '只是文件名，不带目录', `写成 ${outOf(id)} 这种`)
  if (name.includes(':')) throw bad(cell, '里不要带 `:`（那会变成一条带 scheme 的地址）', `写成 ${outOf(id)} 这种`)
  if (!name.endsWith('.html')) throw bad(cell, '要以 .html 结尾', `写成 ${outOf(id)} 这种`)
  if (name === 'index.html' || name === 'manifest.json') {
    throw bad(cell, '不能占首页或清单的文件名', `换一个，如 ${outOf(id)}`)
  }
  return name
}

function text(cell: string, v: unknown, why: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw bad(cell, why, '写一句人读的话')
  return v.trim()
}

/** 一条页面定义。`index` 只用于报错话里指路。 */
function pageDefOf(raw: unknown, index: number): PageDef {
  const cell = `docs.pages[${index}]`
  if (!isPlainObject(raw)) throw bad(cell, '要是一个对象', `写成 {"id":"…","title":"…","source":"…","audience":"…","role":"…","prompt":"…"}`)
  for (const k of Object.keys(raw)) {
    if (!PAGE_KEYS.includes(k)) {
      throw bad(`${cell}.${k}`, '不是一条页面定义认得的键', `只认 ${PAGE_KEYS.join(' · ')}（架构 § 9.9 的文档定义）`)
    }
  }
  const idRaw = raw.id
  if (typeof idRaw !== 'string' || !ID_SHAPE.test(idRaw)) {
    throw bad(`${cell}.id`, '要是稳定标识（小写字母 · 数字 · 连字符，不以连字符开头）', '例如 start · architecture · api-v2')
  }
  const id = idRaw
  const title = text(`${cell}.title`, raw.title, '要是目录里显示的名字')
  const source = repoPath(`${cell}.source`, raw.source)
  const audience = text(`${cell}.audience`, raw.audience, '要写清这一份给谁看')
  const role = text(`${cell}.role`, raw.role, '要写清这一份负责讲什么、边界在哪')
  const prompt = text(`${cell}.prompt`, raw.prompt, '要写清这一份的写法与重点')
  const out = outName(`${cell}.out`, raw.out, id)
  return { id, title, source, audience, role, prompt, out }
}

/**
 * 读一份配置里的文档计划。**`docs` 不在返回 `null`**；在而不合形状就抛 `DocsError`。
 * 抛出来的话带点分键，落在 `config` 那一格——`fugue docs status` 与 `build` 都照它报。
 */
export function parseDocs(config: ConfigDoc): DocsPlan | null {
  const raw = docsOf(config)
  if (raw === undefined) return null
  if (!isPlainObject(raw)) throw bad('docs', '要是一个对象', '写成 {"theme":"primer","pages":[…]}  那种形状')
  for (const k of Object.keys(raw)) {
    if (!DOCS_KEYS.includes(k)) {
      throw bad(`docs.${k}`, '不是文档这一节认得的键', `只认 ${DOCS_KEYS.join(' · ')}`)
    }
  }

  const themeRaw = raw.theme === undefined ? DEFAULT_THEME : raw.theme
  if (typeof themeRaw !== 'string' || themeOf(themeRaw) === null) {
    throw bad('docs.theme', `不是带进来的那几套视觉语言之一（收到 ${JSON.stringify(raw.theme)}）`, `取 ${THEME_IDS.join(' / ')} 之一`)
  }
  const title = raw.title === undefined ? undefined : text('docs.title', raw.title, '要是一句文档集的标题')
  const model = raw.model === undefined ? undefined : text('docs.model', raw.model, '要是目录里有的模型名字')
  let maxTokens: number | undefined
  if (raw.maxTokens !== undefined) {
    const n = raw.maxTokens
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 256) {
      throw bad('docs.maxTokens', '要是不小于 256 的整数（单页输出预算）', '例如 8192；不写就用模型声明里的那一档')
    }
    maxTokens = n
  }

  if (!Array.isArray(raw.pages) || raw.pages.length === 0) {
    throw bad('docs.pages', '要是至少一份页面定义的数组', '写 [{"id":"start","title":"开始","source":"README.md","audience":"…","role":"…","prompt":"…"}]')
  }
  const pages: PageDef[] = []
  const ids = new Set<string>()
  const outs = new Set<string>()
  raw.pages.forEach((p, i) => {
    const page = pageDefOf(p, i)
    if (ids.has(page.id)) throw bad(`docs.pages[${i}].id`, `与前面的定义重名了（${page.id}）`, '每份文档一个稳定标识，深链接靠它')
    if (outs.has(page.out)) throw bad(`docs.pages[${i}].out`, `与前面的产物文件重名了（${page.out}）`, '每份文档一个产物文件名')
    ids.add(page.id)
    outs.add(page.out)
    pages.push(page)
  })

  return {
    title,
    theme: themeRaw,
    pages,
    model,
    maxTokens,
  }
}

/** 按 id 取一页定义。**没有就报出有哪几份**——`docs prompt <id>` 的失败面靠它。 */
export function pageOf(plan: DocsPlan, id: string): PageDef {
  const hit = plan.pages.find((p) => p.id === id)
  if (hit !== undefined) return hit
  throw new DocsError(
    'config',
    `没有 id 为 ${JSON.stringify(id)} 的文档定义。配置 docs.pages 里有的是：${plan.pages.map((p) => p.id).join(' · ')}`,
  )
}
