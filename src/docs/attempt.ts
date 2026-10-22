// 一次生成尝试的边界：**成功与失败都落一条**（`last.json`），且只有这里写它。
//
// 顺序上它在解析模型之前就开始记账：配置、提交、模型解析失败也要在 `status` 的“最近一次”
// 那一栏里留下原因（复审 R8 的判据）。这一份不认识批次与页面，只认识“尝试”这件事。
import type { LastAttempt, Materials } from './contract.ts'
import { writeLast } from './publish.ts'

export interface AttemptFields {
  readonly ok: boolean
  readonly at: string
  readonly commit: string | null
  readonly fingerprint: string | null
  readonly pages: number
  readonly theme: string | null
  readonly model: string | null
  readonly materials: Materials
  readonly usage: { readonly calls: number; readonly inputTokens: number | null; readonly outputTokens: number | null }
  readonly usagePages?: LastAttempt['usagePages']
  readonly reason: string | null
  readonly at_stage: string | null
}

/** 一次尝试的记账形状（纯函数；写盘在 `recordAttempt`）。 */
export function attemptOf(f: AttemptFields): LastAttempt {
  return {
    ok: f.ok,
    at: f.at,
    commit: f.commit,
    fingerprint: f.fingerprint,
    pages: f.pages,
    theme: f.theme,
    model: f.model,
    materials: f.materials,
    reason: f.reason,
    at_stage: f.at_stage,
    usage: { calls: f.usage.calls, inputTokens: f.usage.inputTokens, outputTokens: f.usage.outputTokens },
    ...(f.usagePages === undefined ? {} : { usagePages: f.usagePages }),
  }
}

export async function recordAttempt(root: string, attempt: LastAttempt): Promise<void> {
  await writeLast(root, attempt)
}

/**
 * 生成还没开始（或者停在配置 / 提交 / 模型解析）就失败的那一笔。
 *
 * 那种失败原先直接抛错，于是“刚刚生成失败”在 `status` 的最近一次那一栏里根本不存在——还显示
 * 上一次成功。这里把尝试边界提到解析模型之前：**失败也落账**，已完成的调用数如实写。
 */
export async function recordAttemptFailure(o: {
  readonly root: string
  readonly reason: string
  readonly at_stage: string
  readonly commit: string | null
  readonly materials: Materials
  readonly model: string | null
  readonly theme: string | null
  readonly usage?: { readonly calls: number; readonly inputTokens: number | null; readonly outputTokens: number | null }
  readonly usagePages?: LastAttempt['usagePages']
}): Promise<void> {
  const attempt = attemptOf({
    ok: false,
    at: new Date().toISOString(),
    commit: o.commit,
    fingerprint: null,
    pages: 0,
    theme: o.theme,
    model: o.model,
    materials: o.materials,
    reason: o.reason,
    at_stage: o.at_stage,
    usage: o.usage ?? { calls: 0, inputTokens: null, outputTokens: null },
    ...(o.usagePages === undefined ? {} : { usagePages: o.usagePages }),
  })
  try {
    await recordAttempt(o.root, attempt)
  } catch {
    // 连“失败”都写不进去时不能报成功：调用方本来就在抛错那一头，话里带得出原因。
  }
}
