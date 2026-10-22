// 文档这一层的形状。出处：交接单 § 1.2（词义）· § 3（产物与位置）· 架构 § 9.9。
//
// **这一份只有类型与两三个常数。** 语义分住各处：配置的读法与核对在 `config.ts`，事实的取证
// 在 `facts.ts`，写作输入在 `prompt.ts`，呈现与交互在 `markdown.ts` / `page.ts`，生成与整批替换
// 在 `build.ts` / `publish.ts`。这里定的是它们之间**传什么**——形状放一处，实现各归各的。
//
// **两个输入一个产物**（架构 § 9.9 的那条式子）：`文档 = f(状态源, 每个文档的定义提示词)`。
// 状态源在今天就落在 `—— 提交 C 的完整树 + 提交元数据`；定义提示词落在工作区配置的 `docs` 键。
// 于是"过期"是**比出来的**：指纹一样就是最新，不一样就是过期，不需要谁来判断。
import { join } from 'node:path'
import type { ThinkingLevel, Usage } from '../model/contract.ts'

/** 文档这一层的失败：配置写错 · 来源缺失 · 材料不足 · 模型没写完 · 保存失败。**话原样带给人。** */
export class DocsError extends Error {
  /** 失败落在哪一格（`config` · `facts` · `model` · `render` · `publish`），给结果与状态用。 */
  readonly at: string
  constructor(at: string, message: string) {
    super(message)
    this.name = 'DocsError'
    this.at = at
  }
}

/** 产物目录：`<realRoot>/.fugue/docs/`（架构 § 9.2 那张布局表 · 交接单 § 3.1）。 */
export function docsRootOf(root: string): string {
  return join(root, '.fugue', 'docs')
}

/** 暂存批次的位置：与产物目录**同级**，所以切换是两次改名，不是一件一件换。 */
export function stageRootOf(root: string, token: string): string {
  return join(root, '.fugue', `docs-stage-${token}`)
}

/**
 * 渲染器的版本。**改了宿主那一半（markdown · 页面骨架 · 交互脚本）就加一**。
 *
 * 它进状态指纹：同样的正文、同样的主题，渲染器换了一版，产物仍然过期——那是"宿主那一半
 * 逐字节可复现"这句话的边界（交接单 § 1.4）。
 */
export const RENDERER_VERSION = 5

/** 清单的版本（清单自己换形状时加一，与渲染器版本分开）。 */
export const MANIFEST_VERSION = 1

/**
 * 提示词布局的版本：**谁住哪一区 · 区的顺序 · 共享前缀的边界**变了就加一。
 *
 * 它进状态指纹：同样的提交与定义，装配换了一版，盘上那一批就是旧布局写出来的，提示词里的
 * 材料与它不再对得上——`status` 要说得出来“过期”，而不是以为最新。
 */
export const PROMPT_VERSION = 1

/** 指纹的前缀。**指纹里不带时间**：生成时间只进清单，页面只放内容与事实。 */
export const FINGERPRINT_PREFIX = 'sha256:'

/** 一页的定义。**它就是模型写作的合同**：读者、职责与重点由人定（交接单 § 2.3）。 */
export interface PageDef {
  /** 稳定标识（文件名 · 深链接 · 清单都靠它）。 */
  readonly id: string
  /** 目录里的名字。 */
  readonly title: string
  /** 从哪来：提交里的仓库相对路径（人维护，随提交走）。 */
  readonly source: string
  /** 给谁看。 */
  readonly audience: string
  /** 负责讲什么、边界在哪。 */
  readonly role: string
  /** 这一份的写法与重点。 */
  readonly prompt: string
  /** 产物文件名（缺省 `<id>.html`）。 */
  readonly out: string
}

/** 工作区配置里 `docs` 那一份。 */
export interface DocsPlan {
  /** 文档集的标题（缺省用仓库名）。 */
  readonly title: string | undefined
  /** 视觉语言的名字（`theme.ts` 的目录里有的那几套）。 */
  readonly theme: string
  readonly pages: readonly PageDef[]
  /** 写作用哪个模型（缺省沿用 `round.model`，再缺省按目录第一条）。 */
  readonly model: string | undefined
  /** 单页输出预算（缺省取模型声明里的那一档）。 */
  readonly maxTokens: number | undefined
}

/** 一份来源在提交 C 里的事实。`sha` 与 `bytes` 在来源缺失时是 `null`。 */
export interface SourceFact {
  readonly id: string
  readonly source: string
  readonly sha: string | null
  readonly bytes: number | null
}

