// **跑一格值层**：查表 · 调它 · 把抛出来的错翻成一次失败的值。两个壳共用这一份，
// 于是「同一条命令跑的是同一段实现」在代码上只有一处。
//
// 错误分档（§ 9.8 的四档退出码，§ 9.11 的两段错误码对的就是它）：
//
//   · `UsageError`（**只此一类**——`cli/shared.ts` 那一份就是这一份的重导出）→ 退出码 2，
//     `hint` 指路；
//   · `CommandError` → 退出码 1；
//   · 别的一律交给调用方（`onError` 那一钩）：`LogHeldError` 那种命令面特有的失败**只在壳那
//     一层认得**，值层不该 import 它。
import { HostError } from '../roots/host.ts'
import { LogCorruptError, logDir, openLog } from '../log/log.ts'
import { LogHeldError } from '../log/hold.ts'
import { valueRunnerOf } from './registry.ts'
import { CommandError, UsageError } from './types.ts'
import type { ValueArgs, ValueResult } from './types.ts'

/**
 * **命令面的两族失败**（与 `src/cli/fugue.ts` 那三处出口同一句话，收进一处）：两个壳都用它。
 *
 *   · `LogHeldError`——同一个 writer 的另一个写者正写着：这是「做不成」（1）；
 *   · `LogCorruptError`——日志损坏：也是 1，但**要报出目录**（人读面照旧两行，`--json` 面把
 *     目录并进 message 的第二段）；
 *   · `HostError`——落点不成立（E1 是硬要求，拒绝启动）。
 *
 * `root` 是必要的：日志目录要按 `--root` 算（壳让人在任何目录里敲命令）。
 */
export function commandErrorOf(err: unknown, root: string): ValueResult | null {
  if (err instanceof LogHeldError) return { ok: false, code: 1, message: err.message }
  if (err instanceof LogCorruptError) {
    return {
      ok: false,
      code: 1,
      message: `日志损坏，拒绝加载 —— ${err.message}\n日志目录：${logDir(root)}`,
    }
  }
  if (err instanceof HostError) return { ok: false, code: 1, message: err.message }
  return null
}

/**
 * **抛出来的那一档 → 一份失败的值**。`invoke` 与 `watch` 那条特别的出口共用这一份——
 * 「同一条命令两条脸一致」这句话里，**错误那一面也要一致**：绕开它就会以裸异常逃到最外层。
 *
 * 返回 `null` 表示不认这个错（调用方原样往上抛）。
 */
export function failureOf(
  err: unknown,
  a: ValueArgs,
  onError?: (err: unknown) => ValueResult | null,
): ValueResult | null {
  if (err instanceof UsageError) return { ok: false, code: 2, message: err.message }
  if (err instanceof CommandError) {
    return {
      ok: false,
      code: 1,
      message: err.message,
      ...(err.hint === undefined ? {} : { hint: err.hint }),
      ...(err.subject === undefined ? {} : { subject: err.subject }),
    }
  }
  return (onError ?? ((e: unknown) => commandErrorOf(e, a.root)))(err)
}

/**
 * 跑一格。查不到这个键是**编程错误**（壳不该调没迁的键）——当场抛，不当成一次请求的失败。
 *
 * `onError` 是给壳的那一钩：返回一份值就采纳，返回 `null` 就把原错往上抛。不给时用
 * `commandErrorOf`（命令面那两族失败的默认翻法）。
 */
export async function invoke(
  key: string,
  a: ValueArgs,
  onError?: (err: unknown) => ValueResult | null,
): Promise<ValueResult> {
  const run = valueRunnerOf(key)
  if (run === null) throw new Error(`值层里没有这一格：${key}`)
  try {
    return await run(a)
  } catch (err) {
    const handled = failureOf(err, a, onError)
    if (handled !== null) return handled
    throw err
  }
}

/** 用法错那一档的 `hint`（与 `cli/shared.ts` 的 `usageFail` 同一句话）。 */
export const USAGE_HINT = '跑 fugue --help 看整张表'
