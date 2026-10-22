// 视觉语言 · Material Design 3 适配（交接单 § 2.2 的"至少三套"之一）。
//
// **参考来源**：Google Material 3 — Foundations · Applying type · Color roles · Canonical
// layouts（链接见 `sources`）。**本项目适配**：文字按角色分层（display/headline/title/body/label），
// 表面与强调色按用途配对；圆角与表面比例统一；图解用形状与文字标签一起表达，不只靠色相。
//
// 气质：**主次区域清楚、图文结合、随空间重排**；适合概念导览与不同读者的解释性文档。
import type { ThemeSpec } from '../theme.ts'

const css = `:root[data-doc-theme="material3"]{
  --doc-bg:#fef7ff; --doc-surface:#f3edf7; --doc-text:#1d1b20; --doc-muted:#49454f;
  --doc-border:#cac4d0; --doc-accent:#6750a4; --doc-accent-text:#4f378b;
  --doc-selected:#e8def8; --doc-success:#386a20; --doc-attention:#7d5700; --doc-danger:#b3261e;
  --doc-focus:#6750a4; --doc-code-bg:#f3edf7; --doc-callout-bg:#e8def8;
  --doc-font:system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --doc-mono:ui-monospace,"Cascadia Code",Consolas,"Liberation Mono",monospace;
  --doc-body-size:1rem; --doc-body-leading:1.7;
  --doc-title-size:2.5rem; --doc-section-size:1.5625rem; --doc-subsection-size:1.1875rem;
  --doc-meta-size:0.8125rem; --doc-content-width:44em; --doc-nav-width:15rem;
  --doc-radius:1rem; --doc-shadow:0 1px 2px rgba(0,0,0,.12),0 1px 3px rgba(0,0,0,.08);
  --doc-border-width:1px;
  --doc-heading-weight:500; --doc-link-decoration:underline; --doc-label-transform:none;
  --doc-space-1:0.25rem; --doc-space-2:0.5rem; --doc-space-3:1rem;
  --doc-space-4:1.5rem; --doc-space-5:2rem; --doc-space-6:3rem;
}
:root[data-doc-theme="material3"] .sidenav{background:var(--doc-surface);border-radius:var(--doc-radius);padding:var(--doc-space-3)}
:root[data-doc-theme="material3"] .callout{background:var(--doc-surface);border-radius:var(--doc-radius);border-left:0;padding:var(--doc-space-3) var(--doc-space-4)}
:root[data-doc-theme="material3"] .callout .callout-title{color:var(--doc-accent-text)}
:root[data-doc-theme="material3"] pre{border-radius:var(--doc-radius)}
:root[data-doc-theme="material3"] table{border:0}
:root[data-doc-theme="material3"] table th{background:var(--doc-surface);font-weight:500}
:root[data-doc-theme="material3"] table td{border-left:0;border-right:0}
:root[data-doc-theme="material3"] .tablist label{border-radius:999px;padding:var(--doc-space-1) var(--doc-space-3)}
:root[data-doc-theme="material3"] .tablist label[aria-selected="true"]{background:var(--doc-selected)}
:root[data-doc-theme="material3"] .step::before{background:var(--doc-accent);color:#fff}
:root[data-doc-theme="material3"] .tag{background:var(--doc-selected);border-radius:999px}`

const guidance = `视觉语言：Material 3 的文档方向（按角色分工的文字与颜色、可重排的布局）。
- 层级：页标题 40px · 章节 25px · 小节 19px · 正文 16px/1.7 · 辅助 13px。标题字重 500，正文 400，强调用色块或字重而非全大写。
- 颜色：表面色承载正文，强调色只给链接、当前选中与焦点；配对必须可读。圆角 16px，卡片有极轻的阴影。
- 布局：左侧目录 15rem，正文最多 44em；宽屏可以正文 + 辅助说明并排，窄屏按阅读顺序展开。
- 组织：首屏说明这份文档能解决什么并给直接入口；过程用图 + 文字概述，图中节点能到达条目；同题例子可切换，需要比较的差异并列；卡片只用于可以独立选择的入口。
- 退化：关闭 JavaScript 后正文、图注、原生展开与标签切换仍可读；选择只改变本页阅读状态，能回到默认路径。`

export const material3Theme: ThemeSpec = {
  id: 'material3',
  name: 'Material Design 3',
  basis: 'Google Material Design 3',
  version: 1,
  sources: [
    'https://m3.material.io/foundations/',
    'https://m3.material.io/styles/typography/applying-type',
    'https://m3.material.io/styles/color/roles',
    'https://m3.material.io/foundations/layout/canonical-examples/overview',
  ],
  guidance,
  css,
}