/** 提交 C 的事实：**完整树回答"现在是什么"**（交接单 § 2.4）。 */
export interface TreeFacts {
  readonly commit: string
  readonly commitShort: string
  /** 提交 C 里 `package.json` 的版本号；没有 `package.json` 或读不动就是 `null`（如实缺）。 */
  readonly version: string | null
  /** 提交 C 里 `package.json` 的 `name`（首页与页首的项目名，缺省用它）。 */
  readonly name: string | null
  /** 完整树里的文件数（不含目录条目）。 */
  readonly files: number
  /** 顶层目录及其文件数（按名字排序；顶层文件不计入）。 */
  readonly topDirs: readonly { readonly name: string; readonly files: number }[]
  /** 每份定义的来源在 C 里的 blob 事实（按定义次序）。 */
  readonly sources: readonly SourceFact[]
  /** 在 C 里找不到的来源（按定义次序）——**报出是哪一份、哪一条路径**。 */
  readonly missing: readonly { readonly id: string; readonly source: string }[]
  /** 完整树的路径表（按字典序；模型据此提出要读的文件）。 */
  readonly paths: readonly string[]
}

/** 一段行（1 起，含两端）。取证按它补读文件的后半。 */
export interface FileRange {
  readonly from: number
  readonly to: number
}

/**
 * 一份取证摘录在清单里的形状：**截断范围进清单**（复审 R3：原先只记 requested/found/missing，
 * 被截断的 7 份一个字都没记，复核时看不出"哪些结论只看到开头"）。
 */
export interface EvidenceRange {
  readonly path: string
  /** 这份文件一共多少行 · 多少字符。 */
  readonly lines: number
  readonly chars: number
  /** 真贴出来的行段（可能多段：开头一段 + 补读的那几段）。 */
  readonly shown: readonly FileRange[]
  /** 还有没贴出来的内容。 */
  readonly truncated: boolean
}

/**
 * 实际采用的模型声明（进指纹）。
 *
 * **只认 id 不够**（复审 R7）：`models.json` 可以在 id 不变时改思考档、温度、输出预算，
 * 那种改动会让同一份正文配上不同的调用参数，却仍被 `status` 判成"最新"。
 * 这里只收**声明**，不收凭据（换密钥不该改指纹）。
 */
export interface ModelFacts {
  readonly id: string
  readonly wireModel: string
  readonly thinking: string | null
  readonly temperature: number | null
  /** 这一趟实际会用的输出预算（`docs.maxTokens` 覆盖之后的那一个）。 */
  readonly maxTokens: number | null
  readonly contextLimit: number | null
}

/**
 * 写作上下文里"本轮变化"那一份（交接单 § 2.5 的三种入口）。
 *
 * **自动收口**：归并与验收刚刚落了定，这一轮改了哪些契约、哪几条提交、验收过没过，是从
 * `RoundRun` 那一个返回值取的——完整树承担事实，这一段承担"改了什么"的讲述；本轮会话里
 * 取得的那一段（`session`）与它并列。
 *
 * **手动 `--at`**：没有本轮，材料只有指定提交；这一栏如实写明"按提交重建"与"没有本轮会话"。
 */
export interface Materials {
  readonly kind: 'round' | 'manual'
  /** 一句给人看的话：这次的材料从哪儿来、缺了什么。 */
  readonly note: string
  readonly round?: string
  readonly contracts?: readonly {
    readonly id: string
    readonly agent: string
    readonly commit: string
    readonly paths: readonly string[]
  }[]
  readonly verify?: { readonly ok: boolean; readonly passed: number; readonly failed: number }
  /**
   * 本轮会话里取得的那一段（交接单 § 2.5 的 "A + B + C"）。**取到的范围写进结果**：
   * 条数 · 字符数 · 实际贴进写作输入的那一段。手动 `--at` 没有这一栏（并在 note 里直说）。
   */
  readonly session?: {
    readonly path: string
    readonly records: number
    readonly chars: number
    /** 实际进写作输入的那一段（超预算时只贴尾部，并注明）。 */
    readonly text: string
  }
}

/** 一次模型调用：三区文本进，一段文本与账出。**接缝在这里，真档与夹具档同形**。 */
export interface DocCallRequest {
  /** A 区：这一批的公共事实（提交 C 的事实与完整树索引）。**同一批里所有调用逐字节相同**——缓存前缀落在这里。 */
  readonly system: string
  /** B 区：这一趟的合同与这一页的材料（写作：合同 + 主题 + 定义 + 来源 + 摘录；取证：另一套合同）。 */
  readonly context: string
  /** C 区：这一次要它做的事（那一句话）。 */
  readonly task: string
  readonly maxTokens?: number
  /** 这一趟的思考档（取证那一趟低一档：它只选文件，不写正文）。 */
  readonly thinking?: ThinkingLevel
}

export interface DocCall {
  readonly text: string
  readonly usage: Usage | null
}

/** 写作接缝：真档走 `writer.ts`（真网络），夹具档在测试里给一个假的。 */
export interface DocCaller {
  /** 我们这边的模型键（进指纹与清单：**换模型 = 过期**）。 */
  readonly model: string
  /** 提供方那边叫它什么（进读数，不进指纹）。 */
  readonly wireModel: string
  readonly thinking?: string
  /** 实际采用的模型声明（指纹用）。不给时只能按 id/wire/thinking 估一份。 */
  readonly facts?: ModelFacts
  call(req: DocCallRequest): Promise<DocCall>
}

