// fugue 的执行组（`run`）——U4c 自 `cli/fugue.ts` 抽出，内容逐字未动（出处：架构 § 8.6
// 一次执行的五件事 · § 8.7 反向通道 · § 9.6 的执行行）。物化那一趟（`landOnce`）与
// 声明表折法（`topDeclared`）从 `./materialize.ts` 接过来——两条命令共用它们。
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkMountPoints, checkReach } from '../../boundary/check.ts'
import { PolicyError, probeLayers, resolvePolicy } from '../../boundary/policy.ts'
import type { Policy } from '../../boundary/policy.ts'
import {
  BindingError,
  declaredDirs,
  envFor,
  parseInjections,
  portRangeOf,
  readBinding,
} from '../../boundary/binding.ts'
import type { ActionBinding } from '../../boundary/binding.ts'
import { confine, degradedArgv } from '../../boundary/confine.ts'
import { cacheLayoutOf } from '../../roots/coords.ts'
import { createExecutor } from '../../execute/exec.ts'
import { ReclaimRefused, createReclaim } from '../../execute/reclaim.ts'
import type { DeclaredSet, Reclaim } from '../../execute/reclaim.ts'
import { agentFor } from '../../identity.ts'
import { openLog } from '../../log/log.ts'
import { matState } from '../../materialize/manifest.ts'
import type { MatState } from '../../materialize/manifest.ts'
import { LandError } from '../../materialize/land.ts'
import { MountError, unmountOverlay } from '../../materialize/mount.ts'
import { EnsureRefused } from '../../materialize/ensure.ts'
import { createRoots } from '../../roots/roots.ts'
import type { RelPath, StepId } from '../../terms.ts'
import { applyEdit } from '../../view/edit.ts'
import type { Delta } from '../../delta.ts'
import {
  ConfigError,
  readConfig,
} from '../../config.ts'
import type { ConfigDoc } from '../../config.ts'
import type { Ctx } from '../shared.ts'
import { emitJson, emitLine, fail, modeOf, openCtx, usageFail, writerOf } from '../shared.ts'
import { landOnce, topDeclared } from './materialize.ts'

/**
 * `fugue run <action> [-- k=v…]`：在一个动作自己的物化环境里跑它（架构 § 8.6 · § 9.6 的执行行）。
 *
 * 一趟五件事：**先物化**（`ensure`——D3 的"执行前隐式兑现"）→ 建本 agent 的缓存与声明目录的
 * 挂载点（`cache` 不在 `fork` 的四个坐标里：它是 M5 的，架构 § 8.6）→ 包命令行（`confine`）→
 * 起进程，并把三件事记进日志（`run/start` · `run/confined` · `run/end`）→ **回收**（架构 § 8.7
 * 的反向通道）：声明集内的产出进视图、声明集外的改动记一条 `mat/reclaim`。
 *
 * **它也是写命令**：那三条事件与回收都是写，所以整条命令握着该 agent 的锁（与 write · ensure
 * 同一道栅栏）——同一个 agent 的另一个写者拿不到，不同 agent 之间照旧零协调。
 *
 * 退出码：0 子进程成功 · 1 子进程没成功或这一趟做不成（含配置里没有这个动作）· 2 用法错。
 * **子进程真实的退出码在 `run/end` 与 `--json` 里**——§ 9.8 的退出码只有三个数。
 *
 * 输出：子进程的 stdout 与 stderr 都走我们的 **stderr**（那是过程，§ 9.8 的 stdout 纪律）；
 * stdout 上那一行是结果——默认 `退出码\t毫秒\t档`，`--json` 一个对象。
 */
