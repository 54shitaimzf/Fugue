// 一次生成 · 整批替换 · 状态：**旧批次在失败时一个字节都不动**。
//
// 判据来自交接单 § 3.2（整批替换）· § 3.3（清单与指纹 · 最近一次单独归属）· § 3.5（状态与失败）·
// § 6.1 第 6、7 条（中断与失败归属）。这一份用假模型（`DocCaller` 的接缝）验流程与归属；
// 真实 API 那一趟的读数在停点材料的验收一节，两处不互相代替。
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { commitFiles, tmpRepo } from '../../test/helpers/docs-repo.ts'
import { openTruth } from '../truth/truth.ts'
import { buildDocs } from './build.ts'
import type { BuildOutcome, DocCaller, ModelFacts } from './contract.ts'
import { DocsError, docsRootOf } from './contract.ts'
import { parseDocs } from './config.ts'
import { statusOf } from './status.ts'
import type { ConfigDoc } from '../config.ts'

const PAGES = [
  { id: 'start', title: '开始', source: 'README.md', audience: '第一次用的人', role: '跑通第一条命令', prompt: '最短路径' },
  { id: 'arch', title: '架构', source: 'design/A.md', audience: '维护者', role: '理解边界', prompt: '讲约束' },
]

function configWith(o: { prompt?: string; pages?: typeof PAGES; theme?: string; title?: string; maxTokens?: number } = {}): ConfigDoc {
  return {
    docs: {
      theme: o.theme ?? 'primer',
      ...(o.title === undefined ? {} : { title: o.title }),
      ...(o.maxTokens === undefined ? {} : { maxTokens: o.maxTokens }),
      pages: (o.pages ?? PAGES).map((p) => (p.id === 'start' && o.prompt !== undefined ? { ...p, prompt: o.prompt } : p)),
    },
  }
}

function bodyOf(id: string): string {
  return [
    `## ${id} 的正文 {#${id}-top}`,
    '',
    '这一段说明这一页要解决的问题，以及读者能从这里得到什么。'.repeat(12),
    '',
    `依据在 \`README.md\` 里；边界见 \`design/A.md\`。`,
    '',
    '## 下一节',
    '',
    '更多内容。'.repeat(30),
  ].join('\n')
}

interface FakeOptions {
  readonly content?: (id: string) => string
  readonly failOn?: string
  readonly evidencePaths?: string[]
  readonly rangeAsks?: { path: string; from: number; to: number }[]
  readonly failEvidence?: boolean
  readonly facts?: Partial<ModelFacts>
}

/** 夹具的模型声明：换思考档要能改指纹，换“凭据”（不在这一份里）不能。 */
const FAKE_FACTS: ModelFacts = {
  id: 'fake/model',
  wireModel: 'fake',
  thinking: 'high',
  temperature: 0.2,
  maxTokens: 8192,
  contextLimit: 1048576,
}

/** 假模型：按 `文档 id：<id>` 认出这一趟是哪一页；三趟用系统提示词区分。 */
function fakeCaller(o: FakeOptions = {}): { caller: DocCaller; calls: { kind: 'evidence' | 'ranges' | 'content'; id: string }[]; contexts: string[] } {
  const calls: { kind: 'evidence' | 'ranges' | 'content'; id: string }[] = []
  const contexts: string[] = []
  const caller: DocCaller = {
    model: 'fake/model',
    wireModel: 'fake',
    thinking: 'high',
    facts: { ...FAKE_FACTS, ...o.facts },
    async call(req) {
      const id = /文档 id：([^\n]+)/.exec(req.context)?.[1]?.trim() ?? '?'
      const kind = req.system.includes('只输出一个 JSON 对象') ? (req.system.includes('补读取证') ? 'ranges' : 'evidence') : 'content'
      calls.push({ kind, id })
      if (kind === 'evidence') {
        if (o.failEvidence === true) throw new DocsError('model', '取证这一趟没成（夹具）')
        return {
          text: JSON.stringify({ paths: o.evidencePaths ?? ['README.md'] }),
          usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: null, model: null },
        }
      }
      if (kind === 'ranges') {
        return { text: JSON.stringify({ ranges: o.rangeAsks ?? [] }), usage: { inputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: null, model: null } }
      }
      contexts.push(req.context)
      if (o.failOn === id) throw new DocsError('model', `模型没写完（夹具：${id}）`)
      return {
        text: o.content === undefined ? bodyOf(id) : o.content(id),
        usage: { inputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: null, model: null },
      }
    },
  }
  return { caller, calls, contexts }
}