/** 一页的生成结果（模型写完、宿主校验完）。 */
export interface PageContent {
  readonly id: string
  readonly markdown: string
  /** 模型点名要读的路径、真读到的、没读到的、真贴出来的行段与被截断的范围（清单里的"取证来源"）。 */
  readonly evidence: {
    readonly mode: 'requested' | 'skipped'
    readonly requested: readonly string[]
    readonly found: readonly string[]
    readonly missing: readonly string[]
    /** 每一份摘录真贴出来的行段（完整或截断，逐份记）。 */
    readonly ranges: readonly EvidenceRange[]
  }
  /** 宿主在校验里兑不掉、如实记下的地方（不可达的引用等）。 */
  readonly notes: readonly string[]
  readonly usage: Usage | null
}

/** 一页渲染完的形状（清单与导航用）。 */
export interface RenderedPage {
  readonly id: string
  readonly title: string
  readonly out: string
  readonly html: string
  /** 正文里的标题（稳定 ID · 文字 · 级别），清单与跨页引用校验用。 */
  readonly headings: readonly { readonly id: string; readonly text: string; readonly level: number }[]
  /** 旧深链接的去向：`旧 id → 新 id`（标题改了而主题没变时，旧链接仍到达内容）。 */
  readonly anchors: Readonly<Record<string, string>>
  readonly notes: readonly string[]
}

/** 清单：**当前可读批次**（交接单 § 3.3）。 */
export interface Manifest {
  readonly version: number
  readonly commit: string
  readonly commitShort: string
  readonly projectVersion: string | null
  readonly fingerprint: string
  readonly generatedAt: string
  readonly theme: string
  readonly themeVersion: number
  readonly renderer: number
  /** 提示词布局的版本（与渲染器分开：换的是模型看见的字节，不是 HTML）。 */
  readonly prompt: number
  readonly model: string
  /** 实际采用的模型声明（指纹的原料；只加不改：`model` 那一栏照旧是 id）。 */
  readonly modelFacts: ModelFacts
  readonly materials: Materials
  readonly pages: readonly {
    readonly id: string
    readonly title: string
    readonly out: string
    readonly source: string
    readonly sourceSha: string | null
    readonly content: string
    readonly evidence: PageContent['evidence']
    readonly cited: readonly string[]
    readonly headings: RenderedPage['headings']
    readonly anchors: Readonly<Record<string, string>>
    /** 上一批有、这一版没有后继的旧地址（**完整枚举**，不是只给几条示例）。 */
    readonly dropped: readonly string[]
    readonly notes: readonly string[]
  }[]
  /** 这一批写出去的文件（路径 + 指纹 + 字节数）——**整批替换的对照表**。 */
  readonly files: readonly { readonly path: string; readonly sha: string; readonly bytes: number }[]
}

/** 最近一次生成尝试：**与现有产物分开归属、分开报告**（交接单 § 1.2 · § 3.3）。 */
export interface LastAttempt {
  readonly ok: boolean
  readonly at: string
  /** 尝试生成对应的提交（失败时也要留：目标提交是"试的是哪一版"）。 */
  readonly commit: string | null
  readonly fingerprint: string | null
  readonly pages: number
  readonly theme: string | null
  readonly model: string | null
  readonly materials: Materials | null
  /**
   * 一次生成的两条用量读数（成功时才有）。**它是"真实调用留下读数"那一条的落点**：
   * 只留在终端的 stdout 上，下一次命令就查不到了——而"最近一次生成"本来就该回答"花了多少"。
   */
  readonly usage?: {
    readonly calls: number
    readonly inputTokens: number | null
    /** 命中缓存的那一部分（老记录里没有这一栏——那时汇总只加了出入两项）。 */
    readonly cacheReadTokens?: number | null
    readonly cacheWriteTokens?: number | null
    readonly outputTokens: number | null
  }
  /** 失败之前**逐页已完成**的用量（第 N 页失败时前 N−1 页不丢）。 */
  readonly usagePages?: readonly {
    readonly id: string
    readonly usage: Usage | null
    readonly evidenceUsage: Usage | null
    readonly rangeUsage: Usage | null
  }[]
  /** 失败原因（成功时 `null`）。 */
  readonly reason: string | null
  /** 失败落在哪一格（`config` · `facts` · `model` · `render` · `publish`）。 */
  readonly at_stage: string | null
}

/** 现有产物那一栏。 */
export type ArtifactState = 'missing' | 'current' | 'stale'

export interface ArtifactReport {
  readonly state: ArtifactState
  /** 产物对应的提交（没有产物就是 `null`）。 */
  readonly commit: string | null
  readonly commitShort: string | null
  readonly fingerprint: string | null
  readonly generatedAt: string | null
  readonly pages: number
  readonly theme: string | null
  /** 当前那一版：状态要从它算出过期与否。 */
  readonly now: { readonly commit: string | null; readonly fingerprint: string | null; readonly error: string | null }
  /** 清单里那几条文件与盘上不一致的路径（空 = 完好）。**它也是"过期"的一种**。 */
  readonly integrity: readonly string[]
}

export interface StatusReport {
  readonly artifact: ArtifactReport
  readonly attempt: LastAttempt | null
  readonly docsDir: string
}
