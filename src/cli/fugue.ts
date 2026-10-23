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
// 分发与出口，出口面逐字未动。
//
// **装载按命令切分 + 编译缓存。** 这一份的静态闭包里只有三个 `node:` 内建与 `./boot.ts` ·
// `./load.ts`：解析那一层（`./argv.ts`）· 出口那一层（`./out.ts`）· 各命令组，统统走 `./load.ts`
// 那一张短名表，**走到哪一条命令才装哪一份**——`--version` 与 `round run` 装的不再是同一棵树。
// 模块体的第一句是 `armCompileCache()`：剩下那些模块的编译结果落一份可弃派生体，下一个进程直接
// 取来用。两处地板都在各自的文件里（映射丢了就全量装载 · 缓存目录建不出来就没有缓存），两处都是
// 变慢，不是跑不起来。
//
// 三件事照旧：出口面（`USAGE` 仍从这里再导出，《`--help` 那张表》的消费者一处不改）· 分发次序
// （值层那一支仍排在老路之前）· 一条命令的字节（人面与 `--json` 面，黄金帧逐字节盯着）。
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { armCompileCache } from './boot.ts'
import { load } from './load.ts'

// **这一份模块体的第一句**：编译缓存要在任何重模块被**编译**之前打开——ESM 整张静态图在求值
// 之前就编译完了，所以它必须排在所有动态装载的前面（`src/cli/boot.test.ts` ① 静态盯着这个次序）。
armCompileCache()

// 解析与出口那两层也走动态装载：上面那两条静态 import 之外，静态闭包里一个字节都不装。这一条
// 由 `./load.test.ts` ⑤ 盯着（静态说明符的白名单），而不是靠自觉——它是"`--version` 不碰工作区"
// 这件事的装载那一半。
const { parseArgv, unknownFlagsOf } = await import('./argv.ts')
const { USAGE, emitFail, emitJson, emitLine, fail, usageFail } = await import('./out.ts')
const { PROTOCOL_VERSION } = await import('../protocol.ts')
const { UsageError } = await import('../value/types.ts')