export async function runCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  rest: readonly string[],
  json: boolean,
): Promise<number> {
  const name = args[0]
  if (name === undefined || name === '') return usageFail('run 需要 <action>', json)
  const stepRaw = flags.get('step')
  // 这一站没有轮次（S7 才有）：默认 `-`，读日志时一眼看得出"这不是某一轮里的那一步"。
  const step: StepId = typeof stepRaw === 'string' ? stepRaw : '-'

  // 命令行上那一档（架构 § 8.8 的 `Policy.mode`）：**敲错了是 2**，与"这一趟跑不成"（1）分开。
  const mode = modeOf(flags)
  if (mode === null) {
    return usageFail(`--mode 取 read-only 或 workspace-write：${JSON.stringify(flags.get('mode'))}`, json)
  }

  const abs = resolve(root)
  let doc: ConfigDoc
  let binding: ActionBinding
  let injections: Record<string, string>
  let range: string
  try {
    doc = await readConfig(abs)
    binding = readBinding(doc, name)
    injections = parseInjections(rest)
    range = portRangeOf(doc)
  } catch (err) {
    // 配置错是「做不成」（1），不是「敲错了」（2）：命令行的形状是对的，缺的是工作区那一份。
    if (err instanceof ConfigError || err instanceof BindingError) return fail(err.message, json)
    throw err
  }

  const agent = agentFor(writerOf(flags))
  const peek = openLog(abs)
  let st: MatState
  try {
    st = await matState(peek, agent)
  } finally {
    await peek.close()
  }

  // `bind` 是绑进树里、让子进程写得动的那些目录（§ 8.6 第 1 步）；`declared` 是要收回视图的
  // 产出（§ 8.7），两件事两处。回收那份装配排在**物化之后**：它的减数是"落地之后"的清单。
  const roots = createRoots(abs)
  const bind = declaredDirs(binding)
  // **一处解析**（架构 § 8.8）：这一趟的档 · 网络 · 可达集都在这一份值里——`fugue policy` 读的是
  // 同一份。层现探一次（§ 15.7 的 E4）：值本身与"为什么不在"那句话都从这一次探来。
  const probed = probeLayers(roots)
  let policy: Policy
  try {
    policy = resolvePolicy({ roots, agent, doc, mode, binding, probed })
  } catch (err) {
    if (err instanceof PolicyError) return fail(err.message, json)
    throw err
  }

  // **启动前的一致性检查**（Y4 · 架构 § 8.8 的 fail-closed）：声明的目录落不到视图里 · 清单里
  // 那一条在宿主上不成立 · 软链指不到清单里——都在这里拒。**它排在物化之前**：这一层报的是
  // "哪一栏写错了"，而再往后报的是 bwrap 的话（"源找不到"），指向的是错的地方。
  const checked = checkReach({ roots, policy, declared: bind })
  if (!checked.ok) return fail(checked.error.message, json)

  const ctx = await openCtx(abs, flags, { snapUpTo: st.rev, write: true })
  try {
    // 端口那一片按"日志里 writer 的次序"切：同一个工作区里不同的 agent 拿到不同的片，而同一批
    // agent 的两次跑（X3 的并行一趟与串行一趟）拿到同一片——逐字节可比的前提就是这个。
    const writers = (await ctx.log.writers()).slice().sort()
    const at = writers.indexOf(ctx.writer)
    const portIndex = at < 0 ? writers.length : at

    const cache = cacheLayoutOf(roots, agent)
    // 缓存是 M5 的（`fork` 不建它）：三个落点先建出来，绑定才挂得上。
    mkdirSync(cache.home, { recursive: true })
    mkdirSync(cache.xdgCache, { recursive: true })
    for (const rel of bind) mkdirSync(cache.bound(rel), { recursive: true })

    const landed = await landOnce(ctx, abs, agent, st, ctx.view.rev, bind)
    const mounts = checkMountPoints(landed.merged, bind)
    if (!mounts.ok) return fail(mounts.error.message, json)
    // **这一趟走哪一档**由上面那一份策略值说了算（架构 § 8.8）：在场的层里有挂载层 `bwrap` 就是
    // 沙箱档；只有第二层（Landlock）时它接过"写得动什么"那一维（Y6）；两层都不在才是 § 15.7 的
    // E4 退化档——树可写、回收兜底。**这条读数现探**（`probeLayers`），不从
    // `<realRoot>/.fugue/config` 的 `platform` 键里读——那份缓存的寿命是给"挂一次试试"那类贵
    // 探针定的，E4 · E5 的答案会随机器变。
    const sandboxed = policy.layers.includes('bwrap')
    // 第二层一个人撑着的那一档：没有挂载围栏，可是边界还在（未声明的写入当场拒）。
    const bareLandlock = !sandboxed && policy.layers.includes('landlock')
    // **树敞不敞开**看档：`workspace-write` 是**有人点名**要树可写（挂载层不挂、第二层把整棵树
    // 开出来）；其余档里树是只读的，未声明的写入由内核当场拒，树里没有可查的东西。
    const treeOpen = policy.mode === 'workspace-write'
    const sandboxNote = sandboxed
      ? ''
      : mode === 'workspace-write'
        ? '命令行上点名要树可写那一档（--mode workspace-write）'
        : probed.note
    // 减数是**这一趟落地之后**的清单：上面那一下已经把视图里没落地的 delta 落进了 `upper`。
    // 产出落在哪一侧由**机制**定（有没有挂载层），不由档定：没有挂载层就没有绑定。
    const reclaim = createReclaim({
      roots,
      strategy: st.strategy,
      manifest: landed.manifest,
      landing: sandboxed ? 'cache' : 'tree',
      treeOpen,
    })
    let declared: DeclaredSet
    try {
      declared = reclaim.declare(agent, binding.outputs)
    } catch (err) {
      if (err instanceof ReclaimRefused) return fail(err.message, json)
      throw err
    }
    const env = envFor({ agent, binding, injections, portIndex, range, policy })
    const confined = sandboxed
      ? confine({
          roots,
          agent,
          argv: binding.argv,
          cwd: binding.cwd,
          declared: bind,
          env,
          policy,
        })
      : degradedArgv(binding.argv, { roots, policy })

    await ctx.log.append(ctx.writer, {
      t: 'run/start',
      agent,
      step,
      action: name,
      argv0: binding.argv[0],
      // **完整 argv 与 cwd**：这一栏是绕行率的数据源（`METRIC_HOW` 里那张模式表按 `argv` 判），
      // 而工具面那一侧（`B5`）已经这么填了。两处填的记录的东西一致（都是"真要 spawn 的那一条
      // 命令行"），读数才有同一把尺——差别只在这边是 `binding.argv`，那边是 `["/bin/sh","-c",…]`。
      argv: policy.degraded ? degradedArgv(binding.argv, { roots, policy }) : binding.argv,
      cwd: roots.merged,
    })
    // 这一条事件记的是**上面那一份策略值**（要求），不是包出来的那条命令行自己算的：两处读同一份，
    // `fugue policy` 印的与它逐字相等（PLAN § 5.5 的 Y2 断言 ①）。
    await ctx.log.append(ctx.writer, {
      t: 'run/confined',
      agent,
      mode: policy.mode,
      enforcement: policy.enforcement,
      net: policy.net,
      layers: [...policy.layers],
      reach: [...policy.reach.roRoots],
    })
    // 中止信号这一站不给：Ctrl-C 由 `--die-with-parent` 把子进程带走（那正是那个开关的用处）。
    // 代价写在疑点里——那一下 `run/end` 不会落下，日志上留一条没合上的 `run/start`。
    const res = await createExecutor({
      onChunk: (_which, chunk) => process.stderr.write(chunk),
      // `RunSpec.cwd` 翻成物理路径归 `M5`（架构 § 8.6 那一栏的注）：沙箱那一档它同时进
      // `--chdir`，**退化档里它是唯一的那一处**——没有沙箱可 chdir，子进程就在这棵树里跑。
      cwdOf: (a, rel) => join(roots.mergedRoot(a), rel),
    }).run(agent, { action: name, confined, cwd: binding.cwd, env }, new AbortController().signal)
    await ctx.log.append(ctx.writer, {
      t: 'run/end',
      agent,
      step,
      exit: res.exit,
      ms: res.ms,
      denied: res.denied,
    })

    // ── 反向通道：产出收进视图、越了声明的地方记下来（架构 § 8.7 · PLAN § 5.4 的 X2）
    const gate = await reclaimRun(ctx, roots, agent, st, bind, declared, reclaim)

    if (json) {
      emitJson({
        agent,
        action: name,
        step,
        exit: res.exit,
        ms: res.ms,
        denied: res.denied,
        mode: policy.mode,
        enforcement: policy.enforcement,
        mechanism: confined.mechanism,
        net: policy.net,
        layers: [...policy.layers],
        reach: [...policy.reach.roRoots],
        argv0: binding.argv[0],
        cwd: binding.cwd,
        declared: [...bind],
        outputs: [...declared.paths],
        sandbox: sandboxed,
        sandboxNote,
        reclaimed: gate.wrote,
        missing: gate.missing,
        undeclared: gate.undeclared,
        prepared: landed.prepared,
        merged: landed.merged,
        tree: policy.coords.tree,
        home: env.HOME,
        tmp: env.TMPDIR,
        xdgCache: env.XDG_CACHE_HOME,
        port: Number(env.PORT),
        ports: env.PORTS,
      })
    } else {
      process.stderr.write(
        `退出码 ${res.exit} · ${res.ms} ms · ${policy.mode} · ${policy.enforcement} 档` +
          `${sandboxed ? '' : ` · 没有沙箱（${sandboxNote}）`}` +
          `${bareLandlock ? ' · landlock 那一层还在：未声明的写入当场拒' : ''}` +
          `${treeOpen ? '——树可写，回收兜底' : ''}` +
          `${res.denied ? ' · 有被拒的写入' : ''}` +
          `${landed.prepared.length === 0 ? '' : ` · 预建挂载点 ${landed.prepared.length} 个`}` +
          `${gate.wrote.length === 0 ? '' : ` · 回收 ${gate.wrote.length} 条进视图`}` +
          `${gate.missing.length === 0 ? '' : ` · 声明了没产出 ${gate.missing.length} 条`}` +
          `${gate.undeclared.length === 0 ? '' : ` · 声明集外 ${gate.undeclared.length} 条（mat/reclaim）`}` +
          `\n`,
      )
      emitLine(`${res.exit}\t${res.ms}\t${policy.enforcement}`)
    }
    return res.exit === 0 ? 0 : 1
  } catch (err) {
    if (err instanceof EnsureRefused) return fail(err.why, json)
    if (err instanceof MountError || err instanceof LandError) return fail(err.message, json)
    if (err instanceof BindingError || err instanceof ReclaimRefused) return fail(err.message, json)
    throw err
  } finally {
    await ctx.close()
  }
}

