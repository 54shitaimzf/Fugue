// ①d 同一个状态与坐标，**两份协议装出来的 B 区差在哪一段**。
//
// 这一条的由头：`src/cli/fugue.ts` 里 `handleFor` 给子 agent 的句柄填的是 `HOLDER_PROTOCOL`
// ——而持轮者那份 B 区里**没有「我的任务」那一段**（那是子 agent 的 B 区独有的第五段，架构
// § 8.11 的第一张表）。于是"任务 · 交付物 · 断言 · 产物路径"这一块在真档下**一次都不进前缀**。
// 这一条把那个差量逐字钉住，免得它再漂。
import assert from 'node:assert/strict'
import test from 'node:test'
import { HOLDER_PROTOCOL, SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { assemble, firstDivergence } from '../assemble/assemble.ts'
import { sourcesFor } from '../assemble/sources.ts'
import type { AssembleState } from '../assemble/sources.ts'
import { emptyState } from '../assemble/sources.ts'
import { DRAFT_FIELDS, DRAFT_KINDS, draftPathOf, goalWithDraftRule } from '../contract/draft.ts'
import { holderGoalText } from './plan.ts'

test('①d 子 agent 那份 B 区多出「我的任务」那一段，而持轮者那份没有它（A/C 两区逐字节相同）', () => {
  const dec = new TextDecoder()
  const coord = { id: 'agent-1', branch: 'refs/heads/agent/r1/1', outputPaths: ['deliver/agent-1/'] }
  const state: AssembleState = {
    ...emptyState(),
    policy: '# 项目方针\n',
    system: {},
    codeTree: [],
    goal: '写一份 README.md',
    commits: ['75b0e30 B0'],
    task: { goal: '写一份 README.md', question: '', deliverables: ['README.md'], evidenceRequired: ['读得出来'], assertions: ['文件存在'] },
    runtime: '第 0 步。',
  }
  const segs = sourcesFor(SUBAGENT_PROTOCOL, state, coord)
  const sub = assemble({ protocol: SUBAGENT_PROTOCOL, model: 'x' as never, segments: segs })
  const hold = assemble({ protocol: HOLDER_PROTOCOL, model: 'x' as never, segments: segs })
  const text = dec.decode(sub.zoneB)

  // A 区与 C 区逐字节相同（两份协议的差别只在 B 区——架构 § 8.11 的第一张表）。
  assert.equal(firstDivergence(sub.zoneA, hold.zoneA), -1, 'A 区不同了')
  assert.equal(firstDivergence(sub.zoneC, hold.zoneC), -1, 'C 区不同了')
  // 而 B 区那一段：子 agent 那份有「我的任务」，持轮者那份没有。
  assert.ok(text.includes('产物路径：deliver/agent-1/'), `子 agent 那份 B 区里没有「我的任务」那一段：${text}`)
  assert.equal(dec.decode(hold.zoneB).includes('产物路径：'), false, '持轮者那份 B 区里居然有「我的任务」那一段')
  assert.ok(sub.zoneB.length > hold.zoneB.length, '两份 B 区的长短关系不对')
  console.log(
    `①d 读数：子 agent B 区 ${sub.zoneB.length} 字节 · 持轮者 B 区 ${hold.zoneB.length} 字节 ` +
      `（差 ${sub.zoneB.length - hold.zoneB.length}）· A 区 ${sub.zoneA.length} · C 区 ${sub.zoneC.length}（两区逐字节相同）`,
  )
})


// ── S9 那条缺口的封口：「工作总目标」那一段的末尾说得出草案写哪儿 · 什么形状 ─────────────
//
// 由头：真档取证（`tools/probe-live-s9.sh`）量出来的那条缺口——三次真档里持轮者拿到的前缀
// 一个字节都没说这件事，于是真模型三次都写不出草案。这一条钉两样：**那一句与判据同源**
// （键逐字从 `DRAFT_FIELDS` 念出来，不另抄一份），**位置在末尾**（近因：模型读到的最后一处
// 说什么，它就做什么）。

test('S9 · 「工作总目标」末尾那一句：写哪儿 · 什么形状，而键是从判键域那一份念出来的', () => {
  const dec = new TextDecoder()
  const draftPath = draftPathOf('r1')
  const state: AssembleState = { ...emptyState(), goal: goalWithDraftRule('写一份 README.md', draftPath) }
  const segs = sourcesFor(HOLDER_PROTOCOL, state, null)
  const hold = assemble({ protocol: HOLDER_PROTOCOL, model: 'x' as never, segments: segs })
  const text = dec.decode(hold.zoneB)

  // 一 · 写哪儿：那一条路径就是 `round plan` 读回来的那一条（同一个函数给的）。
  assert.ok(text.includes(draftPath), `那一段里没有草案路径：${text}`)
  // 二 · 什么形状：每一节那一行的名字来自 `DRAFT_FIELDS`，而形状那半句来自 `FIELD_RULES`
  //     （判键域与判值域用的就是那两份）。逐键逐形状的核对在 `contract/draft.test.ts` ⑦。
  for (const kind of DRAFT_KINDS) {
    assert.ok(text.includes(`  ${kind}：`), `${kind} 那一行的名字不在那一段里：${text}`)
  }
  assert.ok(text.includes('值要写成那个形状'), '那一句里没有"形状"那半句')
  // 三 · 位置：它在「工作总目标」那一段的**末尾**（人那一句在最前）。
  assert.ok(text.startsWith('写一份 README.md'), `那一段的开头不是人那一句：${text.slice(0, 60)}`)
  assert.ok(text.trimEnd().endsWith('写别的路径不算这一趟的产物。'), `那一段的末尾不是那一句：${text.slice(-200)}`)
  // 四 · **它只在 B 区那一段里**：A 区（跨 agent 逐字节全等的那一段）与 C 区一个字节都不沾它。
  //     这一条是那句"权限与差别落在作用域上"的另外半张脸——共用头不许被这一趟的产物撑开。
  assert.equal(dec.decode(hold.zoneA).includes(draftPath), false, 'A 区里居然有草案路径')
  assert.equal(dec.decode(hold.zoneC).includes(draftPath), false, 'C 区里居然有草案路径')
  // 五 · **它是值不是段**：协议不加它，加它的是调用方给的那一份状态（`holderWiringOf`）。所以
  //     "子 agent 那一份不带它"这件事由接线定，量在 `chain.test.ts` 那一条（讨论态那一趟与
  //     录下来的子 agent 请求字节）。这里量的是同一件事的另一面：同一份状态换个模型，那一段照旧。
  const again = dec.decode(assemble({ protocol: HOLDER_PROTOCOL, model: 'y' as never, segments: segs }).zoneB)
  assert.equal(again, text, '换一个模型，那一段就变了')
  console.log(
    `S9 读数：「工作总目标」那一段 ${state.goal.length} 字节（人的意图 + 末尾那一句）· ` +
      `键逐字来自 DRAFT_FIELDS · A/C 两区不沾它`,
  )
})


// ── W12 那条缺口的封口：持轮者那一趟的前缀里说得出**这一格的收工口径** ────────────────────
//
// 由头：`tools/scenario/board.sh` 第一趟真档（两案 · 每案 1 趟）——两案的持轮者都在步数上界上
// 停住（8 步 / 6 步），草案一个字节都没写，门退回。补一次 `--dump-wire` 实录才看清它那几步：
// 读两次 · glob 两次，**最后四步全在调 `bash`**（预备态没有可执行的树，一步回一句"这一格没有
// 可执行的树"），而前缀里一件这样的事实都没有——它伸手之前无从知道，而拒绝是一步一句的。
//
// 这一条钉四样：**预算那一句在** · **"没有可执行的树"在**（且只在持轮者那一份里）· **位置在产物
// 说明之前**（末尾留给"写哪儿 · 什么形状"）· **子 agent 那一份一个字节没变**（它的三句在
// `我的任务` 里，由 `cli/chain.test.ts` 序 1 那份录下来的请求钉着）。

test('①e 持轮者那一趟的前缀里说得出收工口径，而子 agent 那一份里没有"没有可执行的树"', () => {
  const dec = new TextDecoder()
  const draftPath = draftPathOf('r1')
  // 这一份状态就是 `holderWiringOf` 给持轮者的那一份（改这一条时那边也要跟着改）。
  const goal = holderGoalText('让 check 通过', draftPath, ['fields'], 6)
  const hold = dec.decode(
    assemble({
      protocol: HOLDER_PROTOCOL,
      model: 'x' as never,
      segments: sourcesFor(HOLDER_PROTOCOL, { ...emptyState(), goal }, null),
    }).zoneB,
  )
  // 一 · 预算那一句：那个数就是 `--max-steps` 给的那个。
  assert.ok(hold.includes('这一格最多 6 步。'), `收工口径里没有预算那一句：${hold}`)
  // 二 · 这一格没有可执行的树：**事先**在，而不是等它伸手之后才回一句（那一句一步）。
  assert.ok(hold.includes('这一格没有可执行的树'), '收工口径里没有"这一格没有可执行的树"')
  assert.ok(hold.includes('`bash`'), '那一句没有点出被拦的那条工具名')
  // 三 · 位置：收工口径在草案那一句**之前**——末尾留给"写哪儿 · 什么形状"（近因）。
  assert.ok(hold.indexOf('这一格最多 6 步。') < hold.indexOf('这一趟要把拆分写进'), '收工口径跑到产物说明后面去了')
  assert.ok(hold.trimEnd().endsWith('写别的路径不算这一趟的产物。'), `那一段的末尾不是产物说明：${hold.slice(-120)}`)
  // 四 · 负对照：子 agent 那一份里没有"这一格没有可执行的树"（它那一格跑得动），而预算那一句两边都在。
  const coord = { id: 'agent/r1/1', branch: 'refs/heads/agent/r1/1', outputPaths: [] }
  const sub = dec.decode(
    assemble({
      protocol: SUBAGENT_PROTOCOL,
      model: 'x' as never,
      segments: sourcesFor(
        SUBAGENT_PROTOCOL,
        {
          ...emptyState(),
          goal: '让 check 通过',
          maxSteps: 6,
          task: {
            goal: '让 check 通过',
            question: '',
            deliverables: ['src/fields.js'],
            evidenceRequired: ['核过'],
            assertions: ['fields'],
          },
        },
        coord,
      ),
    }).zoneB,
  )
  assert.equal(sub.includes('这一格没有可执行的树'), false, '子 agent 那一份里居然有"这一格没有可执行的树"')
  assert.ok(sub.includes('这一格最多 6 步。'), '子 agent 那一份里丢了预算那一句')
  console.log(`①e 读数：持轮者那份 B 区 ${hold.length} 字节（人的意图 + 收工口径 + 产物说明）· 子 agent 那份 ${sub.length} 字节`)
})
