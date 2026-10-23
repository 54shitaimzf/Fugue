// 产物级：**七份真实正文 → 一批真产物 → 只对着产物判**（升级计划 § 阶段 6）。
//
// 这一层管的是"读者拿到的那些文件对不对"：清单与文件一致（`check-docs` 四组）· 查找命中落到
// 内容块 · 步骤数与正文一致 · 关掉脚本仍读得到。原来散在 build/page/search 三处的产物断言
// 收到这里，各层只留自己那一半（纯函数与运行期的闸）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { commitFiles, tmpRepo } from './helpers/docs-repo.ts'
import { buildDocs } from '../src/docs/build.ts'
import { docsRootOf } from '../src/docs/contract.ts'
import type { DocCaller, DocsPlan } from '../src/docs/contract.ts'
import { parseDocs } from '../src/docs/config.ts'
import { openTruth } from '../src/truth/truth.ts'
import type { ConfigDoc } from '../src/config.ts'

const CONTENT = new URL('./fixtures/docs-content/', import.meta.url)
const NAMES = ['start', 'architecture', 'targets', 'roadmap', 'rationale', 'develop', 'changelog']

function bodyOf(name: string): string {
  return readFileSync(new URL(`${name}.md`, CONTENT), 'utf8')
}

function config(): ConfigDoc {
  return {
    docs: {
      theme: 'primer',
      title: 'Fugue',
      pages: NAMES.map((id) => ({ id, title: `第 ${id} 页`, source: `doc/${id}.md`, audience: '读者', role: '读懂这一块', prompt: '讲清楚' })),
    },
  }
}

/** 假模型：取证一律不点名（产物级不考读取），正文按定义里的 id 给固定夹具。 */
function fake(): DocCaller {
  return {
    model: 'fake/model',
    wireModel: 'fake',
    facts: { id: 'fake/model', wireModel: 'fake', thinking: 'high', temperature: null, maxTokens: 8192, contextLimit: 1048576 },
    async call(req) {
      if (req.context.includes('只输出一个 JSON 对象')) return { text: '{"paths":[]}', usage: null }
      const id = /文档 id：([^\n]+)/.exec(req.context)?.[1]?.trim() ?? 'start'
      return { text: bodyOf(id), usage: null }
    },
  }
}

async function built(): Promise<{ dir: string; plan: DocsPlan }> {
  const root = tmpRepo()
  const files: Record<string, string> = { 'package.json': JSON.stringify({ name: 'fugue', version: '1.2.3' }) }
  for (const id of NAMES) files[`doc/${id}.md`] = `# ${id}\n\n来源。\n`
  const truth = openTruth(root)
  const commit = await commitFiles(root, files, [], 'refs/heads/main')
  const plan = parseDocs(config())
  assert.ok(plan !== null)
  const out = await buildDocs({ root, config: config(), truth, caller: fake(), materials: { kind: 'manual', note: '产物级' }, at: String(commit), now: () => new Date('2026-10-22T00:00:00.000Z') })
  truth.close()
  assert.ok(out.ok, JSON.stringify(out))
  return { dir: docsRootOf(root), plan }
}

const html = (dir: string, name: string): string => readFileSync(join(dir, `${name}.html`), 'utf8')

/** 去掉脚本与样式之后，页面上还读得到的文字。 */
function textOnly(page: string): string {
  return page
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
}

test('① `check-docs` 四组全过：清单 · 批次 · 地址 · 自足（七份真实正文）', async () => {
  const { dir } = await built()
  const r = spawnSync('node', ['tools/check-docs.js', dir], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(r.stdout.includes('全部通过'), r.stdout.slice(-800))
  console.log(`① 读数：${NAMES.length} 页 · check-docs 全部通过`)
})

test('② 查找：每页内嵌索引可解析，命中都落到页里的内容块（不是死锚点）', async () => {
  const { dir } = await built()
  let entries = 0
  for (const name of NAMES) {
    const page = html(dir, name)
    const m = /<script type="application\/json" id="doc-index">([\s\S]*?)<\/script>/.exec(page)
    assert.ok(m !== null, `${name}：索引块要在`)
    const all = JSON.parse(m[1]!) as { p: string; s: string; h: string; b: string; x: string }[]
    const list = all.filter((e) => e.p === `${name}.html`)
    assert.ok(list.length > 0, `${name}：索引里要有这一页的命中`)
    for (const e of list) {
      assert.equal(e.b === '', false, `${name}：命中要有内容块 id`)
      assert.ok(page.includes(`id="${e.b}"`), `${name}：命中 ${e.b} 指不到页面里的块`)
    }
    entries += list.length
  }
  // 真查一次：develop 夹具里的独特词要查得到，且落在那一节上
  const develop = html(dir, 'develop')
  const index = JSON.parse(/<script type="application\/json" id="doc-index">([\s\S]*?)<\/script>/.exec(develop)![1]!) as { p: string; s: string; b: string; x: string }[]
  const hit = index.find((e) => e.p === 'develop.html' && e.x.includes('normMode'))
  assert.ok(hit !== undefined, '独特词查不到')
  assert.ok(develop.includes(`id="${hit.b}"`), '命中的内容块要在页面里')
  console.log(`② 读数：${NAMES.length} 页共 ${entries} 条命中 · normMode 落在「${hit.s}」`)
})

test('③ 步骤数：`::: steps` 里几项，页面里就几个 step（不多不少）', async () => {
  const { dir } = await built()
  const md = bodyOf('develop')
  const block = /::: steps\r?\n([\s\S]*?)\r?\n:::/.exec(md)?.[1] ?? ''
  const want = block.split('\n').filter((line) => /^\d+\.\s/.test(line)).length
  assert.ok(want > 0, '夹具里要有 steps 这一块')
  const page = html(dir, 'develop')
  assert.equal((page.match(/class="step"/g) ?? []).length, want, `正文 ${want} 步，页面里对不上`)
  console.log(`③ 读数：${want} 步 · 页面与正文一致`)
})

test('④ 无 JS 仍可读：去掉脚本与样式，正文、目录与展开的摘要都还在', async () => {
  const { dir } = await built()
  for (const name of NAMES) {
    const page = html(dir, name)
    assert.ok(page.includes('<noscript><p class="nojs-note">'), `${name}：没有脚本时的说明`)
    assert.ok(/<details[^>]*>/.test(page), `${name}：展开是原生的`)
    const text = textOnly(page)
    // 正文里的一段真话（夹具的第一节标题）去掉标签之后仍读得到
    const firstHeading = /^## (.+)$/m.exec(bodyOf(name))?.[1] ?? ''
    const plain = firstHeading.replace(/\s*\{#[\w-]+\}\s*$/, '').trim()
    assert.ok(text.includes(plain), `${name}：去掉脚本后读不到「${plain}」`)
  }
  console.log(`④ 读数：${NAMES.length} 页 · noscript · 原生展开 · 正文都在`)
})
