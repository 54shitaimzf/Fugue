// **措辞当 API**（可读性五件之一）：机器要 grep 的那几句文案只有一处定义。
// 出处：ROADMAP § 5 的 0.4.1 行（「词表同义两处定义必报」是验收格原句）· 架构 § 8.6（判据是那几句
// 文案，不是 errno）。
//
// 判据住在 `tools/check-phrases.ts`（一处），这里跑它，并**各配一条负对照**——不然"扫过了"这句话
// 与"一句都没扫"长得一样。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { PHRASES, PHRASE_TEXTS } from '../src/phrases.ts'
import { problemsIn, scanRepo, secondDefinitions, synonymsIn } from '../tools/check-phrases.ts'

const REPO = join(import.meta.dirname, '..')
const TOOL = join(REPO, 'tools', 'check-phrases.ts')

test('词表：每一句在表外一处都没有（`src/` 与 `test/` 全扫）', () => {
  const files = scanRepo()
  assert.ok(files.length > 100, `扫到的文件太少（${files.length}）——发现模式坏了？`)
  const bad = problemsIn(files)
  assert.deepEqual(bad, [], `同一句文案两处定义：\n${bad.join('\n')}`)
  console.log(`读数：扫 ${files.length} 个 .ts · ${PHRASE_TEXTS.length} 句文案各一处定义`)
})

test('负对照：表外抄一句 → 当场报（那条断言不是空话）', () => {
  const files = [
    { path: 'src/别处.ts', text: `const x = '${PHRASES.resumeHead}'\n` },
    { path: 'src/phrases.ts', text: `const home = '${PHRASES.resumeHead}'\n` },
  ]
  const hit = secondDefinitions(files, PHRASE_TEXTS)
  assert.equal(hit.length, 1, `该只报表外那一处：${JSON.stringify(hit)}`)
  assert.match(hit[0] as string, /src\/别处\.ts:1/)
  // 表自己那一处不算第二处定义。
  assert.equal(hit.some((h) => h.startsWith('src/phrases.ts')), false)
})

test('负对照：表里同义两格 → 当场报（换个键名不解决问题）', () => {
  assert.deepEqual(synonymsIn({ a: '一样的一句', b: '另一句' }), [])
  const hit = synonymsIn({ a: '一样的一句', b: '一样的一句' })
  assert.equal(hit.length, 1)
  assert.match(hit[0] as string, /a 与 b/)
})

test('命令面：`node tools/check-phrases.ts` 退 0 并把读数印出来（跑的是同一份判据）', () => {
  const r = spawnSync(process.execPath, [TOOL], { encoding: 'utf8' })
  assert.equal(r.status, 0, String(r.stderr))
  assert.match(String(r.stdout), /各一处定义/)
  console.log(String(r.stdout).trim())
})
