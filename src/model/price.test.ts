/**
 * 钱那一栏的断言。**每一条都要能红**：价目表按官方那一页逐项钉住 · 峰谷窗按 UTC 那几个边界钉住 ·
 * 算钱用真档那一趟的三个数（`wire-in` 那三份：2982 / 4864 / 271）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { PRICE_BOOK, costOf, formatUsd, matchModels, moneyText, phaseOf, priceOf, ratesOf } from './price.ts'
import type { Billable } from './price.ts'
import { BUILTIN_CATALOG } from './catalog.ts'

/** 真档那一趟的三个数（三份录制加起来的：未命中 2982 · 命中 4864 · 输出 271）。 */
const TRIP: Billable = {
  calls: 3,
  inputTokens: { total: 2982, missing: 0 },
  cacheReadTokens: { total: 4864, missing: 0 },
  cacheWriteTokens: { total: 0, missing: 0 },
  outputTokens: { total: 271, missing: 0 },
}

/** 浮点比：这一档的读数常在千分之一美分上，逐字节相等不可靠，容差取 1e-12 美元。 */
function near(got: number | null, want: number, msg: string): void {
  assert.ok(got !== null && Math.abs(got - want) < 1e-12, `${msg}：拿到 ${String(got)}，应当是 ${want}`)
}

test('① 价目表与官方那一页逐项相同（三档 × 两档 × 两个模型）', () => {
  const flash = priceOf('deepseek-flash', BUILTIN_CATALOG)
  const pro = priceOf('deepseek-v4-pro', BUILTIN_CATALOG)
  assert.ok(flash !== null && pro !== null, '官方那两个名字在价目表里查不到')
  assert.deepEqual(flash.peak, { cacheMiss: 0.3, cacheHit: 0.006, output: 1.2 })
  assert.deepEqual(flash.offPeak, { cacheMiss: 0.15, cacheHit: 0.003, output: 0.6 })
  assert.deepEqual(pro.peak, { cacheMiss: 1.32, cacheHit: 0.044, output: 3.96 })
  assert.deepEqual(pro.offPeak, { cacheMiss: 0.66, cacheHit: 0.022, output: 1.98 })
  // 官方那一页那一句"谷时是峰时的一半"：两行都按它核一遍（改价改错一档，这里变红）。
  for (const row of PRICE_BOOK) {
    near(row.offPeak.cacheMiss, row.peak.cacheMiss / 2, `${row.model} 的未命中价不是峰谷两倍`)
    near(row.offPeak.cacheHit, row.peak.cacheHit / 2, `${row.model} 的命中价不是峰谷两倍`)
    near(row.offPeak.output, row.peak.output / 2, `${row.model} 的输出价不是峰谷两倍`)
  }
  // 负对照：把 Flash 的输出价换成 Pro 那一档，① 里那条逐项断言当场红。
  const tampered = [{ ...(flash as object), offPeak: { ...flash.offPeak, output: 3.96 } } as (typeof PRICE_BOOK)[number]]
  assert.notDeepEqual(priceOf('deepseek-flash', { ...BUILTIN_CATALOG, prices: tampered })?.offPeak, flash.offPeak)
})

test('② 峰谷那一档：官方那两个窗（UTC）· 周末整天谷时 · 节假日从参数进来', () => {
  const at = (s: string): Date => new Date(s)
  // 先把这几个时刻是星期几钉住——日期写错的话，下面几条会红在别处（那就是假绿）。
  assert.equal(at('2026-09-28T00:00:00Z').getUTCDay(), 1, '2026-09-28 不是周一')
  assert.equal(at('2026-09-26T00:00:00Z').getUTCDay(), 6, '2026-09-26 不是周六')
  assert.equal(phaseOf(at('2026-09-28T00:59:00Z')), 'off-peak')
  assert.equal(phaseOf(at('2026-09-28T01:00:00Z')), 'peak')
  assert.equal(phaseOf(at('2026-09-28T03:59:00Z')), 'peak')
  assert.equal(phaseOf(at('2026-09-28T04:00:00Z')), 'off-peak')
  assert.equal(phaseOf(at('2026-09-28T06:00:00Z')), 'peak')
  assert.equal(phaseOf(at('2026-09-28T09:59:00Z')), 'peak')
  assert.equal(phaseOf(at('2026-09-28T10:00:00Z')), 'off-peak')
  assert.equal(phaseOf(at('2026-09-26T02:00:00Z')), 'off-peak')
  assert.equal(phaseOf(at('2026-09-27T02:00:00Z')), 'off-peak')
  // 节假日那一栏是参数：同一个时刻，递进去就从峰时变谷时。
  assert.equal(phaseOf(at('2026-09-28T02:00:00Z')), 'peak')
  assert.equal(phaseOf(at('2026-09-28T02:00:00Z'), ['2026-09-28']), 'off-peak')
})

