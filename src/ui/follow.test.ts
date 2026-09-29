// TUI 的第四格：**跟随接上**（PLAN § 5.19 第五段 `UI3` 那一行 · `probe/watch.ts` 头上那条"到达序"·
// PLAN § 5.18 的三面表）。跑法：cd ~/fugue && node --test src/ui/follow.test.ts
//
// 这一份量的七样：
//
//   ① **不许有第二种答案**：同一批事件，跟随那一档的最后一帧与"一次性读齐再折"的那一帧逐字节
//      相同；写出去的永久行那一串也逐字相同（次序 · 条数 · 正文）。
//   ② **一条都不少**（晚出现的 writer）：它的第一条是 `seq = 1`，排在该 writer 之前读到过的
//      `seq = 3` 之后——跟随照样把它写进历史。这一份夹具的到达序与全序**本来就不同**（下面那一条
//      断言把这件事钉住：相同的话这一条就量不到"到达序"）。
//   ③ **负对照 · "从 seq N 接着读"**：自己写一个那样的跟随器（游标是一个数，不是每个 writer 一个）
//      → 晚出现的那个 writer 整段漏掉、两条 `agent/r1/1` 一条都读不到，当场看得出差别。
//   ④ **每一帧都是"那一刻"的答案**：第 i 帧逐字节等于"到那一刻为止读到的那些行"一次性折出来的
//      那一帧（一片一帧：每趟读齐一片、一趟一画）。
//   ⑤ **第一趟读齐、只画一次**：账上已经有的那些不是一条画一帧（`UI2` 实测过一次启动 31 次重画）。
//   ⑥ **地板**：`tuiModeOf` 那张表 · 只印永久行那一档面板一次都不画、`redraw()` 一个字节都不写。
//   ⑦ **历史不许被回头改**：已经写出去的那几条变了（换掉分法那一张表）→ `newLinesOf` 当场抛。
//   ⑧ **永久行那一栏只折尾部**（U5）：同一批反复问零重折 · 新到的只折新增段 · 拼起来的答案与
//      全量折逐字相同（查表次数在一张计数表上数出来）。
//   ⑨ **--tail N**（U15）：首趟只写尾部 N 条 · 跳过的按已写出去记（不补印）· 新到的照常增量 ·
//      N 大过行数全印 · 不给 reveal 与从前逐字节相同。
//   ⑩ **帧快照记忆**（U16）：同批连问（含 note()×3 · frame/panel 交叉）不新增 fold · 新批恰一次 ·
//      换焦点重折（注入计数数出来的）。
//
// 这一份不碰真日志、不碰终端：读那一头是**一本会长的假账**（每一趟读放出一片），摆那一头是
// `ui/term.ts` 那个接口的**记录器**（它用真的 `panelOf` 补到 K 行 × 列数，所以记下来的那几行就是
// 真终端上会出现的那几行）。真终端上的字节由 `ui/term.test.ts` 管，两份各管一头。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Log, LogEvent } from '../log/events.ts'
import type { ReadingsOptions, StatusReadings, StatusRow } from '../probe/status.ts'
import { readingsOf } from '../probe/status.ts'
import { readNew } from '../probe/watch.ts'
import type { Frame } from './frame.ts'
import { frameOf, panelOf } from './frame.ts'
import { widthOf } from './glyph.ts'
import type { FamilyTable } from './stream.ts'
import { FAMILY_KIND, permanentLinesOf } from './stream.ts'
import { K } from './term.ts'
import type { Term } from './term.ts'
import type { Tui, TuiCounts, TuiMode } from './follow.ts'
import { RESIZE_WAIT_MS, newLinesOf, openSession, openTui, tuiModeOf } from './follow.ts'

/** 类型上不必较真的那几栏（品牌类型）：这些行是喂给渲染的，不是账上真发生过的。 */
const brand = (v: string): never => v as never

/** 账上的一条：**两个坐标都显式给**——账上就是每个 writer 各数各的 `seq`。 */
const at = (writer: string, seq: number, e: LogEvent): StatusRow => ({ pos: { writer: brand(writer), seq }, e })

