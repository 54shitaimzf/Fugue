// 文档定义那一层：**能拿来生成的计划**，以及"写错当场拒、指出该改的那一格"。
//
// 判据来自交接单 § 2.3：人改定义就能改一份文档的读者与职责；配置写错当场拒绝并指出该改的
// 那一格；来源在本次提交里缺失时报出是哪一份、哪一条路径（后半条在 `facts.test.ts`）。
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConfigDoc } from '../config.ts'
import { docsOf, outOf, pageOf, parseDocs } from './config.ts'
import { DocsError } from './contract.ts'

/** 一份最小的合法配置：一份文档、缺省主题。 */
function base(): ConfigDoc {
  return {
    docs: {
      theme: 'primer',
      pages: [
        {
          id: 'start',
          title: '开始',
          source: 'README.md',
          audience: '第一次用的人',
          role: '从安装到跑通第一条命令',
          prompt: '先给最短路径，再给边界',
        },
      ],
    },
  }
}

/** 改一格：把点分路径写成数组（`['docs','pages',0,'source']`）。 */
function poke(doc: ConfigDoc, path: readonly (string | number)[], value: unknown): ConfigDoc {
  const copy = structuredClone(doc) as Record<string, unknown>
  let cur: Record<string, unknown> = copy
  for (const seg of path.slice(0, -1)) cur = (Array.isArray(cur) ? cur[Number(seg)] : cur[String(seg)]) as Record<string, unknown>
  cur[String(path[path.length - 1])] = value
  return copy
}

/** 一次失败：必须抛 `DocsError`，话里带点分键，并指明"该改的那一格"。 */
function rejects(doc: ConfigDoc, cell: string): string {
  assert.throws(
    () => parseDocs(doc),
    (err: unknown) => {
      assert.ok(err instanceof DocsError, `要抛 DocsError，拿到 ${String(err)}`)
      assert.equal(err.at, 'config')
      assert.ok(err.message.includes(cell), `话里要点名 ${cell}：${err.message}`)
      assert.ok(err.message.includes('该改的那一格'), `话里要指路：${err.message}`)
      return true
    },
  )
  return cell
}

test('① `docs` 不在 = 能力未启用（null），不是"一份空计划"', () => {
  assert.equal(docsOf({}), undefined)
  assert.equal(parseDocs({}), null)
  // 负对照：`docs` 在了却一份都没有，是**写错了**，不是没启用。
  assert.throws(() => parseDocs({ docs: { pages: [] } }), (err: unknown) => err instanceof DocsError)
  console.log('① 读数：无 docs → null；docs.pages 空数组 → DocsError（两者分开）')
})

test('② 合法计划：缺省主题与产物文件名由一处给，字段原样读到', () => {
  const plan = parseDocs({ docs: { pages: (base().docs as { pages: unknown[] }).pages } })
  assert.ok(plan !== null)
  assert.equal(plan.theme, 'primer', '不写 theme 就是缺省那套')
  assert.equal(plan.pages[0]?.out, outOf('start'))
  assert.equal(plan.model, undefined)
  const full = parseDocs(base())
  assert.ok(full !== null)
  assert.deepEqual(
    { id: full.pages[0]?.id, title: full.pages[0]?.title, source: full.pages[0]?.source, out: full.pages[0]?.out },
    { id: 'start', title: '开始', source: 'README.md', out: 'start.html' },
  )
  assert.equal(pageOf(full, 'start').title, '开始')
  console.log(`② 读数：theme=${full.theme} · pages=${full.pages.length} · out=${full.pages[0]?.out}`)
})

