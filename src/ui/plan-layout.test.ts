import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openStage } from './stage.ts'
import { openSession } from './follow.ts'
import { openTerm } from './term.ts'
import { gateFaceOf } from './gate.ts'
import type { GateFace } from './gate.ts'
import { readContentOf } from './read.ts'
import { innerOf } from './frame.ts'

const long = '检查登录错误并保留账号 '.repeat(160)
function batch(id: string) {
  const texts = [`实现：${id} 第一件 ${long}`, `实现：${id} 第二件 ${long}`]
  const face = gateFaceOf({ round: 'r1', fingerprint: id, same: [], contracts: [1, 2].map(n => ({
    id: `r1.implement.${n}`, agent: `agent/r1/${n}`, kind: 'implement', goal: texts[n - 1],
    ownedPaths: [`src/login-${n}.ts`], seed: [], deliverables: [], assertions: [],
  })) } as never)
  const heads = face.cards.map(c => c.head), reads = [0, 0]
  face.cards.forEach((c, i) => Object.defineProperty(c, 'head', { get() { reads[i]++; return heads[i] } }))
  return { face, reads, expected: (width: number) => readContentOf('计划全文 · 2 项任务', heads.flatMap((head, i) => [...(i === 0 ? [] : ['']), `${i + 1}/2 · ${head}`, ...face.cards[i]!.detail]), innerOf(width), width) }
}
function rig() {
  const one = batch('one'), two = batch('two')
  let pending: GateFace | null = one.face, width = 16, height: number | undefined = 24
  const writes: string[] = [], presses: string[] = []
  const stage = openStage({ rows: () => [], columns: () => width, termRows: () => height,
    pendingFace: async () => pending, now: () => 0, abort: () => {}, note: () => {}, redraw: () => {}, hint: () => '',
    run: () => ({ running: false, last: [], argvOf: () => ({ words: [], argv: [], why: null }),
      press: s => { presses.push(s); return true }, stop: () => false }),
  })
  stage.setRaw(true)
  const session = openSession({ view: stage.view })
  const term = openTerm({ term: 'xterm', heightOf: stage.heightWant, out: { isTTY: true,
    get columns() { return width }, get rows() { return height }, write: s => writes.push(s),
  } })
  return { one, two, stage, presses, writes,
    draw: () => { writes.length = 0; term.draw([], size => session.panel(size)) },
    resize: (w: number, h: number | undefined) => { width = w; height = h; stage.onResize() },
    pending: (p: GateFace | null) => { pending = p },
    close: () => { stage.close(); term.close() },
  }
}
test('未变的长计划在翻页、菜单和重绘中只排一次，完整原文与零空转输出保持', async () => {
  const r = rig()
  try {
    await r.stage.refreshGate(); r.stage.onAction({ action: 'read' }); r.one.reads.fill(0)
    const first = r.stage.view().read!
    assert.deepEqual({ heading: first.heading, rows: first.rows }, { heading: r.one.expected(16).heading, rows: r.one.expected(16).rows })
    const positions: number[] = []
    for (let n = 0; n < 20; n++) {
      r.stage.onAction({ action: 'pageDown' }); positions.push(r.stage.view().read!.top); r.draw(); r.draw()
      assert.equal(r.writes.join(''), '', '同一页第二次绘制无输出')
    }
    const before = r.stage.view().read!
    r.stage.onAction({ action: 'panel' }); r.stage.onAction({ action: 'historyNewer' }); r.draw()
    assert.equal(r.stage.view().read!.top, before.top)
    r.stage.onAction({ action: 'cancel' }); r.draw()
    r.resize(16, 8); r.draw(); r.resize(16, undefined); r.draw()
    assert.deepEqual(r.stage.view().read!.rows, first.rows, '滚动、菜单与高度变化保留相同的完整物理行')
    assert.equal(r.one.reads[0], 1, '相同计划与列宽只读一次卡片正文')
    assert.equal(r.one.reads[1], 1, '未选中任务也只读一次完整正文')
    r.stage.onAction({ action: 'approve', key: 'y' }); r.stage.onAction({ action: 'submit' })
    assert.deepEqual(r.presses, [])
    console.log(`long plan: rows=${first.rows.length}; pages=${positions.join(',')}; sourceReads=${r.one.reads.join('/')}; unchangedDrawBytes=0; readonlyExecute=0`)
  } finally { r.close() }
})
test('列宽、选中任务与批次变化重新排版，旧正文和批准不能沿用，空批次回到事件阅读地板', async () => {
  const r = rig()
  try {
    await r.stage.refreshGate(); r.stage.onAction({ action: 'read' }); r.one.reads.fill(0)
    const small = r.stage.view().read!
    r.resize(120, 40); const wide = r.stage.view().read!
    assert.notEqual(wide.rows, small.rows); assert.deepEqual(wide.rows, r.one.expected(120).rows)
    assert.equal(wide.heading, '计划全文 · 2 项任务'); assert.ok(!wide.rows.join('').includes('计划全文'))
    r.stage.onAction({ action: 'pageDown' }); r.draw()
    assert.equal(r.one.reads[0], 2, '仅列宽变化重读全文')
    r.resize(16, 24); assert.deepEqual(r.stage.view().read!.rows, small.rows)
    assert.equal(r.one.reads[0], 3, '只保留一份排版；回旧列宽重新计算')
    r.stage.onAction({ action: 'cancel' }); r.stage.onAction({ action: 'historyNewer' }); r.stage.onAction({ action: 'read' })
    r.one.reads.fill(0)
    assert.deepEqual(r.stage.view().read!.rows, r.one.expected(16).rows)
    r.stage.onAction({ action: 'pageDown' }); r.draw(); assert.deepEqual(r.one.reads, [0, 0], '选择改变仍复用同一整批全文')
    r.stage.onAction({ action: 'cancel' }); r.stage.onAction({ action: 'historyOlder' }); r.stage.onAction({ action: 'read' })
    assert.deepEqual(r.stage.view().read!.rows, r.one.expected(16).rows)
    r.pending(r.two.face); await r.stage.refreshGate(); assert.equal(r.stage.view().read, undefined)
    r.stage.onAction({ action: 'read' }); r.two.reads.fill(0)
    assert.deepEqual(r.stage.view().read!.rows, r.two.expected(16).rows)
    r.stage.onAction({ action: 'jumpLast' }); r.draw(); assert.deepEqual(r.two.reads, [1, 1])
    assert.equal(r.stage.view().read!.top, r.stage.view().read!.rows.length - 1)
    r.stage.onAction({ action: 'approve', key: 'y' }); r.stage.onAction({ action: 'submit' }); assert.deepEqual(r.presses, [])
    r.pending(null); await r.stage.refreshGate(); r.stage.onAction({ action: 'read' })
    assert.equal(r.stage.view().read!.heading, '事件流'); assert.deepEqual(r.stage.view().read!.rows, ['暂无记录'])
    console.log('long plan invalidation: 16->120->16 reads=3; selection reuse0; new batch reads=1/1; empty fallback=暂无记录; readonlyExecute=0')
  } finally { r.close() }
})
