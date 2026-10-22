// 状态指纹：**"过期"是比出来的，不是谁判断的**（交接单 § 1.2 · § 3.3 · 架构 § 9.9）。
//
// 一只指纹盖住四样东西，任一样变了产物就过期：
//
//   提交 C · 文档定义（含主题 id 与主题版本） · 每份来源的 blob · **实际采用的模型声明**
//
// 模型那一栏从"只认 id"扩到整份声明（复审 R7）：`models.json` 可以在 id 不变时改思考档、温度、
// 输出预算，那些改动会让同一份正文配上不同的调用参数，却仍被 `status` 判成"最新"。
// **凭据不进指纹**：换一把密钥不该让产物过期。
//
// 渲染器版本也进指纹：宿主那一半换了一版，"同样正文出同样字节"这个前提就变了（交接单 § 1.4）。
// **生成时间不进指纹**——它只进清单，否则同一份状态每次生成都是"过期"。
import { createHash } from 'node:crypto'
import type { DocsPlan, ModelFacts, SourceFact } from './contract.ts'
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

/**
 * 这一次实际会用的模型声明。
 *
 * 计算只有这一处：`build` 与 `status` 都走它，于是"用了哪个模型"不会两边各理解一份。
 * `docs.maxTokens` 覆盖输出预算时以**实际请求的那个数**为准。
 */
export function modelFactsOf(
  caller: { readonly model: string; readonly wireModel: string; readonly thinking?: string; readonly facts?: ModelFacts },
  planMaxTokens: number | undefined,
): ModelFacts {
  const f = caller.facts
  return {
    id: caller.model,
    wireModel: f?.wireModel ?? caller.wireModel,
    thinking: f?.thinking ?? caller.thinking ?? null,
    temperature: f?.temperature ?? null,
    maxTokens: planMaxTokens ?? f?.maxTokens ?? null,
    contextLimit: f?.contextLimit ?? null,
  }
}

export interface FingerprintInput {
  readonly commit: string
  readonly plan: DocsPlan
  readonly sources: readonly SourceFact[]
  readonly theme: ThemeSpec
  /** 实际采用的模型声明（换模型或换思考档 = 过期）。 */
  readonly model: ModelFacts
}

/** 这一批的指纹：`sha256:` 加十六进制。 */
export function fingerprintOf(o: FingerprintInput): string {
  const body = stable({
    commit: o.commit,
    renderer: RENDERER_VERSION,
    theme: { id: o.theme.id, version: o.theme.version },
    model: o.model,
    // **定义里进页面与进请求的那几格都进指纹**：标题出现在页首与首页，单页预算影响截断与否。
    // 少了它们，改标题之后 `status` 还会说“最新”，而页面上仍是旧标题。
    title: o.plan.title ?? null,
    maxTokens: o.plan.maxTokens ?? null,
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
