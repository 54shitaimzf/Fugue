// 发布事实的**纯函数**一层（B10 · D8 B）。从事件流里取“哪一次发布、走到哪一步、收尾没有”。
//
// 单独一份的理由：TUI 只经事件通道读账（`ui/console.ts` 的那条纪律），它要判“上一次发布
// 是否没收尾”时只需要这一份纯计算；把 `fs` / Git / 工作树那一套一并装进界面是最不该的。
// 命令面（`recovery/state.ts`）再从这里取同一份判断，不各写一遍“哪一条算发布”。
import type { LogEvent } from '../log/events.ts'
import type { CommitId, RefName, RoundId } from '../terms.ts'

/** 一次发布的账上事实。`accepted` 是「同一轮同一提交的 merge/accept 已经落过」。 */
export interface PublishFacts {
  readonly round: RoundId
  readonly commit: CommitId
  readonly phase: 'begin' | 'done'
  readonly ref?: RefName
  readonly expected?: CommitId
  readonly accepted: boolean
  /** 这一条发布事实在合并序里的位置（同一轮多条时选最新）。 */
  readonly at: number
}

/**
 * 从事件流里取发布事实。**纯函数**：CLI 与 TUI 读同一批事件时用的是同一份判断。
 *
 * 同一轮可以有多条 `merge/publish`（一次发布一条 begin/done）；`accepted` 由同一轮同一提交的
 * `merge/accept` 兑现。返回**每个轮次最后一条**发布事实，按出现次序排序。
 */
export function publishFactsOf(events: readonly LogEvent[]): readonly PublishFacts[] {
  const at = new Map<RoundId, { commit: CommitId; phase: 'begin' | 'done'; ref?: RefName; expected?: CommitId; seq: number }>()
  const accepted = new Set<string>()
  const intents = new Map<RoundId, CommitId>()
  events.forEach((e, i) => {
    if (e.t === 'round/intent') intents.set(e.round, e.base)
    if (e.t === 'merge/publish') {
      at.set(e.round, {
        commit: e.commit,
        phase: e.phase,
        ...(e.ref === undefined ? {} : { ref: e.ref }),
        expected: e.expected ?? intents.get(e.round),
        seq: i,
      })
    }
    if (e.t === 'merge/accept') accepted.add(`${e.round}\u0000${e.commit}`)
  })
  const out: PublishFacts[] = []
  for (const [round, p] of at) {
    const expected = p.expected ?? intents.get(round)
    out.push({
      round,
      commit: p.commit,
      phase: p.phase,
      ...(p.ref === undefined ? {} : { ref: p.ref }),
      ...(expected === undefined ? {} : { expected }),
      accepted: accepted.has(`${round}\u0000${p.commit}`),
      at: p.seq,
    })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** 最后一次**没有收尾**的发布（begin 之后没有 done，或 done 之后没有 accept）。 */
export function openPublishOf(events: readonly LogEvent[]): PublishFacts | null {
  const all = publishFactsOf(events)
  for (let i = all.length - 1; i >= 0; i--) {
    const p = all[i] as PublishFacts
    if (p.phase === 'begin' || !p.accepted) return p
  }
  return null
}
