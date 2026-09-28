// fugue 的轮次组（round new/plan/run/go/work · say）与真驱动装配（driverSupport）——
// U4d 自 `cli/fugue.ts` 抽出，内容逐字未动（出处：架构 § 8.13–§ 8.14 的轮次 · § 9.6 的
// 轮次行 · § 20 S7 的可用性）。`driverSupport` 的出口面由 `fugue.ts` 那行 re-export
// 保住（protocol-wire.test.ts 从那里 import）。
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { BindingError, actionNames, readBinding } from '../../boundary/binding.ts'
import { ConfigError, getConfig, readConfig } from '../../config.ts'
import type { ConfigDoc } from '../../config.ts'
import { agentFor, identFor } from '../../identity.ts'
import type { Log } from '../../log/events.ts'
import { openLog } from '../../log/log.ts'
import type { LogHandle } from '../../log/log.ts'
import { createRoots } from '../../roots/roots.ts'
import type { AgentId, BranchId, CommitId, ContractId, RelPath, RoundId, WriterId } from '../../terms.ts'
import type { TruthHandle } from '../../truth/truth.ts'
import type { View } from '../../view/contract.ts'
import { lowerAt } from '../../view/lower.ts'
import { loadView } from '../../view/view.ts'
import { DEFAULT_MODEL } from '../../assemble/models.ts'
import { HOLDER_PROTOCOL, protocolFor } from '../../assemble/protocol.ts'
import { emptyState } from '../../assemble/sources.ts'
import type { AssembleState } from '../../assemble/sources.ts'
import { stateWithState } from '../../assemble/sources-state.ts'
import type { SplitAssignment } from '../../contract/build.ts'
import { createToolHost } from '../../tools/host.ts'
import { createToolExecutor } from '../../capability/dispatch.ts'
import { refHeadOf } from '../../round/head.ts'
import { RoundStartError, startRound } from '../../round/start.ts'
import { dispatchRound } from '../../round/dispatch.ts'
import { lastOf, latestFaceOf, roundFactsOf, withVersion } from '../../round/versions.ts'
import type { VersionFace } from '../../round/versions.ts'
import { fingerprintOf } from '../../contract/gate.ts'
import { PlanError, holderGoalText, planRound, pinnedBase } from '../../round/plan.ts'
import { RECENT_COUNT, SayError, recentOf, sayRound, sessionPathOf } from '../../round/say.ts'
import { estimateTokensOfText } from '../../runtime/budget.ts'
import { draftPathOf } from '../../contract/draft.ts'
import { RoundRunError, materializeCommit, runIssued, runRound } from '../../round/execute.ts'
import type { RoundRun } from '../../round/execute.ts'
import { RoundWorkError, issuedBatchOf } from '../../round/work.ts'
import type { DriverSupport, Stub } from '../../round/execute.ts'
import { realDriver, stubDriver } from '../../round/driver.ts'
import { RETRY_DEFAULT } from '../../round/machine.ts'
import { wireCallOver } from '../../runtime/step.ts'
import type { AgentHandle, CallModel, ToolExecutor } from '../../runtime/step.ts'
import { makeDumpCall, wireInTransport, targetAt } from '../../model/http.ts'
import { authWith, modelDeclOf, providerOf } from '../../model/contract.ts'
import type { ModelDecl } from '../../model/contract.ts'
import { wireHeader } from '../../model/wire/headers.ts'
import type { ToolEntry } from '../../tools/catalog.ts'
import type { Contract } from '../../contract/types.ts'
import { declaredSetOf } from '../../contract/types.ts'
import type { AssertionRunSpec } from '../../merge/accept.ts'
import type { DriftVerdict } from '../../merge/drift.ts'
import { entriesOf } from '../../merge/accept.ts'
import { computeAll, reportOf } from '../../probe/round.ts'
import { computeAllMetrics, computeAttribution, lineOf, lineOfAttribution } from '../../probe/metrics.ts'
import { METRICS_HEAD, REPORT_HEAD, callLinesOf, rowsOf } from '../../probe/status.ts'
import { phaseOf } from '../../model/price.ts'
import type { Ctx } from '../shared.ts'
import { UsageError, emitJson, emitLine, fail, openCtx, usageFail, writerOf } from '../shared.ts'
import { dumpWireDir, modelLimitOf, publishedCatalog } from './assemble.ts'

/**
 * 那几个"怎么出网"的开关收成一份：`--live` · `--wire-in` · `--dump-wire` · `--credential` ·
 * `--max-steps`。
 *
 * **一处**：`round plan` 与 `round run`（加上 `round go`）都要它们，而两处各写一遍的症状是
 * "一个命令上能用的写法在另一个上不能"——这一站已经撞过一次同类：`--dump-wire` 的落点守卫
 * 原先与凭据那一条挤在同一个对象字面量里求值，"落在工作区里"被"凭据不在"抢答（实测）。
 *
 * **两处守卫的顺序是有意的**：落点那一条是这一趟的入场条件（不成立就不该开工），而凭据那一条
 * 只在真要出网时才要——所以凭据那一步留在调用点（`--judge` 与回放档都不该取凭据）。
 *
 * 用法错（旗子少一个值 · 互斥的两档一起给）**抛 `UsageError`**：`run()` 那一层把它收成退出码
 * 2 与用法说明；落点在工件区里那一条是 `RoundRunError`（"这一趟做不成"），照旧往外抛。
 */
function wireFlagsOf(root: string, flags: Map<string, string | true>): WireFlags {
  const live = flags.has('live')
  // **`--credential <路径>` 是一个覆盖**：不给就按提供方声明里那份表取（`authOf` 那一处）。
  const credential = typeof flags.get('credential') === 'string' ? (flags.get('credential') as string) : undefined
  // `--dump-wire <目录>`：**要它才落**（不给时那一层根本不存在，一个字节都不写）。
  const dumpFlag = flags.get('dump-wire')
  if (dumpFlag === true) throw new UsageError('--dump-wire 要一个目录：--dump-wire /tmp/fugue-wire')
  const dumpDir = typeof dumpFlag === 'string' ? dumpWireDir(root, resolve(dumpFlag)) : undefined
  // `--wire-in <目录>`：**回放档**（架构 § 10.5 的录制夹具 · PLAN § 5.12 序 1）。它不出网、不读
  // 凭据，而它必须走真驱动（打桩那一档一次调用都不发，回放就无从谈起）。
  const wireInFlag = flags.get('wire-in')
  if (wireInFlag === true) throw new UsageError('--wire-in 要一个目录：--wire-in <--dump-wire 落过的那个目录>')
  const wireIn = typeof wireInFlag === 'string' ? resolve(wireInFlag) : undefined
  if (wireIn !== undefined && live) {
    throw new UsageError(
      '--wire-in 与 --live 是两档，一次只给一个：前者不出网（喂回去的是录下来的响应），后者要出网。' +
        '要一边回放一边重录一份，就给 --wire-in <旧目录> --dump-wire <新目录>。',
    )
  }
  // `--max-steps`：**花钱的那道上界**。取值要是一个正整数；不认的写法当场拒（不替它猜）。
  const stepsFlag = flags.get('max-steps')
  let maxSteps: number | undefined
  if (typeof stepsFlag === 'string') {
    const n = Number(stepsFlag)
    if (!Number.isInteger(n) || n < 1) throw new UsageError(`--max-steps 要一个正整数，拿到 ${JSON.stringify(stepsFlag)}`)
    maxSteps = n
  } else if (stepsFlag === true) {
    throw new UsageError('--max-steps 要一个数：--max-steps 8')
  }
  return {
    live,
    ...(wireIn === undefined ? {} : { wireIn }),
    ...(dumpDir === undefined ? {} : { dumpDir }),
    ...(credential === undefined ? {} : { credential }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
  }
}

/** `wireFlagsOf` 的产出：三条传输档 · 一个覆盖 · 一道上界。**缺的那几栏就是"没要求"。** */
interface WireFlags {
  readonly live: boolean
  readonly wireIn?: string
  readonly dumpDir?: string
  readonly credential?: string
  readonly maxSteps?: number
}

/**
 * `fugue round new <目标>`：开一个轮次（架构 § 8.13 的三步转移 · § 8.14 的 C7 前半 · § 8.12 的
 * 第一次预检 · PLAN § 5.7 的 A4 行）。
 *
 * **这一层只做三件事**：读配置里的拆分草案 · 把位置发成身份（`<轮次>/<n>` 与 `agent/<轮次>/<n>`）·
 * 把 `startRound` 的产出排成两列。钉底 · 构造 · 预检 · 发契约 · 起分支全在 `src/round/start.ts`
 * 里——这一层不认识状态机，也不认识契约的形状。
 *
 * **两个写者口**：持轮者那一份（`round/state` · `round/intent` · `contract/issue`）走 `openCtx`
 * 那条句柄；物化那一档每铺一条分支开一个那个 agent 的句柄（`mat/fork` 落在它自己的日志里）。
 * 栅栏按 writer 分文件（§ 9.2），所以这是两个写者，不是一个写者写两份。
 */
export async function roundCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const verb = args[0]
  if (verb !== 'new') {
    return usageFail(`round 的子命令是 new · plan · go · run · work：拿到的是 ${verb === undefined ? '（空）' : verb}`, json)
  }
  const goal = args[1]
  if (goal === undefined || goal === '') return usageFail('round new 需要 <目标>：轮级意图的那一句', json)

  let split: SplitAssignment[]
  let doc: ConfigDoc
  try {
    doc = await readConfig(root)
    split = readSplit(doc, flags.get('split'))
  } catch (err) {
    if (err instanceof RoundStartError) return fail(err.message, json)
    if (err instanceof ConfigError) return fail(err.message, json)
    throw err
  }
  if (split.length === 0) {
    return usageFail(
      '这一轮一份拆分草案都没有：配置里的 round.split 是空的\n' +
        `加一份：fugue --root ${root} config set round.split '[{"goal":"…","ownedPaths":["src/a.ts"],"assertions":[{"action":"test","name":"测试全过"}]}]'`,
      json,
    )
  }

  // 轮次号：配置里有就用它，否则 `r1`。**一个工作区开箱就能开一轮**，不必先配一遍。
  const rawRound = getConfig(doc, 'round.id')
  const round = typeof rawRound === 'string' && rawRound !== '' ? rawRound : 'r1'

  // **身份名就是那条 ref 的中间那一段。** `refFor(agent)` 给的是 `refs/heads/<agent>`，而架构 § 4
  // 那张表写的是 `refs/heads/agent/<round>/<n>`——所以 agent 那一栏是 `agent/<round>/<n>`，
  // 于是这一份里的每一处都从同一个名字出发：分支 ref · 物化根 `mat/<agent>/` · 日志
  // `log/<agent>.jsonl`（§ 9.2 那张布局表）。
  // **身份分配器**（架构 § 14.1 第 1 步）：第 n 个 agent 的名字与它那条分支一处给（`identFor`）。
  // 这一档没有调查型那一节，所以第 n 份草案就是第 n 个 agent（持轮者那一档由草案的节序定）。
  const identityFor = (n: number): { agent: AgentId; branch: BranchId } => identFor(round, n)
  const materialize = flags.has('materialize')

  const ctx = await openCtx(root, flags, { sync: 'each', write: true })
  try {
    const started = await startRound({
      roots: ctx.roots,
      truth: ctx.truth,
      log: ctx.log,
      round,
      intent: { goal },
      split,
      identityFor,
      // 这一档（人拆）没有种子：那一栏由调用方给（架构 § 8.12）。
      seeds: [] as readonly RelPath[],
      // 物化那一档：每一条分支一个口，那个 agent 自己的日志。
      logForAgent: (a) => openLog(root, { write: a as WriterId, sync: 'each' }),
      // **声明的上限接进 `seed` 那一条**：这一档没有种子（`seeds: []`），但读数那一行印的就是它。
      modelLimit: modelLimitOf(),
      materialize,
    })
    if (json) {
      emitJson({
        round: started.round,
        base: started.base,
        contracts: started.built.contracts,
        owners: started.owners,
        seedLimit: started.built.seedLimit,
        seedTokens: started.built.seedTokens,
        seedRead: started.seedRead,
        intersections: started.precheck.lines,
        materialized: materialize,
        branches: started.forks.map((f) => ({ agent: f.agent, base: f.base, strategy: f.strategy, merged: f.merged })),
        trail: started.trail,
      })
    } else {
      const owners = [...new Set(started.built.contracts.map((c) => c.agent))]
      emitLine(`${started.round}\t${started.base}\t${started.built.contracts.length} 份契约\t${owners.length} 条分支`)
      for (const c of started.built.contracts) {
        emitLine(`  ${c.id}\t${c.agent}\t${c.kind}\t${writeSetLine(c)}`)
      }
      // **种子那一行不省**：量出来是 0 与"这一轮没有种子"在读数上分不开，而它们要改的地方
      // 不是一处（前者是树，后者是草案）。
      emitLine(
        `  种子\t上限 ${started.built.seedLimit} token\t逐份 ${started.built.seedTokens.join(' · ') || '（没有）'}\t` +
          (started.seedRead.from === 'tree'
            ? `在钉住的底上取到 ${started.seedRead.loaded} 份内容`
            : '量法是调用方给的（这一层没量）') +
          (started.seedRead.missing.length === 0 ? '' : `\t这一棵树上没有：${started.seedRead.missing.join(' · ')}`),
      )
      for (const f of started.forks) emitLine(`  ${f.agent}\tfork ${f.strategy}\t${f.merged}`)
      if (started.forks.length === 0) {
        process.stderr.write('物化没有铺（架构 § 14.1 的 deferMaterialize：走按需物化）；要现在铺就加 --materialize\n')
      }
      // **不交时也印这一行**：走查里第一条验证的负对照就是"同一把尺子报 0 对"——
      // 不印的话那一档与"预检压根没跑"在读数上分不开（都是没有这一行）。
      process.stderr.write(`写入集预检：${writeSetPaths(started.built.contracts).length} 条路径 · ${started.precheck.lines.length} 对相交`)
      if (started.precheck.lines.length > 0) {
        process.stderr.write('，照发：\n')
        for (const l of started.precheck.lines) process.stderr.write(`  ${l}\n`)
      } else {
        process.stderr.write('\n')
      }
    }
    return 0
  } catch (err) {
    if (err instanceof RoundStartError) return fail(err.message, json)
    throw err
  } finally {
    await ctx.close()
  }
}

