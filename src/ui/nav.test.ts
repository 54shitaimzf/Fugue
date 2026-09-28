// TUI 的第二版第八格：**导航**（PLAN § 5.19 第二版「二 · 按键」· 第九节 `T8` 那一行 · 架构 § 9.8）。
// 跑法：cd ~/fugue && node --test src/ui/nav.test.ts
//
// 这一份量的四样：
//
//   ① **树从账推出来**：节点 = 账上出现过的 writer，主线在最前（depth 0）· agent 按名字排（depth 1）·
//      同一个 writer 只出一个 · 一份账都没有时是空表。
//   ② **走**：`Tab` 那一下是**环形**（最后一个再往下回到第一个——"在面板之间循环"就是它）；`Alt-n`
//      直选的是第 n 格 **agent**（主线不在里头），没有那么多个给 `null`（安静丢掉，不猜）。
//   ③ **切过去 = 换一个读的 writer**：主线那一档 `null`（**不滤**——滤成 `round` 会让处境那一条链
//      整条消失）；agent 那一档是它自己。负对照量的是这一条。
//   ④ **那几行**：缩进按级数 · 选中那个带 `▸` · 超宽就截。
import assert from 'node:assert/strict'
import test from 'node:test'
import type { StatusRow } from '../probe/status.ts'
import { NAV_INDENT, altAt, clampNav, navNodesOf, navRowsOf, stepNav, writerAt } from './nav.ts'
import { widthOf } from './frame.ts'

/** 一行账（这一份只用到坐标那一栏的 `writer` 与事件那一栏的 `t`）。 */
const row = (writer: string, t: string): StatusRow => ({ pos: { seq: 1, writer }, e: { t } }) as unknown as StatusRow

const ROWS: readonly StatusRow[] = [
  row('round', 'round/intent'),
  row('round', 'round/state'),
  row('agent/r1/2', 'llm/call'),
  row('agent/r1/1', 'contract/issue'),
  row('agent/r1/1', 'run/end'),
  row('agent/r1/2', 'contract/issue'),
]

test('① 树从账推出来：主线在最前 · agent 按名字排 · 重复的只出一个 · 空账是空表', () => {
  const nodes = navNodesOf(ROWS)
  assert.deepEqual(
    nodes.map((x) => [x.label, x.depth, x.writer]),
    [
      ['主线（round）', 0, null],
      ['agent/r1/1', 1, 'agent/r1/1'],
      ['agent/r1/2', 1, 'agent/r1/2'],
    ],
    '主线在根上，两格 agent 缩进一级、按名字排',
  )
  assert.deepEqual(navNodesOf([]), [], '一份账都没有：空表')
  // **父级是轮次（主线），所以只有一级缩进**——agent 不会再往下分（今天没有"agent 的子 agent"）。
  assert.equal(Math.max(...nodes.map((x) => x.depth)), 1)
  console.log(`① 读数：${nodes.length} 个节点（主线 1 + agent 2）· 最深 ${Math.max(...nodes.map((x) => x.depth))} 级 · 空账 0 个`)
})

test('② 走：`Tab` 环形 · `Alt-n` 直选第 n 格 agent（主线不在里头）· 越界安静丢掉', () => {
  const n = navNodesOf(ROWS).length
  assert.equal(n, 3)
  assert.equal(stepNav(n, 0, 1), 1)
  assert.equal(stepNav(n, 2, 1), 0, '最后一个再往下回到第一个（环形）')
  assert.equal(stepNav(n, 0, -1), 2, '第一个往上回到最后一个')
  assert.equal(clampNav(n, 7), n - 1)
  const nodes = navNodesOf(ROWS)
  assert.equal(altAt(nodes, 1), 1, '`Alt-1` 是第 1 格 agent（主线不在里头）')
  assert.equal(altAt(nodes, 2), 2)
  assert.equal(altAt(nodes, 3), null, '只有两格 agent：`Alt-3` 安静丢掉')
  assert.equal(altAt(nodes, 0), null, '`Alt-0` 不是一条键（1 起数）')
  console.log('② 读数：Tab 环形（0→1 · 2→0 · 0→2）· Alt-1 → 下标 1 · Alt-3 → null')
})

test('③ 切过去 = 换一个读的 writer：主线不滤（null），agent 滤成它自己', () => {
  const nodes = navNodesOf(ROWS)
  assert.equal(writerAt(nodes, 0), null, '**主线那一档不许滤成 `round`**：处境那一条链在持份者那一份里，滤掉就整条看不见了')
  assert.equal(writerAt(nodes, 1), 'agent/r1/1')
  assert.equal(writerAt(nodes, 2), 'agent/r1/2')
  assert.equal(writerAt([], 0), null, '没有节点时也是整份账')
  // 负对照：把主线那一档改成滤 `round` → 这一条当场红（上面那一行量的就是它）。
  assert.notEqual(writerAt(nodes, 0), 'round')
  console.log('③ 读数：主线 → null（整份账）· agent 1 → agent/r1/1 · agent 2 → agent/r1/2')
})

test('④ 那几行：缩进按级数 · 选中那个带 `▸` · 超宽就截', () => {
  const nodes = navNodesOf(ROWS)
  const rows = navRowsOf(nodes, 1)
  assert.equal(rows.length, 3)
  assert.equal(rows[0], '  主线（round）', '没选中的那一行是一个空格前缀（对齐那个记号）')
  assert.equal(rows[1], `▸ ${' '.repeat(NAV_INDENT)}agent/r1/1`, '选中那一行带 `▸` 且缩进一级')
  assert.equal(rows[2], `  ${' '.repeat(NAV_INDENT)}agent/r1/2`)
  const narrow = navRowsOf(nodes, 1, 12)
  for (const l of narrow) assert.ok(widthOf(l) <= 12, `那一行该在 12 列以内：${widthOf(l)}`)
  assert.ok((narrow[1] as string).startsWith('▸'), `截了也要看得出选中的是哪一个：${String(narrow[1])}`)
  console.log(`④ 读数：三行（主线与两格 agent）· 缩进 ${NAV_INDENT} 空格一级 · 12 列下每行 ≤ 12 · 记号留住`)
})
