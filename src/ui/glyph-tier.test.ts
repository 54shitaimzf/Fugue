// 0.4.3 第二幕 ⑤ 的断言：字形档三档（宪法 0.4.3 行 ⑥ · 施工单 § 五 ⑤）。
//
// 三条各量一件事：
//   · ① **三档那张表**：名字逐条 · 每一档都有一份完整字形 · `mark` 的列宽从档里那一个字符串量
//     （`ascii` 三列 · `box` 一列）· `box` 那一档的成员除了宪法点名的 `mark` 都在交集里；
//   · ② **差集为空**：拿真画出来的帧逐档收字形——这一层印出去的每一个非 ASCII 字形都在那一档的
//     表里有名字（汉字与标点不算字形，它们是文字）；
//   · ③ **换档只换那几格字**：同一份输入在 `ascii` 与 `box` 两档下画出来的帧，**行数相同 ·
//     每行显示宽度相同**，逐行比只差字形那几处。
//
// **夹具刻意避开值层的读数原文**：状态图那几行（`⇒` `─` …）是 `StatusSnapshot.edges` 的原文、
// 进 `--json`，字形档管不着它（管它就是把渲染档泄进值层）。所以这份账里一条 `round/state`
// 都不放——量的是这一层自己的结构字形。
//
// 负对照（红得起来才是断言；六处各注入过一次，下面是实测结果）：
//   ① 把 `box.mark` 改成 `'...'` → ① 当场红（列宽与宪法 ⑥ 对不上）；
//   ② 往框线里塞一个交集之外的字形（`●`）→ ② 当场红（差集非空）；
//   ③ **框线没读档**（`bar()` 里写死 `─`）→ ② 当场红（ascii 档印出表外的字形）；
//   ④ **截断标记没读档**（`clip()` 里写死 `…`）→ ② 当场红；
//   ⑤ 只改表不改渲染（比如把 `GLYPHS.ascii.h` 改成 `─`）→ **三条照旧绿**：表与渲染一起变，
//      差集自然对得上。③④ 上一版就是这么注的，抓不住——所以这两处量的必须是"渲染读没读档"；
//   ⑥ 把 `box.sel` 改成两列的字形 → ② 当场红（表里那一格成了 `'▶ '`，印出来的是 `▶`）。
//
// **③ 那一组的力气说清楚**：`frameOf` 的行是 `cell()` 补到正好 `width` 列的，所以"行数与列宽
// 相同"有一半是补宽保证的——这一条量的是**换档没有把那个保证破坏掉**；真正有劲的是 ②
// （差集为空）。而"标记之前还看得见几个字"本来就随标记的列宽变，那是"列宽从档取"这条判据自己
// 要求的，所以这里不断言它。
import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_GLYPH_TIER, GLYPHS, GLYPH_TIERS, glyphsOf, markWidthOf, setGlyphTier, widthOf, wrap } from './glyph.ts'
import type { GlyphSet, GlyphTier } from './glyph.ts'
import { frameOf } from './frame.ts'
import { statusOf } from '../probe/status.ts'
import type { StatusRow } from '../probe/status.ts'

/** 一档里的字形全部摊平（`spark` 那四格也在内）。 */
function membersOf(set: GlyphSet): string[] {
  const out: string[] = []
  for (const [name, v] of Object.entries(set)) {
    if (name === 'spark') out.push(...(v as readonly string[]))
    else out.push(v as string)
  }
  return out
}

/** 汉字与标点不算字形（它们是文字）；其余非 ASCII 的算。 */
const GLYPH_CHAR = /[\p{So}\p{Sm}\p{Sk}\p{Sc}]/u

/** 一个串里那些"要进档"的字符。 */
function symbolsIn(s: string): string[] {
  return [...s].filter((c) => c !== ' ' && (GLYPH_CHAR.test(c) || c === '…'))
}

/** 一份够画出面板的账：**一条 `round/state` 都没有**（见文件头——避开值层的读数原文）。 */
function rows(): StatusRow[] {
  return [
    { pos: { writer: 'agent/r1/1', seq: 1 }, e: { t: 'llm/call', agent: 'agent/r1/1', step: 0, model: 'm', stop: 'end-turn', rawStop: 'end_turn', thinking: null, usage: { inputTokens: 3000, cacheReadTokens: 4096, cacheWriteTokens: 0, outputTokens: 300, reasoningTokens: 120 } } },
    { pos: { writer: 'agent/r1/1', seq: 2 }, e: { t: 'agent/stop', agent: 'agent/r1/1', reason: '收敛', steps: 2 } },
  ] as unknown as StatusRow[]
}

/** 一帧：给定的档下、给定尺寸。**用完把档还原**（它是进程级的那一份）。 */
function frameIn(
  tier: GlyphTier,
  o: { width?: number; height?: number; menu?: readonly string[]; sel?: number } = {},
): readonly string[] {
  const was = setGlyphTier(tier)
  try {
    return frameOf({
      snapshot: statusOf(rows()),
      width: o.width ?? 100,
      height: o.height ?? 20,
      ...(o.menu === undefined ? {} : { menu: { rows: o.menu, sel: o.sel ?? 0 } }),
    }).lines
  } finally {
    setGlyphTier(was)
  }
}

const MENU = ['/log ', '/status ', '/tui ']
const SHAPES = [
  {},
  { width: 40, height: 8 },
  { width: 20, height: 6 },
  { width: 60, height: 12, menu: MENU, sel: 1 },
] as const

