// 视觉语言 · IBM Carbon 适配（交接单 § 2.2 的"至少三套"之一）。
//
// **参考来源**：IBM Carbon Design System — Type sets · Color · Content switcher（链接见
// `sources`）。**本项目适配**：参考表紧凑、解释正文舒展；直角与分层表面；查询密集的页面用
// 对齐与分组承担密度，中文正文不用产品界面的字号。
//
// 气质：**清楚的层次、稳定的对齐、有节奏的密度**；适合接口参考与需要反复查询的文档。
import type { ThemeSpec } from '../theme.ts'

const css = `:root[data-doc-theme="carbon"]{
  --doc-bg:#ffffff; --doc-surface:#f4f4f4; --doc-text:#161616; --doc-muted:#525252;
  --doc-border:#e0e0e0; --doc-accent:#0f62fe; --doc-accent-text:#0043ce;
  --doc-selected:#edf5ff; --doc-success:#198038; --doc-attention:#8e6a00; --doc-danger:#da1e28;
  --doc-focus:#0f62fe; --doc-code-bg:#f4f4f4; --doc-callout-bg:#edf5ff;
  --doc-font:system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --doc-mono:ui-monospace,"Cascadia Code",Consolas,"Liberation Mono",monospace;
  --doc-body-size:1rem; --doc-body-leading:1.65;
  --doc-title-size:2.125rem; --doc-section-size:1.375rem; --doc-subsection-size:1.125rem;
  --doc-meta-size:0.8125rem; --doc-content-width:46em; --doc-nav-width:16rem;
  --doc-radius:0; --doc-shadow:none; --doc-border-width:1px;
  --doc-heading-weight:600; --doc-link-decoration:none; --doc-label-transform:uppercase;
  --doc-space-1:0.25rem; --doc-space-2:0.5rem; --doc-space-3:1rem;
  --doc-space-4:1.5rem; --doc-space-5:2rem; --doc-space-6:2.5rem;
}
:root[data-doc-theme="carbon"] h1{letter-spacing:-0.01em}
:root[data-doc-theme="carbon"] h2{border-top:1px solid var(--doc-border);padding-top:var(--doc-space-3)}
:root[data-doc-theme="carbon"] table{border-top:2px solid var(--doc-text);border-bottom:2px solid var(--doc-text);border-left:0;border-right:0}
:root[data-doc-theme="carbon"] table th{background:var(--doc-surface);font-size:var(--doc-meta-size);text-transform:uppercase;letter-spacing:0.04em}
:root[data-doc-theme="carbon"] table td{border-top:1px solid var(--doc-border);border-left:0;border-right:0}
:root[data-doc-theme="carbon"] .callout{border-left:3px solid var(--doc-accent);background:var(--doc-callout-bg)}
:root[data-doc-theme="carbon"] .tag{background:var(--doc-surface);border-radius:999px;font-size:var(--doc-meta-size)}
:root[data-doc-theme="carbon"] code{font-size:0.92em}
:root[data-doc-theme="carbon"] .tablist{border-bottom:1px solid var(--doc-border);gap:0}
:root[data-doc-theme="carbon"] .tablist label{padding:var(--doc-space-2) var(--doc-space-3)}
:root[data-doc-theme="carbon"] .tablist label[aria-selected="true"]{border-bottom:2px solid var(--doc-accent);background:var(--doc-selected)}`

const guidance = `视觉语言：IBM Carbon 的文档方向（层次 · 对齐 · 有节奏的密度）。
- 层级：页标题 34px · 章节 22px · 小节 18px · 正文 16px/1.65 · 辅助 13px。章节之间用一条顶线分开，表格上下用粗线。
- 颜色：正文黑、表面灰；蓝色只给链接、当前视图与焦点；状态必须同时有文字，不能只靠底色。
- 布局：左侧目录 16rem，正文最多 46em。参考表比解释正文紧一档；直角、无阴影。
- 组织：适合接口参考——一条目的用途、输入、结果、限制成组出现，可引用地址稳定；同一组接口可看概览或明细（tabs），必须对照的差异并列给表格；内容多时按用途分组，不要求读者记住上一屏。
- 退化：关闭 JavaScript 后参考表、分组标题、原生展开与标签切换仍可用；窄屏里宽表在自身容器内横向滚动。`

export const carbonTheme: ThemeSpec = {
  id: 'carbon',
  name: 'IBM Carbon',
  basis: 'IBM Carbon Design System',
  version: 1,
  sources: [
    'https://www.carbondesignsystem.com/building-blocks/foundations/typography/type-sets',
    'https://www.carbondesignsystem.com/building-blocks/foundations/color/overview',
    'https://www.carbondesignsystem.com/building-blocks/core/components/content-switcher/guidelines',
  ],
  guidance,
  css,
}
