// U21 · 舞台的接线断言：不起一个进程、不开一个真终端——deps 全给假的，量的是「按键进来之后
// 舞台做了什么」。分派的判据本身住在它们各自的测试里（`cancel.test.ts` 的七级 · `gate.test.ts`
// 的二段确认 · `queue.test.ts` 的入队形状），这里钉的是**接线**：舞台把哪一份处境喂给了判据、
// 判据出来的那一级动作递没递到（press · stop · note · redraw）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StatusRow } from '../probe/status.ts'
import { gateFaceOf, lineOf } from './gate.ts'
import type { GateFace } from './gate.ts'
import { openStage } from './stage.ts'
import type { LineArgv, RunLauncher } from './run.ts'

/** 假的那一只手（`RunLauncher` 的四样全记下来：起了什么 · 停过没有 · argv 现推）。 */
interface Ctl {
  readonly notes: string[]
  redraws: number
  readonly presses: { line: string; mode?: string }[]
  readonly stops: string[]
  aborted: number
  running: boolean
  face: GateFace | null
  rows: readonly StatusRow[]
}

/**
 * 一个舞台与它的假世界：note 记行 · redraw 计数 · press/stop 记档 · 钟可拨（`tick`）·
 * `running` 与 `face` 可中途改（「那一趟跑完了」「门口停了一批」都是中途发生的事）。
 */
function stageOf(o: { face?: GateFace | null; rows?: readonly StatusRow[]; running?: boolean } = {}): {
  stage: ReturnType<typeof openStage>
  ctl: Ctl
  tick: (ms: number) => void
} {
  const ctl: Ctl = {
    notes: [],
    redraws: 0,
    presses: [],
    stops: [],
    aborted: 0,
    running: o.running ?? false,
    face: o.face ?? null,
    rows: o.rows ?? [],
  }
  const go: RunLauncher = {
    argvOf: (line: string): LineArgv => ({ words: line.split(' '), argv: ['fugue', ...line.split(' ')], why: null }),
    get running() {
      return ctl.running
    },
    last: [],
    press: (line: string, mode?: string): boolean => {
      ctl.presses.push({ line, mode })
      return true
    },
    stop: (signal?: string): boolean => {
      ctl.stops.push(signal ?? 'SIGINT')
      return true
    },
  }
  let clock = 0
  const stage = openStage({
    note: (line) => {
      ctl.notes.push(line)
    },
    redraw: () => {
      ctl.redraws += 1
    },
    columns: () => 80,
    rows: () => ctl.rows,
    pendingFace: async () => ctl.face,
    run: () => go,
    now: () => clock,
    abort: () => {
      ctl.aborted += 1
    },
  })
  // 测试里 stdin 总算个终端（`view` 里输入行才画得出来）。
  stage.setRaw(true)
  return { stage, ctl, tick: (ms: number) => { clock += ms } }
}

/** 一份两格的账（主线 + 一个 agent）——导航树从它推。 */
const NAV_ROWS: readonly StatusRow[] = [
  { pos: { writer: 'round', seq: 1 }, e: { t: 'round/state' as never, round: 'r1' as never, from: 'Idle' as never, to: 'Planning' as never } },
  { pos: { writer: 'agent/a1', seq: 1 }, e: { t: 'agent/stop' as never, agent: 'agent/a1' as never, why: 'steps' as never } },
]

test('① 门口开着且行空：按两次 y → 举手一次 · press 恰一次且参数是 lineOf(approve)', async () => {
  const face = gateFaceOf({ round: 'r1', fingerprint: 'fp-1', same: [], contracts: [] }, {})
  const { stage, ctl } = stageOf({ face })
  await stage.refreshGate()
  // 第一下：举手（二段确认的第一段——只说话，不起进程）。
  stage.onAction({ action: 'approve', key: 'y' })
  assert.equal(ctl.presses.length, 0, '第一下只是举手，一个进程都不起')
  assert.ok(ctl.notes.some((n) => n.includes('举了手')), '举手要看得见（note 一句）')
  // 第二下：生效——起的就是 `lineOf('approve')` 那一条（与 `g` 键同一条命令）。
  stage.onAction({ action: 'approve', key: 'y' })
  assert.equal(ctl.presses.length, 1, '两次按下恰一次生效')
  assert.equal(ctl.presses[0]?.line, lineOf('approve'), `起的那一条该是 lineOf('approve')（${lineOf('approve')}）`)
  assert.ok(ctl.notes.some((n) => n.includes('按了 y')), '生效那一下也要看得见')
  assert.ok(ctl.redraws > 0, '生效那一下重画了')
})

test('② Tab 补不动就在树里循环：主线 → agent → 主线（环形，不越界）', () => {
  const { stage, ctl } = stageOf({ rows: NAV_ROWS })
  stage.onAdvance(NAV_ROWS)
  // 空行按 Tab：没有词可补（`completeOf` 答不动）→ 轮到「在面板之间循环」那半句。
  stage.onAction({ action: 'complete' })
  stage.onAction({ action: 'complete' })
  stage.onAction({ action: 'complete' })
  const swaps = ctl.notes.filter((n) => n.startsWith('切到 '))
  assert.equal(swaps.length, 3, '三下 Tab 该切三次（补不动全走循环）')
  assert.equal(swaps[0], '切到 agent/a1（2/2）', `第一下切到 agent（实得 ${swaps[0]}）`)
  assert.equal(swaps[1], '切到 主线（round）（1/2）', `第二下循环回主线（实得 ${swaps[1]}）`)
  assert.equal(swaps[2], '切到 agent/a1（2/2）', `第三下又切过去——是环形不是到头停（实得 ${swaps[2]}）`)
})

