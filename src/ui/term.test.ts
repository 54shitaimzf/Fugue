// TUI 的第三格：**接终端**（PLAN § 5.19 第五段 `UI2` 那一行 · 架构 § 9.8 的可附着 TUI）。
// 跑法：cd ~/fugue && node --test src/ui/term.test.ts
//
// 这一份量的六样（**一个真的终端都不碰**：那一头是一个假 sink，"写出去的字节"就是读数）：
//
//   ① **一帧的字节**：手写那一份逐字节等于原件；再拿真 `frameOf` 的 `lines` 走一遍，**底部那 K 行
//      逐字等于 `frameOf({ …, permanent, width, height: K }).lines`**（渲染不在终端里发生，终端
//      只负责擦与摆）。
//   ② **每一行的显示宽度恰好等于终端列数**——这就是"1 逻辑行 = 1 物理行"，也是"上移 K 行"的牙；
//      负对照：给一行超宽的 → 当场被截到正好 `columns`（不截的话它物理上占两行，K 就错位）。
//   ③ **区域是恒定 K 行**：`frameOf` 只给三行时区域照样 K 行，所以上移的数是 **K**，不是"上一帧
//      写了几行"；而且**永久行只写一次**（重画只擦改面板那 K 行，历史是追加的）。
//   ④ **resize**：宽度一变就不"上移 K 行"（重排之后那几行占几个物理行量不到），新宽度另起一块，
//      `close()` 也不去删它；列宽量不到（`undefined`）兜 80。
//   ⑤ **地板：不是 TTY / `$TERM` 认不出来 → 一个字节的 ANSI 都不写**（只印永久行）。
//   ⑥ **收尾**：画过 → 上移 K 行 + 删掉 K 行；没画过 → 一个字节都不写。
//   ⑧ **输入行**（`T4`）：面板下面那几行输入行逐字写出去 · 光标**停在最后一行**（往左退到光标列）·
//      下一次重画按"上一次停在区域第几行"上移（不是 K）· `close()` 删掉的是"面板 + 输入行"·
//      **负对照**：不给输入行时与从前逐字节相同（这一格不许让老的那一档变样）。
//   ⑨ **整屏 `--full`**（`T10`）：两档的字节流**只差 `ALT_ON` / `ALT_OFF` 这两笔**（排版一行不动）·
//      进在第一次画、出在收尾最后一笔 · 每一条退出路径都写到出来那一条（**宽度变过那一档也写**，
//      它只是不删面板）· `close()` 幂等（崩那一档 `finally` 与 `exit` 那一钩都会调）·
//      **负对照**：不给 `--full` 时一个 alt 序列都不出现，管道那一档给了 `--full` 也不写一个字节。
//   ⑪ **行级 diff**（U8）：`screenOf` 把字节流应用到 string[] 屏幕模型上（跳过认不得的 CSI）——
//      每一帧之后**屏幕可见与 panelOf 的答案全等**（掠过与重写两条路都过同一把尺）· 帧一个字节
//      没变时那帧的 `CLEAR_LINE` 数是零 · 输入行变少的那一趟把多出来的行擦成空行（不留残影）·
//      caret 列非 0 的下一帧不错位（每行 `\r` 起头把列算术闭合——U8 顺手修掉的那个错位）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogEvent } from '../log/events.ts'
import type { StatusRow } from '../probe/status.ts'
import { statusOf } from '../probe/status.ts'
import { frameOf } from './frame.ts'
import { widthOf } from './glyph.ts'
import { permanentLinesOf } from './stream.ts'
import { ALT_OFF, ALT_ON, CLEAR_LINE, FALLBACK_COLUMNS, K, ansiOf, deleteLinesOf, degradeNote, leftOf, openTerm, upOf } from './term.ts'
import type { Term, TermOut } from './term.ts'

/** 一个假的 sink：**写出去的每一次 `write` 就是一条读数**（一次 write = 一个动作）。 */
interface Fake extends TermOut {
  readonly written: string[]
  isTTY?: boolean | undefined
  columns?: number | undefined
  rows?: number | undefined
}

function fakeOut(o: { columns?: number; isTTY?: boolean; term?: string; rows?: number } = {}): Fake {
  const f: Fake = {
    written: [],
    isTTY: o.isTTY ?? true,
    write(s: string): boolean {
      f.written.push(s)
      return true
    },
  }
  if (o.columns !== undefined) f.columns = o.columns
  if (o.rows !== undefined) f.rows = o.rows
  return f
}

/** 一条永久行的那一份账（`round/state` 一条 + `merge/attempt` 一条）——顺手把 UI1 与 UI2 接上。 */
const ROWS: StatusRow[] = [
  { pos: { writer: 'round', seq: 1 }, e: { t: 'round/state', round: 'r1' as never, from: 'Idle' as never, to: 'Planning' as never } },
  { pos: { writer: 'round', seq: 2 }, e: { t: 'merge/attempt', round: 'r1' as never, branches: [] as never, conflicts: 0 } },
]
const SNAPSHOT = statusOf(ROWS)
const PERMANENT = permanentLinesOf(ROWS)

