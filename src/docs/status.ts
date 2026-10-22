// 状态：**现有产物对应哪一版 · 最近一次生成成没成**（交接单 § 3.5）。
//
// 两件事分开判断，分开报告：
//
//   一 · 产物那一栏看**指纹比较**（外加批次完整性）：产物缺失 = 未生成；指纹相同且文件完好 =
//        最新；指纹不同或文件与清单不一致 = 过期，并报出产物对应的提交与当前提交。
//   二 · 最近一次那一栏看 `last.json`（成功给提交 · 指纹 · 页数；失败给原因 · 尝试的提交 ·
//        材料范围）。**同一指纹已有完整产物时，再生成失败，现有产物仍是最新**——失败只是
//        "最近一次"那一栏的事（交接单 § 3.5）。
//
// 这一份不取凭据、不发请求：它要的是"现在会用的模型键"，那由调用方按同一处规则算好递进来。
import type { ConfigDoc } from '../config.ts'
import type { Truth } from '../truth/contract.ts'
import type { RefName } from '../terms.ts'
import { parseDocs } from './config.ts'
import type { ArtifactReport, DocsPlan, ModelFacts, SourceFact, StatusReport, TreeFacts } from './contract.ts'
import { DocsError, docsRootOf } from './contract.ts'
import { treeFactsOf } from './facts.ts'
import { fingerprintOf, modelFactsOf } from './fingerprint.ts'
import { batchIntegrity, readLast, readManifest, recoverPublish } from './publish.ts'
import { THEME_IDS, themeOf } from './theme.ts'
import { modelFactsFromConfig } from './writer.ts'

export interface StatusDeps {
  readonly root: string
  /** 合并读过的配置（定义与主题）。 */
  readonly config: ConfigDoc
  readonly truth: Truth
  /**
   * 现在会用的写作模型声明。**不给就从配置与目录现算**：模型或凭据缺席时"最近一次"那一栏
   * 照旧报得出来，第一栏说"当前这一版读不出来"（不是把整条 status 变成一条错）。
   */
  readonly model?: ModelFacts
  /** 当前提交看哪条 ref（缺省 `refs/heads/main`）。 */
  readonly ref?: string
}

interface Now {
  readonly commit: string | null
  readonly fingerprint: string | null
  readonly error: string | null
  readonly plan: DocsPlan | null
  readonly sources: readonly SourceFact[]
  readonly facts: TreeFacts | null
}

/** 当前那一版：定义 → 提交 → 事实 → 指纹。**任一步不行都算"算不出来"，如实说原因。** */
async function nowOf(deps: StatusDeps): Promise<Now> {
  let plan: DocsPlan | null = null
  let commit: string | null = null
  let facts: TreeFacts | null = null
  try {
    plan = parseDocs(deps.config)
    if (plan === null) {
      throw new DocsError('config', '文档能力没有启用：工作区配置里没有 docs 键（架构 § 15.3.a）')
    }
    const theme = themeOf(plan.theme)
    if (theme === null) throw new DocsError('config', `配置 docs.theme 写的 ${JSON.stringify(plan.theme)} 不在目录里（${THEME_IDS.join(' · ')}）`)
    try {
      commit = String(await deps.truth.resolve((deps.ref ?? 'refs/heads/main') as RefName))
    } catch (err) {
      throw new DocsError('facts', `找不到当前提交：${(err as Error).message}`)
    }
    facts = await treeFactsOf(deps.truth, commit as never, plan)
    if (facts.missing.length > 0) {
      const lines = facts.missing.map((m) => `  · 文档 ${m.id}：source 指向 ${m.source}`)
      throw new DocsError('facts', `来源在当前提交里缺失（${facts.missing.length} 份）：\n${lines.join('\n')}`)
    }
    // **模型声明与 build 同一处算**（复审 R7）：换思考档也判过期；缺模型时这一栏读不出来。
    const declared = modelFactsFromConfig(deps.config, plan.model)
    const model = deps.model ?? modelFactsOf({ model: declared.id, wireModel: declared.wireModel, facts: declared }, plan.maxTokens)
    return {
      commit,
      fingerprint: fingerprintOf({ commit, plan, sources: facts.sources, theme, model, read: plan.read }),
      error: null,
      plan,
      sources: facts.sources,
      facts,
    }
  } catch (err) {
    return { commit, fingerprint: null, error: (err as Error).message, plan, sources: facts?.sources ?? [], facts }
  }
}

/** 状态：两栏各算各的。 */
export async function statusOf(deps: StatusDeps): Promise<StatusReport> {
  const docsDir = docsRootOf(deps.root)
  // 先接上上次没走完的切换：状态读到的应该是"当前可读"的那一批。
  await recoverPublish(deps.root)

  let manifest = null as Awaited<ReturnType<typeof readManifest>>
  let manifestError: string | null = null
  try {
    manifest = await readManifest(deps.root)
  } catch (err) {
    manifestError = (err as Error).message
  }
  const attempt = await readLast(deps.root)
  const now = await nowOf(deps)

  const integrity: string[] = []
  if (manifest !== null) integrity.push(...(await batchIntegrity(deps.root, manifest)))
  if (manifestError !== null) integrity.push(manifestError)

  let state: ArtifactReport['state']
  if (manifest === null && manifestError === null) state = 'missing'
  else if (
    manifest !== null &&
    integrity.length === 0 &&
    now.fingerprint !== null &&
    manifest.fingerprint === now.fingerprint
  ) {
    state = 'current'
  } else {
    state = 'stale'
  }

  return {
    artifact: {
      state,
      commit: manifest === null ? null : manifest.commit,
      commitShort: manifest === null ? null : manifest.commitShort,
      fingerprint: manifest === null ? null : manifest.fingerprint,
      generatedAt: manifest === null ? null : manifest.generatedAt,
      pages: manifest === null ? 0 : manifest.pages.length,
      theme: manifest === null ? null : manifest.theme,
      now: { commit: now.commit, fingerprint: now.fingerprint, error: now.error },
      integrity,
    },
    attempt,
    docsDir,
  }
}
