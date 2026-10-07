// 壳那一头的**分发**：把一条已经解析好的命令行交给值层，把值写出去。
//
// 与 `src/value/invoke.ts` 是两件事：那一份是「跑一格值层」（两个壳共用），这一份是**CLI 这个
// 壳**——它知道 `--json` 要挑哪一条脸 · `watch --follow` 要边读边印 · 退出码怎么定。
//
// `watch --follow` 是唯一一条**流式**的：人读那一面要实时印（攒到最后再印就不是跟随了），所以
// 它一个信号、一个 `onBatch`；`--json` 那一面照旧一趟一批（NDJSON 一行一个，与从前逐字节相同）。
import { failureOf, invoke } from './invoke.ts'
import { VALUE_LAYER } from './registry.ts'
import { eventLine, watchValue } from './observe.ts'
import { writeValue } from './shell.ts'
import type { ValueRunner } from './registry.ts'
import type { ValueArgs, ValueResult } from './types.ts'

/** 出口与别的不一样的那几条键（今天只有 `watch`：它一条命令两种收尾）。 */
const SPECIAL: ReadonlySet<string> = new Set(['watch'])

/** 这条命令迁到值层了吗（壳用它决定走值层还是走老路）。 */
export function migrated(key: string): boolean {
  return VALUE_LAYER[key] !== undefined
}

/** 这条命令的值层入口是不是那一档特别的（今天只有 `watch`）。 */
export function isSpecial(key: string): boolean {
  return SPECIAL.has(key)
}

/**
 * **一个接缝：换掉值层那一份**（只给断言用）。出处：施工单 § 八 那条真信号的反面——
 * 「同一条命令经 CLI 与经 serve 出同一个值」这句话要有对手：接一个**手抄的渲染**上来，
 * 两面逐字节那条断言必须当场红（`serve-surface.test.ts` ④ 量的就是那一红）。
 *
 * 产品路径上它恒为 `null`：这一栏不改变任何一条命令的行为。
 */
let valueHook: ValueRunner | null = null

export function setValueHookOf(fn: ValueRunner | null): void {
  valueHook = fn
}

/** 跑一条命令，出一份值。**不写任何字节**——写那一半在 `writeValue`。 */
export async function valueResultOf(key: string, a: ValueArgs): Promise<ValueResult> {
  if (valueHook !== null) return await valueHook(a)
  return await invoke(key, a)
}

/**
 * `watch` 那一趟：跟随档**边读边印**（人读那一面：与从前一样，一行一条摘要），到点（信号）
 * 收尾之后把游标那一行 `notes` 写掉。非跟随档与 `--json` 档与别条命令一致（一整份值一次写下）。
 */
export async function watchAndWrite(a: ValueArgs, json: boolean): Promise<number> {
  const follow = a.flags.has('follow')
  const ac = new AbortController()
  const onSig = (): void => ac.abort()
  if (follow) process.on('SIGINT', onSig)
  try {
    const { result } = await watchValue(a, {
      ...(follow ? { signal: ac.signal } : {}),
      // 实时那一档只在人读面上开：`--json` 那一面是一整份回执（与从前逐字节相同）。
      ...(follow && !json
        ? {
            onBatch: (batch: readonly { pos: never; e: never }[]): void => {
              for (const row of batch) {
                process.stdout.write(eventLine(row.pos, row.e) + '\n')
              }
            },
          }
        : {}),
    })
    return writeValue(result, json)
  } catch (err) {
    // **错误那一面也走同一次映射**：这条出口此前绕开了 `invoke`，用法错于是以裸异常逃到最外层
    // ——`--json` 那一面不再是一行 JSON，退出码也不是四档里的那个数。
    const handled = failureOf(err, a)
    if (handled === null) throw err
    return writeValue(handled, json)
  } finally {
    if (follow) process.removeListener('SIGINT', onSig)
  }
}
