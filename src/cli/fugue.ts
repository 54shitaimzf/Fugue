#!/usr/bin/env node
// fugue —— 环境的操作面。出处：架构 § 9.6。
//
// **单次进程 + 每次重建**：不需要守护进程、不需要常驻状态、崩溃恢复就是"下一条命令照常
// 加载"。§ 9.6 那张表里属于 S1 的每一行都在这里：读 · 写 · 检视 · 提交 · 重放 · 配置。
//
// 这一层只做三件事：解析参数 · 把结构化结果排成两列（人读的与 `--json` 的）· 决定退出码。
// **语义不在这里**：一次变更的顺序与校验住在 `src/view/edit.ts`，提交住在
// `src/checkpoint.ts`——两个都是跨层接线（§ 7），这里只是它们的一个人侧入口。
//
// U4 拆分之后，各命令组住在 `./cmd/` 下（view · observe · config · materialize · execute ·
// assemble · round），共用的解析 · 发射 · 围栏 · 命令上下文住在 `./shared.ts`；这一文件只剩
// 分发与三个出口（`USAGE` · `driverSupport` · `main`），出口面逐字未动。
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { LogHeldError } from '../log/hold.ts'
import { LogCorruptError, logDir, openLog } from '../log/log.ts'
import type { WriterId } from '../terms.ts'
import { HostError, assertHost } from '../roots/host.ts'
import { USAGE, UsageError, emitFail, fail, parseArgv, usageFail } from './shared.ts'
export { USAGE } from './shared.ts'
export { driverSupport } from './cmd/round.ts'
import { branchCmd, commitCmd, replay, viewCmd } from './cmd/view.ts'
import { LOG_FLAGS, emit, statusCmd, tuiCmd, unknownFlagsOf, watchCmd } from './cmd/observe.ts'
import { config, policyCmd } from './cmd/config.ts'
import { diffStatCmd, disposeCmd, ensureCmd, forkCmd, verifyMatCmd } from './cmd/materialize.ts'
import { runCmd } from './cmd/execute.ts'
import { assembleCmd } from './cmd/assemble.ts'
import { roundCmd, roundGo, roundPlan, roundRun, roundWork, sayCommand } from './cmd/round.ts'

/**
 * 最外面那一层只做一件事：**把用法错翻成退出码 2**（§ 9.8 的退出码行）。
 *
 * 判据是"这条命令行本身就不成立"。它与"做不成"（1）分开是有用的：脚本要能一眼分出
 * "我敲错了"与"我敲对了，只是这件事没成"。
 */
