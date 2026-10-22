// 页面骨架：**公共交互那一层**（交接单 § 2.1）与页脚事实（§ 2.4）。
//
// 一次页面渲染只做三件事：把正文放进骨架 · 把导航与目录按这一批的定义拼好 · 把事实与指纹
// 写在页脚。它不认识模型、不认识提交——事实由调用方（`build.ts`）读好递进来。
//
// **自足**：样式、脚本、查找索引都在页面里；没有字体包、没有 CDN、没有图片外链
// （交接单 § 3.1）。离线双击可读，`file://` 下查找与复制也工作（`file:` 上 clipboard 常不可用，
// 脚本会退到"选中内容 + 提示手动复制"）。
//
// **可复现**：页面里没有时间戳，没有随机 id，页面次序由定义次序定。生成时间只进
// `manifest.json` 与 `last.json`（交接单 § 1.4）。
//
// 七个问题的回应落在这一份的结构里（§ 2.1 的那张表）：
//   页首给项目 · 文档标题 · 适用版本；目录标当前文档，章节导航标当前小节（脚本增强）
//   目录与引用是真实链接，章节有稳定 ID，浏览器前进后退照常
//   查找给标题 · 章节 · 片段，选中到达正文；浏览器查找照常
//   展开入口写清里面是什么（`summary`），主结论与前置条件不在里面
//   代码原样、复制只复制内容、成功在原处反馈、失败仍能手动选择
//   原生链接与按钮、清楚的焦点、跳到正文的入口、Tab 顺序按文档流
//   窄屏导航可达（目录收进 details）、正文折行、宽表与代码在自身容器里横向滚动
import type { DocsPlan, PageDef, RenderedPage } from './contract.ts'
import { RENDERER_VERSION } from './contract.ts'
import { escapeHtml } from './markdown.ts'
import type { MdHeading } from './markdown.ts'
import type { SearchEntry } from './search.ts'
import { searchIndexJson } from './search.ts'
import { BASE_CSS } from './style.ts'
import type { ThemeSpec } from './theme.ts'

/** 这一批的站点事实：页首与页脚都从这里取，一处算好。 */
export interface SiteInfo {
  /** 文档集的标题（`docs.title`，缺省用仓库名）。 */
  readonly project: string
  readonly version: string | null
  readonly commit: string
  readonly commitShort: string
  readonly fingerprint: string
  readonly files: number
  readonly theme: ThemeSpec
}

export interface PageInput {
  readonly site: SiteInfo
  readonly plan: DocsPlan
  readonly page: PageDef
  /** 正文 HTML（`renderMarkdown` 的出口）。 */
  readonly html: string
  readonly headings: readonly MdHeading[]
  readonly notes: readonly string[]
  readonly sourceSha: string | null
  /** 站点级的查找索引（同一份嵌进每一页：离线、可查）。 */
  readonly index: readonly SearchEntry[]
  /** 旧深链接的去向（旧 id → 新 id）：清单里记对照，正文里落成别名锚点，旧链接仍到达这一节。 */
  readonly anchors: Readonly<Record<string, string>>
}

export interface IndexInput {
  readonly site: SiteInfo
  readonly plan: DocsPlan
  readonly index: readonly SearchEntry[]
  /** 每页的标题 · 读者 · 职责（首页由宿主按定义与事实合成，交接单 § 3.4）。 */
  readonly pages: readonly { readonly page: PageDef }[]
}

/** 页首那一行：项目 · 适用版本与提交。 */
function topBar(site: SiteInfo): string {
  const version = site.version === null ? '版本未知' : `v${escapeHtml(site.version)}`
  return `<header class="top">
<a class="brand" href="index.html">${escapeHtml(site.project)}</a>
<span class="ver">${version} · 提交 ${escapeHtml(site.commitShort)}</span>
<span class="grow"></span>
<button class="search-open" type="button" data-open-search hidden>查找 <kbd>/</kbd></button>
</header>`
}

