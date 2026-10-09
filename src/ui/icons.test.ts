// 第二幕 ⑨ 前一半的断言：图标档三档（关 · `ascii` · `nerd`）。
//
//   ① **地板**：关着与"根本没有这一档"逐字节相同（没设过的那一帧与显式设成 `off` 的那一帧对）；
//   ② **两档都备**：`ascii` 那一档给 ASCII 那几格（一个私有区码位都不出现）· `nerd` 那一档给私有区
//      那几个——两档的**行数与每行列宽一个都不动**（图标是"一列 + 一个空格"，宽度由 `widthOf` 量）；
//   ③ **表**：名字从表推 · 每个概念两格都有 · 档关着一颗都不给；
//   ④ **开关认得它**：跨进程 `config set ui.icons nerd` 通 · 三档之外的值写这一面就拒。
//
// 负对照（成对）：把 `iconPrefixOf` 里那道"档关着给空串"摘掉（无条件印 `ascii` 那一格）→ ① 当场红，
// 连带 `frame.test.ts` ① 的黄金帧也红（缺省那一档的字节流不许变）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DEFAULT_ICON_TIER, ICONS, ICON_NAMES, ICON_TIERS, iconOf, iconTier, setIconTier } from './icons.ts'
import { frameOf } from './frame.ts'
import { widthOf } from './glyph.ts'
import { statusOf } from '../probe/status.ts'
import type { StatusRow } from '../probe/status.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'

/** 一份够画出主面的账：一条轮次链 + 一格调用 + 那一格停下来。 */
const ROWS: readonly StatusRow[] = [
  { pos: { writer: 'round', seq: 1 }, e: { t: 'round/state', round: 'r1', from: 'Idle', to: 'Working' } },
  {
    pos: { writer: 'agent/r1/1', seq: 1 },
    e: {
      t: 'llm/call',
      agent: 'agent/r1/1',
      step: 0,
      model: 'm',
      stop: 'end-turn',
      rawStop: 'end_turn',
      thinking: null,
      invocations: 1,
      usage: { inputTokens: 3000, cacheReadTokens: 4096, cacheWriteTokens: 0, outputTokens: 300, reasoningTokens: 120 },
    },
  },
  { pos: { writer: 'agent/r1/1', seq: 2 }, e: { t: 'agent/stop', agent: 'agent/r1/1', steps: 2, stopped: '收敛', handoffs: 0 } },
] as unknown as StatusRow[]

/** 一帧（给定档）。**用完把档还原**（它是进程级的那一份）。 */
function frameIn(tier: typeof ICON_TIERS[number]): readonly string[] {
  const was = setIconTier(tier)
  try {
    return frameOf({ snapshot: statusOf(ROWS), width: 100, height: 12 }).lines
  } finally {
    setIconTier(was)
  }
}

const BEFORE = frameOf({ snapshot: statusOf(ROWS), width: 100, height: 12 }).lines

const PUA = (c: string): boolean => c.charCodeAt(0) >= 0xe000 && c.charCodeAt(0) <= 0xf8ff

test('① 地板：关着那一档与"根本没有这一档"逐字节相同', () => {
  assert.equal(DEFAULT_ICON_TIER, 'off', '缺省是关')
  assert.deepEqual([...frameIn('off')], [...BEFORE], '设成 off 与没设过这一档该逐字节相同')
  assert.ok(!BEFORE.some((l) => l.includes('R 正在处理你的任务。')), `缺省那一帧上不该有图标：\n${BEFORE.join('\n')}`)
  console.log(`① 读数：缺省 ${DEFAULT_ICON_TIER} · 没设过与设成 off 的帧逐字节相同（${BEFORE.length} 行）`)
})

