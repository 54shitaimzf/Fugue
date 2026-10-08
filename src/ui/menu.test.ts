// TUI 的第二版第四格：**菜单与面板**（PLAN § 5.19 第二版「二 · 按键」· 架构 § 9.8）。跑法：
// cd ~/fugue && node --test src/ui/menu.test.ts
//
// 这一份量的六样：
//
//   ① **候选与命令面那一张表逐字相同**：`/` 菜单列出的命令集合与 `cli/flags.ts` 的 `FLAGS_OF` 的键
//      集合逐字相同、次序也相同（`T4` 那一行就是这条）；**负对照**：另写一份手抄的目录（同类里那种
//      漂了 5 条的两张表）与表当场对不上。
//   ② **两段候选都从同一张表推**：先按命令名**前缀**筛；名字一个都匹配不上时看是不是已经选定了某一条
//      命令，是就换成**那一条的开关**（"这个命令认哪些开关"在界面上也只有一处来源）。
//   ③ **`Tab` 与 `Enter`**：补到候选的最长公共前缀 · 只剩一条时补成整条（命令后面补一个空格）·
//      认下一条只**换掉这一行字**（起不起命令是 `ui/run.ts` 那一格的事）。
//   ④ **路径那一档**（`@`）：走一遍工作区（有界 · 读不到就跳过 · 两次走出来的次序逐字相同）·
//      带空格的那条路接进去要带引号。
//   ⑤ **面板那一帧**：候选排在内容下面（挨着账尾）· 选中的那一条带记号 · 装不下时说还剩几条 ·
//      一条都没有时说"没有匹配的"；同一份输入两次折出来的逐字节相同（纯函数）。
//   ⑥ **接上终端那一块**（`ui/follow.ts` 的 `panel`）：面板那几行 + 输入行那几行；不给视图时与
//      从前逐字节相同（地板：这一格不许让老的那一档变样）。
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { FLAGS_OF } from '../cli/flags.ts'
import { statusOf } from '../probe/status.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { frameOf } from './frame.ts'
import { openSession } from './follow.ts'
import {
  PATHS_DEPTH,
  acceptOf,
  candidatesOf,
  clampSel,
  commonPrefix,
  completeOf,
  moveSel,
  pathRowsOf,
  pathsOf,
  queryOf,
  rowsTextOf,
  specsOf,
} from './menu.ts'
import { widthOf } from './glyph.ts'
import { K } from './term.ts'

/** 那一刻的账（空账：这一份量的是候选与面板，不是读数）。 */
const snap = statusOf([])
const specs = specsOf(FLAGS_OF)
const cmdRows = (line: string): readonly string[] =>
  rowsTextOf(candidatesOf({ specs, line, source: 'cmd' }))
const names = (line: string): readonly string[] => candidatesOf({ specs, line, source: 'cmd' }).map((r) => r.name)

// ── ① 候选与 `FLAGS_OF` 逐字相同 ─────────────────────────────────────────────
test('① 菜单里的命令集合与 `FLAGS_OF` 的键集合逐字相同（负对照：手抄一份目录）', () => {
  const keys = Object.keys(FLAGS_OF)
  const rows = candidatesOf({ specs, line: '', source: 'cmd' })
  assert.deepEqual(
    rows.map((r) => r.name),
    keys,
    '菜单里列出的命令与 FLAGS_OF 的键**逐字相同、次序也相同**',
  )
  // 每一行的说明也是那一格自己的（有 note 用 note，没有就说它有几个开关）——不许另写一份。
  for (const r of rows) {
    const table = FLAGS_OF[r.name]
    assert.ok(table !== undefined, `${r.name} 在 FLAGS_OF 里没有`)
    assert.equal(r.note, table.note ?? `${table.flags.length} 个开关`, `${r.name} 的说明不是从表里来的`)
  }
  // 面板上真的看得出来：每一行都以那个命令名开头（`rowsTextOf` 那一列对得齐）。
  const text = rowsTextOf(rows)
  for (let i = 0; i < keys.length; i += 1) {
    assert.ok((text[i] as string).startsWith(keys[i] as string), `第 ${i + 1} 行不是 ${keys[i]}`)
  }
  // 对齐量的是显示宽度（U13）：名字里带中文的那条与纯英文的那条，说明那一列**起在同一列上**——
  // 按 code unit 数补空格的话，两字的名字比六字母的短 4 列（中文一字两列），那一列就斜了。
  const mixed = rowsTextOf([
    { name: '中文命令', note: '说明一', kind: 'cmd' },
    { name: 'abcdef', note: '说明二', kind: 'cmd' },
  ])
  const colOf = (s: string, note: string): number => widthOf(s.slice(0, s.indexOf(note)))
  assert.equal(
    colOf(mixed[0] as string, '说明一'),
    colOf(mixed[1] as string, '说明二'),
    `说明该起在同一显示列（量的是宽度，不是字符数）：${JSON.stringify(mixed)}`,
  )
  // **负对照**：手抄一份"看着像那么回事"的目录（上一版那种写法）与表当场对不上——这把尺抓得住。
  const handWritten = ['log', 'status', 'watch', 'tui', 'doctor']
  assert.notDeepEqual(handWritten, keys, '手抄那一份与表对不上')
  const missing = keys.filter((k) => !handWritten.includes(k))
  assert.ok(missing.length > 20, `手抄那一份漏了 ${missing.length} 条`)
  console.log(
    `① 读数：FLAGS_OF ${keys.length} 条 → 菜单 ${rows.length} 行（逐字相同、次序相同）· ` +
      `手抄那一份漂了 ${missing.length} 条 · 每行的说明都取自表里那一格`,
  )
})

