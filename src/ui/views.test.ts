// 第二幕 ⑦ 的断言：**主面倒过来之后，哪一格印在哪一面**是查得动的一件事。
//
// 一条会失败的断言（不是"看着对"）：
//   · ① 表只有一处（三档 · 词从词表推 · 缺省那一档是表里头一个）；
//   · ② 轮换是**环**（`Tab` 按到底是往回绕，不是走到头就不动）；
//   · ③ 三分表数得对（12 / 11 / 4），而且"删"那四格**值层照旧在、人读两面一处都不印**——
//     把 `probe/status.ts` 里那三个格子放回去，③ 当场红。
//
// 负对照（成对）：把 `ui/frame.ts` 的缺省视图从 `DEFAULT_VIEW` 改成 `'progress'` → ① 的那条
// "缺省是表里头一个"红；把 `status.ts` 的 `内核拒 / 边界挡 / 最近` 三个格子放回去 → ③ 红。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WORD_KEYS, WORDS } from '../words.ts'
import { statusOf, linesOf } from '../probe/status.ts'
import type { StatusRow } from '../probe/status.ts'
import { readCatalog } from '../model/catalog.ts'
import { frameOf } from './frame.ts'
import { CELL_TABLE, DEFAULT_VIEW, HOME_NAME, VIEW_KEYS, VIEW_TABLE, cellCounts, stepView, viewAt, viewNameOf } from './views.ts'
import type { CellHome } from './views.ts'

/** 一份最小的账：一条轮次链 + 一格 agent（四面都印得出来）。 */
const ROWS: readonly StatusRow[] = [
  { pos: { writer: 'round', seq: 1 }, e: { t: 'round/state', round: 'r1' as never, from: 'Idle' as never, to: 'Planning' as never } },
  { pos: { writer: 'agent/r1/1', seq: 1 }, e: { t: 'agent/stop', agent: 'agent/r1/1' as never, why: 'steps' as never, steps: 2, stopped: '收敛' } as never },
]

test('① 视图表：三档 · 键与词两两不同 · 每个词都在词表里 · 缺省那一档是表里头一个', () => {
  assert.equal(VIEW_KEYS.length, 3, `三档视图（对话 · 处境 · 读数），拿到 ${VIEW_KEYS.length} 档`)
  assert.deepEqual([...VIEW_KEYS], VIEW_TABLE.map((v) => v.key), '名单从表推（不另抄一遍）')
  assert.equal(new Set(VIEW_KEYS).size, VIEW_KEYS.length, `键不重名：${VIEW_KEYS.join(' · ')}`)
  const faces = VIEW_TABLE.map((v) => v.face)
  assert.equal(new Set(faces).size, faces.length, `印出去的词不重名：${faces.join(' · ')}`)
  const known = WORD_KEYS.map((k) => WORDS[k])
  for (const v of VIEW_TABLE) {
    assert.ok(known.includes(v.face), `视图名「${v.face}」该来自词表（一个界面词只住一处）`)
    assert.ok(v.arch !== '', `${v.key} 带一列"架构里叫什么"`)
  }
  assert.equal(DEFAULT_VIEW, VIEW_KEYS[0], '缺省那一档是表里头一个')
  assert.equal(viewNameOf('chat'), WORDS.chat, '键 → 词从表取')
  // **量画出来的那一帧**（不是量一个常数）：不给 `view` 时 `frameOf` 画的是缺省那一档。
  const head = frameOf({ snapshot: statusOf(ROWS), permanent: [], width: 100, height: 14 }).lines[0] ?? ''
  assert.ok(head.includes(WORDS.chat), `不给 view 时画的该是缺省那一档（${DEFAULT_VIEW}）：${head}`)
  console.log(`① 读数：${VIEW_KEYS.map((k) => `${k}=${viewNameOf(k)}`).join(' · ')} · 缺省 ${DEFAULT_VIEW}`)
})

