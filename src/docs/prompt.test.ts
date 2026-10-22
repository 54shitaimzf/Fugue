// 写作输入那一层：**纯函数 · 三区分得住 · 共享前缀逐字节相同 · 事实跟着提交走**。
//
// 判据来自交接单 § 2.5 与 § 1.4，以及文档线升级计划 § 阶段 3：A 区是这一批的公共事实（一次装配、
// 所有调用共用），B 区是这一趟的合同与这一页的材料，C 区是那一句话。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { Materials, TreeFacts } from './contract.ts'
import { pageOf, parseDocs } from './config.ts'
import type { DocsPlan } from './contract.ts'
import { CONTENT_TASK, EVIDENCE_MAX, chainOf, promptTextOf, sharedOf } from './prompt.ts'
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

/** 七页的那一份：共享前缀是"跨页相同"，两页看不出问题，七页才像真的一批。 */
const PLAN7: DocsPlan = (() => {
  const ids = ['start', 'arch', 'flow', 'api', 'config', 'ops', 'faq']
  const p = parseDocs({
    docs: {
      theme: 'primer',
      title: 'Fugue',
      pages: ids.map((id) => ({ id, title: `第 ${id} 页`, source: `doc/${id}.md`, audience: '读者', role: '读懂这一块', prompt: '讲清楚' })),
    },
  })
  assert.ok(p !== null)
  return p
})()

function factsOf(plan: DocsPlan, o: { version: string; files: number; commit: string }): TreeFacts {
  return {
    commit: o.commit,
    commitShort: o.commit.slice(0, 12),
    version: o.version,
    files: o.files,
    topDirs: [{ name: 'src', files: o.files - 1 }],
    sources: plan.pages.map((p) => ({ id: p.id, source: p.source, sha: `sha-${p.id}`, bytes: 10 })),
    missing: [],
    paths: ['README.md', 'design/ARCHITECTURE.md', 'src/a.ts'],
  }
}