test('③ Esc 七级的次序：门口最外，一层一层往里退（每一下只动最外那一级）', async () => {
  const face = gateFaceOf({ round: 'r1', fingerprint: 'fp-1', same: [], contracts: [] }, {})
  const { stage, ctl } = stageOf({ face, running: true })
  await stage.refreshGate()
  // 第 1 下（行还空着 · 门口那一块开着）→ 只收它（队列不动 · 那一趟不停）。
  stage.onAction({ action: 'cancel' })
  assert.ok(ctl.notes.some((n) => n.includes('收起了门口那一块')), '第一下收门口（行空着才走这一级——`escStepOf` 的判据）')
  assert.equal(ctl.stops.length, 0, '收门口那一下不打断在途的趟')
  // 把下面几级全都占上：排队两条草稿（忙时 Enter 入队）。
  stage.onAction({ action: 'insert', text: 'say one', key: 's' })
  stage.onAction({ action: 'submit' })
  stage.onAction({ action: 'insert', text: 'say two', key: 's' })
  stage.onAction({ action: 'submit' })
  assert.ok(ctl.notes.some((n) => n.includes('排队 2 条')), '忙的时候两下 Enter 都该入队')
  // 第 2 下：门口关了 · 没有弹层 → 打断在途的那一趟。
  stage.onAction({ action: 'cancel' })
  assert.deepEqual(ctl.stops, ['SIGINT'], '第二下打断那一趟（SIGINT）')
  assert.ok(ctl.notes.some((n) => n.includes('打断了那一趟')), '打断要看得见')
  // 第 3 下：那一趟死了（`running` 翻 false）→ 丢排队里最后一条（2 → 1）。
  ctl.running = false
  stage.onAction({ action: 'cancel' })
  assert.ok(ctl.notes.some((n) => n.includes('2 → 1 条')), '第三下丢排队的最后一条（2 → 1）')
  // 第 4 下：还剩一条 → 再丢（1 → 0，队列空了）。
  stage.onAction({ action: 'cancel' })
  assert.ok(ctl.notes.some((n) => n.includes('队列空了')), '第四下把队列丢空')
  // 第 5 下：队列空了 → 轮到行（打一个字占住它，再清掉——view 里不再有那份草稿）。
  stage.onAction({ action: 'insert', text: '草稿', key: '草' })
  stage.onAction({ action: 'cancel' })
  const line = (stage.view().input?.rows ?? []).join(' ')
  assert.equal(line.includes('草稿'), false, `清空输入行那一级够得着（实得 ${JSON.stringify(line)}）`)
  // 第 6 下：什么都没了 → 安静（不再多一句 note · 一个副作用都没有）。
  const notesBefore = ctl.notes.length
  stage.onAction({ action: 'cancel' })
  assert.equal(ctl.notes.length, notesBefore, '全空之后的 Esc 什么都不做')
})

test('④ 忙时 Enter 入队 · 跑完一趟起下一条：起的是队头（FIFO），不是刚打的那条', async () => {
  const { stage, ctl } = stageOf({ running: true })
  stage.onAction({ action: 'insert', text: 'say one', key: 's' })
  stage.onAction({ action: 'submit' })
  stage.onAction({ action: 'insert', text: 'say two', key: 's' })
  stage.onAction({ action: 'submit' })
  assert.equal(ctl.presses.length, 0, '忙的时候两下 Enter 一个进程都不起')
  assert.ok(ctl.notes.some((n) => n.includes('排队 2 条')), '两条都在队里（可见）')
  // 那一趟跑完了（`onRunDone`）：自动起队头那一条——是 `say one`，不是刚打的 `say two`。
  ctl.running = false
  stage.onRunDone({ code: 0, why: null })
  assert.deepEqual(ctl.presses.map((p) => p.line), ['say one'], '跑完一趟起的是队头（FIFO）')
  // 第二趟也跑完：起剩下那一条。
  stage.onRunDone({ code: 0, why: null })
  assert.deepEqual(ctl.presses.map((p) => p.line), ['say one', 'say two'], '两条一条一条都起过')
  // 第三趟（队列已空）：什么都不起。
  stage.onRunDone({ code: 0, why: null })
  assert.equal(ctl.presses.length, 2, '队列空了之后收尾不再起新的')
})

test('⑤ 门关着按 y：它就是个字（进输入行），一个进程都不起', async () => {
  const { stage, ctl } = stageOf({ face: null })
  await stage.refreshGate()
  stage.onAction({ action: 'approve', key: 'y' })
  stage.onAction({ action: 'reject', key: 'n' })
  assert.equal(ctl.presses.length, 0, '门口没有那一批时 y/n 都不起进程')
  assert.equal(ctl.notes.filter((n) => n.includes('举了手') || n.includes('按了')).length, 0, '也不说门口那些话')
  const line = (stage.view().input?.rows ?? []).join(' ')
  assert.ok(line.includes('yn'), `y 与 n 都进了输入行（实得 ${JSON.stringify(line)}）`)
})
