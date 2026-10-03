// 0.2.10 ② 的挂载点：配置键文档校验（`tools/check-config-keys.js`）挂在 **fast 组**里跑，
// 而且它自己不许恒真。挂法照 `src/tools/w10.test.ts` ⑤ 那条（spawn 一个 `tools/*.js`，
// 名字与路径写死在这里）——CI 那边一个字不用改，两档自然都跑到。
//
//   ① 真状态那一趟：退出码 0 · 不印 FAIL · 两半读数都在（键域那一半 + 条数那一半）
//   ② 端到端负对照：换一份**顶层键拼错**的文档 → 当场红（证明它读的是给它的那份文件，
//      不是自己搓的夹具）
//   ③ 端到端负对照：把「config 有 N 条」改成 N-1 → 当场红
//   ④ 端到端负对照：规格散文（架构 § 15.3.a 那句「顶层键域是闭的」）里删掉一个顶层键
//      → 当场红。0.2.10 就是在这里漏了 `ui` 漂了一个版本——这条负对照量的正是那个缺口。
//   ⑤ 规格散文那一整段找不到也当场红（闸不许沉默）
//   ⑥ 规格散文里**多**一个键域里没有的顶层键 → 也当场红（另一个方向；那等于规格许了一个
//      读面会拒的键）
//
// 跑法：cd ~/fugue && node --test test/check-config-keys.test.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmpDir } from './helpers/tmp.ts'

const REPO = join(import.meta.dirname, '..')
const TOOL = join(REPO, 'tools', 'check-config-keys.js')
const README = join(REPO, 'README.md')
const ARCH = join(REPO, 'design', 'ARCHITECTURE.md')

function run(docs: readonly string[] = []): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TOOL, ...docs], { cwd: REPO, encoding: 'utf8' })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 仓库里那份 README 改一处，落在临时目录里当输入（仓库里那份一个字节不动，跑完自己删）。 */
function readmeWith(fix: (text: string) => string): string {
  const before = readFileSync(README, 'utf8')
  const after = fix(before)
  assert.notEqual(after, before, '那一处没改到——这条负对照本身是空的')
  const file = join(tmpDir('fugue-keys-'), 'README.md')
  writeFileSync(file, after)
  return file
}

/** 仓库里那份架构篇改一处，落在临时目录里当输入（仓库里那份一个字节不动）。 */
function archWith(fix: (text: string) => string): string {
  const before = readFileSync(ARCH, 'utf8')
  const after = fix(before)
  assert.notEqual(after, before, '那一处没改到——这条负对照本身是空的')
  const file = join(tmpDir('fugue-keys-arch-'), 'ARCHITECTURE.md')
  writeFileSync(file, after)
  return file
}

/** 只留读数那几行（失败时的报文在 stdout 里，断言自己会打印全文）。 */
const readings = (out: string): string =>
  out.split('\n').filter((l) => /^\s+(ok|info|FAIL)/.test(l)).map((l) => l.trim()).join(' | ')

test('① 真状态那一趟：退出码 0 · 不印 FAIL · 两半读数都在', () => {
  const r = run()
  assert.equal(r.status, 0, `校验器退非零：\n${r.stdout}\n${r.stderr}`)
  assert.doesNotMatch(r.stdout, /FAIL/, '校验器自己报了 FAIL')
  assert.match(r.stdout, /全部通过/)
  assert.match(r.stdout, /教过 \d+ 处键/, '键域那一半的读数在')
  assert.match(r.stdout, /与实现的 \d+ 个 verb 相符/, '条数那一半的读数在')
  console.log(`① 读数：${readings(r.stdout)}`)
})

test('② 端到端负对照：文档里塞一条顶层键拼错的示例 → 当场红', () => {
  const file = readmeWith((t) => t.replace(/fugue config set round\.id r1/, "fugue config set action.test '…'"))
  const r = run([file])
  assert.notEqual(r.status, 0, `拼错的顶层键没被抓住：\n${r.stdout}`)
  assert.match(r.stdout, /FAIL/)
  assert.match(r.stdout, /顶层键 action/, '报文要点名那个顶层段')
  assert.match(r.stdout, /action\.test/, '报文要点名那个键')
  console.log(`② 负对照读数：${readings(r.stdout)}`)
})

test('③ 端到端负对照：把「config 有 N 条」写成 N-1 → 当场红', () => {
  const file = readmeWith((t) => t.replace(/(`config` 有 )(\d+)( 条)/, (_, a, n, c) => `${a}${Number(n) - 1}${c}`))
  const r = run([file])
  assert.notEqual(r.status, 0, `数错了没被抓住：\n${r.stdout}`)
  assert.match(r.stdout, /FAIL/)
  assert.match(r.stdout, /数成「config 有 /, '报文要点名那个数')
  console.log(`③ 负对照读数：${readings(r.stdout)}`)
})

test('④ 端到端负对照：规格散文里删掉一个顶层键 → 当场红', () => {
  const file = archWith((t) => t.replace(' · ui`', '`'))
  const r = run(['--arch', file])
  assert.notEqual(r.status, 0, `散文少一个键没被抓住：\n${r.stdout}`)
  assert.match(r.stdout, /FAIL/)
  assert.match(r.stdout, /散文里少了 .*ui/, '报文要点名少了哪一个键')
  console.log(`④ 负对照读数：${readings(r.stdout)}`)
})

test('⑤ 规格散文那一整段找不到也当场红（闸不许沉默）', () => {
  const file = archWith((t) => t.replace('顶层键域是闭的', '顶层键名是开放的那一批'))
  const r = run(['--arch', file])
  assert.notEqual(r.status, 0, `那一整段没了还绿着：\n${r.stdout}`)
  assert.match(r.stdout, /找不到「顶层键域是闭的/, '报文要说是那一段找不到')
  console.log(`⑤ 负对照读数：${readings(r.stdout)}`)
})

test('⑥ 端到端负对照：规格散文里多一个键域里没有的顶层键 → 当场红', () => {
  const file = archWith((t) => t.replace(' · toolchain · ui`', ' · toolchain · ui · nosuchkey`'))
  const r = run(['--arch', file])
  assert.notEqual(r.status, 0, `散文多写一个键没被抓住：\n${r.stdout}`)
  assert.match(r.stdout, /散文里多了 .*nosuchkey/, '报文要点名多出来的是哪一个（读面会拒它）')
  console.log(`⑥ 负对照读数：${readings(r.stdout)}`)
})
