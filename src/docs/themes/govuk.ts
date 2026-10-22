// 视觉语言 · GOV.UK Design System 适配（交接单 § 2.2 的"至少三套"之一）。
//
// **参考来源**：GOV.UK Design System — Layout · Type scale · Details · Tabs（链接见
// `sources`）。**本项目适配**：直接的语言、足够大的正文、黄色焦点框、粗左侧边；关键条件与
// 步骤直接显示，解释与少见情形放 details；同题环境示例放 tabs，但步骤与差异保持可见。
//
// 气质：**第一次来的人也知道从哪里开始、需要什么、做完会得到什么**。
import type { ThemeSpec } from '../theme.ts'

const css = `:root[data-doc-theme="govuk"]{
  --doc-bg:#ffffff; --doc-surface:#f3f2f1; --doc-text:#0b0c0c; --doc-muted:#505a5f;
  --doc-border:#b1b4b6; --doc-accent:#1d70b8; --doc-accent-text:#003078;
  --doc-selected:#fff7bf; --doc-success:#00703c; --doc-attention:#b06000; --doc-danger:#d4351c;
  --doc-focus:#ffdd00; --doc-code-bg:#f3f2f1; --doc-callout-bg:#f3f2f1;
  --doc-font:system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --doc-mono:ui-monospace,"Cascadia Code",Consolas,"Liberation Mono",monospace;
  --doc-body-size:1.1875rem; --doc-body-leading:1.6;
  --doc-title-size:2.5rem; --doc-section-size:1.6875rem; --doc-subsection-size:1.3125rem;
  --doc-meta-size:0.875rem; --doc-content-width:40em; --doc-nav-width:16rem;
  --doc-radius:0; --doc-shadow:none; --doc-border-width:1px;
  --doc-heading-weight:700; --doc-link-decoration:underline; --doc-label-transform:none;
  --doc-space-1:0.25rem; --doc-space-2:0.5rem; --doc-space-3:1rem;
  --doc-space-4:1.5rem; --doc-space-5:2rem; --doc-space-6:3rem;
}
:root[data-doc-theme="govuk"] a:focus-visible, :root[data-doc-theme="govuk"] button:focus-visible,
:root[data-doc-theme="govuk"] summary:focus-visible, :root[data-doc-theme="govuk"] input:focus-visible{
  outline:3px solid var(--doc-focus); outline-offset:0; color:var(--doc-text); background:var(--doc-focus)
}
:root[data-doc-theme="govuk"] .callout{border-left:10px solid var(--doc-border);padding-left:var(--doc-space-3);background:transparent}
:root[data-doc-theme="govuk"] .callout.warn{border-left-color:var(--doc-attention)}
:root[data-doc-theme="govuk"] .callout.danger{border-left-color:var(--doc-danger)}
:root[data-doc-theme="govuk"] .callout.tip{border-left-color:var(--doc-success)}
:root[data-doc-theme="govuk"] .tag{background:var(--doc-accent);color:#fff;border-radius:0;font-weight:700;letter-spacing:0.02em}
:root[data-doc-theme="govuk"] .tabs>.tabin+label{border-bottom-width:2px;padding:var(--doc-space-2) var(--doc-space-2)}
:root[data-doc-theme="govuk"] .tabs>.tabin:checked+label{border-bottom:4px solid var(--doc-text)}
:root[data-doc-theme="govuk"] .steps .step::before{background:var(--doc-text);color:#fff;border-radius:0}
:root[data-doc-theme="govuk"] .skip{background:var(--doc-focus);color:var(--doc-text)}`

const guidance = `视觉语言：GOV.UK Design System 的文档方向（直接的语言、清楚的起点、可辨认的状态）。
- 层级：页标题 40px · 章节 27px · 小节 21px · 正文 19px/1.6 · 辅助 14px。标题字重 700，链接默认带下划线。
- 颜色：黑白为主，蓝色给链接；黄色只做焦点框；绿/橙/红各带一句文字语义。直角、无阴影、粗左侧边。
- 布局：左侧目录 16rem，正文最多 40em；正文优先，辅助导航让人随时返回。
- 组织：先一段话说清读完能做成什么与适用条件；"开始前"直接列出必要准备与限制；按顺序给操作、可复制内容与应看到的结果；解释与少见情形放 details；任务需要选路线时先帮读者辨认条件，再给对应步骤（tabs），但完整材料仍可查找与引用。
- 退化：关闭 JavaScript 后所有路线都能按顺序读完，原生展开与标签切换仍可用；窄屏导航可达、正文正常折行。`

export const govukTheme: ThemeSpec = {
  id: 'govuk',
  name: 'GOV.UK Design System',
  basis: 'GOV.UK Design System',
  version: 1,
  sources: [
    'https://design-system.service.gov.uk/styles/layout/',
    'https://design-system.service.gov.uk/styles/type-scale/',
    'https://design-system.service.gov.uk/components/details/',
    'https://design-system.service.gov.uk/components/tabs/',
  ],
  guidance,
  css,
}
