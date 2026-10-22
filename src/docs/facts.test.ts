// 事实那一层：**读的是提交 C 的完整树**，缺了就说缺。
//
// 判据来自交接单 § 2.4：页面里的版本、提交、文件数与提交一致；同一份定义换一版提交，事实
// 跟着变；来源在提交里缺失时报出是哪一份、哪一条路径。
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { commitFiles, tmpRepo } from '../../test/helpers/docs-repo.ts'
import { openTruth } from '../truth/truth.ts'
import { parseDocs } from './config.ts'
import type { DocsPlan } from './contract.ts'
import { DocsError } from './contract.ts'
import { excerptAt, looksBinary, sha256Of, sourceTextOf, treeFactsOf, walkTree } from './facts.ts'

function planOf(sources: readonly { id: string; source: string }[]): DocsPlan {
  const parsed = parseDocs({
    docs: {
      pages: sources.map((s) => ({
        id: s.id,
        title: s.id,
        source: s.source,
        audience: '读者',
        role: '职责',
        prompt: '写法',
      })),
    },
  })
  assert.ok(parsed !== null)
  return parsed
}

test('① 完整树的事实：版本 · 提交 · 文件数 · 顶层目录 · 来源 blob · 路径表', async (ctx) => {
  const root = tmpRepo()
  const commit = await commitFiles(root, {
    'package.json': JSON.stringify({ name: 'demo', version: '1.2.3' }),
    'README.md': '# demo\n第一句。\n',
    'src/a.ts': 'export const a = 1\n',
    'src/b.ts': 'export const b = 2\n',
    'design/b.md': '# 设计\n',
  })
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  const plan = planOf([{ id: 'start', source: 'README.md' }, { id: 'arch', source: 'design/b.md' }])
  const facts = await treeFactsOf(truth, commit, plan)

  assert.equal(facts.commit, String(commit))
  assert.equal(facts.commitShort, String(commit).slice(0, 12))
  assert.equal(facts.version, '1.2.3', '版本从提交里的 package.json 读')
  assert.equal(facts.files, 5)
  assert.deepEqual(facts.topDirs, [
    { name: 'design', files: 1 },
    { name: 'src', files: 2 },
  ])
  assert.deepEqual(facts.missing, [])
  assert.equal(facts.sources.length, 2)
  // 来源的 sha 就是 blob id：与真源那一侧单点读到的同一个值（不是另算一份）
  const meta = await truth.statAt(commit, 'README.md')
  assert.equal(facts.sources[0]?.sha, String(meta?.id))
  assert.equal(facts.sources[0]?.bytes, meta?.size)
  assert.deepEqual([...facts.paths].sort(), facts.paths, '路径表按字典序')
  console.log(`① 读数：version=${facts.version} · files=${facts.files} · topDirs=${facts.topDirs.map((d) => `${d.name}:${d.files}`).join(' · ')} · sources=${facts.sources.length}`)
})

test('② 同一份定义换一版提交：事实跟着变（文件数 · 版本），来源 sha 也变', async (ctx) => {
  const root = tmpRepo()
  const c1 = await commitFiles(root, {
    'package.json': JSON.stringify({ version: '0.1.0' }),
    'README.md': '第一版\n',
  })
  const c2 = await commitFiles(
    root,
    { 'package.json': JSON.stringify({ version: '0.2.0' }), 'README.md': '第二版，多了这一句。\n', 'src/new.ts': 'x\n' },
    [c1],
  )
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  const plan = planOf([{ id: 'start', source: 'README.md' }])
  const f1 = await treeFactsOf(truth, c1, plan)
  const f2 = await treeFactsOf(truth, c2, plan)
  assert.notEqual(f1.version, f2.version)
  assert.notEqual(f1.files, f2.files)
  assert.notEqual(f1.sources[0]?.sha, f2.sources[0]?.sha)
  // 负对照：同一个提交读两次，逐字段相同（事实不是随机的）
  assert.deepEqual(await treeFactsOf(truth, c1, plan), f1)
  console.log(`② 读数：c1 v${f1.version}/${f1.files} 文件 · c2 v${f2.version}/${f2.files} 文件 · sha 不同`)
})

test('③ 来源在 C 里缺失：报出是哪一份、哪一条路径，正文不拿空串顶上', async (ctx) => {
  const root = tmpRepo()
  const commit = await commitFiles(root, { 'README.md': '有这一份\n' })
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  const plan = planOf([
    { id: 'start', source: 'README.md' },
    { id: 'arch', source: 'design/missing.md' },
  ])
  const facts = await treeFactsOf(truth, commit, plan)
  assert.deepEqual(facts.missing, [{ id: 'arch', source: 'design/missing.md' }])
  assert.equal(facts.sources.length, 1, '缺的那一份不进 sources')
  await assert.rejects(
    () => sourceTextOf(truth, commit, 'arch', 'design/missing.md'),
    (err: unknown) => err instanceof DocsError && err.message.includes('arch') && err.message.includes('design/missing.md'),
  )
  console.log('③ 读数：missing=[arch · design/missing.md]；sourceTextOf 抛 DocsError（含 id 与路径）')
})

test('④ 摘录：只贴前面一段要如实说，二进制与不存在的路径都不给（null）', async (ctx) => {
  const root = tmpRepo()
  const commit = await commitFiles(root, {
    'README.md': 'a'.repeat(500),
    'bin.dat': 'head\u0000tail',
  })
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  assert.equal(looksBinary(new TextEncoder().encode('head\u0000tail')), true)
  const cut = await excerptAt(truth, commit, 'README.md', 50)
  assert.ok(cut !== null)
  assert.equal(cut.truncated, true)
  assert.ok(cut.text.includes('不要把它当全文'), '截断要说出来')
  assert.equal((await excerptAt(truth, commit, 'bin.dat', 1000)), null)
  assert.equal((await excerptAt(truth, commit, 'nope.txt', 1000)), null)
  const full = await excerptAt(truth, commit, 'README.md', 1000)
  assert.equal(full?.truncated, false)
  console.log(`④ 读数：README 500 字符 · 限额 50 → truncated=${cut.truncated}；二进制与不存在 → null`)
})

test('⑤ 走树：symlink/gitlink 进路径表但不算文件（文件数是"正文来源"那个数）', async (ctx) => {
  const root = tmpRepo()
  const commit = await commitFiles(root, { 'a.txt': 'a\n' })
  const truth = openTruth(root)
  ctx.after(() => truth.close())
  const walk = await walkTree(truth, commit)
  assert.deepEqual(walk.paths, ['a.txt'])
  assert.equal(walk.files, 1)
  assert.equal(sha256Of(new TextEncoder().encode('a\n')).length, 64)
  console.log(`⑤ 读数：paths=${walk.paths.length} · files=${walk.files} · sha256 长 ${sha256Of(new TextEncoder().encode('a\n')).length}`)
})
