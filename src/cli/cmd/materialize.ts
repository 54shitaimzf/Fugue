// fugue 的物化组（diff-stat · fork · ensure · verify-mat · dispose）——U4c 自
// `cli/fugue.ts` 抽出，内容逐字未动（出处：架构 § 8.4/§ 8.5 的物化 · § 9.6 那张表的物化行 ·
// PLAN § 5.2 的 V1/V3/V5）。`landOnce` 与 `topDeclared` 是这一组与执行组共用的，
// 所以导出；`run` 那一条（执行组）在 `./execute.ts`。
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { forkBaseRefusal } from '../../branch.ts'
import { agentFor } from '../../identity.ts'
import { holdWriter } from '../../log/hold.ts'
import { openLog } from '../../log/log.ts'
import type { ChangeStatus, TreeStat } from '../../materialize/diffstat.ts'
import { TreeStatError, WORKSPACE_STATE, diffStat, loadTreeStat, scanTree, storeTreeStat } from '../../materialize/diffstat.ts'
import { DEFAULT_MATERIALIZE } from '../../materialize/contract.ts'
import { dispose } from '../../materialize/dispose.ts'
import { EnsureRefused, ensure } from '../../materialize/ensure.ts'
import type { EnsureResult } from '../../materialize/ensure.ts'
import { ForkRefused, fork } from '../../materialize/fork.ts'
import { LandError } from '../../materialize/land.ts'
import { LayError } from '../../materialize/lay.ts'
import { matState } from '../../materialize/manifest.ts'
import type { MatState } from '../../materialize/manifest.ts'
import { MountError } from '../../materialize/mount.ts'
import { VerifyRefused, verifyMat } from '../../materialize/verify.ts'
import { createRoots } from '../../roots/roots.ts'
import type { CommitId, ForkStrategy, RelPath, ViewRev } from '../../terms.ts'
import { openTruth } from '../../truth/truth.ts'
import type { TruthHandle } from '../../truth/truth.ts'
import { baseFor, lowerAt } from '../../view/lower.ts'
import type { Ctx } from '../shared.ts'
import { emitJson, emitLine, fail, openCtx, usageFail, writerOf } from '../shared.ts'

/** 策略名——给用法错与 `--json` 用；次序就是 § 8.5 策略表里的那三档（`reflink` 不在列）。 */
const STRATEGIES: readonly ForkStrategy[] = ['overlayfs', 'hardlink-ro', 'copy']

/**
 * `fugue diff-stat [<dir>] [--baseline <file>] [--save <file>]`（§ 9.6 的物化行 · § 9.8）。
 *
 * 它是**尺子**，不是物化的一步：只读——不动物化树、不动挂载态（§ 8.5 把 `diff-stat` 与
 * `verify-mat` 并列写成只读）。所以它既不建视图也不读日志：树在盘上什么样，它就报什么样。
 *
 * 不给 `<dir>` 时扫的是这个 agent 的合并树（§ 8.4 的 `merged`）。树还没铺就**拒绝并指路
 * `fork`**——不当成"空树，0 条变化"：那是尺子最坏的一种错法，量出来的 0 会被读成"树没变"。
 * 基线由 `--baseline` 给、`--save` 存，它自己不占持久化位置（PLAN § 5.2 的 V1 行）。
 *
 * **变化条数不进退出码**：退出 0 就是"扫完了、比完了"。§ 9.8 里 `1` 是"这件事没做成"，
 * 而"树变了"不是没做成。
 */
