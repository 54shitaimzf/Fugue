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
import type { BuildOutcome, DocCaller } from './contract.ts'
import { DocsError, docsRootOf } from './contract.ts'
import { parseDocs } from './config.ts'
import { statusOf } from './status.ts'
import type { ConfigDoc } from '../config.ts'

const PAGES = [
  { id: 'start', title: '开始', source: 'README.md', audience: '第一次用的人', role: '跑通第一条命令', prompt: '最短路径' },
  { id: 'arch', title: '架构', source: 'design/A.md', audience: '维护者', role: '理解边界', prompt: '讲约束' },
]

function configWith(o: { prompt?: string; pages?: typeof PAGES; theme?: string } = {}): ConfigDoc {
  return {
    docs: {
      theme: o.theme ?? 'primer',
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
  readonly failEvidence?: boolean
}

/** 假模型：按 `文档 id：<id>` 认出这一趟是哪一页；两趟用系统提示词区分。 */
function fakeCaller(o: FakeOptions = {}): { caller: DocCaller; calls: { kind: 'evidence' | 'content'; id: string }[] } {
  const calls: { kind: 'evidence' | 'content'; id: string }[] = []
  const caller: DocCaller = {
    model: 'fake/model',
    wireModel: 'fake',
    async call(req) {
      const id = /文档 id：([^\n]+)/.exec(req.context)?.[1]?.trim() ?? '?'
      const kind = req.system.includes('只输出一个 JSON 对象') ? 'evidence' : 'content'
      calls.push({ kind, id })
      if (kind === 'evidence') {
        if (o.failEvidence === true) throw new DocsError('model', '取证这一趟没成（夹具）')
        return {
          text: JSON.stringify({ paths: o.evidencePaths ?? ['README.md'] }),
          usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: null, model: null },
        }
      }
      if (o.failOn === id) throw new DocsError('model', `模型没写完（夹具：${id}）`)
      return {
        text: o.content === undefined ? bodyOf(id) : o.content(id),
        usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: null, model: null },
      }
    },
  }
  return { caller, calls }
}

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

  const docs = docsRootOf(root)
  const manifest = JSON.parse(readFileSync(join(docs, 'manifest.json'), 'utf8'))
  assert.equal(manifest.commit, String(commit))
  assert.equal(manifest.pages.length, 2)
  assert.equal(manifest.theme, 'primer')
  assert.equal(manifest.model, 'fake/model')
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
  const byTheme = await buildDocs({ root, config: configWith(), theme: 'govuk', truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.ok(byTheme.ok)
  assert.notEqual(byTheme.fingerprint, base.fingerprint, '主题进指纹')
  const c2 = await commitFiles(root, { 'package.json': JSON.stringify({ name: 'demo', version: '1.2.4' }), 'README.md': '# demo\n\n第二版。\n', 'design/A.md': '# 架构\n\n边界。\n' }, [commit as never], 'refs/heads/main')
  const byCommit = await buildDocs({ root, config: configWith(), truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  assert.ok(byCommit.ok)
  assert.notEqual(byCommit.fingerprint, base.fingerprint, '提交进指纹')
  assert.equal(byCommit.commit, String(c2))
  console.log(`③ 读数：base ${base.fingerprint.slice(9, 21)} · 改定义/主题/提交后三只指纹都不同`)
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
  const last = JSON.parse(readFileSync(join(docsRootOf(root), 'last.json'), 'utf8'))
  assert.equal(last.ok, false)
  assert.ok(String(last.reason).includes('arch'))
  assert.equal(last.pages, 0)

  const status = await statusOf({ root, config: configWith(), truth, model: 'fake/model' })
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
  const missing = await statusOf({ root, config: configWith(), truth, model: 'fake/model' })
  assert.equal(missing.artifact.state, 'missing')
  assert.equal(missing.artifact.now.commit, String(commit))
  await buildDocs({ root, config: configWith(), truth, caller: fakeCaller().caller, materials: { kind: 'manual', note: 'n' }, now: fixed })
  const current = await statusOf({ root, config: configWith(), truth, model: 'fake/model' })
  assert.equal(current.artifact.state, 'current')
  assert.equal(current.artifact.commit, String(commit))
  const stale = await statusOf({ root, config: configWith({ prompt: '定义变了' }), truth, model: 'fake/model' })
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
  const status = await statusOf({ root, config: configWith(), truth, model: 'fake/model' })
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
