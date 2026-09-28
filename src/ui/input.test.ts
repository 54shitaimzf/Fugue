// TUI 的第二版第一格：**输入行**（PLAN § 5.19 第二版「二 · 按键」·「三 · 状态」·「六 · 提交的四
// 种去向」）。跑法：cd ~/fugue && node --test src/ui/input.test.ts
//
// 这一份量的七样：
//
//   ① **逐列对账**：列宽按**簇**算——组合符号零宽 · ZWJ 连起来的一家算一个字 · 一对区域指示符
//      算一个；负对照是"按 code unit 数"那一版（它在 `e` + U+0301 上就错一格）。
//   ② **折行与光标**：提示符占掉前两列之后折到第几行第几列，汉字逐列对；光标列不许等于这一行宽。
//   ③ **原文一个字节不丢**：折叠过的粘贴（5 行 · 241 列）`submitOf` 交出来的与粘进去的逐字节相同。
//   ④ **撤销栈**：退得回来 · 重做回得去 · 有界（`UNDO_DEPTH`）；栈空时什么都不做。
//   ⑤ **kill 环与 `Esc`**：`Ctrl-W`/`Ctrl-U` 砍掉的 `Ctrl-Y` 粘得回来；`Esc` 清掉的那一行退得回来。
//   ⑥ **历史与反查**：上下翻 · `Alt-R` 拿行里那几个字查 · 再按一下找更早的一条。
//   ⑦ **纯 · 视图状态 · 没有裸控制字符**：同一份输入调两次逐字段相同；长到第四行按光标滚；
//      原文里的 `\x1b` 印成 `^[`（显示改了，原文一个字节不改）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { widthOf } from './frame.ts'
import {
  EMPTY_DRAFT,
  INPUT_ROWS,
  UNDO_DEPTH,
  applyIntent,
  cancelTargetOf,
  caretColOf,
  displayOf,
  emptyEditor,
  inputFrameOf,
  modeOf,
  rememberSubmit,
  submitOf,
} from './input.ts'
import type { Editor } from './input.ts'

/** 手里那一行（从空的那一份起，历史为空）。 */
const typed = (text: string): Editor => ({
  ...emptyEditor(),
  draft: { ...EMPTY_DRAFT, text, caret: text.length },
})

/** 换一行字，历史不动（`Editor` 是不可变的：这里给的是新的一份）。 */
const withText = (e: Editor, text: string): Editor => ({ ...e, draft: { ...EMPTY_DRAFT, text, caret: text.length } })

/** 码位写法（把控制字符与组合符号印成人看得懂的样子）。 */
const hex = (s: string): string => [...s].map((c) => (c.codePointAt(0) as number).toString(16)).join('+')

test('① 逐列对账：组合符号零宽 · ZWJ 一个字 · 一对区域指示符一个字', () => {
  const cases: readonly (readonly [string, number, string])[] = [
    ['中文abc', 7, '汉字两列 + 三个拉丁字母'],
    ['e\u0301', 1, 'e 与它身上的组合重音：一列'],
    ['\u0301', 0, '孤零零一个组合符号：零列'],
    ['\u{1F468}\u200d\u{1F469}\u200d\u{1F467}', 2, 'ZWJ 连起来的一家：一个字'],
    ['\u{1F1E8}\u{1F1F3}', 2, '一对区域指示符：一面旗'],
    ['\u{1F44D}\u{1F3FD}', 2, 'emoji + 肤色修饰：一个字'],
  ]
  for (const [s, w, why] of cases) {
    assert.equal(widthOf(s), w, `${why}：0x${hex(s)} 该 ${w} 列，拿到 ${widthOf(s)}`)
  }
  // 负对照：按 code unit 数那一版（这一份要证伪的就是它）
  const units = (s: string): number => s.length
  assert.equal(units('e\u0301'), 2, '负对照在位：按 code unit 数是 2（所以上面那一条能红）')
  assert.notEqual(units('中文abc'), 7, '负对照在位：按 code unit 数把汉字算成一列')
  assert.equal(applyIntent(typed('e\u0301'), { t: 'left' }).draft.caret, 0, '左移一步跨过整个簇（不是停在半个字上）')
  assert.equal(applyIntent(typed('中文'), { t: 'left' }).draft.caret, 1, '汉字各是一个簇：一步退一个 code unit（不是退到行首）')
  assert.equal(applyIntent(typed('中文abc'), { t: 'left' }).draft.caret, 4, '五个 code unit 的一行：一步退到第 4 个之前')
  console.log(
    `① 读数：${cases.map(([s, w]) => `0x${hex(s)}→${w} 列`).join(' · ')}；按 code unit 数那一版在 0x65+0x301 上是 2`,
  )
})

