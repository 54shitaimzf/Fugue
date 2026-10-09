import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openStage } from './stage.ts'
import { openSession } from './follow.ts'
import { openTerm, CLEAR_LINE } from './term.ts'
import { KEYMAP, hintLineOf, hintPicksOf, keymapOf } from './keymap.ts'
import { panelWantOf } from './layout.ts'
import { gateFaceOf } from './gate.ts'
import type { Contract } from '../contract/types.ts'
import { themeOf } from './theme.ts'
const face = gateFaceOf({ round: 'r1', fingerprint: 'one', same: [], contracts: [{
  id: 'r1.implement.1', agent: 'agent/r1/1', kind: 'implement', goal: '修复登录提示', ownedPaths: ['src/login.ts'], seed: [], deliverables: [], assertions: [{ name: '登录行为', action: 'test' }],
}] as Contract[] }, { test: 'node tools/test-entry.js' })
function rig() {
  let pending: typeof face | null = null, running = false, columns = 120, height = 40
  const presses: string[] = [], chunks: string[] = [], notes: string[] = []
  const stage = openStage({ note: s => notes.push(s), redraw: () => {}, hint: when => hintLineOf(KEYMAP, 0, when), rows: () => [],
    columns: () => columns, termRows: () => height, pendingFace: async () => pending,
    run: () => ({ get running() { return running }, last: [], stop: () => true, press: line => { presses.push(line); return true }, argvOf: () => ({ words: [], argv: [], why: null }) }),
    now: () => 0, abort: () => {},
  })
  stage.setRaw(true)
  const session = openSession({ view: stage.view })
  const term = openTerm({ out: { isTTY: true, get columns() { return columns }, get rows() { return height }, write: s => chunks.push(s) }, term: 'xterm-256color', heightOf: stage.heightWant })
  const draw = () => { chunks.length = 0; term.draw([], size => session.panel(size)); return chunks.join('') }
  return { stage, presses, notes, draw, setPending: (p: typeof pending) => { pending = p }, setRunning: (r: boolean) => { running = r }, resize: (w: number, h: number) => { columns = w; height = h; stage.onResize() }, close: () => { stage.close(); term.close() } }
}
test('正常宽高扩展主区，输入多行让出等量空间，开合确认不挪动操作区', async () => {
  assert.ok(panelWantOf(40, false) >= 30)
  assert.ok(panelWantOf(50, false) > panelWantOf(40, false))
  const r = rig(), base = r.stage.heightWant()
  r.stage.onAction({ action: 'insert', text: '草稿'.repeat(65) }); r.stage.onAction({ action: 'toggleFold' })
  assert.equal(r.stage.heightWant(), base - 2)
  const draft = r.stage.view().input!
  r.setPending(face); await r.stage.refreshGate()
  assert.equal(r.stage.heightWant(), base, '确认切换恢复操作区的单行光标占位')
  assert.ok(!r.stage.view().input!.rows.join('').includes('草稿'), '确认时不展示可输入的草稿')
  r.stage.onAction({ action: 'cancel' }); assert.deepEqual(r.stage.view().input, draft, '返回保留文字与光标')
  r.close()
})
test('批准使用同一操作区域，保留草稿与只读全文，返回清除旧选择，不把草稿当批准或排队执行', async () => {
  const r = rig()
  r.stage.onAction({ action: 'insert', text: '保留我的后续问题' }); const draft = r.stage.view().input!
  r.setPending(face); await r.stage.refreshGate(); r.draw()
  assert.equal(r.draw(), '', '未变确认帧零输出')
  r.stage.onAction({ action: 'approve', key: 'y' }); assert.deepEqual(r.presses, [])
  r.stage.onAction({ action: 'read' }); assert.match(r.stage.view().read!.rows.join(''), /修复登录提示/)
  r.stage.onAction({ action: 'submit' }); r.stage.onAction({ action: 'approve', key: 'y' }); assert.deepEqual(r.presses, [], '全文不会执行')
  r.stage.onAction({ action: 'cancel' }); assert.ok(!r.stage.view().bottom!.rows.join('').includes('再按'))
  r.stage.onAction({ action: 'cancel' }); assert.deepEqual(r.stage.view().input, draft)
  r.stage.onAction({ action: 'go' }); r.stage.onAction({ action: 'approve', key: 'y' }); assert.deepEqual(r.presses, [])
  r.stage.onAction({ action: 'submit' }); assert.deepEqual(r.presses, ['round go'])
  assert.deepEqual(r.stage.view().input, draft, '启动整批后恢复输入草稿')
  r.close(); console.log('operation: draft retained; readonly execute=0; fresh approval press1=0/press2=1; idle bytes=0')
})
test('每个场景只露当前动作；宽屏也不补入其他键，当前Esc作用随上下文变化', () => {
  const input = hintPicksOf(KEYMAP, 'input').map(b => b.action)
  assert.ok(input.length <= 5); assert.ok(!input.includes('approve')); assert.ok(!input.includes('pageDown')); assert.ok(!input.includes('quit'))
  const run = hintLineOf(KEYMAP, 0, 'run'); assert.match(run, /Esc 停止/); assert.match(run, /Enter 排队/); assert.ok(!run.includes('退出'))
  const typing = hintLineOf(KEYMAP, 0, 'typing'); assert.match(typing, /Esc 清空输入/)
  const km = keymapOf({ cancel: 'Alt-E', submit: 'Ctrl-T' }), remapped = hintLineOf(km, 0, 'run')
  assert.match(remapped, /Alt-E 停止/); assert.match(remapped, /Ctrl-T 排队/); assert.ok(!remapped.includes('Esc'))
  const r = rig(); assert.ok(!r.stage.view().hint!.includes('退出'))
  r.setRunning(true); assert.match(r.stage.view().hint!, /Esc 停止/)
  r.stage.onAction({ action: 'insert', text: '下一步的问题' }); assert.match(r.stage.view().hint!, /Enter 排队/)
  r.close()
})
test('浅底用字重、深底用背景强调用户消息；未知底保默认；无样式与管道逐字节退化', () => {
  const light = themeOf({ term: 'xterm-256color', colorFgBg: '0;15' }), dark = themeOf({ term: 'xterm-256color', colorFgBg: '15;0' })
  assert.notDeepEqual(light, dark)
  assert.ok(light!.user!.includes('[1;')); assert.ok(!light!.user!.includes('48;5'))
  assert.ok(dark!.user!.includes('48;5'))
  const render = () => ({ rows: ['USER SYSTEM'], roles: ['user' as const], segments: [[{ text: 'USER ', role: 'user' as const }, { text: 'SYSTEM', role: 'system' as const }]] })
  const draw = (theme: ReturnType<typeof themeOf>, tty = true) => { const output: string[] = []; const t = openTerm({ out: { isTTY: tty, columns: 11, write: s => output.push(s) }, term: 'xterm-256color', height: 1, theme }); t.draw(['HISTORY'], render); t.close(); return output.join('') }
  assert.equal(draw(themeOf({ term: 'xterm-256color', noStyle: true, colorFgBg: '15;0' })), draw(undefined))
  assert.equal(draw(themeOf({ term: 'xterm-256color', noColor: '1', colorFgBg: '15;0' })), draw(undefined))
  assert.equal(draw(dark, false), 'HISTORY\n')
  const legacy = themeOf({ term: 'linux', colorTerm: 'truecolor', colorFgBg: '15;0' })
  assert.ok(!Object.values(legacy!).join('').includes('38;5')); assert.ok(!Object.values(legacy!).join('').includes('48;5'))
})
