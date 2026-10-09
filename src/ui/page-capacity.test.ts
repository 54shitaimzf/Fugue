import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openStage } from './stage.ts'
import { openSession } from './follow.ts'
import { openTerm } from './term.ts'
import { KEYMAP, hintLineOf } from './keymap.ts'
import { gateFaceOf } from './gate.ts'
import type { StatusRow } from '../probe/status.ts'

const text = Array.from({ length: 160 }, (_, i) => `item ${String(i).padStart(3, '0')} inspect this result`).join('\n')
function rig(height: number | undefined, plan = false) {
  let h = height, w = 120, size = { columns: w, height: 1 }
  const rows = [
    { pos: { writer: 'round', seq: 1 }, e: { t: 'round/state', round: 'r1', from: 'Idle', to: 'Planning' } },
    { pos: { writer: 'round', seq: 2 }, e: { t: 'round/intent', round: 'r1', body: JSON.stringify({ goal: text }) } },
  ] as StatusRow[]
  const face = gateFaceOf({ round: 'r1', fingerprint: 'page-size', same: [], contracts: [{
    id: 'r1.implement.1', agent: 'agent/r1/1', kind: 'implement', goal: text, ownedPaths: ['src/login.ts'],
    seed: [], deliverables: [], assertions: [],
  }] } as never)
  const presses: string[] = [], writes: string[] = []
  const stage = openStage({ rows: () => rows, columns: () => w, termRows: () => h,
    pendingFace: async () => plan ? face : null, note: () => {}, redraw: () => {}, now: () => 0, abort: () => {},
    hint: when => hintLineOf(KEYMAP, 0, when),
    run: () => ({ running: false, last: [], argvOf: () => ({ words: [], argv: [], why: null }),
      press: s => { presses.push(s); return true }, stop: () => false }),
  })
  stage.setRaw(true)
  const session = openSession({ view: stage.view }); session.push(rows)
  const term = openTerm({ term: 'xterm', heightOf: stage.heightWant,
    out: { isTTY: true, get columns() { return w }, get rows() { return h }, write: s => writes.push(s) },
  })
  const draw = () => {
    writes.length = 0
    term.draw([], s => { size = s; return session.panel(s) })
    return session.panel(size)
  }
  const half = () => Math.max(1, Math.floor(draw().roles!.filter(role => role === 'read').length / 2))
  return { stage, draw, half, presses, writes, top: () => stage.view().read!.top,
    resize: (columns: number, next: number) => { w = columns; h = next; stage.onResize() },
    close: () => { stage.close(); term.close() },
  }
}

test('阅读半屏取自实际正文容量，正常桌面展开、矮窗缩短，未知尺寸沿用四行', () => {
  const results: string[] = []
  for (const h of [24, 40, 50, 8, undefined]) {
    const r = rig(h)
    try {
      r.stage.onAction({ action: 'read' })
      const page = h === undefined ? 4 : r.half()
      r.stage.onAction({ action: 'pageDown' }); assert.equal(r.top(), page)
      r.stage.onAction({ action: 'pageUp' }); assert.equal(r.top(), 0)
      r.stage.onAction({ action: 'jumpLast' }); assert.equal(r.top(), r.stage.view().read!.rows.length - 1)
      r.stage.onAction({ action: 'jumpFirst' }); assert.equal(r.top(), 0)
      r.draw(); r.draw(); if (h !== undefined) assert.equal(r.writes.join(''), '', '已知尺寸的未变阅读页零输出')
      else assert.ok(!r.writes.join('').includes('\x1b[2K'), '未知几何沿用光标路径，未变正文不重新清写')
      assert.deepEqual(r.presses, [])
      results.push(`${h ?? 'unknown'}:${page}`)
    } finally { r.close() }
  }
  console.log(`reading half-page: host rows -> step ${results.join(', ')}; top/end bounded; readonly execute=0; known idle bytes=0; unknown cursor-only`)
})

test('连续翻页随缩窗和多行草稿重算，菜单冻结背后阅读，返回后按新容量继续', () => {
  const r = rig(40), sequence: number[] = []
  try {
    r.stage.onAction({ action: 'insert', text: 'draft '.repeat(50) }); r.stage.onAction({ action: 'toggleFold' })
    const draft = r.stage.view().input
    r.stage.onAction({ action: 'read' })
    let expected = r.half(); r.stage.onAction({ action: 'pageDown' }); assert.equal(r.top(), expected); sequence.push(r.top())
    r.resize(80, 8); const before = r.top(); expected = r.half()
    r.stage.onAction({ action: 'pageDown' }); assert.equal(r.top(), before + expected); sequence.push(r.top())
    r.resize(160, 50); const next = r.top(); expected = r.half()
    r.stage.onAction({ action: 'pageDown' }); assert.equal(r.top(), next + expected); sequence.push(r.top())
    const frozen = r.stage.view().read
    r.stage.onAction({ action: 'panel' }); r.stage.onAction({ action: 'pageDown' })
    assert.deepEqual(r.stage.view().read, frozen, '可见菜单只移选中项，不翻背后阅读')
    r.stage.onAction({ action: 'cancel' }); assert.deepEqual(r.stage.view().read, frozen)
    expected = r.half(); r.stage.onAction({ action: 'pageUp' }); assert.equal(r.top(), next); sequence.push(r.top())
    r.stage.onAction({ action: 'cancel' }); r.resize(120, 40)
    assert.deepEqual(r.stage.view().input, draft, '阅读与几何变化不修改草稿')
    assert.deepEqual(r.presses, [])
    console.log(`reading sequence: ${sequence.join(' -> ')}; menu retains top; draft retained; readonly execute=0`)
  } finally { r.close() }
})

test('计划全文与按键全文也按当前半屏阅读，批准键仍只读，回到同一对象和帮助选项', async () => {
  const plan = rig(50, true)
  try {
    await plan.stage.refreshGate(); plan.stage.onAction({ action: 'read' })
    const step = plan.half(); plan.stage.onAction({ action: 'pageDown' }); assert.equal(plan.top(), step)
    plan.stage.onAction({ action: 'approve', key: 'y' }); plan.stage.onAction({ action: 'submit' })
    assert.deepEqual(plan.presses, [])
    plan.stage.onAction({ action: 'cancel' }); assert.equal(plan.stage.view().read, undefined)
    assert.ok(plan.stage.view().bottom!.rows.join(' ').includes('当前 1/1'))
  } finally { plan.close() }
  const help = rig(8)
  try {
    help.stage.onAction({ action: 'panel' }); help.stage.onAction({ action: 'historyNewer' }); help.stage.onAction({ action: 'read' })
    const step = help.half(), selected = help.stage.view().menu
    help.stage.onAction({ action: 'pageDown' }); assert.equal(help.top(), Math.min(step, help.stage.view().read!.rows.length - 1))
    help.stage.onAction({ action: 'pageUp' }); assert.equal(help.top(), 0)
    help.stage.onAction({ action: 'cancel' }); assert.ok(help.stage.view().menu)
    assert.equal(help.stage.view().menu!.sel, selected?.sel ?? 1)
    assert.deepEqual(help.presses, [])
  } finally { help.close() }
})
