// 作者：**两条策略共用同一条接缝**（升级计划 § 阶段 4–5）。
//
// 判据：请求的三区逐字节来自提示词链（不是另拼一份）；取证失败退到"只有来源"那一档；
// 自由读读得到第一屏之外的行，而两趟读不到——同一条脚本、同一份材料，只换策略。
import assert from 'node:assert/strict'
import test from 'node:test'
import { commitFiles, tmpRepo } from '../../test/helpers/docs-repo.ts'
import { openTruth } from '../truth/truth.ts'
import type { Truth } from '../truth/contract.ts'
import type { CommitId } from '../terms.ts'
import { authorOf } from './author.ts'
import { parseDocs } from './config.ts'
import type { DocCaller, DocsPlan, Materials, TreeFacts } from './contract.ts'
import { DocsError } from './contract.ts'
import { EXCERPT_LIMIT, chainOf } from './prompt.ts'
import { excerptAt, treeFactsOf } from './facts.ts'
import { themeOf } from './theme.ts'

const PLAN: DocsPlan = (() => {
  const p = parseDocs({
    docs: {
      theme: 'primer',
      pages: [{ id: 'start', title: '开始', source: 'README.md', audience: '第一次用的人', role: '跑通第一条命令', prompt: '最短路径' }],
    },
  })
  assert.ok(p !== null)
  return p
})()

const MATERIALS: Materials = { kind: 'manual', note: '测试：手动重建' }
const BODY = ['## 开始 {#top}', '', '正文。'.repeat(400)].join('\n')

/** 1200 行、每行够长（总共约 8 万字符）：开头一屏只盖到前三百多行，第 920 行在它之外。 */
function bigFile(): string {
  const pad = 'x'.repeat(60)
  return Array.from({ length: 1200 }, (_, i) => (i + 1 === 920 ? `L920 NEEDLE ${pad}` : `L${i + 1} ${pad}`)).join('\n')
}

const USAGE = { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: null, model: null }

interface Script {
  readonly evidence?: string
  readonly ranges?: string
  readonly again?: string[]
  readonly failEvidence?: boolean
}

const primer = themeOf('primer')
assert.ok(primer !== null)

function fake(script: Script): { caller: DocCaller; seen: { kind: string; req: Parameters<DocCaller['call']>[0] }[] } {
  const seen: { kind: string; req: Parameters<DocCaller['call']>[0] }[] = []
  const again = [...(script.again ?? [])]
  const caller: DocCaller = {
    model: 'fake/model',
    wireModel: 'fake',
    facts: { id: 'fake/model', wireModel: 'fake', thinking: 'high', temperature: null, maxTokens: 8192, contextLimit: 1048576 },
    async call(req) {
      const kind = req.context.includes('继续取证')
        ? 'again'
        : req.context.includes('补读取证')
          ? 'ranges'
          : req.context.includes('只输出一个 JSON 对象')
            ? 'evidence'
            : 'writing'
      seen.push({ kind, req })
      if (kind === 'writing') return { text: BODY, usage: { ...USAGE, inputTokens: 100, outputTokens: 50 } }
      if (kind === 'evidence') {
        if (script.failEvidence === true) throw new DocsError('model', '取证这一趟没成（夹具）')
        return { text: script.evidence ?? '{"paths":[]}', usage: USAGE }
      }
      if (kind === 'ranges') return { text: script.ranges ?? '{"ranges":[]}', usage: USAGE }
      return { text: again.shift() ?? '{"paths":[]}', usage: USAGE }
    },
  }
  return { caller, seen }
}

/** 19 份小文件：够第一轮点 12 处、第二轮再点 7 处。 */
async function wideRepo(): Promise<{ truth: Truth; commit: CommitId; facts: TreeFacts; source: string }> {
  const root = tmpRepo()
  const source = '# demo\n\n第一版说明。\n'
  const files: Record<string, string> = { 'package.json': JSON.stringify({ name: 'demo', version: '1.2.3' }), 'README.md': source }
  for (let i = 1; i <= 19; i++) files[`src/f${String(i).padStart(2, '0')}.ts`] = `export const f${i} = ${i}\n`
  const commit = await commitFiles(root, files, [], 'refs/heads/main')
  const truth = openTruth(root)
  const facts = await treeFactsOf(truth, commit, PLAN)
  return { truth, commit, facts, source }
}

