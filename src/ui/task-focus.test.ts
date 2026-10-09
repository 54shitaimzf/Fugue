import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StatusRow } from '../probe/status.ts'
import { openSession } from './follow.ts'
import { widthOf } from './glyph.ts'

function ledger() {
  const rows: StatusRow[] = []
  const add = (e: object, writer = 'round') => rows.push({ pos: { writer, seq: rows.length + 1 }, e } as StatusRow)
  add({ t: 'round/state', round: 'old', from: 'Verifying', to: 'Rebuilding' })
  add({ t: 'round/intent', round: 'old', body: '旧任务不占当前主面', base: 'old', digest: 'old' })
  add({ t: 'round/state', round: 'r1', from: 'Idle', to: 'Planning' })
  add({ t: 'round/intent', round: 'r1', body: JSON.stringify({ goal: '修复登录提示。'.repeat(15) + '完整目标结尾' }), base: 'base', digest: 'goal' })
  add({ t: 'holder/todos', agent: 'holder/r1', digest: 'todo', body: JSON.stringify({ todos: [
    { content: '读取登录行为', status: 'completed' }, { content: '修复登录提示', activeForm: '正在修复登录提示', status: 'in_progress' }, { content: '运行回归检查', status: 'pending' },
  ] }) }, 'holder/r1')
  add({ t: 'round/state', round: 'r1', from: 'Delegated', to: 'Working' })
  add({ t: 'agent/handoff', agent: 'agent/r1/1', successor: 'agent/r1/2', contract: 'r1.implement.1', digest: 'message', body: '已经定位问题。\n模型说明结尾' }, 'agent/r1/1')
  add({ t: 'run/start', agent: 'agent/r1/1', action: 'test', step: '1', argv0: 'node', argv: ['node', 'tools/test-entry.js'] }, 'agent/r1/1')
  return { rows, add }
}
const text = (lines: readonly string[]) => lines.join('\n')
test('主面只跟踪当前任务，长目标与模型原文不受三条摘要和80字符限制', () => {
  const { rows } = ledger(), session = openSession(); session.push(rows)
  const panel = session.panel({ columns: 120, height: 34 }), body = text(panel.rows)
  assert.ok(!body.includes('旧任务不占当前主面'))
  assert.match(body, /完整目标结尾/)
  assert.match(body, /模型说明结尾/)
  assert.match(body, /node tools\/test-entry.js/)
  assert.ok(panel.roles!.includes('user' as never), '用户信息有自己的角色')
  assert.ok(panel.roles!.includes('model' as never), '模型信息有自己的角色')
  assert.match(body, /计划/); assert.match(body, /运行回归检查/)
  assert.ok(!body.includes('调用次数')); assert.ok(!body.includes('工具调用'))
  for (const line of panel.rows) assert.equal(widthOf(line), 120)
})
test('计划随宽窗折叠与恢复，空计划、全完成和写回后收起；合并及验收仍属于当前任务', () => {
  const { rows, add } = ledger(), session = openSession(); session.push(rows)
  const wide = session.panel({ columns: 120, height: 34 })
  assert.match(text(wide.rows), /计划/)
  const narrow = session.panel({ columns: 80, height: 18 })
  assert.ok(!text(narrow.rows).includes('运行回归检查'), '窄窗侧栏收起，主任务不丢')
  assert.match(text(narrow.rows), /模型说明结尾/)
  assert.deepEqual(session.panel({ columns: 120, height: 34 }), wide, '尺寸恢复不修改任务与计划')
  add({ t: 'merge/accept', round: 'r1', commit: 'abc', assertions: [{ assertion: '登录行为', verdict: 'pass', note: '' }] })
  add({ t: 'round/state', round: 'r1', from: 'Verifying', to: 'Committed' })
  session.push(rows.slice(session.rows.length))
  assert.match(text(session.frame({ columns: 120, height: 34 })), /待写回/)
  assert.match(text(session.frame({ columns: 120, height: 34 })), /模型说明结尾/)
  add({ t: 'round/state', round: 'r1', from: 'Committed', to: 'Rebuilding' }); session.push(rows.slice(session.rows.length))
  const done = text(session.frame({ columns: 120, height: 34 }))
  assert.match(done, /已写回/); assert.match(done, /验收/); assert.ok(!done.includes('运行回归检查'))
  assert.ok(!done.includes('完整目标结尾'), '完成只保留简短结果和改动入口')
  add({ t: 'round/state', round: 'r2', from: 'Idle', to: 'Planning' })
  add({ t: 'round/intent', round: 'r2', body: '下一件独立任务', base: 'new', digest: 'new' }); session.push(rows.slice(session.rows.length))
  const next = text(session.frame({ columns: 120, height: 34 }))
  assert.match(next, /下一件独立任务/); assert.ok(!next.includes('模型说明结尾')); assert.ok(!next.includes('已写回'))
  assert.match(text(session.permanent()), /旧任务不占当前主面/, '旧结果仍在真实历史')
  console.log('task lifecycle: 6 frames; wide→narrow→wide exact; merged/current, written/brief, next/history')
})
test('全完成或空的计划不占侧栏；坏计划保留可查入口，不制造进度', () => {
  for (const body of [JSON.stringify({ todos: [] }), JSON.stringify({ todos: [{ content: '全部做完', status: 'completed' }] }), '{bad', JSON.stringify({ todos: [{ content: '有效项', status: 'pending' }, { content: '坏项', status: 'made_up' }] })]) {
    const { rows, add } = ledger(); add({ t: 'holder/todos', agent: 'holder/r1', digest: 'new', body }, 'holder/r1')
    const session = openSession(); session.push(rows)
    const panel = text(session.frame({ columns: 120, height: 34 }))
    assert.ok(!panel.includes('运行回归检查')); assert.ok(!panel.includes('全部做完')); assert.ok(!/\d+%/.test(panel))
  }
})
