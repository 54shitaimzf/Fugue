// markdown 子集 · 公共呈现的正文那一半：**结构对、地址稳、兑不掉的说出来**。
//
// 判据来自交接单 § 2.1：链接是真实链接、章节有稳定 ID、展开入口写清内容、主结论不在折叠里；
// § 2.6：宿主校验"引用是否可达、操作是否成立"；以及"无法兑现的表达如实说明并保留完整可读内容"。
//
// **两条抓内容的断言在最后**（⑭ 上手页六步与五条命令 · ⑮ 七份真实正文的每一段可读文字都有着落）：
// 1583 条断言全绿与"这一页丢了五步"曾经同时成立，缺的正是这一条——拿真实正文当输入。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { escapeHtml, plainInline, renderMarkdown, slugOf } from './markdown.ts'

const resolve = (raw: string): { href: string } => ({ href: raw })

const CONTENT_DIR = new URL('../../test/fixtures/docs-content/', import.meta.url)

function bodyOf(name: string): string {
  return readFileSync(new URL(name, CONTENT_DIR), 'utf8')
}

/** 页面里的可读文字：去掉脚本与样式，标签折成空格，实体解回来，空白并成一个。 */
function visibleOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, '')
}

/**
 * 一份正文里"读者应该能读到的每一段文字"。
 *
 * 它从**同一套标记**出发：围栏里的每一行是原文，其余行去掉标题/列表/引用/表格分隔/块的标记，
 * 再用 `plainInline`（渲染器自己那一处）剥行内标记。于是这条断言量与的是"字还在不在"，
 * 不是"标签长什么样"。
 */