/** 写出去的字节流（U3 之后一帧恰一笔 write）：把那些笔拼起来就是它。 */
const streamOf = (f: Fake): string => f.written.join('')

/** 字节流里那些"清行 + 文本"里的文本（`permanent` 空着时，它们就是面板那几行）。 */
function writtenRows(f: Fake): string[] {
  return streamOf(f)
    .split('\n')
    .flatMap((one) => {
      const at = one.indexOf(CLEAR_LINE)
      if (at < 0) return []
      const rest = one.slice(at + CLEAR_LINE.length)
      // 段尾可能粘着下一段的开头（`upOf` / `leftOf` 那些不带换行的笔）——只留到下一个 ESC。
      const esc = rest.indexOf('\x1b')
      return [esc < 0 ? rest : rest.slice(0, esc)]
    })
}

test('① 一帧的字节：逐字节等于原件，而且**一次绘制恰一笔 write**；底部那 K 行逐字等于 frameOf 的 lines', () => {
  // 手写那一份（K=3 · 20 列）：两条永久行 + 两行面板 → 面板补到三行。
  const f = fakeOut({ columns: 20 })
  const term = openTerm({ out: f, height: 3, term: 'xterm-256color' })
  term.draw(['P1', 'P2'], () => ['R1', 'R2'])
  const blank = ' '.repeat(20)
  const five =
    `\r${CLEAR_LINE}P1\n\r${CLEAR_LINE}P2\n` +
    `\r${CLEAR_LINE}R1${' '.repeat(18)}\n\r${CLEAR_LINE}R2${' '.repeat(18)}\n\r${CLEAR_LINE}${blank}\n`
  assert.equal(f.written.length, 1, `一帧该恰一笔 write（U3），实得 ${f.written.length} 笔`)
  assert.equal(f.written[0], five, '那一块摆出来的字节与原件不逐字相同')

  // 真 `frameOf` 那一份：底部那 K 行逐字等于它的 `lines`（多出来的补空行）。
  const g = fakeOut({ columns: 100 })
  const t2 = openTerm({ out: g, height: 16, term: 'xterm-256color' })
  let asked: { columns: number; height: number } | null = null
  t2.draw(PERMANENT, (size) => {
    asked = size
    return frameOf({ snapshot: SNAPSHOT, permanent: PERMANENT, width: size.columns, height: size.height }).lines
  })
  const frame = frameOf({ snapshot: SNAPSHOT, permanent: PERMANENT, width: 100, height: 16 })
  // 写出去的那一串里，**前 `PERMANENT.length` 条是永久行**，后面才是面板（永久行在面板上方）。
  const panel = writtenRows(g).slice(PERMANENT.length)
  // 前 `frame.lines.length` 行逐字等于 `frameOf` 的 `lines`，剩下的补空白（那块区域是恒定 K 行）。
  assert.deepEqual([...panel.slice(0, frame.lines.length)], [...frame.lines], '底部那几行与 frameOf 的 lines 不逐字相同')
  assert.deepEqual(
    panel.slice(frame.lines.length).map((r) => widthOf(r)),
    panel.slice(frame.lines.length).map(() => 100),
    '补的那几行该是空白（不是内容）',
  )
  assert.equal(panel.length, 16, `那一块该是恒定 16 行（K），拿到 ${panel.length} 行`)
  assert.equal(frame.lines.length, 7, `这一份小账画出来该是 7 行（右栏放宽到 59 列后，原先折的那行放得下了），实得 ${frame.lines.length} 行`)
  assert.deepEqual(asked, { columns: 100, height: 16 }, '渲染拿到的尺寸不是终端量到的那一份')
  console.log(`① 读数：手写那一份 1 笔 write（2 永久行 + 3 行面板拼在里头，U3）· frameOf 那一份 ${panel.length} 行逐字相同 · 渲染拿到的尺寸 ${JSON.stringify(asked)}`)
})

