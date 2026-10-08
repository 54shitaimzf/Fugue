// 命令面的**开关表**：每条命令认哪些开关，一处声明、两个消费者——分发处（`cli/fugue.ts` 那一道
// `unknownFlagsOf`）与界面的候选表（`ui/menu.ts` 的 `specsOf`）。出处：架构 § 9.8「认得的开关才收」·
// PLAN § 5.19 第二版「二 · 按键」（"这张表就是分发器的输入"）· 第九节 `T4` 那一行。
//
// **为什么它单独一份文件**：`T4` 那条断言是"菜单里列出的命令集合与 `FLAGS_OF` 的键集合逐字相同"，
// 而界面那一侧（`cli/cmd/observe.ts`）要读同一份——这里的"同一份"是字面意思：不是抄一份、不是
// 导出个同名的东西，是两个消费者读同一个对象。原先它住在 `fugue.ts` 里，界面要读它就绕出一条
// `fugue.ts → cmd/observe.ts → fugue.ts` 的环；搬出来环就没了，"哪些命令存在"这件事也只剩一处。

import { PHRASES } from '../phrases.ts'

/** 视图上那九条无开关的命令共用的底表（`write` · `diff` · `commit` 等各有自己的加项）。 */
export const VIEW_FLAGS: readonly string[] = ['root', 'agent', 'json', 'help']

/**
 * **写组那一份底表**（`remove` · `rename` · `chmod`）：与读组只差一个 `no-clock`。
 *
 * `--no-clock` 是**写面上那道开关**：给了它，这一条命令写进账的行不带信封钟（架构 § 9.11 的方法面
 * 与 § 9.2 的信封表）。读命令不写账，所以它们的表里没有这一格——**表外开关当场退 2，不静默忽略**。
 */
export const WRITE_FLAGS: readonly string[] = [...VIEW_FLAGS, 'no-clock']

/** 一张开关表：`flags` 是这条命令认得的全部开关；`note` 是拒的时候跟在后面那句指路。 */
export interface FlagTable {
  readonly flags: readonly string[]
  readonly note?: string
}

/**
 * 每条命令一张**声明过的开关表**（§ 9.8「认得的开关才收」，U8 自 `log`/`status`/`watch`/`tui`
 * 那四张扩到全命令族；原先其余命令对表外开关是静默忽略）。`round` 按子命令一张——子命令
 * 之间不共用：与观察那四张同一条道理，"收下"与"用上"在读数上分不开。
 */