/**
 * `fugue round run <目标>`：**一条命令跑完一个轮次**（架构 § 20 S7 的可用性 · PLAN § 5.7 的收口
 * 第一条）。这一层只做三件事：把配置读成"拆分草案 + 断言"两栏 · 给打桩一个形状 · 把读数排成两列。
 *
 * 轮次本身的顺序住在 `src/round/execute.ts`，验收住 `src/merge/accept.ts`，折叠住
 * `src/merge/merge.ts`——这一层不认识状态机、不认识契约的形状、不认识冲突。
 *
 * **模型那一侧缺省是打桩那一档**（`--live` 真网络 · `--wire-in` 回放，两档走 `realDriver`）。
 * 打桩的形状是：每个 agent 在它自己的底上造一棵树、落一个提交——一份契约一个提交。
 * `--fail n` 让第 n 个交一棵"必然不满足断言"的树（走查要撞红那一次），`--deny n` 让第 n 个的
 * 格子里多跑一条必然被拒的动作。
 */
export async function roundRun(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const goal = args[0]
  if (goal === undefined || goal === '') return usageFail('round run 需要 <目标>：轮级意图的那一句', json)

  let doc: ConfigDoc
  let split: SplitAssignment[]
  let assertions: AssertionSpec[]
  try {
    doc = await readConfig(root)
    split = readSplit(doc, flags.get('split'))
    assertions = readAssertions(doc)
  } catch (err) {
    if (err instanceof RoundStartError) return fail(err.message, json)
    if (err instanceof ConfigError) return fail(err.message, json)
    throw err
  }
  if (split.length === 0) return usageFail('这一轮一份拆分草案都没有：配置里的 round.split 是空的', json)
  if (assertions.length === 0) {
    return usageFail(
      '一条断言都没有：零条会让「打回率低」这句话没有分母（PLAN § 5.7 的地板第二档）\n' +
        `加一条：fugue --root ${root} config set round.assertions '[{"name":"测试全过","argv":["/bin/sh","-c","true"]}]'`,
      json,
    )
  }

  const rawRound = getConfig(doc, 'round.id')
  const round = typeof rawRound === 'string' && rawRound !== '' ? rawRound : 'r1'
  /** **身份分配器**（架构 § 14.1 第 1 步）：名字与它那条分支一处给（`identFor`）。 */
  const identityFor = (n: number): { agent: AgentId; branch: BranchId } => identFor(round, n)
  /** 打桩那一档只要"这是第几格"（给那棵树的路径起个名）——同一个分配器给的次序。 */
  const agents: AgentId[] = split.map((_, i) => identityFor(i).agent)
  // `--fail <断言名>`：把配置里**那一条**断言换成必然失败的一条。撞不上就什么都不做——这一档是
  // "走查要撞红"，不是"让这一趟注定失败"。
  const failTarget = typeof flags.get('fail') === 'string' ? (flags.get('fail') as string) : undefined
  const retriesLeft = numberOf(flags.get('retry'), 0) ?? RETRY_DEFAULT
  const deny = flags.has('deny')
  // 合并前那一档预检的严宽：**缺省只报不拒**（判决进 `precheckMerge`、印在报告那一行；折叠照做，
  // 真冲突由它当场报出）。`--strict-merge-gate` 才是 fail-closed 那一档——留着的理由与改主意的
  // 条件写在 `RunDeps.strictMergeGate` 那一段。
  const strictMergeGate = flags.has('strict-merge-gate')
  // `--poke <路径>`：**在漂移检之前手改一条路径**（走查要量漂移那一条）。不给就什么都不做。
  const poke = typeof flags.get('poke') === 'string' ? (flags.get('poke') as string) : undefined
  // `--poke-exact <路径>[,<路径>…]`：**把这一趟折出来的目标树里那几条路径的字节照抄到盘上**，
  // 位置与 `--poke` 相同。走查要量"两边逐字节相同 → 照合并"那一档（A10 的断言 ③）：用户手里
  // 那份**恰好就是**合并算出来的结果，于是推进不会覆盖任何人的字节。抄的是树上的字节，所以与
  // 打桩那几行无关。**逗号分隔**：参数解析器一 flag 一个值（重复给只留最后一个）。
  const pokeExact =
    typeof flags.get('poke-exact') === 'string'
      ? (flags.get('poke-exact') as string).split(',').map((x) => x.trim()).filter((x) => x !== '')
      : []

  // 那几面开关收在一处（`wireFlagsOf`）：`--live` · `--wire-in` · `--dump-wire` · `--credential`
  // · `--max-steps`。凭据那一步在下面按档取——**回放档与 `--judge` 都不该取凭据**。
  const wire = wireFlagsOf(root, flags)
  // **这一趟走不走真驱动**：真网络那一档（`--live`）与回放那一档（`--wire-in`）都走它。
  const live = wire.live
  const wireIn = wire.wireIn
  const dumpDir = wire.dumpDir
  const credentialOverride = wire.credential
  const maxSteps = wire.maxSteps
  const real = live || wireIn !== undefined
  const handoff = flags.has('no-handoff') ? false : undefined
  // **一个 agent 一个日志口、由调用方持有**（`hold.ts` 那道栅栏：同一个 writer 开第二个口就是
  // "已经有写者"）。这一份记着开过的口，轮次跑完一起关（`closeAgentLogs`）。
  const agentLogs = new Map<AgentId, LogHandle>()
  const agentLogOf = (a: AgentId): Log => {
    const hit = agentLogs.get(a)
    if (hit !== undefined) return hit
    const made = openLog(root, { write: a as WriterId, sync: 'each' })
    agentLogs.set(a, made)
    return made
  }
  const closeAgentLogs = async (): Promise<void> => {
    for (const [a, l] of agentLogs) {
      agentLogs.delete(a)
      await l.close()
    }
  }
  const ctx = await openCtx(root, flags, { sync: 'each', write: true })
  /**
   * **每一格为什么停**（第 5 批 · 疑点 2）：`realDriver` 的 `onResult` 是这句话唯一的出口，
   * 而壳原先没接——于是"这一步是走完的、还是被预算/步数/半截流掐掉的"出了驱动那一层就没了，
   * 命令面只剩"验收：通过 1"。**这里不是新判据**：判据仍然是验收（`report.ok`）；收它是因为
   * `stopped` 与"写了几条"合起来才说得清一轮到底干成了什么（第一次联网验证那两趟全靠它）。
   */
  const stops: AgentStop[] = []
  try {
    const stub: Stub = {
      run: async (agent, c, base, hint) => {
        // **解决那一格走另一条路**：把冲突路径上的内容**收敛到下一折那一路**（`hint.nextBranch`），
        // 于是下一折的逐文件比对什么都看不到——折得下去。这是"逐路折叠"这条路的真实形状。
        if (c.kind === 'resolve' && hint !== undefined) {
          const inherited = new Map((await entriesOf(ctx.truth, hint.nextBranch)).map((e) => [e.name, e]))
          return ctx.truth.commit(await ctx.truth.putTree([...inherited.values()]), [base], `（打桩·解冲突：收敛到下一折那一路）${agent}`)
        }
        // **打桩改的是"这一份契约的写入面里第一条真路径"**：写入面里有两条时第一条往往是目录、
        // 第二条是它底下的文件。这样"撞不撞车"由拆分草案决定（走查要拿它撞一次），打桩自己不猜。
        const surface: readonly string[] = c.kind === 'implement' ? c.ownedPaths : c.kind === 'resolve' ? c.conflictPaths : [`evidence-${agents.indexOf(agent) + 1}`]
        const covers = (a: string, b: string): boolean => a === b || b.startsWith(`${a}/`)
        const isPrefix = surface.some((q) => surface.some((r) => r !== q && covers(q, r)))
        const where = surface.find((q) => !isPrefix || !surface.some((r) => r !== q && covers(q, r) && r !== q)) ?? `stub-${agents.indexOf(agent) + 1}`
        // 内容带上契约的 id：**两份契约改同一条路径时，两条分支的那一条内容不同**——否则
        // "相对底改了哪些路径"算出来是空的（内容一样 = 与底一样）。
        const files: Record<string, string> = { [where]: `（打桩）${c.id} 改了 ${where}\n` }
        const entries = []
        for (const [path, text] of Object.entries(files)) {
          const id = await ctx.truth.putBlob(new TextEncoder().encode(text))
          entries.push({ name: path, mode: 0o100644, id })
        }
        // **新树 = 底那棵树 + 这一格的改动。** 这一句是承重的：折出来的那棵目标树就是第 7 步
        // 要推进工作树的那一棵，所以它必须是**底的整棵树**加上改动——只落改动那几条的话，
        // 底里其余的路径在目标树里都不存在，推进会当成"要删"（A10 把判据换成"目标树 vs 盘上"
        // 之后，走查当场量到了这一条）。打桩不删、只加改。
        const inherited = await entriesOf(ctx.truth, base)
        const merged = new Map(inherited.map((e): [string, (typeof entries)[number]] => [e.name, e]))
        for (const e of entries) merged.set(e.name, e)
        return ctx.truth.commit(await ctx.truth.putTree([...merged.values()]), [base], `（打桩）${agent}`)
      },
    }

    const specsOf = (c: Contract, agent: AgentId): readonly AssertionRunSpec[] => {
      void c
      void agent
      return assertions.map((a) => {
        const fail = failTarget !== undefined && a.name === failTarget
        return {
          assertion: { action: a.name, name: a.name, expect: a.expect } as Assertion,
          argv: fail ? ['/bin/sh', '-c', 'exit 1'] : a.argv,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
        }
      })
    }

    const started = await runRound({
      roots: ctx.roots,
      truth: ctx.truth,
      log: ctx.log,
      logOf: agentLogOf,
      closeAgentLogs,
      round,
      intent: { goal },
      split,
      identityFor,
      // 这一档（人拆）没有种子：那一栏由调用方给（架构 § 8.12）。
      seeds: [] as readonly RelPath[],
      logForAgent: agentLogOf,
      materialize: flags.has('materialize'),
      // **声明的上限接进 `seed` 那一条**：与 `round new` / `round go` 递的是同一个数。
      modelLimit: modelLimitOf(),
      // **两条路在 `runRound` 眼里没有区别**（同一个 `AgentDriver`）：打桩那一档把 `Stub` 包
      // 一层（S7 定下的那个形状不动），真驱动那一档走 `realDriver` + `DriverSupport`。凭据那一
      // 步只在这一档走（不打 `--live` 的话 `driverSupport` 一次都不被调）。
      //
      // **这里原先恒是 `stubDriver(stub)`**，于是 `--live` 那一档只是把 `driverSupport` 传了下去
      // （ask 那一侧因此是完整的），而**干一格的那一个函数还是打桩**：一次真调用都没发，盘上落的
      // 是"（打桩）… 改了 …"，而命令面照旧报成功。整条链的取证（dump 一份都不落）就是这么露的。
      // `driverSupport` 那一栏照旧给（ask 要从它拿 `call` · `execute` · `decl` · `handle`）。
      // **真驱动那一档接上 `onResult`**：`stopped` 与 `steps` 收进 `stops`，跑完一起报出去
      // （打桩那一档没有这句话可说——它没有"停因"，`stubDriver` 也不产出读数）。
      // **回放档也走它**（`real`）：那一档与真档的差别只在传输那一层，不在驱动这一层。
      stub: real
        ? realDriver({
            onResult: (agent, r) => {
              stops.push({ agent: String(agent), steps: r.steps, stopped: r.stopped })
            },
          })
        : stubDriver(stub),
      ...(maxSteps === undefined ? {} : { maxSteps }),
      ...(handoff === undefined ? {} : { handoff }),
      // **判据是"这一趟走不走真驱动"**（`--live` 或 `--wire-in`）：凭据那一步已经归
      // `driverSupport`（声明里那份表 + `authOf`；**回放档不取凭据**），壳这一层不再自己读一次
      // ——它只带一个命令行覆盖。
      ...(real
        ? {
            driver: driverSupport({
              root,
              doc,
              ...(wireIn === undefined ? {} : { wireIn }),
              ...(maxSteps === undefined ? {} : { maxSteps }),
              ...(credentialOverride === undefined ? {} : { credential: credentialOverride }),
              ...(dumpDir === undefined ? {} : { dumpDir }),
            }),
          }
        : {}),
      specsOf,
      retriesLeft,
      strictMergeGate,
      onDrift: reportDrift,
      ...(poke === undefined
        ? {}
        : {
            beforeMerge: () => {
              const abs = join(ctx.roots.realRoot, poke)
              mkdirSync(join(abs, '..'), { recursive: true })
              const before = existsSync(abs) ? statSync(abs).size : -1
              appendFileSync(abs, `轮次中有人手改了这条：${poke}\n`)
              process.stderr.write(
                `--poke ${poke}：${abs}（${before} → ${statSync(abs).size} 字节）· realRoot=${ctx.roots.realRoot}\n`,
              )
            },
          }),
      ...(pokeExact.length === 0
        ? {}
        : {
            afterFold: async (target: CommitId) => {
              for (const p of pokeExact) {
                const abs = join(ctx.roots.realRoot, p)
                const before = existsSync(abs) ? statSync(abs).size : -1
                const bytes = await ctx.truth.readAt(target, p)
                if (bytes === null) throw new Error(`--poke-exact ${p}：目标树里没有这条路径`)
                mkdirSync(join(abs, '..'), { recursive: true })
                writeFileSync(abs, bytes)
                process.stderr.write(
                  `--poke-exact ${p}：${abs}（${before} → ${statSync(abs).size} 字节）——盘上抄的是目标树里那一份\n`,
                )
              }
            },
          }),
    })

    // `--deny`：**真让内核拒一次写**，把那一趟记成 `run/end`。三个数里第三个的来源就是这一条
    // 事件；而这一跑要给的是一个**真的**被拒，不是一个自己写的 `denied: true`。
    let deniedAction: { agent: AgentId; exit: number; denied: boolean; note: string } | null = null
    if (deny) {
      const agent = agents[0]
      if (agent === undefined) return usageFail('--deny：这一轮一个 agent 都没有', json)
      const r = await refuseOneWrite(ctx.truth, started.base, 'round-deny-')
      deniedAction = { agent, exit: r.exit, denied: r.denied, note: r.note }
      // **口用持轮者已经开着的那个**（`agentLogOf` 那一份缓存）。这一轮里这个 agent 的口是持轮者
      // 开着的（`logOf` 那一栏：只借不还），同一个进程里再拿一次同一把锁是程序错误——`holdWriter`
      // 当场拒。走查实测过（改之前）：这里另开一份 → 撞红那一趟 `run2.json` 0 字节 · 退出码 1 · 两个 FAIL。
      await agentLogOf(agent).append(agent as WriterId, {
        t: 'run/end',
        agent,
        step: 'deny',
        exit: r.exit,
        ms: 0,
        denied: r.denied,
      })
    }

    // 打回那三个数：**从日志重算**（架构 § 8.15）。同一份日志算两次同值——所以 `--report` 印的
    // 就是刚才那一趟跑出来的那份日志。
    const readings = await computeAll(() => ctx.log.readMerged(), { round })
    // **归因三处对照**（闸四的另一半 · PLAN § 5.12 序 3）：也是从日志重算——与上面那三个数、
    // 与八元指标同一个源（同一份日志 · 同样不采集）。三行恒在，缺的写「没有读数」。
    const attribution = await computeAttribution(() => ctx.log.readMerged())
    // **逐趟账**（PLAN § 5.9 的 `G5`）：每一条 `llm/call` 一行 + 合计。它也是从同一份日志重算，
    // 钱的档按读这一次的钟算（账上没有时刻）。
    const callLines = callLinesOf(await rowsOf(() => ctx.log.readMerged()), { phase: phaseOf(new Date()) })
    const report = reportOf({ round }, readings, attribution.map(lineOfAttribution), callLines)
    // 八元指标（架构 § 8.15）：**与上面那三个数同一个来源**（同一份日志 · 同样重算）。
    // 那一趟的日志就是刚才跑出来的那一份——所以 `--metrics` 印的就是这一趟。
    const metrics = flags.has('metrics') ? await computeAllMetrics(() => ctx.log.readMerged(), { round }) : null

    return emitRunFace({ json, flags, run: started, stops, deniedAction, report, attribution: [...attribution], metrics })
  } catch (err) {
    if (err instanceof RoundRunError) return fail(`${err.at}：${err.message}`, json)
    if (err instanceof RoundStartError) return fail(err.message, json)
    throw err
  } finally {
    // **agent 那几个口由调用方关**（`runRound` 只借不还）。
    await closeAgentLogs()
    await ctx.close()
  }
}

