// 写作输入那一层：**纯函数 · 三区分得住 · 事实跟着提交走 · 换主题不动内容那一段**。
//
// 判据来自交接单 § 2.5 与 § 1.4：写作上下文的来源指得出来；同一份定义换一版提交，事实跟着
// 变；相同定义与事实下宿主那一半逐字节可复现。
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Materials, TreeFacts } from './contract.ts'
import { pageOf, parseDocs } from './config.ts'
import type { DocsPlan } from './contract.ts'
import { CONTENT_TASK, contextOf, evidenceContextOf, evidenceSystemOf, promptTextOf, systemOf } from './prompt.ts'
import { themeOf } from './theme.ts'

const PLAN: DocsPlan = (() => {
  const p = parseDocs({
    docs: {
      theme: 'primer',
      title: 'Fugue',
      pages: [
        {
          id: 'start',
          title: '开始',
          source: 'README.md',
          audience: '第一次用 Fugue 的人',
          role: '从安装到跑通第一条命令',
          prompt: '先给最短路径',
        },
        { id: 'arch', title: '架构', source: 'design/ARCHITECTURE.md', audience: '维护者', role: '边界', prompt: '讲约束' },
      ],
    },
  })
  assert.ok(p !== null)
  return p
})()

function factsWith(o: { version: string; files: number; commit: string }): TreeFacts {
  return {
    commit: o.commit,
    commitShort: o.commit.slice(0, 12),
    version: o.version,
    files: o.files,
    topDirs: [{ name: 'src', files: o.files - 1 }],
    sources: PLAN.pages.map((p) => ({ id: p.id, source: p.source, sha: `sha-${p.id}`, bytes: 10 })),
    missing: [],
    paths: ['README.md', 'design/ARCHITECTURE.md', 'src/a.ts'],
  }
}

const MATERIALS: Materials = {
  kind: 'round',
  note: '自动收口：取本轮归并与验收的读数',
  round: 'r7',
  contracts: [{ id: 'c1', agent: 'agent/r7/1', commit: 'abc1234', paths: ['src/a.ts'] }],
  verify: { ok: true, passed: 3, failed: 0 },
}

const primer = themeOf('primer')
assert.ok(primer !== null)

test('① 三区：A 是公共合同与视觉语言，B 是这一页的定义来源事实，C 是那一句话', () => {
  const page = pageOf(PLAN, 'start')
  const facts = factsWith({ version: '0.5.1', files: 10, commit: 'aaaa' })
  const A = systemOf(primer)
  const B = contextOf({ page, plan: PLAN, facts, source: '# 读我\n', materials: MATERIALS, excerpts: [] })
  assert.ok(A.includes('只输出 markdown 正文'))
  assert.ok(A.includes('GitHub Primer'))
  assert.ok(B.includes('给谁看（audience）：第一次用 Fugue 的人'))
  assert.ok(B.includes('来源：README.md'))
  assert.ok(B.includes('提交 C：aaaa'))
  assert.ok(B.includes('验收：通过'), '本轮变化要进 B 区')
  assert.ok(!B.includes(CONTENT_TASK), '那一句话只在 C 区')
  assert.ok(CONTENT_TASK.length > 0)
  console.log(`① 读数：A ${A.length} 字符 · B ${B.length} 字符 · C ${CONTENT_TASK.length} 字符`)
})

test('② 逐字节稳定：同样的输入出同样的字节（宿主可复现的那一半）', () => {
  const page = pageOf(PLAN, 'start')
  const facts = factsWith({ version: '0.5.1', files: 10, commit: 'aaaa' })
  const once = contextOf({ page, plan: PLAN, facts, source: 'S', materials: MATERIALS, excerpts: [] })
  const twice = contextOf({ page, plan: PLAN, facts, source: 'S', materials: MATERIALS, excerpts: [] })
  assert.equal(once, twice)
  assert.equal(systemOf(primer), systemOf(primer))
  // 取证那一趟的 A 也稳定，且与正文那一趟不同（两套合同各管一件事）
  assert.equal(evidenceSystemOf(), evidenceSystemOf())
  assert.notEqual(evidenceSystemOf(), systemOf(primer))
  console.log('② 读数：A/B 各调两次逐字节相同；两趟的 A 互不相同')
})

test('③ 事实跟着提交走：B 区随版本 · 文件数 · 提交变化，A 区不动', () => {
  const page = pageOf(PLAN, 'start')
  const b1 = contextOf({
    page,
    plan: PLAN,
    facts: factsWith({ version: '0.5.1', files: 10, commit: 'aaaa' }),
    source: 'S',
    materials: MATERIALS,
    excerpts: [],
  })
  const b2 = contextOf({
    page,
    plan: PLAN,
    facts: factsWith({ version: '0.5.2', files: 11, commit: 'bbbb' }),
    source: 'S',
    materials: MATERIALS,
    excerpts: [],
  })
  assert.notEqual(b1, b2)
  assert.ok(b2.includes('版本：0.5.2') && b2.includes('完整树文件数：11'))
  // 负对照：同一份事实两次 -> 相同（差异不是随便来的）
  assert.equal(
    b1,
    contextOf({ page, plan: PLAN, facts: factsWith({ version: '0.5.1', files: 10, commit: 'aaaa' }), source: 'S', materials: MATERIALS, excerpts: [] }),
  )
  console.log('③ 读数：B 区随提交变化 · 同提交两次相同')
})

test('④ 换主题：A 区变（视觉语言），B 区不变（内容与事实不随主题变）', () => {
  const page = pageOf(PLAN, 'start')
  const facts = factsWith({ version: '0.5.1', files: 10, commit: 'aaaa' })
  const args = { page, plan: PLAN, facts, source: 'S', materials: MATERIALS, excerpts: [] }
  const carbon = themeOf('carbon')
  assert.ok(carbon !== null)
  assert.notEqual(systemOf(primer), systemOf(carbon))
  assert.equal(contextOf(args), contextOf(args), 'B 区里没有主题这一栏')
  assert.ok(!contextOf(args).includes('GitHub Primer'))
  console.log('④ 读数：A 区随主题变化 · B 区逐字节不变（内容与操作含义不随主题改）')
})

test('⑤ 取证那一步：B 区给完整树索引与来源，并只要一份 JSON 清单', () => {
  const page = pageOf(PLAN, 'start')
  const facts = factsWith({ version: '0.5.1', files: 10, commit: 'aaaa' })
  const B = evidenceContextOf({ page, plan: PLAN, facts, source: '# 读我\n' })
  assert.ok(B.includes('src/a.ts'), '索引里有真路径')
  assert.ok(B.includes('最多 12 条'), '上界写进话里')
  assert.ok(evidenceSystemOf().includes('{"paths"'))
  console.log(`⑤ 读数：索引 ${facts.paths.length} 条 · 取证 B ${B.length} 字符`)
})

test('⑥ `docs prompt` 打出来的那一份：三段齐全，且如实说明摘录那一栏为什么是空的', () => {
  const page = pageOf(PLAN, 'start')
  const facts = factsWith({ version: '0.5.1', files: 10, commit: 'aaaa' })
  const text = promptTextOf({ page, plan: PLAN, facts, source: '# 读我\n', theme: primer, materials: MATERIALS })
  for (const want of ['# A 区', '# B 区', '# C 区', CONTENT_TASK, '这一条命令不调模型']) {
    assert.ok(text.includes(want), `缺：${want}`)
  }
  console.log(`⑥ 读数：${text.split('\n').length} 行 · ${text.length} 字符 · 三段齐全`)
})