test('③ 算钱：真档那一趟 · 峰谷真的分开 · 思考那一栏一分钱都不加', () => {
  const row = priceOf('deepseek-flash/anthropic', BUILTIN_CATALOG) // 账上写的是我们这个键
  assert.ok(row !== null, '账上那个键认不出价目')
  assert.equal(row.model, 'deepseek-flash', '我们自己发出去的名字没折回官方那一行的名字')
  const off = costOf(TRIP, row, 'off-peak')
  const peak = costOf(TRIP, row, 'peak')
  // 2982 × 0.15 + 4864 × 0.003 + 271 × 0.6 = 624.492（微美元）→ 0.000624492 美元。
  near(off.usd, 0.000624492, '谷时那一趟的钱')
  near(peak.usd, 0.001248984, '峰时那一趟的钱')
  near(peak.usd, (off.usd as number) * 2, '峰时不是谷时的两倍')
  assert.equal(off.missing, 0)
  // 负对照：命中那 4864 若按未命中价算，钱要大五十倍——证明"命中"那一栏走的是另一档价。
  const asMiss = costOf(
    { ...TRIP, inputTokens: { total: 2982 + 4864, missing: 0 }, cacheReadTokens: { total: 0, missing: 0 } },
    row,
    'off-peak',
  )
  near(
    (asMiss.usd as number) - (off.usd as number),
    (4864 * (row.offPeak.cacheMiss - row.offPeak.cacheHit)) / 1_000_000,
    '那 4864 若按未命中价算，差额应当是 4864 ×（未命中 − 命中）',
  )
  // 写进缓存的那一部分按未命中价算（官方表上没有第三档），所以它进的是同一个桶。
  const withWrite = costOf({ ...TRIP, cacheWriteTokens: { total: 1000, missing: 0 } }, row, 'off-peak')
  near(withWrite.usd, (off.usd as number) + (1000 * row.offPeak.cacheMiss) / 1_000_000, '缓存写入那 1000 没算进钱')
  // 思考 token 是输出里的明细：把它抬到 100 万，钱一分不变（`Billable` 里没有这一栏）。
  const withThinking = { ...TRIP, reasoningTokens: { total: 1_000_000, missing: 0 } }
  assert.deepEqual(costOf(withThinking, row, 'off-peak'), off)
  // 没有价目那一档：**`null`，不是 0**；没量到的条数要落到 `missing` 上（这一笔是下界）。
  assert.deepEqual(costOf(TRIP, null, 'off-peak'), { usd: null, missing: 0 })
  assert.equal(costOf({ ...TRIP, outputTokens: { total: 271, missing: 2 } }, row, 'off-peak').missing, 2)
})

test('④ 名字 → 价目行：账上那两个键都认得出，两种价混在一趟与没见过的名字都不给行', () => {
  assert.equal(matchModels(['deepseek-flash/openai'], BUILTIN_CATALOG).row?.model, 'deepseek-flash')
  assert.equal(matchModels(['deepseek-flash/anthropic'], BUILTIN_CATALOG).row?.model, 'deepseek-flash')
  assert.equal(matchModels(['deepseek-flash/anthropic', 'deepseek-flash/openai'], BUILTIN_CATALOG).row?.model, 'deepseek-flash')
  assert.equal(matchModels(['deepseek-flash', 'deepseek-chat'], BUILTIN_CATALOG).row?.model, 'deepseek-flash')
  assert.deepEqual(matchModels([], BUILTIN_CATALOG), { row: null, miss: 'empty' })
  assert.deepEqual(matchModels(['没有这个模型'], BUILTIN_CATALOG), { row: null, miss: 'unknown' })
  assert.deepEqual(matchModels(['deepseek-flash', 'deepseek-v4-pro'], BUILTIN_CATALOG), { row: null, miss: 'mixed' })
  assert.equal(priceOf(null, BUILTIN_CATALOG), null)
  assert.equal(priceOf('', BUILTIN_CATALOG), null)
})

test('⑤ 钱那一行：算不出来时不拿 0 顶 · 价与档印在同一行里 · 缺项报下界', () => {
  const flash = priceOf('deepseek-flash', BUILTIN_CATALOG)
  assert.ok(flash !== null)
  const money = costOf(TRIP, flash, 'off-peak')
  const text = moneyText({
    money,
    match: matchModels(['deepseek-flash/openai'], BUILTIN_CATALOG),
    phase: 'off-peak',
    models: ['deepseek-flash/openai'],
  })
  assert.ok(text.includes('0.000624'), text)
  assert.ok(text.includes('谷时'), text)
  assert.ok(text.includes('deepseek-flash'), text)
  assert.ok(text.includes('deepseek-flash/openai'), '回执里没印账上那个名字，价与名对不上时看不出来')
  const none = moneyText({ money, match: matchModels(['没有这个模型'], BUILTIN_CATALOG), phase: 'peak', models: ['没有这个模型'] })
  assert.ok(none.includes('算不出来'), none)
  assert.ok(!none.includes('0.000000'), '没有价目时印了一个 0')
  const mixed = moneyText({
    money,
    match: matchModels(['deepseek-flash', 'deepseek-v4-pro'], BUILTIN_CATALOG),
    phase: 'peak',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  })
  assert.ok(mixed.includes('两种价'), mixed)
  const lower = moneyText({
    money: { usd: 1, missing: 3 },
    match: matchModels(['deepseek-flash'], BUILTIN_CATALOG),
    phase: 'peak',
    models: ['deepseek-flash'],
  })
  assert.ok(lower.includes('下界'), lower)
  assert.ok(lower.includes('峰时'), lower)
  assert.equal(ratesOf(flash, 'peak').output, 1.2)
  assert.equal(formatUsd(0), '$0.000000')
})