/**
 * 一轮跑完之后那张面：**`round run` 与 `round work` 共用一份**（同一份读数 · 两个入口）。
 *
 * 它从 `RoundRun` 那一个返回值渲染两档（人面与 `--json`）——两档同源是那一份返回值的性质，
 * 不是这一处的自觉：能印的都在 `RoundRun` 里，印不出来的这里也编不出来。
 *
 * 返回值就是这一趟的退出码：**验收过了 0 · 没过 1**（不是用法错——这一趟真的跑了）。
 */
function emitRunFace(o: {
  readonly json: boolean
  readonly flags: Map<string, string | true>
  readonly run: RoundRun
  readonly stops: readonly AgentStop[]
  readonly deniedAction: { readonly agent: AgentId; readonly exit: number; readonly denied: boolean; readonly note: string } | null
  readonly report: Awaited<ReturnType<typeof reportOf>>
  readonly attribution: readonly string[]
  readonly metrics: Awaited<ReturnType<typeof computeAllMetrics>> | null
}): number {
  const { json, flags, run, stops, deniedAction, report, attribution, metrics } = o
  if (json) {
    emitJson({
      round: run.round,
      base: run.base,
      state: run.state,
      contracts: run.batch.contracts.map((c) => ({ id: c.id, agent: c.agent, kind: c.kind })),
      precheckPlanning: run.precheckPlanning,
      precheckMerge: run.precheckMerge,
      drift: run.drift === null ? null : { ok: run.drift.ok, dirty: run.drift.dirty, colliding: run.drift.colliding },
      fold: run.fold.kind === 'folded' ? { kind: 'folded', steps: run.fold.steps } : { kind: 'conflict' },
      conflictTree: run.conflictTree,
      verify: { pass: run.report.pass, fail: run.report.fail, unrunnable: run.report.unrunnable, ok: run.report.ok },
      assertions: run.report.results,
      advanced: run.advanced === null ? null : { written: run.advanced.written, removed: run.advanced.removed, skipped: run.advanced.skipped },
      deniedAction,
      // **每一格为什么停**（`--live` 才有；打桩那一档是空数组——那句话不在打桩那条路上）。
      agents: stops,
      // **`--json` 与文字那一档给的是同一件事**：文字那一档 `--metrics` 印的是八元指标
      // （`lineOf`），所以这一档的 `metrics` 就是那八条；不给 `--metrics` 时是 `null`。
      // （原先这一栏放的是 `report.readings`——那是**打回**那三个数，与 `--report` 同源，
      // 而八元指标另挂在 `probe` 那一栏。两条路给的不是一件事，名字还都叫指标。）
      metrics: metrics === null ? null : [...metrics],
      report: report.readings,
      attribution: [...attribution],
      // 逐趟账：`--json` 与文字那一档给的是同一件事（同一个数组的两档渲染）。
      callLines: [...report.callLines],
    })
  } else {
    emitLine(`${run.round}\t${run.base}\t${run.state}`)
    emitLine(`  契约 ${run.batch.contracts.length} 份：${run.batch.contracts.map((c) => c.id).join(' · ')}`)
    emitLine(`  预检：Planning ${run.precheckPlanning} 对 · 合并前 ${run.precheckMerge.count} 对`)
    emitLine(`  折叠：${run.fold.kind === 'folded' ? `折了 ${run.fold.steps} 步` : '停在冲突上'}`)
    emitLine(`  验收：通过 ${run.report.pass} · 没通过 ${run.report.fail} · 跑不起来 ${run.report.unrunnable}`)
    if (run.advanced !== null) {
      emitLine(`  推进：写 ${run.advanced.written.length} 条 · 删 ${run.advanced.removed.length} 条 · 跳 ${run.advanced.skipped.length} 条`)
    } else {
      emitLine('  推进：没有（验收没过——真实工作树一个字节都没动）')
    }
    if (deniedAction !== null) emitLine(`  被拒的动作：exit ${deniedAction.exit} · denied=${String(deniedAction.denied)}（${deniedAction.note}）`)
    // **停因**：一行一格。它只在真驱动那一档有内容（打桩那一档 `stops` 是空的）。
    for (const s of stops) emitLine(`  停因：${s.agent} ${s.steps} 步 · ${s.stopped}`)
    if (flags.has('report')) {
      emitLine(REPORT_HEAD)
      for (const l of report.lines) emitLine(`  ${l}`)
      emitLine('归因三处对照（闸四：命中落在哪一段；三行恒在，缺的写「没有读数」）：')
      for (const l of report.attributionLines) emitLine(`  ${l}`)
      // **每趟 `usage` 一行**（`G5` 那句话的兑现）：末行是合计，钱按官方价目表算。
      emitLine('逐趟账（每一条 `llm/call` 一行，末行是合计；钱按官方价目表算）：')
      for (const l of report.callLines) emitLine(`  ${l}`)
    }
    if (metrics !== null) {
      emitLine(METRICS_HEAD)
      for (const m of metrics) emitLine(`  ${lineOf(m)}`)
    }
    if (!run.report.ok) {
      for (const r of run.report.results.filter((x) => x.verdict !== 'pass')) {
        process.stderr.write(`${r.verdict}\t${r.assertion}\t${r.note}\n`)
      }
    }
  }
  // 没通过那一档：退出码 1（**不是用法错**：这一趟真的跑了，只是没通过）。
  return run.report.ok ? 0 : 1
}

/**
 * 漂移检那三条读数原样报到 stderr（两个入口共用一份措辞）。
 *
 * **拒了也要说得出是哪一边**：判据的两边（这次合并动到哪些 · 盘上与目标树不同的那些）都印出来，
 * 否则一句"漂移检没过"说不清是用户改了什么还是这次合并算错了。
 */
function reportDrift(d: DriftVerdict): void {
  const covered = d.drift.colliding.length === 0 ? '（没有）' : d.drift.colliding.join(' · ')
  process.stderr.write(
    `漂移检：HEAD ${d.drift.headMoved ? '动了' : '没动'} · 这次合并动到 [${d.drift.touched.join(' · ')}] · ` +
      `盘上与目标树不同 [${d.drift.divergent.join(' · ')}] · 会被覆盖的（盘上既不是底也不是目标树）[${covered}]\n`,
  )
}

