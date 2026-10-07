// 视图组的**值层**：`read` · `list` · `stat` · `diff` · `revs` · `write` · `remove`
// · `rename` · `chmod` · `commit` · `branch` 十一条。出处：架构 § 9.6 那张表的前三行 + 「命令本身
// 是一份值层，CLI 是它的第一个壳」那一段。
//
// **挪的是渲染，不是行为。** 每一条把原 `src/cli/cmd/view.ts` 里那一支的两条脸**原样**搬过来：
// `--json` 那一面还是 `JSON.stringify(...)`，人读那一面还是那几行字（制表符 · 字节数 · 八进制
// 模式 · 过程走 stderr）。黄金帧（`test/golden/frames/`）锁的正是这两个的字节——搬错了当场红。
//
// **语义不在这里**：一次变更的顺序与校验住在 `src/view/edit.ts`，提交住在 `src/checkpoint.ts`，
// 分支头住在 `src/branch.ts`——这一份只是它们的值层入口。
import { resolve } from 'node:path'
import { BranchRefused, branchAt } from '../branch.ts'
import { checkpoint } from '../checkpoint.ts'
import type { Delta } from '../delta.ts'
import type { TreeEntry } from '../entries.ts'
import { agentFor, refFor } from '../identity.ts'
import type { CommitId, ViewRev } from '../terms.ts'
import { openTruth } from '../truth/truth.ts'
import { applyEdit } from '../view/edit.ts'
import { saveSnapshot, snapshotOf } from '../view/snapshot.ts'
import type { Roots } from '../roots/contract.ts'
import { createRoots } from '../roots/roots.ts'
import { deltaFrom, deltaLine, deltaJson } from '../cli/cmd/view.ts'
import { UsageError as CliUsageError, fence, openCtx, writerOf } from '../cli/shared.ts'
import type { Ctx } from '../cli/shared.ts'
import { CommandError, UsageError, ok, unit } from './types.ts'
import type { ValueArgs, ValueResult } from './types.ts'

/** 一条命令要几段位置参数（与原先那几句 `need(1)` 同一条判据：少一个或者空串都算没给）。 */
function need(args: readonly string[], n: number): boolean {
  return args.length >= n && !args.slice(0, n).some((a) => a === '')
}

/**
 * `openCtx` 抛的用法错要**原样**落进值层那一档（退出码 2）：视图那一层的路径检查与围栏的话
 * 都是这一族，壳按类分档。
 */
async function withCtx<T>(
  a: ValueArgs,
  opts: { write?: boolean; history?: boolean },
  fn: (ctx: Ctx) => Promise<T>,
): Promise<T> {
  const extra =
    opts.write === true ? { write: true } : opts.history === true ? { history: true } : {}
  let ctx: Ctx
  try {
    ctx = await openCtx(a.root, a.flags, extra)
  } catch (err) {
    if (err instanceof CliUsageError) throw new UsageError(err.message)
    throw err
  }
  try {
    return await fn(ctx)
  } finally {
    await ctx.close()
  }
}

/** `read <path>`：人读那一面是**字节**，`--json` 那一面是元数据（§ 9.11「字节走带外」）。 */
export async function readValue(a: ValueArgs): Promise<ValueResult> {
  if (!need(a.args, 1)) throw new UsageError('read 需要 <path>')
  const raw = a.args[0]
  return await withCtx(a, {}, async (ctx) => {
    const fenced = fence(ctx.roots, raw)
    if (!fenced.ok) throw new CommandError(fenced.message)
    const bytes = await ctx.view.read(fenced.rel)
    if (bytes === null) {
      throw new CommandError(`read：${raw} 不是可读的路径（目录 · gitlink · 或者不存在）`)
    }
    const meta = await ctx.view.stat(fenced.rel)
    const value = { path: raw, size: bytes.length, ...meta }
    return ok({ value, faces: { json: JSON.stringify(value), human: '' }, bytes })
  })
}

/** `list [dir]`：`--json` 那一面就是那一份行数组；人读那一面一行一条。 */
export async function listValue(a: ValueArgs): Promise<ValueResult> {
  const raw = a.args[0] ?? ''
  return await withCtx(a, {}, async (ctx) => {
    const fenced = fence(ctx.roots, raw)
    if (!fenced.ok) throw new CommandError(fenced.message)
    const rows = await ctx.view.list(fenced.rel)
    return ok(unit(rows, rows.map((r) => `${r.kind}\t${r.mode.toString(8)}\t${r.size}\t${r.name}`)))
  })
}

/** `stat <path>`。 */
export async function statValue(a: ValueArgs): Promise<ValueResult> {
  if (!need(a.args, 1)) throw new UsageError('stat 需要 <path>')
  const raw = a.args[0]
  return await withCtx(a, {}, async (ctx) => {
    const fenced = fence(ctx.roots, raw)
    if (!fenced.ok) throw new CommandError(fenced.message)
    const meta = await ctx.view.stat(fenced.rel)
    if (meta === null) throw new CommandError(`stat：${raw} 不存在`)
    return ok(unit({ path: raw, ...meta }, `${meta.kind}\t${meta.mode.toString(8)}\t${meta.size}\t${meta.id}`))
  })
}

