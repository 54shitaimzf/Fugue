// `config ls` 的断言：它列的是**合法顶层键域**——`src/config.ts` 的 `TOP_LEVEL_KEYS` 是唯一真源，
// 所以对答案从那一份 import，测试里不手抄第二份清单（手抄的那一份漂了不会报错）。
//
//   ① 人面一行一键，逐字同序等于 `TOP_LEVEL_KEYS`
//   ② `--json` 那一面是数组（给脚本用），逐字等于同一份
//   ③ 只读：空目录里跑完，磁盘上一个字节不多（配置是输入不是状态，与 show|get|set 同一纪律）
//   ④ 未知 verb 的提示句把四条都印出来（含 `ls`），退出码 2
//   ⑤ 多余位置参数当场判用法错（2）；坏配置下 `ls` 照旧列键域、`show` 拒——两面对照
//
// 负对照（红得起来才是断言）：
//   把实现换成手抄的字面量并漏一个键（例如少写 `ui`）→ ① 当场红——那正是这条断言要抓的变异；
//   把 `--json` 那一面从数组改成对象 → ② 红；
//   把 `ls` 那一支的多余参数判断删掉 → ⑤ 红（`config ls extra` 又变回静默退 0）。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { TOP_LEVEL_KEYS } from '../config.ts'
import { runCli } from '../../test/helpers/run-cli.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'

test('① 人面一行一键，与 TOP_LEVEL_KEYS 逐字同序', async () => {
  const root = tmpDir('fugue-config-ls-')
  const r = await runCli(['--root', root, 'config', 'ls'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stderr, '')
  const lines = r.stdout.split('\n').filter((l) => l !== '')
  assert.deepEqual(lines, [...TOP_LEVEL_KEYS], '一行一键、次序照那一份；少一个键或多一行都算漂')
  console.log(`① 读数：${lines.length} 行 —— ${lines.join(' · ')}`)
})

test('② --json 那一面是数组，逐字等于 TOP_LEVEL_KEYS', async () => {
  const root = tmpDir('fugue-config-ls-json-')
  const r = await runCli(['--root', root, '--json', 'config', 'ls'])
  assert.equal(r.code, 0, r.stderr)
  const got = JSON.parse(r.stdout)
  assert.ok(Array.isArray(got), `--json 那一面该是数组：${r.stdout.trim()}`)
  assert.deepEqual(got, [...TOP_LEVEL_KEYS])
  console.log(`② 读数：${r.stdout.trim()}`)
})

test('③ 只读：空目录里跑完，磁盘上一个字节不多', async () => {
  const root = tmpDir('fugue-config-ls-ro-')
  assert.deepEqual(readdirSync(root), [])
  const r = await runCli(['--root', root, 'config', 'ls'])
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(readdirSync(root), [], '它不读配置、不建视图、不落盘——目录照旧是空的')
  assert.equal(existsSync(join(root, '.fugue')), false)
  console.log('③ 读数：目录跑前跑后都是空的（没有 .fugue/）')
})

test('④ 未知 verb 的提示句把四条都印出来（含 ls），退出码 2', async () => {
  const root = tmpDir('fugue-config-ls-usage-')
  const r = await runCli(['--root', root, 'config', 'nope'])
  assert.equal(r.code, 2, '用法错是 2（与「做不成」的 1 分开）')
  assert.equal(r.stdout, '', '用法错不写 stdout')
  assert.match(r.stderr, /config 需要 ls\|show\|get\|set，收到：nope/)
  console.log(`④ 读数：${r.stderr.split('\n')[0]}`)
})

test('⑤ 多余的位置参数当场判用法错；配置读不动时它照样列得出键域', async () => {
  const root = tmpDir('fugue-config-ls-args-')
  // 多余位置参数一律用法错（2）：这一支一次配置都不读，不会有后面的读把它拦下来——不判的话
  // `config ls show` 会静默吐出一张键表，看着像成功。
  for (const extra of [['extra'], ['one', 'two']]) {
    const r = await runCli(['--root', root, 'config', 'ls', ...extra])
    assert.equal(r.code, 2, `用法错是 2：「config ls ${extra.join(' ')}」`)
    assert.equal(r.stdout, '', '用法错不写 stdout')
    assert.match(r.stderr, /config ls 不接受位置参数/)
  }
  const j = await runCli(['--root', root, '--json', 'config', 'ls', 'extra'])
  assert.equal(j.code, 2, '--json 那一面同样是用法错')
  assert.equal(j.stdout, '')
  assert.equal(JSON.parse(j.stderr).code, 2, '--json 那一面用法错是一行 JSON（code 2）')
  // 坏配置：`ls` 报的是键域、不是现值，所以它连配置都不读——坏配置下照样列得出这张清单；
  // 读配置的 `show` 在同一份坏配置下照旧拒。两面的差别正是这一条。
  mkdirSync(join(root, '.fugue'), { recursive: true })
  writeFileSync(join(root, '.fugue', 'config'), '{')
  const listed = await runCli(['--root', root, 'config', 'ls'])
  assert.equal(listed.code, 0, `ls 不读配置，坏配置下也该列得出键域：${listed.stderr}`)
  assert.deepEqual(listed.stdout.split('\n').filter((l) => l !== ''), [...TOP_LEVEL_KEYS])
  const shown = await runCli(['--root', root, 'config', 'show'])
  assert.equal(shown.code, 1, '同一份坏配置，show 读它，所以拒——退出码 1（「做不成」那一档）')
  console.log(`⑤ 读数：多余参数退 2 · 坏配置下 ls 退 ${listed.code} / show 退 ${shown.code}`)
})