/**
 * 持轮者那一格的接线（**两处共用**：`round plan` 的预备态那一趟 · `fugue say` 的两个状态）。
 *
 * 四样东西一处给：**视图**（持轮者写它 · 调用方读它是同一个对象——两处各开一份的症状是"草案不在
 * 视图里"）· **工具面**（与子 agent 同一个宿主、同一份公布目录：不给持轮者加工具，架构 § 15.4；
 * 差别只落在作用域上——`src/round/plan.ts` 的 `holderFace` 拦下物化与提交那三条，`execRoot`
 * 那一栏不给，预备态不物化所以没有可执行的树）· **句柄**（`handleFor`：B 区那两段与 C 区第一条
 * 由这一趟定）· **怎么调模型**（真网络 / 回放 / 落盘三档只看传输那一层）。
 *
 * 它还读一次**这一轮的会话记录**（`.fugue/session/<轮次>.jsonl`，架构 § 9.10）——那一段投影是
 * 持轮者 B 区的「凝聚前最近几次原文」，生产者是 `fugue say`（架构 § 8.11）。
 */
async function holderWiringOf(o: {
  readonly root: string
  readonly ctx: Ctx
  readonly doc: ConfigDoc
  readonly round: RoundId
  readonly wire: WireFlags
  readonly judge: boolean
  /** B 区那一段：轮级意图那一句。 */
  readonly goal: string
  /** B 区那一段：上一版凝聚理解（`holder/distill` 的最后一条）。 */
  readonly distill: string
  /**
   * **这一趟的产物是那一份草案**（预备态那一趟）——给了它才有末尾那一句与写入面那一栏。
   *
   * 讨论态那一趟不给：那一趟的产物是"修正后的理解"（不落文件 · 处境不动），说一句"往
   * `.fugue/plan/` 里写"是错的（架构 § 15.1.a 那张表的两行）。
   */
  readonly draftPath?: RelPath
}): Promise<{
  readonly base: CommitId
  readonly view: View
  readonly head: CommitId
  readonly execute: ToolExecutor
  readonly decl: ModelDecl
  readonly call: CallModel
  readonly tools: readonly ToolEntry[]
  readonly baseState: AssembleState
  readonly recent: string
  readonly handleFor: (over: { readonly runtime: string; readonly recent: string }) => AgentHandle
}> {
  // **钉住底**（读一次，然后传下去）：视图铺在它上面，日志里 `round/state` 那条链也以它为准。
  // **这一趟的产物那一句拼在「工作总目标」那一段的末尾**（近因：模型读到的最后一处说什么，它
  // 就做什么），而**要什么产物本来就是意图的一部分**——所以不另起一段。出处：S9 真档取证。
  // **收工口径那两句也在这一处**（`holderGoalText` 里，排在产物说明之前）：这一格几步 · 有没有
  // 可执行的树，与"要什么产物"同一档——都是模型无从得知、而这一趟非知道不可的事实。
  const goalText =
    o.draftPath === undefined
      ? o.goal
      : holderGoalText(
          o.goal,
          o.draftPath,
          Object.keys(actionsTableOf(o.doc)).sort(),
          o.wire.maxSteps,
          actionCommandsOf(o.doc),
        )
  const base = await pinnedBase(o.ctx.truth)
  const view = await loadView(o.ctx.log, 'round' as WriterId, { lower: lowerAt(o.ctx.truth, base) })
  const head = await refHeadOf(o.ctx.log, 'round' as WriterId, base)
  const host = createToolHost(view, o.ctx.roots, {
    actions: { writer: 'round' as WriterId, log: o.ctx.log, truth: o.ctx.truth, head },
  })
  const execute = createToolExecutor({
    logOf: () => o.ctx.log,
    host,
    // **写入面那一栏**（架构 § 15.4：权限差别落在输入与作用域上）：持轮者那一趟只有草案那一棵
    // 写得下去。讨论态那一趟不给它——那一趟没有产物文件（见 `draftPath` 那一栏）。
    ...(o.draftPath === undefined ? {} : { planPath: o.draftPath }),
    fenceOf: (raw, cwd) => {
      const got = o.ctx.roots.resolveVirtual(raw, cwd as RelPath)
      return got.ok ? { ok: true as const, value: got.value } : { ok: false as const, error: got.error }
    },
  })
  const decl = modelDeclOf(DEFAULT_MODEL.id)
  const baseState = stateWithState(emptyState(), o.doc, o.root)
  // 「凝聚前最近几次原文」：**会话记录那一段投影**（最近 3 条）。记录不在就是空串——第一次说话
  // 之前这一场对话还没有一条。
  const sessionBytes = await view.read(sessionPathOf(o.round))
  const recent = recentOf(sessionBytes === null ? '' : new TextDecoder().decode(sessionBytes))
  const handleFor = (over: { readonly runtime: string; readonly recent: string }): AgentHandle => ({
    agent: 'round' as AgentId,
    // **持轮者那一格没有 agent 这一栏**（架构 § 8.11：它手里是全部契约，不是一份）。
    coord: null,
    branch: 'refs/heads/main' as BranchId,
    contract: '' as ContractId,
    protocol: HOLDER_PROTOCOL,
    model: decl.id,
    wireModel: decl.model,
    target: targetAt(decl.id, credentialFor(decl, o.wire, o.judge)),
    adapter: { name: decl.wire },
    // **轮内固定的调用配置**（架构 § 10.2 的必固四条之一）**在声明里，而这里必须把它接上**。
    // 这一栏原先一处都没接：声明里那两栏是空的，于是没人看得出来"声明了却没发出去"——思考那一格
    // 一开就露了（真档第一趟读到的 `max_tokens` 是那条线的兜底 4096，而声明里写的是 32K）。
    call: decl.call,
    // C 区那一段 = **头**（人说的那一句：`runtime`）+ 只追加的尾巴（走过的那几步）——见
    // `assemble/sources.ts` 的 `cZoneHeadOf`。头是空的就不写这一栏（那时全文与尾巴逐字节相同）。
    state: {
      ...baseState,
      goal: goalText,
      distill: o.distill,
      recent: over.recent,
      ...(over.runtime === '' ? {} : { runtime: over.runtime }),
    },
  })
  const pump = o.wire.wireIn === undefined ? undefined : wireInTransport(o.wire.wireIn)
  const call = o.wire.dumpDir === undefined ? wireCallOver(pump) : makeDumpCall(o.wire.dumpDir, pump)
  return { base, view, head, execute, decl, call, tools: publishedCatalog(), baseState, recent, handleFor }
}

/**
 * `fugue round plan <目标>`：**预备态那一趟**——持轮者自己读 · 自己设计 · 自己拆，**停在门口**等人批。
 * 出处：架构 § 15.1.a（落地 · 四步里的"拆" · "预备态的出口是一道默认为停的门" · 出口三档）·
 * PLAN § 5.10 的 `C1` 行。
 *
 * 这一层只做三件事：把持轮者那一格接起来（视图 · 工具面 · 怎么调模型）· 把读数排成两列 ·
 * 决定退出码。**判据不在这里**：键域那一条住 `src/contract/draft.ts`，"三档出口"住
 * `src/round/plan.ts`。它**一个契约都不发 · 一条分支都不起 · 一片物化都不铺**——那三样归
 * `round go`（架构 § 15.1.a："落地不是不可逆的一刻，派发才是"）。
 *
 * **一张视图两处用**：持轮者写草案的那一份与这里读草案的那一份是**同一个对象**。两处各开一份
 * 的症状是"草案不在视图里"，而那时错的是接线，不是模型。
 *
 * `--judge` 是人喊停那一档：**不请模型跑**，拿视图里那一份直接判。三条路收完都进同一个判，
 * 所以"模型知不知道该收工"这件事不押在模型身上；它同时是这一站的地板——模型换了 · 协议换了 ·
 * `exit_plan_mode` 哪天不叫这个名字了，人喊停那一下照样把门打开（PLAN § 5.10）。
 */
