// 页面骨架 · 公共交互与页脚事实：**七个问题在结构上走得通**，换主题不动内容与操作含义。
//
// 判据来自交接单 § 2.1（七问）· § 2.2（换主题：内容完整、操作照旧）· § 2.4（页脚带完整提交、
// 来源与指纹）· § 6.2（形状检查证明结构，截图证明外观，各自只证明一部分）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { outOf, parseDocs } from './config.ts'
import type { DocsPlan, PageDef } from './contract.ts'
import { renderMarkdown } from './markdown.ts'
import { renderIndexPage, renderPage } from './page.ts'
import type { SiteInfo } from './page.ts'
import { searchEntriesOf } from './search.ts'
import { themeOf } from './theme.ts'

const MD = `## 先做什么 {#first}

主结论直接可见。

::: note 前置条件
需要一份提交。
:::

::: details 完整参数表
藏在这里。
:::

::: tabs
::: tab 第一次
甲内容
:::
::: tab 已经用过
乙内容
:::
:::

\`\`\`sh
fugue docs build
\`\`\`

见 [另一页](architecture.html#boundary) 与 [本页]( #first )，还有 <script>alert(1)</script>。
`

const PLAN: DocsPlan = (() => {
  const p = parseDocs({
    docs: {
      theme: 'primer',
      title: 'Fugue',
      pages: [
        { id: 'start', title: '开始', source: 'README.md', audience: '第一次用的人', role: '跑通第一条命令', prompt: '最短路径' },
        { id: 'architecture', title: '架构', source: 'design/ARCHITECTURE.md', audience: '维护者', role: '理解边界', prompt: '讲约束' },
      ],
    },
  })
  assert.ok(p !== null)
  return p
})()

const primer = themeOf('primer')
const govuk = themeOf('govuk')
assert.ok(primer !== null && govuk !== null)

function site(theme = primer): SiteInfo {
  return {
    project: 'Fugue',
    version: '1.2.3',
    commit: 'fd3cd29a1c2b3d4e5f60718293a4b5c6d7e8f901',
    commitShort: 'fd3cd29a1c2b',
    fingerprint: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    files: 508,
    theme,
  }
}

function page(theme = primer): { html: string; page: PageDef; headings: ReturnType<typeof renderMarkdown>['headings']; entries: ReturnType<typeof searchEntriesOf> } {
  const def = PLAN.pages[0]!
  const md = renderMarkdown(MD, { resolve: (raw) => ({ href: raw }) })
  const entries = searchEntriesOf(def, md.blocks)
  const other = PLAN.pages[1]!
  const otherMd = renderMarkdown('## 边界 {#boundary}\n\n正文。\n')
  const entriesAll = [...entries, ...searchEntriesOf(other, otherMd.blocks)]
  const rendered = renderPage({
    site: site(theme),
    plan: PLAN,
    page: def,
    html: md.html,
    headings: md.headings,
    notes: md.notes,
    sourceSha: '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c',
    index: entriesAll,
    anchors: {},
  })
  return { html: rendered.html, page: def, headings: md.headings, entries: entriesAll }
}

test('① 页首/目录：项目 · 适用版本 · 当前文档 · 本页章节（跳到正文的入口也在）', () => {
  const { html } = page()
  assert.ok(html.includes('href="#content">跳到正文</a>'), '键盘读者要有跳到正文的入口')
  assert.ok(html.includes('v1.2.3 · 提交 fd3cd29a1c2b'), '页首给版本与提交')
  assert.ok(html.includes('<a href="start.html" aria-current="page">开始</a>'), '目录标出当前文档')
  assert.ok(html.includes('<a href="architecture.html">架构</a>'), '目录列出同批的其它页')
  assert.ok(html.includes('href="#first">先做什么</a>'), '章节导航是真实链接')
  console.log(`① 读数：目录 ${PLAN.pages.length} 份 · 本章 ${html.match(/class="toc"/g)?.length ?? 0} 处`)
})

test('② 页脚事实：完整提交 · 来源与 sha · 指纹 · 视觉语言；页面里没有时间戳', () => {
  const { html } = page()
  assert.ok(html.includes('<code>fd3cd29a1c2b3d4e5f60718293a4b5c6d7e8f901</code>'), '完整提交')
  assert.ok(html.includes('<code>README.md</code>'), '来源文件')
  assert.ok(html.includes('sha 9f8e7d6c5b4a'), '来源 blob 的前 12 位')
  assert.ok(html.includes('<code>sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef</code>'), '指纹')
  assert.ok(html.includes('GitHub Primer'), '视觉语言写在页脚')
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(html), '页面只放内容与事实：生成时间进清单')
  assert.ok(html.startsWith('<!-- fugue docs · page start · commit fd3cd29'), '头一行记下这一页对应哪一版')
  console.log('② 读数：提交/来源/指纹/主题齐全 · 无时间戳')
})

