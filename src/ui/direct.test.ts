// **界面读账只经事件通道**（0.4.3 第一幕 ①）：判据住在 `tools/check-ui-direct.ts`（一处），
// 这里跑它，并各配负对照——不然"扫过了"这句话与"一份都没扫"长得一样。
//
// 出处：路线图 § 5 的 0.4.3 行（「客户端化之后 TUI 零直连……那条 lint 式断言的覆盖面要含人说的话
// 那一条读源」）· 架构 § 9.7（观察不得影响状态）· § 9.11（事件通道）。
//
// 三样「真有东西」的对照，缺一条这一份就是空话：
//   · **闭包真扫到了东西**：界面那 18 个根闭出六十来份模块，而且里面有 `ui/follow.ts`（跟随那一格）
//     与 `serve/source.ts`（事件通道那一份）——闭包要是空的，下面"零直连"当然成立；
//   · **负对照一 · 塞一条直连 import 当场红**（`src/log/log.ts` 进闭包）；
//   · **负对照二 · 塞一条 `.fugue/session` 直读当场红**，而把它点名进 `LEGACY_READERS` 就放行
//     ——这一条演示的正是 0.5.0 那个"删点名即自动加严"的开关。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { LEGACY_READERS, closureOf, problemsIn, readRepo, uiModules } from '../../tools/check-ui-direct.ts'

const REPO = join(import.meta.dirname, '..', '..')
const TOOL = join(REPO, 'tools', 'check-ui-direct.ts')

/** 把某一份模块的正文换成新的一份（其余原样）——负对照就是往真树上塞一条。 */
function withText(mods: ReturnType<typeof readRepo>, path: string, text: string) {
  return mods.map((m) => (m.path === path ? { path: m.path, text } : m))
}

test('① 界面读账只经事件通道：账的直连模块进不来 · 宿主私有的两个前缀一处都没有', () => {
  const mods = readRepo()
  const entries = uiModules(mods)
  const bad = problemsIn(mods, entries)
  assert.deepEqual(bad, [], `界面这一侧的闭包不干净：\n${bad.join('\n')}`)
  const closure = closureOf(mods, entries)
  // **真有东西**：闭包得真是那一片（下面那条"零直连"才有内容）。
  assert.ok(entries.length >= 15, `界面那几份根太少（${entries.length}）——发现模式坏了？`)
  assert.ok(closure.length >= 40, `闭包只有 ${closure.length} 份——走不动的话这条断言是空话`)
  for (const must of ['src/ui/console.ts', 'src/ui/follow.ts', 'src/serve/source.ts']) {
    assert.ok(closure.includes(must), `${must} 该在闭包里（它是这条读法的一段）`)
  }
  for (const never of ['src/log/log.ts', 'src/probe/watch.ts']) {
    assert.equal(closure.includes(never), false, `${never} 不该在闭包里`)
  }
  console.log(
    `① 读数：${entries.length} 个根 · 闭包 ${closure.length} 份 · 直连模块 0 份 · 点名放行 ${LEGACY_READERS.length} 处`,
  )
})

test('② 负对照 · 塞一条直连 import：闭包里多出 `log/log.ts`，当场红（这条断言抓得住变异）', () => {
  const mods = readRepo()
  const entries = uiModules(mods)
  const broken = withText(
    mods,
    'src/ui/console.ts',
    `import { openLog } from '../log/log.ts'\n` + (mods.find((m) => m.path === 'src/ui/console.ts')?.text ?? ''),
  )
  const bad = problemsIn(broken, entries)
  assert.ok(bad.length > 0, '塞进来的那条直连 import 没被报出来——这条 lint 是空话')
  assert.match(bad.join('\n'), /src\/log\/log\.ts/, `报出来的该点名那个模块：${JSON.stringify(bad)}`)
  // 原树照旧干净：上一条红的只是塞进去的那一份。
  assert.deepEqual(problemsIn(mods, entries), [])
})

test('③ 负对照 · 塞一条 `.fugue/session` 直读：当场红；点名进放行表就放行（0.5.0 那个开关）', () => {
  const mods = readRepo()
  const entries = uiModules(mods)
  const here = 'src/ui/console.ts'
  const source = mods.find((m) => m.path === here)?.text ?? ''
  const broken = withText(mods, here, `const p = '.fugue/session/r1.jsonl'\n` + source)
  const red = problemsIn(broken, entries)
  assert.ok(red.some((b) => b.includes('.fugue/session')), `该报出那条遗留直读：${JSON.stringify(red)}`)
  // **点名即放行**：`LEGACY_READERS` 是那条读源唯一合法的住处；0.5.0 把它收进 serve 的读口之后
  // 删掉这一行，判据自动回到"一处都不许"。
  assert.deepEqual(problemsIn(broken, entries, { legacyReaders: [here] }), [])
  assert.deepEqual(LEGACY_READERS, [], '0.4.3 不新开这条直连，所以放行表今天是空的')
})

test('④ 命令面：`node tools/check-ui-direct.ts` 退 0 并把读数印出来（跑的是同一份判据）', () => {
  const r = spawnSync(process.execPath, [TOOL], { encoding: 'utf8' })
  assert.equal(r.status, 0, `lint 该退 0：\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /账的直连模块 0 份/, `读数该把它说出来：${r.stdout}`)
  console.log(`④ 读数：${r.stdout.trim()}`)
})