const intent = (body: string): LogEvent => ({
  t: 'round/intent',
  round: brand('r1'),
  base: brand('0123456789abcdef'),
  digest: 'd1',
  body,
})
const state = (from: string, to: string): LogEvent => ({
  t: 'round/state',
  round: brand('r1'),
  from: brand(from),
  to: brand(to),
})
const stop = (steps: number): LogEvent => ({
  t: 'agent/stop',
  agent: brand('agent/r1/1'),
  steps,
  stopped: '收敛',
  handoffs: 0,
})
const accept = (): LogEvent => ({
  t: 'merge/accept',
  round: brand('r1'),
  commit: brand('abcdef0123456789'),
  assertions: [{ assertion: '缺省那一档', verdict: 'pass' }],
})
/** 只进瞬态区的那一族（一条也不进历史，但每一条都该让面板重画一次）。 */
const call = (): LogEvent => ({
  t: 'llm/call',
  agent: brand('agent/r1/1'),
  step: brand('1'),
  model: brand('deepseek-flash/anthropic'),
  wire: 'anthropic-messages',
  thinking: null,
  toolCount: 9,
  invocations: 1,
  status: null,
  headers: null,
  usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 40 },
  rawStop: 'end_turn',
  stop: brand('end-turn'),
})

/**
 * 一份夹具：**按 seq 分片**——同一号 `seq` 的两个 writer 在同一片里到。于是"新事件都长在尾部"，
 * 两条路（跟随的到达序 · 一次性读的全序）的次序相同：这正是 ① 要量那一档。
 */
function tailChapters(): StatusRow[][] {
  return [
    [at('round', 1, intent('给记账库加一条按天汇总')), at('agent/r1/1', 1, stop(3))],
    [at('round', 2, state('Idle', 'Planning')), at('agent/r1/1', 2, call())],
    [at('round', 3, accept()), at('agent/r1/1', 3, call())],
  ]
}

/**
 * 同一份账，但**晚出现的 writer**：`agent/r1/1` 的日志口在 `round` 那一路写到第三条之后才开，
 * 它第一条是 `seq = 1`。到达序（两片）与全序（按 `(seq, writer)` 归并）在这里**不同**——②③ 量它。
 */
function lateChapters(): StatusRow[][] {
  return [
    [
      at('round', 1, intent('给记账库加一条按天汇总')),
      at('round', 2, state('Idle', 'Planning')),
      at('round', 3, state('Planning', 'Delegated')),
    ],
    [at('agent/r1/1', 1, stop(3)), at('agent/r1/1', 2, call()), at('round', 4, accept())],
  ]
}

/** 一片里那几条按 `(seq, writer)` 排——`readMerged` 的合并序（`log.ts` 250 行那一处）。 */
function mergedOf(rows: readonly StatusRow[]): StatusRow[] {
  return [...rows].sort(
    (a, b) =>
      a.pos.seq - b.pos.seq || (a.pos.writer < b.pos.writer ? -1 : a.pos.writer > b.pos.writer ? 1 : 0),
  )
}

interface Scripted {
  readonly log: Pick<Log, 'readMerged'>
  /** 到这一刻为止放出来的那些行（按片放，片内按合并序）。 */
  readonly released: () => readonly StatusRow[]
  readonly calls: () => number
}

/**
 * **一本会长的假账**：第 n 次 `readMerged` 放出第 n 片（片放出来之后就一直在），并照 `readMerged`
 * 的语义按 `seq > fromSeq` 筛。它这样长法正对得上跟随的节奏：一趟读一次。
 */
function scripted(
  chapters: readonly (readonly StatusRow[])[],
  o: { readonly onRead?: (n: number) => void } = {},
): Scripted {
  const out: StatusRow[] = []
  let calls = 0
  const log = {
    async *readMerged(fromSeq = 0): AsyncGenerator<{ pos: StatusRow['pos']; e: LogEvent }> {
      calls += 1
      const ch = chapters[calls - 1]
      if (ch !== undefined) out.push(...ch)
      o.onRead?.(calls)
      for (const r of mergedOf(out)) if (r.pos.seq > fromSeq) yield { pos: r.pos as never, e: r.e }
    },
  }
  return { log: log as Pick<Log, 'readMerged'>, released: () => out, calls: () => calls }
}