test('① 三档那张表：名字逐条 · 每档一份完整字形 · 标记的列宽从档里那一个字符串量', () => {
  assert.deepEqual([...GLYPH_TIERS], ['ascii', 'box', 'rich'])
  assert.equal(DEFAULT_GLYPH_TIER, 'box', '缺省是交集那一档')
  for (const tier of GLYPH_TIERS) {
    for (const [name, v] of Object.entries(glyphsOf(tier))) {
      if (name === 'spark') {
        assert.equal((v as readonly string[]).length, 4, `${tier}.spark 是四格（空 · 低 · 中 · 高）`)
        continue
      }
      assert.ok(typeof v === 'string' && v !== '', `${tier}.${name} 有字形`)
    }
  }
  assert.equal(markWidthOf('ascii'), 3, 'ascii 档 `...` 三列')
  assert.equal(markWidthOf('box'), 1, 'box 档 `…` 一列')
  assert.equal(markWidthOf('rich'), 1)
  assert.equal(GLYPHS.ascii.mark, '...')
  assert.equal(GLYPHS.box.mark, '…')
  // **box 那一档的成员**：除了宪法 ⑥ 点名的 `mark` 那一处，其余都在交集里。
  const INTERSECTION = new Set([...'─│┌┐└┘├┤┬┴', '░', '▒', '█', '←', '↑', '→', '↓', '▶', '•'])
  const strays = membersOf(GLYPHS.box).filter(
    (c) => c !== '' && ![...c].every((ch) => ch.charCodeAt(0) < 0x80 || INTERSECTION.has(ch)),
  )
  assert.deepEqual(strays, ['…'], `box 档除了宪法点名的 mark，其余都该在交集里：${strays.join('')}`)
  // **细线那一横**（第二幕 ④）：分隔线从 `div` 取——`box` 那一档仍要在交集里（与上面那条闭包同一
  // 条：把 `box.div` 换成 `┈`，上面那句 `strays` 当场多一个），`rich` 那一档才是更细的那一横。
  assert.deepEqual(
    GLYPH_TIERS.map((t) => GLYPHS[t].div),
    ['-', '─', '┈'],
    '细线那一横：ascii `-` · box `─`（交集里没有更细的一横）· rich `┈`',
  )
  console.log(
    `① 读数：三档 ${GLYPH_TIERS.join(' · ')}；mark 列宽 ascii=${markWidthOf('ascii')} box=${markWidthOf('box')}；` +
      `box 档字形「${membersOf(GLYPHS.box).join('')}」（交集之外只有 mark 那一处）`,
  )
})

test('② 差集为空：真画出来的帧里，非 ASCII 的每个字形都在那一档的表里有名字', () => {
  for (const tier of GLYPH_TIERS) {
    const set = new Set(membersOf(glyphsOf(tier)))
    const seen = new Set<string>()
    for (const o of SHAPES) for (const line of frameIn(tier, o)) for (const c of symbolsIn(line)) seen.add(c)
    assert.ok(seen.size > 0, `${tier} 档这一组帧里一个字形都没有——那这条断言量的是空气`)
    const stray = [...seen].filter((c) => !set.has(c))
    assert.deepEqual(stray, [], `${tier} 档画出来的字形里有表外的：${stray.join('')}（表里是 ${[...set].join('')}）`)
    console.log(`② 读数：${tier} 档画出来 ${[...seen].sort().join('')} · 表里「${membersOf(glyphsOf(tier)).join('')}」`)
  }
})

test('③ 换档只换那几格字：行数 · 每行列宽不动 · 折行点与档无关', () => {
  // **为什么不断言"去掉字形之后逐行相同"**：截断标记的列宽是按档来的（`ascii` 三列 · `box`
  // 一列），所以一条被截断的行里，"标记之前还看得见几个字"本来就差着那两列——那是"列宽从档取"
  // 这条判据自己要求的。判据原句说的是**行宽与折行点**一个不变，这一条量的就是这两样。
  for (const o of SHAPES) {
    const a = frameIn('ascii', o)
    const b = frameIn('box', o)
    assert.equal(a.length, b.length, `行数相同（${JSON.stringify(o)}）`)
    for (const [i, lineA] of a.entries()) {
      assert.equal(widthOf(lineA), widthOf(b[i] as string), `第 ${i + 1} 行列宽相同：${lineA} / ${b[i]}`)
    }
    assert.notDeepEqual(a, b, `两档该有差别（不然这一条量不到东西）：${JSON.stringify(o)}`)
  }
  // 折行点：`wrap` 一处都不许读档——拿两档各折一遍同一条长行，逐段相同。
  const long = '用量 调用 3 · input 3,000 · cacheRead 4,096 · cacheWrite 0 · output 300 · 思考 120'
  const wrapped = (tier: GlyphTier): readonly string[] => {
    const was = setGlyphTier(tier)
    try {
      return wrap(long, 24)
    } finally {
      setGlyphTier(was)
    }
  }
  assert.deepEqual(wrapped('ascii'), wrapped('box'), '折行点与档无关')
  assert.ok(wrapped('box').length > 1, '这条长行该折开（不然这一条量的是空气）')
  console.log(
    `③ 读数：${SHAPES.length} 组尺寸下 ascii 与 box 行数与列宽逐行相同；同一条长行在两档下折成 ${wrapped('box').length} 段，逐段相同`,
  )
})