function readableOf(md: string): string[] {
  const out: string[] = []
  let fence = false
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    if (/^\s*```/.test(line)) {
      fence = !fence
      continue
    }
    if (fence) {
      if (line.trim() !== '') out.push(line)
      continue
    }
    const t = line.trim()
    if (t === '' || /^:::\s*$/.test(t)) continue
    const open = /^:::\s*[a-z][a-z0-9-]*\s*(.*)$/.exec(t)
    if (open !== null) {
      if ((open[1] ?? '').trim() !== '') out.push(open[1]!.trim())
      continue
    }
    if (t.startsWith('|') && /^[\s:|-]+$/.test(t)) continue // 表格分隔行
    if (t.startsWith('|')) {
      for (const cell of t.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)) {
        if (cell.trim() !== '') out.push(cell.trim().replace(/\\\|/g, '|'))
      }
      continue
    }
    out.push(t.replace(/^#{1,6}\s+/, '').replace(/^\s*([-*]|\d+\.)\s+/, '').replace(/^>\s?/, ''))
  }
  return out
    .map((s) => plainInline(s).replace(/\s+/g, ''))
    .filter((s) => s.length >= 8)
}

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
  // 标题里的行内标记：正文里渲染成 <code>，标题表里是纯文字（目录与查找拿它显示）
  const span = renderMarkdown('## 三个 `.fugue` 不是同一个目录')
  assert.equal(span.headings[0]?.text, '三个 .fugue 不是同一个目录')
  assert.ok(span.html.includes('<code>.fugue</code>'), '标题自己仍渲染行内代码')
  console.log(`① 读数：${r.headings.map((h) => `${h.level}:${h.id}`).join(' · ')} · 标题表纯文字`)
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

test('③ 表格与列表：结构、对齐、嵌套各就各位（块 id 落在容器上，不挡选择器）', () => {
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
  assert.ok(/<ul[^>]*><li>第一<ul[^>]*><li>嵌套<\/li><\/ul><\/li><li>第二<\/li><\/ul>/.test(r.html), r.html)
  assert.ok(/<ol[^>]*><li>一步<\/li><li>两步<\/li><\/ol>/.test(r.html))
  console.log('③ 读数：表头 2 列 · 嵌套列表一层 · 有序列表 · 三块各有 id')
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
  assert.ok(/<div class="callout note"[^>]*><p class="callout-title">前置条件<\/p>/.test(r.html), r.html)
  assert.ok(/<details[^>]*>\s*<summary>完整参数表<\/summary>/.test(r.html), '原生展开，不靠脚本')
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

test('⑧ 标签的简写：每个 tab 不各写收尾也读得懂；后面每一节仍在标签之外（实测遇到的写法）', () => {
  const md = [
    '::: tabs',
    '::: tab 甲',
    '内容甲',
    '::: tab 乙',
    '内容乙',
    '::: tab 丙',
    '内容丙',
    ':::',
    '',
    '## 后面的节',
    '',
    '这一节必须看得见。',
  ].join('\n')
  const r = renderMarkdown(md)
  assert.equal((r.html.match(/class="tabpanel"/g) ?? []).length, 3, r.html)
  for (const t of ['内容甲', '内容乙', '内容丙']) assert.ok(r.html.includes(t))
  const after = r.html.slice(r.html.indexOf('</div>') + 6)
  assert.ok(after.includes('id="后面的节"') || after.includes('后面的节'), '后面那一节要在标签之外')
  assert.ok(r.html.indexOf('这一节必须看得见。') > r.html.lastIndexOf('class="tabpanel"'), '不在面板里')
  assert.ok(r.notes.some((n) => n.includes('收住')), '收在哪儿要说出来')
  console.log(`⑧ 读数：3 个面板 · 后续节在标签外 · note：${r.notes.join(' / ')}`)
})

test('⑨ 图片兜底：能外链的印成链接，`javascript:`/`data:` 只留文字（正文里唯一一处把源串放进 href 的地方）', () => {
  const r = renderMarkdown('![说](javascript:alert%281%29) ![图](data:text/html;base64,PHg+) ![外](https://example.com/a.png)', {
    resolve: () => null,
  })
  assert.ok(!r.html.includes('javascript:'), r.html)
  assert.ok(!r.html.includes('data:text/html'), r.html)
  assert.ok(r.html.includes('https://example.com/a.png'), 'http(s) 仍是链接')
  assert.equal((r.html.match(/<a /g) ?? []).length, 1, '只有那一条外链成了 <a>')
  assert.ok(r.html.includes('说') && r.html.includes('图'), '兑不掉的图仍留着说明文字')
  assert.ok(r.notes.filter((n) => n.includes('已印成纯文字')).length === 2, r.notes.join(' | '))
  console.log(`⑨ 读数：${r.notes.length} 条 note · javascript/data 未成 href · https 成链接`)
})

test('⑩ 表格：`\\|` 是一个竖线不是列边界；比表头多的格并进末格并记 note（原先静默丢字）', () => {
  const r = renderMarkdown(['| 版本 | 说明 | 影响 |', '| --- | --- | --- |', '| 0.2.1 | `[all\\|fast\\|real]` 三档 | 无 |', '| 0.2.2 | 多一列 | 这里 | 还有这里 |'].join('\n'))
  assert.ok(r.html.includes('all|fast|real'), r.html)
  assert.ok(r.html.includes('<td>无</td>'), '第三列要在')
  assert.ok(r.html.includes('还有这里'), '多出来的字不许丢')
  assert.ok(r.notes.some((n) => n.includes('多 1 格')), r.notes.join(' | '))
  console.log(`⑩ 读数：转义竖线成字 · 末列在 · note：${r.notes.join(' / ')}`)
})

test('⑪ 列表项里的围栏是块：命令原样、围栏标记不漏；容器里的围栏不被 `:::` 与 `##` 提前截断', () => {
  const li = renderMarkdown(['1. 进项目、把工作记录挡在提交之外：', '   ```sh', '   echo .fugue/ >> .git/info/exclude', '   ```', '   没有输出就是对了。'].join('\n'))
  assert.ok(li.html.includes('<pre><code class="language-sh">echo .fugue/ &gt;&gt; .git/info/exclude</code></pre>'), li.html)
  assert.ok(!li.html.includes('```'), '围栏标记不该出现')
  assert.ok(!li.html.includes('`'), '没有落单的反引号')
  assert.ok(li.html.indexOf('没有输出') > li.html.indexOf('</code></pre>'), '围栏后面的文字在块之后')
  const box = renderMarkdown(['::: note 说明', '```', '::: tip 这是代码', '## 不是标题', '```', ':::', '', '## 后面'].join('\n'))
  assert.ok(box.html.includes('::: tip 这是代码'), '围栏里的块标记是内容')
  assert.ok(!box.html.includes('不是标题</h2>'), '围栏里的 ## 不成标题')
  assert.equal(box.notes.length, 0, `不该有 note：${box.notes.join(' | ')}`)
  assert.ok(box.html.includes('id="后面"'), '块后面照常读')
  console.log('⑪ 读数：列表内围栏成块 · 无反引号漏出 · 容器内围栏不截断 · 后面照常')
})

