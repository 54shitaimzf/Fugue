// 查找索引：**切法与渲染器同源**（标题表由 `renderMarkdown` 交回来），嵌进页面的 JSON 不许
// 反过来伤到页面本身。两件事各一条断言：围栏里的 `#` 不是标题；索引里的 `<` 不许出现。
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
  const entries = searchEntriesOf(PAGE, md, r.headings)
  const two = entries.filter((e) => e.s === '第二节')
  assert.equal(two.length, 1, JSON.stringify(entries))
  assert.equal(two[0]!.h, 'two', '第二节的命中要指向自己的锚点')
  assert.ok(!entries.some((e) => e.s.includes('shell 注释')), '注释不该成节')
  assert.ok(entries.some((e) => e.h === 'one'))
  console.log(`① 读数：${entries.length} 条 · 第二节锚点 ${two[0]!.h}`)
})

test('② 索引 JSON 里一个 `<` 都没有：`</script>` 与 `<!--`+`<script` 两类口子一起堵', () => {
  const json = searchIndexJson([
    { p: 'start.html', t: '开始', s: '节', h: 'x', x: 'a </script> b <!-- c <script> d' },
  ])
  assert.ok(!json.includes('<'), json)
  const back = JSON.parse(json) as { x: string }[]
  assert.equal(back[0]!.x, 'a </script> b <!-- c <script> d', '解析回来还是原文')
  console.log('② 读数：JSON 里 0 个 `<` · 原文往返一致')
})
