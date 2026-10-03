// `config ls` 的断言：它列的是**合法顶层键域**——`src/config.ts` 的 `TOP_LEVEL_KEYS` 是唯一真源，
// 所以对答案从那一份 import，测试里不手抄第二份清单（手抄的那一份漂了不会报错）。
//
//   ① 人面一行一键，逐字同序等于 `TOP_LEVEL_KEYS`
//   ② `--json` 那一面是数组（给脚本用），逐字等于同一份
//   ③ 只读：空目录里跑完，磁盘上一个字节不多（配置是输入不是状态，与 show|get|set 同一纪律）
//   ④ 未知 verb 的提示句把四条都印出来（含 `ls`），退出码 2
//
// 负对照（红得起来才是断言）：
//   把实现换成手抄的字面量并漏一个键（例如少写 `ui`）→ ① 当场红——那正是这条断言要抓的变异；
//   把 `--json` 那一面从数组改成对象 → ② 红。
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
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
