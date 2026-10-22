// 公共呈现那一份 CSS：**只认变量，不认任何一套主题的具体值**。
//
// 它是"固定的优秀交互逻辑"这一层的外观半边（交接单 § 2.1）：同一套操作在换主题后含义不变，
// 因为操作元素的结构与状态（`aria-current` · `aria-selected` · `:focus-visible`）都不由主题
// 决定；主题只替换变量与少量结构规则（`themes/*.ts` 的 `css`）。
//
// **零外部资源**：字体只用系统栈，没有网络请求，图标用字符与 CSS 画。于是离线双击可读，
// 装进 `file://` 也不缺东西（交接单 § 3.1）。
//
// **退化是设计的一部分**：`details/summary` 是原生展开，标签页用 `input[type=radio] + label`
// 实现，关掉 JavaScript 仍可切换；搜索与复制按钮由脚本增强，脚本不在时退回浏览器查找与手动
// 选择（`noscript` 那句把这条路说给读者）。
/** 一页最多几组标签（渲染器与样式同源：渲染器按这个数生成，样式按它写选择器）。 */
export const MAX_TABS = 6

export const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
:root{
  --doc-bg:#fff;--doc-surface:#f6f8fa;--doc-text:#1f2328;--doc-muted:#59636e;--doc-border:#d1d9e0;
  --doc-accent:#0969da;--doc-accent-text:#0550ae;--doc-selected:#ddf4ff;--doc-success:#1a7f37;
  --doc-attention:#9a6700;--doc-danger:#cf222e;--doc-focus:#0969da;--doc-code-bg:#f6f8fa;
  --doc-callout-bg:#f6f8fa;--doc-font:system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --doc-mono:ui-monospace,"Cascadia Code",Consolas,monospace;--doc-body-size:1.0625rem;
  --doc-body-leading:1.75;--doc-title-size:2.25rem;--doc-section-size:1.5rem;
  --doc-subsection-size:1.1875rem;--doc-meta-size:0.875rem;--doc-content-width:42em;
  --doc-nav-width:15rem;--doc-radius:0.375rem;--doc-shadow:none;--doc-border-width:1px;
  --doc-heading-weight:600;--doc-link-decoration:none;--doc-label-transform:none;
  --doc-space-1:0.25rem;--doc-space-2:0.5rem;--doc-space-3:1rem;--doc-space-4:1.5rem;
  --doc-space-5:2rem;--doc-space-6:3rem;
}
html{background:var(--doc-bg);color:var(--doc-text);font-family:var(--doc-font);font-size:100%;
  -webkit-text-size-adjust:100%;scroll-padding-top:var(--doc-space-6)}