test('② 两档都备：ascii 给 ASCII 那几格 · nerd 给私有区那几个 · 行数与列宽不动', () => {
  const ascii = frameIn('ascii')
  assert.notDeepEqual([...ascii], [...BEFORE], 'ascii 那一档该有差别（不然这一条量的是空气）')
  assert.ok(ascii.some((l) => l.includes('R 正在处理你的任务。')), `轮次头那一行该有那一颗：\n${ascii.join('\n')}`)
  assert.equal(iconOf('halted'), '', '当前全局档已还原为 off')
  assert.ok(!ascii.some((l) => [...l].some(PUA)), 'ascii 那一档一个私有区码位都不该有（它是同义退化）')
  const nerd = frameIn('nerd')
  assert.ok(nerd.some((l) => l.includes('\uf024 正在处理你的任务。')), `nerd 那一档轮次头该是那个旗：\n${nerd.join('\n')}`)
  const marks = [...new Set([...nerd.join('')].filter(PUA))].sort()
  assert.deepEqual(marks, ['\uf024'], `印出来的私有区码位该就是表里点名的那两颗：${marks.join('')}`)
  // **列宽与行数一个都不动**：图标占的是一列 + 一个空格，量宽走的还是那一把尺。
  for (const [name, frame] of [['ascii', ascii], ['nerd', nerd]] as const) {
    assert.equal(frame.length, BEFORE.length, `${name} 那一档行数不该变`)
    assert.deepEqual(frame.map(widthOf), BEFORE.map(widthOf), `${name} 那一档每行列宽不该变`)
  }
  console.log(
    `② 读数：ascii 档「R 轮次」「x 格」· nerd 档「\uf024 正在处理你的任务。」「\uf04d 格」· 两档都是 ${nerd.length} 行 / 每行 100 列`,
  )
})

test('③ 表：名字从表推 · 每个概念两格都有 · 档关着一颗都不给', () => {
  assert.deepEqual([...ICON_TIERS], ['off', 'ascii', 'nerd'])
  assert.deepEqual([...ICON_NAMES], Object.keys(ICONS), '名单从表推（不另抄一遍）')
  for (const k of ICON_NAMES) {
    assert.equal([...ICONS[k].ascii].length, 1, `${k}.ascii 是一个字符（列位好算）`)
    assert.ok(ICONS[k].nerd !== '', `${k} 有 nerd 那一格`)
    assert.ok([...ICONS[k].nerd].every(PUA), `${k}.nerd 该落在私有区`)
    assert.ok(ICONS[k].arch !== '', `${k} 带一列"这一颗是什么意思"`)
  }
  const was = setIconTier('off')
  try {
    for (const k of ICON_NAMES) assert.equal(iconOf(k), '', `${k} 在关着那一档该给空串`)
  } finally {
    setIconTier(was)
  }
  assert.equal(iconTier(), was, '还原回去了')
  console.log(`③ 读数：${ICON_NAMES.length} 个概念（${ICON_NAMES.map((k) => `${k}=${ICONS[k].ascii}/${ICONS[k].nerd}`).join(' · ')}）· 关着 0 颗`)
})

test('④ 开关认得它：`config set ui.icons nerd` 通 · 三档之外的值拒', () => {
  const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))
  const root = tmpDir('fugue-icons-')
  const run = (...args: readonly string[]) =>
    spawnSync(process.execPath, [CLI, '--root', root, ...args], {
      encoding: 'utf8',
      input: '',
      env: { ...process.env, FUGUE_SYSTEM_DIR: tmpDir('fugue-sys-none-') },
    })
  const set = run('config', 'set', 'ui.icons', 'nerd')
  assert.equal(set.status, 0, `config set ui.icons nerd 该通：${set.stdout}${set.stderr}`)
  const got = run('config', 'get', 'ui.icons')
  assert.ok(got.stdout.includes('nerd'), `读回来该是 nerd：${got.stdout}`)
  const bad = run('config', 'set', 'ui.icons', 'fancy')
  assert.notEqual(bad.status, 0, '三档之外的值该拒')
  assert.ok(`${bad.stdout}${bad.stderr}`.includes('ascii'), '拒的那一句该把它认得的值说出来')
  console.log(`④ 读数：ui.icons=nerd 写通 · 读回 ${got.stdout.trim()} · 坏值退出码 ${bad.status}`)
})