const STATUS_MODEL: ModelFacts = { ...FAKE_FACTS }

/** 产物目录里每一份文件的字节（整批替换的对照表）。 */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) walk(p)
      else out.set(p, readFileSync(join(dir, p)).toString('base64'))
    }
  }
  walk('')
  return out
}

async function repo(o: { version?: string } = {}): Promise<{ root: string; commit: string; truth: ReturnType<typeof openTruth> }> {
  const root = tmpRepo()
  const commit = await commitFiles(
    root,
    {
      'package.json': JSON.stringify({ name: 'demo', version: o.version ?? '1.2.3' }),
      'README.md': '# demo\n\n第一版说明。\n',
      'design/A.md': '# 架构\n\n边界。\n',
      'src/a.ts': 'export const a = 1\n',
    },
    [],
    'refs/heads/main',
  )
  return { root, commit, truth: openTruth(root) }
}

test('① 一次生成：两页正文 · 首页 · 清单（提交 · 版本 · 指纹 · 逐页取证）· 用量读数', async (ctx) => {
  const { root, commit, truth } = await repo()
  ctx.after(() => truth.close())
  const now = (): Date => new Date('2026-10-22T00:00:00.000Z')
  const { caller, calls } = fakeCaller({ evidencePaths: ['README.md', 'src/a.ts', 'nope.ts'] })
  const out = await buildDocs({ root, config: configWith(), truth, caller, materials: { kind: 'manual', note: '测试：按提交重建' }, now })
  assert.ok(out.ok, JSON.stringify(out))
  assert.equal(out.commit, String(commit))
  assert.equal(out.version, '1.2.3')
  assert.equal(out.usage.calls, 4, '两页 × 两趟')
  assert.equal(out.usage.inputTokens, 220)
  assert.equal(out.usage.cacheReadTokens, 80, '缓存读进合计（写作两页各 40）：原先汇总只加出入两项，把这一项丢了')

  const docs = docsRootOf(root)
  const manifest = JSON.parse(readFileSync(join(docs, 'manifest.json'), 'utf8'))
  assert.equal(manifest.commit, String(commit))
  assert.equal(manifest.pages.length, 2)
  assert.equal(manifest.theme, 'primer')
  assert.equal(manifest.model, 'fake/model')
  assert.deepEqual(Object.keys(manifest.modelFacts).sort(), ['contextLimit', 'id', 'maxTokens', 'temperature', 'thinking', 'wireModel'], '模型声明进清单（指纹的原料）')
  assert.equal(manifest.pages[0].evidence.ranges.length, 2, '真读到的每一份都记一行段，截断与否都记')
  assert.ok(manifest.pages[0].evidence.ranges.every((r: { truncated: boolean }) => r.truncated === false), '小文件是全文')
  assert.deepEqual(manifest.pages[0].dropped, [], '第一版没有旧地址')
  assert.match(manifest.fingerprint, /^sha256:[0-9a-f]{64}$/)
  assert.ok(manifest.files.some((f: { path: string }) => f.path === 'index.html'))
  assert.ok(manifest.files.some((f: { path: string }) => f.path === 'content/start.md'))
  // 取证：请求了三条（两条真、一条不在）——**不在的那条如实记下**
  assert.deepEqual(manifest.pages[0].evidence.found, ['README.md', 'src/a.ts'])
  assert.deepEqual(manifest.pages[0].evidence.missing, ['nope.ts'])
  // 正文里引用的路径进清单（"取证依据指得出来"）
  assert.deepEqual(manifest.pages[0].cited, ['README.md', 'design/A.md'])
  // 页脚带完整提交与指纹
  const page = readFileSync(join(docs, 'start.html'), 'utf8')
  assert.ok(page.includes(`<code>${String(commit)}</code>`))
  assert.ok(page.includes(manifest.fingerprint))
  assert.ok(page.includes('v1.2.3'))
  assert.equal(calls.filter((c) => c.kind === 'content').length, 2)
  const last = JSON.parse(readFileSync(join(root, '.fugue', 'docs-last.json'), 'utf8')) as { usage: { cacheReadTokens: number; cacheWriteTokens: number } }
  assert.equal(last.usage.cacheReadTokens, 80, '缓存读也要落到 last.json，下一次 `docs status` 才答得出“花了多少”')
  assert.equal(last.usage.cacheWriteTokens, 0, '写缓存那一栏照实记（没有断点时是 0）')
  console.log(`① 读数：${manifest.pages.length} 页 · ${calls.length} 次调用 · ${out.usage.inputTokens} 入 / ${out.usage.outputTokens} 出 · 指纹 ${manifest.fingerprint.slice(0, 20)}…`)
})

