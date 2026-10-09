// 第一幕 ① 附带的一块断言：`T6` 门口那三样输入（`ui/console.ts` 的 `gateSetupOf`）。
//
// **为什么单独立一条**：开工前发现的那一处缺陷——那一块原先内联在 `tuiCmd` 里，`getConfig` 没有
// import，抛出来的 `ReferenceError` 被同一层的 `catch` 吞掉，`why` 于是恒非空，门口那一块（`T6`）
// 在生产里一次都没画出来。断言「配置好的工作区里 `why` 是 null」抓得住那一类"接线断了却不报错"。
//
// 负对照（红得起来才是断言）：
//   ① 配置好 → `why` 是 null，三样都从配置那份来——**把 `getConfig` 那一行去掉，这一条当场红**
//   ② 配置坏 → `why` 非空、三样退到地板（门口那一块不画，而界面照开：这一档是观察窗）
//   ③ 没配过 → `why` 是 null（"没配过"不是"读不出"，两者必须分得开——`config.ts` 那条口径）
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { configFileOf } from '../config.ts'
import { gateSetupOf } from './console.ts'

// 系统那一级指到临时目录（`config.ts` 的 `defaultSystemDir` 读它），不然读数取决于这台机器上
// 有没有人配过系统级。`node --test` 一个文件一个进程，设在这里不外溢。
process.env.FUGUE_SYSTEM_DIR = tmpDir('fugue-gate-setup-sys-')

async function rootWith(config: unknown): Promise<string> {
  const root = tmpDir('fugue-gate-setup-')
  await mkdir(join(root, '.fugue'), { recursive: true })
  await writeFile(configFileOf(root), JSON.stringify(config, null, 2), 'utf8')
  return root
}

test('① 配置好：三样都从配置里来，why 是 null（负对照：`getConfig` 那一行丢了就红）', async () => {
  const root = await rootWith({
    round: { id: 'r7' },
    actions: { build: { argv: ['make', 'all'], outputs: ['dist/a'] } },
  })
  const s = await gateSetupOf(root)
  assert.equal(s.why, null, 'why 是 null ⇒ 门口那一块画得出来')
  assert.equal(s.round, 'r7', '轮次号从配置来')
  assert.deepEqual(s.actions, { build: ['dist/a'] }, '动作表从配置来')
  assert.deepEqual(s.commands, { build: 'make all' }, '命令行从配置来')
})

test('② 配置坏：why 说得出为什么，三样退到地板（门口那一块不画，界面照开）', async () => {
  const root = tmpDir('fugue-gate-setup-bad-')
  await mkdir(join(root, '.fugue'), { recursive: true })
  await writeFile(configFileOf(root), '{ 这不是 JSON', 'utf8')
  const s = await gateSetupOf(root)
  assert.notEqual(s.why, null, 'why 非空')
  assert.ok(s.why?.includes('JSON'), `报文说得出为什么：${s.why}`)
  assert.equal(s.round, 'r1', '轮次号退到地板')
  assert.deepEqual(s.actions, {}, '动作表退到地板')
  assert.deepEqual(s.commands, {}, '命令行退到地板')
})

test('③ 没配过：why 是 null（"没配过"不是"读不出"）', async () => {
  const root = tmpDir('fugue-gate-setup-none-')
  const s = await gateSetupOf(root)
  assert.equal(s.why, null, '没有那一份配置文件不是读不出')
  assert.equal(s.round, 'r1', '轮次号是缺省')
  assert.deepEqual(s.actions, {}, '一个动作都没绑')
})
