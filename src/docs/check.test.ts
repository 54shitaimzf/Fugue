// 正文的形状核对：四条会红的判据 + “H1 与 ## 同现只记 note”那一档；`citedOf` 只认提交里真有的路径。
//
// 从 build.ts 搬出来时补的断言：搬之前 ./check.ts 不存在（导入即失败）。判据来自交接单 § 2.1
// 正文完整与复审 R1/R3 的反面：**宿主只判可机械核对的那几条**，内容取舍留给复核。
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkContent, citedOf } from './check.ts'
import type { PageDef, TreeFacts } from './contract.ts'

const DEF = { id: 'p', title: '页', source: 'README.md', audience: '人', role: '读', prompt: '写' } as PageDef
const LONG = '这一段说明这一页要解决的问题，以及读者能从这里得到什么。'.repeat(20)

test('① 四条会红的判据各一例 · H1 与 ## 同现只记 note · citedOf 只认提交里真有的路径', () => {
  assert.throws(() => checkContent(DEF, '   '), /正文是空的/)
  assert.throws(() => checkContent(DEF, '短'), /短于 \d+/)
  assert.throws(() => checkContent(DEF, `# 只有一级标题\n\n${LONG}`), /只写了 H1/)
  assert.throws(() => checkContent(DEF, LONG), /一个章节标题都没有/)

  const notes = checkContent(DEF, `# 一级\n\n${LONG}\n\n## 这一节\n\n${LONG}`)
  assert.equal(notes.length, 1, 'H1 与 ## 同现不拒，但要留一条 note')
  assert.match(notes[0]!, /H1/)

  const facts = { paths: ['src/a.ts', 'design/A.md'] } as unknown as TreeFacts
  assert.deepEqual(citedOf('看 `src/a.ts` 与 `src/b.ts`，还有 `design/A.md`', facts), ['design/A.md', 'src/a.ts'])
  console.log(`① 读数：拒 4 例 · note 1 条（${notes[0]}）· citedOf 2/3 命中`)
})