function factsWith(o: { version: string; files: number; commit: string }): TreeFacts {
  return factsOf(PLAN, o)
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

test('① 三区：A 是这一批的公共事实，B 是合同与这一页，C 是那一句话', () => {
  const page = pageOf(PLAN, 'start')
  const facts = factsWith({ version: '1.2.3', files: 10, commit: 'aaaa' })
  const words = chainOf(facts).writing({ page, plan: PLAN, theme: primer, source: '# 读我\n', materials: MATERIALS, excerpts: [] })
  assert.ok(words.shared.includes('提交 C：aaaa'), '事实在 A 区')
  assert.ok(words.shared.includes('完整树路径索引'), '索引也在 A 区')
  assert.ok(words.page.includes('只输出 markdown 正文'), '写作合同在 B 区')
  assert.ok(words.page.includes('GitHub Primer'), '视觉语言在 B 区')
  assert.ok(words.page.includes('给谁看（audience）：第一次用 Fugue 的人'))
  assert.ok(words.page.includes('来源：README.md'))
  assert.ok(words.page.includes('验收：通过'), '本轮变化要进 B 区')
  assert.equal(words.page.includes('完整树路径索引'), false, 'B 区不再贴索引（那是缓存前缀的事）')
  assert.ok(!words.page.includes(CONTENT_TASK), '那一句话只在 C 区')
  assert.equal(words.task, CONTENT_TASK)
  console.log(`① 读数：A ${words.shared.length} 字符 · B ${words.page.length} 字符 · C ${words.task.length} 字符`)
})

test('② 逐字节稳定：同样的输入出同样的字节；取证与写作的 A 区是同一份', () => {
  const page = pageOf(PLAN, 'start')
  const facts = factsWith({ version: '1.2.3', files: 10, commit: 'aaaa' })
  const chain = chainOf(facts)
  const writing = { page, plan: PLAN, theme: primer, source: 'S', materials: MATERIALS, excerpts: [] }
  const once = chain.writing(writing)
  const twice = chainOf(facts).writing(writing)
  assert.deepEqual(once, twice)
  assert.equal(chain.writing(writing).page, once.page)
  // 取证与写作发的是同一份 A 区字节（前缀对齐的那一条）
  assert.equal(chain.evidence({ page, plan: PLAN, source: 'S' }).shared, chain.shared)
  assert.equal(chain.ranges({ page, excerpts: [] }).shared, chain.shared)
  assert.equal(sharedOf(facts), chain.shared)
  console.log(`② 读数：A 区 ${chain.shared.length} 字符 · 三趟同源 · 两次装配逐字节相同`)
})

test('③ 事实跟着提交走：A 区随版本与文件数变，B 区一个字都不动', () => {
  const page = pageOf(PLAN, 'start')
  const writing = { page, plan: PLAN, theme: primer, source: 'S', materials: MATERIALS, excerpts: [] }
  const a1 = chainOf(factsWith({ version: '1.2.3', files: 10, commit: 'aaaa' })).writing(writing)
  const a2 = chainOf(factsWith({ version: '1.2.4', files: 11, commit: 'bbbb' })).writing(writing)
  assert.notEqual(a1.shared, a2.shared)
  assert.ok(a2.shared.includes('版本：1.2.4') && a2.shared.includes('完整树文件数：11'))
  assert.equal(a1.page, a2.page, 'B 区里没有事实这一栏')
  console.log('③ 读数：A 区随提交变 · B 区逐字节相同')
})

test('④ 换主题：B 区变（视觉语言），A 区不动', () => {
  const page = pageOf(PLAN, 'start')
  const facts = factsWith({ version: '1.2.3', files: 10, commit: 'aaaa' })
  const carbon = themeOf('carbon')
  assert.ok(carbon !== null)
  const chain = chainOf(facts)
  const quoted = (theme: NonNullable<ReturnType<typeof themeOf>>) => chain.writing({ page, plan: PLAN, theme, source: 'S', materials: MATERIALS, excerpts: [] })
  assert.notEqual(quoted(primer).page, quoted(carbon).page)
  assert.equal(quoted(primer).shared, quoted(carbon).shared)
  assert.equal(quoted(carbon).page.includes('GitHub Primer'), false)
  console.log('④ 读数：B 区随主题变化 · A 区逐字节不变')
})

test('⑤ 取证那一趟：A 区给完整树索引，B 区给这一页并要求一份 JSON 清单', () => {
  const page = pageOf(PLAN, 'start')
  const facts = factsWith({ version: '1.2.3', files: 10, commit: 'aaaa' })
  const ask = chainOf(facts).evidence({ page, plan: PLAN, source: '# 读我\n' })
  assert.ok(ask.shared.includes('src/a.ts'), '索引里有真路径')
  assert.ok(ask.shared.includes('完整树路径索引'))
  assert.ok(ask.page.includes('{"paths"'))
  assert.ok(ask.page.includes(`最多 ${EVIDENCE_MAX} 条`), '上界写进话里')
  assert.equal(ask.page.includes('完整树路径索引'), false, 'B 区不重复索引')
  console.log(`⑤ 读数：索引 ${facts.paths.length} 条在 A 区 · 取证 B ${ask.page.length} 字符`)
})

test('⑥ 七页一批：所有页、所有趟的共享前缀 sha 相同，且里面没有一个页 id', () => {
  const facts = factsOf(PLAN7, { version: '1.2.3', files: 10, commit: 'aaaa' })
  const chain = chainOf(facts)
  const shas = new Set<string>()
  for (const def of PLAN7.pages) {
    const source = `# ${def.title}\n\n正文。`
    const writing = chain.writing({ page: def, plan: PLAN7, theme: primer, source, materials: MATERIALS, excerpts: [] })
    const evidence = chain.evidence({ page: def, plan: PLAN7, source })
    assert.equal(writing.shared, evidence.shared, `${def.id}：取证与写作的 A 区要逐字节相同`)
    assert.equal(writing.page.includes('完整树路径索引'), false, `${def.id}：B 区不贴索引`)
    // 负对照：把页面 id 拼进 sharedOf，这一条就红（七页会给出七个不同的前缀）
    assert.equal(writing.shared.includes(def.id), false, `${def.id}：公共前缀里不许有逐页的东西`)
    shas.add(createHash('sha256').update(writing.shared).digest('hex'))
  }
  assert.equal(shas.size, 1, `七页应当共用一个前缀，实际 ${shas.size} 个`)
  console.log(`⑥ 读数：7 页 × 2 趟共 ${shas.size} 个前缀 sha · ${chain.shared.length} 字符`)
})

test('⑦ `docs prompt` 打出来的那一份：三段齐全，且如实说明摘录那一栏为什么是空的', () => {
  const page = pageOf(PLAN, 'start')
  const facts = factsWith({ version: '1.2.3', files: 10, commit: 'aaaa' })
  const text = promptTextOf({ page, plan: PLAN, facts, source: '# 读我\n', theme: primer, materials: MATERIALS })
  for (const want of ['# A 区', '# B 区', '# C 区', CONTENT_TASK, '这一条命令不调模型', '完整树路径索引', '只输出 markdown 正文']) {
    assert.ok(text.includes(want), `缺：${want}`)
  }
  console.log(`⑦ 读数：${text.split('\n').length} 行 · ${text.length} 字符 · 三段齐全`)
})

test('⑧ 摘录带行段与截断：B 区说得出"读到第几行、还有没有没读的"（复审 R3）', () => {
  const page = pageOf(PLAN, 'start')
  const facts = factsWith({ version: '1.2.3', files: 10, commit: 'aaaa' })
  const excerpt = {
    path: 'src/a.ts',
    text: '…原文…',
    bytes: 100,
    lines: 900,
    chars: 30000,
    shown: [{ from: 1, to: 400 }, { from: 700, to: 760 }],
    truncated: true,
  }
  const chain = chainOf(facts)
  const B = chain.writing({ page, plan: PLAN, theme: primer, source: 'S', materials: MATERIALS, excerpts: [excerpt] }).page
  assert.ok(B.includes('第 1–400 行') && B.includes('第 700–760 行'), '贴出来的行段要写明')
  assert.ok(B.includes('还有内容没读（共 900 行）'), '截断要如实说')
  // 会话进 B 区；手动入口没有这一栏
  const withSession = chain.writing({
    page,
    plan: PLAN,
    theme: primer,
    source: 'S',
    materials: { ...MATERIALS, session: { path: '.fugue/session/r7.jsonl', records: 3, chars: 120, text: '人：保留旧参数' } },
    excerpts: [],
  }).page
  assert.ok(withSession.includes('本轮会话') && withSession.includes('保留旧参数'))
  assert.ok(!B.includes('本轮会话'))
  console.log(`⑧ 读数：摘录行段 2 段 · 截断说明在 · 会话 ${withSession.includes('保留旧参数') ? '进 B 区' : '缺失'}`)
})