test('② 每一行的显示宽度恰好等于终端列数（不截就物理占两行，K 当场错位）', () => {
  for (const columns of [100, 80, 47, 20]) {
    const f = fakeOut({ columns })
    openTerm({ out: f, height: 3, term: 'xterm-256color' }).draw([], (size) =>
      frameOf({ snapshot: SNAPSHOT, permanent: PERMANENT, width: size.columns, height: size.height }).lines,
    )
    const rows = writtenRows(f)
    assert.deepEqual(rows.map((r) => widthOf(r)), rows.map(() => columns), `${columns} 列那一档有行的宽度不对`)
    assert.equal(rows.length, 3, '恒定 K 行')
  }
  // 负对照：给一行超宽的（60 字 · 20 列）→ 当场截到正好 20 列（留一个 `…`）。
  const f = fakeOut({ columns: 20 })
  openTerm({ out: f, height: 1, term: 'xterm-256color' }).draw([], () => ['甲'.repeat(60)])
  const row = writtenRows(f)[0] as string
  assert.equal(widthOf(row), 20, `超宽那一行没被截到正好 20 列：${widthOf(row)} 列`)
  // 截断的记号是 `…`；宽字符那一档 `clip` 会短一列、由 `cell` 补一个空格（`甲` 9 个 = 18 列 + `…`）。
  assert.equal(row, `${'甲'.repeat(9)}… `, `超宽那一行该截成 9 个甲 + … + 一格补位：${row}`)
  console.log(`② 读数：100 / 80 / 47 / 20 列四档每行都是整列 · 60 字的超宽行 → ${widthOf(row)} 列（${row}）`)
})

test('③ 区域是恒定 K 行：上移的数是 K，而且永久行只写一次', () => {
  const f = fakeOut({ columns: 40 })
  const term = openTerm({ out: f, height: K, term: 'xterm-256color' })
  term.draw(['第一条永久行'], () => ['只给三行', '第二行', '第三行'])
  const first = f.written.join('')
  assert.equal(writtenRows(f).length, K + 1, `第一次该写 1 条永久行 + K 行面板，拿到 ${writtenRows(f).length} 行`)
  f.written.length = 0
  term.draw([], () => ['新的一行'])
  assert.equal(f.written.length, 1, '重画也是一笔（U3）')
  assert.ok(f.written[0]?.startsWith(upOf(K)) === true, `重画该上移 K(${K}) 行起头，实得 ${JSON.stringify(f.written[0])}`)
  // U8 之后重画帧走行级 diff：变了的 3 行重写、其余 9 行掠过——**上移的数仍是 K**（区域没变，
  // 只是没变的行不再一个字节一个字节重写）。
  assert.equal(writtenRows(f).length, 3, `重画帧只重写变了的那 3 行（9 行面板空着没变），实得 ${writtenRows(f).length}`)
  assert.equal(streamOf(f).split('\x1b[1B').length - 1, K - 3, `其余 ${K - 3} 行该掠过（${K - 3} 个下移）`)
  assert.equal(streamOf(f).includes('第一条永久行'), false, '重画把永久行又写了一遍——历史该是追加的，不是重画的')
  // 而第一次那一份里它只出现一次。
  assert.equal(first.split('第一条永久行').length - 1, 1, '永久行写了两遍')
  console.log(`③ 读数：区域 ${K} 行恒定（第一次 ${K + 1} 行含 1 条永久行）· 重画那一笔以 ${JSON.stringify(upOf(K))} 起头 · 永久行只出现 1 次`)
})

test('④ resize：宽度一变就不上移（重排量不到），另起一块；量不到列宽兜 80', () => {
  const f = fakeOut({ columns: 80 })
  const term = openTerm({ out: f, height: 3, term: 'xterm-256color' })
  term.draw([], () => ['a'])
  f.written.length = 0
  term.draw([], () => ['b'])
  assert.ok(f.written[0]?.startsWith(upOf(3)) === true, '宽度没变时该上移')
  f.written.length = 0
  f.columns = 40
  term.draw([], () => ['c'])
  assert.equal(streamOf(f).includes('A'), false, `宽度变过还上移了：${JSON.stringify(f.written)}`)
  assert.deepEqual(writtenRows(f).map((r) => widthOf(r)), [40, 40, 40], '新那一块该按新宽度画')
  // 按新宽度画过一块：那一块落在哪是知道的 → 收得掉。
  f.written.length = 0
  term.close()
  assert.equal(f.written.length, 1, 'close() 也是一笔（U3）')
  assert.equal(f.written[0], upOf(3) + deleteLinesOf(3), '按新宽度画过之后，close() 该收得掉那一块')
  // 反过来：画过一块 80 列的，然后终端变成 40 列、**没有再画** → 重排之后它落在哪量不到 → 不动它。
  const h = fakeOut({ columns: 80 })
  const t3 = openTerm({ out: h, height: 3, term: 'xterm-256color' })
  t3.draw([], () => ['d'])
  h.written.length = 0
  h.columns = 40
  t3.close()
  assert.deepEqual([...h.written], [], '宽度变过（没再画）close() 不该去删面板')

  // 量不到列宽（`columns === undefined`）→ 兜 80。
  const g = fakeOut({})
  const t2 = openTerm({ out: g, height: 1, term: 'xterm-256color' })
  t2.draw([], () => ['x'])
  assert.equal(widthOf(writtenRows(g)[0] as string), FALLBACK_COLUMNS, `量不到列宽该兜 ${FALLBACK_COLUMNS}`)
  console.log(`④ 读数：80 → 40 那一趟不上移（另起一块，3 行都是 40 列）· 按新宽度画过 → close() 收得掉 · 只 resize 没再画 → close() 0 字节 · 量不到列宽兜 ${FALLBACK_COLUMNS} 列`)
})

