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