test('② 折行与光标：提示符占前两列，汉字按两列折', () => {
  const f = inputFrameOf({ e: typed('中文abc'), prompt: '> ', width: 8 })
  assert.deepEqual([...f.rows], ['> 中文ab', '  c'], '八列宽、提示两列：六个显示列装两个汉字加两个字母')
  assert.deepEqual(f.caret, { row: 1, col: 3 }, '光标在最后的 c 之后：第二行第三列（这一行没占满，就停在内容末尾）')
  assert.deepEqual(f.hidden, { above: 0, below: 0 }, '三行装得下，没藏东西')
  for (const one of f.rows) assert.ok(widthOf(one) <= 8, `每一行不超过 8 列：${widthOf(one)} 列（${one}）`)
  assert.deepEqual(f, inputFrameOf({ e: typed('中文abc'), prompt: '> ', width: 8 }), '同一份输入量两次逐字段相同')
  // 负对照：按 code unit 折（这一份要证伪的就是它）
  const byUnits = (s: string, w: number): readonly string[] => (s.length <= w ? [s] : [s.slice(0, w), s.slice(w)])
  assert.notDeepEqual([...byUnits('中文abc', 6)], ['> 中文ab', '  c'], '负对照在位：按 code unit 折出来的不是这一副样子')
  // 窄到放不下提示符：提示符让位，一行都不少
  const narrow = inputFrameOf({ e: typed('中文'), prompt: '> ', width: 2 })
  assert.deepEqual([...narrow.rows], ['中', '文', ''], '两列宽时提示符让位（装不下就不印它，一个字两列、一行一个）')
  console.log(`② 读数：8 列 / 提示 "> " → ${f.rows.map((r) => `「${r}」`).join(' ')}，光标 ${f.caret.row} 行 ${f.caret.col} 列`)
})

test('③ 折叠过的粘贴：显示是一块牌子，原文一个字节不丢', () => {
  const paste = Array.from({ length: 5 }, (_, i) => `第 ${i + 1} 行：这是一段粘进来的东西`).join('\n')
  const e = applyIntent(emptyEditor(), { t: 'insert', text: paste })
  assert.equal(e.draft.text, paste, 'draft.text 就是原文')
  assert.equal(submitOf(e), paste, '交出去的与粘进来的逐字节相同')
  assert.equal(e.draft.folded.length, 1, '五行算大段粘贴：折一块')
  const shown = displayOf(e.draft)
  assert.ok(shown.includes('[粘贴 5 行'), `显示里该有一块牌子：${shown}`)
  assert.ok(!shown.includes('\n'), '显示里没有真换行（这块地方只有一行）')
  assert.equal(caretColOf(e.draft), widthOf(shown), '光标在末尾：列宽按显示算')
  assert.equal(applyIntent({ ...e, draft: { ...e.draft, caret: 0 } }, { t: 'right' }).draft.caret, paste.length, '右移一步跨过整块')
  // 展开（`Ctrl-O`）：原文逐字露出来，但换行仍是记号
  const open = applyIntent(e, { t: 'toggleFold' })
  const flat = displayOf(open.draft, { unfolded: open.unfolded })
  assert.ok(flat.includes('第 5 行'), '展开了要看得见原文')
  assert.ok(!flat.includes('\n'), '展开也不许在屏幕上真换行')
  assert.equal(submitOf(open), paste, '展开过再交出去还是原文')
  // 阈值两条边
  const four = applyIntent(emptyEditor(), { t: 'insert', text: 'a\nb\nc\nd' })
  assert.equal(four.draft.folded.length, 0, `四行不折（阈值 ${4} 行）`)
  const five = applyIntent(emptyEditor(), { t: 'insert', text: 'a\nb\nc\nd\ne' })
  assert.equal(five.draft.folded.length, 1, '五行折')
  const keep = 'x'.repeat(240)
  assert.equal(applyIntent(emptyEditor(), { t: 'insert', text: keep }).draft.folded.length, 0, '240 列不折')
  const wide = 'x'.repeat(241)
  const w = applyIntent(emptyEditor(), { t: 'insert', text: wide })
  assert.equal(w.draft.folded.length, 1, '241 列折')
  assert.equal(submitOf(w), wide, '折起来的那一份交出去还是原文')
  console.log(`③ 读数：5 行 / ${[...paste].length} 字 → 「${shown}」；240 列不折 · 241 列折；交出去 ${submitOf(e) === paste ? '逐字节相同' : '不一致'}`)
})

