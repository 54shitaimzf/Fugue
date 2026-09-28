// TUI 的第二版第七格：**排队**（PLAN § 5.19 第二版「六 · 提交的四种去向」·「四 · 取消链」第三级 ·
// 第九节 `T7` 那一行 · 架构 § 9.8）。跑法：cd ~/fugue && node --test src/ui/queue.test.ts
//
// 这一份量的三样：
//
//   ① **次序与一次一条**：入队的次序就是起的次序（跑完一趟取一条，取走的不再出来）· 空队列取出来是
//      `null`（负对照：不许凭空造一条出来）· **同一条打两遍就是两条**（去重等于替人改主意）。
//   ② **撤**：`dropLastOf` 掉的是**最后**那一条（负对照：不是最前面那一条）· 空队列原样还回去 ·
//      撤到空之后那一行是空串。
//   ③ **那一行（可见）**：空队列时**一个字节都不占** · 有货时说得出条数与下一条原文 · 超过宽度就截。
import assert from 'node:assert/strict'
import test from 'node:test'
import { EMPTY_QUEUE, dropLastOf, enqueueOf, queueRowOf, shiftOf } from './queue.ts'
import type { QueueState } from './queue.ts'
import { widthOf } from './frame.ts'

const at = (lines: readonly string[]): QueueState =>
  lines.reduce((q, line) => enqueueOf(q, { line, mode: line.startsWith('/') ? 'Command' : 'Say' }), EMPTY_QUEUE)

test('① 次序与一次一条：入队的次序就是跑的次序 · 取走的不再出来 · 空的就是 null', () => {
  const q = at(['/round go', '把注释补上', '/log'])
  const one = shiftOf(q)
  assert.equal(one.next?.line, '/round go', '先入队的先出')
  assert.equal(one.q.items.length, 2)
  const two = shiftOf(one.q)
  assert.equal(two.next?.line, '把注释补上')
  const three = shiftOf(two.q)
  assert.equal(three.next?.line, '/log')
  assert.equal(three.next?.mode, 'Command', '模式跟着那一行一起排队（`/` 起头就是命令）')
  const four = shiftOf(three.q)
  assert.equal(four.next, null, '**负对照**：空队列里取不出东西来（不许凭空造一条）')
  assert.equal(four.q.items.length, 0)
  // 同一条打两遍就是两条。
  const twice = at(['/log', '/log'])
  assert.equal(twice.items.length, 2, '去重等于替人改主意')
  console.log(`① 读数：三条按入队次序出去（${['/round go', '把注释补上', '/log'].join(' → ')}）· 取空之后是 null · 两条一样的照样两条`)
})

test('② 撤：`Esc` 掉的是最后那一条 · 空的原样 · 撤到空之后是一行空串', () => {
  const q = at(['第一条', '第二条', '第三条'])
  const after = dropLastOf(q)
  assert.equal(after.items.length, 2)
  assert.equal(after.items[0]?.line, '第一条', '**负对照**：掉的是最后一条，不是第一条')
  assert.equal(after.items[1]?.line, '第二条')
  assert.equal(q.items.length, 3, '原来那一份没被动过（纯函数）')
  assert.equal(dropLastOf(EMPTY_QUEUE).items.length, 0, '空的原样还回去')
  assert.equal(dropLastOf(dropLastOf(dropLastOf(q))).items.length, 0, '一条一条撤到空')
  assert.equal(queueRowOf(EMPTY_QUEUE), '', '撤到空之后那一行一个字节都不占')
  console.log('② 读数：三条撤一下剩两条（掉的是第三条）· 撤到空 0 条 · 空队列那一行是空串')
})

test('③ 那一行：空的一个字节都不占 · 有货说得出条数与下一条 · 超宽就截', () => {
  assert.equal(queueRowOf(EMPTY_QUEUE), '')
  const one = at(['/round go'])
  assert.equal(queueRowOf(one), '排队 1 条 · 下一条：/round go · Enter 起下一条 · Esc 丢掉最后一条')
  const three = at(['/round go', '第二条', '第三条'])
  assert.ok(queueRowOf(three).includes('排队 3 条'), queueRowOf(three))
  assert.ok(queueRowOf(three).includes('下一条：/round go'), queueRowOf(three))
  assert.ok(queueRowOf(three).includes('还有 2 条在后头'), queueRowOf(three))
  assert.ok(queueRowOf(three).includes('Enter 起下一条'), '那两条路要在那一行里说得出（不然人不知道排队那几条怎么起 · 怎么撤）')
  const wide = queueRowOf(three, 20)
  assert.ok(widthOf(wide) <= 20, `那一行该在 20 列以内：${widthOf(wide)}`)
  assert.ok(wide.includes('排队 3 条'), `截了也要留住条数：${wide}`)
  console.log(`③ 读数：空 '' · 一条「${queueRowOf(one)}」· 三条那一行在 20 列下是「${wide}」`)
})
