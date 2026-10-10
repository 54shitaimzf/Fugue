// 外观草稿 · 片与上色（ROADMAP § 5 的 0.4.3 行 ②④；验收列「两道门与黑白地板逐字节不变」的那一层）。
//
//   ① `fit` 与生产那一把尺逐字节相同：字 = `clip` + 补空格，列宽恰好 `w`；截过时那个 `…` 自成一片、
//      落弱化格，而且它就是 `clip` 给的那个字形（`ELLIPSIS` 从 `clip` 推）；
//   ② `off` 档逐字节等于没有色位（片的字接起来）；任一档剥掉 SGR 都是 `off` 那一份（三档同形）；
//      有色的片各包恰一对、归位就是 `term.ts` 的 `STYLE_OFF`；
//   ③ 折行：断点照 `glyph.ts` 的 `wrap`（不悬挂时逐段相同）· 悬挂缩进 · 断点前悬空的 ` ·` 吃掉 ·
//      字一个不少（去掉空白与 `·` 之后逐字相同）· 每段 ≤ 宽；
//   ④ 折叠标记全站一个口径：草稿里「还有 N」这几个字只许出现在 `foldText` 那一处。
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { clip, widthOf, wrap } from '../glyph.ts'
import { STYLE_OFF } from '../term.ts'
import { ELLIPSIS, fit, foldNote, foldText, lineWidth, merge, paint, sp, strip, textOf, wrapLine } from './paint.ts'
import type { Line } from './paint.ts'
import { COLOR_TIERS, PALETTES, SLOTS } from './palette.ts'

const SAMPLES: readonly string[] = [
  '',
  'abc',
  '中文abc',
  'été · 组合符号',
  '👨‍👩‍👧 一家三口 · emoji',
  '契约 2 · 折叠尝试 1 · 冲突 0 · 验收 1 次（过 3 / 没过 0）',
  'a'.repeat(120),
]

/** 把一个串按每 3 个 code unit 切成片、色位轮着给（片界故意不落在簇界上）。 */
function shred(s: string): Line {
  const out = []
  for (let i = 0, k = 0; i < s.length; i += 3, k += 1) out.push(sp(s.slice(i, i + 3), SLOTS[k % SLOTS.length]))
  return out
}

test('① fit 与生产那一把尺逐字节相同（clip + 补空格），截过时 … 自成一片落弱化格', () => {
  assert.equal(ELLIPSIS, '…', '截断标记就是 clip 给的那个字形')
  assert.equal(clip('中文', 1), ELLIPSIS, '从 clip 推出来的那一个')
  let truncated = 0
  for (const s of SAMPLES) {
    for (const w of [1, 2, 3, 5, 8, 13, 40, 200]) {
      const line = fit(shred(s), w)
      const cut = clip(s, w)
      assert.equal(textOf(line), cut + ' '.repeat(Math.max(0, w - widthOf(cut))), `字与 cell(${JSON.stringify(s)}, ${w}) 不同`)
      assert.equal(lineWidth(line), w, `${JSON.stringify(s)} 补到 ${w} 列`)
      if (cut !== s) {
        truncated += 1
        const marks = line.filter((x) => x.text.includes(ELLIPSIS))
        assert.equal(marks.length, 1, '截过的行恰一个 … 片')
        assert.equal(marks[0]?.slot, 'muted', '截断标记落弱化格')
      }
    }
  }
  assert.ok(truncated > 10, '样本里要真有截过的（不然这一条量不到 … 那一片）')
  assert.deepEqual(fit([sp('abc')], 0), [], '0 列：空')
  console.log(`① 读数：${SAMPLES.length} 个串 × 8 档宽 · 截过 ${truncated} 次 · 字逐字节等于 clip + 补空格`)
})

test('② off 档逐字节等于没有色位 · 三档同形 · 有色的片各包恰一对', () => {
  for (const s of SAMPLES) {
    const line = shred(s)
    assert.equal(paint(line, PALETTES.off), textOf(line), 'off 档 = 片的字接起来，一个字节不多')
    assert.ok(!paint(line, PALETTES.off).includes('\x1b'), 'off 档一个 ESC 都不许有')
    for (const tier of COLOR_TIERS) {
      const out = paint(line, PALETTES[tier])
      assert.equal(strip(out), textOf(line), `${tier} 档剥掉 SGR 之后与 off 档同形`)
      const styled = merge(line).filter((x) => PALETTES[tier][x.slot] !== '').length
      assert.equal(out.split(STYLE_OFF).length - 1, styled, `${tier} 档：有色的片各包恰一对（归位 = term.ts 的 STYLE_OFF）`)
    }
  }
  // 合并只动片界、不动字。
  const line = [sp('a'), sp('b'), sp('', 'bad'), sp('c', 'bad'), sp('d', 'bad')]
  assert.deepEqual(merge(line), [sp('ab'), sp('cd', 'bad')])
  console.log(`② 读数：${SAMPLES.length} 个串 × ${COLOR_TIERS.length} 档 · 剥掉 SGR 全等 · off 档零 ESC`)
})