export function diffStatCmd(root: string, flags: Map<string, string | true>, args: string[], json: boolean): number {
  const where = args[0]
  let dir: string
  try {
    dir = where === undefined ? createRoots(resolve(root)).mergedRoot(agentFor(writerOf(flags))) : resolve(where)
  } catch (err) {
    return fail((err as Error).message)
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    if (where !== undefined) return fail(`不是一棵能扫的树：${dir}`)
    return fail(`物化的合并树还没铺：${dir}\n先 fugue fork <base> 铺一棵（§ 8.5）。`)
  }

  const baseFlag = flags.get('baseline')
  const saveFlag = flags.get('save')
  if (baseFlag === true || saveFlag === true) return usageFail('--baseline 与 --save 都要一个文件名')
  const baseFile = typeof baseFlag === 'string' ? resolve(baseFlag) : undefined
  const saveFile = typeof saveFlag === 'string' ? resolve(saveFlag) : undefined
  // **别把尺子放进树里**：基线自己也是一份新文件，留在被扫的树里，下一轮它会被报成
  // "多了一条"——量树的人亲手污染读数。拦住比事后解释便宜。
  for (const [what, file] of [
    ['--baseline', baseFile],
    ['--save', saveFile],
  ] as const) {
    if (file !== undefined && insideTree(dir, file)) {
      return fail(`${what} 指向被扫的树里：${file}\n基线是尺子，不是树的一部分——把它挪到 ${dir} 之外。`)
    }
  }

  let before: TreeStat | undefined
  let now: TreeStat
  try {
    // 基线**先读**：读不动就拒绝，绝不当成"什么都没变"（与配置同一条纪律）。
    if (baseFile !== undefined) before = loadTreeStat(baseFile)
    now = scanTree(dir, { skip: WORKSPACE_STATE })
    if (saveFile !== undefined) storeTreeStat(saveFile, now)
  } catch (err) {
    if (err instanceof TreeStatError) return fail(err.message)
    return fail(`扫不动 ${dir}：${(err as Error).message}`)
  }
  // 过程走 stderr（§ 9.8 的 stdout 纪律）。
  if (saveFile !== undefined) process.stderr.write(`快照存到 ${saveFile}\n`)

  const paths = now.leaves.length
  // 没给基线：这是一次"拍快照"，报的是树自己。
  if (before === undefined) {
    if (json) emitJson({ root: now.root, paths, leaves: now.leaves })
    else emitLine(`${paths} 个叶子\t${now.root}`)
    // 指路：裸敲这一次拿到的是快照，不是对比。"要对比该给什么"不能靠人去猜（§ 24 纪律 5）。
    process.stderr.write('没有给 --baseline：这是一张快照，不是对比——--save <f> 存下来，下一次 --baseline <f> 读它\n')
    return 0
  }

  const changes = diffStat(before, now)
  if (json) emitJson({ root: now.root, baseline: baseFile, paths, count: changes.length, changes })
  else {
    for (const c of changes) emitLine(`${STATUS_MARK[c.status]}\t${c.path}\t${c.columns.join(',')}`)
    process.stderr.write(
      changes.length === 0
        ? `没有变化\t${paths} 个叶子\t基线 ${baseFile}\n`
        : `${changes.length} 条变化\t${paths} 个叶子\t基线 ${baseFile}\n`,
    )
  }
  return 0
}

/** 人读那一面的记号：增 · 删 · 改。`--json` 那一面给的是 `status` 这个字本身。 */
const STATUS_MARK: Record<ChangeStatus, string> = { added: '+', removed: '-', changed: '~' }

/**
 * `fugue fork <base>`：把 base 那棵树物化出来，返回合并树（§ 8.5 · § 9.6）。
 *
 * **它不建视图、不读日志的历史**：物化的底是**真实工作树**，`fork` 只是把它挂上来（§ 8.4）。
 * `base` 在这里只做两件事——解析成一个真提交（免得把一串敲错的字符当成标签记进日志），
 * 以及进 `mat/fork` 事件。**不拿它跟真实工作树比对**：那一步 § 8.4 说得明白，不做检测。
 *
 * 退出码：0 物化好了（**用了哪一档由 stderr 那一行说，也由 `--json` 的 `strategy` 说**）·
 * 1 做不成（底不在 · 挂不上 · 铺不动）· 2 命令行本身不成立。
 */
