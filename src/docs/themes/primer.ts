// 视觉语言 · GitHub Primer 适配（交接单 § 2.2 的"至少三套"之一）。
//
// **参考来源**：GitHub Primer Product UI — Typography · Layout · Color usage · Navigation ·
// Progressive disclosure · Accessibility（链接见 `sources`）。**本项目适配**：中文长文的正文
// 字号与行高、42em 的栏宽、左侧目录的安静度，以及"展开/切换都是一条原生的操作"这一条退化档。
// 不复制界面的色值表，也不要求安装 Primer / React / 字体包——这里只有变量与几条结构规则。
//
// 气质：**安静、清楚、适合长时间读**；技术内容有准确感，第一次来的人也知道从哪儿开始。
import type { ThemeSpec } from '../theme.ts'

const css = `:root[data-doc-theme="primer"]{
  --doc-bg:#ffffff; --doc-surface:#f6f8fa; --doc-text:#1f2328; --doc-muted:#59636e;
  --doc-border:#d1d9e0; --doc-accent:#0969da; --doc-accent-text:#0550ae;
  --doc-selected:#ddf4ff; --doc-success:#1a7f37; --doc-attention:#9a6700; --doc-danger:#cf222e;
  --doc-focus:#0969da; --doc-code-bg:#f6f8fa; --doc-callout-bg:#f6f8fa;
  --doc-font:system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --doc-mono:ui-monospace,"Cascadia Code",Consolas,"Liberation Mono",monospace;
  --doc-body-size:1.0625rem; --doc-body-leading:1.75;
  --doc-title-size:2.25rem; --doc-section-size:1.5rem; --doc-subsection-size:1.1875rem;
  --doc-meta-size:0.875rem; --doc-content-width:42em; --doc-nav-width:15rem;
  --doc-radius:0.375rem; --doc-shadow:none; --doc-border-width:1px;
  --doc-heading-weight:600; --doc-link-decoration:none; --doc-label-transform:none;
  --doc-space-1:0.25rem; --doc-space-2:0.5rem; --doc-space-3:1rem;
  --doc-space-4:1.5rem; --doc-space-5:2rem; --doc-space-6:3rem;
}
:root[data-doc-theme="primer"] h2{border-bottom:var(--doc-border-width) solid var(--doc-border);padding-bottom:var(--doc-space-2)}
:root[data-doc-theme="primer"] .toc a[aria-current="true"]{background:var(--doc-selected);border-radius:var(--doc-radius)}
:root[data-doc-theme="primer"] .tabs>.tabin+label{padding:var(--doc-space-2) var(--doc-space-3)}
:root[data-doc-theme="primer"] .tabs>.tabin:checked+label{border-bottom-color:#fd8c73}
:root[data-doc-theme="primer"] .callout{border-left:4px solid var(--doc-accent)}
:root[data-doc-theme="primer"] .callout.warn{border-left-color:var(--doc-attention)}
:root[data-doc-theme="primer"] .callout.danger{border-left-color:var(--doc-danger)}
:root[data-doc-theme="primer"] .callout.tip{border-left-color:var(--doc-success)}`

const guidance = `视觉语言：GitHub Primer 的产品文档方向（安静、清楚、长时间阅读）。
- 层级：页标题 36px · 章节 24px · 小节 19px · 正文 17px/1.75 · 辅助 14px。二级标题下有一条细线，章节之间留 48px。
- 颜色：中性底色承载正文；蓝色只给链接、当前选中与焦点；成功/注意/危险各有一句文字语义，不能只靠颜色。
- 布局：左侧目录 15rem，正文最多 42em；表格用于比较、步骤用于操作、图用于解释关系。首屏尽早出现有用内容。
- 组织：先给读者能做什么、怎么开始；参数、依据与少见情况放进可展开入口（details）或同题切换（tabs）；必须同时比较的内容并列给表格，不要让人来回切换。
- 退化：关闭 JavaScript 后正文、目录链接、原生展开与标签切换仍可用；搜索退到浏览器查找，复制退到手动选择。`

export const primerTheme: ThemeSpec = {
  id: 'primer',
  name: 'GitHub Primer',
  basis: 'GitHub Primer Product UI',
  version: 1,
  sources: [
    'https://primer.style/product/getting-started/foundations/typography/',
    'https://primer.style/product/getting-started/foundations/layout/',
    'https://primer.style/product/getting-started/foundations/color-usage/',
    'https://primer.style/product/ui-patterns/navigation/',
    'https://primer.style/product/ui-patterns/progressive-disclosure/',
    'https://primer.style/accessibility/',
  ],
  guidance,
  css,
}