test('② 走：`Tab` 环形（走到头绕回第一个）· 越界夹住', () => {
  assert.equal(stepView(0, 1), 1, '第一档往下是第二档')
  assert.equal(stepView(VIEW_KEYS.length - 1, 1), 0, '最后一档再往下绕回第一个——环，不是走到头停住')
  assert.equal(stepView(0, -1), VIEW_KEYS.length - 1, '反着走也绕')
  assert.equal(viewAt(99), VIEW_KEYS[VIEW_KEYS.length - 1], '越上界夹到最后一档')
  assert.equal(viewAt(-5), VIEW_KEYS[0], '负数夹到第一个（不抛、不猜）')
  console.log(
    `② 读数：0→1→2→0（${VIEW_KEYS.map((_, i) => viewAt(i)).join(' → ')} → ${viewAt(stepView(VIEW_KEYS.length - 1, 1))}）· 越界 99 → ${viewAt(99)}`,
  )
})

test('③ 三分表：12 / 11 / 4，而且"删"那四格值层照旧在、人读两面一处都不印', () => {
  const n = cellCounts()
  assert.equal(CELL_TABLE.length, 27, `三分表该是 27 格，拿到 ${CELL_TABLE.length}`)
  const kept = n.tail + n.flow + n.chat
  assert.equal(kept, 12, `保留那 12 格（账尾 + 对话流 + 对话视图），拿到 ${kept}`)
  assert.equal(n.progress + n.spending, 11, `降级那 11 格（Tab 里两档视图），拿到 ${n.progress + n.spending}`)
  assert.equal(n.gone, 4, `删那 4 格，拿到 ${n.gone}`)
  for (const key of Object.keys(n) as readonly CellHome[]) {
    assert.ok(HOME_NAME[key] !== '', `${key} 有一个人读的说法`)
  }
  assert.equal(
    new Set(CELL_TABLE.map((c) => c.cell)).size,
    CELL_TABLE.length,
    '一格只许写一行（同一格写两遍就是第二份真相）',
  )

  // ── 删那四格：值层照旧在（进 `--json`），人读两面一处都不印 ────────────────
  const s = statusOf(ROWS)
  const r = s.rounds[0]
  const a = s.agents[0]
  assert.ok(r !== undefined && 'hops' in r, '`rounds[].hops` 还在值层（这一站删的是读者，不是字段）')
  assert.ok(a !== undefined && 'denies' in a && 'bounds' in a && 'last' in a, '`agents[].denies/bounds/last` 还在值层')
  const cmd = linesOf(s, { cat: readCatalog() }).join('\n')
  const frame = frameOf({ snapshot: s, permanent: [], width: 100, height: 14 }).lines.join('\n')
  for (const [name, text] of [['命令行人面（probe/status.ts）', cmd], ['面板（ui/frame.ts）', frame]] as const) {
    // **格那一行**里那三个格子一个都不许再印（`越界 被挡 N 次（内核拒 N）` 那一行不是这三格：
    // 它带 `byRule` 分组，信息量严格更大，留着）。
    // 找格那一行：框线还在行首，所以按「格 <writer>」这一段找，不按行首找。
    // **不拿 `${WORDS.calls}` 一起当线索**：对话面把计数挪到缩进的那一行去了（收口后按人令），
    // 命令行那一面照旧。按「格 <writer>」这一段找，两张脸都找得到。
    const cell = text.split('\n').find((l) => l.includes(`${WORDS.agent} agent/`))
    assert.ok(cell !== undefined, `${name} 上该找得到格那一行：\n${text}`)
    assert.ok(!(cell as string).includes('内核拒'), `${name} 的格那一行不该再印「内核拒」：${cell as string}`)
    assert.ok(!(cell as string).includes('边界挡'), `${name} 的格那一行不该再印「边界挡」：${cell as string}`)
    assert.ok(!(cell as string).includes(`${WORDS.last} `), `${name} 的格那一行不该再印「${WORDS.last}」：${cell as string}`)
  }
  // 反面：这一份确实读到了那一面（不然上面那几条量的是空气）。
  assert.ok(cmd.includes(WORDS.agent), '命令行人面上该有格那一行')
  assert.ok(cmd.includes('内核拒'), '「越界 被挡（内核拒）」那一行留着——删的不是它')
  console.log(
    `③ 读数：27 格 = 保留 ${kept}（账尾 ${n.tail} · 对话流 ${n.flow} · 对话视图 ${n.chat}）` +
      ` + 降级 ${n.progress + n.spending}（处境 ${n.progress} · 读数 ${n.spending}） + 删 ${n.gone}` +
      ` · 删那四格值层都在 · 人读两面的格那一行「内核拒」「边界挡」「${WORDS.last}」0 处`,
  )
})