test('④ 无 JS 的完整阅读路径：原生展开 · 收音机标签 · noscript 说明；按钮在脚本打开前不出现', () => {
  const { html } = page()
  assert.ok(/<details[^>]*>/.test(html), '展开是原生的')
  assert.ok(/type="radio"/.test(html) && /<label for="tabs-1-1">/.test(html), '切换是收音机，不靠脚本')
  assert.ok(html.includes('<noscript><p class="nojs-note">'), '没有脚本时的退路要说给读者')
  assert.ok(html.includes('data-open-search hidden'), '查找按钮由脚本放出，脚本不在时不出现')
  assert.ok(html.includes("d.querySelector('[data-open-search]')"), '脚本里放出按钮')
  console.log('④ 读数：details · radio tabs · noscript · 查找按钮 hidden')
})

test('⑤ 换主题：正文与操作逐字节相同，只有视觉变量与主题名变（内容与操作含义不随主题改）', () => {
  const a = page(primer).html
  const b = page(govuk).html
  const body = (h: string): string => h.slice(h.indexOf('<h1>'), h.indexOf('<footer>'))
  assert.equal(body(a), body(b), '正文那一截（标题到页脚）逐字节相同')
  for (const op of ['<details', 'type="radio"', 'data-open-search', 'class="anchor"']) {
    assert.ok(a.includes(op) && b.includes(op), `两边都要有 ${op}`)
  }
  assert.ok(a.includes('data-doc-theme="primer"') && b.includes('data-doc-theme="govuk"'))
  assert.ok(a.includes('--doc-body-size:1.0625rem') && b.includes('--doc-body-size:1.1875rem'), '变量确实换了')
  assert.notEqual(a, b)
  console.log(`⑤ 读数：正文 ${body(a).length} 字符逐字节相同 · 总长 ${a.length} vs ${b.length}`)
})

test('⑥ 首页由宿主合成：每份文档一个入口，写清给谁看与负责什么，这一版的事实一并给出', () => {
  const { entries } = page()
  const index = renderIndexPage({
    site: site(),
    plan: PLAN,
    index: entries,
    pages: PLAN.pages.map((p) => ({ page: p })),
  })
  assert.ok(index.includes('<h1>Fugue 文档</h1>'))
  for (const p of PLAN.pages) {
    assert.ok(index.includes(`href="${p.out}">${p.title}</a>`), `缺入口：${p.id}`)
    assert.ok(index.includes(p.audience) && index.includes(p.role), `缺读者/职责：${p.id}`)
  }
  assert.ok(index.includes('v1.2.3') && index.includes('fd3cd29a1c2b3d4e5f60718293a4b5c6d7e8f901'))
  assert.ok(index.includes('508'), '文件数写在这一版')
  console.log(`⑥ 读数：首页 ${index.length} 字符 · ${PLAN.pages.length} 个入口 · 事实齐`)
})

test('⑦ 一节一地址：标题 ID 与目录/查找的锚点逐字相同（不然命中点下去落空）', () => {
  const { html, headings, entries } = page()
  for (const h of headings) assert.ok(html.includes(`id="${h.id}"`), `正文缺 id=${h.id}`)
  for (const e of entries) {
    if (e.s === '先做什么') assert.equal(e.h, headings[0]?.id)
    assert.notEqual(e.b, '', '每条命中都要有内容块 id')
  }
  // 本页的命中要落在本页的块上（跨页的只看 id 非空）。
  for (const e of entries.filter((x) => x.p === 'start.html')) assert.ok(html.includes(`id="${e.b}"`), `命中要落到页面里的内容块：${e.p}#${e.b}`)
  assert.equal(outOf('start'), 'start.html')
  console.log(`⑦ 读数：${headings.length} 个标题 ID 在正文 · ${entries.length} 条命中都有内容块`)
})

test('⑧ 查找是模态：声明与实际行为在同一处（背景 inert · Tab 循环 · Esc 回到入口）', () => {
  const { html } = page()
  assert.ok(html.includes('role="dialog" aria-modal="true"'), '声明为模态')
  assert.ok(html.includes('overlay.hidden = false; background(true)'), '打开时把背景设成 inert')
  assert.ok(html.includes('overlay.hidden = true; background(false)'), '关闭时恢复背景')
  assert.ok(html.includes("setAttribute('inert'"), 'inert 真的落到背景元素上')
  assert.ok(html.includes('addEventListener(\'keydown\', trap)'), 'Tab 在面板里循环')
  assert.ok(html.includes('if (openBtn) openBtn.focus()'), '关闭后焦点回到打开入口')
  // 查找结果是真实链接，落到内容块（不是页首）
  assert.ok(html.includes("a.href = e.p + (e.b ? '#' + e.b"), '命中落到内容块')
  console.log('⑧ 读数：aria-modal · 打开/关闭都管 inert · Tab 循环 · 焦点回入口 · 命中落块')
})
