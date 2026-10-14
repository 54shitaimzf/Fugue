// **命令行那一层读了几遍账**：两条结构断言，量的都是 `src/cli/cmd/round.ts` 的源码文本。
// 跑法：cd ~/fugue && node tools/test-entry.js fast src/cli/cmd/round-reads.test.ts
//
// 出处：架构 § 9.6（单次进程 + 每次重建——读一趟账就要重放一份日志）· 发布窗维护批的交接单
// § 三 4（判据：`round run` 与 `round work` 打回那几份读数只读一遍账，并且结构断言红过）。
//
// **为什么住在 fast 组**：两条都只读源码文本，不碰真依赖——不起 bwrap · 不连端口 · 不落日志。
// 它们原先与 `src/cli/chain.test.ts` 那一族真档断言同处，于是只有跑 real 组、或在 CI 的 full
// 任务里才抓得住「又多读了一趟」；而这是命令行那一层自己的形状，人改它的时候手上跑的正是 fast 组。
//
// 两条各自会红的样子写在它们里面。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SOURCE = fileURLToPath(new URL('./round.ts', import.meta.url))

test('一趟命令读一遍：命令行那一层只有三处 `roundFactsOf`（`round plan` · `say` · `round go` 各一处）', () => {
  // **为什么量这一条结构**：轮次那一层的三个入口收了 `facts` 就不再读日志（`plan.test.ts` ⑩ ·
  // `say.test.ts` ⑥ · `dispatch.test.ts` ⑤ 量的是它），而"命令行读了几遍"这一头**没有注入缝**
  // ——每条命令一个真进程、一次真加载。所以量它的来源：三处读，一处一条命令，每一处都是
  // 「读一次、递下去」。**多出来的那一处就是又一趟读**：那时要么把读数递下去，要么把这一条改掉。
  const source = readFileSync(SOURCE, 'utf8')
  const sites = source
    .split('\n')
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => line.includes('roundFactsOf('))
  assert.equal(sites.length, 3, `命令行那一层读了 ${sites.length} 遍轮次日志（该是三处：round plan · say · round go）`)
  for (const [at, line] of sites) {
    assert.match(
      line,
      /const facts = await roundFactsOf\(ctx\.log, round\)/,
      `第 ${at} 行那一处不是「读一次、递下去」的形状：${line.trim()}`,
    )
  }
  console.log(`读数：命令行那一层 roundFactsOf( 共 ${sites.length} 处（第 ${sites.map(([at]) => at).join(' · ')} 行），一处一条命令`)
})

test('跑完那一档读一遍：`round run` 与 `round work` 各自只读一趟账（读一遍、折四遍）', () => {
  // **为什么量这一条结构**：这两条命令原先各读四趟——三个数一趟 · 归因一趟 · 逐趟账一趟 ·
  // 指标一趟——四趟读的是同一份日志。那既是白付四遍读的钱，也让「四份读数同源」这句话靠四处
  // 自觉。现在整份文件里只剩一处 `readMerged()`（`runFoldsOf` 里那一次），两个入口各走一次它。
  // **多出来的那一处就是又一趟读**：那时要么把折法收进 `runFoldsOf`，要么把这一条改掉。
  // 读数对不对由 `status.test.ts` ⑩ 那条三处读法的断言管，这里只管「读了几遍」。
  const source = readFileSync(SOURCE, 'utf8')
  const lines = source.split('\n').map((line, i) => [i + 1, line] as const)
  const reads = lines.filter(([, line]) => line.includes('readMerged()'))
  assert.equal(reads.length, 1, `跑完那一档读了 ${reads.length} 遍账（该是一遍：读一次、折四遍）`)
  const folds = lines.filter(([, line]) => line.includes('runFoldsOf({'))
  assert.equal(folds.length, 2, `走读一遍那一档的入口有 ${folds.length} 处（该是两处：round run · round work）`)
  console.log(`读数：cmd/round.ts 里 readMerged() 共 ${reads.length} 处（第 ${reads.map(([at]) => at).join(' · ')} 行）· runFoldsOf({ 共 ${folds.length} 处（第 ${folds.map(([at]) => at).join(' · ')} 行）`)
})
