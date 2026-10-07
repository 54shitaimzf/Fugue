// 命令值层的**登记表**：命令 → 值层那一格的入口。出处：架构 § 9.11「**方法名是既有
// CLI 动词的外部别名**……**本节不抄第二张对应表**——对应关系从 § 9.6 派生」。
//
// 两个壳都从这里取：
//
//   · **CLI**（`src/cli/fugue.ts`）在这些键上把分发交给值层，自己只做「写两股 · 定退出码」；
//   · **serve**（`src/serve/`）把同一批键摆到 JSON-RPC 的方法面上——**方法名从 `FLAGS_OF` 派生**
//     （`methodOf`），不抄第二张表。
//
// **没迁的命令走退化档**（serve 那一侧：子进程 `fugue <cmd> --json` 顶班），所以这张表是**可以
// 长的**：迁一条加一行，别的什么都不动。表里的键必须都在 `FLAGS_OF` 里（`registry.test.ts` 量
// 这一条）——命令面单一真源那条纪律在值层这一头也成立。
import { FLAGS_OF } from '../cli/flags.ts'
import type { FlagTable } from '../cli/flags.ts'
import { logValue, statusValue, watchValue } from './observe.ts'
import {
  branchValue,
  chmodValue,
  commitValue,
  diffValue,
  listValue,
  readValue,
  removeValue,
  renameValue,
  revsValue,
  statValue,
  writeValue,
} from './view.ts'
import type { ValueArgs, ValueResult } from './types.ts'

/** 一格值层入口：收参数、出值（或者一句失败）。 */
export type ValueRunner = (a: ValueArgs) => Promise<ValueResult>

export interface ValueEntry {
  /** `FLAGS_OF` 里的那个键（命令名，`round` 的子命令写成 `round new`）。 */
  readonly key: string
  /** 这条命令的值层入口。 */
  readonly run: ValueRunner
}

/**
 * 已经迁到值层的命令。**顺序不影响语义**——它是查表，不是分发链。
 *
 * 「迁到值层」这件事是**可证的**：同一条命令在这个键上跑出来的两条脸，与黄金帧里那两条逐字节
 * 相同（`test/golden/golden.test.ts`）；serve 那一侧则要求它的 `result` 与 CLI 的 `--json` 面
 * 逐字节相同（`src/serve/serve.test.ts`）。
 */
export const VALUE_LAYER: Readonly<Record<string, ValueRunner>> = {
  read: readValue,
  list: listValue,
  stat: statValue,
  diff: diffValue,
  revs: revsValue,
  write: writeValue,
  remove: removeValue,
  rename: renameValue,
  chmod: chmodValue,
  commit: commitValue,
  branch: branchValue,
  log: logValue,
  status: statusValue,
  watch: watchValue,
}

/** 这一格命令名在值层里吗（`round` 的子命令按 `round new` 那种键查）。 */
export function valueRunnerOf(key: string): ValueRunner | null {
  return VALUE_LAYER[key] ?? null
}

/** 值层迁到哪儿了——一条命令的键（`log` · `round new` 那种）。 */
export function isMigrated(key: string): boolean {
  return VALUE_LAYER[key] !== undefined
}

/**
 * **方法名从 § 9.6 派生**（§ 9.11 那句话的可执行形态）：命令与子命令各占一段，段与段之间用 `.`
 * 连。`FLAGS_OF` 的键就是那条命令（`round new`），所以 `<a> <b>` → `<a>.<b>`。
 *
 * **入口不出方法名**（§ 9.11「表里两类行分得开」）：`serve` 与 `tui` 是「这份东西怎么跑」，
 * 不是「收参数、出值」的动词——`tui` 今天在 `FLAGS_OF` 里，serve 那一侧不给它方法名。
 */
export function methodOf(key: string): string {
  return key.split(' ').join('.')
}

/** 命令面的那几条**动词**（值层与 serve 方法面都只看这一批）：`FLAGS_OF` 的键减去入口。 */
export const ENTRY_KEYS: readonly string[] = ['serve', 'tui']

/** 按命令名分段的两种写法：`round new` ⇄ `round.new`。 */
export function keyOfMethod(method: string): string {
  return method.split('.').join(' ')
}

/** `FLAGS_OF` 里每一条动词命令的键（入口那一档减掉）。 */
export function verbKeys(): readonly string[] {
  return Object.keys(FLAGS_OF).filter((k) => !ENTRY_KEYS.includes(k))
}

/** 一张表的开关名单（serve 解析参数时要它：方法收的 `params` 就是这些名字）。 */
export function flagsFor(key: string): FlagTable | undefined {
  return FLAGS_OF[key]
}