export async function forkCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const base = args[0]
  if (base === undefined || base === '') return usageFail('fork 需要 <base>：一个提交')
  const want = flags.get('strategy')
  if (typeof want === 'string' && !(STRATEGIES as readonly string[]).includes(want)) {
    return usageFail(`--strategy 只认 ${STRATEGIES.join(' · ')}；不给就按策略表探着退档`)
  }
  const roRaw = flags.get('ro')
  const readOnly =
    typeof roRaw === 'string' ? roRaw.split(',').map((s) => s.trim()).filter((s) => s !== '') : undefined

  const abs = resolve(root)
  const writer = writerOf(flags)
  const agent = agentFor(writer)
  // `fork` 既要追加一条 `mat/fork`，又要挂载——同样整条命令一个写者。
  const log = openLog(abs, { write: writer })
  let truth: TruthHandle | null = null
  try {
    truth = openTruth(abs)
    let commit: CommitId
    try {
      commit = await truth.resolve(base)
    } catch (err) {
      return fail(`fork：${base} 不是这个工作区里一个能用的提交——<base> 要指向一棵树\n  ${(err as Error).message}`)
    }
    // **视图的底与物化的底必须是同一个提交**（§ 4）：物化的底是真实工作树，视图的底是本 agent
    // 的分支头。不一致时症状是静默的，所以拦在落地之前——这一趟只读了 ref，盘上还什么都没动。
    const disagree = forkBaseRefusal(writer, commit, await baseFor(truth, writer))
    if (disagree !== null) return fail(disagree)

    const res = await fork({ roots: createRoots(abs), log, root: abs }, agent, commit, {
      ...DEFAULT_MATERIALIZE,
      // `preserveMtime` 只在铺底的两档上有意义（overlayfs 档什么都不铺，§ 8.5）。它默认开着，
      // 关掉是**负对照**用的：关掉之后未变文件的时间戳不是底的那一个，按 mtime 判定新旧的
      // 工具链于是全量重建（V6 的读数）。
      preserveMtime: !flags.has('no-preserve-mtime'),
      ...(typeof want === 'string' ? { preferredStrategy: want as ForkStrategy } : {}),
      ...(readOnly === undefined ? {} : { readOnlyPaths: readOnly }),
    })
    if (json) {
      emitJson({
        agent,
        base: res.base,
        strategy: res.strategy,
        mount: res.mount,
        merged: res.merged,
        laid: res.laid,
        ms: res.ms,
        why: res.why,
        platform: res.facts,
      })
    } else {
      // 用了哪一档是**读数**，不是进度条：它在 stderr 上，与 stdout 那条坐标分得开（§ 9.8）。
      // `why` 自己开头就写着是哪一档（"overlayfs 档：…"或者"跳过 …；copy 档：…"），不再另起一句。
      process.stderr.write(res.why + '\n')
      emitLine(res.merged)
    }
    return 0
  } catch (err) {
    if (err instanceof ForkRefused) return fail(err.why)
    if (err instanceof MountError || err instanceof LayError) return fail(err.message)
    throw err
  } finally {
    await log.close()
    if (truth !== null) await truth.close()
  }
}

/**
 * `ensure` 那一趟的装配。**两条命令共用它**：`fugue ensure` 与 `fugue run`——后者在执行前
 * 隐式兑现一次物化（D3 的"先物化"），并把自己的声明目录递给它（`declared`，架构 § 8.6
 * 第 1 步：挂载点要在卸载态预建）。
 *
 * 上面那一趟已经读过的清单从这里递进去：不为了同一个答案再全量重放一次（§ 9.4 的重放代价）。
 */
export async function landOnce(
  ctx: Ctx,
  abs: string,
  agent: ReturnType<typeof agentFor>,
  st: MatState,
  upTo: ViewRev,
  declared?: readonly string[],
): Promise<EnsureResult> {
  return await ensure(
    {
      roots: createRoots(abs),
      log: ctx.log,
      root: abs,
      opt: DEFAULT_MATERIALIZE,
      // 视图那一侧的读口：M4 不 import M2，所以由这里接上（§ 8.3：两者只共享 `Delta`）。
      view: {
        stat: (p) => ctx.view.stat(p),
        read: (p) => ctx.view.read(p),
        rev: ctx.view.rev,
        deltasSince: (from) => ctx.view.diff(from),
        // 墓碑只给"一条 whiteout 打不开"那一支用：视图删过一个目录，而底里它还在。
        tombstones: () =>
          ctx.view
            .state()
            .upper.filter((e) => e.kind === 'tombstone')
            .map((e) => e.path),
      },
      base: lowerAt(ctx.truth, st.base),
      state: st,
      ...(declared === undefined ? {} : { declared }),
    },
    agent,
    upTo,
  )
}

/** 声明表里没被别的声明盖住的那些（排过序，所以祖先一定在后代前面）。`collect` 的收法同此。 */
export function topDeclared(paths: readonly RelPath[]): RelPath[] {
  const out: RelPath[] = []
  for (const p of paths) {
    if (out.some((q) => p.startsWith(`${q}/`))) continue
    out.push(p)
  }
  return out
}