test('⑤ 地板：不是 TTY / $TERM 认不出来 → 一个字节的 ANSI 都不写', () => {
  for (const [why, o] of [
    ['管道（不是 TTY）', { isTTY: false, term: 'xterm-256color' }],
    ['$TERM=dumb', { isTTY: true, term: 'dumb' }],
    ['$TERM 认不出来', { isTTY: true, term: 'weird-term-9000' }],
    ['$TERM 是空的', { isTTY: true, term: '' }],
  ] as const) {
    const f = fakeOut({ columns: 80, isTTY: o.isTTY })
    const term = openTerm({ out: f, height: 3, term: o.term })
    term.draw(['第一条', '第二条'], () => ['面板这一行'])
    term.close()
    assert.equal(term.ansi, false, `${why}：该退到只印永久行那一档`)
    assert.equal(f.written.length, 1, `${why}：那一档也是一笔`)
    assert.equal(f.written[0], '第一条\n第二条\n', `${why}：那一档只许印永久行`)
    assert.equal(streamOf(f).includes('\x1b'), false, `${why}：写了一个字节的 ANSI`)
  }
  for (const t of ['xterm-256color', 'screen.xterm', 'tmux-256color', 'linux', 'alacritty', 'st-256color']) {
    assert.equal(ansiOf(t), true, `${t} 该认得出来`)
  }
  for (const t of ['dumb', '', undefined, 'stupid', 'vt999']) {
    assert.equal(ansiOf(t), false, `${JSON.stringify(t)} 该退档`)
  }
  console.log(`⑤ 读数：管道 / dumb / 认不出来 / 没给 四档都是 0 个转义字节 · 认得出 ${['xterm-256color', 'screen.xterm', 'tmux-256color', 'linux', 'alacritty', 'st-256color'].length} 种 · 退档 5 种`)
})

test('⑥ 收尾：画过 → 上移 K 行 + 删 K 行；没画过 → 一个字节都不写', () => {
  const f = fakeOut({ columns: 80 })
  const term = openTerm({ out: f, height: 3, term: 'xterm-256color' })
  term.close()
  assert.deepEqual([...f.written], [], '没画过就写字节了')
  term.draw(['一条永久行'], () => ['a'])
  f.written.length = 0
  term.close()
  assert.equal(f.written.length, 1, '收尾也是一笔（U3）')
  assert.equal(f.written[0], upOf(3) + deleteLinesOf(3), '收尾该是"上移 K 行 + 删掉 K 行"')
  console.log(`⑥ 读数：没画过 0 字节 · 画过 → 一笔 ${JSON.stringify(f.written[0])}`)
})

test('⑦ 降级说一声（U10a）：只有「真终端 + 认不出的 $TERM」那一档有那句话', () => {
  // 有那句话的一档：真终端、非空非 dumb、且不在 KNOWN_TERM 表上。
  const note = degradeNote('fugue-term', true)
  assert.ok(note !== null, '真终端 + 认不出 → 该有那句话')
  assert.ok(note.includes('$TERM=fugue-term'), `话里要带那个值：${note}`)
  assert.ok(note.includes('只印永久行'), `话要说清退到哪一档：${note}`)
  // 不说的四档：不是 TTY（管道 · CI）· 没设 · '' 与 dumb（声明过的没有）· 认得出。
  assert.equal(degradeNote('fugue-term', false), null, '不是 TTY 不说——那一档退到永久行是常态')
  assert.equal(degradeNote(undefined, true), null, 'TERM 没设不说')
  assert.equal(degradeNote('', true), null, '空串不说')
  assert.equal(degradeNote('dumb', true), null, 'dumb 是声明过的没有，不是认不出')
  assert.equal(degradeNote('xterm-256color', true), null, '认得出就没有降级')
  console.log(`⑦ 读数：说的一档 1 种 · 不说的四档（非 TTY · 没设 · 空/dumb · 认得出）各 0 字节`)
})

