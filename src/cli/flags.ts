// 命令面的**开关表**：每条命令认哪些开关，一处声明、两个消费者——分发处（`cli/fugue.ts` 那一道
// `unknownFlagsOf`）与界面的候选表（`ui/menu.ts` 的 `specsOf`）。出处：架构 § 9.8「认得的开关才收」·
// PLAN § 5.19 第二版「二 · 按键」（"这张表就是分发器的输入"）· 第九节 `T4` 那一行。
//
// **为什么它单独一份文件**：`T4` 那条断言是"菜单里列出的命令集合与 `FLAGS_OF` 的键集合逐字相同"，
// 而界面那一侧（`cli/cmd/observe.ts`）要读同一份——这里的"同一份"是字面意思：不是抄一份、不是
// 导出个同名的东西，是两个消费者读同一个对象。原先它住在 `fugue.ts` 里，界面要读它就绕出一条
// `fugue.ts → cmd/observe.ts → fugue.ts` 的环；搬出来环就没了，"哪些命令存在"这件事也只剩一处。

/** 视图上那九条无开关的命令共用的底表（`write` · `diff` · `commit` 等各有自己的加项）。 */
export const VIEW_FLAGS: readonly string[] = ['root', 'agent', 'json', 'help']

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
  status: { flags: ['root', 'json', 'help', 'once', 'metrics', 'report'], note: '一次快照就加 --once，跟随是另一条命令：watch --follow' },
  watch: { flags: ['root', 'agent', 'json', 'help', 'follow', 'interval'], note: '不给 --follow 就把账上有的念一遍就停' },
  tui: { flags: ['root', 'help', 'once', 'follow', 'metrics', 'report', 'interval'], note: 'tui 是同一读面的第二档渲染——要机器读的那一份用 status --json' },
  read: { flags: VIEW_FLAGS },
  list: { flags: VIEW_FLAGS },
  stat: { flags: VIEW_FLAGS },
  remove: { flags: VIEW_FLAGS },
  rename: { flags: VIEW_FLAGS },
  chmod: { flags: VIEW_FLAGS },
  revs: { flags: VIEW_FLAGS },
  branch: { flags: VIEW_FLAGS },
  'verify-mat': { flags: VIEW_FLAGS },
  dispose: { flags: VIEW_FLAGS },
  write: { flags: ['root', 'agent', 'json', 'help', 'from', 'stdin'] },
  diff: { flags: ['root', 'agent', 'json', 'help', 'since'] },
  commit: { flags: ['root', 'agent', 'json', 'help', 'm'] },
  replay: { flags: ['root', 'agent', 'json', 'help', 'to', 'verify'] },
  'diff-stat': { flags: ['root', 'agent', 'json', 'help', 'baseline', 'save'] },
  fork: { flags: ['root', 'agent', 'json', 'help', 'strategy', 'ro', 'no-preserve-mtime'] },
  ensure: { flags: ['root', 'agent', 'json', 'help', 'to'] },
  run: { flags: ['root', 'agent', 'json', 'help', 'step', 'mode'] },
  policy: { flags: ['root', 'agent', 'json', 'help', 'mode'] },
  config: { flags: ['root', 'json', 'help'] },
  doctor: { flags: ['root', 'json', 'help'] },
  assemble: { flags: ['root', 'agent', 'json', 'help', 'against'] },
  say: { flags: ['root', 'agent', 'json', 'help', 'live', 'wire-in', 'max-steps', 'credential', 'dump-wire'] },
  'round new': { flags: ['root', 'agent', 'json', 'help', 'materialize', 'split'] },
  'round plan': { flags: ['root', 'agent', 'json', 'help', 'live', 'wire-in', 'judge', 'max-steps', 'credential', 'dump-wire'] },
  'round go': { flags: ['root', 'agent', 'json', 'help', 'materialize'] },
  'round run': { flags: ['root', 'agent', 'json', 'help', 'split', 'fail', 'deny', 'retry', 'materialize', 'report', 'metrics', 'live', 'wire-in', 'max-steps', 'credential', 'dump-wire', 'no-handoff', 'strict-merge-gate', 'poke', 'poke-exact'] },
  'round work': { flags: ['root', 'agent', 'json', 'help', 'live', 'wire-in', 'retry', 'report', 'metrics', 'max-steps', 'credential', 'dump-wire'] },
}
