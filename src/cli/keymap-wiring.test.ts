// 清障批 ⑧ 接线的断言：`ui.keys` 从配置到按键表的那条路——写那面（`config set` 过 `keymapOf`）
// 把配不了的挡在门外；读那面把配错的逐格照缺省走、并报出为什么；形状坏了整份拒载（与"没配过"分开）。
//
// 负对照（红得起来才是断言）：
//   ① 配一个认不出的键名 / 一个表里没有的动作 → `config set` 拒绝（退出码非 0，报出原因）
//   ② 手改文件塞一个认不出的键名 → `keymapOf` 报一条 problem，那一格照缺省（rows 与 KEYMAP 同格相等）
//   ③ `ui.keys` 形状坏 → `readConfig` 整份拒绝（ConfigError），不是静默空表
//   ⑥ 接线在场：`ui/console.ts` 把配置造出的那一份递给 openKeys 与提示行——删掉那一档必红
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { configFileOf, ConfigError, readConfig } from '../config.ts'
import { config } from './cmd/config.ts'
import { hintLineOf, KEYMAP, keymapOf } from '../ui/keymap.ts'

const CLI = fileURLToPath(new URL('./fugue.ts', import.meta.url))
const SYS = tmpDir('fugue-keymap-sys-')

async function rootOf(): Promise<string> {
  const root = tmpDir('fugue-keymap-')
  await mkdir(join(root, '.fugue'), { recursive: true })
  return root
}

test('① 写得进、读得回：好键串过 set → 配置里有 → keymapOf 零 problem、提示行跟着走', async () => {
  const root = await rootOf()
  const rc = await config(root, new Map(), ['set', 'ui.keys.pageUp', 'Ctrl-B'], false)
  assert.equal(rc, 0, 'config set 退出码')
  const over = (await readConfig(root, SYS)).ui as Record<string, unknown>
  assert.deepEqual(over.keys, { pageUp: 'Ctrl-B' }, '配置里落的就是那一格')
  const km = keymapOf({ pageUp: 'Ctrl-B' })
  assert.equal(km.problems.length, 0, 'problems 为空')
  assert.deepEqual(km.rows.find((r) => r.action === 'pageUp')?.keys, ['Ctrl-B'], '那一格换成了新键')
  assert.notEqual(hintLineOf(km), hintLineOf(KEYMAP), '提示行不再与缺省同一串')
})

test('② 写那面拦得住：认不出的键名与动作 id 当场拒（真 CLI 跨进程，报文可读）', () => {
  const root = tmpDir('fugue-keymap-rej-')
  const bad1 = spawnSync(process.execPath, [CLI, '--root', root, 'config', 'set', 'ui.keys.submit', 'NoSuchKey'], {
    encoding: 'utf8', input: '', env: { ...process.env, FUGUE_SYSTEM_DIR: SYS },
  })
  assert.notEqual(bad1.status, 0, '认不出的键名：退出码非 0')
  assert.ok(`${bad1.stdout}${bad1.stderr}`.includes('认不出来'), '报文说得出为什么')
  const bad2 = spawnSync(process.execPath, [CLI, '--root', root, 'config', 'set', 'ui.keys.not_an_action', 'Ctrl-B'], {
    encoding: 'utf8', input: '', env: { ...process.env, FUGUE_SYSTEM_DIR: SYS },
  })
  assert.notEqual(bad2.status, 0, '表里没有的动作：退出码非 0')
  assert.ok(`${bad2.stdout}${bad2.stderr}`.includes('没有这个动作'), '报文点名动作')
})

test('③ 整份对象也过同一把尺：混一格坏的拒 · 两个动作抢同一个键拒 · 全好的收', async () => {
  const root = await rootOf()
  const mixed = await config(root, new Map(), ['set', 'ui.keys', '{"pageUp":"Ctrl-B","submit":"NoSuchKey"}'], false)
  assert.notEqual(mixed, 0, '混了一格认不出的键名：整组拒')
  const clash = await config(root, new Map(), ['set', 'ui.keys', '{"pageUp":"Ctrl-B","pageDown":"Ctrl-B"}'], false)
  assert.notEqual(clash, 0, '两个动作抢同一个字节：拒')
  const good = await config(root, new Map(), ['set', 'ui.keys', '{"pageUp":"Ctrl-B"}'], false)
  assert.equal(good, 0, '全好的对象：收')
})

test('④ 手改文件配错的那一档：那一格照缺省走、problems 报出为什么（读那面的地板）', async () => {
  const root = await rootOf()
  await writeFile(configFileOf(root), JSON.stringify({ ui: { keys: { submit: 'NoSuchKey' } } }, null, 2), 'utf8')
  const doc = await readConfig(root, SYS)
  const km = keymapOf((doc.ui as { keys: Record<string, string> }).keys)
  assert.equal(km.problems.length, 1, '恰好一条 problem')
  assert.ok(km.problems[0]?.why.includes('认不出来'), 'why 说得出')
  assert.deepEqual(km.rows.find((r) => r.action === 'submit')?.keys, KEYMAP.rows.find((r) => r.action === 'submit')?.keys, '那一格照缺省')
})

test('⑤ 形状坏了整份拒载：ui.keys 不是对象 · 值不是键串，都不是"没配过"', async () => {
  const root = await rootOf()
  await writeFile(configFileOf(root), JSON.stringify({ ui: { keys: 42 } }, null, 2), 'utf8')
  await assert.rejects(() => readConfig(root, SYS), (err: unknown) => {
    assert.ok(err instanceof ConfigError)
    assert.ok(err.message.includes('ui.keys'), `报文点名 ui.keys：${err.message}`)
    return true
  })
  await writeFile(configFileOf(root), JSON.stringify({ ui: { keys: { submit: 5 } } }, null, 2), 'utf8')
  await assert.rejects(() => readConfig(root, SYS), (err: unknown) => {
    assert.ok(err instanceof ConfigError)
    assert.ok(err.message.includes('键串'), `报文点名键串：${err.message}`)
    return true
  })
})

test('⑥ 接线在场：`ui/console.ts` 把配置造出的那一份递给 openKeys 与提示行（负对照：删掉必红）', () => {
  const src = readFileSync(new URL('../ui/console.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('onAction: stage.onAction, km }'), 'openKeys 收到的是配置造出的那一份')
  assert.ok(src.includes('hintLineOf(km,'), '提示行读同一份')
})