async function repo(): Promise<{ truth: Truth; commit: CommitId; facts: TreeFacts; source: string }> {
  const root = tmpRepo()
  const source = '# demo\n\n第一版说明。\n'
  const commit = await commitFiles(
    root,
    { 'package.json': JSON.stringify({ name: 'demo', version: '1.2.3' }), 'README.md': source, 'src/big.ts': bigFile() },
    [],
    'refs/heads/main',
  )
  const truth = openTruth(root)
  const facts = await treeFactsOf(truth, commit, PLAN)
  return { truth, commit, facts, source }
}

function input(o: { facts: TreeFacts; caller: DocCaller; truth: Truth; commit: CommitId; source: string; read: boolean; strategy: 'two-pass' | 'loop' }) {
  return {
    page: PLAN.pages[0]!,
    plan: PLAN,
    theme: primer,
    facts: o.facts,
    source: o.source,
    materials: MATERIALS,
    prompt: chainOf(o.facts),
    caller: o.caller,
    truth: o.truth,
    commit: o.commit,
    read: o.read,
  }
}

test('① 三区逐字节来自提示词链：A 是共享前缀 · B 是这一页的装配（黄金帧）', async (ctx) => {
  const { truth, commit, facts, source } = await repo()
  ctx.after(() => truth.close())
  const { caller, seen } = fake({ evidence: '{"paths":["src/big.ts"]}' })
  const out = await authorOf('two-pass').write(input({ facts, caller, truth, commit, source, read: true, strategy: 'two-pass' }))
  assert.equal(out.markdown, BODY)
  const chain = chainOf(facts)
  const ask = seen.find((s) => s.kind === 'evidence')!
  assert.equal(ask.req.system, chain.shared, 'A 区就是链上那一份')
  assert.equal(ask.req.context, chain.evidence({ page: PLAN.pages[0]!, plan: PLAN, source }).page, '取证 B 区逐字节相同')
  const excerpt = await excerptAt(truth, commit, 'src/big.ts', { limit: EXCERPT_LIMIT })
  assert.ok(excerpt !== null)
  const write = seen.find((s) => s.kind === 'writing')!
  assert.equal(write.req.system, chain.shared)
  assert.equal(
    write.req.context,
    chain.writing({ page: PLAN.pages[0]!, plan: PLAN, theme: primer, source, materials: MATERIALS, excerpts: [excerpt], evidenceMissing: [] }).page,
    '写作 B 区 = 链按同一份摘录装出来的字节',
  )
  assert.deepEqual(out.evidence.found, ['src/big.ts'])
  console.log(`① 读数：A ${chain.shared.length} 字符 · B（写作）${write.req.context.length} 字符 · 三区同源`)
})

test('② 取证那一趟没成：退到"只有来源"仍写正文，note 说清原因', async (ctx) => {
  const { truth, commit, facts, source } = await repo()
  ctx.after(() => truth.close())
  const { caller, seen } = fake({ failEvidence: true })
  const out = await authorOf('two-pass').write(input({ facts, caller, truth, commit, source, read: true, strategy: 'two-pass' }))
  assert.equal(out.markdown, BODY, '写正文那一趟照发')
  assert.equal(out.evidence.mode, 'skipped')
  assert.ok(out.notes[0]!.includes('取证这一趟没成'), out.notes.join(' | '))
  assert.equal(seen.filter((s) => s.kind === 'writing').length, 1)
  console.log(`② 读数：note=${out.notes[0]!.slice(0, 40)}…`)
})

