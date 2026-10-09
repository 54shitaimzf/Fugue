// 第二幕 ④ 的断言：**布局那本行账合得上**，而且它只有一处真源。
//
// 一条会失败的断言（不是"看着对"）：把常量加一遍，看等不等于 K——`CONTENT_ROWS` 从 6 改成 5，
// K 立刻变 11，与宪法那个 12 对不上，① 当场红。这一条抓的正是"改了一个数、忘了另一处"。
//
// 负对照（成对）：把 `GAP_ROWS` 与 `HINT_ROWS` 折进 `FRAME_ROWS`（把提示行算成框的一部分）→
// ① 的 `FRAME_ROWS === 10` 与 `REGION_ROWS === 12` 当场红两项：**框是框、提示行是提示行**，
// 混起来的那一版在这里被抓住。
//
// 绘制那一头的三条（提示行画在框下面 · 矮屏先让提示行 · 提示行走弱化那一格）在
// `ui/term.test.ts` ⑭ —— 那里有量终端字节那一套家伙。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONTENT_ROWS,
  FRAME_EDGE_ROWS,
  FRAME_ROWS,
  GAP_ROWS,
  HINT_ROWS,
  INNER_ROWS,
  MIN_FRAME_ROWS,
  OVERLAY_WANT,
  PANEL_MIN,
  PANEL_SHARE,
  OVERLAY_SHARE,
  REGION_ROWS,
  RULE_ROWS,
  TAIL_ROWS,
  panelWantOf,
  regionRowsOf,
} from './layout.ts'
import { MIN_HEIGHT } from './frame.ts'
import { K } from './term.ts'

test('① 布局那本行账：K=12 不变 · 框 12→10 · 内容 8→6（交接单 § 二）', () => {
  assert.equal(FRAME_EDGE_ROWS, 2, '框的上下两条边')
  assert.equal(CONTENT_ROWS, 6, '内容 8→6')
  assert.equal(RULE_ROWS, 1, '细线一行')
  assert.equal(TAIL_ROWS, 1, '收尾一行')
  // 五分账那一本（轮次头 1 · 在飞 4 · 细线 1 · 最近动作 1 · 收尾 1）和就是框内。
  assert.equal(INNER_ROWS, 8, '框内 8 = 五分账的和')
  assert.equal(FRAME_ROWS, 10, '框 12→10')
  assert.equal(GAP_ROWS + HINT_ROWS, 2, '框下多出来的是空一行与提示行')
  assert.equal(REGION_ROWS, 12, 'K=12 一个数没动')
  assert.equal(K, REGION_ROWS, '`ui/term.ts` 的 K 就是这一份推出来的（不是另抄一个 12）')
  assert.equal(MIN_FRAME_ROWS, 5, '画得出框的下限还是 5')
  assert.equal(MIN_HEIGHT, MIN_FRAME_ROWS, '`ui/frame.ts` 那个 5 也从这一份推')
  // 提示行那两行是**框外面**的：框画几行，那一块就多几行。
  assert.equal(regionRowsOf(FRAME_ROWS), K, '框 10 + 空一行 + 提示行 = 重画区 12')
  console.log(
    `① 读数：K=${K} ＝ 上边 ${FRAME_EDGE_ROWS} ＋ 内容 ${CONTENT_ROWS} ＋ 细线 ${RULE_ROWS} ＋ 收尾 ${TAIL_ROWS} ` +
      `＋ 下边 ${FRAME_EDGE_ROWS}（框 ${FRAME_ROWS}）＋ 空 ${GAP_ROWS} ＋ 提示 ${HINT_ROWS}；框内 ${INNER_ROWS} 行` +
      `（五分账和 = 轮次头 1 ＋ 在飞 4 ＋ 细线 1 ＋ 最近动作 1 ＋ 收尾 1）· 画得出框的下限 ${MIN_FRAME_ROWS} 行`,
  )
})

test('② 框是框、提示行是提示行：分账收的是框，提示行加在框下面', () => {
  // 缺省那一档：40 行及以上回到框的上限（10），量不到行数也回它——**不是回 12**（12 是重画区）。
  assert.deepEqual(
    [24, 30, 40, 16].map((r) => panelWantOf(r, false)),
    [9, 10, 10, 8],
    '缺省档：24 行终端 9 行框 · 40 行及以上回到框的 10 行 · 16 行那一档落到 PANEL_MIN',
  )
  assert.deepEqual(
    [24, 30, 40, 16].map((r) => panelWantOf(r, true)),
    [13, 17, 23, 12],
    '弹层档：至多 3/5（上限 24），下限是缺省那档 ＋ 4',
  )
  assert.deepEqual(
    [panelWantOf(undefined, false), panelWantOf(undefined, true)],
    [FRAME_ROWS, OVERLAY_WANT],
    '量不到行数：不分账，回框的 10 行 / OVERLAY_WANT（与「量不到就不夹」同一条）',
  )
  // 分账那两个比与下限：这里只量"表里写的"与"算出来用的"是同一份。
  assert.equal(PANEL_SHARE, 2 / 5)
  assert.equal(OVERLAY_SHARE, 3 / 5)
  assert.equal(PANEL_MIN, 8, '框与收尾 4 行 ＋ 内容 4 行')
  assert.ok(panelWantOf(24, false) < FRAME_ROWS, '24 行终端上分账真的压了框（9 < 10）')
  console.log(
    `② 读数：24/30/40/16 行终端上框的期望 ${[24, 30, 40, 16].map((r) => panelWantOf(r, false)).join(' · ')} 行；` +
      `弹层那档 ${[24, 30, 40, 16].map((r) => panelWantOf(r, true)).join(' · ')} 行；` +
      `24 行终端上整块占 ${regionRowsOf(panelWantOf(24, false))} ＋ 输入行 1 行，显示区 ${24 - regionRowsOf(panelWantOf(24, false)) - 1} 行`,
  )
})
