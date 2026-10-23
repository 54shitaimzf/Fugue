// 查找索引：**切法与渲染器同源**（内容块由 `renderMarkdown` 交回来），嵌进页面的 JSON 不许
// 反过来伤到页面本身。
//
// 四条断言：围栏里的 `#` 不是标题 · 索引 JSON 里没有 `<` · **检索覆盖整份正文**（第 401 字之后
// 的独有词查得到，复审 R5）· **命中落到具体内容块**（折叠内容与非默认标签里的也算）。
import assert from 'node:assert/strict'
import test from 'node:test'
import type { PageDef } from './contract.ts'
import { renderMarkdown } from './markdown.ts'
import { searchEntriesOf, searchIndexJson } from './search.ts'

const PAGE: PageDef = {
  id: 'start',
  title: '开始',
  source: 'README.md',
  audience: '新人',
  role: '上手',
  prompt: '最短路径',
  out: 'start.html',
}

test('① 围栏里的 `#` 是注释不是标题：标题槽不错位，命中落在真锚点上', () => {
  const md = ['## 第一节 {#one}', '', '正文一。', '', '```sh', '# 这是 shell 注释', 'echo hi', '```', '', '## 第二节 {#two}', '', '正文二。'].join('\n')
  const r = renderMarkdown(md)
  const entries = searchEntriesOf(PAGE, r.blocks)
  const two = entries.filter((e) => e.s === '第二节')
  assert.ok(two.length > 0, JSON.stringify(entries))
  for (const e of two) {
    assert.equal(e.h, 'two', '第二节的命中要指向自己的锚点')
    assert.ok(r.html.includes(`id="${e.b}"`), `命中要落到页面里的内容块：${e.b}`)
  }
  assert.ok(!entries.some((e) => e.s.includes('shell 注释')), '注释不该成节')
  assert.ok(entries.some((e) => e.h === 'one'))
  console.log(`① 读数：${entries.length} 条 · 第二节命中 ${two.length} 条且都有内容块 ${two[0]?.b}`)
})

test('② 索引 JSON 里一个 `<` 都没有：`</script>` 与 `<!--`+`<script` 两类口子一起堵', () => {
  const json = searchIndexJson([
    { p: 'start.html', t: '开始', s: '节', h: 'x', b: 'doc-b-1', x: 'a </script> b <!-- c <script> d' },
  ])
  assert.ok(!json.includes('<'), json)
  const back = JSON.parse(json) as { x: string }[]
  assert.equal(back[0]!.x, 'a </script> b <!-- c <script> d', '解析回来还是原文')
  console.log('② 读数：JSON 里 0 个 `<` · 原文往返一致')
})

test('③ 检索覆盖整份正文：第 401 字之后的独有词也查得到（不是只搜每节前 400 字）', () => {
  const filler = '这一段说明这一页要解决的问题，以及读者能从这里得到什么。'.repeat(20)
  const paragraph = `${filler} 独有的词 ZEBRA-TOKEN 出现在这一段的末尾。`
  const md = ['## 长的一节 {#long}', '', paragraph, '', '## 下一节', '', '更多内容。'].join('\n')
  assert.ok(paragraph.length > 400, `这一段要长过 400 字：${paragraph.length}`)
  const r = renderMarkdown(md)
  const entries = searchEntriesOf(PAGE, r.blocks)
  const hit = entries.find((e) => e.x.includes('ZEBRA-TOKEN'))
  assert.ok(hit !== undefined, `第 401 字之后的词查不到：${JSON.stringify(entries.map((e) => e.x.length))}`)
  assert.equal(hit.s, '长的一节')
  assert.ok(hit.x.length > 400, `索引里的正文不许截断：${hit.x.length} 字`)
  assert.ok(r.html.includes(`id="${hit.b}"`), '命中落在页面里的内容块上')
  // 负对照：这个词确实不在前面 400 字里（否则这条断言抓不住“只搜开头”）
  assert.ok(!hit.x.slice(0, 400).includes('ZEBRA-TOKEN'))
  console.log(`③ 读数：命中在 ${hit.x.indexOf('ZEBRA-TOKEN')} 字处 · 索引片段 ${hit.x.length} 字 · 块 ${hit.b}`)
})

test('④ 折叠内容与非默认标签里的命中：各有一条内容块 id，页面里真有那个块', () => {
  const md = [
    '## 一节 {#one}',
    '',
    '::: details 藏在里面',
    '',
    '折叠里的独有词 FOLDED-TOKEN。',
    '',
    ':::',
    '',
    '::: tabs',
    '::: tab 第一次',
    '默认面板里的词。',
    ':::',
    '::: tab 已经用过',
    '第二个面板里的独有词 SECOND-TAB-TOKEN。',
    ':::',
    ':::',
  ].join('\n')
  const r = renderMarkdown(md)
  const entries = searchEntriesOf(PAGE, r.blocks)
  const folded = entries.find((e) => e.x.includes('FOLDED-TOKEN'))
  assert.ok(folded !== undefined)
  const detailsAt = r.html.indexOf('<details')
  const detailsEnd = r.html.indexOf('</details>')
  assert.ok(r.html.indexOf(`id="${folded.b}"`) > detailsAt && r.html.indexOf(`id="${folded.b}"`) < detailsEnd, '折叠里的块要带 id')
  const second = entries.find((e) => e.x.includes('SECOND-TAB-TOKEN'))
  assert.ok(second !== undefined)
  const panelAt = r.html.lastIndexOf('class="tabpanel"')
  assert.ok(r.html.indexOf(`id="${second.b}"`) > panelAt, '第二个面板里的块要带 id')
  console.log(`④ 读数：折叠块 ${folded.b} · 第二面板块 ${second.b}（揭示脚本展开全部祖辈）`)
})