export async function roundPlan(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const goal = args[0]
  if (goal === undefined || goal === '') return usageFail('round plan 需要 <目标>：轮级意图的那一句', json)
  const judge = flags.has('judge')
  const wire = wireFlagsOf(root, flags)
  if (judge && (wire.live || wire.wireIn !== undefined)) {
    return usageFail('--judge 不跑模型：它与 --live / --wire-in 不能一起给（那两档要发真调用，而这一档一步都不走）', json)
  }

  let doc: ConfigDoc
  try {
    doc = await readConfig(root)
  } catch (err) {
    if (err instanceof ConfigError) return fail(err.message, json)
    throw err
  }
  const rawRound = getConfig(doc, 'round.id')
  const round = typeof rawRound === 'string' && rawRound !== '' ? rawRound : 'r1'
  const draftPath = draftPathOf(round)

  const ctx = await openCtx(root, flags, { sync: 'each', write: true })
  try {
    // **这一趟的那份读数：一遍**（`round/versions.ts`）。开跑时读一次、往下递——接线的「凝聚理解」
    // 那一栏 · 轮次那一层的处境与「上一版是哪一版」 · 放过的那几批 · 写完之后印的版本那一栏，
    // 全是它的投影（`PlanDeps.facts` 那条缝）。
    const facts = await roundFactsOf(ctx.log, round)
    // 持轮者那一格的接线（视图 · 工具面 · 句柄 · 怎么调模型）：一处，`fugue say` 的两个状态
    // 走的是同一份（见 `holderWiringOf`）。
    const w = await holderWiringOf({
      root,
      ctx,
      doc,
      round,
      wire,
      judge,
      goal,
      // **凝聚理解**（架构 § 15.1.a 的 B 区那一段）：链尾那一版的正文（同一份读数）。
      distill: lastOf(facts)?.body ?? '',
      // 预备态那一趟的产物是那份草案：末尾那一句与写入面都按它走（讨论态那一趟不给）。
      draftPath,
    })
    const { base, view, execute, decl, call, tools, baseState } = w
    // 这一趟的句柄：**C 区第一条是空的**（这一趟没有人的话——那是 `fugue say` 那一格），
    // B 区那一段投影照 `holderWiringOf` 读出来的会话记录给。
    const handle: AgentHandle = w.handleFor({ runtime: '', recent: w.recent })

    const r = await planRound({
      base,
      view,
      log: ctx.log,
      facts,
      round,
      goal,
      // **同上一个分配器**：门判出来的那一批契约的身份，就是放行那一下要发的那些（门只认契约集合）。
      identityFor: (n: number) => identFor(round, n),
      // 持轮者给的断言只能从绑好的动作里选（`actions.<名字>` 那一份表）。
      actions: actionsTableOf(doc),
      handle,
      decl,
      call,
      execute,
      tools,
      ...(wire.maxSteps === undefined ? {} : { maxSteps: wire.maxSteps }),
      ...(judge ? { judgeOnly: true } : {}),
      occupancy: {
        decl,
        base: baseState,
        goal,
        round,
        ...(wire.maxSteps === undefined ? {} : { maxSteps: wire.maxSteps }),
        tools: JSON.stringify(tools),
      },
    })

    const draft = r.gate.draft
    const built = r.gate.built
    // **这一批的编号**（拆分的形状）：与 `round go` 落进 `round/approve` 的是同一个函数算的。
    const fingerprint = built === null ? null : fingerprintOf(built)
    // **同号不是凭证**（架构 § 15.1.a）：日志里放过的那几批里"与这一批同形"的那一个只是给人看的
    // 读数——它换不来放行，新的一批照样停在门口。
    const earlier = fingerprint === null ? [] : facts.approvals
    const same = earlier.find((x) => x.fingerprint === fingerprint) ?? null
    // **版本那一栏：一次读，两个渲染器**（PLAN § 5.12 的 C5.b「与 `--json` 那两栏同源」）——下面
    // 机器面那几栏与人面那几行出自同一张 `VersionFace`。**这一趟没写出草案时那一栏是空的**
    // （`landing` 为空；判据与人面印那一处逐字相同：人面不印的处境，机器面也不该报一个旧的号）。
    // **写完之后不再读一遍**：把这一趟落下的那一版接回开跑时那份读数上（`withVersion`）。
    const version = r.landing === null ? null : latestFaceOf(withVersion(facts, r.landing))
    if (json) {
      emitJson({
        round: r.round,
        base: r.base,
        draftPath,
        exit: r.exit,
        steps: r.steps,
        stopped: r.stopped,
        held: r.held,
        problems: [...r.gate.problems],
        draftText: r.draftText,
        sections: (draft?.sections ?? []).map((s0) => ({
          kind: s0.kind,
          goal: s0.kind === 'implement' ? s0.goal : s0.question,
        })),
        // **判出来的那一批**：门停着的时候它已经造好了——一个字节都没发。
        contracts: (built?.contracts ?? []).map((c) => ({ id: c.id, agent: c.agent, kind: c.kind, paths: writeSetPaths([c]) })),
        seedLimit: built?.seedLimit ?? null,
        seedTokens: built === null ? [] : [...built.seedTokens],
        intersections: r.gate.precheck?.lines ?? [],
        fingerprint,
        sameAs: same === null ? null : same.round,
        seedRead: r.seedRead,
        occupancy: [...r.occupancy],
        // **版本那一栏**（`versionJsonOf`：`VersionFace` 逐字段投影）——与人面那几行同源。
        version: versionJsonOf(version),
      })
    } else {
      emitLine(`${r.round}\t${r.held ? '停在门口' : '退回'}\t${r.steps} 步\t${r.exit}`)
      emitLine(`  收工：${r.exit}（${r.stopped}）`)
      emitLine(
        `  草案：${draftPath}\t${
          r.draftText === null ? '没有写出来' : `${estimateTokensOfText(r.draftText)} token（那把尺的估账）· 正文进日志 holder/distill`
        }`,
      )
      // **人面那一栏**（C5.b）：这一版是第几版 · 与上一版差在哪几节——与上面 `--json` 那几栏
      // 读的是同一张读数（`version`）。
      if (r.draftText !== null) {
        for (const line of versionLinesOf(version, '预备态')) emitLine(line)
      }
      if (draft !== null) {
        emitLine(`  要开 ${draft.sections.length} 个任务：`)
        for (const [k, s0] of draft.sections.entries()) {
          emitLine(`    第 ${k + 1} 节\t${s0.kind}\t${s0.kind === 'implement' ? s0.goal : s0.question}`)
          if (s0.kind === 'implement') {
            emitLine(`      写入面：${s0.ownedPaths.join(' · ') || '（空）'}`)
            if (s0.deliverables.length > 0) emitLine(`      交付物：${s0.deliverables.map((d) => `${d.path}（${d.form}）`).join(' · ')}`)
            emitLine(`      验收：${s0.assertions.map((a) => `${a.name}（${a.action}）`).join(' · ') || '（一条都没有）'}`)
          } else {
            emitLine(`      要交的证据：${s0.evidenceRequired.map((e) => e.note).join(' · ') || '（没有）'}`)
          }
        }
        emitLine(
          `  种子\t在持轮者那份视图上取到 ${r.seedRead.loaded} 份内容` +
            (r.seedRead.missing.length === 0 ? '' : `\t这一棵树上没有：${r.seedRead.missing.join(' · ')}`),
        )
      }
      // **判出来的那一批契约**（门后面那一批）：停着的时候它已经在了，人批的就是它。
      if (built !== null && r.gate.precheck !== null) {
        emitLine(`  判：${built.contracts.length} 份契约造得出来（值域持有者逐字段核过）· 还没发`)
        for (const c of built.contracts) emitLine(`    ${c.id}\t${c.agent}\t${c.kind}\t${writeSetLine(c)}`)
        emitLine(`  预检：${writeSetPaths(built.contracts).length} 条路径 · ${r.gate.precheck.intersections.length} 对相交`)
        for (const line of r.gate.precheck.lines) emitLine(`    ${line}（照发：这一站的口径是报出来、照发）`)
        emitLine(`  批号：${fingerprint}（这一批的编号——拆分的形状，不含轮次与身份）`)
        if (same !== null) {
          emitLine(`    与你在 ${same.round} 放过的那一批同号：编号只是一个名字，不作放行的凭证——新的一批照样停在这里等人点头`)
        }
      }
      if (draft !== null) {
        emitLine('  每一格的预估占用（三区 + 工具目录 + seed；估账，不是读数）：')
        for (const row of r.occupancy) {
          emitLine(
            `    第 ${row.at} 节\tseed ${row.seed}\tused ${row.used}\t触发点 ${row.trigger}\t与上限的差额 ${row.headroom}\t甜点=${row.sweet ? '是' : '否'}` +
              (row.sweet ? '' : `\t${row.why}`),
          )
        }
        if (draft.prose !== '') {
          emitLine('  为什么这么拆（模型写的）：')
          for (const line of draft.prose.split('\n')) emitLine(`    ${line}`)
        }
      }
      if (!r.held) {
        process.stderr.write('草案退回了（构造器不猜、不补）：\n')
        for (const one of r.gate.problems) process.stderr.write(`  ${one}\n`)
        process.stderr.write('改完再跑一遍：' + `fugue --root ${root} round plan ${JSON.stringify(goal)}\n`)
      } else {
        process.stderr.write(
          '门停在这里等人批：一个契约都没发 · 一条分支都没起 · 真实工作树一个字节没动。' +
            `放行是 \`fugue round go\`。\n`,
        )
      }
    }
    // **退回那一档是退出码 1**（不是用法错：这一趟真的跑了，只是草案不成立）。
    return r.held ? 0 : 1
  } catch (err) {
    if (err instanceof PlanError) return fail(err.message, json)
    if (err instanceof ConfigError) return fail(err.message, json)
    throw err
  } finally {
    await ctx.close()
  }
}

/**
 * `fugue say <一句话>`：**答完接着走**（架构 § 15.1.a 的"问与答" · PLAN § 5.10 的 `C5`）。
 *
 * 这一层只做三件事：把持轮者那一格接起来（与 `round plan` 同一份 `holderWiringOf`）· 把两个状态
 * 各自的读数排成人读的两列 · 决定退出码。**分岔不在这里**：它在 `src/round/say.ts` 里按
 * `round/state` 那条链重放出来的处境判（`Idle` = 讨论态 · `Planning` = 预备态）。
 *
 * **这一条没有"目标"这个参数**：预备态那一趟的「工作总目标」从日志里的 `round/intent` 读——
 * 同一轮里第二趟起，命令行那一句与日志里的意图会静默分家（架构 § 15.1 纪律 2）。
 */
export async function sayCommand(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  // **一句话可以是几个词**：命令行按空白分词，`fugue say 把解析器 拆成两格` 到这里是三个参数。
  const text = args.join(' ').trim()
  if (text === '') return usageFail('say 需要 <一句话>：那句话是这一趟的输入（架构 § 15.1.a 的"问与答"）', json)
  const wire = wireFlagsOf(root, flags)
  let doc: ConfigDoc
  try {
    doc = await readConfig(root)
  } catch (err) {
    if (err instanceof ConfigError) return fail(err.message, json)
    throw err
  }
  const rawRound = getConfig(doc, 'round.id')
  const round = (typeof rawRound === 'string' && rawRound !== '' ? rawRound : 'r1') as RoundId
  const ctx = await openCtx(root, flags, { sync: 'each', write: true })
  try {
    // **一次读**（`round/versions.ts`）：意图那一句与这一轮当下的那一版草案是同一份读数里的两样。
    const facts = await roundFactsOf(ctx.log, round)
    const distill = lastOf(facts)?.body ?? ''
    const w = await holderWiringOf({
      root,
      ctx,
      doc,
      round,
      wire,
      // 说话那一趟**没有 `--judge`**：人的话必须真的到持轮者手里，一步都不能省（那一档是"人喊停、
      // 不请模型跑"，与"人说话"是两件事）。
      judge: false,
      goal: facts.goal,
      distill,
      // **预备态那一趟才有产物文件**：讨论态（Idle）那一趟的产物是"修正后的理解"，不落文件。
      ...(facts.state === 'Planning' ? { draftPath: draftPathOf(round) } : {}),
    })
    const makeHandle = (over: { readonly runtime: string; readonly recent: string }): AgentHandle =>
      w.handleFor({ runtime: over.runtime, recent: over.recent })
    const r = await sayRound({
      round,
      text,
      view: w.view,
      log: ctx.log,
      facts,
      truth: ctx.truth,
      writer: ctx.writer,
      head: w.head,
      goal: facts.goal,
      distill,
      makeHandle,
      call: w.call,
      execute: w.execute,
      tools: w.tools,
      ...(wire.maxSteps === undefined ? {} : { maxSteps: wire.maxSteps }),
      // 预备态那一趟就是 `round plan` 那一趟（同一个判据 · 同一份身份分配器 · 同一段估账）——
      // 差别只有一处：C 区第一条是人的那一句话。
      plan: async (over) =>
        await planRound({
          base: w.base,
          view: w.view,
          log: ctx.log,
          facts,
          round,
          goal: over.goal,
          identityFor: (n: number) => identFor(round, n),
          actions: actionsTableOf(doc),
          handle: makeHandle({ runtime: over.runtime, recent: over.recent }),
          decl: w.decl,
          call: w.call,
          execute: w.execute,
          tools: w.tools,
          ...(wire.maxSteps === undefined ? {} : { maxSteps: wire.maxSteps }),
          occupancy: {
            decl: w.decl,
            base: w.baseState,
            goal: over.goal,
            round,
            ...(wire.maxSteps === undefined ? {} : { maxSteps: wire.maxSteps }),
            tools: JSON.stringify(w.tools),
          },
        }),
    })
    // **版本那一栏：一次读，两个渲染器**（同上）。**这一趟落了东西才有这一栏**：讨论态那一趟落的
    // 是一段话、预备态那一趟改的是那份草案——两态收在同一栏 `landing` 里（`sayRound` 一处给），
    // 所以机器面不会在"这一趟什么都没落"时报一个旧的号。**写完之后不再读一遍**（`withVersion`）。
    const version = r.landing === null ? null : latestFaceOf(withVersion(facts, r.landing))
    if (json) {
      emitJson({
        round: r.round,
        where: r.where,
        state: r.state,
        text: r.text,
        sessionPath: r.sessionPath,
        records: r.records,
        badLines: r.badLines,
        recent: r.recent,
        distill: r.distill,
        notes: [...r.notes],
        steps: r.steps,
        exit: r.exit,
        stopped: r.stopped,
        held: r.plan === null ? null : r.plan.held,
        draftPath: r.plan === null ? null : draftPathOf(round),
        problems: r.plan === null ? [] : [...r.plan.gate.problems],
        contracts: r.plan?.gate.built?.contracts.length ?? 0,
        occupancy: r.plan === null ? [] : [...r.plan.occupancy],
        // **版本那一栏**（`versionJsonOf`）——与人面那几行同源。
        version: versionJsonOf(version),
      })
    } else {
      emitLine(`${r.round}\t${r.where}\t${r.steps} 步\t${r.exit}`)
      emitLine(`  收工：${r.exit}（${r.stopped}）`)
      emitLine(`  那句话：${r.text}`)
      emitLine('  它进的是这一趟的尾端（C 区第一条）：这一步之后的每一步都读得到它')
      if (r.where === '讨论态') {
        emitLine(`  对话：${r.sessionPath}\t${r.records} 条${r.badLines === 0 ? '' : `（读不出来 ${r.badLines} 行）`}`)
        emitLine(`  进前缀的那一段：最近 ${RECENT_COUNT} 条原文（${estimateTokensOfText(r.recent)} token）`)
        for (const line of r.recent.split('\n')) emitLine(`    ${line}`)
        emitLine(
          r.distill === null
            ? '  凝聚：这一趟没落下新的那一段（它一句话都没说出来）'
            : `  凝聚：修正后的理解 ${estimateTokensOfText(r.distill)} token → 一条 holder/distill（正文全文进日志）`,
        )
        // **人面那一栏**（C5.b）：这一版是第几版（讨论态落的是话，逐节差异那一栏不印）。
        if (r.distill !== null) {
          for (const line of versionLinesOf(version, '讨论态')) emitLine(line)
        }
        emitLine(`  这一态的处境没动：${r.state}（讨论不落地——落地是 fugue round plan <目标>）`)
      } else {
        emitLine(`  草案：${draftPathOf(round)}\t这一趟改的是它（原话不另存：工作区里找不到第二份）`)
        // **人面那一栏**（C5.b）：这一版是第几版 · 与上一版差在哪几节。
        if (r.plan?.draftText != null) {
          for (const line of versionLinesOf(version, '预备态')) emitLine(line)
        }
        emitLine(
          `  判：${r.plan?.held === true ? '仍然停在门口' : '退回'}\t契约造得出来 ` +
            `${r.plan?.gate.built?.contracts.length ?? 0} 份 · 一份都没发`,
        )
      }
      for (const note of r.notes) process.stderr.write(`${note}\n`)
      if (r.where === '预备态') {
        if (r.plan?.held === true) {
          process.stderr.write('门停在这里等人批：放行是 `fugue round go`。\n')
        } else {
          process.stderr.write('草案退回了（构造器不猜、不补）：\n')
          for (const one of r.plan?.gate.problems ?? []) process.stderr.write(`  ${one}\n`)
        }
      }
    }
    // 退出码：**讨论态没落下产物**（那句话没换来一段理解）与**预备态退回**都是 1——这一趟真的跑
    // 了，只是没换来东西（不是用法错）。
    if (r.where === '讨论态') return r.distill === null ? 1 : 0
    return r.plan?.held === true ? 0 : 1
  } catch (err) {
    if (err instanceof SayError) return fail(err.message, json)
    if (err instanceof PlanError) return fail(err.message, json)
    if (err instanceof ConfigError) return fail(err.message, json)
    throw err
  } finally {
    await ctx.close()
  }
}