// ── ② 两段候选：命令名 → 那一条的开关 ─────────────────────────────────────────
test('② 两段都从同一张表推：名字前缀筛 · 一个都匹配不上时换成那一条的开关', () => {
  // 第一段：前缀（不是包含——名字是拿来补全的）。
  assert.deepEqual(names('/ro'), ['round new', 'round plan', 'round go', 'round run', 'round work'])
  assert.deepEqual(names('/round g'), ['round go'], '`round g` 还是命令那一段（不是开关那一段）')
  assert.deepEqual(names('/zzz'), [], '一条都匹配不上，而且不是任何一条命令的开头')
  // 第二段：已经选定了某一条命令（`名字 + 空格`）→ 那一条的开关。
  assert.deepEqual(names('/round go '), [
    '--root', '--agent', '--json', '--help', '--materialize', '--no-clock',
  ])
  assert.deepEqual(names('/round go --r'), ['--root'], '手里那个词跟着筛')
  // `--header` 也在这一格里（0.4.3 第一幕 ②）：开关那一段从 FLAGS_OF 推，表长了它就跟着长。
  assert.deepEqual(names('/log '), ['--root', '--agent', '--json', '--help', '--header'])
  // 最长的那一条命令赢（`round go` 赢过 `round`）。
  assert.deepEqual(names('/round '), ['round new', 'round plan', 'round go', 'round run', 'round work'])
  // 查询词是从行里推的（三个来源各一条规则）。
  assert.equal(queryOf('/lo', 'cmd'), 'lo')
  assert.equal(queryOf('随便一句话', 'cmd'), '', '不是命令行就一个都不筛（`Ctrl-P` 那一档印全量）')
  assert.equal(queryOf('看 @src/ui/', 'path'), 'src/ui/')
  assert.equal(queryOf('看一个路径', 'path'), null, '一个 `@` 都没有 → 这个来源没有查询词（面板该关了）')
  assert.equal(queryOf('Ctrl', 'keys'), 'Ctrl')
  // 选中的下标：夹回范围里 · `↑↓` 是**环**。
  assert.equal(clampSel(5, 9), 4)
  assert.equal(clampSel(0, 3), 0)
  assert.equal(moveSel(5, 4, 1), 0, '到底了再按一下回到头')
  assert.equal(moveSel(5, 0, -1), 4, '到头了再按一下回到底')
  console.log(
    `② 读数：/ro → ${names('/ro').length} 条命令 · /round g → 1 条 · /round go --r → 1 个开关 · ` +
      `/round go 那一段共 ${names('/round go ').length} 个开关 · 三个来源的查询词各一条规则 · ` +
      `选中下标夹回范围、↑↓ 成环`,
  )
})

