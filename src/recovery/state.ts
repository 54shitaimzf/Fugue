// 恢复（recover）的共同判断（D8 B · B10 的恢复那一半）。
//
// **五种状态，一个判据：账上的发布事实 + 实际 ref + 盘上内容。**
//
//   · 未写回（not-written）：文件还是发布前那一份，主线还在钉住的旧值上；
//   · 全写回（full）      ：文件与主线都已经到目标提交；
//   · 部分写回（partial） ：两者只到了一边，或文件只写了一部分；
//   · 冲突（conflict）    ：盘上有既不是发布前、也不是发布目标的内容（用户的改动会被覆盖）；
//   · 未验证（unverified）：事实不够（目标提交读不出 · ref 读不出 · 这次中断早于发布记录），
//                          或者 ref 被第三个人挪到了别处。
//
// **它只读。** 不写盘、不挪 ref、不重放写——"继续"是人的决定，命令面只把事实与下一步说清。
// 这一层不认识的失败一律落到 `unverified`（并说清哪一样读不出来），不猜成"没写回"。
//
// **同一真源**：事实来自 M0 日志（`merge/publish` 两条 + `round/intent` 的底 + `round/state`
// 的链），状态由 Git 对象与真实工作树核对。派生物可以重建——这里每次都重新核对。
import type { Log, LogEvent } from '../log/events.ts'
import type { Truth } from '../truth/contract.ts'
import type { CommitId, RefName, RelPath, RoundId, RoundState } from '../terms.ts'
import { gitModeOf } from '../delta.ts'
import { WORKSPACE_STATE, scanTree } from '../materialize/diffstat.ts'
import { leavesOf } from '../merge/drift.ts'

/** 五态。**名字与路线图 D8 B 同一个词表**。 */
export type RecoveryState = 'not-written' | 'full' | 'partial' | 'conflict' | 'unverified'

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
 * 从事件流里取发布事实。**纯函数**：CLI 与 TUI 读同一批事件时用的是同一份判断，
 * 不各写一遍"哪一条算发布"。
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

/** 读账取那一批事件（恢复命令与 `round work` 的守卫都用它）。 */
export async function eventsOf(log: Log): Promise<LogEvent[]> {
  const out: LogEvent[] = []
  for await (const { e } of log.readMerged()) out.push(e)
  return out
}

/** 最后一次 `round/state`（按轮次）。**只用来判"这次中断早于发布记录"那一档**。 */
function lastStateOf(events: readonly LogEvent[]): { round: RoundId; state: RoundState } | null {
  let last: { round: RoundId; state: RoundState } | null = null
  for (const e of events) if (e.t === 'round/state') last = { round: e.round, state: e.to }
  return last
}

function lastAcceptOf(events: readonly LogEvent[]): { round: RoundId; commit: CommitId } | null {
  let last: { round: RoundId; commit: CommitId } | null = null
  for (const e of events) if (e.t === 'merge/accept') last = { round: e.round, commit: e.commit }
  return last
}

export interface RecoveryDeps {
  readonly truth: Truth
  readonly realRoot: string
  readonly log: Log
}

/** 一份恢复报告：**人读的结论 + 机器读的事实**。`state` 是那五个词之一。 */
export interface RecoveryReport {
  readonly state: RecoveryState
  readonly round: RoundId | null
  readonly commit: CommitId | null
  readonly expected: CommitId | null
  readonly ref: RefName | null
  readonly refNow: CommitId | null
  /** 一句话：现在是什么状态。 */
  readonly say: string
  /** 判定用到的路径（部分写回：已经落的；冲突：用户改的那些）。 */
  readonly paths: readonly RelPath[]
  /** **下一步的原文**：终端可达、能实际照做。 */
  readonly next: readonly string[]
}

const REF = 'refs/heads/main' as RefName

interface Leaves {
  readonly mode: number
  readonly hash: string
}

function leavesOfDisk(root: string): Map<RelPath, Leaves> {
  const st = scanTree(root, { skip: WORKSPACE_STATE })
  const out = new Map<RelPath, Leaves>()
  for (const l of st.leaves) out.set(l.path, { mode: gitModeOf(Number(l.mode)), hash: l.hash })
  return out
}

function sameLeaves(a: ReadonlyMap<RelPath, Leaves>, b: ReadonlyMap<RelPath, Leaves>): boolean {
  if (a.size !== b.size) return false
  for (const [p, x] of a) {
    const y = b.get(p)
    if (y === undefined || y.hash !== x.hash || y.mode !== x.mode) return false
  }
  return true
}