/** 摆的那一头：记下每一次 `draw` 摆了什么（`panelOf` 那一步是真的，所以记的就是屏幕上那几行）。 */
interface Recorded {
  readonly permanent: readonly string[]
  readonly panel: readonly string[]
}

function recorder(o: { readonly columns?: number; readonly height?: number; readonly ansi?: boolean } = {}): {
  readonly term: Term
  readonly records: Recorded[]
} {
  const columns = o.columns ?? 80
  const height = o.height ?? K
  const records: Recorded[] = []
  const term: Term = {
    ansi: o.ansi ?? true,
    height,
    columns,
    draw(permanent, render): void {
      // **这一份是记帧的假终端**（量的是"画了几帧、每帧几行"），不是第二份摆法：`Panel` 那一层
      // 拆不拆由真的 `ui/term.ts` 说了算，这里只把面板那几行拿下来记着。
      const asked = render({ columns, height })
      const spec = Array.isArray(asked) ? { rows: asked } : asked
      records.push({
        permanent: [...permanent],
        panel: [...panelOf(spec.rows, height, columns)],
      })
    },
    close(): void {},
  }
  return { term, records }
}

interface Run {
  readonly tui: Tui
  readonly counts: TuiCounts
  /** 面板那一档画出去的每一帧；只印永久行那一档是空的。 */
  readonly records: Recorded[]
  /** 只印永久行那一档印出去的那些行（按印的次序）。 */
  readonly lines: string[]
  /** 到跑完为止读进来的行。 */
  readonly rows: readonly StatusRow[]
}

/**
 * 跑一趟：按片喂给跟随那一档，**片放完之后再读一趟就把信号拨停**（于是它不会一直等下去）。
 * 第一趟读齐的是第 1 片，之后每一趟读放出下一片。
 */
async function runFollow(o: {
  readonly chapters: readonly (readonly StatusRow[])[]
  readonly mode?: TuiMode
  readonly columns?: number
  readonly height?: number
}): Promise<Run> {
  const rec = recorder({ columns: o.columns, height: o.height })
  const ac = new AbortController()
  const s = scripted(o.chapters, {
    onRead: (n) => {
      if (n > o.chapters.length) ac.abort()
    },
  })
  const lines: string[] = []
  const tui = openTui({
    log: s.log,
    term: rec.term,
    emit: (line) => lines.push(line),
    mode: o.mode ?? 'panel',
    intervalMs: 1,
    signal: ac.signal,
  })
  const counts = await tui.counts
  return { tui, counts, records: rec.records, lines, rows: s.released() }
}

/** 一次性那一档：同一批事件，另一本账**从一开始就全都有**，读齐、折一帧。 */
async function oneShot(chapters: readonly (readonly StatusRow[])[]): Promise<{ rows: StatusRow[]; frame: Frame }> {
  const whole = scripted([chapters.flat()])
  const all = await readNew(whole.log, {})
  const frame = frameOf({
    ...readingsOf(all.rows),
    permanent: permanentLinesOf(all.rows),
    width: 80,
    height: K,
  })
  return { rows: all.rows, frame }
}

/** 底部那 K 行（真终端上就是这块地方：正好 K 行、每行正好 80 列）。 */
const panelOfFrame = (f: Frame): string[] => [...panelOf(f.lines, K, 80)]

/** 折一帧（尺寸与记录器一致）。 */
function frameAt(rows: readonly StatusRow[]): Frame {
  return frameOf({ ...readingsOf(rows), permanent: permanentLinesOf(rows), width: 80, height: K })
}