// ── ⑧ 输入行：面板下面那几行，光标停在最后一行 ────────────────────────────────
test('⑧ 输入行：逐字写出去 · 光标退到该在的那一列 · 上移按"上次停在哪一行" · 收尾删的是一整块', () => {
  const panel = frameOf({ snapshot: SNAPSHOT, permanent: PERMANENT, width: 20, height: K }).lines
  const out = fakeOut({ columns: 20 })
  const t = openTerm({ out, term: 'xterm-256color' })
  // 负对照（U8 之后缩到**首帧**：重画帧走行级 diff 不再全量，「与从前逐字节相同」只对首帧成立）。
  t.draw(PERMANENT, () => panel)
  assert.equal(out.written.length, 1, '首帧也是一笔（U3）')
  assert.equal(
    out.written[0],
    PERMANENT.map((p) => `\r${CLEAR_LINE}${p}\n`).join('') + panel.map((r) => `\r${CLEAR_LINE}${r}\n`).join(''),
    '首帧的字节：永久行 + 面板逐行「\\r + 清行 + 行 + 换行」（每行 \\r 起头，U8）',
  )
  t.draw([], () => panel)
  // 有输入行：面板那 K 行之后接着写输入行那两行，**最后一行不带换行**，再往左退到光标列。
  const out2 = fakeOut({ columns: 20 })
  const t2 = openTerm({ out: out2, term: 'xterm-256color' })
  t2.draw([], () => ({ rows: panel, input: { rows: ['» /log', '  --root'], caret: { row: 1, col: 2 } } }))
  assert.ok(
    streamOf(out2).endsWith(
      `\r${CLEAR_LINE}${panel[panel.length - 1] as string}\n` +
        '\r' + CLEAR_LINE + '» /log\n' +
        '\r' + CLEAR_LINE + '  --root' +
        leftOf(widthOf('  --root') - 2),
    ),
    `输入行那两行写得不对：${JSON.stringify(streamOf(out2))}`,
  )
  assert.ok(streamOf(out2).includes(leftOf(widthOf('  --root') - 2)), '光标退到该在的那一列')
  assert.ok(!streamOf(out2).includes('--root\n'), '最后一行不许带换行（光标就停在它上面）')
  // 重画：上移的是"上一次停在哪一行"（K + 输入行数 − 1 = 13），不是 K。
  const before = streamOf(out2).length
  t2.draw([], () => ({ rows: panel, input: { rows: ['» /log', '  --root'], caret: { row: 1, col: 2 } } }))
  assert.equal(out2.written.length, 2, '两次 draw 就是两笔（U3）')
  assert.ok(streamOf(out2).slice(before).startsWith(upOf(K + 2 - 1)), `重画该上移 ${K + 2 - 1} 行（面板 + 输入行 − 1）`)
  // 收尾：上移同一行数 + 删掉"面板 K 行 + 输入行 2 行"。
  const before2 = streamOf(out2).length
  t2.close()
  assert.equal(streamOf(out2).slice(before2), upOf(K + 2 - 1) + deleteLinesOf(K + 2), '收尾删的是整块（面板 + 输入行）')
  // 没有输入行的收尾：上移 K + 删 K（与从前一样）。
  const out3 = fakeOut({ columns: 20 })
  const t3 = openTerm({ out: out3, term: 'xterm-256color' })
  t3.draw([], () => panel)
  t3.close()
  assert.ok(streamOf(out3).endsWith(upOf(K) + deleteLinesOf(K)), '没有输入行时收尾与从前一样')
  console.log(
    `⑧ 读数：输入行 2 行逐字写出去 · 光标退 ${widthOf('  --root') - 2} 列到第 3 列 · ` +
      `重画上移 ${K + 1} 行（不是 K）· 收尾删 ${K + 2} 行 · 不给输入行时逐字节与从前相同`,
  )
})