// ── ③ `Tab` 补全与 `Enter` 认下 ───────────────────────────────────────────────
test('③ `Tab` 补到最长公共前缀 · 只剩一条补成整条 · 认下一条只换掉这一行字', () => {
  const rows = (line: string) => candidatesOf({ specs, line, source: 'cmd' })
  const complete = (line: string): string | null => completeOf({ rows: rows(line), line, source: 'cmd' })
  assert.equal(commonPrefix(['round new', 'round plan', 'round go']), 'round ')
  assert.equal(complete('/ro'), '/round ', '补到公共前缀（并上那个空格）')
  assert.equal(complete('/round g'), '/round go')
  assert.equal(complete('/round go'), '/round go ', '只剩一条且已补全 → 补的是后面那个空格')
  assert.equal(complete('/log '), '/log --', '开关那一档同样补公共前缀')
  assert.equal(complete('/zzz'), null, '一条候选都没有 → 什么都不补（不许把这一行改坏）')
  assert.equal(completeOf({ rows: rows('/x'), line: 'x', source: 'keys' }), null, '键表那一档接不进这一行')
  // 认下一条：只换掉这一行字（`acceptOf` 还回一行字，起不起命令不归它）。
  const pick = (line: string, name: string): string | null => {
    const row = rows(line).find((r) => r.name === name)
    assert.ok(row !== undefined, `${name} 不在候选里`)
    return acceptOf(line, 'cmd', row)
  }
  assert.equal(pick('/ro', 'round go'), '/round go ')
  assert.equal(pick('/round go --r', '--root'), '/round go --root ', '开关那一段只换手里那个词')
  const keyRow = { name: 'Ctrl-C 打断', note: '', kind: 'key' as const }
  assert.equal(acceptOf('', 'keys', keyRow), null, '键表那一档只是读，接不进去')
  console.log(
    `③ 读数：/ro → /round （公共前缀）· /round g → /round go · /round go → /round go （补空格）· ` +
      `开关那一档 → /round go --root · 键表那一档不接（null）`,
  )
})