body{margin:0;font-size:var(--doc-body-size);line-height:var(--doc-body-leading)}
a{color:var(--doc-accent-text);text-decoration:var(--doc-link-decoration);text-underline-offset:.2em}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--doc-focus);outline-offset:2px;border-radius:2px}
.skip{position:absolute;left:-999px;top:0;padding:var(--doc-space-2) var(--doc-space-3);
  background:var(--doc-focus);color:#fff;z-index:100}
.skip:focus{left:var(--doc-space-3);top:var(--doc-space-2)}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
.top kbd{font-family:var(--doc-mono);font-size:.85em;border:var(--doc-border-width) solid var(--doc-border);
  border-radius:3px;padding:0 .3em;background:var(--doc-bg)}
.top{display:flex;flex-wrap:wrap;gap:var(--doc-space-2) var(--doc-space-3);align-items:baseline;
  padding:var(--doc-space-3) var(--doc-space-4);border-bottom:var(--doc-border-width) solid var(--doc-border)}
.top .brand{font-weight:var(--doc-heading-weight);font-size:1rem;color:var(--doc-text);text-decoration:none}
.top .ver{color:var(--doc-muted);font-size:var(--doc-meta-size);font-variant-numeric:tabular-nums}
.top .grow{flex:1}
.search-open{font:inherit;font-size:var(--doc-meta-size);color:var(--doc-text);background:var(--doc-surface);
  border:var(--doc-border-width) solid var(--doc-border);border-radius:var(--doc-radius);
  padding:var(--doc-space-1) var(--doc-space-3);cursor:pointer}
.layout{display:grid;grid-template-columns:var(--doc-nav-width) minmax(0,1fr);gap:var(--doc-space-6);
  max-width:calc(var(--doc-content-width) + var(--doc-nav-width) + var(--doc-space-6)*3);margin:0 auto;
  padding:var(--doc-space-5) var(--doc-space-4) var(--doc-space-6)}
.sidenav{font-size:0.9375rem;align-self:start;position:sticky;top:var(--doc-space-4)}
.nav-fold>summary{cursor:pointer;font-weight:var(--doc-heading-weight);padding:var(--doc-space-1) 0;
  color:var(--doc-muted);font-size:var(--doc-meta-size);text-transform:var(--doc-label-transform);
  letter-spacing:.04em;list-style:none}
.nav-fold>summary::-webkit-details-marker{display:none}
.nav-fold>summary::before{content:"▾ ";color:var(--doc-muted)}
.nav-fold:not([open])>summary::before{content:"▸ "}
.nav-pages ul,.toc ul{list-style:none;margin:0;padding:0}
.nav-pages a,.toc a{display:block;color:var(--doc-text);text-decoration:none;padding:var(--doc-space-1) var(--doc-space-2);
  border-left:2px solid transparent;border-radius:0 var(--doc-radius) var(--doc-radius) 0}
.nav-pages a:hover,.toc a:hover{background:var(--doc-surface)}
.nav-pages a[aria-current="page"]{border-left-color:var(--doc-accent);font-weight:var(--doc-heading-weight);color:var(--doc-accent-text)}
.toc{margin-top:var(--doc-space-4)}
.toc>p{margin:0 0 var(--doc-space-2);color:var(--doc-muted);font-size:var(--doc-meta-size);
  text-transform:var(--doc-label-transform);letter-spacing:.04em}
.toc .lvl-3 a{padding-left:var(--doc-space-4);font-size:0.9em;color:var(--doc-muted)}
.toc a[aria-current="true"]{background:var(--doc-selected);border-left-color:var(--doc-accent)}
main{min-width:0}
h1,h2,h3,h4{line-height:1.25;margin:0;font-weight:var(--doc-heading-weight);scroll-margin-top:var(--doc-space-5)}
h1{font-size:var(--doc-title-size);letter-spacing:-.01em;margin-bottom:var(--doc-space-3)}
h2{font-size:var(--doc-section-size);margin-top:var(--doc-space-6);margin-bottom:var(--doc-space-3)}
h3{font-size:var(--doc-subsection-size);margin-top:var(--doc-space-5);margin-bottom:var(--doc-space-2)}
h4{font-size:1.0625rem;margin-top:var(--doc-space-4);margin-bottom:var(--doc-space-2)}
.lede{color:var(--doc-muted);margin:0 0 var(--doc-space-4);max-width:var(--doc-content-width)}
.anchor{margin-left:var(--doc-space-2);color:var(--doc-muted);text-decoration:none;font-weight:400;
  opacity:0;font-size:.8em}
h2:hover .anchor,h3:hover .anchor,.anchor:focus-visible{opacity:1}
.anchor-alias{position:absolute;scroll-margin-top:var(--doc-space-5)}
p{margin:0 0 var(--doc-space-3);max-width:var(--doc-content-width)}
ul,ol{margin:0 0 var(--doc-space-3);padding-left:1.4em;max-width:var(--doc-content-width)}
li{margin:var(--doc-space-1) 0}
li>ul,li>ol{margin:var(--doc-space-1) 0}
blockquote{margin:0 0 var(--doc-space-3);padding:0 var(--doc-space-3);color:var(--doc-muted);
  border-left:3px solid var(--doc-border);max-width:var(--doc-content-width)}
hr{border:0;border-top:var(--doc-border-width) solid var(--doc-border);margin:var(--doc-space-5) 0}
code{font-family:var(--doc-mono);font-size:.9em;background:var(--doc-code-bg);padding:.12em .35em;
  border-radius:var(--doc-radius);overflow-wrap:anywhere}
pre{margin:0 0 var(--doc-space-4);padding:var(--doc-space-3);background:var(--doc-code-bg);
  border:var(--doc-border-width) solid var(--doc-border);border-radius:var(--doc-radius);
  overflow-x:auto;position:relative;max-width:100%}
pre code{background:none;padding:0;font-size:.875rem;line-height:1.6;white-space:pre;display:block}
.copy{position:absolute;top:var(--doc-space-2);right:var(--doc-space-2);font:inherit;font-size:var(--doc-meta-size);
  color:var(--doc-text);background:var(--doc-bg);border:var(--doc-border-width) solid var(--doc-border);
  border-radius:var(--doc-radius);padding:0 var(--doc-space-2);cursor:pointer;opacity:.85}
.copy:hover{opacity:1}
.copy[data-state="ok"]{color:var(--doc-success);border-color:var(--doc-success)}
.copy[data-state="fail"]{color:var(--doc-danger);border-color:var(--doc-danger)}
.table-wrap{overflow-x:auto;margin:0 0 var(--doc-space-4);border:var(--doc-border-width) solid var(--doc-border);
  border-radius:var(--doc-radius)}
table{border-collapse:collapse;width:100%;font-size:.95em;min-width:32em}
th,td{text-align:left;vertical-align:top;padding:var(--doc-space-2) var(--doc-space-3);
  border-bottom:var(--doc-border-width) solid var(--doc-border)}
th{background:var(--doc-surface);font-weight:var(--doc-heading-weight)}
tr:last-child td{border-bottom:0}
.callout{margin:0 0 var(--doc-space-4);padding:var(--doc-space-3) var(--doc-space-4);
  background:var(--doc-callout-bg);border-left:3px solid var(--doc-accent);border-radius:0 var(--doc-radius) var(--doc-radius) 0}
.callout>:last-child{margin-bottom:0}
.callout-title{margin:0 0 var(--doc-space-2);font-weight:var(--doc-heading-weight)}
details{margin:0 0 var(--doc-space-4);border:var(--doc-border-width) solid var(--doc-border);
  border-radius:var(--doc-radius);padding:var(--doc-space-2) var(--doc-space-3)}
details>summary{cursor:pointer;font-weight:var(--doc-heading-weight)}
details[open]>summary{margin-bottom:var(--doc-space-2)}
.tabs{margin:0 0 var(--doc-space-4);border:var(--doc-border-width) solid var(--doc-border);border-radius:var(--doc-radius);display:flex;flex-wrap:wrap}
.tabs>.tabin{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}
.tabs>.tabin+label{cursor:pointer;padding:var(--doc-space-2) var(--doc-space-3);
  border-bottom:2px solid transparent;color:var(--doc-muted);font-size:.95em}
.tabs>.tabin+label:hover{color:var(--doc-text)}
.tabs>.tabin:checked+label{color:var(--doc-text);font-weight:var(--doc-heading-weight);border-bottom-color:var(--doc-accent)}
.tabs>.tabin:focus-visible+label{outline:2px solid var(--doc-focus);outline-offset:-2px}
.tabs>.tabpanel{display:none;padding:var(--doc-space-3) var(--doc-space-4);width:100%}
.tabs>.tabpanel>:last-child{margin-bottom:0}
.steps{margin:0 0 var(--doc-space-4);counter-reset:step}
.steps>ol{list-style:none;padding-left:0}
.steps .step{position:relative;padding-left:2.2em;margin-bottom:var(--doc-space-3)}
.steps .step::before{counter-increment:step;content:counter(step);position:absolute;left:0;top:.1em;
  width:1.5em;height:1.5em;display:grid;place-items:center;border-radius:50%;
  background:var(--doc-surface);border:var(--doc-border-width) solid var(--doc-border);font-size:.8em;font-weight:600}
.figure{margin:0 0 var(--doc-space-4)}
.figure-body{border:var(--doc-border-width) dashed var(--doc-border);border-radius:var(--doc-radius);
  padding:var(--doc-space-3);overflow-x:auto}
.figure figcaption{margin-top:var(--doc-space-2);color:var(--doc-muted);font-size:var(--doc-meta-size)}
.tag{display:inline-block;padding:0 var(--doc-space-2);font-size:var(--doc-meta-size);
  background:var(--doc-surface);border:var(--doc-border-width) solid var(--doc-border);border-radius:var(--doc-radius)}
footer{border-top:var(--doc-border-width) solid var(--doc-border);margin-top:var(--doc-space-6);
  padding:var(--doc-space-4) var(--doc-space-4) var(--doc-space-6);color:var(--doc-muted);
  font-size:var(--doc-meta-size);max-width:var(--doc-content-width)}
footer p{margin:0 0 var(--doc-space-1);max-width:none;overflow-wrap:anywhere}
footer code{background:none;padding:0}
.overlay[hidden]{display:none}
.overlay{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.35);display:flex;
  align-items:flex-start;justify-content:center;padding:10vh var(--doc-space-3) var(--doc-space-3)}