test('④ 撤销栈：退得回来 · 重做回得去 · 有界', () => {
  let e = applyIntent(typed('abc'), { t: 'backspace' })
  assert.equal(e.draft.text, 'ab', '退格删掉一个簇')
  e = applyIntent(e, { t: 'undo' })
  assert.equal(e.draft.text, 'abc', '退一步回来')
  e = applyIntent(e, { t: 'redo' })
  assert.equal(e.draft.text, 'ab', '重做回去')
  let many = emptyEditor()
  for (let i = 0; i < UNDO_DEPTH + 20; i += 1) many = applyIntent(many, { t: 'insert', text: 'x' })
  assert.equal(many.draft.text.length, UNDO_DEPTH + 20, '打了 84 个 x')
  assert.equal(many.draft.undo.length, UNDO_DEPTH, `撤销栈有界：${UNDO_DEPTH} 层`)
  let back = many
  for (let i = 0; i < UNDO_DEPTH; i += 1) back = applyIntent(back, { t: 'undo' })
  assert.equal(back.draft.text.length, 20, '退到底：只剩最早那 20 个（栈外的丢掉）')
  assert.deepEqual(applyIntent(emptyEditor(), { t: 'undo' }), emptyEditor(), '栈空时撤销什么都不做')
  assert.deepEqual(applyIntent(emptyEditor(), { t: 'redo' }), emptyEditor(), '没重做可做时也什么都不做')
  console.log(`④ 读数：84 个 x → 撤销 ${UNDO_DEPTH} 层后剩 ${back.draft.text.length} 个 · 重做回得去`)
})

test('⑤ kill 环与 Esc：砍掉的粘得回来，清空的退得回来', () => {
  let e = applyIntent(typed('foo bar'), { t: 'killWord' })
  assert.equal(e.draft.text, 'foo ', '整词删：砍掉 bar')
  e = applyIntent(e, { t: 'yank' })
  assert.equal(e.draft.text, 'foo bar', '粘回来')
  let c = applyIntent(applyIntent(typed('整行都要清掉'), { t: 'home' }), { t: 'killToStart' })
  assert.equal(c.draft.text, '', '光标在行首时 Ctrl-U 清整行（表里那一格写的是"清行"）')
  assert.equal(applyIntent(c, { t: 'yank' }).draft.text, '整行都要清掉', '粘回来是原文')
  let d = typed('草稿')
  assert.equal(cancelTargetOf(d), 'input', '行里有字：Esc 要清空')
  d = applyIntent(d, { t: 'cancel' })
  assert.equal(d.draft.text, '', 'Esc 清空输入行')
  assert.equal(applyIntent(d, { t: 'undo' }).draft.text, '草稿', '清掉的那一行在撤销栈上（"恢复刚清掉的草稿"）')
  assert.equal(cancelTargetOf(emptyEditor()), null, '空行上 Esc 什么都不做（让上头的链接着走）')
  assert.deepEqual(applyIntent(emptyEditor(), { t: 'cancel' }), emptyEditor(), '空行上按 Esc 不改任何字段')
  console.log(`⑤ 读数：kill 环最近一格 ${JSON.stringify(c.draft.killed[c.draft.killed.length - 1])} · Esc 清空后可撤销回来`)
})

