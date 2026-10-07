// CLI 这个**壳**：把一份值排成人读或 `--json`，写下两股，定退出码。出处：架构 § 9.6
// 那一句——「CLI 这一层只做三件事：把 argv 解析成参数 · 把值排成人读或 `--json` · 决定退出码」。
//
// **它不认识任何一条命令**：收一份 `ValueResult`，写下字节。于是「同一条命令经 CLI 与经 serve 出
// 同一个值」这句话里，**两边共用的那一段就是这一份**（serve 那一侧的 `serve/face.ts` 与它同源）。
//
// 两条脸的字节由值层给全（`faces`），这一份只负责：按 `--json` 挑一条 · 补末尾换行 · 把 `notes`
// 写到 stderr · 把失败翻成 § 9.8 的四档退出码。
import { emitFail } from '../cli/shared.ts'
import { USAGE_HINT } from './invoke.ts'
import type { ValueResult } from './types.ts'

/** 挑一条脸（**不含**末尾换行）。 */
export function faceOf(r: ValueResult, json: boolean): string {
  if (!r.ok) return r.message
  return json ? r.value.faces.json : r.value.faces.human
}

/**
 * 把一份值写出去。
 *
 * 三档各写各的：`bytes` 那一档人读那一面写的是**字节**（`read` 今天的形状）；`unit` 与 `stream`
 * 写的是那条脸的字符串。**空串一个字节都不写**——今天 `read` 的 `--json` 面是元数据，人读面是
 * 字节，两条都不是「空行加换行」。
 */
export function writeValue(r: ValueResult, json: boolean): number {
  if (!r.ok) {
    // 用法错那一档人读面上要跟整张 USAGE（§ 9.8：`usageFail` 印的字节），`--json` 那一面是
    // 一行 JSON——两条都由 `cli/shared.ts` 的 `emitFail` 说了算，这里不另造一份。
    const hint = r.code === 2 ? (r.hint ?? USAGE_HINT) : r.hint
    return emitFail(
      {
        code: r.code,
        message: r.message,
        ...(hint === undefined ? {} : { hint }),
        ...(r.subject === undefined ? {} : { subject: r.subject }),
      },
      json,
    )
  }
  if (!json && r.value.kind === 'bytes') {
    process.stdout.write(Buffer.from(r.value.bytes))
  } else {
    const text = faceOf(r, json)
    process.stdout.write(text === '' ? '' : text + '\n')
  }
  for (const line of r.notes ?? []) process.stderr.write(line + '\n')
  return 0
}
