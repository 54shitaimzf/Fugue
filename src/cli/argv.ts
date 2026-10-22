// 命令行**解析那一层**：参数怎么切 · 哪几个开关取值 · 表外的开关当场怎么拒。
//
// **它为什么单开一份**：`--version` 与 `--help` 是两条不碰工作区的命令，它们要的全部就是这一份与
// `cli/out.ts`；而 `cli/shared.ts` 还带着开视图那一串（`log/log.ts` · `truth/truth.ts` · `view/`
// 那一族 · `roots/` · `config.ts`）。入口按命令装载（`cli/load.ts`），所以切出这一份就等于让那两条
// 命令不必为整个命令族的并集付装载钱。
//
// 出口只有三样：`Parsed` · `parseArgv` · `unknownFlagsOf`——要就来这里拿。`cli/shared.ts` 不转一手：
// 同一个名字两条路，正是这一份最想避免的那种东西。

export interface Parsed {
  flags: Map<string, string | true>
  positional: string[]
  /** `--` 之后那几段的原文。**只有 `run` 收它**（`-- k=v…` 的注入，§ 9.6 的执行行）。 */
  rest: string[]
}

/**
 * 取值的选项。其余 `--x` 一律是开关——因为 § 9.6 的规范形是
 * `fugue [--root <dir>] [--agent <id>] [--json] <command>`，开关排在命令**前面**，
 * 一个贪心的解析器会把命令当成开关的值吃掉。
 */
const VALUED: ReadonlySet<string> = new Set([
  'root', 'agent', 'm', 'from', 'since', 'to', 'baseline', 'save', 'strategy', 'ro', 'step', 'mode', 'against',
  'split', 'fail', 'retry', 'poke', 'poke-exact',
  // `--dump-wire <目录>`：**它取一个值**。不列在这里的话 `--dump-wire /tmp/x` 里的 `/tmp/x`
  // 会被当成位置参数，而开关本身成了 `true`——于是要么误报用法错，要么把目录名当成轮次目标。
  'dump-wire', 'credential',
  // `--max-steps <n>`：同一条纪律——它取一个值，不列在这里那个数会被当成位置参数。
  'max-steps',
  // `--interval <毫秒>`（`watch --follow` 的轮询间隔）：同一条纪律。
  'interval',
  // `--tail <n>`（tui 首趟只写尾部 n 条，U15）：同一条纪律——不列在这里那个数会被当成位置参数。
  'tail',
  // `--wire-in <目录>`：**回放档**（PLAN § 5.12 序 1）。它也取一个值，同一条纪律；而它是**内部档**
  // ——不进用法说明：它要的是"录下来的那一趟"，只有取证与走查用得上。
  'wire-in',
  // `--model <id>`：模型选择（`round.model` 的旗标那一档，P2b）。同一条纪律——它取一个值。
  'model',
  // `--resume <游标串>`（watch 接着读，架构 § 9.11 的事件通道）：同一条纪律——它取一个值。
  // 不列在这里的话游标串会被当成位置参数，而 `--resume` 成了 `true`：接着读变成从零读。
  'resume',
  // `--wait <状态>` 与 `--timeout <秒>`（`status` 的等待糖）：同一条纪律——两个都取值。
  'wait', 'timeout',
  // `--idle-ms <毫秒>`（`serve` 的闲时阈值，走查与测试要一个短的）：同一条纪律。
  'idle-ms',
  // `--at <提交>` 与 `--theme <主题>`（`docs build`）：两个都取值。不列在这里的话提交号
  // 与主题名会变成位置参数，而 `docs build` 当场报"多出来的是 …"——实测撞过。
  'at', 'theme',
])

export function parseArgv(argv: readonly string[]): Parsed {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // `--` 之后一律是原文：`k=v` 的值里可能有 `-`、有 `=`，再解析下去就是替人猜。
    if (a === '--') {
      rest.push(...argv.slice(i + 1))
      break
    }
    if (!a.startsWith('-') || a === '-') {
      positional.push(a)
      continue
    }
    const long = a.startsWith('--')
    const eq = a.indexOf('=')
    if (eq !== -1) {
      flags.set(a.slice(long ? 2 : 1, eq), a.slice(eq + 1))
      continue
    }
    const key = a.slice(long ? 2 : 1)
    const next = argv[i + 1]
    if (VALUED.has(key) && next !== undefined && !next.startsWith('-')) {
      flags.set(key, next)
      i++
    } else {
      flags.set(key, true)
    }
  }
  return { flags, positional, rest }
}

/**
 * **认不得的开关当场拒**（退 2），不静默收下（§ 9.8「认得的开关才收」）。
 *
 * 为什么这一族要拒：写错的开关被咽下去之后，人看到的是"命令跑了、什么都没变"——那与"这个开关
 * 今天没用"在读数上分不开（`log --grep x` 找不到东西，与"日志里没有匹配"也是同一张脸）。用法
 * 错是 2，做不成是 1，两者不许混（架构 § 9.8）：收下一个不认识的开关属于**命令行不成立**。
 *
 * 报的话里把**这一条命令认的那几个**印出来：拒一条命令时，人要知道的是"那该怎么办"。
 */
export function unknownFlagsOf(
  cmd: string,
  flags: Map<string, string | true>,
  allowed: readonly string[],
): string | null {
  const bad = [...flags.keys()].filter((k) => !allowed.includes(k))
  if (bad.length === 0) return null
  return (
    `${cmd} 不认这几个开关：${bad.map((k) => '--' + k).join(' · ')}——这一条命令认的是 ` +
    allowed.map((k) => '--' + k).join(' · ')
  )
}