test('⑥ 历史与反查：上下翻 · 拿行里那几个字查', () => {
  let e = emptyEditor()
  for (const line of ['round go', 'config set a b', 'round status']) e = rememberSubmit(e, line)
  assert.deepEqual([...e.history], ['round go', 'config set a b', 'round status'], '历史按提交次序（最新的在后）')
  let up = withText(e, '写到一半')
  up = applyIntent(up, { t: 'historyOlder' })
  assert.equal(up.draft.text, 'round status', '↑ 先给最近一条')
  up = applyIntent(up, { t: 'historyOlder' })
  assert.equal(up.draft.text, 'config set a b', '再 ↑ 往早里走')
  up = applyIntent(applyIntent(up, { t: 'historyNewer' }), { t: 'historyNewer' })
  assert.equal(up.draft.text, '写到一半', '↓ 翻回来是手里原来那一行（不是历史里的）')
  assert.equal(applyIntent(emptyEditor(), { t: 'historyOlder' }).draft.text, '', '没历史时 ↑ 什么都不做')
  let s = withText(e, 'round')
  s = applyIntent(s, { t: 'search' })
  assert.equal(s.draft.text, 'round status', 'Alt-R 先给最近一条含这几个字的')
  s = applyIntent(s, { t: 'search' })
  assert.equal(s.draft.text, 'round go', '再按一下找更早的（查询词定住，不拿翻出来的那一条去找）')
  s = applyIntent(s, { t: 'search' })
  assert.equal(s.draft.text, 'round go', '没有更早的了：停下不动')
  s = applyIntent(s, { t: 'cancel' })
  assert.equal(s.search, null, 'Esc 先退反查')
  assert.equal(s.draft.text, 'round go', '退反查之后行里还是找到的那一条')
  assert.deepEqual(applyIntent(emptyEditor(), { t: 'search' }), emptyEditor(), '没历史时反查什么都不做')
  console.log(`⑥ 读数：历史 ${e.history.length} 条 · 反查 "round" 命中 round status → round go · 退反查行里留着 round go`)
})

test('⑦ 纯 · 视图状态 · 显示里没有裸控制字符', () => {
  const e = applyIntent(emptyEditor(), { t: 'insert', text: 'say 你好' })
  assert.deepEqual(applyIntent(e, { t: 'left' }), applyIntent(e, { t: 'left' }), '同一份输入调两次逐字段相同')
  assert.equal(e.draft.text, 'say 你好', '进来那一份没被改')
  assert.equal(e.draft.caret, 'say 你好'.length, '光标也没被改')
  assert.equal(modeOf(e.draft), 'Say', '行首不是 / 就是话（落进 say）')
  assert.equal(modeOf({ ...e.draft, text: '/round go' }), 'Command', '行首是 / 就是命令')
  // 三行窗口：长到第四行按光标滚，滚上去那一格说出"上面还有"
  const long = typed('中文中文中文中文')
  const f = inputFrameOf({ e: long, prompt: '> ', width: 6 })
  assert.equal(f.rows.length, INPUT_ROWS, `最多 ${INPUT_ROWS} 行`)
  assert.deepEqual(f.hidden, { above: 2, below: 0 }, '滚上去两行')
  assert.ok(f.rows[0]?.startsWith('…') === true, `滚上去时提示符那一格换成 …：${f.rows[0]}`)
  assert.deepEqual(f.caret, { row: 2, col: 2 }, '光标在补出来的那一行行首（列 = 提示符宽度）')
  for (const one of f.rows) assert.ok(widthOf(one) <= 6, `每一行不超过 6 列：${widthOf(one)}`)
  // 原文里的转义字符：显示改了，原文不改
  const sneaky = typed('a\u001b[31mb')
  const shown = displayOf(sneaky.draft)
  assert.ok(!shown.includes('\u001b'), '裸 ESC 不许出现在显示里')
  assert.ok(shown.includes('^['), `ESC 印成 ^[：${hex(shown)}`)
  assert.equal(submitOf(sneaky), 'a\u001b[31mb', '原文一个字节不丢')
  assert.equal(caretColOf(sneaky.draft), widthOf(shown), '光标列按显示算（^[ 占两列）')
  console.log(`⑦ 读数：${INPUT_ROWS} 行窗口 · 上面藏 ${f.hidden.above} 行 · 0x1b 印成 "${shown}"`)
})