export const FLAGS_OF: Readonly<Record<string, FlagTable>> = {
  log: { flags: ['root', 'agent', 'json', 'help'], note: 'log 是抄本——不渲染、不筛选' },
  status: {
    flags: ['root', 'json', 'help', 'once', 'metrics', 'report', 'ledger', 'agent', 'wait', 'timeout'],
    note: '一次快照就加 --once，跟随是另一条命令：watch --follow；只读某一格加 --agent <id>',
  },
  watch: { flags: ['root', 'agent', 'json', 'help', 'follow', 'interval', 'resume'], note: PHRASES.watchNote },
  tui: {
    flags: ['root', 'help', 'once', 'follow', 'metrics', 'report', 'interval', 'full', 'tail', 'no-style'],
    note: 'tui 是同一读面的第二档渲染——要机器读的那一份用 status --json；整屏那一档是 --full（缺省关）',
  },
  read: { flags: VIEW_FLAGS },
  list: { flags: VIEW_FLAGS },
  stat: { flags: VIEW_FLAGS },
  remove: { flags: WRITE_FLAGS },
  rename: { flags: WRITE_FLAGS },
  chmod: { flags: WRITE_FLAGS },
  revs: { flags: VIEW_FLAGS },
  branch: { flags: VIEW_FLAGS },
  'verify-mat': { flags: VIEW_FLAGS },
  dispose: { flags: VIEW_FLAGS },
  write: { flags: ['root', 'agent', 'json', 'help', 'from', 'stdin', 'no-clock'] },
  diff: { flags: ['root', 'agent', 'json', 'help', 'since'] },
  commit: { flags: ['root', 'agent', 'json', 'help', 'm', 'no-clock'] },
  replay: { flags: ['root', 'agent', 'json', 'help', 'to', 'verify'] },
  'diff-stat': { flags: ['root', 'agent', 'json', 'help', 'baseline', 'save'] },
  fork: { flags: ['root', 'agent', 'json', 'help', 'strategy', 'ro', 'no-preserve-mtime', 'no-clock'], note: PHRASES.noClockNote },
  ensure: { flags: ['root', 'agent', 'json', 'help', 'to', 'no-clock'], note: PHRASES.noClockNote },
  run: { flags: ['root', 'agent', 'json', 'help', 'step', 'mode', 'no-clock'], note: PHRASES.noClockNote },
  policy: { flags: ['root', 'agent', 'json', 'help', 'mode'] },
  config: { flags: ['root', 'json', 'help', 'system'], note: 'config set --system 写系统那一级（~/.fugue）；不带它写工作区' },
  doctor: { flags: ['root', 'json', 'help'] },
  // **`serve` 是入口，不是动词**（架构 § 9.11「表里两类行分得开」）：它说的是这份东西怎么跑，
  // 因此虽然在这张表里（命令面单一真源：速查表与它对账），**它不出方法名**。
  serve: {
    flags: ['root', 'help', 'idle-ms'],
    note: 'serve 是另一种进程角色：stdio 上一行一调用给客户端连；它不出方法名——方法面就是这张表里的动词',
  },
  assemble: { flags: ['root', 'agent', 'json', 'help', 'against'] },
  say: { flags: ['root', 'agent', 'json', 'help', 'live', 'wire-in', 'max-steps', 'credential', 'dump-wire', 'model', 'no-clock'], note: PHRASES.noClockNote },
  'round new': { flags: ['root', 'agent', 'json', 'help', 'materialize', 'split', 'no-clock'], note: PHRASES.noClockNote },
  'round plan': { flags: ['root', 'agent', 'json', 'help', 'live', 'wire-in', 'judge', 'max-steps', 'credential', 'dump-wire', 'model', 'no-clock'], note: PHRASES.noClockNote },
  'round go': { flags: ['root', 'agent', 'json', 'help', 'materialize', 'no-clock'], note: PHRASES.noClockNote },
  'round run': { flags: ['root', 'agent', 'json', 'help', 'split', 'fail', 'deny', 'retry', 'materialize', 'report', 'metrics', 'live', 'wire-in', 'max-steps', 'credential', 'dump-wire', 'no-handoff', 'strict-merge-gate', 'poke', 'poke-exact', 'model', 'no-clock'], note: PHRASES.noClockNote },
  'round work': { flags: ['root', 'agent', 'json', 'help', 'live', 'wire-in', 'retry', 'report', 'metrics', 'max-steps', 'credential', 'dump-wire', 'model', 'no-clock'], note: PHRASES.noClockNote },
}


/**
 * `--interval <毫秒>`：跟随那一趟睡多久。给一个数，或者给一句用法错的话。
 *
 * **一处读法**：`watch`（`cli/cmd/observe.ts`）与 `tui`（`ui/console.ts`）说的是同一件事，值层
 * 那一份（`value/observe.ts`）也读它——三处各写一遍的话，"多少算合法"这件事就漂了。
 */
export function intervalOf(flags: Map<string, string | true>): number | string {
  const raw = flags.get('interval')
  if (raw === undefined) return 200
  if (typeof raw !== 'string') return '--interval 要一个数：--interval 200'
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return `--interval 要一个正整数（毫秒），拿到 ${JSON.stringify(raw)}`
  return n
}

/**
 * `--tail N`（U15）：**首趟**永久行只写尾部 N 条——旧账几百行时不用翻半天才到活的那些；之后的
 * 新行照常增量。不给 = 全印（与从前逐字节相同）。要一个正整数，别的都是用法错（退出码 2，
 * 与 `--interval` 同一道门）。跳过的前几条**不折了也不印**：旧账想全看有 `fugue log` /
 * `fugue watch`，这一档是"接着看"的入口。
 */
export function tailOf(flags: Map<string, string | true>): number | undefined | string {
  const raw = flags.get('tail')
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') return '--tail 要一个数：--tail 40'
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return `--tail 要一个正整数（条数），拿到 ${JSON.stringify(raw)}`
  return n
}