test('② 可复现：同一份状态生成两次，页面与清单（除生成时间）逐字节相同', async (ctx) => {
  const { root, truth } = await repo()
  ctx.after(() => truth.close())
  const fixed = (): Date => new Date('2026-10-22T00:00:00.000Z')
  const a = await buildDocs({ root, config: configWith(), truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.ok(a.ok)
  const first = snapshot(docsRootOf(root))
  const b = await buildDocs({ root, config: configWith(), truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.ok(b.ok)
  const second = snapshot(docsRootOf(root))
  assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort())
  for (const [k, v] of first) assert.equal(second.get(k), v, `变了：${k}`)
  assert.equal(a.fingerprint, b.fingerprint)
  console.log(`② 读数：${first.size} 份文件逐字节相同 · 指纹 ${a.fingerprint.slice(0, 20)}…`)
})

test('③ 指纹：换定义（prompt）或换提交都会过期；换主题也过期', async (ctx) => {
  const { root, truth, commit } = await repo()
  ctx.after(() => truth.close())
  const fixed = (): Date => new Date('2026-10-22T00:00:00.000Z')
  const base = await buildDocs({ root, config: configWith(), truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.ok(base.ok)
  const byPrompt = await buildDocs({ root, config: configWith({ prompt: '换一个重点' }), truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.ok(byPrompt.ok)
  assert.notEqual(byPrompt.fingerprint, base.fingerprint)
  const byTitle = await buildDocs({ root, config: configWith({ title: '另一个标题' }), truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.ok(byTitle.ok)
  assert.notEqual(byTitle.fingerprint, base.fingerprint, '标题进指纹（它出现在页首与首页）')
  const byBudget = await buildDocs({ root, config: configWith({ maxTokens: 8192 }), truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.ok(byBudget.ok)
  assert.notEqual(byBudget.fingerprint, base.fingerprint, '单页预算进指纹（它影响截断与否）')
  const byTheme = await buildDocs({ root, config: configWith(), theme: 'govuk', truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.ok(byTheme.ok)
  assert.notEqual(byTheme.fingerprint, base.fingerprint, '主题进指纹')
  const c2 = await commitFiles(root, { 'package.json': JSON.stringify({ name: 'demo', version: '1.2.4' }), 'README.md': '# demo\n\n第二版。\n', 'design/A.md': '# 架构\n\n边界。\n' }, [commit as never], 'refs/heads/main')
  const byCommit = await buildDocs({ root, config: configWith(), truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.ok(byCommit.ok)
  assert.notEqual(byCommit.fingerprint, base.fingerprint, '提交进指纹')
  assert.equal(byCommit.commit, String(c2))
  console.log(`③ 读数：base ${base.fingerprint.slice(9, 21)} · 改定义/标题/预算/主题/提交后指纹都不同`)
})

test('④ 失败归属：第二页生成失败 → 旧批次逐字节不动 · last 记失败 · 产物仍是最新', async (ctx) => {
  const { root, truth } = await repo()
  ctx.after(() => truth.close())
  const fixed = (): Date => new Date('2026-10-22T00:00:00.000Z')
  const ok = await buildDocs({ root, config: configWith(), truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.ok(ok.ok)
  const before = snapshot(docsRootOf(root))
  const out: BuildOutcome = await buildDocs({ root, config: configWith({ prompt: '改了定义' }), truth, caller: fakeCaller({ failOn: 'arch' }).caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.equal(out.ok, false)
  if (out.ok) return
  assert.equal(out.at_stage, 'model')
  const after = snapshot(docsRootOf(root))
  const batchOf = (m: Map<string, string>): string[] => [...m.keys()].filter((k) => k !== 'last.json').sort()
  assert.deepEqual(batchOf(after), batchOf(before), `批次里多出/少了文件：${batchOf(after).join(' · ')} vs ${batchOf(before).join(' · ')}`)
  for (const k of before.keys()) {
    if (k === 'last.json') continue
    assert.equal(after.get(k), before.get(k), `旧批次被改了：${k}`)
  }
  const last = JSON.parse(readFileSync(join(root, '.fugue', 'docs-last.json'), 'utf8'))
  assert.equal(last.ok, false)
  assert.ok(String(last.reason).includes('arch'))
  assert.equal(last.pages, 0)
  assert.ok(last.usage.calls > 0, '失败之前已经花掉的调用要有读数（不是 0）')
  assert.ok(Array.isArray(last.usagePages), '已完成页的逐页用量要留着')

  const status = await statusOf({ root, config: configWith(), truth, model: STATUS_MODEL })
  assert.equal(status.artifact.state, 'current', '旧产物仍是最新（指纹只看定义与提交）')
  assert.equal(status.attempt?.ok, false)
  console.log(`④ 读数：${before.size} 份旧文件逐字节不变 · last.ok=false · 产物 ${status.artifact.state}`)
})

test('⑤ 来源缺失：报出是哪一份、哪一条路径，旧批次不动', async (ctx) => {
  const { root, truth } = await repo()
  ctx.after(() => truth.close())
  const fixed = (): Date => new Date('2026-10-22T00:00:00.000Z')
  const ok = await buildDocs({ root, config: configWith(), truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.ok(ok.ok)
  const before = snapshot(docsRootOf(root))
  const pages = [...PAGES, { id: 'gone', title: '没有', source: 'docs/missing.md', audience: '谁', role: '什么', prompt: '怎么写' }]
  const out = await buildDocs({ root, config: configWith({ pages }), truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.equal(out.ok, false)
  if (out.ok) return
  assert.equal(out.at_stage, 'facts')
  assert.ok(out.reason.includes('gone') && out.reason.includes('docs/missing.md'), out.reason)
  const after = snapshot(docsRootOf(root))
  for (const k of before.keys()) {
    if (k === 'last.json') continue
    assert.equal(after.get(k), before.get(k), `旧批次被改了：${k}`)
  }
  console.log('⑤ 读数：facts 失败话里带 gone · docs/missing.md；旧批次不变')
})

test('⑥ 状态三档：未生成 / 最新 / 过期（定义变了报出两边的提交与指纹）', async (ctx) => {
  const { root, truth, commit } = await repo()
  ctx.after(() => truth.close())
  const fixed = (): Date => new Date('2026-10-22T00:00:00.000Z')
  const missing = await statusOf({ root, config: configWith(), truth, model: STATUS_MODEL })
  assert.equal(missing.artifact.state, 'missing')
  assert.equal(missing.artifact.now.commit, String(commit))
  await buildDocs({ root, config: configWith(), truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  const current = await statusOf({ root, config: configWith(), truth, model: STATUS_MODEL })
  assert.equal(current.artifact.state, 'current')
  assert.equal(current.artifact.commit, String(commit))
  const stale = await statusOf({ root, config: configWith({ prompt: '定义变了' }), truth, model: STATUS_MODEL })
  assert.equal(stale.artifact.state, 'stale')
  assert.equal(stale.artifact.commit, String(commit))
  assert.notEqual(stale.artifact.fingerprint, stale.artifact.now.fingerprint)
  console.log(`⑥ 读数：missing → current → stale（产物 ${stale.artifact.fingerprint?.slice(9, 21)}… vs 当前 ${stale.artifact.now.fingerprint?.slice(9, 21)}…）`)
})

test('⑦ 批次完整性：页面被手改，状态判过期并把那一条指出来', async (ctx) => {
  const { root, truth } = await repo()
  ctx.after(() => truth.close())
  const fixed = (): Date => new Date('2026-10-22T00:00:00.000Z')
  await buildDocs({ root, config: configWith(), truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  const page = join(docsRootOf(root), 'start.html')
  writeFileSync(page, readFileSync(page, 'utf8') + '<!-- 手改 -->\n')
  const status = await statusOf({ root, config: configWith(), truth, model: STATUS_MODEL })
  assert.equal(status.artifact.state, 'stale')
  assert.deepEqual(status.artifact.integrity, ['start.html'])
  console.log('⑦ 读数：integrity=[start.html] · state=stale')
})

test('⑧ 取证那一趟失败：退到"只有来源与索引"那一档，正文照样生成并记一条 note', async (ctx) => {
  const { root, truth } = await repo()
  ctx.after(() => truth.close())
  const { caller } = fakeCaller({ failEvidence: true })
  const out = await buildDocs({ root, config: configWith(), truth, caller, materials: { kind: 'manual', note: 'n' }, now: () => new Date('2026-10-22T00:00:00.000Z') })
  assert.ok(out.ok)
  assert.ok(out.notes.some((n) => n.includes('取证这一趟没成')), out.notes.join(' | '))
  const manifest = JSON.parse(readFileSync(join(docsRootOf(root), 'manifest.json'), 'utf8'))
  assert.equal(manifest.pages[0].evidence.mode, 'skipped')
  console.log(`⑧ 读数：ok=true · notes=${out.notes.length} · evidence.mode=skipped`)
})

test('⑨ 没有 docs 键：不生成，按配置失败回报（收口因此"只做归并与验收"）', async (ctx) => {
  const { root, truth } = await repo()
  ctx.after(() => truth.close())
  const out = await buildDocs({ root, config: {}, truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' } })
  assert.equal(out.ok, false)
  if (out.ok) return
  assert.equal(out.at_stage, 'config')
  assert.ok(out.reason.includes('没有 docs 键'))
  assert.equal(parseDocs({}), null)
  console.log('⑨ 读数：config 失败 · 话里说"没有 docs 键"')
})

test('⑩ 跳过取证那一趟：一次调用都不多发，读数也不多算（`--no-evidence`）', async (ctx) => {
  const { root, truth } = await repo()
  ctx.after(() => truth.close())
  const { caller, calls } = fakeCaller()
  const out = await buildDocs({
    root,
    config: configWith(),
    truth,
    caller,
    materials: { kind: 'manual', note: 'n' },
    evidence: false,
    now: () => new Date('2026-10-22T00:00:00.000Z'),
  })
  assert.ok(out.ok, JSON.stringify(out))
  assert.equal(calls.filter((c) => c.kind === 'evidence').length, 0, '取证那趟一次都没发')
  assert.equal(out.usage.calls, 2, '两页各一次正文调用')
  const manifest = JSON.parse(readFileSync(join(docsRootOf(root), 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.pages.map((p: { evidence: { mode: string } }) => p.evidence.mode), ['skipped', 'skipped'])
  console.log(`⑩ 读数：${out.usage.calls} 次调用（两页）· 取证 0 次`)
})

test('⑪ 正文形状：短页与只写 H1 当场拒（render 格）；H1+## 收下但记一条 note', async (ctx) => {
  const { root, truth } = await repo()
  ctx.after(() => truth.close())
  const fixed = (): Date => new Date('2026-10-22T00:00:00.000Z')
  const short = await buildDocs({ root, config: configWith(), truth, caller: fakeCaller({ content: () => '## 一小节\n\n太短。' }).caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.equal(short.ok, false)
  if (!short.ok) {
    assert.equal(short.at_stage, 'render')
    assert.match(short.reason, /短于 400/)
  }
  const h1only = await buildDocs({
    root,
    config: configWith(),
    truth,
    caller: fakeCaller({ content: () => ['# 只有一级标题', '', '正文。'.repeat(220)].join('\n') }).caller,
    materials: { kind: 'manual', note: 'n' },
    now: fixed,
  })
  assert.equal(h1only.ok, false)
  if (!h1only.ok) assert.match(h1only.reason, /只写了 H1/)
  const mixed = await buildDocs({
    root,
    config: configWith(),
    truth,
    caller: fakeCaller({ content: (id) => ['# 页内一级标题', '', '## ' + id + ' 的正文 {#' + id + '-top}', '', '正文。'.repeat(200)].join('\n') }).caller,
    materials: { kind: 'manual', note: 'n' },
    now: fixed,
  })
  assert.ok(mixed.ok, JSON.stringify(mixed))
  const manifest = JSON.parse(readFileSync(join(docsRootOf(root), 'manifest.json'), 'utf8'))
  assert.ok(manifest.pages[0].notes.some((n: string) => n.includes('写了 H1')), JSON.stringify(manifest.pages[0].notes))
  console.log('⑪ 读数：短页拒 · 只有 H1 拒 · H1+## 收下并记 note')
})

test('⑫ 跨页引用：目标页上没有那个锚点时落成页链接并记 note（来源路径那一路也要校）', async (ctx) => {
  const { root, truth } = await repo()
  ctx.after(() => truth.close())
  const body = (id: string): string =>
    [
      '## ' + id + ' 的正文 {#' + id + '-top}',
      '',
      '这一段说明这一页要解决的问题，以及读者能从这里得到什么。'.repeat(12),
      '',
      '[去架构的边界](design/A.md#arch-top) · [去不存在的节](design/A.md#nope)',
      '',
      '## 下一节',
      '',
      '更多内容。'.repeat(30),
    ].join('\n')
  const out = await buildDocs({
    root,
    config: configWith(),
    truth,
    caller: fakeCaller({ content: body, evidencePaths: [] }).caller,
    materials: { kind: 'manual', note: 'n' },
    now: () => new Date('2026-10-22T00:00:00.000Z'),
  })
  assert.ok(out.ok, JSON.stringify(out))
  const manifest = JSON.parse(readFileSync(join(docsRootOf(root), 'manifest.json'), 'utf8'))
  const start = manifest.pages.find((p: { id: string }) => p.id === 'start')
  assert.ok(start.notes.some((n: string) => n.includes('锚点不在目标页')), JSON.stringify(start.notes))
  const html = readFileSync(join(docsRootOf(root), 'start.html'), 'utf8')
  assert.ok(html.includes('href="arch.html#arch-top"'), '存在的手术保留深链接')
  assert.ok(html.includes('href="arch.html"'), '不存在的锚点落成页链接')
  assert.ok(!html.includes('arch.html#nope'), '不给读者一条死深链')
  console.log('⑫ 读数：好锚点保深链 · 坏锚点落页链接 + note')
})

test('⑬ 取证拿得到被截断文件的后半：第二趟按行段补读，写作输入里真有那一句', async (ctx) => {
  const root = tmpRepo()
  const filler = Array.from({ length: 900 }, (_, i) => `export const v${i} = ${i} // 填充行：让关键实现落在很后面`).join('\n')
  const key = 'const KEY_IMPLEMENTATION = "后半部的关键实现"'
  const big = `${filler}\n${key}\n${Array.from({ length: 300 }, (_, i) => `export const tail${i} = ${i} // 关键实现之后还有内容`).join('\n')}\n`
  await commitFiles(
    root,
    {
      'package.json': JSON.stringify({ name: 'demo', version: '1.2.3' }),
      'README.md': '# demo\n',
      'design/A.md': '# 架构\n',
      'src/big.ts': big,
    },
    [],
    'refs/heads/main',
  )
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  // 关键实现在第 901 行：开头那 24000 字符的摘录一定够不到它。
  const fake = fakeCaller({ evidencePaths: ['src/big.ts'], rangeAsks: [{ path: 'src/big.ts', from: 895, to: 920 }] })
  const out = await buildDocs({
    root,
    config: configWith({ pages: [PAGES[0]!] }),
    truth,
    caller: fake.caller,
    materials: { kind: 'manual', note: 'n' },
    now: () => new Date('2026-10-22T00:00:00.000Z'),
  })
  assert.ok(out.ok, JSON.stringify(out))
  assert.equal(fake.calls.filter((c) => c.kind === 'ranges').length, 1, '截断了就要有第二趟取证')
  const writing = fake.contexts.join('\n')
  assert.ok(writing.includes('后半部的关键实现'), '写作材料里没有后半部那一段')
  const manifest = JSON.parse(readFileSync(join(docsRootOf(root), 'manifest.json'), 'utf8'))
  const ev = manifest.pages[0].evidence.ranges[0]
  assert.equal(ev.path, 'src/big.ts')
  assert.equal(ev.truncated, true, '截断要如实记')
  assert.ok(ev.lines > 900 && ev.chars > 24000)
  assert.ok(ev.shown.some((r: { from: number; to: number }) => r.to >= 895), `补读的行段要进清单：${JSON.stringify(ev.shown)}`)
  console.log(`⑬ 读数：${ev.lines} 行 / ${ev.chars} 字符 · 贴出 ${JSON.stringify(ev.shown)} · 写作材料含关键实现`)
})

test('⑭ 旧地址跨三版仍到 C：改名一串都跟到终点；版本号写法变了也认得（`v1-2-3` → `v123`）', async (ctx) => {
  const root = tmpRepo()
  const c1 = await commitFiles(root, { 'README.md': '# demo\n', 'design/A.md': '# 架构\n' }, [], 'refs/heads/main')
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  const cfg = configWith()
  const fixed = (): Date => new Date('2026-10-22T00:00:00.000Z')
  const body = (heading: string, id: string): string =>
    [`## ${heading} {#${id}}`, '', '这一段说明这一页要解决的问题，以及读者能从这里得到什么。'.repeat(12), '', '## 下一节', '', '更多内容。'.repeat(30)].join('\n')
  const caller = (start: string, arch: string): DocCaller => ({
    model: 'fake/model',
    wireModel: 'fake',
    thinking: 'high',
    facts: FAKE_FACTS,
    async call(req) {
      if (req.system.includes('只输出一个 JSON 对象')) return { text: '{"paths":[]}', usage: null }
      const id = /文档 id：([^\n]+)/.exec(req.context)?.[1]?.trim()
      return { text: id === 'start' ? start : arch, usage: null }
    },
  })
  const build = async (start: string, arch: string): Promise<void> => {
    const head = await truth.resolve('refs/heads/main' as never).catch(() => null)
    await commitFiles(root, { 'README.md': `# demo ${String(head).slice(0, 7)}\n`, 'design/A.md': '# 架构\n' }, head === null ? [] : [String(head)], 'refs/heads/main')
    const out = await buildDocs({ root, config: cfg, truth, caller: caller(start, arch), materials: { kind: 'manual', note: 'n' }, now: fixed })
    assert.ok(out.ok, JSON.stringify(out))
  }
  // 第一版
  await build(body('安装 Fugue', '安装-fugue'), body('1.2.3 —— 旧写法', 'v1-2-3'))
  const manifest1 = JSON.parse(readFileSync(join(docsRootOf(root), 'manifest.json'), 'utf8'))
  assert.equal(manifest1.pages[0].id, 'start')
  // 第二版：两个主题都改名（一个靠相似度，一个靠版本号）
  await build(body('装好 Fugue', '装好-fugue'), body('1.2.3 —— 文档成为可读产物', 'v123'))
  const manifest2 = JSON.parse(readFileSync(join(docsRootOf(root), 'manifest.json'), 'utf8'))
  assert.equal(manifest2.pages[0].anchors['安装-fugue'], '装好-fugue')
  assert.equal(manifest2.pages[1].anchors['v1-2-3'], 'v123', '版本号写法变了，旧地址仍到')
  // 第三版：再改一次名（A→B→C 之后，A 与 B 都要到 C）
  await build(body('三步装好 Fugue', '三步装好-fugue'), body('1.2.3 —— 文档是产物', 'v123-final'))
  const manifest3 = JSON.parse(readFileSync(join(docsRootOf(root), 'manifest.json'), 'utf8'))
  assert.equal(manifest3.pages[0].anchors['装好-fugue'], '三步装好-fugue')
  assert.equal(manifest3.pages[0].anchors['安装-fugue'], '三步装好-fugue', '三版之后最早的地址仍到 C')
  assert.equal(manifest3.pages[1].anchors['v123'], 'v123-final')
  assert.equal(manifest3.pages[1].anchors['v1-2-3'], 'v123-final')
  const page = readFileSync(join(docsRootOf(root), 'start.html'), 'utf8')
  assert.ok(page.includes('id="安装-fugue"'), '最早的地址在页面里仍是一个锚点')
  console.log(`⑭ 读数：安装-fugue→三步装好-fugue · 装好-fugue→三步装好-fugue · v1-2-3/v123→v123-final · dropped ${manifest3.pages[0].dropped.length}/${manifest3.pages[1].dropped.length}`)
})

test('⑮ 指纹认模型声明：只改思考档就过期；只换凭据（不在声明里）不变', async (ctx) => {
  const { root, truth } = await repo()
  ctx.after(() => truth.close())
  const fixed = (): Date => new Date('2026-10-22T00:00:00.000Z')
  const high = await buildDocs({ root, config: configWith(), truth, caller: fakeCaller({ facts: { thinking: 'high' } }).caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.ok(high.ok)
  const low = await buildDocs({ root, config: configWith(), truth, caller: fakeCaller({ facts: { thinking: 'low' } }).caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.ok(low.ok)
  assert.notEqual(low.fingerprint, high.fingerprint, 'ID 不变、思考档变了也要判过期')
  const base = fakeCaller({ facts: { thinking: 'high' } })
  const withKey = { ...base.caller, credential: 'sk-another-one' }
  const again = await buildDocs({ root, config: configWith(), truth, caller: withKey as DocCaller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.ok(again.ok)
  assert.equal(again.fingerprint, high.fingerprint, '换一把密钥不该改指纹')
  console.log(`⑮ 读数：thinking high ${high.fingerprint.slice(9, 21)} · low ${low.fingerprint.slice(9, 21)} · 换密钥 ${again.fingerprint.slice(9, 21)}（与 high 相同）`)
})

test('⑯ 合并与复活：合并的那一节接住旧版本号；判过“没有后继”的地址在这一版重新出现时接回来', async (ctx) => {
  const root = tmpRepo()
  await commitFiles(root, { 'README.md': '# demo\n', 'design/A.md': '# 架构\n' }, [], 'refs/heads/main')
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  const fixed = (): Date => new Date('2026-10-22T00:00:00.000Z')
  const cfg = configWith()
  const body = (sections: [string, string][]): string =>
    sections.map(([h, id]) => `## ${h} {#${id}}\n\n${'这一段说明这一页要解决的问题。'.repeat(30)}`).join('\n\n')
  const caller = (start: string, arch: string): DocCaller => ({
    model: 'fake/model',
    wireModel: 'fake',
    thinking: 'high',
    facts: FAKE_FACTS,
    async call(req) {
      if (req.system.includes('只输出一个 JSON 对象')) return { text: '{"paths":[]}', usage: null }
      const id = /文档 id：([^\n]+)/.exec(req.context)?.[1]?.trim()
      return { text: id === 'start' ? start : arch, usage: null }
    },
  })
  const build = async (start: string, arch: string): Promise<void> => {
    const head = await truth.resolve('refs/heads/main' as never).catch(() => null)
    await commitFiles(root, { 'README.md': `# demo ${String(head).slice(0, 7)}\n`, 'design/A.md': '# 架构\n' }, head === null ? [] : [String(head)], 'refs/heads/main')
    const out = await buildDocs({ root, config: cfg, truth, caller: caller(start, arch), materials: { kind: 'manual', note: 'n' }, now: fixed })
    assert.ok(out.ok, JSON.stringify(out))
  }
  const read = (): { anchors: Record<string, string>; dropped: string[] }[] =>
    (JSON.parse(readFileSync(join(docsRootOf(root), 'manifest.json'), 'utf8')) as { pages: { anchors: Record<string, string>; dropped: string[] }[] }).pages
  // 第一版：旧写法（版本号分隔的 id）
  await build(body([['0.4.3 —— 界面的一版', 'v0-4-3'], ['0.2.1 —— 收口', 'v0-2-1']]), body([['1.2.3 —— 旧写法', 'v1-2-3']]))
  // 第二版：两节合并成一节；架构页改成与版本号无关的标题 → v0-5-2 判“没有后继”
  await build(
    body([['0.4.4 与 0.4.3 —— 界面的两版', 'v044'], ['0.2.x —— 收口批次', 'v02x']]),
    body([['安装说明', '安装说明']]),
  )
  const two = read()
  assert.equal(two[0]!.anchors['v0-4-3'], 'v044', '“0.4.4 与 0.4.3”这一节要接住 0.4.3 的旧地址')
  assert.equal(two[0]!.anchors['v0-2-1'], 'v02x', '“0.2.x”这一族要接住 0.2.1 的旧地址')
  assert.deepEqual(two[1]!.dropped, ['v1-2-3'])
  // 第三版：架构页又写回 1.2.3 那一节 → 上一批判过“没有后继”的地址自动复活
  await build(
    body([['0.4.4 与 0.4.3 —— 界面的两版', 'v044'], ['0.2.x —— 收口批次', 'v02x']]),
    body([['1.2.3 —— 文档是产物', 'v123']]),
  )
  const three = read()
  assert.equal(three[1]!.anchors['v1-2-3'], 'v123', '删过一次的地址在这一版重新出现时要接回来')
  assert.deepEqual(three[1]!.dropped, ['安装说明'], '上一版临时用的那个标题才是这一版被删的地址')
  console.log(`⑯ 读数：合并 v0-4-3→v044 · v0-2-1→v02x · 复活 v1-2-3→v123 · 上一版的标题转为 dropped`)
})
