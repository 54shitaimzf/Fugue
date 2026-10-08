// U21 · 舞台的接线断言：不起一个进程、不开一个真终端——deps 全给假的，量的是「按键进来之后
// 舞台做了什么」。分派的判据本身住在它们各自的测试里（`cancel.test.ts` 的七级 · `gate.test.ts`
// 的二段确认 · `queue.test.ts` 的入队形状），这里钉的是**接线**：舞台把哪一份处境喂给了判据、
// 判据出来的那一级动作递没递到（press · stop · note · redraw）。
//
// ⑦（0.2.8 U2）量的是**列宽那一把尺**：阅读面折行用的列宽与框内宽是同一处（`frame.ts` 的
// `innerOf`）——屏上印的与翻页数的是同一串物理行。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StatusRow } from '../probe/status.ts'
import { conclusionLineOf, gateFaceOf, lineOf } from './gate.ts'
import type { Contract } from '../contract/types.ts'
import type { GateFace } from './gate.ts'
import { openStage } from './stage.ts'
import { panelWantOf } from './layout.ts'
import type { LineArgv, RunLauncher } from './run.ts'
import { innerOf } from './frame.ts'
import { widthOf } from './glyph.ts'
import { faceRowsOf, facesOf, firstFace, readStateOf } from './read.ts'

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
function stageOf(
  o: {
    face?: GateFace | null
    rows?: readonly StatusRow[]
    running?: boolean
    termRows?: number
    /** 框下面那一行提示行的原文（第二幕 ④）。缺省空串——不给就与从前逐字节相同。 */
    hint?: string
    /** 这一刻的终端列数（U2 的一把尺那一格要它随测试改）。缺省 80，与从前逐字节相同。 */
    columns?: () => number
  } = {},
): {
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
    columns: o.columns ?? ((): number => 80),
    termRows: () => o.termRows,
    hint: () => o.hint ?? '',
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

test('② Tab 补不动就换视图：对话 → 进展 → 结果与花费 → 对话（环形，不越界）', () => {
  const { stage } = stageOf({ rows: NAV_ROWS })
  stage.onAdvance(NAV_ROWS)
  // 空行按 Tab：没有词可补（`completeOf` 答不动）→ 轮到「换视图」那半句（第二幕 ⑦：
  // 三档视图环形轮换；切格改走 `Alt-1…9`，所以这一档不再写注记——换视图在屏上看得见）。
  const viewOf = (): string | undefined => stage.view().view
  assert.equal(viewOf(), 'chat', '缺省那一档是对话（`ui/views.ts` 的 `DEFAULT_VIEW`）')
  stage.onAction({ action: 'complete' })
  assert.equal(viewOf(), 'progress', '第一下换到进展')
  stage.onAction({ action: 'complete' })
  assert.equal(viewOf(), 'spending', '第二下换到结果与花费')
  stage.onAction({ action: 'complete' })
  assert.equal(viewOf(), 'chat', '第三下绕回对话——是环形不是到头停')
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

test('⑥ 面板高度按终端行数分账：输入那块不得与显示区等高（2026-09-29 的口径）', () => {
  // 纯表：panelWantOf 在几档典型终端上的读数——缺省至多 2/5（下限 8 · 上限 K）· 弹层至多
  // 3/5（上限 24 · 下限是缺省档 + 4）· 量不到行数不分账。
  assert.deepEqual(
    [24, 30, 40, 16].map((r) => panelWantOf(r, false)),
    [9, 10, 10, 8],
    '缺省档：24 行终端 9 行框 · 40 行及以上回到框的 10 行（第二幕 ④：分账收的是框，提示行加在框下面）',
  )
  assert.deepEqual(
    [24, 30, 40, 16].map((r) => panelWantOf(r, true)),
    [13, 17, 23, 12],
    '弹层档：至多 3/5（上限 24），下限是缺省档 + 4',
  )
  assert.deepEqual(
    [panelWantOf(undefined, false), panelWantOf(undefined, true)],
    [10, 24],
    '量不到行数：不分账，回框的 10 行 / OVERLAY_WANT（与「量不到就不夹」同一条）',
  )
  // 接线：24 行的终端上想要 9 行；开一层弹层（Ctrl-P 候选）长到 13；Esc 收掉回到 9。
  const { stage } = stageOf({ termRows: 24 })
  assert.equal(stage.heightWant(), 9, '接线：heightWant 读 deps.termRows 分账')
  stage.onAction({ action: 'panel' })
  assert.equal(stage.heightWant(), 13, '弹层开着走 3/5 那一档')
  stage.onAction({ action: 'cancel' })
  assert.equal(stage.heightWant(), 9, '收掉弹层回到缺省那一档')
})
// ── ⑦ 一把尺（0.2.8 U2）：阅读面折的列宽与框内宽是同一处 ────────────────────────────────
test('⑦ 一把尺：舞台递给阅读面的列宽就是 `innerOf`——屏上印的与翻页数的是同一串', () => {
  // 一条长得画不进框的路径：它折出来的物理行数跟着列宽走。
  const LONG = `src/${'深/'.repeat(40)}a.ts`
  const rows: readonly StatusRow[] = [
    {
      pos: { writer: 'round', seq: 1 },
      e: { t: 'view/write' as never, agent: 'agent/r1/1' as never, path: LONG as never, rev: 1 as never, blob: 'b1' as never, mode: 0o100644 },
    },
    { pos: { writer: 'round', seq: 2 }, e: { t: 'view/remove' as never, agent: 'agent/r1/1' as never, path: 'src/b.ts' as never, rev: 2 as never } },
  ]
  let width = 30
  const { stage } = stageOf({ rows, columns: () => width })
  stage.onAction({ action: 'read' })

  const faces = facesOf(readStateOf(rows))
  const name = firstFace(faces)
  assert.equal(name, 'diff', '这一份账有变更：先看 diff 那一面')
  const want = faceRowsOf(faces, name, innerOf(30))
  assert.deepEqual([...(stage.view().read?.rows ?? [])], [...want], '舞台按 `innerOf(columns)` 折，不是自己那一把尺')
  assert.ok(want.some((l) => l.includes('深/')), '这一面真折到了那条长路径')
  assert.ok(want.every((l) => widthOf(l) <= innerOf(30)), '每一行都画得进框')
  console.log(`⑦ 读数：路径 ${LONG.length} 字符 → 30 列（框内 ${innerOf(30)}）折成 ${want.length} 行`)

  // **负对照**：旧版那两把尺（显示端按框宽截断 · 滚动端按未折行行数数）——舞台递**未折行的原文**。
  const raw = [faces.diff?.title ?? '', ...(faces.diff?.lines ?? [])]
  assert.notDeepEqual([...raw], [...want], '未折行的那一串与折过的那一串对不上')
  assert.ok(raw.some((l) => widthOf(l) > innerOf(30)), '旧版有画不进框的行（必被 `cell` 截掉尾巴）')
  // 自己那一把尺（`columns` − 1）也对不上：漂移一列，屏幕上少一个字符且不报错。
  assert.notDeepEqual([...faceRowsOf(faces, name, 30 - 1)], [...want], '两把尺差一列：折出来的行不一样')

  // **窄 → 宽**：折的就是新列宽下那一串；`↓` 翻到底停在新那一串的末行上。
  width = 200
  const want2 = faceRowsOf(faces, name, innerOf(200))
  assert.deepEqual([...(stage.view().read?.rows ?? [])], [...want2], '窄 → 宽：同一把尺重新折一遍')
  assert.ok(want2.length < want.length, `宽了折得少（窄 ${want.length} · 宽 ${want2.length}）`)
  for (let i = 0; i < 40; i += 1) stage.onAction({ action: 'historyNewer' })
  assert.equal(stage.view().read?.top, want2.length - 1, '`↓` 翻到底：`top` 停在新列宽那一串的末行')
  console.log(`⑦ 读数：200 列（框内 ${innerOf(200)}）折成 ${want2.length} 行 · 翻到底 top=${want2.length - 1}`)
})

// ── ⑧ 结论行进永久行（第二幕 ⑧）──────────────────────────────────────────────────
test('⑧ 门口一开就推一条结论行：一批恰一条 · 同一批再算一遍不再说 · 换一批才说', async () => {
  // 一份最小的调查契约（不占路径 · 不算验收——三个数里只有 tasks 那一栏非零）。
  const contract = {
    id: 'r1.investigate.1',
    agent: 'agent/r1/1',
    kind: 'investigate',
    question: '现状怎么写的',
    evidenceRequired: [],
    seed: [],
  } as unknown as Contract
  const said = (): readonly string[] => ctl.notes.filter((n) => n.includes('打算开'))
  const { stage, ctl } = stageOf({ face: gateFaceOf({ round: 'r1', fingerprint: 'fp-1', same: [], contracts: [contract] }, {}) })
  await stage.refreshGate()
  assert.deepEqual(
    [...said()],
    [conclusionLineOf({ tasks: 1, paths: 0, accepts: 0 })],
    `门口开一次恰一条结论行：${JSON.stringify(said())}`,
  )
  // 账又往前动了一条（`round/*` / `holder/*`）→ 重算一遍：**同一批不再说第二遍**。
  await stage.refreshGate()
  assert.equal(said().length, 1, '同一批重算不重复推')
  // 换一批（编号变了）：再说一条，而且是新那一批的数。
  ctl.face = gateFaceOf({ round: 'r1', fingerprint: 'fp-2', same: [], contracts: [contract, contract] }, {})
  await stage.refreshGate()
  assert.equal(said().length, 2, '换了一批要说')
  assert.ok(said()[1]?.includes('2 个'), `第二条说的是新那一批：${said()[1]}`)
  // 门口没了（那一批发出去了）：不推任何东西。
  ctl.face = null
  await stage.refreshGate()
  assert.equal(said().length, 2, '门口没了不再推')
  console.log(`⑧ 读数：结论行 ${said().length} 条（一批一条）· 第一条「${said()[0] ?? ''}」`)
})