test('③ 自由读：先读开头一段，再点到第 900–950 行，写作输入里真有那一行', async (ctx) => {
  const { truth, commit, facts, source } = await repo()
  ctx.after(() => truth.close())
  const { caller, seen } = fake({
    evidence: '{"paths":[{"path":"src/big.ts","from":1,"to":10}]}',
    again: ['{"paths":[{"path":"src/big.ts","from":900,"to":950}]}', '{"paths":[]}'],
  })
  const out = await authorOf('loop').write(input({ facts, caller, truth, commit, source, read: true, strategy: 'loop' }))
  const write = seen.find((s) => s.kind === 'writing')!
  assert.ok(write.req.context.includes('L920 NEEDLE'), '第 920 行要进写作输入')
  const range = out.evidence.ranges[0]!
  assert.ok(range.shown.some((r) => r.from === 900 && r.to === 950), '清单里记着补读的行段')
  assert.equal(seen.filter((s) => s.kind === 'again').length, 2, '两轮继续取证（第二轮给空数组收手）')
  assert.equal(out.evidenceUsage?.inputTokens, 30, '三轮取证各 10 入')
  assert.equal(out.calls, 4, '三轮取证 + 一次写作 = 4 次调用')
  console.log(`③ 读数：调用 ${seen.length} 次 · 行段 ${range.shown.length} 段 · 写入含 NEEDLE`)
})

test('④ 负对照：同一条脚本、同一份材料，两趟读不到第 920 行', async (ctx) => {
  const { truth, commit, facts, source } = await repo()
  ctx.after(() => truth.close())
  const { caller, seen } = fake({
    evidence: '{"paths":[{"path":"src/big.ts","from":1,"to":10}]}',
    again: ['{"paths":[{"path":"src/big.ts","from":900,"to":950}]}', '{"paths":[]}'],
  })
  const out = await authorOf('two-pass').write(input({ facts, caller, truth, commit, source, read: true, strategy: 'two-pass' }))
  const write = seen.find((s) => s.kind === 'writing')!
  assert.equal(write.req.context.includes('L920 NEEDLE'), false, '两趟只读开头与那一段行')
  assert.equal(seen.some((s) => s.kind === 'again'), false, '两趟没有"继续取证"这一趟')
  assert.equal(out.calls, 3, '取证 + 补读 + 写作 = 3 次调用')
  assert.equal(out.evidence.ranges[0]!.shown.some((r) => r.from === 900), false)
  console.log(`④ 读数：调用 ${seen.length} 次 · 写作输入里没有 NEEDLE`)
})

test('⑤ 自由读第一轮照合同收 12 处，第二轮起按继续取证的合同收 6 处', async (ctx) => {
  const { truth, commit, facts, source } = await wideRepo()
  ctx.after(() => truth.close())
  const first = Array.from({ length: 12 }, (_, i) => `src/f${String(i + 1).padStart(2, '0')}.ts`)
  const next = Array.from({ length: 7 }, (_, i) => `src/f${String(i + 13).padStart(2, '0')}.ts`)
  const { caller, seen } = fake({ evidence: JSON.stringify({ paths: first }), again: [JSON.stringify({ paths: next }), '{"paths":[]}'] })
  const out = await authorOf('loop').write(input({ facts, caller, truth, commit, source, read: true, strategy: 'loop' }))
  assert.deepEqual(out.evidence.requested, [...first, ...next.slice(0, 6)], '第一轮 12 处全收；第二轮点名 7 处只收前 6')
  assert.equal(out.evidence.missing.length, 0, '这 19 份都在提交里，一份都不该缺')
  assert.equal(seen.filter((s) => s.kind === 'again').length, 2, '两轮继续取证（第二轮给空数组收手）')
  assert.equal(out.calls, 4, '三轮取证 + 一次写作 = 4 次调用')
  console.log(`⑤ 读数：第一轮收 ${out.evidence.requested.length - 6} 处 · 第二轮点名 ${next.length} 处收 6 处 · requested ${out.evidence.requested.length}`)
})