/** 目录（全部文档 + 本页章节）。窄屏收进原生 details，宽屏也用它折叠（不用脚本就能开合）。 */
function navOf(plan: DocsPlan, current: PageDef | null, headings: readonly MdHeading[]): string {
  const pages = plan.pages
    .map((p) => {
      const cur = current !== null && p.id === current.id ? ' aria-current="page"' : ''
      return `<li><a href="${escapeHtml(p.out)}"${cur}>${escapeHtml(p.title)}</a></li>`
    })
    .join('')
  const toc = headings
    .filter((h) => h.level <= 3)
    .map(
      (h) =>
        `<li class="lvl-${h.level}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`,
    )
    .join('')
  const tocBlock =
    current === null || toc === ''
      ? ''
      : `<div class="toc"><p>本页</p><ul>${toc}</ul></div>`
  return `<nav class="sidenav" aria-label="文档导航">
<details class="nav-fold" open>
<summary>目录</summary>
<div class="nav-pages"><ul>${pages}</ul></div>
${tocBlock}
</details>
</nav>`
}

/** 查找那一层：**脚本不在时整块不出现**（按钮也 `hidden`），读者用浏览器查找。 */
function searchBlocks(index: readonly SearchEntry[]): string {
  return `<div class="overlay" id="doc-search" hidden>
<div class="search-panel" role="dialog" aria-modal="true" aria-labelledby="doc-q-label">
<div class="search-head">
<label class="visually-hidden" id="doc-q-label" for="doc-q">查找文档</label>
<input class="search-input" id="doc-q" type="search" placeholder="查找：词、命令、参数" autocomplete="off">
<span class="search-hint">Esc 关</span>
</div>
<ul class="search-results" id="doc-results" role="list" aria-label="查找结果"></ul>
<p class="search-empty" id="doc-empty" hidden>没有匹配。可以换一个词，或按 Esc 回到正文。</p>
</div>
</div>
<script type="application/json" id="doc-index">${searchIndexJson(index)}</script>`
}

/** 页脚：版本 · 完整提交 · 来源 · 指纹（交接单 § 2.4 的"读者据此知道对应哪一版代码"）。 */
function footerOf(site: SiteInfo, page: PageDef | null, sourceSha: string | null): string {
  const src =
    page === null
      ? ''
      : `<p>来源 <code>${escapeHtml(page.source)}</code>${sourceSha === null ? '' : `（sha ${escapeHtml(sourceSha.slice(0, 12))}）`} · 文档 <code>${escapeHtml(page.id)}</code></p>`
  return `<footer>
<p><span class="tag">${escapeHtml(site.theme.name)}</span> ${site.version === null ? '版本未知' : `v${escapeHtml(site.version)}`} · 提交 <code>${escapeHtml(site.commit)}</code> · 文件 ${site.files}</p>
${src}
<p>状态指纹 <code>${escapeHtml(site.fingerprint)}</code></p>
<p>这一批由 Fugue 从提交 ${escapeHtml(site.commitShort)} 生成，可弃、可重生成：页面只放内容与事实，生成时间在 <code>manifest.json</code>。</p>
<noscript><p class="nojs-note">没有 JavaScript 也能读：正文、目录、原生展开与标签切换照常；查找用浏览器自带的查找（Ctrl-F / ⌘-F），复制请手动选择。</p></noscript>
</footer>`
}

