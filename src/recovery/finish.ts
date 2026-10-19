// 恢复里**唯一的一笔写**：显式收尾（R2 · D8 B 的收尾那一半）。
//
// 判据只有一条：**能证明已经全写回、而且验收已经过了**，才把账上缺的收尾事实补上——
//   · 全写回：`recoverOf` 判 `full`（盘上与 ref 都已经等于发布目标）；
//   · 验收已过：`merge/publish` 这条事实只在验收返回 ok 之后才写（`merge/accept.ts` 的
//     `publish` 两个调用点都在 `report.ok` 之后），所以它存在就是"验过"的证据。
//
// 补的是 `merge/publish done`（若还停在 begin）与 `merge/accept`。**不重放写**：不碰工作树、
// 不挪 ref、不重新验收——它落的是已经发生的事实，不是再做一遍。
//
// `state.ts` 保持只读；这一份是那一族里单独的一笔写，入口只在 `recover --finish` 上。
import type { Log, LogEvent } from '../log/events.ts'
import type { Truth } from '../truth/contract.ts'
import type { AssertionResult, RoundId, WriterId } from '../terms.ts'
import { eventsOf, openPublishOf, recoverOf } from './state.ts'
import type { RecoveryReport } from './state.ts'

/** 收尾做不成：入口把它翻成退出码 1，并把"为什么"与"下一步"原样给人。 */
export class RecoverFinishRefused extends Error {}

export interface FinishDeps {
  readonly truth: Truth
  readonly realRoot: string
  readonly log: Log
}

/**
 * 这一轮发出去的契约里的断言，**按发布事实记为通过**。
 *
 * 发布事实（`merge/publish begin`）在验收 ok 之后才写，所以这里记 `pass` 不是猜——真正跑过的
 * 判决已经在验收那一刻发生过，只是没有随 accept 一起落下来。
 *
 * 解冲突那一份契约**不在 `contract/issue` 里**（它是"折到这一步才知道"的那一份，复制第一份的
 * 断言）：这里不重造它，所以这一轮若解过冲突，清单会比正常路径少那几条。验收是否通过由发布
 * 事实证明，不由这份清单证明；清单只用来让人看见"验过哪些断言"。
 *
 * 读不出一份契约正文、或一条断言都拼不出来时返回 `null`——那时不落 accept，宁可让人手工收尾。
 */
function passedAssertionsOf(events: readonly LogEvent[], round: RoundId): AssertionResult[] | null {
  const out: AssertionResult[] = []
  let contracts = 0
  for (const e of events) {
    if (e.t !== 'contract/issue' || e.round !== round) continue
    contracts += 1
    let body: unknown
    try {
      body = JSON.parse(e.body)
    } catch {
      return null
    }
    if (body === null || typeof body !== 'object') return null
    const c = body as { kind?: unknown; assertions?: unknown }
    if (c.kind === 'investigate') continue
    if (!Array.isArray(c.assertions)) return null
    for (const a of c.assertions) {
      if (a === null || typeof a !== 'object') return null
      const name = (a as { name?: unknown }).name
      if (typeof name !== 'string' || name === '') return null
      out.push({ assertion: name, verdict: 'pass' })
    }
  }
  // 验收 ok 的前提是至少有一条断言真的通过（`reportOf` 的 `pass > 0`）：一条都拼不出来就是
  // 这份账与那条事实对不上，不拿一个空清单去补 accept。
  return contracts > 0 && out.length > 0 ? out : null
}

/**
 * `fugue recover --finish`：把"已全写回、验收已过"的那一次发布收尾。
 *
 * 只在 `full` 那一态落账；其余四态一律拒，并把人指回 `fugue recover` 的读数与下一步。
 * 返回收尾之后给人看的那一份报告（`say` / `next` 换成收尾事实）。
 */
export async function finishOf(deps: FinishDeps): Promise<RecoveryReport> {
  const events = await eventsOf(deps.log)
  const open = openPublishOf(events)
  if (open === null) throw new RecoverFinishRefused('没有未收尾的发布，不需要收尾。')
  if (open.accepted) {
    throw new RecoverFinishRefused(`${open.round} 的这次发布已经收尾（merge/accept 已在账上），不需要再落一次。`)
  }
  const report = await recoverOf(deps)
  if (report === null) throw new RecoverFinishRefused('账上那条发布事实读不出一份报告，先不要收尾。')
  if (report.state !== 'full') {
    throw new RecoverFinishRefused(
      `现在不是全写回（${report.state}），收尾只落"盘上与 ref 都已经到发布目标"那一档。先看清事实：fugue recover`,
    )
  }
  const assertions = passedAssertionsOf(events, open.round)
  if (assertions === null) {
    throw new RecoverFinishRefused(
      `读不出 ${open.round} 这一轮发出去的断言清单，不补 merge/accept。先手工核对：fugue status --once · git show --stat ${open.commit}`,
    )
  }

  // 次序与正常发布那一段一致：先 done、再 accept。中途断掉的话，下一次 --finish 仍能接着补。
  if (open.phase === 'begin') {
    await deps.log.append('round' as WriterId, {
      t: 'merge/publish',
      round: open.round,
      commit: open.commit,
      phase: 'done',
      ...(open.ref === undefined ? {} : { ref: open.ref }),
      ...(open.expected === undefined ? {} : { expected: open.expected }),
    })
  }
  await deps.log.append('round' as WriterId, { t: 'merge/accept', round: open.round, commit: open.commit, assertions })

  return {
    ...report,
    say:
      `全写回，收尾事实已落：merge/publish ${open.phase === 'begin' ? 'done（补的）' : 'done（原已在）'} + ` +
      `merge/accept（${assertions.length} 条断言按发布事实记为通过；没有重放写）。`,
    next: ['可以开下一轮：fugue round work', `看这一轮的结果：fugue status --once · git show --stat ${open.commit}`],
  }
}