interface ReclaimOutcome {
  /** 收进视图的那些路径（一次回写一条事件，rev 按这个次序往前推）。 */
  readonly wrote: readonly RelPath[]
  /** 声明了、这一趟却一条产出都没收到的那些。 */
  readonly missing: readonly RelPath[]
  /** 声明集**外**被改动的路径——有它就记了一条 `mat/reclaim`。 */
  readonly undeclared: readonly RelPath[]
}

/**
 * `fugue run` 的最后一步：把这一趟的产出收回视图、把越了声明的地方记下来（架构 § 8.7）。
 *
 * **次序是硬的：卸 → 收 → 记 → 挂回。** 枚举 `upper` 必须在卸载之后（§ 8.7 与 § 8.5 的第一条
 * 机制约束），而挂回排在 `finally` 里——中途抛错也留不下一棵卸着的树。挂回给的是**清单那个
 * rev**，于是它只补挂载态、不落 delta：回写视图的是 `collect` 的产出，落盘由下一条 `ensure`
 * 负责（§ 9.6：执行前隐式兑现，执行后不追着落）。
 */
async function reclaimRun(
  ctx: Ctx,
  roots: ReturnType<typeof createRoots>,
  agent: ReturnType<typeof agentFor>,
  st: MatState,
  bind: readonly string[],
  declared: DeclaredSet,
  reclaim: Reclaim,
): Promise<ReclaimOutcome> {
  const cache = cacheLayoutOf(roots, agent)
  unmountOverlay(roots.mergedRoot(agent))
  let deltas: Delta[]
  let outside: RelPath[]
  try {
    deltas = await reclaim.collect(agent, declared)
    outside = await reclaim.undeclared(agent, declared)
  } finally {
    await landOnce(ctx, ctx.root, agent, st, st.rev, bind)
  }
  // 越了声明的地方先记：它是这一趟的判决；回写进去的是判决之后放行的那几条。
  if (outside.length > 0) {
    await ctx.log.append(ctx.writer, {
      t: 'mat/reclaim',
      agent,
      declared: [...declared.paths],
      changed: [...outside],
    })
  }
  const wrote: RelPath[] = []
  for (const d of deltas) {
    await applyEdit(ctx, d)
    wrote.push(d.kind === 'rename' ? d.to : d.path)
  }
  const got = new Set(wrote)
  return {
    wrote,
    missing: topDeclared(declared.paths).filter(
      (p) => !got.has(p) && !wrote.some((w) => w.startsWith(`${p}/`)),
    ),
    undeclared: outside,
  }
}