/** 跟随那一档画帧的那几步：**一片一帧**（每趟读齐一片、一趟一画，U4）。 */
function stepsOf(chapters: readonly (readonly StatusRow[])[]): StatusRow[][] {
  const steps: StatusRow[][] = []
  let acc: StatusRow[] = []
  for (const ch of chapters) {
    acc = [...acc, ...mergedOf(ch)]
    steps.push([...acc])
  }
  return steps
}

test('① 跟随那一档的最后一帧 = 同一批事件一次性读齐再折出来的那一帧（逐字节）', async () => {
  const chapters = tailChapters()
  const r = await runFollow({ chapters })
  const one = await oneShot(chapters)
  const last = r.records[r.records.length - 1] as Recorded
  const want = panelOfFrame(one.frame)
  assert.deepEqual([...last.panel], want, '跟随读到的那一块面板与一次性折出来的那一块不逐字节相同')
  assert.equal(
    last.panel.every((row) => widthOf(row) === 80),
    true,
    '面板有一行的显示宽度不是终端列数（"上移 K 行"就不落在面板顶上了）',
  )
  assert.equal(last.panel.length, K, `面板该是恒定 ${K} 行，拿到 ${last.panel.length} 行`)
  const written = r.records.flatMap((x) => [...x.permanent])
  assert.deepEqual(written, [...permanentLinesOf(one.rows)], '写出去的永久行那一串与一次性那一栏不逐字相同')
  assert.equal(r.counts.rows, one.rows.length, '跟随读进来的行数与一次性读齐的行数对不上')
  assert.equal(r.counts.permanent, permanentLinesOf(one.rows).length)
  console.log(
    `① 读数：跟随 ${r.counts.rows} 行 / ${r.records.length} 帧 / 永久 ${r.counts.permanent} 条 · ` +
      `一次性 ${one.rows.length} 行 · 最后一帧 ${last.panel.length} 行 × ${widthOf(last.panel[0] as string)} 列 逐字节相同`,
  )
})

test('② 一条都不少：晚出现的 writer（seq=1 排在读过的 seq=3 之后）照样写进历史', async () => {
  const chapters = lateChapters()
  const r = await runFollow({ chapters })
  const one = await oneShot(chapters)
  const written = r.records.flatMap((x) => [...x.permanent])
  const still = [...permanentLinesOf(one.rows)]
  assert.deepEqual([...written].sort(), [...still].sort(), '同一个集合（次序那一档两条路本来就不同）')
  assert.equal(written.length, still.length, `历史条数对不上：跟随 ${written.length} 条 · 一次性 ${still.length} 条`)
  assert.equal(
    written.some((l) => l.startsWith('agent/r1/1 1 · ')),
    true,
    `晚出现那个 writer 的那一条该在历史里：${written.join(' ｜ ')}`,
  )
  assert.notDeepEqual(written, still, '这一份夹具里到达序与全序本来就不同——相同就量不到"到达序"这件事了')
  assert.equal(r.counts.rows, one.rows.length, '跟随读进来的行数与一次性读齐的行数对不上（漏了或重了）')
  console.log(
    `② 读数：跟随 ${r.counts.rows} 行（到达序，含 agent/r1/1 的 ${written.filter((l) => l.startsWith('agent/r1/1')).length} 条）· ` +
      `一次性 ${one.rows.length} 行（全序）· 集合逐字相同、次序不同（就此一条）`,
  )
})

/** 负对照：**"从 seq N 接着读"**那种写法——游标是一个数，不是每个 writer 一个。 */
async function* naiveFollow(
  log: Pick<Log, 'readMerged'>,
  signal: AbortSignal,
  intervalMs: number,
): AsyncGenerator<StatusRow> {
  let from = 0
  for (;;) {
    if (signal.aborted) return
    let n = 0
    for await (const row of log.readMerged(from)) {
      from = row.pos.seq
      n += 1
      yield { pos: row.pos, e: row.e }
    }
    if (n > 0) continue
    await new Promise((done) => setTimeout(done, intervalMs))
  }
}