test('③ 折行：断点照 wrap · 悬挂缩进 · 悬空的 ` ·` 吃掉 · 字一个不少', () => {
  const s = '轮次 r1 · 状态 Rebuilding · 转移 5 条 · 跳步 1 · 打回 1 次 · 最近一条落在这一轮'
  const bare = (x: string): string => x.replace(/[\s·]/g, '')
  let same = 0
  let dangling = 0
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu 中文一段不带空格的长句子'
  for (const [one, w] of [12, 16, 20, 24, 37, 60].flatMap((x) => [[s, x], [words, x]] as const)) {
    const plain = wrapLine([sp(one)], w).map(textOf)
    // 不悬挂、也没有悬空的 ` ·` 时，与 `wrap` 逐段相同（断点只有一处真相）。
    const ref = wrap(one, w)
    if (ref.slice(0, -1).some((x) => x.endsWith(' ·'))) dangling += 1
    else {
      assert.deepEqual(plain, [...ref], `宽 ${w}：断点与 wrap 不同`)
      same += 1
    }
    for (const x of plain.slice(0, -1)) assert.ok(!x.endsWith('·'), `宽 ${w}：断点前悬空的 · 要吃掉（${x}）`)
    assert.equal(bare(plain.join('')), bare(one), `宽 ${w}：字少了`)
    for (const x of plain) assert.ok(widthOf(x) <= w, `宽 ${w}：一段超宽 ${x}`)
  }
  assert.ok(same > 0 && dangling > 0, `两支都要量到（与 wrap 逐段相同 ${same} 档 · 有悬空的 · ${dangling} 档）`)
  // 悬挂：续行比首行行首多缩 `hang` 列；剩下的宽不够 `HANG_ROOM` 就不悬挂。
  const edge = '  Planning ──contracts-issued──> Delegated'
  const hung = wrapLine([sp(edge)], 36, 2).map(textOf)
  assert.deepEqual(hung, ['  Planning ──contracts-issued──>', '    Delegated'], '续行缩到首行行首 + 2')
  assert.deepEqual(wrapLine([sp(edge)], 14, 2).map(textOf), wrapLine([sp(edge)], 14).map(textOf), '太窄就不悬挂')
  // 片的色位跟着字走。
  const colored = wrapLine([sp('aaaa '), sp('bbbb', 'bad')], 6)
  assert.deepEqual(colored, [[sp('aaaa')], [sp('bbbb', 'bad')]])
  console.log(`③ 读数：悬挂「${hung.join('⏎')}」· 2 句 × 6 档宽字一个不少（与 wrap 逐段相同 ${same} 档 · 吃掉悬空 · ${dangling} 档）`)
})

test('④ 折叠标记一个口径：… 还有 N 条（提示 · 提示）· 草稿里「还有 N」只住在 foldText', () => {
  assert.equal(foldText(5, '条', ['↑↓ 翻', '选中第 4 条']), '… 还有 5 条（↑↓ 翻 · 选中第 4 条）')
  assert.equal(foldText(3, '行'), '… 还有 3 行')
  assert.deepEqual(foldNote(2, '条'), [sp('… 还有 2 条', 'muted')], '整句落弱化格')
  // 口径只有一处：草稿的产品文件里，「还有」后面跟数字的写法只许出现在 paint.ts（foldText 那一处）。
  const dir = import.meta.dirname
  const offenders: string[] = []
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
    const text = readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l))
    for (const l of text) if (/还有 \$\{|还有 \d/.test(l) && f !== 'paint.ts') offenders.push(`${f}: ${l.trim()}`)
  }
  assert.deepEqual(offenders, [], '折叠标记绕过了 foldText')
  console.log(`④ 读数：${foldText(5, '条', ['↑↓ 翻', '选中第 4 条'])}`)
})