// ── ⑩ 行数也量（U6）：期望夹进行数 · 矮到画不出框只印永久行 · 行数够了自动回来 ───────
test('⑩ 行数也量（U6）：rows=8 期望 12 → 夹到 7 行；rows=3 → 只印永久行零 ANSI；回来另起一块', () => {
  const f = fakeOut({ columns: 80 })
  f.rows = 8
  const t = openTerm({ out: f, term: 'xterm-256color' })
  t.draw([], () => ['a'])
  assert.equal(writtenRows(f).length, 7, `rows=8 期望 12 该夹到 7 行（留一行），拿到 ${writtenRows(f).length}`)
  // 矮到画不出框：rows=3 → 夹到 2，比 MIN_HEIGHT 还小 → 只印永久行，一个 ANSI 都不写
  // （矮那一帧屏幕顶紧挨着历史，`CLEAR_LINE` 会把历史吃掉一行）。
  f.written.length = 0
  f.rows = 3
  t.draw(['一条永久行'], () => ['a'])
  assert.equal(f.written.length, 1, '矮那一帧该只印永久行')
  assert.equal(f.written[0], '一条永久行\n')
  assert.equal(streamOf(f).includes('\x1b'), false, '矮那一帧一个字节的 ANSI 都不写')
  // 行数回来了：面板自动回来，而且**另起一块**（矮那一帧把 drawn 清了，无上移）。
  f.written.length = 0
  f.rows = 24
  t.draw([], () => ['b'])
  assert.equal(writtenRows(f).length, 12, `rows=24 期望 12 → 12 行，拿到 ${writtenRows(f).length}`)
  assert.ok(f.written[0]?.startsWith(`\r${CLEAR_LINE}`) === true, '矮那一帧之后回来该另起一块（第一笔是回车+清行，不是上移）')
  // 期望每一帧现问：`heightOf` 给多大（装得下时）就画多高。
  const g = fakeOut({ columns: 80 })
  g.rows = 40
  const t2 = openTerm({ out: g, term: 'xterm-256color', heightOf: () => 24 })
  t2.draw([], () => ['c'])
  assert.equal(writtenRows(g).length, 24, `heightOf 给 24（rows=40 装得下）该画 24 行，拿到 ${writtenRows(g).length}`)
  // 量不到行数（`rows` 一直 undefined）→ 不夹，与 U6 之前逐字节相同（①~⑨ 走的就是这一档）。
  const h = fakeOut({ columns: 80 })
  const t3 = openTerm({ out: h, term: 'xterm-256color' })
  t3.draw([], () => ['d'])
  assert.equal(writtenRows(h).length, 12, '量不到行数该按期望画（K=12）')
  // 行数变过（宽度没变）之后 close：不删面板——量不到那一块落在哪。
  g.written.length = 0
  g.rows = 30
  t2.close()
  assert.deepEqual([...g.written], [], '行数变过 close 不该删面板')
  console.log(
    `⑩ 读数：rows=8 → 7 行 · rows=3 → 只印永久行（0 个 ANSI）· 回到 24 另起一块 12 行 · ` +
      `heightOf=24（rows=40）→ 24 行 · 量不到行数 → 12 行（与从前相同）· 行数变过 close 0 字节`,
  )
})

// ── ⑨ 整屏（`--full`）：多两个 escape，排版一行不动 ────────────────────────────
test('⑨ 整屏 --full：两档只差 ALT_ON/ALT_OFF 两笔 · 每一条退出路径都写得到出来那一笔 · 幂等', () => {
  const panel = frameOf({ snapshot: SNAPSHOT, permanent: PERMANENT, width: 40, height: K }).lines
  /** 走一趟完整的一生（画两次 + 收尾），把写出去的字节还回来。 */
  const play = (full: boolean): { readonly t: Term; readonly f: Fake } => {
    const f = fakeOut({ columns: 40 })
    const t = openTerm({ out: f, term: 'xterm-256color', full })
    assert.equal(t.alt, false, '还没画就进 alt screen 了')
    t.draw(PERMANENT, () => ({ rows: panel, input: { rows: ['» /log'], caret: { row: 0, col: 6 } } }))
    assert.equal(t.alt, full, `画过之后 alt 该是 ${full}`)
    t.draw([], () => panel)
    t.close()
    return { t, f }
  }
  const off = play(false)
  const on = play(true)
  // **负对照**：不给 `--full` 那一档一个 alt 序列都不出现（缺省关是关得干净的）。
  assert.equal(off.t.alt, false, '缺省那一档不该进 alt screen')
  assert.equal(streamOf(off.f).includes('\x1b[?1049'), false, `缺省那一档写进了 alt 序列：${JSON.stringify(off.f.written)}`)
  // 两档之间**只差那两笔**——这一条就是"渲染层一行不动"在字节上的意思。
  assert.equal(
    streamOf(on.f).replaceAll(ALT_ON, '').replaceAll(ALT_OFF, ''),
    streamOf(off.f),
    '整屏那一档除了那两个 escape 之外多写（或少写）了字节',
  )
  assert.ok(streamOf(on.f).startsWith(ALT_ON), '进 alt screen 那一笔该在第一次画的最前面')
  assert.ok(streamOf(on.f).endsWith(ALT_OFF), '出来那一笔该是收尾的最后一笔')
  assert.equal(streamOf(on.f).split(ALT_ON).length - 1, 1, `ALT_ON 写了不止一次：${JSON.stringify(on.f.written)}`)
  assert.equal(streamOf(on.f).split(ALT_OFF).length - 1, 1, 'ALT_OFF 写了不止一次')
  assert.equal(on.t.alt, false, 'close() 之后该记成"已经出来了"')

  // **崩那一档**：`finally` 与 `exit` 那一钩都会调 `close()`——第二次一个字节都不许再写。
  const after = streamOf(on.f).length
  on.t.close()
  assert.equal(streamOf(on.f).length, after, 'close() 第二次还写了字节（崩那一档就是两边都调）')

  // **宽度变过那一档**：重排量不到，面板那一笔省掉——**出来那一笔一个字节都不许省**。
  const g = fakeOut({ columns: 80 })
  const t3 = openTerm({ out: g, term: 'xterm-256color', full: true })
  t3.draw([], () => ['a'])
  g.written.length = 0
  g.columns = 40
  t3.close()
  assert.equal(g.written.length, 1, '只剩的那一笔也该是一笔（U3）')
  assert.equal(g.written[0], ALT_OFF, `宽度变过那一档该只剩 ALT_OFF：${JSON.stringify(g.written)}`)

  // **没画过那一档**（`--once` 那种：一次都不画）与**管道那一档**：连 alt screen 都不进。
  const h = fakeOut({ columns: 80 })
  const t4 = openTerm({ out: h, term: 'xterm-256color', full: true })
  t4.close()
  assert.deepEqual([...h.written], [], '没画过就不该写字节（进都没进，不用出来）')
  const p = fakeOut({ columns: 80, isTTY: false })
  const t5 = openTerm({ out: p, term: 'xterm-256color', full: true })
  t5.draw(['一条永久行'], () => ['面板这一行'])
  t5.close()
  assert.equal(p.written.length, 1, '管道那一档那一帧也是一笔')
  assert.equal(p.written[0], '一条永久行\n', '`--full` 也改不了地板：管道那一档一个字节的 ANSI 都不写')
  console.log(
    `⑨ 读数：不整屏 ${off.f.written.length} 笔 · 整屏 ${on.f.written.length} 笔（一帧一笔，只差 ALT_ON/ALT_OFF）· ` +
      `崩那条路第二次 close() 0 笔 · 宽度变过那一档只剩 1 笔 ALT_OFF · 没画过 0 笔 · 管道 0 个转义字节`,
  )
})