.search-panel{background:var(--doc-bg);color:var(--doc-text);width:min(46rem,100%);max-height:70vh;
  display:flex;flex-direction:column;border-radius:var(--doc-radius);box-shadow:0 12px 40px rgba(0,0,0,.25);
  border:var(--doc-border-width) solid var(--doc-border);overflow:hidden}
.search-head{display:flex;gap:var(--doc-space-2);align-items:center;padding:var(--doc-space-3);
  border-bottom:var(--doc-border-width) solid var(--doc-border)}
.search-input{flex:1;font:inherit;font-size:1rem;padding:var(--doc-space-2) var(--doc-space-3);
  border:var(--doc-border-width) solid var(--doc-border);border-radius:var(--doc-radius);
  background:var(--doc-bg);color:var(--doc-text)}
.search-hint{color:var(--doc-muted);font-size:var(--doc-meta-size);white-space:nowrap}
.search-results{list-style:none;margin:0;padding:0;overflow-y:auto}
.search-results li{margin:0}
.search-hit{display:block;padding:var(--doc-space-2) var(--doc-space-3);text-decoration:none;color:var(--doc-text);
  border-bottom:var(--doc-border-width) solid var(--doc-border)}
.search-hit:hover,.search-hit[aria-selected="true"]{background:var(--doc-selected)}
.search-hit .hit-title{font-weight:var(--doc-heading-weight)}
.search-hit .hit-section,.search-hit .hit-snippet{color:var(--doc-muted);font-size:var(--doc-meta-size);
  display:block;margin-top:2px}
