// 绑好的动作表与它的命令行：**从 `cli/cmd/round.ts` 搬出来的两个纯函数**（第一幕 ①）。
//
// 为什么单独一份：`cli/cmd/round.ts` 有一千八百多行（持轮者那一整套：草案 · 判 · 派发 ·
// 落地），而这两个函数只读一份配置文档。原先的消费者有三处——命令面的那一栏（`status --ledger`
// 的「走法」）· 界面折门口那一块（`ui/console.ts`）· 值层那一份同样的读法——它们要的是
// 「这台机器上有哪几条动作命令」，不该为此把持轮者那一整套牵进来。
//
// 判据来源与语义一字未改：读 `readBinding` 一处，报出来的话就是那一份说的（不猜 · 不补 ·
// 不替它挑）。
import { actionNames, readBinding } from '../boundary/binding.ts'
import type { ConfigDoc } from '../config.ts'
import type { RelPath } from '../terms.ts'

/**
 * 绑好的动作表：名字 → 它声明的产出（`actions.<名字>` 那一条）。
 *
 * **持轮者给的断言只能从这里选**（PLAN § 5.10 的 C1 ⑦：架构 § 8.12 那张表里
 * `assertions` 的候选就是工作区配置）。读它的是 `readBinding` 一处，所以“这个名字合不合形状”
 * 的判据只有一份——报出来的话就是那一份说的（不猜、不补、不替它挑）。
 */
export function actionsTableOf(doc: ConfigDoc): Readonly<Record<string, readonly RelPath[]>> {
  const out: Record<string, readonly RelPath[]> = {}
  for (const name of actionNames(doc)) out[name] = readBinding(doc, name).outputs as readonly RelPath[]
  return out
}

/**
 * 绑好的动作**跑什么**：名字 → `argv` 拼起来。**与 `actionsTableOf` 同一个来源**（`readBinding`
 * 一处读）。P3b2 起它的消费方只剩**门停给人看的那张表**（`observe.ts`）——模型那一侧的清单
 * 住在 A 区系统状态的 `actions` 栏（名字 + argv，同一份来源），不再由提示词内联。
 *
 * 那张表为什么留着：`assertions.action` 只能从这几个里挑，而"只给名字"那一版真档烧掉过一整趟的
 * 预算——那一趟为了弄清哪个动作核哪一处，去找工作区的配置（它猜 `*.json` / `*.yaml` /
 * `*.toml`，而那一份叫 `.fugue/config`），8 步里四步花在找它上，一次都没伸手写草案。
 */
export function actionCommandsOf(doc: ConfigDoc): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of actionNames(doc)) out[name] = readBinding(doc, name).argv.join(' ')
  return out
}