/**
 * `fugue round work`：**放行之后接着跑**（架构 § 15.1.a 的"派"之后那一环 · PLAN § 5.11 的判据一句话）。
 *
 * **它与 `round run` 的分界只有一处：这一批契约从哪儿来。** `round run` 从配置里的 `round.split`
 * 造（人拆那一档 · 从 `Idle` 起头）；这一条**从日志里读回**——`contract/issue` 的正文与
 * `round/intent` 的底（`round/issuedBatchOf`）。一句配置都不看、一份契约都不重算，所以"人批的是
 * 哪一批"这件事在这一条路上不可能漂。其余全部相同：跑格 → 合并前预检 → 折叠 → 漂移检 → 验收 →
 * 定格 + 推进，走的是同一个 `runIssued`。
 *
 * **断言从契约里来**：契约只带动作名（架构 § 8.12），命令行从配置里绑好的动作读
 * （`actions.<名字>` 的 `argv`）——绑不上就当场拒，不拿一条空命令顶。
 *
 * 处境不是 `Working` 时当场拒并指一条路（`whyNotWorking`）；已经交过卷的格不重跑
 * （`runIssued` 从那条分支上取回它那个提交）。
 */
export async function roundWork(root: string, flags: Map<string, string | true>, args: string[], json: boolean): Promise<number> {
  if (args.length > 0) {
    return usageFail(`round work 不带位置参数：拿到的是 ${args.join(' ')}（目标那一句在 round plan 那一趟给）`, json)
  }
  let doc: ConfigDoc
  try {
    doc = await readConfig(root)
  } catch (err) {
    if (err instanceof ConfigError) return fail(err.message, json)
    throw err
  }
  const rawRound = getConfig(doc, 'round.id')
  const round = typeof rawRound === 'string' && rawRound !== '' ? rawRound : 'r1'

  const wire = wireFlagsOf(root, flags)
  const real = wire.live || wire.wireIn !== undefined
  const handoff = flags.has('no-handoff') ? false : undefined
  const retriesLeft = numberOf(flags.get('retry'), 0) ?? RETRY_DEFAULT
  // **一个 agent 一个日志口、由调用方持有**（与 `round run` 同一条：`hold.ts` 那道栅栏）。
  const agentLogs = new Map<AgentId, LogHandle>()
  const agentLogOf = (a: AgentId): Log => {
    const hit = agentLogs.get(a)
    if (hit !== undefined) return hit
    const made = openLog(root, { write: a as WriterId, sync: 'each' })
    agentLogs.set(a, made)
    return made
  }
  const closeAgentLogs = async (): Promise<void> => {
    for (const [a, l] of agentLogs) {
      agentLogs.delete(a)
      await l.close()
    }
  }

  const ctx = await openCtx(root, flags, { sync: 'each', write: true })
  const stops: AgentStop[] = []
  try {
    // 一 · **这一批从日志来**（这一条与 `round run` 的全部差别就在这一行）。
    const batch = await issuedBatchOf(ctx.log, round)
    // 二 · 接上那条尾巴（与 `round run` 同一个函数）。
    const run = await runIssued(
      {
        roots: ctx.roots,
        truth: ctx.truth,
        log: ctx.log,
        round,
        logOf: agentLogOf,
        closeAgentLogs,
        stub: real
          ? realDriver({
              onResult: (agent, r) => {
                stops.push({ agent: String(agent), steps: r.steps, stopped: r.stopped })
              },
            })
          : stubDriver(stubOfIssued(ctx)),
        specsOf: specsOfContract(doc),
        retriesLeft,
        strictMergeGate: flags.has('strict-merge-gate'),
        ...(wire.maxSteps === undefined ? {} : { maxSteps: wire.maxSteps }),
        ...(handoff === undefined ? {} : { handoff }),
        ...(real
          ? {
              driver: driverSupport({
                root,
                doc,
                ...(wire.wireIn === undefined ? {} : { wireIn: wire.wireIn }),
                ...(wire.maxSteps === undefined ? {} : { maxSteps: wire.maxSteps }),
                ...(wire.credential === undefined ? {} : { credential: wire.credential }),
                ...(wire.dumpDir === undefined ? {} : { dumpDir: wire.dumpDir }),
              }),
            }
          : {}),
        onDrift: reportDrift,
      },
      batch,
    )
    // 三 · 打回那三个数与八元指标（**与 `round run` 同一份读法**：同一份日志上的重算，不采集）。
    const readings = await computeAll(() => ctx.log.readMerged(), { round })
    const attribution = await computeAttribution(() => ctx.log.readMerged())
    const callLines = callLinesOf(await rowsOf(() => ctx.log.readMerged()), { phase: phaseOf(new Date()) })
    const report = reportOf({ round }, readings, attribution.map(lineOfAttribution), callLines)
    const metrics = flags.has('metrics') ? await computeAllMetrics(() => ctx.log.readMerged(), { round }) : null
    // **复用了哪几格**印在 stderr：它是"这一趟只补了没交卷的那几格"的读数（重跑不重复烧钱）。
    if (run.reused.length > 0) {
      process.stderr.write(
        `接着跑：${run.reused.length} 格已经交过卷（分支不是底了），取回它们的提交复用——没重跑：${run.reused.join(' · ')}\n`,
      )
    }
    return emitRunFace({ json, flags, run, stops, deniedAction: null, report, attribution: [...attribution], metrics })
  } catch (err) {
    if (err instanceof RoundWorkError) return fail(err.message, json)
    if (err instanceof RoundRunError) return fail(`${err.at}：${err.message}`, json)
    if (err instanceof RoundStartError) return fail(err.message, json)
    if (err instanceof BindingError) return fail(err.message, json)
    throw err
  } finally {
    await closeAgentLogs()
    await ctx.close()
  }
}

/**
 * 契约里的断言 → 真起的命令行。**契约只带动作名，argv 从工作区配置来**（架构 § 8.12：
 * "契约不认识命令行"——`Assertion` 只带 `action`，起进程那几样归 `M7` 与 `M5`）。
 *
 * 绑不上就当场拒（`readBinding` 报出那个名字与现有的那几个）：不猜、不补、不拿一条空命令顶。
 * 调查型契约没有断言（它的产物是证据），所以那一档给空数组——不是"少跑了一条"。
 */
function specsOfContract(doc: ConfigDoc): (c: Contract, agent: AgentId) => readonly AssertionRunSpec[] {
  return (c) => {
    const list = c.kind === 'investigate' ? [] : c.assertions
    return list.map((a) => {
      const b = readBinding(doc, a.action)
      return {
        assertion: a,
        argv: b.argv,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
        ...(b.cwd === '' ? {} : { cwd: b.cwd }),
      }
    })
  }
}

/**
 * 打桩那一档**只给 `round work` 用**（`round run` 那一份还带 `--fail` · `--deny` 那几个走查开关）。
 * 它写契约声明的第一条路径：新树 = 底那棵树 + 这一格的改动（与 `round run` 那一份同一条理由——
 * 只落改动那几条的话，底里其余的路径在目标树里都不存在，推进会当成"要删"）。
 */
function stubOfIssued(ctx: Ctx): Stub {
  return {
    run: async (agent, c, base, hint) => {
      if (c.kind === 'resolve' && hint !== undefined) {
        const inherited = new Map((await entriesOf(ctx.truth, hint.nextBranch)).map((e) => [e.name, e]))
        return ctx.truth.commit(await ctx.truth.putTree([...inherited.values()]), [base], `（打桩·解冲突）${agent}`)
      }
      const where = declaredSetOf(c)[0] ?? `stub-${c.id}.txt`
      const blob = await ctx.truth.putBlob(new TextEncoder().encode(`（打桩）${c.id} 改了 ${where}\n`))
      const merged = new Map((await entriesOf(ctx.truth, base)).map((e) => [e.name, e]))
      merged.set(where, { name: where, mode: 0o100644, id: blob })
      return ctx.truth.commit(await ctx.truth.putTree([...merged.values()]), [base], `（打桩）${agent}`)
    },
  }
}

/**
 * `fugue round go`：**放行**（架构 § 15.1.a 四步里的"派" · PLAN § 5.10 的 C4）。
 *
 * 这一层只做三件事：从配置里取轮次号与绑好的动作表 · 把日志里那一轮的那几样（钉住的底 · 那一份
 * 草案）交给 `dispatchRound` · 把读数排成两列。判 · 发 · 起分支 · 物化全在 `src/round/` 里。
 *
 * **放行的是日志里那一份草案**，不是视图里当下那一份：门那一趟把草案的正文落进了
 * `holder/distill`，重算的就是它——于是"人批的那一批"与"发出去的这一批"是同一个对象。
 *
 * **同号不作数。** 放行之前先读一遍日志里放过的那几批：有同号的就说出来（给人看"这一批与哪一批
 * 同形"），而它**不是**"照上次放行"的依据——新的一批一律要人再点一次头（架构 § 15.1.a）。
 */
export async function roundGo(root: string, flags: Map<string, string | true>, args: string[], json: boolean): Promise<number> {
  if (args.length > 0) {
    return usageFail(`round go 不带位置参数：拿到的是 ${args.join(' ')}（目标那一句在 round plan 那一趟给）`, json)
  }
  let doc: ConfigDoc
  try {
    doc = await readConfig(root)
  } catch (err) {
    if (err instanceof ConfigError) return fail(err.message, json)
    throw err
  }
  const rawRound = getConfig(doc, 'round.id')
  const round = typeof rawRound === 'string' && rawRound !== '' ? rawRound : 'r1'
  const materialize = flags.has('materialize')

  const ctx = await openCtx(root, flags, { sync: 'each', write: true })
  try {
    // **这一趟的那份读数：一遍**（含放过的那几批——这一笔写进去之后它就与这一批混在一起了）。
    const facts = await roundFactsOf(ctx.log, round)
    const earlier = facts.approvals
    const r = await dispatchRound({
      roots: ctx.roots,
      truth: ctx.truth,
      log: ctx.log,
      facts,
      round,
      // **与判那一趟同一个分配器**（`round plan` 那一趟用的是同一个 `identFor`）。
      identityFor: (n: number) => identFor(round, n),
      actions: actionsTableOf(doc),
      // **声明的上限接进 `seed` 那一条**：判那一趟（`round plan`）读的是同一份声明。
      modelLimit: modelLimitOf(),
      materialize,
      logForAgent: (a) => openLog(root, { write: a as WriterId, sync: 'each' }),
    })
    const same = earlier.find((x) => x.fingerprint === r.fingerprint) ?? null
    if (json) {
      emitJson({
        round: r.round,
        base: r.base,
        fingerprint: r.fingerprint,
        sameAs: same === null ? null : same.round,
        contracts: r.built.contracts,
        owners: r.owners,
        seedLimit: r.built.seedLimit,
        seedTokens: r.built.seedTokens,
        seedRead: r.seedRead,
        intersections: r.precheck.lines,
        materialized: materialize,
        branches: r.forks.map((f) => ({ agent: f.agent, base: f.base, strategy: f.strategy, merged: f.merged })),
        trail: r.trail,
      })
    } else {
      const owners = [...new Set(r.built.contracts.map((c) => c.agent))]
      emitLine(`${r.round}\t${r.base}\t放行：${r.built.contracts.length} 份契约\t${owners.length} 条分支`)
      for (const c of r.built.contracts) emitLine(`  ${c.id}\t${c.agent}\t${c.kind}\t${writeSetLine(c)}`)
      emitLine(`  批号：${r.fingerprint}（这一批的编号——拆分的形状，不含轮次与身份）`)
      if (same !== null) {
        emitLine(`    与你在 ${same.round} 放过的那一批同号：编号只是一个名字，不作放行的凭证`)
      }
      // **种子那一行不省**：量出来是 0 与"这一轮没有种子"在读数上分不开（见 `round new` 那一档）。
      emitLine(
        `  种子\t上限 ${r.built.seedLimit} token\t逐份 ${r.built.seedTokens.join(' · ') || '（没有）'}\t` +
          (r.seedRead.from === 'tree'
            ? `在钉住的底上取到 ${r.seedRead.loaded} 份内容`
            : '量法是调用方给的（这一层没量）') +
          (r.seedRead.missing.length === 0 ? '' : `\t这一棵树上没有：${r.seedRead.missing.join(' · ')}`),
      )
      for (const f of r.forks) emitLine(`  ${f.agent}\tfork ${f.strategy}\t${f.merged}`)
      if (r.forks.length === 0) {
        process.stderr.write('物化没有铺（架构 § 14.1 的 deferMaterialize：走按需物化）；要现在铺就加 --materialize\n')
      }
      process.stderr.write(`写入集预检：${writeSetPaths(r.built.contracts).length} 条路径 · ${r.precheck.lines.length} 对相交`)
      if (r.precheck.lines.length > 0) {
        process.stderr.write('，照发：\n')
        for (const l of r.precheck.lines) process.stderr.write(`  ${l}\n`)
      } else {
        process.stderr.write('\n')
      }
      // **发了就是发了**：契约逐条在日志里，分支定在同一个底上——这一轮的处境已经是 `Working`。
      process.stderr.write(
        `放行完了：${r.built.contracts.length} 份契约在日志里（contract/issue 逐条）· ${owners.length} 条分支定在 ${r.base}\n`,
      )
    }
    return 0
  } catch (err) {
    if (err instanceof RoundStartError) return fail(err.message, json)
    throw err
  } finally {
    await ctx.close()
  }
}