// ── ⑪ 行级 diff（U8）：屏幕模拟器 —— 字节流应用到 string[] 模型，可见内容与 panelOf 全等 ──
/**
 * 屏幕模拟器（⑪ 的那把尺）：把字节流应用到 `rows × columns` 的屏幕模型上，还回**此刻看得见的
 * 那几行**。只认这一份会写的几条（`\r` · `\n`（ONLCR：下一行行首）· 上移/下移/左退 · `2K` 清行 ·
 * 删行）；认不得的 CSI（alt screen 那对）整段跳过。光标从**屏幕底行**起——真进程是在 shell
 * 提示符后面起画的（`fugue tui` 敲下去那一行），不是从屏幕顶。
 */
function screenOf(stream: string, rows: number, columns: number): string[] {
  const screen: string[] = Array.from({ length: rows }, () => '')
  let row = rows - 1
  let col = 0
  const isParam = (ch: string): boolean => (ch >= '0' && ch <= '9') || ch === '?'
  for (let i = 0; i < stream.length; ) {
    const ch = stream[i] as string
    if (ch === '\r') {
      col = 0
      i += 1
    } else if (ch === '\n') {
      row += 1
      col = 0
      if (row === rows) {
        screen.shift()
        screen.push('')
        row = rows - 1
      }
      i += 1
    } else if (ch === '\x1b') {
      // CSI（`\x1b[` + 参数 + 结尾字母）手动扫：参数到第一个不在 [0-9?] 的字符为止。
      if (stream[i + 1] !== '[') {
        i += 1
        continue
      }
      let j = i + 2
      while (j < stream.length && isParam(stream[j] as string)) j += 1
      const param = stream.slice(i + 2, j)
      const n = param === '' || param.includes('?') ? 1 : parseInt(param, 10) || 1
      const c = stream[j] as string
      if (c === 'A') row = Math.max(0, row - n)
      else if (c === 'B') row = Math.min(rows - 1, row + n)
      else if (c === 'D') col = Math.max(0, col - n)
      else if (c === 'K') screen[row] = ''
      else if (c === 'M') {
        screen.splice(row, n)
        for (let k = 0; k < n; k += 1) screen.push('')
      }
      i = j + 1
    } else {
      const line = screen[row] as string
      screen[row] = line.padEnd(col, ' ') + ch
      col += 1
      i += 1
    }
  }
  return screen
}

