import assert from 'node:assert/strict'
import {test} from 'node:test'
import {openStage} from './stage.ts'
import {openSession} from './follow.ts'
import {KEYMAP, hintLineOf} from './keymap.ts'
import type {StatusRow} from '../probe/status.ts'

// D8 B 的用户面：发布没收尾时，TUI 只把事实与下一步放进当前反馈，绝不自动重放写、
// 也不把“没验证”说成“没写过”。这条用真实 Stage/Session 的 view/frame 走一遍，不另造一份文案。
const publish = (phase: 'begin' | 'done', seq: number): StatusRow => ({
  pos: { writer: 'round', seq },
  e: { t: 'merge/publish', round: 'r1', commit: 'c1', phase, ref: 'refs/heads/main', expected: 'b1' },
} as StatusRow)
const accepted = (seq: number): StatusRow => ({
  pos: { writer: 'round', seq },
  e: { t: 'merge/accept', round: 'r1', commit: 'c1', assertions: [] },
} as StatusRow)
const notice = '上一次发布没收尾'

test('发布没收尾时 Stage 把事实与下一步放进当前反馈；收尾后自然消失，且不声称自动重放', () => {
  let all: StatusRow[] = [publish('begin', 1)]
  const stage = openStage({
    rows: () => all,
    columns: () => 120,
    termRows: () => 40,
    pendingFace: async () => null,
    note: () => {},
    redraw: () => {},
    now: () => 0,
    abort: () => {},
    hint: (when) => hintLineOf(KEYMAP, 3, when),
    run: () => null,
  })
  stage.setRaw(true)
  const session = openSession({ view: stage.view })
  session.push(all)
  const shown = () => session.panel({ columns: 120, height: 40 }).rows.join('\n')
  try {
    const begin = stage.view().feedback ?? []
    assert.ok(begin.some(l => l.includes(notice) && l.includes('写回中途')), `begin：${JSON.stringify(begin)}`)
    assert.ok(begin.some(l => l.includes('fugue recover')), '要给出下一步（诊断入口）')
    assert.ok(!begin.some(l => l.includes('已自动') || l.includes('重放完成')), '不许声称自动补齐')
    assert.ok(shown().includes(notice), '这一行要真的印到屏上')
    assert.ok(shown().includes('! 上一次发布'), '反馈带注意力标记，不另加“系统”身份词')
    assert.ok(!shown().includes('系统 · '), '身份词不上屏')
    const tall = session.panel({ columns: 120, height: 40 }).rows
    assert.ok(tall.findIndex((l) => l.startsWith('┌')) >= 20, '启动反馈贴着输入，不在顶上留一屏空白')
    const narrow = session.panel({ columns: 40, height: 40 }).rows.join('\n')
    assert.ok(narrow.includes('! 上一次发布') && narrow.includes('不会自动重放') && narrow.includes('recover 看实际状态'), '窄屏折行后事实仍在')

    // 写回已落、接受未落：状态词要跟着事实走，不能仍说“写回中途”。
    const done = publish('done', 2)
    all = [...all, done]
    session.push([done])
    const row = stage.view().feedback ?? []
    assert.ok(row.some(l => l.includes(notice) && l.includes('接受未落') && !l.includes('写回中途')), `done：${JSON.stringify(row)}`)

    // 接受落账：这一行消失，界面回到静默。
    const accept = accepted(3)
    all = [...all, accept]
    session.push([accept])
    assert.ok(!(stage.view().feedback ?? []).some(l => l.includes(notice)), '收尾后不再提示')
    assert.ok(!shown().includes(notice))
    console.log('recovery notice:begin/done 两态可见且措辞随事实 · accept 后消失 · 无自动重放字样 · 走真实 Stage/Session/frame')
  } finally {
    stage.close()
  }
})