export { USAGE }

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
    if (err instanceof (await load('hold')).LogHeldError) return fail(err.message, json)
    throw err
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const { flags, positional, rest } = parseArgv(argv)
  const json = flags.has('json')
  const cmd = positional[0]

  // `--help` 是一条成功的命令；什么都不给是用法错——两者的退出码不一样。
  if (flags.has('help')) {
    process.stdout.write(USAGE)
    return 0
  }
  // 没给开关才用缺省值；给了却缺值不是同一回事。否则 --root 会退回 cwd、--agent 会
  // 退回 round，连 write 都会悄悄写进另一份视图。开上下文与读取 stdin 之前就拒绝（§ 9.8）。
  const rootFlag = flags.get('root')
  const agentFlag = flags.get('agent')
  if (rootFlag === true || rootFlag === '') return usageFail('--root 需要一个目录：--root <dir>', json)
  if (agentFlag === true || agentFlag === '') return usageFail('--agent 需要一个标识：--agent <id>', json)
  // 安装版本与工作区无关：在落点探测、开日志之前读，只认安装目录里的 package.json。
  if (flags.has('version')) {
    const bad = unknownFlagsOf('--version', flags, ['version', 'root', 'json', 'help'])
    if (bad !== null) return usageFail(bad, json)
    if (flags.get('version') !== true) return usageFail('--version 不取值', json)
    if (positional.length > 0 || rest.length > 0) {
      return usageFail('--version 单独使用，不接命令或其他参数', json)
    }
    const { name, version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    if (json) emitJson({ name, version, protocol: PROTOCOL_VERSION })
    else emitLine(`${name} ${version}`)
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
  // `--help` 与 `--version` 在上面，不受影响。
  // 只在入口按调用者 cwd 解析一次；git 子进程也以 root 为 cwd，不能再解释一遍相对路径。
  const root = resolve(typeof rootFlag === 'string' ? rootFlag : process.cwd())
  const { HostError, assertHost } = await load('host')
  try {
    assertHost(root)
  } catch (err) {
    if (err instanceof HostError) return fail(err.message, json)
    throw err
  }

  // 每条命令一张**声明过的开关表**（§ 9.8「认得的开关才收」，U8 从三条读命令扩到全命令族）：
  // 表外的开关退 2——写错的开关被咽下去之后，人看到的是"命令跑了、什么都没变"，那与
  // "这个开关今天没用"是同一张脸。`round` 按子命令一张；表里没有的键（未知命令 · round
  // 的未知子命令）落到下面的分发去说它自己的话。
  // `round` 与 `docs` 都按子命令各一张表（子命令之间不共用开关）。
  const flagKey =
    cmd === 'round' ? `round ${positional[1] ?? ''}` : cmd === 'docs' ? `docs ${positional[1] ?? ''}` : cmd
  const { FLAGS_OF } = await load('flags')
  const table = FLAGS_OF[flagKey]
  if (table !== undefined) {
    const bad = unknownFlagsOf(flagKey, flags, table.flags)
    if (bad !== null) {
      return usageFail(bad + (table.note === undefined ? '' : `；${table.note}`), json)
    }
  }

  // ── 值层这一站：迁过来的命令从这里出去 ──────────────────────────────────────
  // 出处：架构 § 9.6「**命令本身是一份值层，CLI 是它的第一个壳**」。这条支路做的只有壳那三件事
  // 里的两件：把 argv 解析成参数（上面已经做完）· 把值排成人读或 `--json`（`writeValue`）；退出码
  // 那一件在 `writeValue` 的返回值里。**它不碰下面的老路**——没迁的命令一个字节都没动。
  //
  // 放在开关表检查**之后**：表外开关当场退 2 那条纪律（§ 9.8）对值层这一档同样成立，而它比
  // 值层更靠前——两条脸不该因为出口换了就少一道门。
  const valueKey =
    cmd === 'round'
      ? `round ${positional[1] ?? ''}`
      : cmd === 'docs'
        ? `docs ${positional[1] ?? ''}`
        : cmd === undefined
          ? ''
          : cmd
  // `docs` 后面没跟子命令、或跟了一个不认识的：在这里说清有哪三条（值层查不到 `docs ` 那个键，
  // 落到下面会变成一句"未知命令：docs"，那对一条有子命令的命令族是错的指路）。
  if (cmd === 'docs' && !['build', 'status', 'prompt'].includes(positional[1] ?? '')) {
    return usageFail(
      `docs 后面要跟一条子命令：build（生成）· status（状态）· prompt（一份的写作输入），拿到的是 ${positional[1] ?? '（没有）'}`,
      json,
    )
  }
  if (valueKey !== '') {
    // 值层那一份要装：`migrated` 就是"这条命令迁过来了吗"，它只有从登记表里问得出来。**这一份
    // 因此每条真实命令都要装**（实测 123 份）——这是"一处真相"的价钱：名单只在
    // `value/registry.ts` 一处，入口不另抄一条键的表。读数记在停点报告的疑点清单里。
    const { isSpecial, migrated, valueResultOf, watchAndWrite } = await load('value')
    if (migrated(valueKey)) {
      const valueArgs = { root, flags, args: positional.slice(1), rest }
      if (isSpecial(valueKey)) return await watchAndWrite(valueArgs, json)
      const { writeValue } = await load('shell')
      return writeValue(await valueResultOf(valueKey, valueArgs), json)
    }
  }
  // **观察那三条（`log` · `status` · `watch`）在上面值层那一支就出去了**：本版收口把它们的
  // 三个老出口与 `cli/cmd/observe.ts` 一起收掉（那三个在值层登记之后一条都走不到这儿）。
  // 三条都是**纯读**：不建视图、不取锁、不追加（§ 9.7）——所以它们排在建视图那一组之前。
  if (cmd === 'tui') return await (await load('console')).tuiCmd(root, flags)
  if (cmd === 'serve') return await (await load('serve')).serveCmd(root, flags, json)

  if (cmd === 'replay') return await (await load('view')).replay(root, flags, json)

  if (cmd === 'commit') return await (await load('view')).commitCmd(root, flags, json)

  // 分出去改的是 ref（真源那一侧），不建视图、不读日志——所以它排在建视图的命令之前。
  if (cmd === 'branch') return await (await load('view')).branchCmd(root, flags, positional.slice(1), json)

  // 轮次那一组自己开上下文（它要 truth 与 log 两个句柄、还要写日志），排在通用视图之前：
  // 它的参数与其他命令不共用。
  if (cmd === 'round') {
    const sub = positional[1]
    const m = await load('round')
    if (sub === 'run') return await m.roundRun(root, flags, positional.slice(2), json)
    if (sub === 'plan') return await m.roundPlan(root, flags, positional.slice(2), json)
    if (sub === 'go') return await m.roundGo(root, flags, positional.slice(2), json)
    if (sub === 'work') return await m.roundWork(root, flags, positional.slice(2), json)
    return await m.roundCmd(root, flags, positional.slice(1), json)
  }

  // 说话那一趟与轮次那一组同一档：它要 log 与 truth 两个句柄（会话记录走 view/write 那条路），
  // 还要跑一趟持轮者——所以它也自己开上下文。
  if (cmd === 'say') return await (await load('round')).sayCommand(root, flags, positional.slice(1), json)

  // 配置不建视图、不读日志：它是工作区的输入，不是它的状态（§ 15.3.a 末段）。
  if (cmd === 'config') return await (await load('config')).config(root, flags, positional.slice(1), json)

  // 策略值读的也是配置与探针，不是工作区的状态——所以它也排在视图之前（架构 § 8.8）。
  if (cmd === 'policy') return await (await load('config')).policyCmd(root, flags, positional.slice(1), json)

  // 自检纯读（U9）：读数各有归属（§ 15.7 的探针 · engines · PATH），不建视图、不读日志、不落盘。
  if (cmd === 'doctor') return await (await load('doctor')).doctorCmd(root, flags, json)

  // 尺子只读，也不进那份"状态"——所以它排在视图之前（§ 8.5 把 diff-stat 与 verify-mat 并列只读）。
  if (cmd === 'diff-stat') return (await load('materialize')).diffStatCmd(root, flags, positional.slice(1), json)
  if (cmd === 'fork') return await (await load('materialize')).forkCmd(root, flags, positional.slice(1), json)
  if (cmd === 'ensure') return await (await load('materialize')).ensureCmd(root, flags, positional.slice(1), json)
  // 执行排在物化那一组之后：它先兑现一次 `ensure`（D3），再起进程。
  if (cmd === 'run') return await (await load('execute')).runCmd(root, flags, positional.slice(1), rest, json)
  if (cmd === 'verify-mat') return await (await load('materialize')).verifyMatCmd(root, flags, json)
  if (cmd === 'dispose') return await (await load('materialize')).disposeCmd(root, flags, json)
  if (cmd === 'assemble') return await (await load('assemble')).assembleCmd(root, flags, positional.slice(1), json)

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
      return await (await load('view')).viewCmd(cmd, root, flags, args, json)

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
    .catch(async (err: unknown) => {
      // 兜底那一层的脸也跟着 `--json` 走（§ 9.8「错误」行）：走到这里的错（日志损坏 · 意外
      // 抛出）此前只有人读的那一面。日志目录那一行人面上照旧两行；`--json` 那一面一行，
      // 目录并进 message 的第二段（`subject` 那一栏留给「说到的那个东西」，不装路径拼接）。
      const json = parseArgv(process.argv.slice(2)).flags.has('json')
      const { LogCorruptError, logDir } = await load('log')
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
