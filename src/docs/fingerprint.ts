// 状态指纹：**"过期"是比出来的，不是谁判断的**（交接单 § 1.2 · § 3.3 · 架构 § 9.9）。
//
// 一只指纹盖住四样东西，任一样变了产物就过期：
//
//   提交 C · 文档定义（含主题 id 与主题版本） · 每份来源的 blob · 写作所用的模型声明
//
// 渲染器版本也进指纹：宿主那一半换了一版，"同样正文出同样字节"这个前提就变了（交接单 § 1.4）。
// **生成时间不进指纹**——它只进清单，否则同一份状态每次生成都是"过期"。
import { createHash } from 'node:crypto'
import type { DocsPlan, SourceFact } from './contract.ts'
import { FINGERPRINT_PREFIX, RENDERER_VERSION } from './contract.ts'
import type { ThemeSpec } from './theme.ts'

/** 键序稳定的序列化（数组按原序——次序本身是定义的一部分：`docs.pages` 的先后就是导航的先后）。 */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  const obj = v as Record<string, unknown>
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
    .join(',')}}`
}

export interface FingerprintInput {
  readonly commit: string
  readonly plan: DocsPlan
  readonly sources: readonly SourceFact[]
  readonly theme: ThemeSpec
  /** 我们这边的模型键（换模型 = 过期：同一份定义换了写作用模型，正文不该算最新）。 */
  readonly model: string
}

/** 这一批的指纹：`sha256:` 加十六进制。 */
export function fingerprintOf(o: FingerprintInput): string {
  const body = stable({
    commit: o.commit,
    renderer: RENDERER_VERSION,
    theme: { id: o.theme.id, version: o.theme.version },
    model: o.model,
    pages: o.plan.pages.map((p) => ({
      id: p.id,
      title: p.title,
      source: p.source,
      audience: p.audience,
      role: p.role,
      prompt: p.prompt,
      out: p.out,
    })),
    sources: o.sources.map((s) => [s.id, s.source, s.sha]),
  })
  return FINGERPRINT_PREFIX + createHash('sha256').update(body).digest('hex')
}

/** 给人看的前缀（页脚与状态行都不印 64 位十六进制）。 */
export function shortFingerprint(fp: string): string {
  const hex = fp.startsWith(FINGERPRINT_PREFIX) ? fp.slice(FINGERPRINT_PREFIX.length) : fp
  return `${FINGERPRINT_PREFIX}${hex.slice(0, 12)}`
}
