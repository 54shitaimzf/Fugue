import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openStage } from './stage.ts'
import { openSession } from './follow.ts'
import { openTerm } from './term.ts'
import { KEYMAP, hintLineOf } from './keymap.ts'
import { gateFaceOf, previewLinesOf } from './gate.ts'
import { clip } from './glyph.ts'
import { readWrap } from './read.ts'
import { innerOf, frameOf } from './frame.ts'
import { statusOf } from '../probe/status.ts'
import type { StatusRow } from '../probe/status.ts'

const text = Array.from({ length: 160 }, (_, i) => `item ${String(i).padStart(3, '0')} inspect login result`).join('\n')
const task = [
  { pos: { writer: 'round', seq: 1 }, e: { t: 'round/state', round: 'r1', from: 'Idle', to: 'Planning' } },
  { pos: { writer: 'round', seq: 2 }, e: { t: 'round/intent', round: 'r1', body: JSON.stringify({ goal: text }) } },
] as StatusRow[]
const batch = gateFaceOf({ round: 'r1', fingerprint: 'reader-context', same: [], contracts: [1, 2].map(n => ({
  id: `r1.implement.${n}`, agent: `agent/r1/${n}`, kind: 'implement', goal: text,
  ownedPaths: [`src/login-${n}.ts`], seed: [], deliverables: [], assertions: [],
})) } as never)
function rig(rows: StatusRow[] = task, width = 120, height: number | undefined = 40, plan = false, images = false) {
  let w = width, h = height, size = { columns: width, height: 1 }
  const writes: string[] = [], presses: string[] = [], requests: unknown[] = [], notes: string[] = []
  const stage = openStage({ rows: () => rows, columns: () => w, termRows: () => h, now: () => 0, abort: () => {},
    note: s => notes.push(s), redraw: () => {}, hint: when => hintLineOf(KEYMAP, 0, when),
    pendingFace: async () => plan ? batch : null, graphics: () => images ? 'kitty' : 'none',
    readImage: async request => { requests.push(request); return null },
    run: () => ({ running: false, last: [], argvOf: () => ({ words: [], argv: [], why: null }),
      press: s => { presses.push(s); return true }, stop: () => false }),
  })
  stage.setRaw(true); stage.onAdvance(rows)
  const session = openSession({ view: stage.view }); session.push(rows)
  const term = openTerm({ term: 'xterm', heightOf: stage.heightWant,
    out: { isTTY: true, get columns() { return w }, get rows() { return h }, write: s => writes.push(s) },
  })
  const draw = () => { writes.length = 0; term.draw([], s => { size = s; return session.panel(s) }); return session.panel(size) }
  return { stage, draw, writes, presses, requests, notes,
    resize: (width: number, height: number | undefined) => { w = width; h = height; stage.onResize() },
    close: () => { stage.close(); term.close() },
  }
}
test('任务阅读的对象与真实行位置在滚动后仍可见，宽窗不重复标题，正文和返回草稿完整', () => {
  const r = rig()
  try {
    r.stage.onAction({ action: 'insert', text: '继续检查登录' }); const draft = r.stage.view().input
    r.stage.onAction({ action: 'read' })
    const first = r.stage.view().read!
    assert.equal(first.heading, '当前任务记录')
    assert.ok(!first.rows.includes('当前任务记录'), '宽窗固定标题取代正文标题')
    assert.ok(first.rows.join('\n').includes(text), '全部目标原文完整')
    const positions: number[] = []
    for (const action of ['pageDown', 'jumpLast', 'jumpFirst'] as const) {
      r.stage.onAction({ action }); const read = r.stage.view().read!, frame = r.draw()
      assert.equal(read.heading, first.heading); assert.ok(frame.rows[0]!.includes('当前任务记录'))
      assert.equal(read.footer, `${read.top + 1}/${read.rows.length} 行 · 只读`)
      assert.equal(frame.rows[frame.roles!.indexOf('footer')]!.slice(1, -1).trim(), clip(read.footer!, innerOf(120)))
      assert.ok(!read.footer!.includes('准备计划')); positions.push(read.top)
    }
    r.draw(); r.draw(); assert.equal(r.writes.join(''), '')
    const frozen = r.stage.view().read; r.stage.onAction({ action: 'panel' }); r.stage.onAction({ action: 'pageDown' })
    assert.deepEqual(r.stage.view().read, frozen); r.stage.onAction({ action: 'cancel' }); assert.deepEqual(r.stage.view().read, frozen)
    r.resize(8, 8); const narrow = r.stage.view().read!
    assert.ok(narrow.rows.join('').includes('当前任务记录'), '窄窗正文仍可读完整标题')
    assert.ok(narrow.rows.join('').includes(text.replaceAll('\n', '')), '缩窗原文逐字保留')
    r.resize(120, undefined); assert.equal(r.stage.view().read!.heading, '当前任务记录')
    r.stage.onAction({ action: 'cancel' }); assert.deepEqual(r.stage.view().input, draft); assert.deepEqual(r.presses, [])
    assert.deepEqual(r.notes, [])
    console.log(`reader context: stable task heading; down/end/start=${positions.join('/')}; full original; narrow title fallback; draft retained; readonly execute=0; idle bytes=0`)
  } finally { r.close() }
})
test('计划全文显示当前任务与行位置，窄窗仍可完整阅读标题和内容，空记录与坏元数据保持地板', async () => {
  for (const width of [120, 16, 8]) {
    const r = rig([], width, 40, true)
    try {
      await r.stage.refreshGate(); r.stage.onAction({ action: 'historyNewer' }); r.stage.onAction({ action: 'read' })
      const read = r.stage.view().read!
      assert.equal(read.heading, clip('计划全文 · 当前 2/2', Math.max(0, width - 5)))
      assert.ok(r.draw().rows[0]!.includes(read.heading!), '实际固定框头显示同一选中任务')
      const source = previewLinesOf(batch.cards[1]!).flatMap(line => [...readWrap(line, innerOf(width))])
      assert.deepEqual(read.rows.slice(-source.length), source, '完整选中计划按实际框内宽度排版')
      if (width === 120) assert.ok(!read.rows.join('').includes('计划全文'))
      else assert.ok(read.rows.join('').includes('计划全文 · 当前 2/2'), '标题装不下时全文留在正文')
      r.stage.onAction({ action: 'jumpLast' }); const end = r.stage.view().read!
      assert.equal(end.footer, `${end.top + 1}/${end.rows.length} 行 · 只读`)
      const frame = r.draw(); assert.equal(frame.rows[frame.roles!.indexOf('footer')]!.slice(1, -1).trim(), clip(end.footer!, innerOf(width)))
      r.stage.onAction({ action: 'approve', key: 'y' }); r.stage.onAction({ action: 'submit' }); assert.deepEqual(r.presses, [])
      r.stage.onAction({ action: 'cancel' }); assert.ok(r.stage.view().bottom!.rows.join(' ').includes('当前 2/2'))
    } finally { r.close() }
  }
  const empty = rig([])
  try { empty.stage.onAction({ action: 'read' }); assert.equal(empty.stage.view().read!.heading, '事件流'); assert.deepEqual(empty.stage.view().read!.rows, ['暂无记录']) } finally { empty.close() }
  const base = { width: 40, height: 14, snapshot: statusOf([]), read: { rows: ['original'], top: 0 } }
  const legacy = frameOf(base)
  assert.deepEqual(frameOf({ ...base, read: { ...base.read, heading: 7 as never, footer: 8 as never } }), legacy)
  console.log('reader plan: selected2/2 complete at120/16/8; end position actual; readonly execute=0; empty record readable; bad metadata exact legacy')
})
test('文件阅读的稳定标题不挤入正文，图片坐标仍紧随完整文件描述，关图退回原文', async () => {
  const events = ['preview.png', 'following.txt'].map((path, i) => ({
    pos: { writer: 'agent/r1/1', seq: i + 1 },
    e: { t: 'view/write', agent: 'agent/r1/1', path, rev: i + 1, blob: String(i + 1).repeat(40), mode: 0o100644 },
  })) as unknown as StatusRow[]
  for (const width of [120, 16, 8]) {
    const r = rig(events, width, 40, false, true)
    try {
      r.stage.onAction({ action: 'read' }); const read = r.stage.view().read!
      assert.equal(read.heading, clip('文件改动 · 2 条', Math.max(0, width - 5)))
      assert.ok(r.draw().rows[0]!.includes(read.heading!))
      const description = readWrap('写 preview.png', innerOf(width))
      const start = read.rows.findIndex(s => s === description[0])
      assert.ok(start >= 0); assert.deepEqual(read.rows.slice(start, start + description.length), description)
      assert.equal(read.preview!.after, start + description.length, '预览坐标跟正文同源')
      assert.equal(r.requests.length, 1)
      if (width === 120) assert.ok(!read.rows.join('').includes('文件改动'))
      else assert.ok(read.rows.join('').includes('文件改动 · 2 条'))
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.ok(r.stage.view().read!.rows.join('').includes('following.txt'))
      r.stage.onAction({ action: 'complete' }); assert.equal(r.stage.view().read!.heading, clip('事件流', Math.max(0, width - 5)))
      assert.deepEqual(r.presses, [])
    } finally { r.close() }
  }
  const off = rig(events)
  try { off.stage.onAction({ action: 'read' }); assert.equal(off.requests.length, 0); assert.ok(off.stage.view().read!.rows.join('').includes('preview.png')) } finally { off.close() }
  console.log('reader image: path complete; preview offset exact at120/16/8; one source read each; off requests=0; readonly execute=0')
})