test('③ 负对照 · "从 seq N 接着读"：晚出现的那个 writer 整段漏掉', async () => {
  const chapters = lateChapters()
  const ac = new AbortController()
  const s = scripted(chapters, {
    onRead: (n) => {
      if (n > chapters.length) ac.abort()
    },
  })
  const bad: StatusRow[] = []
  for await (const row of naiveFollow(s.log, ac.signal, 1)) bad.push(row)
  const good = await runFollow({ chapters })
  const badIds = bad.map((r) => `${r.pos.writer} ${r.pos.seq}`)
  const goodIds = good.rows.map((r) => `${r.pos.writer} ${r.pos.seq}`)
  assert.deepEqual(badIds, ['round 1', 'round 2', 'round 3', 'round 4'], `这一档该只读到 round 那一路：${badIds.join(' · ')}`)
  assert.equal(badIds.some((id) => id.startsWith('agent/r1/1')), false, '"从 seq N 接着读"却读到了晚出现的那个 writer')
  assert.equal(goodIds.filter((id) => id.startsWith('agent/r1/1')).length, 2, '正着那一档该读到那两条')
  // 两条路的面板因此不同（① 那条断言在错的那一档上会红——这就是它的牙）。
  const badFrame = frameAt(bad)
  const goodLast = good.records[good.records.length - 1] as Recorded
  assert.notDeepEqual([...goodLast.panel], panelOfFrame(badFrame), '两种读法给出的面板竟然一样——那①就量不出东西')
  console.log(
    `③ 读数：正着 ${goodIds.length} 条（agent/r1/1 2 条）· "从 seq N 接着读" ${badIds.length} 条（${badIds.join(' · ')}）——` +
      `晚出现那个 writer 整段漏掉，面板也不同`,
  )
})

test('④ 每一帧都是"那一刻"的答案（一片一帧：每趟读齐一片、一趟一画）', async () => {
  const chapters = tailChapters()
  const r = await runFollow({ chapters })
  const steps = stepsOf(chapters)
  assert.equal(
    r.records.length,
    steps.length,
    `画了 ${r.records.length} 帧，按"一片一帧"（U4）该是 ${steps.length} 帧`,
  )
  steps.forEach((rows, i) => {
    const rec = r.records[i] as Recorded
    assert.deepEqual([...rec.panel], panelOfFrame(frameAt(rows)), `第 ${i + 1} 帧不是那一刻的答案`)
  })
  assert.equal(r.counts.draws, r.records.length, '画了几次那一栏与记下来的帧数对不上')
  console.log(
    `④ 读数：${r.records.length} 帧逐帧逐字节对得上（${chapters.length} 片各一帧：` +
      `${chapters.map((ch) => (ch as readonly StatusRow[]).length).join(' + ')} 条）`,
  )
})

test('⑤ 第一趟读齐、只画一次：账上已经有的那些不是一条画一帧', async () => {
  // 同一批 7 条（两个 writer 的 seq 1..4 都到齐）一次放出来：第一趟读齐。
  const chapters: StatusRow[][] = [
    [
      at('round', 1, intent('给记账库加一条按天汇总')),
      at('agent/r1/1', 1, call()),
      at('round', 2, state('Idle', 'Planning')),
      at('agent/r1/1', 2, call()),
      at('round', 3, state('Planning', 'Delegated')),
      at('agent/r1/1', 3, stop(3)),
      at('round', 4, accept()),
    ],
  ]
  const r = await runFollow({ chapters })
  const one = await oneShot(chapters)
  assert.equal(r.records.length, 1, `第一趟该只画一帧，画了 ${r.records.length} 帧（一条一画那条路回来了）`)
  assert.equal(r.counts.draws, 1)
  // 那 7 条里配得上历史的是 5 条：4 条事件族各一条 + 只进瞬态区那两条 `llm/call` 不进历史。
  assert.equal(r.counts.permanent, 5, `这一份夹具该有 5 条永久行，数出 ${r.counts.permanent} 条`)
  assert.deepEqual([...(r.records[0] as Recorded).permanent], [...permanentLinesOf(one.rows)], '一帧里该把 5 条一次写出去')
  assert.equal((r.records[0] as Recorded).permanent.length, 5)
  console.log(
    `⑤ 读数：7 条一次读齐 → 画 ${r.counts.draws} 帧 · 一帧里写出去 ${(r.records[0] as Recorded).permanent.length} 条永久行` +
      `（只进瞬态区那两条一条都不进历史）· 每一趟重画一次那一档见④`,
  )
})

