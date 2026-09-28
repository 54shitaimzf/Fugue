// fugue 的视图组（读 · 写 · 检视 · 提交 · 分支 · 重放）——U4b 自 `cli/fugue.ts` 抽出，
// 内容逐字未动（出处：架构 § 9.6 那张表的前三行 · § 8.3 视图 · § 9.5 提交点 · S1 的验收
// 脚本 replay）。`run()` 里那九个 case 在这里合成一个入口 `viewCmd`；`commit` 的外壳
// （`-m` 校验 + `openCtx`）合进 `commitCmd`；其余函数原样。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BranchRefused, branchAt } from '../../branch.ts'
import { checkpoint } from '../../checkpoint.ts'
import { agentFor } from '../../identity.ts'
import type { Delta } from '../../delta.ts'
import type { TreeEntry } from '../../entries.ts'
import { mergedFace, openLog } from '../../log/log.ts'
import type { LogHandle } from '../../log/log.ts'
import type { Roots } from '../../roots/contract.ts'
import { createRoots } from '../../roots/roots.ts'
import type { CommitId, ViewRev, WriterId } from '../../terms.ts'
import { openTruth } from '../../truth/truth.ts'
import type { TruthHandle } from '../../truth/truth.ts'
import type { View } from '../../view/contract.ts'
import { applyEdit } from '../../view/edit.ts'
import { lowerFor } from '../../view/lower.ts'
import { readSnapshot, saveSnapshot, snapshotOf } from '../../view/snapshot.ts'
import { loadView } from '../../view/view.ts'
import type { Ctx } from '../shared.ts'
import { UsageError, emitJson, emitLine, fail, fence, openCtx, parseOctal, readStdin, usageFail, writerOf } from '../shared.ts'

/** `--json` 的 delta 形状。**字节不进去**——它可能是二进制，`JSON.stringify` 会把它摊成下标表。 */
function deltaJson(d: Delta): Record<string, unknown> {
  switch (d.kind) {
    case 'add':
    case 'modify':
      return { kind: d.kind, path: d.path, mode: d.mode, size: d.bytes.length }
    default:
      return { ...d }
  }
}

function deltaLine(d: Delta): string {
  switch (d.kind) {
    case 'add':
    case 'modify':
      return `${d.kind}\t${d.path}\t${d.bytes.length} 字节\t${d.mode.toString(8)}`
    case 'delete':
      return `delete\t${d.path}`
    case 'rename':
      return `rename\t${d.from}\t→ ${d.to}`
    case 'chmod':
      return `chmod\t${d.path}\t${d.mode.toString(8)}`
    case 'symlink':
      return `symlink\t${d.path}\t→ ${d.target}`
  }
}

/**
 * 视图上的九条命令（`read` · `list` · `stat` · `diff` · `revs` · `write` · `remove` ·
 * `rename` · `chmod`）——原先各是 `run()` 尾部 switch 的一个 case，逐字搬来。
 */