/**
 * `fugue verify-mat`：清单 == 差异集（§ 8.5 的第二条验证性质 · § 9.6 物化行的出账）。
 *
 * **它建视图，而且载到清单那个 rev 为止**：物化树对应的是那一刻的清单。视图再往后写的那些
 * 还没有落地，拿它们来核等于拿未来核现在。
 *
 * 底下那三样各有各的来源（日志 · 真源 · 文件系统，见 `verify.ts` 的文件头），所以"相等"不是
 * 自己跟自己比。**不等就退 1，只报不修**：§ 8.5 的失败处理是删除重建，修不是这条命令的事。
 */
export async function verifyMatCmd(root: string, flags: Map<string, string | true>, json: boolean): Promise<number> {
  const abs = resolve(root)
  const agent = agentFor(writerOf(flags))
  // 先问清单要一个 rev——视图得载到那儿为止。这一趟只读日志，不开视图。
  const peek = openLog(abs)
  let st
  try {
    st = await matState(peek, agent)
  } finally {
    await peek.close()
  }
  // **不要 history**：这条命令要的是"视图在 st.rev 那一刻长什么样"，不是变更序列——所以
  // 快照能用（§ 9.4 的第一步），代价从"重放整份日志"降到"重放快照之后的那些"。
  const ctx = await openCtx(abs, flags, { upToRev: st.rev })
  try {
    const res = await verifyMat(
      {
        roots: createRoots(abs),
        log: ctx.log,
        // 底那一侧是 `mat/fork` 记的那个提交；`base` 为 null 时 `lowerAt` 给的就是一层空的下层。
        base: lowerAt(ctx.truth, st.base),
        view: {
          stat: (p) => ctx.view.stat(p),
          read: (p) => ctx.view.read(p),
          upper: () => ctx.view.state().upper,
        },
        state: st,
      },
      agent,
    )
    if (json) emitJson(res)
    else {
      const ratio = res.precision === null ? '（差异集为空）' : res.precision.toFixed(3)
      emitLine(
        `${res.ok ? 'ok' : '不等'}\t清单 ${res.manifest.paths.length} 条\t差异集 ${res.diff.paths.length} 条\t` +
          `落地 ${res.landed.paths.length} 条\tmaterialize-precision ${ratio}`,
      )
      for (const [what, list] of [
        ['只有清单有', res.onlyManifest],
        ['只有差异集有', res.onlyDiff],
        ['只有落地有（上层里多出来的）', res.onlyLanded],
        ['清单有而落地没有', res.missing],
        ['两边都有而内容对不上', res.mismatch],
      ] as const) {
        if (list.length > 0) emitLine(`${what}\t${list.join(' · ')}`)
      }
    }
    return res.ok ? 0 : 1
  } catch (err) {
    if (err instanceof VerifyRefused) return fail(err.why)
    throw err
  } finally {
    await ctx.close()
  }
}

/**
 * `fugue dispose`：删掉这个 agent 的整份物化（§ 8.5 的失败处理 · § 9.6 的物化行）。
 *
 * **它不建视图、不读日志**：`dispose` 是删除，不是一次状态迁移——它要的只是四个坐标（§ 8.4），
 * 而那四个由 `--root` 与 `--agent` 就定得下来。于是"物化目录损坏，删掉重来"这条路上，没有
 * 任何一处要先信任日志或视图。
 *
 * 退出码：0 删干净了（本来就没有也算）· 1 删不动（卸不下来）。
 */
export async function disposeCmd(root: string, flags: Map<string, string | true>, json: boolean): Promise<number> {
  const abs = resolve(root)
  const writer = writerOf(flags)
  const agent = agentFor(writer)
  // **`dispose` 不改日志，却拿同一道锁**：它改的是物化，而物化与日志是同一条命令序列的
  // 两半——一条 `ensure` 正落着的时候四个坐标被删掉，与两个写者抢一个序号是同一类事。
  const hold = holdWriter(abs, writer)
  try {
    const res = await dispose({ roots: createRoots(abs) }, agent)
    if (json) emitJson(res)
    else {
      // 过程走 stderr（§ 9.8 的 stdout 纪律）；stdout 上那一行是这次动过的坐标。
      process.stderr.write(
        res.existed
          ? `卸下并删掉 ${res.mat}：四个坐标${res.left.length === 0 ? '一个不剩' : `还剩 ${res.left.join(' · ')}`} · ${res.ms} ms\n`
          : `${res.mat} 下本来就没有物化树——幂等，照常成功\n`,
      )
      emitLine(res.mat)
    }
    return res.left.length === 0 ? 0 : 1
  } catch (err) {
    if (err instanceof MountError) return fail(err.message)
    throw err
  } finally {
    hold.release()
  }
}