test('⑫ 转义的反引号：不参与配对，整句仍是一个代码段；落单的印成“反引号字符”的代码段', () => {
  const r = renderMarkdown('形如 `编号 \\`T1\\` – \\`T19\\`` 的声明，单个 \\` 号也认。')
  assert.ok(r.html.includes('<code>编号 `T1` – `T19`</code>'), r.html)
  assert.ok(r.html.includes('<code>`</code>'), '落单的转义反引号印成代码段')
  // 可见文字（去掉标签）里不留裸反引号
  const text = r.html.replace(/<[^>]+>/g, '')
  assert.ok(!text.includes('\\`'), '反斜杠不该漏进正文')
  console.log('⑫ 读数：代码段里 3 个字面反引号 · 落单的 1 个 · 反斜杠 0')
})

test('⑬ 没写收尾的 details 不许把后面整页藏起来（退化档：收在下一个二级标题之前）', () => {
  const r = renderMarkdown(['::: details 细节', '藏在里面', '', '## 后面', '', '正文还在。'].join('\n'))
  const at = r.html.indexOf('<details')
  const d = r.html.slice(at, r.html.indexOf('</details>') + 10)
  assert.ok(d.includes('藏在里面'))
  assert.ok(!d.includes('正文还在。'), '后面的正文不许被吞进 details')
  assert.ok(r.html.includes('正文还在。'))
  console.log(`⑬ 读数：details 只包住自己那一段 · note：${r.notes.join(' / ')}`)
})

test('⑭ 上手页：六个步骤与五条命令都在页面里（拿当前正文当固定输入，复审 R1 的负对照）', () => {
  const md = bodyOf('start.md')
  const r = renderMarkdown(md)
  const steps = r.html.match(/class="step"/g) ?? []
  assert.equal(steps.length, 6, `上手页要有 6 步，页面里只有 ${steps.length} 步`)
  // 一条 `::: steps` 包成一张有序列表（六个"1."不各自从头数）
  const stepsAt = r.html.indexOf('<div class="steps"')
  const stepsBox = r.html.slice(stepsAt, r.html.indexOf('</div>', stepsAt))
  assert.equal((stepsBox.match(/<ol/g) ?? []).length, 1, '六步要在同一张有序列表里')
  assert.equal((stepsBox.match(/class="step"/g) ?? []).length, 6, '同一张列表里六项')
  for (const cmd of [
    'fugue config set actions.test',
    'fugue config set round.id r1',
    'fugue round plan',
    'fugue round go',
    'fugue round work --live --max-steps 8',
  ]) {
    assert.ok(r.html.includes(escapeHtml(cmd)), `页面上找不到这条命令：${cmd}`)
  }
  console.log(`⑭ 读数：${steps.length} 步 · 五条命令都在 · 页面 ${r.html.length} 字符`)
})