export async function viewCmd(
  cmd: string,
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const need = (n: number): boolean => args.length >= n && !args.slice(0, n).some((a) => a === '')

  switch (cmd) {
    case 'read': {
      if (!need(1)) return usageFail('read 需要 <path>')
      const ctx = await openCtx(root, flags)
      try {
        const fenced = fence(ctx.roots, args[0])
        if (!fenced.ok) return fail(fenced.message)
        const rel = fenced.rel
        const bytes = await ctx.view.read(rel)
        if (bytes === null) return fail(`read：${args[0]} 不是可读的路径（目录 · gitlink · 或者不存在）`)
        if (json) {
          const meta = await ctx.view.stat(rel)
          emitJson({ path: args[0], size: bytes.length, ...meta })
        } else {
          process.stdout.write(Buffer.from(bytes))
        }
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'list': {
      const ctx = await openCtx(root, flags)
      try {
        const fenced = fence(ctx.roots, args[0] ?? '')
        if (!fenced.ok) return fail(fenced.message)
        const rel = fenced.rel
        const rows = await ctx.view.list(rel)
        if (json) emitJson(rows)
        else for (const r of rows) emitLine(`${r.kind}\t${r.mode.toString(8)}\t${r.size}\t${r.name}`)
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'stat': {
      if (!need(1)) return usageFail('stat 需要 <path>')
      const ctx = await openCtx(root, flags)
      try {
        const fenced = fence(ctx.roots, args[0])
        if (!fenced.ok) return fail(fenced.message)
        const rel = fenced.rel
        const meta = await ctx.view.stat(rel)
        if (meta === null) return fail(`stat：${args[0]} 不存在`)
        if (json) emitJson({ path: args[0], ...meta })
        else emitLine(`${meta.kind}\t${meta.mode.toString(8)}\t${meta.size}\t${meta.id}`)
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'diff': {
      const sinceRaw = flags.get('since')
      let since: ViewRev | undefined
      if (typeof sinceRaw === 'string') {
        since = Number(sinceRaw)
        if (!Number.isInteger(since) || since < 0) return usageFail('--since 要一个非负整数修订号')
      }
      const ctx = await openCtx(root, flags, { history: true })
      try {
        const deltas = ctx.view.diff(since)
        if (json) emitJson(deltas.map(deltaJson))
        else for (const d of deltas) emitLine(deltaLine(d))
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'revs': {
      // 检视组的一条（§ 9.6）：输出就是 `View.revs` 这个字段（§ 8.3）。**不看历史**——
      // 修订点跟着状态走，快照带着它，所以从快照起的视图答得一样全，这也是
      // `replay --verify` 把 `revs` 列进比对项的原因。
      const ctx = await openCtx(root, flags)
      try {
        const revs = ctx.view.revs
        if (json) emitJson(revs)
        else for (const r of revs) emitLine(String(r))
        return 0
      } finally {
        await ctx.close()
      }
    }

    case 'write':
    case 'remove':
    case 'rename':
    case 'chmod': {
      // 参数先收齐（含"这几条路径能不能落地"那一步过围栏），**再开视图**：一条用法错的命令
      // 不该在磁盘上留下任何东西，而围栏要的只是落点，不必等日志与快照建起来——围栏拿的是
      // 一份无状态的 `Roots`，`openCtx` 收同一份（第四个数），所以那两处说的是同一个根。
      const roots = createRoots(resolve(root))
      const delta = await deltaFrom(roots, cmd, args, flags)
      if (typeof delta === 'string') return fail(delta)
      const ctx = await openCtx(root, flags, { write: true }, roots)
      try {
        const res = await applyEdit(
          { log: ctx.log, truth: ctx.truth, view: ctx.view, writer: ctx.writer },
          delta,
        )
        if (json) emitJson({ rev: res.rev, agent: ctx.writer })
        else emitLine(`${res.rev}\t${ctx.writer}`)
        // 「没有变化」不是失败（§ 8.3 的模式两档）：**stdout 的形状与别的写命令一样**——
        // 给的是视图此刻的 rev，它没有动；那句话去 stderr，报的是判过的那个现值。
        if (!res.changed && delta.kind === 'chmod') {
          process.stderr.write(`没有变化：${delta.path} 已经是 ${res.mode.toString(8)}\n`)
        }
        return 0
      } finally {
        await ctx.close()
      }
    }

    default:
      return usageFail(`未知命令：${cmd}`)
  }
}

async function commit(ctx: Ctx, msg: string, json: boolean): Promise<number> {
  // **条目来自视图的全量读出**（§ 8.3 的"先持久，后重建"）：U2 那个临时的日志折叠在
  // U3 落地时删除，调用点一行没改——`checkpoint` 收的本来就是条目与 rev。
  const entries: TreeEntry[] = await snapshotOf(ctx.view)
  const r = await checkpoint({
    log: ctx.log,
    truth: ctx.truth,
    writer: ctx.writer,
    entries,
    rev: ctx.view.rev,
    msg,
    // 视图铺在哪个提交上，这次提交就推在哪个提交之上（`checkpoint` 的 CAS 期望）。
    expectedOld: ctx.view.base,
  })
  // 提交点同时是快照点（§ 9.5 把提交点与检查点列在同一档）：那一行日志已经落了，把上层的
  // 折叠留在 `<root>/.fugue/snap/` 下。**写不成就当没写**——快照从不阻塞写入（§ 9.4）。
  await saveSnapshot(ctx.root, ctx.writer, ctx.view, r.seq)
  if (json) emitJson({ ...r, rev: ctx.view.rev })
  else emitLine(`${r.commit}\t${r.ref}\t${r.entries} 个条目`)
  return 0
}

/** `fugue commit -m <msg>`：外壳（`-m` 校验 + 开写档上下文）与 `commit` 那一步，原先是 `run()` 里的一个 case。 */
export async function commitCmd(root: string, flags: Map<string, string | true>, json: boolean): Promise<number> {
  const msg = flags.get('m')
  if (typeof msg !== 'string' || msg === '') return usageFail('commit 需要 -m <msg>')
  const ctx = await openCtx(root, flags, { sync: 'each', write: true })
  try {
    return await commit(ctx, msg, json)
  } finally {
    await ctx.close()
  }
}

/**
 * `fugue branch <base>`：把本 agent 的分支头定格在 <base> 上（§ 4 的"分出去" · § 9.6 的提交组）。
 *
 * **它不建视图、不读日志**：这个动作改的是 ref（真源那一侧），而"视图的底现在是哪个提交"是
 * 下一条命令加载时现读出来的。所以它和 `config` · `dispose` 一样，排在建视图的命令之前。
 *
 * 退出码：0 定好了（本来就指着它也算）· 1 做不成（<base> 不是一个提交 · 指着别处）· 2 用法错。
 */
export async function branchCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const base = args[0]
  if (base === undefined || base === '') return usageFail('branch 需要 <base>：一个提交')
  const abs = resolve(root)
  const writer = writerOf(flags)
  const truth = openTruth(abs)
  try {
    let commit: CommitId
    try {
      commit = await truth.resolve(base)
    } catch (err) {
      return fail(`branch：${base} 不是这个工作区里一个能用的提交\n  ${(err as Error).message}`)
    }
    const res = await branchAt(truth, writer, commit)
    if (json) emitJson({ agent: agentFor(writer), ref: res.ref, base: res.base, moved: res.moved })
    else {
      // 过程走 stderr（§ 9.8 的 stdout 纪律）：stdout 上那一行是这次的坐标，与 `commit` 一致。
      process.stderr.write(
        res.moved
          ? `${res.ref} 定格在 ${res.base}\n`
          : `${res.ref} 本来就指着 ${res.base}——幂等，什么都没动\n`,
      )
      emitLine(`${res.base}\t${res.ref}`)
    }
    return 0
  } catch (err) {
    if (err instanceof BranchRefused) return fail(err.why)
    throw err
  } finally {
    await truth.close()
  }
}

/**
 * `fugue replay [--to <rev>]` / `fugue replay --verify`（§ 9.6 的重放组）。
 *
 * **只读。** 它同时是 S1 的验收脚本与崩溃恢复实验的探针：一个写者被杀之后，第一条要跑的
 * 就是它——所以它不能在坏现场上再写什么。
 */
export async function replay(
  root: string,
  flags: Map<string, string | true>,
  json: boolean,
): Promise<number> {
  const toRaw = flags.get('to')
  let upToRev: ViewRev | undefined
  if (typeof toRaw === 'string') {
    const n = Number(toRaw)
    if (!Number.isInteger(n) || n < 0) return usageFail('--to 要一个非负整数修订号')
    upToRev = n
  }
  const only = flags.get('agent')
  const log = openLog(root)
  let truth: TruthHandle | null = null
  const t0 = Date.now()
  try {
    truth = openTruth(root)
    if (flags.has('verify')) {
      const writers = typeof only === 'string' ? [only as WriterId] : await log.writers()
      if (writers.length === 0) {
        if (json) emitJson({ ok: true, agents: [] })
        else emitLine('还没有任何 writer 写过日志：没有可重放的视图')
        return 0
      }
      return await verify(root, log, truth, writers, upToRev, json)
    }
    const writer = writerOf(flags)
    const lower = await lowerFor(truth, writer)
    const snap = await readSnapshot(root, writer, upToRev === undefined ? {} : { upToRev })
    const view = await loadView(
      log,
      writer,
      snap === null ? { lower, upToRev } : { lower, upToRev, snap },
    )
    const entries = await snapshotOf(view)
    const ms = Date.now() - t0
    const from =
      snap === null ? { kind: 'genesis' } : { kind: 'snapshot', seq: snap.seq, rev: snap.state.rev }
    if (json) emitJson({ agent: writer, rev: view.rev, base: view.base, from, entries, ms })
    else {
      const where =
        snap === null ? '从 0 全量重放' : `从快照 seq ${snap.seq}（rev ${snap.state.rev}）起`
      emitLine(`${view.rev}\t${view.base ?? '(没有提交)'}\t${entries.length} 个条目\t${where}`)
    }
    return 0
  } finally {
    await log.close()
    if (truth !== null) await truth.close()
  }
}

/** 条目表压成一行可比对的字：走目录的顺序不该参与判定。 */
function entryKey(rows: TreeEntry[]): string {
  return rows
    .map((r) => `${r.mode.toString(8)} ${r.id} ${r.name}`)
    .sort()
    .join('\n')
}

/** 变更压成一行可比对的字。**`add` 与 `modify` 要分开**——它由日志前缀决定，不是细节。 */
function deltaKey(d: Delta): string {
  switch (d.kind) {
    case 'add':
    case 'modify':
      return `${d.kind} ${d.path} ${d.mode.toString(8)} ${d.bytes.length} ${createHash('sha1').update(d.bytes).digest('hex')}`
    case 'symlink':
      return `symlink ${d.path} → ${d.target}`
    case 'delete':
      return `delete ${d.path}`
    case 'rename':
      return `rename ${d.from} → ${d.to}`
    case 'chmod':
      return `chmod ${d.path} ${d.mode.toString(8)}`
  }
}

/**
 * 两份视图是不是同一份：`rev` · `base` · `revs` · 全量读出 · 变更序列（从 `since` 起）。
 *
 * `since` 是给从快照起的视图留的：它答不了比快照更早的变更序列，所以两边都从快照那个
 * 修订点比起——**这正是"快照换掉的是历史，不是状态"的可测形式**。
 */
function sameView(
  a: View,
  aRows: TreeEntry[],
  b: View,
  bRows: TreeEntry[],
  since: ViewRev,
): boolean {
  if (a.rev !== b.rev || a.base !== b.base) return false
  if (JSON.stringify(a.revs) !== JSON.stringify(b.revs)) return false
  if (entryKey(aRows) !== entryKey(bRows)) return false
  const x = a.diff(since).map(deltaKey)
  const y = b.diff(since).map(deltaKey)
  return x.length === y.length && x.every((k, i) => k === y[i])
}

/**
 * `--verify`：逐 agent 重建视图，比对 `rev` · 全量读出 · `diff()` · `revs`（§ 9.6）。
 *
 * **两条独立的重建路径对着同一条日志，各走一遍**：
 *
 *   1. 按 writer 读（`readByWriter`） 与 按交错全序读再筛（`mergedFace`）
 *   2. 从 0 全量重放 与 从快照起再重放尾部
 *
 * 第 2 条就是"快照是纯加速项"的验收——它把快照删掉只是慢，不会不一样；第 1 条是"重建结果
 * 只由自己的操作决定"的验收——交错序里夹着别人的事件，读出来的还是自己那份。
 */
async function verify(
  root: string,
  log: LogHandle,
  truth: TruthHandle,
  writers: WriterId[],
  upToRev: ViewRev | undefined,
  json: boolean,
): Promise<number> {
  const reports: Record<string, unknown>[] = []
  let bad = 0
  for (const writer of writers) {
    const checks: { what: string; ok: boolean; detail?: string }[] = []
    let rev = 0
    let count = 0
    let snapInfo: Record<string, unknown> | null = null
    try {
      const lower = await lowerFor(truth, writer)
      const full = await loadView(log, writer, { lower, upToRev })
      const want = await snapshotOf(full)
      rev = full.rev
      count = want.length

      const inter = await loadView(mergedFace(log, writer), writer, { lower, upToRev })
      checks.push({
        what: '交错读 == 按 writer 读',
        ok: sameView(full, want, inter, await snapshotOf(inter), 0),
      })

      const snap = await readSnapshot(root, writer, upToRev === undefined ? {} : { upToRev })
      if (snap === null) {
        checks.push({
          what: '从快照起 == 从 0 起',
          ok: true,
          detail: '没有快照：这一路只跑了全量重放',
        })
      } else {
        snapInfo = { seq: snap.seq, rev: snap.state.rev }
        const fast = await loadView(log, writer, { lower, upToRev, snap })
        checks.push({
          what: `从快照 seq ${snap.seq}（rev ${snap.state.rev}）起 == 从 0 起`,
          ok: sameView(full, want, fast, await snapshotOf(fast), snap.state.rev),
        })
      }
    } catch (err) {
      checks.push({
        what: '重建',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      })
    }
    const ok = checks.every((c) => c.ok)
    if (!ok) bad++
    reports.push({ writer, ok, rev, entries: count, snapshot: snapInfo, checks })
    if (!json) {
      emitLine(`${ok ? 'ok  ' : 'FAIL'}\t${writer}\trev ${rev}\t${count} 个条目`)
      for (const c of checks) {
        const mark = c.ok ? '·' : '×'
        const detail = c.detail === undefined ? '' : `（${c.detail}）`
        if (!c.ok || c.detail !== undefined) emitLine(`      ${mark} ${c.what}${detail}`)
      }
    }
  }
  if (json) emitJson({ ok: bad === 0, agents: reports })
  else if (bad === 0) emitLine(`${writers.length} 个视图全部一致`)
  if (bad !== 0) return fail(`${bad} 个视图没有通过重放比对`)
  return 0
}

/**
 * 把命令行收成一个 delta。**这一步不开视图、不读日志**——参数不对的命令不该在磁盘上留下
 * 任何东西，而"先建再检查"会让一条用法错的命令也留下一个日志目录。
 *
 * **每一条路径都过围栏**（`fence`）：`write ../x` 这一类输入在这里就变成一条带指路
 * 的拒绝（退出码 1），而不是等视图那一步的路径检查来 `throw`——那是两个不同的话（一个是
 * "这条请求不成立"，一个是"这条请求做不成"），拒绝时该说的是后一句。基准目录是工作区的根。
 *
 * 四条写命令共用它；与模型侧共用的是更下面那次 `applyEdit`——这里只做参数那一半。
 */
async function deltaFrom(
  roots: Roots,
  cmd: string,
  args: string[],
  flags: Map<string, string | true>,
): Promise<Delta | string> {
  switch (cmd) {
    case 'write': {
      if (args[0] === undefined) throw new UsageError('write 需要 <path>')
      const fenced = fence(roots, args[0])
      if (!fenced.ok) return fenced.message
      const p = fenced.rel
      const from = flags.get('from')
      let bytes: Uint8Array
      if (typeof from === 'string') bytes = readFileSync(from)
      else if (flags.has('stdin')) bytes = await readStdin()
      else throw new UsageError('write 需要 --from <file> 或 --stdin')
      // 默认 644；要可执行就再敲一条 chmod——两条命令各说一件事，不从写里猜。
      return { kind: 'add', path: p, bytes, mode: 0o100644 }
    }
    case 'remove': {
      if (args[0] === undefined) throw new UsageError('remove 需要 <path>')
      const fenced = fence(roots, args[0])
      if (!fenced.ok) return fenced.message
      const p = fenced.rel
      return { kind: 'delete', path: p }
    }
    case 'rename': {
      const [rawFrom, rawTo] = args
      if (rawFrom === undefined || rawTo === undefined) throw new UsageError('rename 需要 <from> <to>')
      const a = fence(roots, rawFrom)
      if (!a.ok) return a.message
      const b = fence(roots, rawTo)
      if (!b.ok) return b.message
      const from = a.rel
      const to = b.rel
      return { kind: 'rename', from, to }
    }
    default: {
      const p = args[0]
      const mode = args[1]
      if (p === undefined || mode === undefined) throw new UsageError('chmod 需要 <path> <mode>')
      const fenced = fence(roots, p)
      if (!fenced.ok) return fenced.message
      return { kind: 'chmod', path: fenced.rel, mode: parseOctal(mode) }
    }
  }
}
