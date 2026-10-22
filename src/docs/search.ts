// 查找索引：**公共交互里"找到具体词句"那一条的数据**（交接单 § 2.1 的七问第三行）。
//
// 索引在生成时就做进页面（`<script type="application/json">`），所以离线双击、`file://` 打开都
// 能查；不建服务、不发请求（交接单 § 5.4）。每条命中带**标题 · 所在章节 · 片段**，点下去是
// 一条真链接（页面 + 内容块锚点），于是"选中后到达正文位置"由浏览器自己完成。
//
// **索引不是第二份正文**：它从渲染器交回来的内容块生成（`MdResult.blocks`），所以
//   · 页面上没有的句子，索引里也没有；
//   · **覆盖整份正文**：每一块的全文都在 `x` 里（`x` 不截断）。展示用的片段长度由页面脚本
//     自己剪——"片段多长"与"搜得到什么"是两件事（复审 R5：把 400 字当检索范围，后半页的词
//     就查不到了）；
//   · **命中落到内容块**：`b` 是那一块的元素 id，点下去直接到那一段；块在折叠内容或非默认
//     标签里时，页面脚本展开全部祖辈。
//
// 索引里也带章节（`s`）与章节锚点（`h`）：块 id 只是当页的定位手段，章节是读者认路的那一层。
import type { MdBlock } from './markdown.ts'
import type { PageDef } from './contract.ts'

/** 一条命中：页（out）· 页标题 · 章节 · 章节锚点 · 内容块 id · 全文。**字段名短是为了内嵌进每个页面**。 */
export interface SearchEntry {
  readonly p: string
  readonly t: string
  readonly s: string
  readonly h: string
  /** 内容块 id（命中落到具体那一段；块在折叠内容里时由页面脚本展开）。 */
  readonly b: string
  /** 这一块的全部可读文字（**不截断**；展示时由页面脚本截一段）。 */
  readonly x: string
}

/**
 * 一份正文 → 若干条。**切法与渲染器同源**：`blocks` 是 `renderMarkdown` 交回来的那一份，
 * 所以每条命中的锚点与页面里的 `id` 逐字相同——索引里给一个页面上不存在的锚点，等于让
 * 命中点下去落空。
 */
export function searchEntriesOf(page: PageDef, blocks: readonly MdBlock[]): SearchEntry[] {
  return blocks.map((b) => ({
    p: page.out,
    t: page.title,
    s: b.section,
    h: b.heading,
    b: b.id,
    x: b.text,
  }))
}

/**
 * 内嵌用的脚本内容。**所有 `<` 都写成 `\u003c`**：`</script>` 会当场结束脚本块，
 * `<!--` 后跟 `<script` 会把 tokenizer 推进双重转义态、把页面尾部吞成脚本文本——
 * 两类是同一个口子，拆 `<` 一次堵完（`\u003c` 是合法的 JSON 转义，解析回来还是 `<`）。
 */
export function searchIndexJson(entries: readonly SearchEntry[]): string {
  return JSON.stringify(entries).replace(/</g, '\\u003c')
}