/** `p` 是不是在 `dir` 这棵树里。两边都已经 `resolve` 过；`dir` 自己不算"在树里"。 */
function insideTree(dir: string, p: string): boolean {
  const rel = relative(dir, p)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * `fugue ensure [--to <rev>]`：把这个 agent 的改动落到物化树里（§ 8.5 · § 9.6 的物化行）。
 *
 * **它是物化那一组里唯一要建视图的命令**：`fork` 铺的是真实工作树（§ 8.4），不读日志；而
 * `ensure` 落的是"这个 agent 自己写过的那些路径"，那份东西只存在于日志里。
 *
 * `--to` 不给就是视图此刻的修订点。**它必须是一个修订点**：这个号要进 `mat/sync`，落一个不存在
 * 的号进去，"清单落到哪儿了"从此说不准——下一句 `--since` 也对不上。
 *
 * 退出码：0 落好了（用了哪一档由 `--json` 的 `strategy` 说）· 1 做不成（没 fork 过 · 挂不动 ·
 * 落不下）· 2 命令行本身不成立。
 */
export async function ensureCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const toRaw = flags.get('to')
  let want: ViewRev | undefined
  if (typeof toRaw === 'string') {
    const n = Number(toRaw)
    if (!Number.isInteger(n) || n < 0) return usageFail('--to 要一个非负整数修订号')
    want = n
  }
  const abs = resolve(root)
  const agent = agentFor(writerOf(flags))
  // **先问清单要两样：落到哪个 rev · base 是哪个提交。** 前者定快照的上界，后者是清单的口径
  // 那一侧的读口（`land.ts` 文件头第六条）。这一趟只读日志、不开视图。
  const peek = openLog(abs)
  let st
  try {
    st = await matState(peek, agent)
  } finally {
    await peek.close()
  }
  // 视图要载到 `want`；而快照只敢用 rev ≤ 清单那个 rev 的那一份——`diff(st.rev)` 要算得出来
  // （§ 9.4：快照换掉的是历史）。没有快照就是全量重放，慢一点，答案一样。
  const ctx = await openCtx(abs, flags, { upToRev: want, snapUpTo: st.rev, write: true })
  try {
    const upTo = want ?? ctx.view.rev
    if (!ctx.view.revs.includes(upTo)) {
      return fail(
        `ensure：rev ${upTo} 不是一个修订点\n可用的有 ${ctx.view.revs.join(' · ')}（fugue revs 列的就是它们）`,
      )
    }
    const res = await landOnce(ctx, abs, agent, st, upTo)
    if (json) {
      emitJson({
        agent: res.agent,
        from: res.from,
        to: res.to,
        strategy: res.strategy,
        merged: res.merged,
        upper: res.upper,
        landed: res.landed,
        untouched: res.untouched,
        whiteouts: res.whiteouts,
        pruned: res.pruned,
        touched: res.touched,
        noop: res.noop,
        ms: res.ms,
        platform: res.facts,
      })
    } else {
      // 过程走 stderr（§ 9.8 的 stdout 纪律）：stdout 上那一行是合并树的坐标，与 `fork` 一致。
      process.stderr.write(
        res.noop
          ? `rev ${res.to} 已是最新：没有 delta 要落\n`
          : `rev ${res.from} → ${res.to} · 落地 ${res.landed.length} 条` +
            `${res.whiteouts === 0 ? '' : `（${res.whiteouts} 条 whiteout）`} · 原样 ${res.untouched.length} 条` +
            `${res.pruned === 0 ? '' : ` · 清掉空目录 ${res.pruned} 个`} · ${res.ms} ms · ${res.strategy} 档\n`,
      )
      emitLine(res.merged)
    }
    return 0
  } catch (err) {
    if (err instanceof EnsureRefused) return fail(err.why)
    if (err instanceof MountError || err instanceof LandError) return fail(err.message)
    throw err
  } finally {
    await ctx.close()
  }
}