function changedPaths(a: ReadonlyMap<RelPath, Leaves>, b: ReadonlyMap<RelPath, Leaves>): RelPath[] {
  const out: RelPath[] = []
  const all = new Set<RelPath>([...a.keys(), ...b.keys()])
  for (const p of all) {
    const x = a.get(p)
    const y = b.get(p)
    if (x === undefined || y === undefined || x.hash !== y.hash || x.mode !== y.mode) out.push(p)
  }
  return out.sort()
}

async function treeLeaves(truth: Truth, commit: CommitId | null): Promise<Map<RelPath, Leaves> | null> {
  if (commit === null) return null
  try {
    const t = await leavesOf(truth, commit)
    return new Map(t.leaves)
  } catch {
    return null
  }
}

/**
 * 核对一次中断的发布。**返回 `null` = 没有需要恢复的发布**（最近一轮是正常收尾的）。
 *
 * 不把读不出来的东西猜成"没写回"：目标树读不出、ref 读不出、旧值不知道，都落 `unverified`。
 */
export async function recoverOf(deps: RecoveryDeps): Promise<RecoveryReport | null> {
  const events = await eventsOf(deps.log)
  const open = openPublishOf(events)
  if (open === null) {
    // **没有发布记录也可能是一次中断**：验收到一半被杀时，账停在 Verifying/Committed，
    // 而文件一个字节都没动。它判不出"目标提交是哪一个"，如实报未验证，不报成功。
    const last = lastStateOf(events)
    const accept = lastAcceptOf(events)
    if (
      last !== null &&
      (last.state === 'Merging' || last.state === 'Verifying' || last.state === 'Committed' || last.state === 'Rebuilding') &&
      (accept === null || accept.round !== last.round)
    ) {
      return {
        state: 'unverified',
        round: last.round,
        commit: null,
        expected: null,
        ref: null,
        refNow: null,
        say: `上一轮（${last.round}）停在 ${last.state}：这一趟没有留下发布记录，判不出写回到哪一步。`,
        paths: [],
        next: [
          '先备份工作树：cp -a . ../fugue-backup（或者在确认干净后 git stash）',
          '再看实际状态：git status · git log -1 --oneline',
          '确认之前不要重跑 round work——它可能把已经产生的结果再做一遍',
        ],
      }
    }
    return null
  }

  const ref = open.ref ?? REF
  let refNow: CommitId | null = null
  let refError: string | null = null
  try {
    refNow = await deps.truth.resolve(ref)
  } catch (err) {
    refError = (err as Error).message
  }
  const target = await treeLeaves(deps.truth, open.commit)
  const base = await treeLeaves(deps.truth, open.expected ?? null)
  let disk: Map<RelPath, Leaves>
  try {
    disk = leavesOfDisk(deps.realRoot)
  } catch (err) {
    return {
      state: 'unverified',
      round: open.round,
      commit: open.commit,
      expected: open.expected ?? null,
      ref,
      refNow,
      say: `读不出真实工作树：${(err as Error).message}`,
      paths: [],
      next: ['先确认工作树还在、有读权限，再运行 fugue recover'],
    }
  }

  if (target === null) {
    return {
      state: 'unverified',
      round: open.round,
      commit: open.commit,
      expected: open.expected ?? null,
      ref,
      refNow,
      say: `发布目标 ${open.commit} 读不出来（对象不在 · 仓库读不动），判不了写回到哪一步。`,
      paths: [],
      next: ['先确认这个工作区的 Git 对象库完好：git fsck', '确认之前不要重跑 round work'],
    }
  }
  if (refError !== null) {
    return {
      state: 'unverified',
      round: open.round,
      commit: open.commit,
      expected: open.expected ?? null,
      ref,
      refNow: null,
      say: `读不出 ${ref}：${refError}`,
      paths: [],
      next: [`先确认 ${ref} 还在：git show-ref ${ref}`, '确认之前不要重跑 round work'],
    }
  }

  const diskIsTarget = sameLeaves(disk, target)
  const diskIsBase = base !== null && sameLeaves(disk, base)
  const refIsTarget = refNow === open.commit
  const refIsExpected = open.expected === undefined ? null : refNow === open.expected

  // **用户的改动**：盘上既不是发布前、也不是发布目标。它在任何一态都要单独报——那是唯一
  // 一份"推进不能盖掉"的内容。
  const userChanged: RelPath[] = []
  if (base !== null) {
    const seen = new Set<RelPath>()
    for (const [p, l] of disk) {
      const b = base.get(p)
      const t = target.get(p)
      const sameB = b !== undefined && b.hash === l.hash && b.mode === l.mode
      const sameT = t !== undefined && t.hash === l.hash && t.mode === l.mode
      if (!sameB && !sameT) {
        userChanged.push(p)
        seen.add(p)
      }
    }
    // 盘上被删掉、而发布前与目标都还留着的路径：也是用户的删除，不能当"没写回"。
    for (const p of base.keys()) {
      if (!disk.has(p) && target.has(p) && !seen.has(p)) userChanged.push(p)
    }
  }
  userChanged.sort()

  if (refNow !== open.commit && open.expected !== undefined && refNow !== open.expected) {
    return {
      state: 'conflict',
      round: open.round,
      commit: open.commit,
      expected: open.expected,
      ref,
      refNow,
      say: `${ref} 现在指着 ${refNow}——既不是发布前（${open.expected}），也不是发布目标（${open.commit}）：别人在中断之后动过主线。`,
      paths: userChanged,
      next: [
        `先看主线走到了哪：git log --oneline ${open.expected}..${refNow}`,
        '确认之前不要重跑 round work；要保留这次发布的结果，先把它对应的提交找出来再决定怎么接',
      ],
    }
  }
  if (userChanged.length > 0) {
    return {
      state: 'conflict',
      round: open.round,
      commit: open.commit,
      expected: open.expected ?? null,
      ref,
      refNow,
      say:
        `发布只走到一半，而 ${userChanged.length} 条路径上是中断之后的新内容（既不是发布前，也不是发布目标）：\n  ` +
        userChanged.join('\n  '),
      paths: userChanged,
      next: [
        '先看这些路径上是什么：git diff -- <path>',
        '要保住你的改动：先把它们提交或挪走；要放弃：git checkout ' + (open.expected ?? 'HEAD') + ' -- <path>',
        '处理完再运行 fugue recover 复核，别直接重跑 round work',
      ],
    }
  }
  if (diskIsTarget && refIsTarget) {
    return {
      state: 'full',
      round: open.round,
      commit: open.commit,
      expected: open.expected ?? null,
      ref,
      refNow,
      say: `全写回：工作树与 ${ref} 都已经是发布目标 ${open.commit}。`,
      paths: [],
      next:
        open.accepted
          ? ['没有需要恢复的写；看进展：fugue status --once']
          : [
              '接受事件在中断前没有落下（文件与主线已经是对的，不需要重放写）',
              '查看这一轮的结果：fugue status --once · git show --stat ' + open.commit,
            ],
    }
  }
  if (diskIsBase && refIsExpected === true) {
    return {
      state: 'not-written',
      round: open.round,
      commit: open.commit,
      expected: open.expected ?? null,
      ref,
      refNow,
      say: `未写回：工作树还是发布前那一份，${ref} 还在 ${open.expected}。`,
      paths: [],
      next: ['可以重试这一轮：fugue round work', '重试之前先看一眼上一轮停在哪儿：fugue status --once'],
    }
  }
  // 剩下的都算部分写回：至少有一边已经动了，但不是全写回。把"已经落了哪些"报出来
  // （相对发布前的那一份），人据此判断要不要手工收尾。
  const landed = base === null ? [] : changedPaths(base, disk)
  const refNote =
    refIsTarget ? `主线已经到 ${open.commit}` : refIsExpected === true ? `主线还在 ${open.expected}` : `主线在 ${refNow}`
  return {
    state: 'partial',
    round: open.round,
    commit: open.commit,
    expected: open.expected ?? null,
    ref,
    refNow,
    say:
      `部分写回：${refNote}；工作树${diskIsTarget ? '已经是发布目标' : diskIsBase ? '还是发布前那一份' : '只落了一部分'}。` +
      (landed.length === 0 ? '' : `\n  已经变的路径（${landed.length}）：\n  ${landed.join('\n  ')}`),
    paths: landed,
    next: [
      '先看差异：git status · git diff',
      `要把这次发布做完：fugue round work（它会重新验收；不要手工改 ref 来"补"）`,
      `要回到发布前：git checkout ${open.expected ?? 'HEAD'} -- <path>（只回列出的那几条，别整树回退）`,
    ],
  }
}
