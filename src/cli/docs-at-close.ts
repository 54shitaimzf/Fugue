// 收口处生成文档：**归并、验收与写回之后的那一步**（交接单 § 1.2 的"收口" · § 2.5 的"触发"）。
//
// 它在轮次命令的**成功路径**上被调用，但**不是轮次的一部分**：
//
//   · 轮次的退出码按验收（`report.ok`），文档成不成一个字节都不改它（交接单 § 3.5）；
//   · 文档的失败只落在文档自己的结果里（`ok: false` + 原因 + 尝试的提交），旧批次留在原处；
//   · 打桩档与回放档**不生成**：那两档不出网，悄悄接一次真模型等于把"不联网不花钱"破了
//     （PLAN § 5.8 的口径一）。要生成就 `fugue docs build`，它自己会取凭据。
//
// **写作上下文从哪里来**（交接单 § 2.5）：完整树承担事实，这一段承担"改了什么"——本轮归并的
// 契约（id · agent · 提交 · 写入面）与验收读数。持轮者会话里那一段原文不在这一份的可达范围，
// 所以 `note` 如实写"本轮变化取契约与验收读数"，取到的范围也写进结果。
import type { ConfigDoc } from '../config.ts'
import { declaredSetOf } from '../contract/types.ts'
import type { RoundRun } from '../round/execute.ts'
import { openTruth } from '../truth/truth.ts'
import { parseDocs } from '../docs/config.ts'
import { buildDocs } from '../docs/build.ts'
import type { Materials } from '../docs/contract.ts'
import { DocsError } from '../docs/contract.ts'
import { shortFingerprint } from '../docs/fingerprint.ts'
import { callerOf } from '../docs/writer.ts'
import type { DocCaller } from '../docs/contract.ts'

/** 收口那一格的结果：**两脸同源的一段话 + 一份结构**。 */
export interface DocsClose {
  readonly ok: boolean
  /** 人读面追加的行（一行一句；不缩进，`emitRunFace` 原样印）。 */
  readonly lines: readonly string[]
  /** 机器面那一栏（只在配了 docs 时出现，所以没配文档的轮次 `--json` 面一个字节不动）。 */
  readonly value: Readonly<Record<string, unknown>>
}

function strFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name)
  return typeof v === 'string' && v !== '' ? v : undefined
}

function failedOf(err: unknown, commit: string | null): DocsClose {
  const at = err instanceof DocsError ? err.at : 'build'
  const why = (err as Error).message
  return {
    ok: false,
    lines: [`文档：生成失败（${at}）—— ${why}`, '  旧批次留在原处；处理好再跑一次 fugue docs build'],
    value: { ok: false, at_stage: at, reason: why, commit },
  }
}

/**
 * 收口那一格。`null` = 这个工作区没配文档（收口只做归并与验收，交接单 § 3.5 末段）。
 */
export async function docsAtClose(o: {
  readonly root: string
  readonly config: ConfigDoc
  readonly flags: Map<string, string | true>
  readonly round: string
  readonly run: RoundRun
  /** 这一轮接的是真模型（`--live`）吗。打桩与回放两档不生成。 */
  readonly live: boolean
  /** 回放档（`--wire-in`）：不出网，同样不生成。 */
  readonly replay: boolean
  /** 写作接缝（测试注入假模型用；不给就走真档）。 */
  readonly caller?: DocCaller
}): Promise<DocsClose | null> {
  let plan
  try {
    plan = parseDocs(o.config)
  } catch (err) {
    return failedOf(err, null)
  }
  if (plan === null) return null

  const accepted = o.run.report.ok && o.run.advanced !== null
  const commit = o.run.advanced === null ? null : String(o.run.advanced.commit)
  if (!accepted) {
    return {
      ok: false,
      lines: ['文档：这一轮没有通过验收，不生成（旧批次仍在原处）'],
      value: { ok: false, at_stage: 'round', reason: '这一轮没有通过验收', commit },
    }
  }
  if (o.replay) {
    return {
      ok: false,
      lines: ['文档：回放档不出网，不生成；要生成用 fugue docs build（它自己取凭据）'],
      value: { ok: false, at_stage: 'model', reason: '回放档不出网', commit },
    }
  }
  if (!o.live) {
    return {
      ok: false,
      lines: ['文档：这一轮是打桩档（没接真模型），不生成；要生成用 fugue docs build'],
      value: { ok: false, at_stage: 'model', reason: '打桩档不接模型', commit },
    }
  }

  const materials: Materials = {
    kind: 'round',
    note: `自动收口：轮次 ${o.round} 归并、验收与写回之后生成；完整树承担事实，本轮变化取契约与验收读数（持轮者会话的原文不在这一份的可达范围）`,
    round: o.round,
    contracts: o.run.batch.contracts.map((c) => ({
      id: c.id,
      agent: c.agent,
      commit: String(o.run.work[c.id] ?? ''),
      paths: declaredSetOf(c),
    })),
    verify: { ok: o.run.report.ok, passed: o.run.report.pass, failed: o.run.report.fail },
  }

  const truth = openTruth(o.root)
  try {
    const caller =
      o.caller ??
      callerOf({
        config: o.config,
        ...(strFlag(o.flags, 'model') === undefined ? {} : { model: strFlag(o.flags, 'model')! }),
        ...(strFlag(o.flags, 'credential') === undefined ? {} : { credential: strFlag(o.flags, 'credential')! }),
      })
    const out = await buildDocs({
      root: o.root,
      config: o.config,
      truth,
      caller,
      materials,
      at: commit ?? undefined,
    })
    if (!out.ok) return failedOf(new DocsError(out.at_stage, out.reason), commit)
    return {
      ok: true,
      lines: [
        `文档：${out.pages.length} 页已生成 —— ${out.docsDir}/index.html（file:// 即可）`,
        `  提交 ${out.commitShort} · 指纹 ${shortFingerprint(out.fingerprint)} · 视觉语言 ${out.theme} · 模型 ${out.model}`,
        ...(out.notes.length === 0 ? [] : [`  待复核：${out.notes.length} 处（见 manifest.json 的 pages[].notes）`]),
      ],
      value: {
        ok: true,
        commit: out.commit,
        commitShort: out.commitShort,
        fingerprint: out.fingerprint,
        theme: out.theme,
        model: out.model,
        docsDir: out.docsDir,
        index: `${out.docsDir}/index.html`,
        generatedAt: out.generatedAt,
        pages: out.pages.map((p) => ({ id: p.id, out: p.out })),
        usage: out.usage,
        notes: out.notes,
        materials,
      },
    }
  } catch (err) {
    return failedOf(err, commit)
  } finally {
    truth.close()
  }
}