/** `diff [--since <rev>]`：**看历史，不看快照**（快照换掉的正是历史）。 */
export async function diffValue(a: ValueArgs): Promise<ValueResult> {
  const sinceRaw = a.flags.get('since')
  let since: ViewRev | undefined
  if (typeof sinceRaw === 'string') {
    since = Number(sinceRaw) as ViewRev
    if (!Number.isInteger(since) || since < 0) throw new UsageError('--since 要一个非负整数修订号')
  }
  return await withCtx(a, { history: true }, async (ctx) => {
    const deltas = ctx.view.diff(since)
    return ok(unit(deltas.map(deltaJson), deltas.map(deltaLine)))
  })
}

/** `revs`：输出就是 `View.revs` 这个字段（§ 8.3）。**不看历史**——快照带着它。 */
export async function revsValue(a: ValueArgs): Promise<ValueResult> {
  return await withCtx(a, {}, async (ctx) => {
    const revs = ctx.view.revs
    return ok(unit(revs, revs.map(String)))
  })
}

/** 写组共用的一步：参数先收齐（含过围栏），**再开视图**——用法错的命令不该在盘上留下东西。 */
async function applyWrite(a: ValueArgs, cmd: string): Promise<ValueResult> {
  const roots: Roots = createRoots(resolve(a.root))
  let delta: Delta
  try {
    const got = await deltaFrom(roots, cmd, [...a.args], a.flags)
    if (typeof got === 'string') throw new CommandError(got)
    delta = got
  } catch (err) {
    if (err instanceof CliUsageError) throw new UsageError(err.message)
    throw err
  }
  return await withCtx(a, { write: true }, async (ctx) => {
    const res = await applyEdit(
      { log: ctx.log, truth: ctx.truth, view: ctx.view, writer: ctx.writer },
      delta,
    )
    // 「没有变化」不是失败（§ 8.3 的模式两档）：stdout 的形状与别的写命令一样，那句话去 stderr。
    const notes =
      !res.changed && delta.kind === 'chmod'
        ? [`没有变化：${delta.path} 已经是 ${res.mode.toString(8)}`]
        : []
    return ok(unit({ rev: res.rev, agent: ctx.writer }, `${res.rev}\t${ctx.writer}`), notes)
  })
}

export async function writeValue(a: ValueArgs): Promise<ValueResult> {
  return await applyWrite(a, 'write')
}
export async function removeValue(a: ValueArgs): Promise<ValueResult> {
  return await applyWrite(a, 'remove')
}
export async function renameValue(a: ValueArgs): Promise<ValueResult> {
  return await applyWrite(a, 'rename')
}
export async function chmodValue(a: ValueArgs): Promise<ValueResult> {
  return await applyWrite(a, 'chmod')
}

/** `commit -m <msg>`：提交点同时是快照点（§ 9.5）——写完把折叠留在 `<root>/.fugue/snap/` 下。 */
export async function commitValue(a: ValueArgs): Promise<ValueResult> {
  const msg = a.flags.get('m')
  if (typeof msg !== 'string' || msg === '') throw new UsageError('commit 需要 -m <msg>')
  return await withCtx(a, { write: true }, async (ctx) => {
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
    await saveSnapshot(ctx.root, ctx.writer, ctx.view, r.seq)
    return ok(unit({ ...r, rev: ctx.view.rev }, `${r.commit}\t${r.ref}\t${r.entries} 个条目`))
  })
}

/**
 * `branch <base>`：把本 agent 的分支头定格在 <base> 上（§ 4 的"分出去"）。
 *
 * **它不建视图、不读日志、不取栅栏**：改的是 ref（真源那一侧），靠的是 ref 的 CAS。过程那两行
 * 走 stderr（§ 9.8 的 stdout 纪律）——值层把它们收进 `notes`。
 */
export async function branchValue(a: ValueArgs): Promise<ValueResult> {
  if (!need(a.args, 1)) throw new UsageError('branch 需要 <base>：一个提交')
  const base = a.args[0]
  const writer = writerOf(a.flags)
  const truth = openTruth(resolve(a.root))
  try {
    let commit: CommitId
    try {
      commit = await truth.resolve(base)
    } catch (err) {
      throw new CommandError(
        `branch：${base} 不是这个工作区里一个能用的提交\n  ${(err as Error).message}`,
      )
    }
    let res
    try {
      res = await branchAt(truth, writer, commit)
    } catch (err) {
      if (err instanceof BranchRefused) throw new CommandError(err.why)
      throw err
    }
    const value = { agent: agentFor(writer), ref: refFor(writer), base: res.base, moved: res.moved }
    const line = res.moved
      ? `${res.ref} 定格在 ${res.base}`
      : `${res.ref} 本来就指着 ${res.base}——幂等，什么都没动`
    return ok(unit(value, `${res.base}\t${res.ref}`), [line])
  } finally {
    await truth.close()
  }
}