test('⑮ 七份真实正文：每一段可读文字都在页面或 notes 里（不是只数反引号）', () => {
  const names = readdirSync(CONTENT_DIR).filter((n) => n.endsWith('.md')).sort()
  assert.equal(names.length, 7, `固定材料要有七份：${names.join(' · ')}`)
  let total = 0
  for (const name of names) {
    const md = bodyOf(name)
    const r = renderMarkdown(md)
    const page = visibleOf(r.html)
    const notes = visibleOf(r.notes.join('\n'))
    const missing = readableOf(md).filter((seg) => !page.includes(seg) && !notes.includes(seg))
    total += readableOf(md).length
    assert.deepEqual(missing, [], `${name} 里有 ${missing.length} 段文字在页面与 notes 里都找不到：${missing.slice(0, 5).join(' | ')}`)
  }
  console.log(`⑮ 读数：7 份 · ${total} 段可读文字全部有着落`)
})

test('⑯ 内容块与宿主控件各占各的命名空间：`content`/`doc-*` 撞不上，重名不产生两个同名 id', () => {
  const md = [
    '## content {#content}',
    '',
    '正文甲。这一段要够长才不触发别的东西。',
    '',
    '## x',
    '',
    '正文乙。',
    '',
    '## x',
    '',
    '正文丙。',
    '',
    '## x-2',
    '',
    '正文丁。',
  ].join('\n')
  const r = renderMarkdown(md, { reserved: ['content', 'doc-search', 'doc-q'] })
  const ids = [...r.html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])
  assert.equal(new Set(ids).size, ids.length, `id 撞了：${ids.join(' · ')}`)
  assert.ok(!ids.includes('content'), '正文不许占宿主控件的 id')
  // 三个都叫 x 的标题 + 一个 x-2：四个请求名落成四个不同 id（不是两个 x-2）
  const xIds = r.headings.filter((h) => h.text === 'x' || h.text === 'x-2').map((h) => h.id)
  assert.equal(new Set(xIds).size, xIds.length, `重名去重要真的去重：${xIds.join(' · ')}`)
  assert.equal(xIds.length, 3, `三个标题（x · x · x-2）各一个 id：${xIds.join(' · ')}`)
  console.log(`⑯ 读数：${ids.length} 个 id 全不重复 · content 让给宿主 · x 一族 ${xIds.join('/')}`)
})

test('⑰ 列表项里的围栏隔着空行也是块：围栏标记不漏进正文（真生成里露过一次）', () => {
  const md = [
    '::: steps',
    '1. **第一步**：先看树。',
    '',
    '   ```sh',
    '   git status --porcelain',
    '   ```',
    '',
    '   有输出就先提交。',
    '',
    '2. **第二步**：再跑测试。',
    '',
    '   ```sh',
    '   node tools/test-entry.js',
    '   ```',
    ':::',
  ].join('\n')
  const r = renderMarkdown(md)
  assert.equal(r.html.includes('```'), false, '页面里不该出现围栏标记（原先三步拼成一句）')
  assert.ok(r.html.includes('<code class="language-sh">git status --porcelain</code>'), '空行之后的围栏要按块渲染')
  assert.ok(r.html.includes('有输出就先提交。'), '空行之后的第二段仍在')
  assert.equal((r.html.match(/class="step"/g) ?? []).length, 2)
  console.log('⑰ 读数：2 步 · 两处空行之后的围栏都成了代码块')
})

test('⑱ 容器整块消费：steps 里列表前后的正文与代码块都在（不是只取第一个列表）', () => {
  const md = ['::: steps', '先看这一段说明，它也是容器里的内容。', '', '1. 一步', '   ```sh', '   echo hi', '   ```', '', '2. 两步', '', '收尾这一段也要在。', ':::'].join('\n')
  const r = renderMarkdown(md)
  assert.ok(r.html.includes('先看这一段说明，它也是容器里的内容。'), '列表之前的正文要在')
  assert.ok(r.html.includes('收尾这一段也要在。'), '列表之后的正文要在')
  assert.ok(r.html.includes('echo hi'), '列表项里的代码块要在')
  assert.equal((r.html.match(/class="step"/g) ?? []).length, 2)
  console.log('⑱ 读数：2 步 · 列表前后正文与代码块都在')
})
