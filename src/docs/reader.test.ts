// 读取接口：**去重 · 预算 · 补读 · 轨迹**（都是宿主这一侧的账）。
//
// 判据来自交接单 § 2.5 与升级计划 § 阶段 4：模型只说"要读哪里"，读多少与读没读到由宿主定。
// 这一份不认识模型，也不认识提示词——所以断言全是可数的账。
import assert from 'node:assert/strict'
import test from 'node:test'
import { commitFiles, tmpRepo } from '../../test/helpers/docs-repo.ts'
import { openTruth } from '../truth/truth.ts'
import type { Truth } from '../truth/contract.ts'
import type { CommitId } from '../terms.ts'
import { openRead } from './reader.ts'
import type { ReadBudget } from './reader.ts'

/** 一个大文件：每行 `L<n>`，第 920 行带一个标记（"藏在后半部"的那种内容）。 */
function bigFile(lines: number): string {
  return Array.from({ length: lines }, (_, i) => (i + 1 === 920 ? 'L920 NEEDLE' : `L${i + 1}`)).join('\n')
}

async function repo(): Promise<{ root: string; truth: Truth; commit: CommitId; known: Set<string> }> {
  const root = tmpRepo()
  const commit = await commitFiles(
    root,
    {
      'package.json': JSON.stringify({ name: 'demo', version: '1.2.3' }),
      'src/a.ts': 'export const a = 1\n',
      'src/big.ts': bigFile(1200),
    },
    [],
    'refs/heads/main',
  )
  const truth = openTruth(root)
  return { root, truth, commit, known: new Set(['package.json', 'src/a.ts', 'src/big.ts']) }
}

const SMALL: ReadBudget = { head: 120, total: 400, paths: 4, ranges: 3 }

test('① 点名：同一条路径只读一次 · 不存在的如实记缺 · 轨迹可数', async (ctx) => {
  const { truth, commit, known } = await repo()
  ctx.after(() => truth.close())
  const s = openRead({ truth, commit, known })
  await s.read([
    { path: 'src/a.ts', from: null, to: null },
    { path: 'src/a.ts', from: null, to: null },
    { path: 'nope.ts', from: null, to: null },
  ])
  assert.equal(s.excerpts.length, 1, '重复点名只读一次')
  assert.deepEqual(s.log.requested, ['src/a.ts', 'nope.ts'], '点名表里没有重复项')
  assert.deepEqual(s.log.found, ['src/a.ts'])
  assert.deepEqual(s.log.missing, ['nope.ts'])
  assert.ok(s.chars > 0, '预算的账要动')
  console.log(`① 读数：读到 ${s.log.found.length} 份 · 缺 ${s.log.missing.length} 份 · ${s.chars} 字符`)
})

test('② 预算：单份只贴开头一段 · 一页总额封顶（超了就不再多贴）', async (ctx) => {
  const { truth, commit, known } = await repo()
  ctx.after(() => truth.close())
  const s = openRead({ truth, commit, known, budget: SMALL })
  await s.read([
    { path: 'src/big.ts', from: null, to: null },
    { path: 'package.json', from: null, to: null },
  ])
  const big = s.excerpts.find((x) => x.path === 'src/big.ts')!
  // 开头按整行取，末尾再带一句“没贴到哪”；所以上界是 limit 加上那句说明。
  assert.ok(big.text.length <= 200, `单份开头要封在 120 字符左右，实际 ${big.text.length}`)
  assert.ok(big.truncated, '1200 行的文件读开头一段就是没读全')
  assert.ok(s.chars <= 400, `一页总额要封在 400 字符内，实际 ${s.chars}`)
  console.log(`② 读数：单份 ${big.text.length} 字符 · 一页 ${s.chars} 字符 · 截断=${String(big.truncated)}`)
})

test('③ 补读：只认已读过的路径 · 行段并进同一份摘录 · 读全之后 truncated 转假', async (ctx) => {
  const { truth, commit, known } = await repo()
  ctx.after(() => truth.close())
  const s = openRead({ truth, commit, known, budget: { head: 200, total: 200_000, paths: 4, ranges: 3 } })
  await s.read([{ path: 'src/big.ts', from: null, to: null }])
  await s.extend([
    { path: 'src/big.ts', from: 900, to: 950 },
    { path: 'src/a.ts', from: 1, to: 2 }, // 没读过这一份：补读一律不认
  ])
  const big = s.excerpts.find((x) => x.path === 'src/big.ts')!
  assert.ok(big.text.includes('L920 NEEDLE'), '第 920 行要真的贴出来')
  assert.deepEqual(big.shown.at(-1), { from: 900, to: 950 }, '行段逐段记着')
  assert.equal(s.excerpts.some((x) => x.path === 'src/a.ts'), false, '补读不读新文件')

  await s.extend([{ path: 'src/big.ts', from: 1, to: 1200 }])
  const whole = s.excerpts.find((x) => x.path === 'src/big.ts')!
  assert.equal(whole.truncated, false, '整份都贴出来了就不算截断')
  assert.deepEqual(s.unread(), [], '没有没读全的就不记 note')
  console.log(`③ 读数：行段 ${whole.shown.length} 段 · 全文 ${whole.truncated === false ? '读全' : '仍截断'}`)
})

test('④ 自由读的分流：新路径读开头 · 已读的带行段就补读 · 不带行段的重复点名不动账', async (ctx) => {
  const { truth, commit, known } = await repo()
  ctx.after(() => truth.close())
  const s = openRead({ truth, commit, known, budget: { head: 200, total: 200_000, paths: 6, ranges: 6 } })
  await s.ask([{ path: 'src/big.ts', from: null, to: null }])
  const before = s.chars
  await s.ask([{ path: 'src/big.ts', from: null, to: null }])
  assert.equal(s.chars, before, '已读过的路径不带行段再来，什么都不读')
  await s.ask([{ path: 'src/big.ts', from: 900, to: 950 }])
  assert.ok(s.chars > before, '带行段的那一次要补读')
  assert.ok(s.excerpts[0]!.text.includes('NEEDLE'))
  console.log(`④ 读数：${before} → ${s.chars} 字符 · 补读只走行段`)
})