/**
 * 凭据：**三种档各取各的**，一处。`--judge` 与回放档都不取凭据——它们一个字节都不出网
 * （架构 § 10.5），而取凭据那一步在没有 key 时会当场拒：那与这两档无关。
 */
function credentialFor(decl: ReturnType<typeof modelDeclOf>, wire: WireFlags, judge: boolean): string {
  if (judge) return '--judge：不跑模型，不取凭据'
  if (wire.wireIn !== undefined) return wire.credential ?? '回放档：不出网，不取凭据'
  return authWith(providerOf(decl.provider), wire.credential ?? null)
}

/**
 * 人面那一栏：**这一版是第几版 · 与上一版差在哪几节**（PLAN § 5.12 的 C5.b）。
 *
 * **收的是一张读数，不是日志**（`latestFaceOf`）：同一条读数还有机器面那一个渲染器
 * （`versionJsonOf`），两处因此不会各算各的。`null` = 这一轮还没落过（那一栏不印）。
 *
 * 讨论态那一趟落的是**一段话**（凝聚理解）不是草案——那时只印第几版，逐节差异那一栏不印
 * （`versionFaceOf` 的 `why` 说得出来原因）。
 */
function versionLinesOf(face: VersionFace | null, where: '讨论态' | '预备态'): string[] {
  if (face === null) return []
  const head = `  版本：第 ${face.version} 版（这一轮第 ${face.landing} 次落地）`
  if (face.same) return [`${head}\t与上一趟逐字节相同`]
  if (face.why !== null) return where === '讨论态' ? [head] : [`${head}\t${face.why}`]
  // **比的是哪一版由读数给**（`againstVersion`）：回退那一趟它不是 `version - 1`（见 `versionFaceOf`）。
  const vs = face.againstVersion === null ? '第一版' : `与第 ${face.againstVersion} 版比`
  return [`${head}\t${vs}：${face.lines.length} 处`, ...face.lines.map((l) => `    ${l}`)]
}

/**
 * 机器面那一栏：**同一张读数的另一个渲染器**（PLAN § 5.12 的 C5.b「与 `--json` 那两栏同源」）。
 *
 * **逐字段投影，一个名字都不改**——`--json` 那一栏的形状就是 `VersionFace` 本身，所以人面与机器面
 * 之间没有可漂移的余地（口径只有一处：`round/versions.ts` 的 `versionFaceOf`）。这一轮还没落过就是
 * `null`：那一栏在、值是空的，与"这一栏不存在"分得开。
 */
function versionJsonOf(face: VersionFace | null): VersionFace | null {
  return face === null ? null : { ...face, lines: [...face.lines] }
}

/**
 * **真让内核拒一次写。** 把那棵树设成只读，再往树里一条**已经存在的文件**追加一个字节——
 * `open(O_APPEND)` 拿 EROFS / EACCES，退出码非零，stderr 上是内核那句话。
 *
 * `denied` 是**读出来的**（`exec.ts` 读 stderr 上的拒绝签名，与 `run/end` 那一栏同一个口径），
 * 所以这一处读的也是 stderr，**不自己写一个 `denied: true`**。
 */
async function refuseOneWrite(
  truth: TruthHandle,
  commit: CommitId,
  prefix: string,
): Promise<{ exit: number; denied: boolean; note: string }> {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  await materializeCommit(truth, commit, dir)
  const victim = join(dir, (await entriesOf(truth, commit))[0]?.name ?? 'x')
  const readOnly = (p: string): void => {
    chmodSync(p, 0o444)
  }
  try {
    readOnly(victim)
    const r = spawnSync('/bin/sh', ['-c', `printf x >> ${JSON.stringify(victim)}`], { encoding: 'utf8' })
    const stderr = r.stderr ?? ''
    const denied = (r.status ?? 1) !== 0 && /read-only|Read-only|EROFS|Permission denied|Permission denied/i.test(stderr)
    return {
      exit: r.status ?? 1,
      denied,
      note: denied ? `内核拒了这次写（${stderr.trim().split('\n')[0] ?? ''}）` : `写入没被拒（stderr：${stderr.trim().slice(0, 80)}）`,
    }
  } finally {
    chmodSync(victim, 0o644)
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 配置里的一条断言：`{ name, argv, expect?, where? }`。**它与契约的 `Assertion` 是两个形状**
 * （那一份只有动作名），所以这一步是"动作名 → 命令行"翻译的落点，而今天它读的是配置。 */
interface AssertionSpec {
  readonly name: string
  readonly argv: readonly string[]
  readonly expect: number
}

/** 读配置里的断言那一栏。**解析不了就拒**，不当成"没有断言"（那会让轮次静默地没有判据）。 */
function readAssertions(doc: ConfigDoc): AssertionSpec[] {
  const v = getConfig(doc, 'round.assertions')
  if (v === undefined) return []
  const list = typeof v === 'string' ? JSON.parse(v) : v
  if (!Array.isArray(list)) throw new RoundStartError('round.assertions 要是一个数组')
  return list.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new RoundStartError(`第 ${i + 1} 条断言要是一个对象`)
    }
    const o = raw as Record<string, unknown>
    if (typeof o.name !== 'string' || o.name === '') throw new RoundStartError(`第 ${i + 1} 条断言缺 name`)
    if (!Array.isArray(o.argv) || o.argv.length === 0 || !o.argv.every((x) => typeof x === 'string')) {
      throw new RoundStartError(`第 ${i + 1} 条断言的 argv 要是一个非空的字符串数组`)
    }
    const expect = o.expect === undefined ? 0 : o.expect
    if (typeof expect !== 'number' || !Number.isInteger(expect)) {
      throw new RoundStartError(`第 ${i + 1} 条断言的 expect 要是一个整数`)
    }
    return { name: o.name, argv: o.argv as readonly string[], expect }
  })
}

/** 一格跑完的读数里"为什么停"那一栏（与日志 `agent/stop` 那一族同域：一个 agent 一条）。 */
interface AgentStop {
  readonly agent: string
  readonly steps: number
  readonly stopped: string
}

/** 这一轮几份契约一共占了多少条路径（读数的分母，与判决无关）。 */
/**
 * 这一格的**产物路径**（B 区末尾那一行的值）。
 *
 * **只有只读型的产物才由构造器按位置定名**（架构 § 8.12 的 `Evidence` 注释 · § 22 的 D15：
 * "只读型契约的产物由构造器按位置定名，落进专属目录——产物命名冲突不可能发生"）。`implement`
 * 与 `resolve` 的产物路径是**契约自己声明的**（`ownedPaths` / `deliverables`），所以那一行对它们
 * 是空数组：它们的落点已经在"交付物"那一行里说清了。
 *
 * **这一处原先无条件给 `deliver/<agent>/`**，而验收跑的是契约声明的那些路径——于是 B 区末尾那
 * 一行把模型指到别处去了。实测（`--live`，第三次联网验证）：模型**写出的是对的字节**
 * （`数完了`），而它落在 `deliver/agent/r1/1/notes.md` 上，验收跑 `test -f notes.md` 不过，
 * 推进一个字节都不动。模型照着"产物路径"那一行走，那是它对。
 */
function outputsOf(c: Contract): readonly string[] {
  if (c.kind === 'implement') return []
  if (c.kind === 'resolve') return []
  // 调查型：**契约写入面那几条**（构造器按位置定名：`evidence/<agent 的每一段>/<备注>`）。
  // 原先给的是 `deliver/<agent>/`——那是证据前缀那一次改写之前的旧约定，而这一行是 B 区的
  // 最后一行（近因那一处）：模型照它走，就会写到一个**既不在契约写入面、验收也不看**的地方。
  return c.evidenceRequired.map((e) => e.artifact)
}

function writeSetPaths(contracts: readonly Contract[]): string[] {
  const all = new Set<string>()
  for (const c of contracts) {
    const paths = c.kind === 'implement' ? c.ownedPaths : c.kind === 'resolve' ? c.conflictPaths : []
    for (const p of paths) all.add(p)
  }
  return [...all]
}

/**
 * 那几面 `--fail`/`--deny`/`--retry` 的开关：不给就是 `undefined`（"没要求"），给了要是个整数且
 * 不小于 `min`（缺省 1）。
 *
 * `min` 存在只为一件事：`--retry` 的 **0 是一个有意义的取值**（"一遍都不重来"，架构 § 8.13），
 * 所以"没给"与"给了 0"要分得开——前者落到缺省，后者就是 0。
 */
function numberOf(v: string | true | undefined, min = 1): number | undefined {
  if (v === undefined || v === true) return undefined
  const n = Number(v)
  return Number.isInteger(n) && n >= min ? n : undefined
}

/** 把一个提交铺到一个临时目录里——`--deny` 那一档要在真盘上试一次写入。 */
async function scratchTree(truth: TruthHandle, commit: CommitId): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'fugue-round-deny-'))
  await materializeCommit(truth, commit, dir)
  return dir
}

/** 契约要写哪儿，给那一行印出来（三种来源各自那一份）。 */
function writeSetLine(c: {
  kind: string
  ownedPaths?: readonly RelPath[]
  conflictPaths?: readonly RelPath[]
  evidenceRequired?: { artifact: RelPath }[]
}): string {
  if (c.kind === 'implement') return (c.ownedPaths ?? []).join(' · ')
  if (c.kind === 'resolve') return (c.conflictPaths ?? []).join(' · ')
  return (c.evidenceRequired ?? []).map((e) => e.artifact).join(' · ')
}

/**
 * 绑好的动作表：名字 → 它声明的产出（`actions.<名字>` 那一条）。
 *
 * **持轮者给的断言只能从这里选**（PLAN § 5.10 的 C1 ⑦：架构 § 8.12 那张表里
 * `assertions` 的候选就是工作区配置）。读它的是 `readBinding` 一处，所以“这个名字合不合形状”
 * 的判据只有一份——报出来的话就是那一份说的（不猜、不补、不替它挑）。
 */
function actionsTableOf(doc: ConfigDoc): Readonly<Record<string, readonly RelPath[]>> {
  const out: Record<string, readonly RelPath[]> = {}
  for (const name of actionNames(doc)) out[name] = readBinding(doc, name).outputs as readonly RelPath[]
  return out
}

/**
 * 绑好的动作**跑什么**：名字 → `argv` 拼起来。**与 `actionsTableOf` 同一个来源**（`readBinding`
 * 一处读），用处只有一个——产物说明里那一句动作，名字后面括号里那个命令。
 *
 * 为什么要印出来：`assertions.action` 只能从这几个里挑，而"只给名字"那一版真档烧掉过一整趟的
 * 预算——那一趟为了弄清哪个动作核哪一处，去找工作区的配置（它猜 `*.json` / `*.yaml` /
 * `*.toml`，而那一份叫 `.fugue/config`），8 步里四步花在找它上，一次都没伸手写草案。
 */