test('⑥ 地板：只印永久行那一档面板一次都不画 · `redraw()` 一个字节都不写 · `tuiModeOf` 那张表', async () => {
  assert.deepEqual(
    [
      tuiModeOf({ ansi: true, once: false, follow: false }),
      tuiModeOf({ ansi: true, once: false, follow: true }),
      tuiModeOf({ ansi: true, once: true, follow: false }),
      tuiModeOf({ ansi: false, once: false, follow: false }),
      tuiModeOf({ ansi: false, once: false, follow: true }),
    ],
    ['panel', 'panel', 'lines-once', 'lines-once', 'lines-follow'],
    '四档地板那张表变了（真终端 · --once · 不是 TTY · TERM 认不出来）',
  )
  const chapters = tailChapters()
  const r = await runFollow({ chapters, mode: 'lines-once' })
  assert.equal(r.records.length, 0, '只印永久行那一档画了面板')
  assert.equal(r.counts.draws, 0)
  const one = await oneShot(chapters)
  assert.deepEqual([...r.lines], [...permanentLinesOf(one.rows).slice(0, r.lines.length)], '印出去的那些行与那一栏不逐字相同')
  assert.equal(r.lines.length, 2, `--once 那一档该只印第 1 片那 2 条永久行，印了 ${r.lines.length} 条`)
  r.tui.redraw()
  assert.equal(r.records.length, 0, '只印永久行那一档的 redraw() 写了面板')
  console.log(
    `⑥ 读数：tuiModeOf 5 种组合 → panel · panel · lines-once · lines-once · lines-follow · ` +
      `lines-once 印 ${r.lines.length} 行 · 面板 0 帧 · redraw() 之后还是 0 帧`,
  )
})

test('⑨ resize 尾沿防抖（U7）：连按三次只补一画 · 安静期没到不画 · redraw() 仍立即', async () => {
  const r = await runFollow({ chapters: [[at('round', 1, intent('防抖的夹具'))]] })
  const before = r.records.length
  r.tui.redraw()
  assert.equal(r.records.length, before + 1, 'redraw() 是立即的那一条')
  const settled = (): Promise<void> => new Promise((done) => setTimeout(done, 60))
  r.tui.resize()
  await settled()
  r.tui.resize()
  await settled()
  r.tui.resize()
  assert.equal(r.records.length, before + 1, '安静期没到不该画（还在连发）')
  await new Promise((done) => setTimeout(done, RESIZE_WAIT_MS + 80))
  assert.equal(r.records.length, before + 2, `连发三次只补一画（尾沿），拿到 ${r.records.length - before - 1} 画`)
  console.log(`⑨ 读数：redraw() 立即 +1 · 60ms 间隔连按三次 → 安静 ${RESIZE_WAIT_MS}ms 后恰 +1`)
})

test('⑦ 历史不许被回头改：已经写出去的那几条变了就当场抛', () => {
  const rows = tailChapters().flat()
  const all = permanentLinesOf(rows)
  const moved = permanentLinesOf(rows, { ...FAMILY_KIND, 'round/state': 'transient' })
  assert.deepEqual([...newLinesOf(all, [])], [...all], '第一次该把全部都当新的')
  assert.deepEqual([...newLinesOf(all, all.slice(0, 2))], [...all.slice(2)], '写过的那两条不该再写一遍')
  assert.deepEqual([...newLinesOf(all, all)], [], '全都写过了就不该再有新的')
  assert.throws(
    () => newLinesOf(moved, all.slice(0, 3)),
    /永久行那一栏回头改了第 3 条/,
    '已经写出去的那几条变了却没抛——那就成了静默把终端历史重新编号',
  )
  // 反面：变了的那一条还**没写出去**时不抛——那时接着写就是对的（写出去的是现在这一份）。
  assert.deepEqual([...newLinesOf(moved, all.slice(0, 2))], [...moved.slice(2)], '还没写出去的那一段不该拦')
  console.log(
    `⑦ 读数：all ${all.length} 条 · 挪走 round/state 之后 ${moved.length} 条 · ` +
      `已写过 3 条时再折 → 第 3 条变了、当场抛；只写过 2 条时（第 3 条还没出去）不抛`,
  )
})