function headOf(site: SiteInfo, title: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="generator" content="fugue docs · 渲染器 ${RENDERER_VERSION} · 视觉语言 ${escapeHtml(site.theme.id)}">
<style>
${BASE_CSS}
${site.theme.css}
</style>`
}

/**
 * 一页：正文 + 公共交互 + 页脚事实。
 *
 * 顶部那一条 HTML 注释是交接单 § 1.4 说的"头一行记下状态指纹"（HTML 的形态）——它不显示，
 * 但人用"查看源代码"就能读出这一页对应哪一版。
 */
export function renderPage(input: PageInput): RenderedPage {
  const { site, plan, page, html, headings, notes, sourceSha, index } = input
  const doc = `<!-- fugue docs · page ${page.id} · commit ${site.commit} · fingerprint ${site.fingerprint} · renderer ${RENDERER_VERSION} -->
<!doctype html>
<html lang="zh-CN" data-doc-theme="${escapeHtml(site.theme.id)}">
<head>
${headOf(site, `${page.title} · ${site.project}`)}
</head>
<body>
<a class="skip" href="#content">跳到正文</a>
${topBar(site)}
<div class="layout">
${navOf(plan, page, headings)}
<main id="content" tabindex="-1">
<h1>${escapeHtml(page.title)}</h1>
${html}
${footerOf(site, page, sourceSha)}
</main>
</div>
${searchBlocks(index)}
${ENHANCE_JS}
</body>
</html>
`
  return {
    id: page.id,
    title: page.title,
    out: page.out,
    html: doc,
    headings,
    anchors: input.anchors,
    notes,
  }
}

/**
 * 首页：**由宿主按定义与本次事实合成**（交接单 § 3.4）。它承担导航，讲述由各份文档承担。
 */
export function renderIndexPage(input: IndexInput): string {
  const { site, plan, index, pages } = input
  const cards = pages
    .map(
      ({ page }) => `<div class="card">
<h3><a href="${escapeHtml(page.out)}">${escapeHtml(page.title)}</a></h3>
<p>${escapeHtml(page.role)}</p>
<p class="who">给 ${escapeHtml(page.audience)}</p>
</div>`,
    )
    .join('\n')
  const facts = [
    ['版本', site.version === null ? '（提交里没有可读的版本号）' : `v${site.version}`],
    ['提交', site.commit],
    ['文件数', String(site.files)],
    ['文档', `${plan.pages.length} 份`],
    ['视觉语言', `${site.theme.name}（${site.theme.id}）`],
  ]
    .map(([k, v]) => `<tr><th scope="row">${escapeHtml(k!)}</th><td>${escapeHtml(v!)}</td></tr>`)
    .join('')
  const doc = `<!-- fugue docs · index · commit ${site.commit} · fingerprint ${site.fingerprint} · renderer ${RENDERER_VERSION} -->
<!doctype html>
<html lang="zh-CN" data-doc-theme="${escapeHtml(site.theme.id)}">
<head>
${headOf(site, `${site.project} 文档`)}
</head>
<body>
<a class="skip" href="#content">跳到正文</a>
${topBar(site)}
<div class="layout">
${navOf(plan, null, [])}
<main id="content" tabindex="-1">
<h1>${escapeHtml(site.project)} 文档</h1>
<p class="lede">这 ${plan.pages.length} 份文档对应提交 ${escapeHtml(site.commitShort)}${site.version === null ? '' : `（v${escapeHtml(site.version)}）`}。每份给不同的读者，从你正在做的事挑一份。</p>
<div class="meta-grid">
${cards}
</div>
<h2 id="this-version">这一版</h2>
<div class="table-wrap"><table><tbody>${facts}</tbody></table></div>
<p>文档是这一版代码的阅读投影：能做什么、怎么用、为什么这样组织、边界在哪。它只服务阅读，下一次生成从新的提交、来源与定义重新开始。</p>
${footerOf(site, null, null)}
</main>
</div>
${searchBlocks(index)}
${ENHANCE_JS}
</body>
</html>
`
  return doc
}

/**
 * 增强脚本：**只加能力，不改内容**。
 *
 * 四件事：复制按钮 · 查找面板 · 目录里标出当前小节 · 锚点落在折叠内容里时先展开。
 * 关掉它，页面仍是完整的阅读路径（原生 details / 收音机标签 / 浏览器查找 / 手动选择）。
 * 它不联网、不写项目文件、不把读者选择写回任何真源（交接单 § 2.1 的"阅读状态的边界"）。
 */
const ENHANCE_JS = `<script>
(function () {
  var d = document;
  var overlay = d.getElementById('doc-search');
  var openBtn = d.querySelector('[data-open-search]');
  var q = d.getElementById('doc-q');
  var list = d.getElementById('doc-results');
  var empty = d.getElementById('doc-empty');
  var entries = [];
  try { entries = JSON.parse((d.getElementById('doc-index') || {}).textContent || '[]'); } catch (e) { entries = []; }

  // ── 复制 ────────────────────────────────────────────────────────────────
  function selectAll(el) {
    var range = d.createRange(); range.selectNodeContents(el);
    var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  }
  function copyText(text, pre, btn) {
    function ok() { btn.textContent = '已复制'; btn.setAttribute('data-state', 'ok'); window.setTimeout(function () { btn.textContent = '复制'; btn.removeAttribute('data-state'); }, 1800); }
    function fail() { btn.textContent = '复制失败，请手动选择'; btn.setAttribute('data-state', 'fail'); selectAll(pre.querySelector('code') || pre); }
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(ok, fail); return; }
    try {
      var ta = d.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px';
      d.body.appendChild(ta); ta.select(); var done = d.execCommand('copy'); d.body.removeChild(ta);
      if (done) ok(); else fail();
    } catch (e) { fail(); }
  }
  Array.prototype.forEach.call(d.querySelectorAll('pre'), function (pre) {
    var btn = d.createElement('button');
    btn.type = 'button'; btn.className = 'copy'; btn.textContent = '复制'; btn.setAttribute('aria-label', '复制这段内容');
    btn.addEventListener('click', function () {
      var code = pre.querySelector('code');
      copyText(code ? code.textContent : pre.textContent, pre, btn);
    });
    pre.appendChild(btn);
  });

  // ── 查找 ────────────────────────────────────────────────────────────────
  function snippet(text, term) {
    var at = text.toLowerCase().indexOf(term);
    if (at < 0) at = 0;
    var from = Math.max(0, at - 40);
    return (from > 0 ? '…' : '') + text.slice(from, from + 140) + (text.length > from + 140 ? '…' : '');
  }
  function render(term) {
    if (!list) return;
    term = (term || '').trim().toLowerCase();
    list.innerHTML = '';
    if (term === '') { list.hidden = true; if (empty) empty.hidden = true; return; }
    var hits = [];
    for (var i = 0; i < entries.length && hits.length < 20; i++) {
      var e = entries[i];
      if ((e.t + ' ' + e.s + ' ' + e.x).toLowerCase().indexOf(term) >= 0) hits.push(e);
    }
    list.hidden = false;
    if (empty) empty.hidden = hits.length > 0;
    hits.forEach(function (e) {
      var li = d.createElement('li');
      var a = d.createElement('a');
      a.className = 'search-hit';
      a.href = e.p + (e.h ? '#' + e.h : '');
      var t = d.createElement('span'); t.className = 'hit-title'; t.textContent = e.t;
      var s = d.createElement('span'); s.className = 'hit-section'; s.textContent = e.s ? '§ ' + e.s : '';
      var x = d.createElement('span'); x.className = 'hit-snippet'; x.textContent = snippet(e.x, term);
      a.appendChild(t); a.appendChild(s); a.appendChild(x);
      li.appendChild(a); list.appendChild(li);
    });
  }
  function openSearch() {
    if (!overlay) return;
    overlay.hidden = false; if (q) { q.value = ''; q.focus(); } render('');
  }
  function closeSearch() {
    if (!overlay) return;
    overlay.hidden = true;
    if (openBtn) openBtn.focus();
  }
  if (openBtn && overlay) { openBtn.hidden = false; openBtn.addEventListener('click', openSearch); }
  if (q) q.addEventListener('input', function () { render(q.value); });
  if (overlay) {
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeSearch(); });
    list && list.addEventListener('click', function () { closeSearch(); });
  }

  // ── 目录：标出当前小节 ──────────────────────────────────────────────────
  var tocLinks = Array.prototype.slice.call(d.querySelectorAll('.toc a'));
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var byId = {};
    tocLinks.forEach(function (a) { byId[decodeURIComponent(a.hash.slice(1))] = a; });
    var observed = Object.keys(byId).map(function (id) { return d.getElementById(id); }).filter(Boolean);
    var io = new IntersectionObserver(function (rows) {
      rows.forEach(function (row) {
        if (!row.isIntersecting) return;
        tocLinks.forEach(function (a) {
          if (a === byId[row.target.id]) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
        });
      });
    }, { rootMargin: '-15% 0px -70% 0px' });
    observed.forEach(function (el) { io.observe(el); });
  }

  // ── 锚点落在折叠内容里：先展开，再到达 ──────────────────────────────────
  function reveal() {
    var id = decodeURIComponent((location.hash || '').slice(1));
    if (!id) return;
    var el = d.getElementById(id);
    if (!el) return;
    var panel = el.closest ? el.closest('.tabpanel') : null;
    if (panel) {
      var radio = d.getElementById(panel.getAttribute('data-tab-for'));
      if (radio) radio.checked = true;
    }
    var box = el.closest ? el.closest('details') : null;
    if (box) box.open = true;
  }
  window.addEventListener('hashchange', reveal);
  reveal();

  // ── 键盘：/ 开查找 · Esc 关 ─────────────────────────────────────────────
  d.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && overlay && !overlay.hidden) { ev.preventDefault(); closeSearch(); return; }
    var t = ev.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (ev.key === '/' && !typing && overlay && overlay.hidden) { ev.preventDefault(); openSearch(); }
  });
})();
</script>`
