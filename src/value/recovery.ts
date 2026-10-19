// `recover` 的值层入口：**一个值，两个壳**（架构 §9.6 / §9.11）。
//
// CLI 与 serve 读的是同一份 `recovery/state.ts` 判断；这里只把它收成 `unit(value, human)`，
// 人面与机器面因此不各写一遍。命令不写盘、不挪 ref、不重放写——D8 B 的边界。
import { openCtx } from '../cli/shared.ts'
import { finishOf, RecoverFinishRefused } from '../recovery/finish.ts'
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
 * `fugue recover [--json] [--finish]`。
 *
 * 缺省只读：核对五态、报事实与下一步。`--finish` 是**显式收尾**：只在“全写回、验收已过”
 * 那一档把账上缺的 `merge/publish done` 与 `merge/accept` 补上（不重放写）；其余四态一律拒，
 * 退出码 1 并把人指回 `fugue recover`。
 *
 * 退出码：0 = 核对完成（包括“有冲突”——那是读数）或收尾落成；1 = 核对/收尾没做成
 * （句柄打不开 · 库读不动 · 不是全写回）。**绝不把“判不了”印成“没写回”**：那一档是 `unverified`。
 */
export async function recoverValue(a: ValueArgs): Promise<ValueResult> {
  const finish = a.flags.has('finish')
  // 收尾要写那两条事实，所以整条命令取写者的锁；缺省那条路径仍是纯读（观察不得影响状态）。
  const ctx = await openCtx(a.root, a.flags, finish ? { write: true, sync: 'each' } : {})
  try {
    if (finish) {
      try {
        const report = await finishOf({ truth: ctx.truth, realRoot: ctx.roots.realRoot, log: ctx.log })
        return ok(unit(report, humanRecovery(report)))
      } catch (err) {
        if (err instanceof RecoverFinishRefused) {
          return {
            ok: false,
            code: 1,
            message: err.message,
            hint: '先运行 fugue recover 看清五态与下一步；收尾只在“全写回”时可用。',
          }
        }
        throw err
      }
    }
    const report = await recoverOf({ truth: ctx.truth, realRoot: ctx.roots.realRoot, log: ctx.log })
    return ok(unit(report, humanRecovery(report)))
  } finally {
    await ctx.close()
  }
}