test('⑧ 永久行那一栏只折尾部（U5）：反复问不重折 · 新到的只折新增段 · 答案与全量折逐字相同', () => {
  // 计数表：查一次分法记一次——「折了几条」在它上面数得出来。
  let asks = 0
  const table: FamilyTable = new Proxy(FAMILY_KIND, {
    get(t, k) {
      asks += 1
      return (t as Record<string, unknown>)[k as string]
    },
  })
  const s = openSession({ table })
  const ch1 = mergedOf(tailChapters()[0] as readonly StatusRow[])
  const ch2 = mergedOf(tailChapters()[1] as readonly StatusRow[])
  const ch3 = mergedOf(tailChapters()[2] as readonly StatusRow[])
  s.push(ch1)
  assert.deepEqual([...s.permanent()], [...permanentLinesOf(ch1)], '第 1 段的答案与全量折不逐字相同')
  const after1 = asks
  // 再问三遍：一次都不该重折（asks 不动），答案每次都是全量那一份。
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual([...s.permanent()], [...permanentLinesOf(ch1)], '第 1 段的答案与全量折不逐字相同')
  }
  assert.equal(asks, after1, `反复问把已折的又折了一遍（asks ${after1} → ${asks}）`)
  // 新到两段：只折新增的，前缀一次都不碰。
  s.push(ch2)
  s.permanent()
  const after2 = asks
  s.push(ch3)
  const all = s.permanent()
  assert.deepEqual([...all], [...permanentLinesOf([...ch1, ...ch2, ...ch3])], '拼起来的答案与全量折不逐字相同')
  assert.ok(asks > after2, '新到的那一段该真的折了（asks 没动就是压根没折）')
  console.log(
    `⑧ 读数：第 1 段折 ${after1} 次查表 · 反复问 3 遍零新增 · 第 2 段 +${after2 - after1} · ` +
      `第 3 段 +${asks - after2} · 答案与全量折逐字相同`,
  )
})

test('⑨ --tail N（U15）：首趟只写尾部 N 条 · 跳过的按已写出去记 · 不给就全印', () => {
  // 三段章 + 一条 state：折出恰 5 条永久行（llm/call 是瞬态，一条都不进历史）。
  const rows = [...tailChapters().flat(), at('round', 4, state('Planning', 'Delegated'))]
  const all = permanentLinesOf(rows)
  assert.equal(all.length, 5, `这份夹具该折出恰 5 条永久行（拿到 ${all.length}）——断言语义靠它`)

  // --tail 2：首趟恰印尾部 2 条（与全量折的最后一刀逐字相同），跳过的前 3 条不会补印。
  const t = openSession({ reveal: 2 })
  t.push(rows)
  const first = t.fresh()
  assert.deepEqual([...first], [...all.slice(3)], '首趟该只写尾部 2 条')
  assert.deepEqual([...t.fresh()], [], '跳过的前 3 条按已写出去记——第二趟不补印')
  // 账往前动一条：新折出来的照常写出（reveal 只管首趟）。
  const more = [at('round', 5, state('Delegated', 'Merged'))]
  t.push(more)
  assert.deepEqual([...t.fresh()], [...permanentLinesOf(more)], '首趟之后新到的照常增量写出')

  // N 大过行数：就是全部（不截断成 0）。
  const whole = openSession({ reveal: 99 })
  whole.push(rows)
  assert.deepEqual([...whole.fresh()], [...all], 'N 大过行数就是全印')

  // 不给 reveal：与从前逐字节相同（全印）——开关的缺省档是"没这回事"。
  const plain = openSession()
  plain.push(rows)
  assert.deepEqual([...plain.fresh()], [...all], '不给 reveal 就全印')

  console.log(
    `⑨ 读数：5 条旧账 --tail 2 → 首趟印 ${first.length} 条 · 新到的 1 条照常增量 · ` +
      'N=99 全印 · 不给 reveal 全印',
  )
})