.search-empty{padding:var(--doc-space-3);color:var(--doc-muted)}
.meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:var(--doc-space-4);
  margin:var(--doc-space-4) 0;max-width:100%}
.card{border:var(--doc-border-width) solid var(--doc-border);border-radius:var(--doc-radius);
  padding:var(--doc-space-3) var(--doc-space-4);background:var(--doc-bg);box-shadow:var(--doc-shadow)}
.card h3{margin-top:0}
.card p{margin-bottom:0}
.card .who{color:var(--doc-muted);font-size:var(--doc-meta-size)}
.nojs-note{color:var(--doc-muted)}
@media (max-width:60em){
  .layout{grid-template-columns:minmax(0,1fr);gap:var(--doc-space-4);padding-top:var(--doc-space-3)}
  .sidenav{position:static;border-bottom:var(--doc-border-width) solid var(--doc-border);
    padding-bottom:var(--doc-space-2)}
  .toc{display:none}
  h1{font-size:1.75rem} h2{font-size:1.35rem} h3{font-size:1.15rem}
  pre,.table-wrap,.figure-body{max-width:100%}
}
@media print{
  .top,.sidenav,.search-open,.overlay,.copy{display:none!important}
  .layout{display:block;padding:0;max-width:none}
  a{color:inherit;text-decoration:underline}
  pre,details,.tabs{border:1px solid #ccc;break-inside:avoid}
  details>.tabpanel{display:block!important}
}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
` + tabRules()

/**
 * 标签页那几条"第 i 个选中 → 第 i 个面板显示"的选择器。
 *
 * **为什么不用 `aria-selected` 上色**：无 JS 时属性不会跟着选择变，样式的判据必须是选择器
 * 自己能看见的那个状态（`:checked`）。收音机按钮的选择因此既驱动内容，又驱动选中样式。
 */
function tabRules(): string {
  let out = ''
  for (let i = 1; i <= MAX_TABS; i++) {
    out += `\n.tabs>.tabin:nth-of-type(${i}):checked~.tabpanel:nth-of-type(${i}){display:block}`
  }
  return out
}
