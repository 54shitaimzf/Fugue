// `recover` 的值层入口：**一个值，两个壳**（架构 §9.6 / §9.11）。
//
// CLI 与 serve 读的是同一份 `recovery/state.ts` 判断；这里只把它收成 `unit(value, human)`，
// 人面与机器面因此不各写一遍。命令不写盘、不挪 ref、不重放写——D8 B 的边界。
import { openCtx } from '../cli/shared.ts'
import { recoverOf } from '../recovery/state.ts'
import type { RecoveryReport, RecoveryState } from '../recovery/state.ts'
import { ok, unit } from './types.ts'
import type { ValueArgs, ValueResult } from './types.ts'

const LABEL: Readonly<Record<RecoveryState, string>> = {
  'not-written': '未写回',
  full: '全写回',
  partial: '部分写回',
  conflict: '冲突',
  unverified: '未验证',
}

const short = (id: string | null): string => (id === null ? '（不知道）' : id.slice(0, 12))

/** 人读那一面：结论 · 事实 · 路径 · 下一步（每一步都能在终端里照做）。 */
export function humanRecovery(report: RecoveryReport | null): string {
  if (report === null) return '恢复：没有未收尾的发布。'
  const lines: string[] = []
  lines.push(`恢复 · ${report.round ?? '（不知道是哪一轮）'} · ${LABEL[report.state]}`)
  if (report.commit !== null) {
    lines.push(
      `  目标 ${short(report.commit)}（发布前 ${short(report.expected)}）· ${report.ref ?? 'refs/heads/main'} 现在 ${short(report.refNow)}`,
    )
  }
  lines.push('')
  for (const l of report.say.split('\n')) lines.push(`  ${l}`)
  if (report.paths.length > 0) {
    lines.push('')
    lines.push(`  路径（${report.paths.length}）：`)
    for (const p of report.paths) lines.push(`    ${p}`)
  }
  if (report.next.length > 0) {
    lines.push('')
    lines.push('  下一步（在终端里可以照做）：')
    for (const n of report.next) lines.push(`    · ${n}`)
  }
  return lines.join('\n')
}

/**
 * `fugue recover [--json]`。
 *
 * 退出码：0 = 核对完成（包括“有冲突”——那是读数）；1 = 核对本身没做成（句柄打不开 · 库读不动）。
 * **绝不把“判不了”印成“没写回”**：那一档是 `unverified`。
 */
export async function recoverValue(a: ValueArgs): Promise<ValueResult> {
  const ctx = await openCtx(a.root, a.flags, {})
  try {
    const report = await recoverOf({ truth: ctx.truth, realRoot: ctx.roots.realRoot, log: ctx.log })
    return ok(unit(report, humanRecovery(report)))
  } finally {
    await ctx.close()
  }
}