test('③ 写错一格当场拒：主题 · 来源 · id · 产物名 · 未知键 · 重名', () => {
  const cases: { doc: ConfigDoc; cell: string }[] = [
    { doc: poke(base(), ['docs', 'theme'], 'nonexistent'), cell: 'docs.theme' },
    { doc: poke(base(), ['docs', 'pages', 0, 'source'], '/etc/passwd'), cell: 'docs.pages[0].source' },
    { doc: poke(base(), ['docs', 'pages', 0, 'source'], '../outside.md'), cell: 'docs.pages[0].source' },
    { doc: poke(base(), ['docs', 'pages', 0, 'id'], 'Start Page'), cell: 'docs.pages[0].id' },
    { doc: poke(base(), ['docs', 'pages', 0, 'out'], 'index.html'), cell: 'docs.pages[0].out' },
    { doc: poke(base(), ['docs', 'pages', 0, 'out'], 'javascript:alert(1).html'), cell: 'docs.pages[0].out' },
    { doc: poke(base(), ['docs', 'pages', 0, 'out'], 'guide#part.html'), cell: 'docs.pages[0].out' },
    { doc: poke(base(), ['docs', 'pages', 0, 'out'], 'guide?x.html'), cell: 'docs.pages[0].out' },
    { doc: poke(base(), ['docs', 'pages', 0, 'audience'], ''), cell: 'docs.pages[0].audience' },
    { doc: poke(base(), ['docs', 'pagse'], []), cell: 'docs.pagse' },
    { doc: poke(base(), ['docs', 'pages', 0, 'soruce'], 'README.md'), cell: 'docs.pages[0].soruce' },
  ]
  const hit = cases.map((c) => rejects(c.doc, c.cell))
  // 重名那一条要两份定义，单独拼。
  const two = structuredClone(base()) as { docs: { pages: { id: string }[] } }
  two.docs.pages.push({ ...two.docs.pages[0]! })
  rejects(two as ConfigDoc, 'docs.pages[1].id')
  // 负对照：同一份配置把那一格改对，就解析得过——失败来自那一格，不是整份配置。
  const fixed = poke(base(), ['docs', 'theme'], 'carbon') as ConfigDoc
  assert.equal(parseDocs(fixed)?.theme, 'carbon')
  console.log(`③ 读数：${hit.length} 种写错各点名一格，改对那一格即通过 —— ${hit.join(' · ')}`)
})

test('④ 目录里的主题都在，写错时话里列全（模型不会去猜"还有没有别的"）', () => {
  const good = ['primer', 'carbon', 'material3', 'govuk'].map((theme) => {
    const doc = poke(base(), ['docs', 'theme'], theme)
    return parseDocs(doc)?.theme
  })
  assert.deepEqual(good, ['primer', 'carbon', 'material3', 'govuk'])
  assert.throws(
    () => parseDocs(poke(base(), ['docs', 'theme'], 'bootstrap')),
    (err: unknown) => err instanceof DocsError && ['primer', 'carbon', 'material3', 'govuk'].every((t) => err.message.includes(t)),
  )
  console.log(`④ 读数：${good.join(' · ')} 四套都解析得出；未知主题的报错列全四套`)
})

test('⑤ 产物名要能被浏览器当路径原样打开：`#` / `?` 一律拒（要么拒、要么在地址那一处编码）', () => {
  // **配置收下的每一个输出名，都能经目录链接打开**：这里拿 URL 解析验一遍（浏览器的判据）。
  const names = ['start.html', 'start-v2.html', 'Part_2.final.html']
  for (const name of names) {
    const plan = parseDocs(poke(base(), ['docs', 'pages', 0, 'out'], name))
    assert.equal(plan?.pages[0]?.out, name)
    const url = new URL(name, 'file:///tmp/docs/index.html')
    assert.equal(url.pathname.endsWith(`/${name}`), true, `${name} 经 URL 解析后不再指向同一个文件：${url.href}`)
    assert.equal(url.hash, '', '不能读出片段')
    assert.equal(url.search, '', '不能读出查询')
  }
  // 负对照：带 `#` / `?` 的名字要是被收下，上一条就是死链。
  for (const bad of ['guide#part.html', 'guide?x.html', 'a b.html']) {
    assert.throws(
      () => parseDocs(poke(base(), ['docs', 'pages', 0, 'out'], bad)),
      (err: unknown) => err instanceof DocsError && err.message.includes('docs.pages[0].out'),
      bad,
    )
  }
  console.log(`⑤ 读数：${names.length} 个名字 URL 解析后不变 · ${3} 个带片段/查询/空格的名字当场拒`)
})

test('⑥ `docs.read`：不写就是两趟；写错当场拒，话里列出带进来的两种', () => {
  assert.equal(parseDocs(base())?.read, 'two-pass')
  assert.equal(parseDocs(poke(base(), ['docs', 'read'], 'loop'))?.read, 'loop')
  assert.throws(
    () => parseDocs(poke(base(), ['docs', 'read'], 'loop!')),
    (err: unknown) => {
      assert.ok(err instanceof DocsError, `要抛 DocsError，拿到 ${String(err)}`)
      assert.equal(err.at, 'config')
      assert.ok(err.message.includes('docs.read'), err.message)
      assert.ok(err.message.includes('two-pass') && err.message.includes('loop'), `话里要列出两种策略：${err.message}`)
      return true
    },
  )
  console.log('⑥ 读数：缺省 two-pass · 写集为 loop · 写错当场拒')
})