test('⑪ 行级 diff（U8）：可见与 panelOf 全等 · 帧未变零 CLEAR_LINE · 输入行变少擦残影 · caret 列非 0 不错位', () => {
  const COLS = 40
  const ROWS = 24
  const H = 8
  const f = fakeOut({ columns: COLS, rows: ROWS })
  const t = openTerm({ out: f, term: 'xterm-256color', heightOf: () => H })
  /** 一块面板：第 3 行（i=2）是要变的那个位，其余恒定。 */
  const panel = (mark: string): string[] =>
    Array.from({ length: H }, (_, i) => (i === 2 ? mark : `p${i}`).padEnd(COLS, '.'))
  const input2 = { rows: ['» /log', '  --tail'], caret: { row: 1, col: 4 } }
  /** 全流应用之后的屏幕，底部那 10 行（8 面板 + 2 输入）trimEnd——那就是人看得见的那一块。 */
  const bottom = (): string[] => screenOf(streamOf(f), ROWS, COLS).slice(-10).map((r) => r.trimEnd())
  // 字节断言用**增量**（这一帧写了什么），可见断言用**全流**（屏幕此刻长什么样）——模拟器只认全流。
  let mark = streamOf(f).length
  const frame = (): string => {
    const all = streamOf(f)
    const one = all.slice(mark)
    mark = all.length
    return one
  }

  // 第一帧（首帧全量，golden 在 ⑧）。
  t.draw([], () => ({ rows: panel('AAA'), input: input2 }))
  frame()
  assert.deepEqual(bottom(), [...panel('AAA'), '» /log', '  --tail'], '首帧之后的可见内容')

  // 第二帧：面板第 3 行变了 → 恰那一行重写、其余掠过；可见仍与 panelOf 全等。
  t.draw([], () => ({ rows: panel('BBB'), input: input2 }))
  const second = frame()
  assert.deepEqual(bottom(), [...panel('BBB'), '» /log', '  --tail'], '变了一行的那一帧，可见内容')
  assert.equal(second, f.written.at(-1), '一帧一笔（U3）：这一帧的增量恰是最后一笔')
  assert.ok(second.startsWith(upOf(9)) === true, `重画该上移 9 行（8 面板 + 2 输入 − 1）起头：${JSON.stringify(second)}`)
  assert.equal(second.split(CLEAR_LINE).length - 1, 1, `变了的那一行才重写（恰 1 个 CLEAR_LINE），实得 ${second.split(CLEAR_LINE).length - 1}`)
  assert.equal(second.split('\x1b[1B').length - 1, 8, `其余 9 行掠过（8 个下移——最后一行输入行只回车不下移），实得 ${second.split('\x1b[1B').length - 1}`)
  assert.equal(second.includes('p0'), false, '掠过的行不重写：面板第一行的内容一个字节都没写出去')
  assert.ok(second.includes(leftOf(widthOf('  --tail') - 4)), '光标仍退回 caret 列（末尾恒回 caret）')

  // 第三帧：一个字节都没变 → 那帧里 CLEAR_LINE 数是零，屏幕也不动。
  t.draw([], () => ({ rows: panel('BBB'), input: input2 }))
  const third = frame()
  assert.equal(third.split(CLEAR_LINE).length - 1, 0, `帧未变还清行了：${JSON.stringify(third)}`)
  assert.deepEqual(bottom(), [...panel('BBB'), '» /log', '  --tail'], '帧未变，可见内容不动')

  // 第四帧：光标停在 caret 列 4（非 0）之后再画，带一条永久行——不错位（每行 \\r 起头的功劳）。
  t.draw(['一条永久行'], () => ({ rows: panel('CCC'), input: input2 }))
  frame()
  assert.deepEqual(bottom(), [...panel('CCC'), '» /log', '  --tail'], 'caret 列非 0 的下一帧不错位')
  assert.ok(screenOf(streamOf(f), ROWS, COLS).some((r) => r.includes('一条永久行')), '永久行进历史')

  // 第五帧：输入行 2 行 → 1 行 → 全量重写 + 多出来的那一行擦成空行（不留残影）。区域画在上一帧
  // 面板顶起的位置（不必然贴屏幕底），所以从「p0 那一行」起数 9 行。
  t.draw([], () => ({ rows: panel('CCC'), input: { rows: ['» /log'], caret: { row: 0, col: 6 } } }))
  frame()
  const lines = screenOf(streamOf(f), ROWS, COLS)
  const top = lines.findIndex((r) => r.startsWith('p0'))
  assert.ok(top >= 0, '面板第一行找得到（区域还在屏幕上）')
  assert.deepEqual(
    lines.slice(top, top + 9).map((r) => r.trimEnd()),
    [...panel('CCC'), '» /log'],
    '输入行变少的那一帧，可见内容（9 行 = 8 面板 + 1 输入）',
  )
  assert.equal((lines[top + 9] as string).trim(), '', '上一帧多出来的那行输入行该被擦成空行')

  // 收尾：面板那一块删得掉（up + delete 走得通），屏幕上不再有面板行。
  t.close()
  assert.equal(frame(), f.written.at(-1), 'close 也是一笔（U3）')
  const after = screenOf(streamOf(f), ROWS, COLS).map((r) => r.trimEnd())
  assert.equal(after.some((r) => r.includes('p0') || r.includes('» /log')), false, '面板与输入行该从屏幕上收走')
  assert.ok(after.some((r) => r.includes('一条永久行')), '永久行留在历史里')
  console.log(
    `⑪ 读数：变 1 行的那帧 ${second.length} 字节（1 个 CLEAR_LINE · 8 个掠过）· 帧未变那帧 ` +
      `${third.length} 字节（0 个 CLEAR_LINE）· 输入行 2→1 擦掉残影 · close 收走面板`,
  )
})
