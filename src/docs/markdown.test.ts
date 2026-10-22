// markdown 子集 · 公共呈现的正文那一半：**结构对、地址稳、兑不掉的说出来**。
//
// 判据来自交接单 § 2.1：链接是真实链接、章节有稳定 ID、展开入口写清内容、主结论不在折叠里；
// § 2.6：宿主校验"引用是否可达、操作是否成立"；以及"无法兑现的表达如实说明并保留完整可读内容"。
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderMarkdown, slugOf } from './markdown.ts'

const resolve = (raw: string): { href: string } => ({ href: raw })

test('① 标题：稳定 ID 由文字推、`{#id}` 优先、重名去重、H1 让位给宿主（降到 H2）', () => {
  const r = renderMarkdown(
    ['# 页内大标题', '', '## 安装 {#install}', '', '## 安装 {#install}', '', '### 细节'].join('\n'),
  )
  assert.deepEqual(
    r.headings.map((h) => [h.level, h.id]),
    [
      [2, '页内大标题'],
      [2, 'install'],
      [2, 'install-2'],
      [3, '细节'],
    ],
  )
  assert.ok(r.html.includes('id="install"'), '目录与深链接要能到达这一节')
  // 中文标题的 slug 保留汉字（不是空串）
  assert.equal(slugOf('第一次生成'), '第一次生成')
  console.log(`① 读数：${r.headings.map((h) => `${h.level}:${h.id}`).join(' · ')}`)
})

test('② 代码：语言类名保留、原文逐字转义（生成内容写不出可执行标签）', () => {
  const r = renderMarkdown(['```ts', 'const x = "<script>alert(1)</script>"', '```'].join('\n'))
  assert.ok(r.html.includes('<code class="language-ts">'))
  assert.ok(r.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(!r.html.includes('<script'), '正文里不许出现可执行标签')
  // 未收尾的围栏：内容保留，并记一条 note（不静默丢）
  const open = renderMarkdown('```\n还在写')
  assert.ok(open.html.includes('还在写'))
  assert.ok(open.notes.some((n) => n.includes('代码围栏')))
  console.log(`② 读数：转义 ${r.html.includes('&lt;script&gt;') ? 'ok' : 'FAIL'} · 未收尾记 note`)
})

test('③ 表格与列表：结构、对齐、嵌套各就各位', () => {
  const md = [
    '| 参数 | 含义 |',
    '| --- | --- |',
    '| `--at` | 指定提交 |',
    '',
    '- 第一',
    '  - 嵌套',
    '- 第二',
    '',
    '1. 一步',
    '2. 两步',
  ].join('\n')
  const r = renderMarkdown(md)
  assert.ok(r.html.includes('<thead><tr><th scope="col">参数</th>'))
  assert.ok(r.html.includes('<td><code>--at</code></td>'))
  assert.ok(/<ul><li>第一<ul><li>嵌套<\/li><\/ul><\/li><li>第二<\/li><\/ul>/.test(r.html), r.html)
  assert.ok(r.html.includes('<ol><li>一步</li><li>两步</li></ol>'))
  console.log('③ 读数：表头 2 列 · 嵌套列表一层 · 有序列表')
})

test('④ 块：note/details/tabs/steps/figure 各自成立，且无 JS 也能用', () => {
  const md = [
    '::: note 前置条件',
    '先有提交。',
    ':::',
    '',
    '::: details 完整参数表',
    '藏在里面。',
    ':::',
    '',
    '::: tabs',
    '::: tab 第一次',
    '甲内容',
    ':::',
    '::: tab 已经用过',
    '乙内容',
    ':::',
    ':::',
    '',
    '::: steps',
    '1. 装',
    '2. 跑',
    ':::',
    '',
    '::: figure 数据流：定义 → 写作 → 页面',
    '示意文字',
    ':::',
  ].join('\n')
  const r = renderMarkdown(md)
  assert.ok(r.html.includes('<div class="callout note"><p class="callout-title">前置条件</p>'))
  assert.ok(/<details>\s*<summary>完整参数表<\/summary>/.test(r.html), '原生展开，不靠脚本')
  // 标签是收音机 + 紧挨着的 label：`:checked + label` 是选中态的唯一判据
  assert.ok(/<input class="tabin" type="radio" name="tabs-1" id="tabs-1-1" checked><label for="tabs-1-1">第一次<\/label>/.test(r.html), r.html)
  assert.equal((r.html.match(/class="tabpanel"/g) ?? []).length, 2)
  assert.ok(r.html.includes('<li class="step">装</li>'))
  assert.ok(r.html.includes('<figcaption>数据流：定义 → 写作 → 页面</figcaption>'))
  console.log('④ 读数：callout · details · tabs(2) · steps(2) · figure 全成立')
})

test('⑤ 兑不掉的东西：未识别的块与不可达引用保留内容、各记一条 note', () => {
  const r = renderMarkdown('::: mystery 标题\n内容还在\n:::\n\n见 [那一条](missing.html#x)。', {
    resolve: (raw) => (raw.startsWith('missing') ? null : { href: raw }),
  })
  assert.ok(r.html.includes('内容还在'), '块内容保留')
  assert.ok(r.html.includes('那一条'), '链接文字保留')
  assert.ok(!r.html.includes('href="missing.html#x"'), '兑不掉的引用不落成死链')
  assert.ok(r.notes.some((n) => n.includes('未识别的块')))
  assert.ok(r.notes.some((n) => n.includes('引用兑不掉')))
  assert.equal(r.links.filter((l) => l.kind === 'dropped').length, 1)
  console.log(`⑤ 读数：${r.notes.length} 条 note —— ${r.notes.join(' / ')}`)
})

test('⑥ 行内：代码/粗/斜/链接/图片，正文里的尖括号一律转义', () => {
  const r = renderMarkdown('用 `--at` 指定，**别** 写 *中文斜体*，见 [提交](start.html#commit) 与 ![图](docs/a.png)。<b>x</b>', {
    resolve: (raw) => ({ href: raw }),
  })
  for (const want of ['<code>--at</code>', '<strong>别</strong>', '<em>中文斜体</em>', 'href="start.html#commit"', '<img src="docs/a.png"', '&lt;b&gt;x&lt;/b&gt;']) {
    assert.ok(r.html.includes(want), `缺：${want} —— ${r.html}`)
  }
  console.log('⑥ 读数：六种行内都成立，裸 HTML 被转义')
})

test('⑦ 逐字节可复现：同一份正文两次渲染相同；旧 ID 落成别名锚点', () => {
  const md = '## 现在的标题 {#now}\n\n正文\n'
  const a = renderMarkdown(md, { aliases: { now: ['old-id'] } })
  const b = renderMarkdown(md, { aliases: { now: ['old-id'] } })
  assert.equal(a.html, b.html)
  assert.ok(a.html.includes('<span class="anchor-alias" id="old-id"></span>'), '旧深链接仍到达这一节')
  assert.ok(!renderMarkdown(md).html.includes('anchor-alias'), '没有旧 id 就不落别名')
  console.log('⑦ 读数：两次相同 · 旧 id 别名在位')
})