function actionCommandsOf(doc: ConfigDoc): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of actionNames(doc)) out[name] = readBinding(doc, name).argv.join(' ')
  return out
}

/**
 * 读配置里的拆分草案（`round.split`）。**给的就是一份数组，一份草案一笔**——不另造一套键名，
 * 因为草案的键就是契约的键（架构 § 15.1.a）。
 *
 * 解析不了就拒，不当成空草案：把一份坏配置读成"这一轮没有草案"，症状是"开不出轮次"而说不出为什么。
 * `--split <json>` 盖过配置——一个工作区想开两轮不同拆法的轮次时用它，不必改配置。
 */
function readSplit(doc: ConfigDoc, override: string | true | undefined): SplitAssignment[] {
  const raw = override === true ? undefined : override
  let text: string
  if (raw !== undefined) {
    text = raw
  } else {
    const v = getConfig(doc, 'round.split')
    if (v === undefined) return []
    text = typeof v === 'string' ? v : JSON.stringify(v)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new RoundStartError(`round.split 不是一份完整的 JSON：${(err as Error).message}`)
  }
  if (!Array.isArray(parsed)) throw new RoundStartError('round.split 要是一个数组：一份草案一笔')
  return parsed.map((one, i) => splitOf(one, i + 1))
}

/** 一份草案：`goal` · `ownedPaths` · `assertions` 三样必给，`deliverables` 可空。 */
function splitOf(raw: unknown, n: number): SplitAssignment {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RoundStartError(`第 ${n} 份草案要是一个对象`)
  }
  const o = raw as Record<string, unknown>
  const goal = o.goal
  if (typeof goal !== 'string' || goal === '') throw new RoundStartError(`第 ${n} 份草案缺 goal`)
  const ownedPaths = o.ownedPaths
  if (!Array.isArray(ownedPaths) || ownedPaths.length === 0 || !ownedPaths.every((x) => typeof x === 'string')) {
    throw new RoundStartError(`第 ${n} 份草案的 ownedPaths 要是一个非空的字符串数组`)
  }
  const assertions = o.assertions
  if (!Array.isArray(assertions) || assertions.length === 0) {
    throw new RoundStartError(`第 ${n} 份草案没有断言：零条断言会让「打回率低」这句话没有分母`)
  }
  const deliverables = o.deliverables === undefined ? [] : o.deliverables
  if (!Array.isArray(deliverables)) throw new RoundStartError(`第 ${n} 份草案的 deliverables 要是一个数组`)
  return {
    goal,
    ownedPaths: ownedPaths as readonly string[],
    assertions: assertions as SplitAssignment['assertions'],
    deliverables: deliverables as SplitAssignment['deliverables'],
  }
}
/**
 * 真驱动那一档要的那几样（`DriverSupport`）。**打桩那一档一个都不读**——所以这一份只在
 * `--live` 下拼，凭据那一步也就只在真要出网时才走（PLAN § 5.8 的口径一）。
 *
 * **凭据这一栏是一个命令行覆盖，不是一个来源**（第 5 批 · 疑点 4）：不给 `--credential` 时它
 * 是 `undefined`，那时按**提供方声明里那份有序的表**取（`authOf()`——唯一取值处：环境变量优先，
 * 其次 `CREDENTIAL_FILE`）。壳这一层原先自己读一遍文件，于是"从哪取"这句话在两个地方各写了一遍，
 * 而两处漂移的表现是"文件里那份读到了也没用"（实测）。
/**
 * 真驱动那一档要的那几样（`DriverSupport`）。**打桩那一档一个都不读**——所以这一份只在
 * `--live` 下拼，凭据那一步也就只在真要出网时才走（PLAN § 5.8 的口径一）。
 *
 * **一个 agent 一份状态、一个句柄**：`sourcesFor(protocol, state, who)` 的输入里有坐标
 * （分支 · 产物路径），而每一条分支的坐标各是各的。所以这一份按 agent 记忆，不是"整轮一份"。
 *
 * **导出它是为了让它能被单独断言**：句柄里"这个 agent 读哪一份协议"这一栏原先写死过
 * `HOLDER_PROTOCOL`，而那一处错了只表现为前缀短了一截（没有别的报错）——所以它要有一条
 * 直接量它的断言（`protocol-wire.test.ts` 的 ①e），而不是靠走到真调用才看得见。
 *
 * 目标那一栏（`Target`）**是唯一碰凭据的地方**，而它在这里就拼好（不是每一步现取）：一次轮次
 * 一个目标，出网那一刻用的就是它。头的名字按**这一条线协议**给（`wireHeader`）——两条线各一套
 * 头，那一栏的差别不是这里的分岔。
 */
export function driverSupport(o: {
  readonly root: string
  readonly doc: ConfigDoc
  /** `--credential <路径>`：**那个文件在哪**（不给就走声明里那一格）。顺序照声明。 */
  readonly credential?: string
  /** `--dump-wire` 那一档的落点（**已经在工作区之外**——守卫在 `dumpWireDir`）。不给就不落。 */
  readonly dumpDir?: string
  /**
   * `--wire-in <目录>`：**回放档**（PLAN § 5.12 序 1）。
   *
   * 给了它就同时换掉两件事：**目标**（不取凭据——它一个字节都不出网）与**传输**（读那份目录，
   * 不碰 `fetch`）。`--dump-wire` 与它叠加时落的是这一趟真的发出去的那一串（请求是现算的），
   * 于是"重录一份夹具"就是 `--wire-in <旧> --dump-wire <新>`。
   */
  readonly wireIn?: string
  /**
   * 这一格最多走几步（`--max-steps`）。**它是「我的任务」里那句话的那个数**，所以要在拼状态
   * 的时候就写进去——那一份状态同时喂给两处装配（`step` 里那一次与驱动算预算用的 `prefixOf`
   * 那一次），两处读到的字节因此是同一串。
   *
   * **不给就是不设上界**：这一栏缺席，那句"这一格最多 N 步"就不写（`sources.ts` 那一处只在
   * 有数时写），而驱动那一侧也真的不设——`undefined` 一路传到底，三处读的是同一个缺少。
   */
  readonly maxSteps?: number
}): DriverSupport {
  const decl = modelDeclOf(DEFAULT_MODEL.id)
  const tools = publishedCatalog()
  const states = new Map<string, AssembleState>()
  const handles = new Map<string, AgentHandle>()
  // **覆盖给了就用覆盖**（`targetAt`：值从参数进来，不再取一次）；**不给就按声明取**。
  // 声明那一份是**有序的表**：环境变量优先，其次 `CREDENTIAL_FILE`——这两条的实现只有一处
  // （`authOf()`），所以"文件里那份读到了也没用"这一类漂移在结构上不存在。
  // **回放那一档不取凭据**：它一个字节都不出网（架构 § 10.5），而取凭据那一步在没有 key 时会
  // 当场拒——那与这一档无关（夹具档要凭据这件事本身就是"把两件事混成一件"）。占位串只进这一份
  // 目标的头里，而头不进请求体、也不进任何一份夹具。`--credential` 照旧优先（走查要换一份声明
  // 之外的 key 时给的就是它）。
  const credential =
    o.wireIn === undefined
      ? authWith(providerOf(decl.provider), o.credential ?? null)
      : (o.credential ?? '回放档：不出网，不取凭据')
  const target = targetAt(decl.id, credential)
  /** 回放档的那条传输（不给就是"没有"，`callModel` 走真网络）。 */
  const pump = o.wireIn === undefined ? undefined : wireInTransport(o.wireIn)

  /**
   * 这个 agent 的第一步那一份状态：**契约值就是它的任务**（B 区那几段照契约填）。
   *
   * 记忆按 agent：同一个 agent 只干一格（一份契约），而记忆是为了让 `state` 与 `handle` 两次问
   * 拿到**同一份对象**（`handle.state` 与 `ask.state` 是同一个值——驱动两边都读）。
   */
  const stateFor = (agent: string, c: Contract): AssembleState => {
    const hit = states.get(agent)
    if (hit !== undefined) return hit
    const base = stateWithState(emptyState(), o.doc, o.root)
    const made: AssembleState = {
      ...base,
      // **预算那一句由这里进前缀**：它的读者是模型，所以它得在状态里——不能等到 `step()` 里现拼
      // （那样 `prefixOf` 与 `step` 两处装出来的字节会差这一段，而算预算的那一处读的正是 `prefixOf`）。
      ...(o.maxSteps === undefined ? {} : { maxSteps: o.maxSteps }),
      ...(c.kind === 'implement' ? { goal: c.goal, files: c.ownedPaths.map((path) => ({ path, text: '' })) } : {}),
      task: {
        goal: c.kind === 'implement' ? c.goal : c.kind === 'investigate' ? c.question : base.task.goal,
        question: c.kind === 'investigate' ? c.question : '',
        // **三个变体各一个分支。** `implement` / `resolve` 那两条照旧（它们那几行的字节是录下来的
        // 夹具绑着的，一个字都不能动）；补的是**调查型**那一条——它原先走 `c.deliverables.map`，
        // 而 `InvestigateContract` **没有 `deliverables` 这一栏**（它只有 question ·
        // evidenceRequired · seed），于是真驱动这一档在调查型那一格上当场
        // `Cannot read properties of undefined (reading 'map')`：`round work --live` 第一次
        // 跑到调查型契约时照出来的（真档链第一趟：2 份契约 · 一个格都没跑）。
        deliverables:
          c.kind === 'resolve'
            ? [...c.conflictPaths]
            : c.kind === 'implement'
              ? c.deliverables.map((d) => d.path)
              : [],
        // 调查型的"要交的证据"是那几条备注；它的产物路径在末尾那行 `产物路径`（按位置定名，见
        // `outputsOf`）。它**没有断言**——那一栏空着（"断言由 harness 跑"那一句因此也不该出现）。
        evidenceRequired: c.kind === 'investigate' ? c.evidenceRequired.map((e) => e.note) : c.assertions.map((a) => a.name),
        assertions: c.kind === 'investigate' ? [] : c.assertions.map((a) => a.name),
        // **写入面与执行那一侧同一个集合**（同一份 `declaredSetOf`）：它进了 B 区那一段，
        // 于是"别处别动"这句话在它伸手**之前**就在（`writeScope` 那一条是伸手**之后**才拒的）。
        ownedPaths: [...declaredSetOf(c)],
      },
    }
    states.set(agent, made)
    return made
  }

  const handleFor = (agent: string, c: Contract): AgentHandle => {
    const hit = handles.get(agent)
    if (hit !== undefined) return hit
    const made: AgentHandle = {
      agent: agent as AgentId,
      // **产物路径那一栏照契约给**（见 `outputsOf` 那一份注释：只有只读型才由构造器定名）。
      coord: { id: agent, branch: `refs/heads/agent/${agent}`, outputPaths: outputsOf(c) },
      branch: `refs/heads/agent/${agent}` as BranchId,
      contract: (c?.id ?? '') as ContractId,
      protocol: protocolFor(decl),
      model: decl.id,
      wireModel: decl.model,
      target,
      adapter: { name: decl.wire },
      // 同上：声明里那一栏必须真的发出去（思考那一档与输出预算都在里面）。
      call: decl.call,
      state: stateFor(agent, c),
    }
    handles.set(agent, made)
    return made
  }

  return {
    state: (a, c) => stateFor(String(a), c),
    handle: (a, c) => handleFor(String(a), c),
    decl,
    // **要它才包这一层**：不给 `--dump-wire` 时交出去的就是 `wireCall` 本身——多一层包装也许多
    // 一次调用开销，而"用户不用 debug 就不为它付成本"这条要落到结构上，不是靠自觉。
    // **这一档的签名是 `(目录)`**：`makeDumpCall` 自己起 `callModel`（它要的是完整的那笔账——
    // `raw` · `opened` · `closed` 都在 `ModelStream` 上，而 `wireCall` 那一道出口只交两栏）。
    // 传 `wireCall` 进去的话第一个参数会落成"目录"，而那是函数——真正的失败长这样：
    // `TypeError: The "path" argument must be of type string. Received function wireCall`。
    //
    // **传输那一层的一个 `if`**：回放档给它 `wireInTransport(目录)`，其余两档给 `undefined`
    // （`callModel` 的缺省就是真网络）。三种用法因此是同一条代码路径：
    //   `wireCallOver(pump)` · `makeDumpCall(dir, pump)`——`pump` 给不给，决定字节从哪儿来。
    call: o.dumpDir === undefined ? wireCallOver(pump) : makeDumpCall(o.dumpDir, pump),
    tools,
  }
}
