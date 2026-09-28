// `fugue doctor`——环境自检的命令面（U9）。读数在 `probe/doctor.ts`（那里也写着口径：
// 纯读不落盘 · 「缺」是读数不是失败）。这一层只做两件事：把读数排成两列 · 决定退出码。
import { doctorOf } from '../../probe/doctor.ts'
import { emitJson, emitLine, fail } from '../shared.ts'

/**
 * 退出码：**读得出就退 0**——绿与缺都是读数（§ 8.15 不造伪判据：探不到不是失败，
 * 是这台机器的档位）。唯一退 1 的情形：`statfs` 都问不出落点（`host === null`）——
 * 那是自检自己跑不了，与 E1 那道硬门槛是两件事（E1 的拒绝在每条命令的启动处，
 * `assertHost`）。
 */
export async function doctorCmd(
  root: string,
  flags: Map<string, string | true>,
  json: boolean,
): Promise<number> {
  void flags
  const report = doctorOf(root)
  if (report.host === null) {
    return fail(`doctor：statfs 问不出落点（root=${root}）——自检自己跑不了`, json)
  }
  if (json) {
    emitJson({
      rows: report.rows,
      allOk: report.rows.every((r) => r.ok),
      host: { root: report.host.root, probed: report.host.probed, fs: report.host.fs, class: report.host.class },
    })
  } else {
    for (const r of report.rows) emitLine(`${r.ok ? 'ok  ' : '缺  '}\t${r.name}\t${r.note}`)
    const missing = report.rows.filter((r) => !r.ok)
    emitLine(
      missing.length === 0
        ? '全绿'
        : `缺 ${missing.length} 项（缺是读数不是失败——哪一项缺、出路是什么，各行自己说）`,
    )
  }
  return 0
}