export async function main(argv: readonly string[]): Promise<number> {
  // 错误面跟着 `--json` 走（§ 9.8「错误」行）：深处的 UsageError（`parseOctal` · 视图那一层的
  // 路径检查）与 LogHeldError 在这里翻成退出码，也要翻成同一张脸——argv 这里就有，读一次。
  const json = parseArgv(argv).flags.has('json')
  try {
    return await run(argv)
  } catch (err) {
    if (err instanceof UsageError) return usageFail(err.message, json)
    // 同一个 agent 的另一个写者正写着：这是「做不成」（1），不是「敲错了」（2）。
    if (err instanceof LogHeldError) return fail(err.message, json)
    throw err
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const { flags, positional, rest } = parseArgv(argv)
  const json = flags.has('json')
  const rootFlag = flags.get('root')
  const root = typeof rootFlag === 'string' ? rootFlag : process.cwd()
  const cmd = positional[0]

  // `--help` 是一条成功的命令；什么都不给是用法错——两者的退出码不一样。
  if (flags.has('help')) {
    process.stdout.write(USAGE)
    return 0
  }
  if (cmd === undefined) return usageFail('需要一个命令', json)
  // `--` 只对执行那一行有意义（`fugue run <action> -- k=v…`）。别的命令收到它就说不清，
  // 所以拒绝，而不是把后面那几段悄悄咽下去。
  if (rest.length > 0 && cmd !== 'run') {
    return usageFail(`\`--\` 之后的东西只有 run 收（这次给的是 ${cmd}）：只有 run 往子进程里注入 k=v`, json)
  }

  // 落点先探（架构 § 15.7 的 E1）。**E1 是硬要求，所以这里是拒绝启动，不是降级运行**：
  // 落在 9p / drvfs 那一类跨内核的落点上时，失败模式是静默的（§ 15.8 的"不成立"档）。
  // 根还不存在时探它最近的祖先（`host.ts`），所以这条检查不依赖"目录已经建好"；
  // `--help` 在上面，不受影响。
  try {
    assertHost(root)
  } catch (err) {
    if (err instanceof HostError) return fail(err.message, json)
    throw err
  }

  if (cmd === 'log') {
    const bad = unknownFlagsOf('log', flags, LOG_FLAGS)
    if (bad !== null) return usageFail(`${bad}；log 是抄本——不渲染、不筛选`, json)
    const only = flags.get('agent')
    const log = openLog(root)
    try {
      for await (const { pos, e } of log.readMerged()) {
        if (typeof only === 'string' && pos.writer !== (only as WriterId)) continue
        emit(pos, e, json)
      }
    } finally {
      await log.close()
    }
    return 0
  }

  // 观察命令（`status` · `watch`）是**纯读**：不建视图、不开账本、不取锁——所以它们排在建视图
  // 那一组之前。读面与写面在命令面上分开之后，"看一眼会不会改日志"这个问题就答完了（§ 5.18）。
  if (cmd === 'status') return await statusCmd(root, flags, json)
  if (cmd === 'watch') return await watchCmd(root, flags, json)
  if (cmd === 'tui') return await tuiCmd(root, flags)

  if (cmd === 'replay') return await replay(root, flags, json)

  if (cmd === 'commit') return await commitCmd(root, flags, json)

  // 分出去改的是 ref（真源那一侧），不建视图、不读日志——所以它排在建视图的命令之前。
  if (cmd === 'branch') return await branchCmd(root, flags, positional.slice(1), json)

  // 轮次那一组自己开上下文（它要 truth 与 log 两个句柄、还要写日志），排在通用视图之前：
  // 它的参数与其他命令不共用。
  if (cmd === 'round') {
    const sub = positional[1]
    if (sub === 'run') return await roundRun(root, flags, positional.slice(2), json)
    if (sub === 'plan') return await roundPlan(root, flags, positional.slice(2), json)
    if (sub === 'go') return await roundGo(root, flags, positional.slice(2), json)
    if (sub === 'work') return await roundWork(root, flags, positional.slice(2), json)
    return await roundCmd(root, flags, positional.slice(1), json)
  }

  // 说话那一趟与轮次那一组同一档：它要 log 与 truth 两个句柄（会话记录走 view/write 那条路），
  // 还要跑一趟持轮者——所以它也自己开上下文。
  if (cmd === 'say') return await sayCommand(root, flags, positional.slice(1), json)

  // 配置不建视图、不读日志：它是工作区的输入，不是它的状态（§ 15.3.a 末段）。
  if (cmd === 'config') return await config(root, positional.slice(1), json)

  // 策略值读的也是配置与探针，不是工作区的状态——所以它也排在视图之前（架构 § 8.8）。
  if (cmd === 'policy') return await policyCmd(root, flags, positional.slice(1), json)

  // 尺子只读，也不进那份"状态"——所以它排在视图之前（§ 8.5 把 diff-stat 与 verify-mat 并列只读）。
  if (cmd === 'diff-stat') return diffStatCmd(root, flags, positional.slice(1), json)
  if (cmd === 'fork') return await forkCmd(root, flags, positional.slice(1), json)
  if (cmd === 'ensure') return await ensureCmd(root, flags, positional.slice(1), json)
  // 执行排在物化那一组之后：它先兑现一次 `ensure`（D3），再起进程。
  if (cmd === 'run') return await runCmd(root, flags, positional.slice(1), rest, json)
  if (cmd === 'verify-mat') return await verifyMatCmd(root, flags, json)
  if (cmd === 'dispose') return await disposeCmd(root, flags, json)
  if (cmd === 'assemble') return await assembleCmd(root, flags, positional.slice(1), json)

  const args = positional.slice(1)

  // 视图上那九条命令（read · list · stat · diff · revs · write · remove · rename · chmod）
  // 的 case 与实现已住 `./cmd/view.ts`（U4b）。
  switch (cmd) {
    case 'read':
    case 'list':
    case 'stat':
    case 'diff':
    case 'revs':
    case 'write':
    case 'remove':
    case 'rename':
    case 'chmod':
      return await viewCmd(cmd, root, flags, args, json)

    default:
      return usageFail(`未知命令：${cmd}`, json)
  }
}

/**
 * 只有直接运行才执行。**这个守卫不能用 `import.meta.main`**：它是 Node 24.2 才有的，
 * 而 `package.json` 声明的 engines 是 ≥22.6——在那个版本上它会静默什么都不做。
 * 与 `tools/test-entry.js` 用同一个写法，所以本模块**可以被 import 而不产生副作用**。
 */
const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      // 兜底那一层的脸也跟着 `--json` 走（§ 9.8「错误」行）：走到这里的错（日志损坏 · 意外
      // 抛出）此前只有人读的那一面。日志目录那一行人面上照旧两行；`--json` 那一面一行，
      // 目录并进 message 的第二段（`subject` 那一栏留给「说到的那个东西」，不装路径拼接）。
      const json = parseArgv(process.argv.slice(2)).flags.has('json')
      if (err instanceof LogCorruptError) {
        // 日志在哪，由 `--root` 说了算——壳让人在任何目录里敲这条命令，而"我在哪"与
        // "它的日志在哪"是两件事。默认值仍是 cwd（`run` 里那一句）。
        const asked = parseArgv(process.argv.slice(2)).flags.get('root')
        const dir = logDir(typeof asked === 'string' ? asked : process.cwd())
        process.exit(
          emitFail(
            { code: 1, message: `日志损坏，拒绝加载 —— ${err.message}\n日志目录：${dir}` },
            json,
          ),
        )
      }
      process.exit(emitFail({ code: 1, message: err instanceof Error ? err.message : String(err) }, json))
    })
}