// ── ④ 路径那一档（`@`） ─────────────────────────────────────────────────────
test('④ 路径那一档：有界地走一遍 · 读不到就跳过 · 次序稳定 · 带空格要引号', () => {
  const root = tmpDir('fugue-menu-')
  mkdirSync(join(root, 'src', 'ui'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(root, 'd1', 'd2', 'd3', 'd4'), { recursive: true })
  writeFileSync(join(root, 'a.txt'), 'a\n')
  writeFileSync(join(root, '.hidden'), 'h\n')
  writeFileSync(join(root, 'src', 'ui', 'x.ts'), 'x\n')
  writeFileSync(join(root, 'src', 'ui', '有两个 空格.ts'), 'y\n')
  writeFileSync(join(root, 'node_modules', 'x', 'z.js'), 'z\n')
  writeFileSync(join(root, 'd1', 'd2', 'd3', 'd4', 'f.txt'), 'f\n')
  const all = pathsOf(root)
  assert.ok(all.includes('a.txt'), all.join(' '))
  assert.ok(all.includes('src/ui/x.ts'), all.join(' '))
  assert.ok(all.includes('d1/d2/d3/'), '深度 3 那一层还在')
  assert.ok(!all.some((p) => p.includes('node_modules')), '构建产物不走进去')
  assert.ok(!all.some((p) => p.startsWith('.')), '隐藏的那些不走进去')
  assert.ok(!all.some((p) => p.includes('d4')), `深度 ${PATHS_DEPTH} 之外的不走进去：${all.join(' ')}`)
  assert.deepEqual(pathsOf(root), all, '同一棵树两次走出来的次序逐字相同')
  assert.equal(pathsOf(root, { limit: 3 }).length, 3, '条数有界')
  assert.deepEqual(pathsOf(join(root, '没有这个目录')), [], '读不到就跳过（不抛）')
  // 筛与接：路径是"名字里含这几个字"，接进去要带引号。
  const rows = candidatesOf({ specs, paths: all, line: ' 看 @src/ui/x', source: 'path' })
  assert.deepEqual(rows.map((r) => r.name), ['src/ui/x.ts'])
  const spaced = all.find((p) => p.includes('空格')) as string
  const picked = acceptOf('看 @有两个', 'path', { name: spaced, note: '', kind: 'path' })
  assert.equal(picked, `看 @"${spaced}"`, '带空格的那条路接进去要带引号（`ui/run.ts` 的切词认引号）')
  assert.equal(pathRowsOf([], 'x').length, 0)
  console.log(
    `④ 读数：走一遍 ${all.length} 条（深度 ≤ ${PATHS_DEPTH} · 跳过 node_modules 与隐藏项 · 次序稳定）· ` +
      `limit=3 → 3 条 · 没有那个目录 → 0 条 · 筛 @src/ui/x → 1 条 · 带空格那条接成 @"…"`,
  )
})

// ── ⑤ 面板那一帧 ─────────────────────────────────────────────────────────────
test('⑤ 面板那一帧：候选排在内容下面 · 选中带记号 · 装不下说还剩几条 · 空时说没有匹配的', () => {
  const rows = cmdRows('')
  const frame = (o: { readonly sel?: number; readonly rows?: readonly string[] } = {}): readonly string[] =>
    frameOf({
      snapshot: snap,
      permanent: ['round/state r1 Idle→Planning'],
      width: 100,
      height: K,
      menu: { rows: o.rows ?? rows, sel: o.sel ?? 0 },
    }).lines
  const lines = frame({ sel: 2 })
  assert.ok(lines.some((l) => l.includes('▸ watch')), `选中的那一条带记号：\n${lines.join('\n')}`)
  assert.ok(lines.some((l) => l.includes('status')), '候选那几行在面板里')
  // 候选排在内容下面（挨着框底），而且**没有把框撑破**。
  const at = lines.findIndex((l) => l.includes('▸ watch'))
  assert.ok(at > 0 && at < lines.length - 1, `候选夹在框里面：第 ${at + 1} 行 / 共 ${lines.length} 行`)
  for (const l of lines) assert.equal([...l].length > 0, true)
  assert.ok(lines.some((l) => l.includes('还有')), `30 条装不下，要说还剩几条：\n${lines.join('\n')}`)
  assert.ok(lines.some((l) => l.includes('（没有匹配的）')) === false, '有候选时不说"没有匹配的"')
  const none = frame({ rows: [] })
  assert.ok(none.some((l) => l.includes('（没有匹配的）')), `一条都没有时要说出来：\n${none.join('\n')}`)
  // 纯：同一份输入两次折出来逐字节相同。
  assert.deepEqual(frame({ sel: 2 }), lines, '同一份输入两次折出来逐字节相同')
  // 选中的那一条一定看得见（窗跟着选中走）。
  const last = frame({ sel: rows.length - 1 })
  assert.ok(last.some((l) => l.includes('▸ ')), '选到最后一条时它也在窗里')
  console.log(
    `⑤ 读数：${rows.length} 条候选 → 一屏 ${K} 行的框里印出 ${lines.filter((l) => /^│[ ▸]/.test(l)).length} 行（候选 3 行 + 内容）· ` +
      `箭头指向第 3 条（窗跟着它走）· 装不下时说"还有 29 条"· 0 条时说"（没有匹配的）"· 两次折出来逐字节相同`,
  )
})

// ── ⑥ 接上终端那一块：面板 + 输入行 ───────────────────────────────────────────
test('⑥ `panel()` = 面板那几行 + 输入行那几行 · 不给视图时与从前逐字节相同', () => {
  const rows = cmdRows('')
  const view = { menu: { rows, sel: 1 }, input: { rows: ['» /lo'], caret: { row: 0, col: 5 } } }
  const session = openSession({ view: () => view })
  const panel = session.panel({ columns: 80, height: K })
  assert.equal(panel.rows.length, K, '面板那几行还是正好 K 行')
  assert.deepEqual(panel.input, view.input, '输入行那几行原样交出去（光标在第几列也在）')
  assert.equal(session.frame({ columns: 80, height: K }).length, K, '`frame()` 那一份不含输入行（与从前同一形状）')
  // **地板**：不给视图时一个字节都不多（这一格不许让老的那一档变样）。
  const plain = openSession()
  const before = plain.panel({ columns: 80, height: K })
  assert.equal(before.input, undefined, '不给视图就没有输入行')
  assert.deepEqual(before.rows, plain.frame({ columns: 80, height: K }), '没有视图时 `panel()` 就是 `frame()`')
  assert.deepEqual(plain.frame({ columns: 80, height: K }), frameOf({
    snapshot: snap,
    permanent: [],
    width: 80,
    height: K,
  }).lines, '与"直接折一帧"逐字节相同')
  console.log(
    `⑥ 读数：面板 ${panel.rows.length} 行 + 输入行 ${panel.input?.rows.length ?? 0} 行（光标第 ${(panel.input?.caret.col ?? 0) + 1} 列）· ` +
      '不给视图时 `panel()` 与 `frame()` 逐字节相同（地板保住）',
  )
})
