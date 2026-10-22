// 用量求和与印法：**缓存读进了和，也印得出来**（计划 § 阶段 2 的断言）。
//
// 负对照：把 `sumUsage` 里的 `cacheReadTokens` 一行删掉，① 立刻红；把 `usageText` 的括号
// 删掉，② 立刻红。这两处正是原先丢读数的地方。
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Usage } from '../model/contract.ts'
import { sumUsage, usageText } from './usage.ts'

function use(o: Partial<Usage>): Usage {
  return { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, model: null, ...o }
}

test('① 求和：四项各加各的 · null 不当 0 · 一次都没量到就是 null', () => {
  const sum = sumUsage([
    use({ inputTokens: 100, cacheReadTokens: 30, cacheWriteTokens: 0, outputTokens: 50 }),
    null,
    use({ inputTokens: 20, cacheReadTokens: 12, cacheWriteTokens: null, outputTokens: 5 }),
  ])
  assert.equal(sum.calls, 3, 'null 那一次也占一次调用')
  assert.equal(sum.inputTokens, 120)
  assert.equal(sum.cacheReadTokens, 42, '缓存读要进和（原先在这一步丢的）')
  assert.equal(sum.cacheWriteTokens, 0, '写缓存有人报 0 就记 0')
  assert.equal(sum.outputTokens, 55)

  const silent = sumUsage([use({ inputTokens: 7, outputTokens: 1 })])
  assert.equal(silent.cacheReadTokens, null, '全都没报缓存读时它仍是 null，不是 0')
  console.log(`① 读数：${usageText(sum)} · 全缺那项=${String(silent.cacheReadTokens)}`)
})

test('② 印法：缓存读在输入的括号里 · 量不到时不写括号（老记录也读得出来）', () => {
  const withCache = usageText({ calls: 4, inputTokens: 220, cacheReadTokens: 12345, cacheWriteTokens: 0, outputTokens: 50 })
  assert.equal(withCache, '4 次调用 · 输入 220（缓存读 12,345）/ 输出 50')
  const without = usageText({ calls: 2, inputTokens: null, outputTokens: null })
  assert.equal(without, '2 次调用 · 输入 （没量到）/ 输出 （没量到）', '没有缓存那两栏的老记录照旧印得出来')
  console.log(`② 读数：${withCache} · ${without}`)
})