test('⑩ 帧快照记忆（U16）：同批连问（含 note()×3）不新增 fold · 新批恰一次 · 换焦点重折', async () => {
  // 注入计数：折一刀记一笔——「一批折了几次」在它上面数得出来（U16 的断言就数这个）。
  let folds = 0
  const counted = (rows: readonly StatusRow[], opts?: ReadingsOptions): StatusReadings => {
    folds += 1
    return readingsOf(rows, opts)
  }

  // openTui 那一头：三批账跑完（一批一画），folds 该恰等于批数——每批恰折一次。
  const chapters = tailChapters()
  const rec = recorder()
  const ac = new AbortController()
  const s = scripted(chapters, {
    onRead: (n) => {
      if (n > chapters.length) ac.abort()
    },
  })
  const tui = openTui({
    log: s.log,
    term: rec.term,
    emit: () => {},
    mode: 'panel',
    intervalMs: 1,
    signal: ac.signal,
    fold: counted,
  })
  await tui.counts
  const afterRun = folds
  assert.equal(afterRun, chapters.length, `${chapters.length} 批账（一批一画）该恰折 ${chapters.length} 次（拿到 ${afterRun}）`)
  // 账停着的时候连按三下 note()：每一下都 paint()（按键要当场看得见），但那一批已经折过了——
  // 一次都不该重折。
  tui.note('按下去了 a')
  tui.note('按下去了 b')
  tui.note('按下去了 c')
  assert.equal(folds, afterRun, `同批 note()×3 不该新增 fold（${afterRun} → ${folds}）`)
  assert.ok(rec.records.length >= 3, 'note 那三下真的画了（records 有它们）——不是没画所以没折')

  // session 那一头：frame/panel 交叉问同一批，只折一次；新批恰 +1。
  let sFolds = 0
  const sCounted = (rows: readonly StatusRow[], opts?: ReadingsOptions): StatusReadings => {
    sFolds += 1
    return readingsOf(rows, opts)
  }
  const size = { columns: 80, height: K }
  const ses = openSession({ fold: sCounted })
  const ch1 = mergedOf(chapters[0] as readonly StatusRow[])
  const ch2 = mergedOf(chapters[1] as readonly StatusRow[])
  ses.push(ch1)
  ses.frame(size)
  const afterFirst = sFolds
  assert.equal(afterFirst, 1, '第一批折一次')
  ses.panel(size)
  ses.frame(size)
  ses.frame(size)
  assert.equal(sFolds, afterFirst, '同批 frame/panel 交叉问三遍，fold 一次不新增')
  ses.push(ch2)
  ses.frame(size)
  assert.equal(sFolds, afterFirst + 1, '新到一批恰再折一次')

  // 换焦点：键换了就重折（那是换答案，不是白烧）；换回也重折一次——缓存只有一格，不追历史。
  let focus: string | null = null
  const focused = openSession({
    fold: sCounted,
    view: () => (focus === null ? {} : { focus }),
  })
  focused.push(ch1)
  focused.frame(size)
  const f1 = sFolds
  focus = 'round'
  focused.frame(size)
  assert.equal(sFolds, f1 + 1, '焦点一换（Tab 切格）重折——筛的是另一批行')
  focused.frame(size)
  assert.equal(sFolds, f1 + 1, '同一焦点连问不重折')
  focus = null
  focused.frame(size)
  assert.equal(sFolds, f1 + 2, '换回整份账也重折一次（缓存一格，不追历史）')

  console.log(
    `⑩ 读数：3 批账恰折 ${afterRun} 次 · 同批 note()×3 与交叉问零新增 · 新批 +1 · ` +
      `换焦点重折（${f1 + 1 - f1} 次/换）`,
  )
})
