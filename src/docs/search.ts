// 查找索引：**公共交互里"找到具体词句"那一条的数据**（交接单 § 2.1 的七问第三行）。
//
// 索引在生成时就做进页面（`<script type="application/json">`），所以离线双击、`file://` 打开都
// 能查；不建服务、不发请求（交接单 § 5.4）。每条命中带**标题 · 所在章节 · 片段**，点下去是
// 一条真链接（页面 + 锚点），于是"选中后到达正文位置"由浏览器自己完成。
//
// **索引不是第二份正文**：它从同一份生成正文里切出来，页面上没有的句子索引里也没有。它的
// 唯一去处是这个页面自己的查找框；脚本不在时读者用浏览器查找，读到的是同一份正文。
import type { MdHeading } from './markdown.ts'
import type { PageDef } from './contract.ts'

/** 一条命中：页（out）· 页标题 · 章节 · 锚点 · 片段。**字段名短是为了内嵌进每个页面**。 */
export interface SearchEntry {
  readonly p: string
  readonly t: string
  readonly s: string
  readonly h: string
  readonly x: string
}

/** markdown 语法剥成可读文字（索引里不出现 `**` 与围栏）。 */
function plainOf(lines: readonly string[]): string {
  const out: string[] = []
  let inFence = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (line === '') continue
    // 块那一行：**块的标题是可查的词**（"前置条件"这种词常常只在标题上），所以取参数，不整行丢。
    if (/^:::\s*$/.test(line)) continue
    const open = /^:::\s*[a-z][a-z0-9-]*\s*(.*)$/.exec(line)
    if (open !== null) {
      if ((open[1] ?? '') !== '') out.push(open[1]!)
      continue
    }
    if (!inFence && /^\|?\s*[-:|\s]+\|?\s*$/.test(line) && line.includes('-')) continue
    let s = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\s*([-*]|\d+\.)\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
      .replace(/\{#[^}]*\}/g, '')
      .replace(/\|/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (s === '') continue
    out.push(s)
  }
  return out.join(' ')
}

/**
 * 一份正文 → 若干条。**切法与渲染器同源**：`headings` 是 `renderMarkdown` 交回来的那一份，
 * 所以每条命中的锚点与页面里的 `id` 逐字相同——索引里给一个页面上不存在的锚点，等于让
 * 命中点下去落空。
 */
export function searchEntriesOf(page: PageDef, md: string, headings: readonly MdHeading[]): SearchEntry[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: SearchEntry[] = []
  let section = ''
  let hash = ''
  let buf: string[] = []
  let n = 0
  let inFence = false
  const flush = (): void => {
    const text = plainOf(buf)
    if (text !== '' || hash !== '') {
      out.push({ p: page.out, t: page.title, s: section, h: hash, x: text.slice(0, 400) })
    }
    buf = []
  }
  for (const line of lines) {
    const t = line.trim()
    // **围栏里的 `#` 是注释，不是标题**：计数要与渲染器一致（它也不在围栏里出标题），
    // 否则围栏后每一节都会拿到前一节的锚点，命中点下去落到别的节。
    if (/^```/.test(t)) {
      inFence = !inFence
      buf.push(line)
      continue
    }
    if (!inFence && /^#{1,6}\s+/.test(t)) {
      flush()
      const h = headings[n]
      n += 1
      section = h?.text ?? line.replace(/^#{1,6}\s+/, '').replace(/\{#[^}]*\}/g, '').trim()
      hash = h?.id ?? ''
      continue
    }
    buf.push(line)
  }
  flush()
  return out.filter((e) => e.x !== '' || e.s !== '')
}

/**
 * 内嵌用的脚本内容。**所有 `<` 都写成 `\u003c`**：`</script>` 会当场结束脚本块，
 * `<!--` 后跟 `<script` 会把 tokenizer 推进双重转义态、把页面尾部吞成脚本文本——
 * 两类是同一个口子，拆 `<` 一次堵完（`\u003c` 是合法的 JSON 转义，解析回来还是 `<`）。
 */
export function searchIndexJson(entries: readonly SearchEntry[]): string {
  return JSON.stringify(entries).replace(/</g, '\\u003c')
}
