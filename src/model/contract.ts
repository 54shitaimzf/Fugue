// 模型与提供方的声明。出处：架构 § 10.2（哪些必须固定）· § 10.3（适配器与"声明而不是分支"）·
// § 8.11 表外那一项（调用配置没有位置）· § 8.12 的 `seed` 两条准则（上限 = 模型上限 − Zone A −
// 交接余量）。PLAN § 5.8 的 `B0`。
//
// **这一份是那一栏的值域持有者。** 在它之前，`src/assemble/models.ts` 里是一条占位名
// （`fugue-default`，头注自己写着"真实模型目录属于 S8"），于是每一处要拿"一个模型"的地方
// 都各自理解一遍——适配器按 id 分岔、`seed` 的上界按一句写死的数判。占位表撤掉之后，
// 「有哪几个模型 · 各走哪条线协议 · 发到哪个 host · 上限多少」只有这一处答案。
//
// **`ModelId` 仍住 `src/assemble/contract.ts`，不搬。** 它是装配那边的键（`AssembleInput.model`），
// 搬过来会让 `assemble/` 依赖 `model/`，而装配是纯函数那一层（架构 § 13.4 的 P1）：它不该
// 认识提供方。这里 import 它，方向是单向的。
//
// **两份表·一条记录。** 装配要的只是四个字段（名字 · 系统提示词的更新方式 · 上限 · 调用配置），
// 提供方那三样（`provider` · `wire` · `model`）它一个字都不读。所以前缀那一侧看到的是
// `prefixDeclOf(m)` 投出来的 `PrefixModelDecl`——**投影，不是第二张表**：两边的键域同域这一条
// 由 `PREFIX_MODEL_IDS` 与载入时那一次核对保证，改一处漏一处会当场炸。
//
// **凭据的值不进这一份。** `auth` 只收两样东西：一个环境变量的**名字**，或工作区外的一个
// **路径**；取值那一步是 `authOf()`，它**只在真要出网时被调用**。于是装配 · 重放 · 夹具档
// 一条断言都不碰凭据（PLAN § 5.8 的口径一），"沙箱里看得见的环境"（架构 § 14.4）也仍是闭的。
import { readFileSync } from 'node:fs'
import type { ModelId } from '../assemble/contract.ts'
import { protocolNames } from '../assemble/protocol.ts'

/** 提供方那边的一个模型名（发给它的 `model` 字段）。与 `ModelId` 不是一回事：那是我们这边的键。 */
export type WireModel = string

/** 两条线协议。**名字是这条线上的叫法**，不是我们这边的叫法（架构 § 10.3：Messages 优先）。 */
export type WireName = 'anthropic-messages' | 'openai-chat'

/** 两条线协议的名字，一处。`WIRES` 与它同域。 */
export const WIRE_NAMES: readonly WireName[] = ['anthropic-messages', 'openai-chat']

/** 声明里写错一个线协议名是打错了一个字，不是"以后再支持"——所以它当场拒，并列出有的。 */
export class ModelDeclError extends Error {}

/**
 * 一条线协议：它自己的路径那一段，加上**这条线在请求形状上的能力**。
 *
 * **能力住在线协议这一栏，不住在模型那一栏。** 判据是"这件事是谁的性质"：`cache_control` 是
 * Anthropic Messages 这条线的东西（架构 § 10.3：断点是这条线上的显式数据），不是某个模型的
 * 性质——同一个模型换一条线就没有这个字段了。声明在模型那一栏，两个模型走同一条线却要各写
 * 一遍，而第三个模型接进来时没人知道该抄哪一份。
 *
 * **`host` 不在这一份里**——那是提供方的，不是协议的。
 */
export interface WireDecl {
  readonly path: string
  /**
   * 提示词缓存的**显式断点**。
   *
   * `'explicit'`：这条线要我们声明断点（`{type:'ephemeral'}` 那一档），命中与否看我们放对位置。
   * `'implicit'`：这条线按请求前缀自动命中，**多发一个字段都是噪声**（OpenAI Chat Completions
   * 与 DeepSeek 那一侧的隐式前缀缓存都是这一档。
   *
   * 今天两条线各一档，而**这不是一个空缺**：它是有值域的声明，将来那条线上有第三种（比如
   * 显式但用别的字段名）就加第三个值，适配器多一条分支。
   */
  readonly promptCache: 'explicit' | 'implicit'
}

/**
 * 两条线各自的路径与能力。**"同一个 host 上两条路"是一件事**，不是两条各写一遍的常量。
 */
export const WIRES: Readonly<Record<WireName, WireDecl>> = {
  // **今天这一档是 implicit**，判据是三条读数，不是"新东西还没接上"：
  //   一 · DeepSeek 的上下文缓存是**自动前缀命中**（官方文档：缓存默认开启、按缓存前缀单元
  //        完整匹配计费，命中报 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`）；
  //   二 · 报缺陷那条读数说，`/anthropic` 那条路上把 `system` 发成**内容块数组**会被拒
  //        （`unknown variant system`，那是 400），而把断点放进 `system` 就必须换成数组；
  //   三 · 这个仓库那条线的 `system` 今天是一串**纯文本**（实测请求体 `"system":"…"`），
  //        换形状是三样一起动的改动，而"这条端点收不收断点"本地验不了（要真出网）。
  // **改成 explicit 是一行**：改完请求体里 A 区与 B 区各多一个断点，别的字节不动。
  'anthropic-messages': { path: '/anthropic/v1/messages', promptCache: 'implicit' },
  'openai-chat': { path: '/v1/chat/completions', promptCache: 'implicit' },
}

/**
 * 凭据从哪来。**它是一个引用，不是一份值。**
 *
 * 两档就是两种真实的放法：环境变量（`from: 'env'`，值是那个变量的**名字**）与工作区外的一个
 * 文件（`from: 'file'`，值是路径）。两档都不把凭据写进仓库，也都不让它进事件 · 夹具 · 沙箱环境。
 */
export type AuthRef = { readonly from: 'env'; readonly name: string } | { readonly from: 'file'; readonly path: string }

/**
 * 那个文件**在哪儿**只写一遍：它同时是声明的第二条与报错话里指的那条路。
 *
 * 为什么它有资格进这一份（一个路径也算"声明"）：这一档的凭据**住在工作区之外**是它唯一的形状
 * 约束（PLAN § 5.8 的口径一）——写在这儿，`--root` 指向谁都改不了这个位置。
 */
export const CREDENTIAL_FILE = '/home/ubuntu/.fugue/credentials/deepseek.key'

/**
 * 一个提供方：一个 host 加**一份有序的凭据引用表**。
 *
 * **`host` 是不带路径的那一段**（`https://api.deepseek.com`）：端点由 `WIRES` 与它相乘得到，
 * 于是"同一个 host 上两条路"是一件事，不是两条各写一遍的常量。凭据挂在提供方上：同一个 key
 * 走两条路，这正是"同一模型两个协议可比"那条验证能落地的地方（PLAN § 5.8 的第一处读数）。
 *
 * **`auth` 为什么是一份表而不是一条引用**（第 5 批 · 疑点 4）：原先这里写的是一条（只认环境
 * 变量），而"环境变量优先，其次那个文件"这句话在**三个地方各写了一遍**——这一份、壳的
 * `credentialAt()`、探针自己那一段——坏掉两份是迟早的（实测：`--live --credential <文件>` 与
 * 探针的 `--live` 各踩过一次，而症状是"读到了也没用，换一个地方又说读不到"）。
 * 有序表让"从哪取"变成**一处声明**：`authOf()` 按表逐条试，试完才拒，而拒的话把每一条都
 * 写出来（"环境变量没设"与"文件读不到"是两件事，只报一件会让人以为另一条路不存在）。
 *
 * **顺序是承重的**：环境变量在前——开发机上那个变量是有意设的（临时换 key），而文件是常驻的。
 * 两条都没有时**不返回空串顶替**：空凭据换一个 401，那看起来像"模型不行"，其实是没配。
 */
export interface ProviderDecl {
  readonly id: string
  readonly host: string
  readonly auth: readonly AuthRef[]
}

/** 提供方的常量表。**第一条是缺省**（与 `MODEL_DECLS` 同一条口径）。 */
export const PROVIDERS: Readonly<Record<string, ProviderDecl>> = {
  deepseek: {
    id: 'deepseek',
    host: 'https://api.deepseek.com',
    // 两条路：**环境变量优先，其次工作区外那个文件**（顺序由这张表说，不散在调用点上）。
    // 名字在这儿、路径也在这儿，值两处都不在——`authOf()` 是唯一取值处。
    auth: [
      { from: 'env', name: 'DEEPSEEK_API_KEY' },
      { from: 'file', path: CREDENTIAL_FILE },
    ],
  },
}
/**
 * 一个模型的声明。八个字段，每一个都有一条被读的理由：
 *
 * - `id`：我们这边的键，也是命令行 `--model` 收的那一串。
 * - `protocol`：**这个模型读哪一份系统提示词**（架构 § 8.11 的 `Protocol` 值的名字）。它是
 *   一个名字而不是一个值：解析成协议值是装配那一侧的事（`protocolFor`），这一份只声明"哪一份"。
 *   于是"换一个模型换一份提示词"是一个数据字段，而不是某处的分支——§ 10.3 的判据。
 * - `provider` · `wire` · `model`：**请求发给谁 · 走哪条线 · 那边叫它什么名字**。三样分开是
 *   因为它们的值域各不相同：一个 host 上有两条路（`deepseek-chat` 两个线协议），一条路上有
 *   好几个模型。**适配器只读 `wire`，不读 `id`**——架构 § 10.3 的判据：适配器里出现
 *   `if (model === 'x')` 就是漏了一个声明式字段。
 * - `systemPromptUpdate`：两行（`in-history` · `rewrite-head`），逐字来自架构 § 8.11 那张
 *   "模型的声明 → C 怎么增长"的表。落到处理上是**三种**，那三种归提供方（§ 10.3）。
 * - `contextLimit`：上下文的上界。`seed` 那一条的不动项（架构 § 8.12）。
 * - `budget`：三个模型相关的数——上限 · 触发点 · 交接余量（架构 § 23 U6：这一站只建立口径，
 *   **具体取值要等 `B7` 的读数**，所以触发点是从上限算出来的，不是一条独立常量）。
 * - `call`：轮内固定那四条里属于调用配置的那一条（§ 10.2）。**它没有位置，所以不进前缀**
 *   （§ 8.11 表外那一项）——拼进去的话，同一份状态换一个温度就换掉整条前缀，而缓存对此一无所知。
 */
export interface ModelDecl {
  readonly id: ModelId
  /** 系统提示词那一份的名字（`PROTOCOLS` 的键）。**载入时核对它真的存在**。 */
  readonly protocol: string
  readonly provider: string
  readonly wire: WireName
  readonly model: WireModel
  readonly systemPromptUpdate: 'in-history' | 'rewrite-head'
  readonly contextLimit: number
  readonly budget: {
    /** 步数走到这里就写交接提示词（**先停**，不是撞了上限才补救）。 */
    readonly trigger: number
    /** 交接要留出的那一片（架构 § 8.12 的 `HANDOFF_MARGIN`）。 */
    readonly handoffMargin: number
  }
  readonly call: {
    readonly temperature?: number
    readonly maxTokens?: number
  }
}

/**
 * 预算的触发点：上限的一个比例，**取整到整数**。
 *
 * 它是函数不是常量，理由写在架构 § 23 U6：触发点与交接余量都是**模型相关的量**，而真实取值
 * 要等 `B7` 的 `handoff-yield` 读数。今天从一个比例算出来，改的是这一个数，不是七处声明。
 */
export function triggerAt(contextLimit: number): number {
  return Math.floor(contextLimit * 0.75)
}

/**
 * 两条路上的一份调用配置：轮内固定（架构 § 10.2 的必固四条之一）——**今天它是空的**。
 *
 * 空不是遗漏，是两件事的结论：
 *
 *   一 · **"缺省"在两个线协议上语义不同**。Messages 那条线上 `temperature` 不填 = 由提供方定
 *        （那边默认是 1），填 0.2 就是**真的要 0.2**；Chat Completions 那条线上同理。所以"我们
 *        这边的缺省值"这句话没有唯一的意思——一个共用常量表达不了它。适配器各自把"没填"翻成
 *        自己那条线上的"不出现"（`B2`）。
 *   二 · **温度要给哪一档，得等读数**。它改的是模型的伸手率与零工具调用率（`B7` 的两个一线
 *        指标），而在 `B7` 之前定一个数，就是在拿一个没有依据的值当基线。声明里留着这一栏：
 *        真要固定，它是一个模型一条记录的字段，不是全站共用的常量。
 */
export const DEFAULT_CALL: Readonly<{ temperature?: number; maxTokens?: number }> = {}

/**
 * 模型目录。**今天两条记录，同一个模型的两个线协议。**
 *
 * 两条都留着，是因为"同一模型两个协议可比"是 S8 的第二条验证（架构 § 20）：只声明一条的话，
 * 那条验证在 `B2` 就没法落地（两个适配器里有一个没有声明喂它）。`budget` 两行都由
 * `triggerAt(contextLimit)` 算出来，于是"上限 · 触发点 · 交接余量"三者的关系只有一处。
 *
 * **`protocol` 两条都是 `'subagent'`。** 这不是抄的：`'holder'` 是**持轮者那一格**用的
 * （B 区多两段、少一段），而模型目录描述的是"干一格的 agent"，不是轮次的主线。持轮者换不换
 * 提示词由轮次那一层定（`round/driver.ts`），不由模型定。
 */
export const MODEL_DECLS: Readonly<Record<string, ModelDecl>> = {
  'deepseek-chat/anthropic': {
    id: 'deepseek-chat/anthropic' as ModelId,
    protocol: 'subagent',
    provider: 'deepseek',
    wire: 'anthropic-messages',
    model: 'deepseek-chat',
    systemPromptUpdate: 'in-history',
    contextLimit: 128_000,
    budget: { trigger: triggerAt(128_000), handoffMargin: 16_000 },
    call: DEFAULT_CALL,
  },
  'deepseek-chat/openai': {
    id: 'deepseek-chat/openai' as ModelId,
    protocol: 'subagent',
    provider: 'deepseek',
    wire: 'openai-chat',
    model: 'deepseek-chat',
    systemPromptUpdate: 'in-history',
    contextLimit: 128_000,
    budget: { trigger: triggerAt(128_000), handoffMargin: 16_000 },
    call: DEFAULT_CALL,
  },
}

/** 目录里的名字，按表的键序。**第一条是缺省**（Messages 优先，架构 § 10.3）。 */
export const MODEL_IDS: readonly string[] = Object.keys(MODEL_DECLS)

/**
 * 前缀那一侧的投影：**装配真的会读的那四个字段**。
 *
 * 它是 `ModelDecl` 的一个子集，而这件事由类型表达（`Pick<ModelDecl, …>`）——加一个字段忘了
 * 投影，编译不过。
 *
 * **`protocol` 不在这一份里。** 它不是"装配读的字段"，是"选哪一份装配"的键：`assemble()`
 * 收到的是协议值本身，而不是一个名字。名字的解析在 `protocolFor()`，那里是唯一一处把
 * `ModelDecl` 翻成 `Protocol` 的地方。
 */
export type PrefixModelDecl = Pick<ModelDecl, 'id' | 'systemPromptUpdate' | 'contextLimit' | 'call'>

/** 前缀那一侧看得见的那些名字。**与 `MODEL_DECLS` 同域**，由载入时那一次核对保证。 */
export const PREFIX_MODEL_IDS: readonly string[] = MODEL_IDS

/** 一个声明 → 前缀那一侧看到的四个字段。**投影，不是改写**：四个字段原样搬。 */
export function prefixDeclOf(m: ModelDecl): PrefixModelDecl {
  return { id: m.id, systemPromptUpdate: m.systemPromptUpdate, contextLimit: m.contextLimit, call: m.call }
}

/** 前缀那一侧的表：`src/assemble/models.ts` 的 `MODELS` 就是它。 */
export const PREFIX_MODELS: Readonly<Record<string, PrefixModelDecl>> = Object.fromEntries(
  Object.entries(MODEL_DECLS).map(([name, m]) => [name, prefixDeclOf(m)]),
)

/** 缺省模型。**表的第一条**——不是一条写在别处的常量（写两处就会漂）。 */
export const DEFAULT_MODEL: ModelDecl = MODEL_DECLS[MODEL_IDS[0] as string] as ModelDecl

/**
 * 按名字取一个声明。**查不到就拒，不替它挑一个**——"没写 model"与"写了一个没有的 model"是
 * 两件事：前者走缺省，后者是打错了一个字，静默替他选一个会让命令行那次装配的读数指着另一个
 * 模型。与 `--agent` 拒未知名字是同一条口径（PLAN § 5.6 的 Z4）。
 */
export function modelDeclOf(id: string | undefined): ModelDecl {
  if (id === undefined || id === '') return DEFAULT_MODEL
  const m = MODEL_DECLS[id]
  if (m === undefined) {
    throw new ModelDeclError(`没有这个模型：${id}（目录里只有 ${MODEL_IDS.join(' · ')}）`)
  }
  return m
}

/** 按名字取一个提供方。同上：查不到就拒。 */
/**
 * 一条线协议的发断点方式。**声明 → 请求形状的唯一一处解析。**
 *
 * 为什么不把这一档抄进 `ModelDecl`：那样同一个事实就有两处（线协议一栏 · 模型一栏），
 * 改一处漏一处**不报错**，只表现为多一个或少一个断点。
 */
export function promptCacheFor(wire: string): WireDecl['promptCache'] {
  const w = WIRES[wire as WireName]
  if (w === undefined) throw new ModelDeclError(`没有这条线协议：${wire}（有的是 ${WIRE_NAMES.join(' · ')}）`)
  return w.promptCache
}

export function providerOf(id: string): ProviderDecl {
  const p = PROVIDERS[id]
  if (p === undefined) {
    throw new ModelDeclError(`没有这个提供方：${id}（目录里只有 ${Object.keys(PROVIDERS).join(' · ')}）`)
  }
  return p
}

/** 一个名字是不是目录里那个。**判据是目录，不是形状**（形状对了但没声明过的名字仍然拒）。 */
export function isModelRef(id: string): boolean {
  return MODEL_DECLS[id] !== undefined
}

/** 环境变量名的形状：大写字母 · 数字 · 下划线，且不以数字开头。 */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/

/**
 * 一处凭据的**形状**：一条引用合不合法。**只判形状，不判它指得到指不到**——指不到是 `authOf()`
 * 的失败，那时才有人读得到那句话。
 *
 * 环境变量名那一条是有牙齿的：它把 `sk-…` 这样的**值**挡在门外（含小写字母 · 连字符之类的东西
 * 都进不来），因为"把凭据写进声明"是这一档唯一要防住的事。
 */
export function isAuthRef(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  const r = v as { from?: unknown; name?: unknown; path?: unknown }
  if (r.from === 'env') return typeof r.name === 'string' && ENV_NAME.test(r.name)
  if (r.from === 'file') return typeof r.path === 'string' && r.path !== '' && !r.path.includes('\n')
  return false
}

/**
 * **一份有序的引用表**合不合法：非空 · 每一条合形状 · 至少有一条环境变量。
 *
 * "至少一条环境变量"不是风格：这一档的默认放法是环境变量（架构 § 10.2），而一份只认文件的
 * 声明会让"临时换一个 key"变成改文件——那条路是给"没有环境变量这一档"的场合留的。
 */
export function isAuthChain(v: unknown): boolean {
  if (!Array.isArray(v) || v.length === 0) return false
  if (!v.every(isAuthRef)) return false
  return v.some((r) => (r as { from?: unknown }).from === 'env')
}

/** 一条引用的人读写法（`authOf()` 的报错话里用它，别的用处没有）。 */
function authRefText(a: AuthRef): string {
  return a.from === 'env' ? `环境变量 ${a.name}` : `文件 ${a.path}`
}

/**
 * 取一次凭据。**这一份里唯一读凭据的地方，而它只在真要出网时被调用。**
 *
 * 按声明的顺序逐条试（环境变量 → 文件）。每条各自记着"为什么不行"，最后**一句里把每一条都写
 * 出来**——只报最后那一条的话，人会以为前一条路不存在（"读不到文件"而其实是环境变量没设）。
 * **不返回空串顶替**：空凭据发出去换来一个 401，那看起来像"模型不行"，而其实是没配。
 *
 * 一次都没有时给的就是那句话；**中途成功就当场返回**（后面的引用一个字节都不碰：顺序是承重的，
 * 而"读第二个文件"这种事不该在第一个成功之后还发生）。
 */
export function authOf(p: ProviderDecl): string {
  return authOfTable(p, p.auth)
}

/**
 * 取一次凭据，**顺序照声明，只是"文件在哪"那一格换成 `--credential <路径>` 给的那一个**。
 *
 * 覆盖的是**那个文件的位置**，不是"要不要看环境变量"：环境变量那条路照旧最优先（顺序由声明
 * 说），所以"临时换一份 key"不必改声明。
 */
export function authWith(p: ProviderDecl, override: string | null = null): string {
  // **空串当场拒**：`--credential ''` 若照原样进头里，换来的是一个 401——那看起来像"模型不行"，
  // 其实是没给值（`targetAt` 为空串也拒，两处同一条口径）。
  if (override !== null && override === '') {
    throw new ModelDeclError('凭据不能是空串：空凭据发出去换来一个 401，那看起来像"模型不行"，其实是没给值')
  }
  // `--credential <路径>` 给的是**那个文件**：顺序照声明（环境变量优先），只是文件那一格换成它。
  // 覆盖的是"文件在哪"，不是"要不要看环境变量"——这一条让"临时换一份 key"不必改声明，而
  // 环境变量那条路照旧最优先。
  const table: readonly AuthRef[] =
    override === null
      ? p.auth
      : p.auth.map((a) => (a.from === 'file' ? ({ from: 'file', path: override } as const) : a))
  return authOfTable(p, table)
}

/**
 * 取一次凭据，按一份**指定的**表。`authOf()` 与 `authWith()` 都走它——两份实现会让"环境变量
 * 优先，其次那个文件"这句话变成两处（第 5 批 · 疑点 4 的由头正是这种重复）。
 */
function authOfTable(p: ProviderDecl, table: readonly AuthRef[]): string {
  const tried: string[] = []
  for (const a of table) {
    if (a.from === 'env') {
      const v = process.env[a.name]
      if (v !== undefined && v !== '') return v
      tried.push(`${authRefText(a)}：没有设`)
      continue
    }
    let text: string
    try {
      text = readFileSync(a.path, 'utf8')
    } catch (err) {
      tried.push(`${authRefText(a)}：读不到（${(err as NodeJS.ErrnoException).code ?? '未知原因'}）`)
      continue
    }
    const v = text.trim()
    if (v === '') {
      tried.push(`${authRefText(a)}：是空的`)
      continue
    }
    return v
  }
  throw new ModelDeclError(
    `提供方 ${p.id} 的凭据不在——试过的那 ${table.length} 条路都不行：\n` +
      tried.map((t) => `  · ${t}`).join('\n') +
      `\n  两条都是"工作区外的一个声明路径"：不给 --live 就是打桩那一档，它一条断言都不需要凭据` +
      `（PLAN § 5.8 的口径一）。`,
  )
}
/**
 * 载入时那一次核对：**两份表的键域同域**，加上那几条一眼看得出写错的声明。
 *
 * 它封的是"静默失效"那一类：投影漏掉一条记录，命令行那次装配的读数就指着另一个模型，而
 * 没有一处会报错。与 `contract/types.ts` 的 `unownedFields` 载入时当场炸是同一条纪律。
 *
 * **`protocol` 那一条同属这一类**：声明里写了一个不存在的协议名，后果是"装配出来的前缀是
 * 别人的那一份"——多一段少一段都只是字节不同，没有别的报错。所以它和键域那几条一起当场炸。
 */
const mismatch: string[] = []
for (const name of MODEL_IDS) {
  if (PREFIX_MODELS[name] === undefined) mismatch.push(`${name} 有声明，前缀那一侧看不见`)
  else if (PREFIX_MODELS[name].id !== MODEL_DECLS[name].id) mismatch.push(`${name} 的投影换了名字`)
}
for (const name of Object.keys(PREFIX_MODELS)) {
  if (MODEL_DECLS[name] === undefined) mismatch.push(`${name} 在前缀那一侧有，却没有声明`)
}
for (const [id, p] of Object.entries(PROVIDERS)) {
  if (!isAuthChain(p.auth)) mismatch.push(`提供方 ${id} 的凭据引用表不合形状（要非空 · 每条合形状 · 至少一条环境变量）：${JSON.stringify(p.auth)}`)
}
for (const [name, m] of Object.entries(MODEL_DECLS)) {
  if (!WIRE_NAMES.includes(m.wire)) mismatch.push(`${name} 的线协议没有这一条：${m.wire}`)
  if (PROVIDERS[m.provider] === undefined) mismatch.push(`${name} 指的提供方没有声明：${m.provider}`)
  if (!protocolNames().includes(m.protocol)) {
    mismatch.push(`${name} 指的协议没有这一份：${m.protocol}（有的是 ${protocolNames().join(' · ')}）`)
  }
  if (m.systemPromptUpdate !== 'in-history' && m.systemPromptUpdate !== 'rewrite-head') {
    mismatch.push(`${name} 的系统提示词更新方式没有这一档：${String(m.systemPromptUpdate)}`)
  }
}
if (mismatch.length > 0) {
  throw new Error(`模型声明与它的投影对不上：\n  ${mismatch.join('\n  ')}`)
}

// ── B1 · 调用的边界（冻结接口点）────────────────────────────────────────────────
//
// 出处：架构 § 14.2 那六步里的第 2 步（`resp = llm.call(prefix, tools = M9.schema())`）·
// § 10.1（内部 `Protocol` 保持规范形状，适配器只做翻译）· § 10.2 的必固四条 · § 8.10（工具
// schema 的形状与硬纪律 2）· § 8.15（用量四个数是"钱"那一侧的读数）。PLAN § 5.8 的 `B1`。
//
// **这一份冻结的是三个世界之间的那道边界**：左边是装配出来的三区字节，右边是线协议上的
// 请求与事件，两个适配器 · 循环 · 夹具 · 录制全押在下面这几个形状上。
//
// **`ModelRequest` 是**值**，不是一次发送。** 它里面没有 host · 没有凭据 · 没有线协议的名字：
// 三样都属于"怎么送出去"，归 `B2` 的适配器与 `B3` 的传输（架构 § 10.1 的四层里，这里是**传输**
// 那一层的边界）。所以断言 ④"凭据的值不出现在请求体里"不是靠自觉，是**签名里没有那个位置**。
//
// **三区就是稳定性等级**（架构 § 8.11），所以请求里也按区带着：`zones.A` 跨 N 个 agent 全等 ·
// 相邻两步只有 `zones.C` 变。适配器把它们拼成自己那边的形状（`system` 那一条放 A 区，历史放
// B 区，最新那一段放 C 区），而**区与区的分界是装配的结论，不是适配器的选择**。
//
// **事件流是唯一一份"一次调用发生了什么"。** `usage` 可以**没有**（流式请求里提供方常常不带），
// 那时它就是"没有读数"——**不拿 0 顶**（PLAN § 5.8 的 `B1` 断言 ②）：0 是一个真实的值（缓存
// 写入 0 · 输出 0），与"没量到"必须分得开，否则 `B7` 的 `prefix-hit-rate` 会把"没量到"算成 0%。

/** 用量。**四个数是"钱"那一侧的读数**（架构 § 8.15 的 `prefix-hit-rate` 读它）。 */
export interface Usage {
  /** 输入里**没命中**缓存的那一部分。 */
  readonly inputTokens: number | null
  /** 命中缓存、按折扣计价的那一部分（Anthropic 系的 `cache_read_input_tokens` 那一档）。 */
  readonly cacheReadTokens: number | null
  /** 这次调用**写进**缓存的那一部分（有断点的协议才有这一项；隐式缓存的那条线上是 `null`）。 */
  readonly cacheWriteTokens: number | null
  readonly outputTokens: number | null
  /** 提供方自己的结束原因，原样带过来（不是我们那套 `StopReason`）。 */
  readonly rawStop: string | null
  /** 提供方报的模型名——**它可能与声明的 `model` 不同**（别名 · 路由），所以两个都留着。 */
  readonly model: string | null
}

/**
 * **用量的四个数**：架构 § 8.15 与 § 14.2 说的"用量的四个数"就是这四个（缓存命中率那个指标的
 * 全部输入）。名字一处，报错的话与读数表读的是同一串。
 */
export const USAGE_COUNTS: readonly (keyof Usage)[] = [
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
]

/**
 * 这一栏的全部字段：四个数 + 提供方自己的结束原因 + 它报的模型名。后两样不是用量，是**读数旁边
 * 的两个坐标**（一个是"为什么停"的原始说法，一个是"它说它是谁"）——分开列，是为了让"四个数"
 * 这句话有一处指得出来，而不是被这两个坐标混进去变成六个。
 */
export const USAGE_FIELDS: readonly (keyof Usage)[] = [...USAGE_COUNTS, 'rawStop', 'model']

/**
 * 一段工具调用**收尾之前**的样子：参数是一串还没拼完的 JSON（线协议上它是分片流过来的）。
 *
 * `id` 允许是 `null`：两条线协议里，`tool_use` 那种带 id，而有些兼容实现不发 id。**不替它编一个**
 * ——编出来的 id 会进日志，而日志是"模型做了什么"的账。
 */
export interface ToolCallDelta {
  readonly index: number
  readonly id: string | null
  readonly name: string | null
  readonly args: string
}

/** 一条收尾的工具调用。`arguments` 是**原样的参数 JSON 文本**（不在这里解析成对象）。 */
export interface ToolCall {
  readonly id: string | null
  readonly name: string
  readonly arguments: string
}

/**
 * 一次调用为什么结束。**五种，不合成"结束了"**（PLAN § 5.8 的 `B4` 断言 ③ 要它们分得开）。
 */
export type StopReason =
  | 'tool-calls'
  | 'end-turn'
  | 'max-tokens'
  | 'stop-sequence'
  | 'refusal'

/** 五种结束原因在盘上的名字，一处。 */
export const STOP_REASONS: readonly StopReason[] = ['tool-calls', 'end-turn', 'max-tokens', 'stop-sequence', 'refusal']

/**
 * 发给模型的一个请求。四个字段，**一个都不多**（PLAN § 5.8 的 `B1` 断言 ①）：
 *
 * - `model`：声明里**提供方那边**的名字（`ModelDecl.model`，不是我们这边的 `id`）。适配器拿它
 *   填自己那边的 `model` 字段——一条记录里两个名字，一个是对内的键，一个是对外的名。
 * - `zones`：三个区的字节，**按区带**（不是拼好的一条）。装配的结论（哪一段属于哪个稳定性等级）
 *   在这一层仍然看得见，适配器不需要自己猜。
 * - `tools`：工具 schema。**它是随请求走的那份数据**（架构 § 8.11 表外那一项：位置由提供方定），
 *   所以它不在三区里，而是这里的一个字段。缺省 = 这次不带工具。
 * - `call`：轮内固定的调用配置（架构 § 10.2 的必固四条之一）。
 */
/**
 * 一步的往返。**它是 C 区那个积累段的结构化那一面**（文本那一面由 `sources.ts` 的 `turnText`
 * 从一个 `Turn` 渲染出来，两处同源，不许各写一份）。
 *
 * 为什么要两面：发出去的要是**原生轮次**——`tool_use` → `tool_result` 这条配对是所有模型训练
 * 时就见过的形状，而把它重述成一段文本等于只用了前半段（模型在上下文里看不见自己伸手的那一下，
 * 于是重复调用、也不知道该收工）。而字节那一面要留着：三区指纹 · 相邻两步的 `hash(A+B)` ·
 * 只追加这条性质，量的都是它。
 */
export interface Turn {
  /** 模型这一步说的话（没说就没有这一栏）。 */
  readonly text?: string
  /** 它调了哪几条工具（`arguments` 是原样那一串 JSON 文本）。 */
  readonly calls: readonly { readonly id: string | null; readonly name: string; readonly arguments: string }[]
  /** 每一条回了什么。与 `calls` 逐条对位。 */
  readonly results: readonly { readonly id: string | null; readonly output: string; readonly isError: boolean }[]
}

export interface ModelRequest {
  readonly model: WireModel
  readonly zones: {
    /** 跨 N 个 agent 逐字节相同的那一段（架构 § 8.11 的验证性质）。 */
    readonly A: Uint8Array
    /** 同一 agent 跨步稳定的那一段。 */
    readonly B: Uint8Array
    /** 只追加的那一段——相邻两步只有它变。 */
    readonly C: Uint8Array
  }
  /**
   * 这一条线的断点**由谁声明**（`WIRES` 那一栏原样带过来，见 `promptCacheFor`）。
   *
   * `'explicit'`：适配器在 A 区与 B 区的边界各放一个断点；`'implicit'`：什么都不发，命中由
   * 这条线的自动前缀匹配决定。**必填**：给个缺省值就说不清"没声明"与"声明了隐式"这两件事，
   * 而两者的请求体字节不同（多一个 `cache_control`）。
   */
  readonly promptCache: 'explicit' | 'implicit'
  /**
   * 已经走过的那几步（**只追加**：新的一步在末尾）。
   *
   * 给了它，适配器就发**原生轮次**（assistant 的 tool_use，user 的 tool_result，一开一合）；不给（夹具 ·
   * 第 0 步 · 另一条线协议）就照旧把 C 区那条文本当一条 user 消息发出去——**两条路都不改 A/B
   * 两区的字节**，所以前缀那笔账不破。
   */
  readonly turns?: readonly Turn[]
  readonly tools?: readonly ToolEntry[]
  readonly call?: {
    readonly temperature?: number
    readonly maxTokens?: number
  }
}

/**
 * 一次调用里流出来的事件。**六种，顺序有约束**（`checkEvents` 把约束写成一条会失败的检查）：
 *
 *   delta…（任意多条）  tool-start / tool-delta… / tool-call（可重复，按 `index` 交错）
 *   usage（可以没有；给了就并进总账）  stop（**恰好一条，且是最后一条**）
 *
 * **文本增量与工具调用可以交错**——真实的两条线协议都允许，所以这里不假设先后。
 */
export type ModelEvent =
  | { readonly t: 'delta'; readonly text: string }
  | { readonly t: 'tool-start'; readonly index: number; readonly id: string | null; readonly name: string | null }
  | { readonly t: 'tool-delta'; readonly index: number; readonly args: string }
  | {
      readonly t: 'tool-call'
      readonly index: number
      readonly id: string | null
      readonly name: string
      readonly arguments: string
    }
  /** 这一份**只是这一条事件报的那几个数**；没报的字段不在这里（并账见 `usageUpdate`）。 */
  | { readonly t: 'usage'; readonly usage: Partial<Usage> }
  | { readonly t: 'stop'; readonly reason: StopReason; readonly raw?: string }

/** `USAGE_FIELDS` 里那几个数取到一个真值：`null` 与"这个键根本不在"都算没有读数。 */
export function usageCount(u: Usage): number {
  const one = (v: number | null | undefined): number => (typeof v === 'number' ? 1 : 0)
  return one(u.inputTokens) + one(u.cacheReadTokens) + one(u.cacheWriteTokens) + one(u.outputTokens)
}

/** 一次调用积出来的东西。**`usage` 与 `stop` 的 `null` 是"没有读数"，不是 0**（见下面两条）。 */
export interface ModelCall {
  readonly text: string
  readonly toolCalls: readonly ToolCall[]
  /** `null` = 这一串事件里没有任何读数；字段为 `null` = 那一项没量到。**两级都不是 0。** */
  readonly usage: Usage | null
  /** `null` = 一个 `stop` 事件都没有（这一串事件是半截的）。 */
  readonly stop: StopReason | null
  /** 提供方自己的结束原因，原样带过来（没有就是 `null`）。 */
  readonly rawStop: string | null
}

/** 事件序列不成立：次序乱了 · 少了收尾 · 多了收尾 · 数字不是整数 · 参数分片落在一个没开过的调用上。 */
export class EventSequenceError extends Error {}

/** 一条事件报的那几个数并进总账：**只覆盖它真的报了的字段**，别的保持原样（包括保持 `null`）。 */
export function usageUpdate(prev: Usage | null, part: Partial<Usage>): Usage {
  const base: Usage = prev ?? {
    inputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    rawStop: null,
    model: null,
  }
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(part)) {
    if (v !== undefined && v !== null) out[k] = v
  }
  return out as unknown as Usage
}

function isIndex(v: number): boolean {
  return Number.isInteger(v) && v >= 0
}

/**
 * 一串事件 → 一次调用的账。**顺序的约束在这一处**，五种坏法各抛一条带指路的话。
 *
 * 它是 `B3` 的两个适配器的共同出口：适配器负责"字节 → 事件"，这一份负责"事件 → 一次调用"。
 * **两条线协议的差别到此为止**——所以"同一模型两个协议可比"这条验证（架构 § 20 S2）比的是
 * 这里积出来的东西，不是上游那两串字节。
 */
export function checkEvents(events: readonly ModelEvent[]): ModelCall {
  let text = ''
  let usage: Usage | null = null
  let rawStop: string | null = null
  let stop: StopReason | null = null
  /** `undefined` = 还没有 `stop`；一旦有了就不再接受任何事件（收尾只有一条，架构 § 14.2 第 2 步）。 */
  let over: StopReason | undefined
  const parts = new Map<number, { id: string | null; name: string | null; args: string }>()
  const done: ToolCall[] = []

  for (const [at, e] of events.entries()) {
    if (over !== undefined) throw new EventSequenceError(`第 ${at} 条事件排在 \`stop\` 之后：一次调用的收尾只有一条（架构 § 14.2 的第 2 步）`)
    switch (e.t) {
      case 'delta':
        if (typeof e.text !== 'string') throw new EventSequenceError(`第 ${at} 条 \`delta\` 的 text 不是字符串`)
        text += e.text
        break
      case 'tool-start': {
        if (!isIndex(e.index)) throw new EventSequenceError(`第 ${at} 条 \`tool-start\` 的 index 要是一个非负整数：${String(e.index)}`)
        if (parts.has(e.index)) throw new EventSequenceError(`第 ${at} 条 \`tool-start\` 又开了一次已经在跑的 index ${e.index}`)
        if (e.id !== null && (typeof e.id !== 'string' || e.id === '')) {
          throw new EventSequenceError(`第 ${at} 条 \`tool-start\` 的 id 要么是 null（这条线协议不发 id），要么是一个非空字符串`)
        }
        if (e.name !== null && (typeof e.name !== 'string' || e.name === '')) {
          throw new EventSequenceError(`第 ${at} 条 \`tool-start\` 的 name 要么是 null（分片里后到），要么是一个非空字符串`)
        }
        parts.set(e.index, { id: e.id, name: e.name, args: '' })
        break
      }
      case 'tool-delta': {
        if (!isIndex(e.index)) throw new EventSequenceError(`第 ${at} 条 \`tool-delta\` 的 index 要是一个非负整数：${String(e.index)}`)
        const p = parts.get(e.index)
        if (p === undefined) throw new EventSequenceError(`第 ${at} 条 \`tool-delta\` 落在一个没开过的 index ${e.index} 上（要先有 \`tool-start\`）`)
        if (typeof e.args !== 'string') throw new EventSequenceError(`第 ${at} 条 \`tool-delta\` 的 args 不是字符串`)
        parts.set(e.index, { id: p.id, name: p.name, args: p.args + e.args })
        break
      }
      case 'tool-call': {
        if (!isIndex(e.index)) throw new EventSequenceError(`第 ${at} 条 \`tool-call\` 的 index 要是一个非负整数：${String(e.index)}`)
        if (typeof e.name !== 'string' || e.name === '') throw new EventSequenceError(`第 ${at} 条 \`tool-call\` 的 name 不能是空的`)
        if (typeof e.arguments !== 'string') throw new EventSequenceError(`第 ${at} 条 \`tool-call\` 的 arguments 要是原样的参数 JSON 文本`)
        // 两样都能是"收尾"：一直在分片的那一条（累下来的参数就是它）与整条到手的那一条。
        // **两样都给了的话必须对得上**——对不上就是这一份账自己矛盾，报出来，不挑一个用。
        const open = parts.get(e.index)
        if (open === undefined) {
          done.push({ id: e.id, name: e.name, arguments: e.arguments })
        } else {
          if (e.arguments !== '' && e.arguments !== open.args) {
            throw new EventSequenceError(
              `第 ${at} 条 \`tool-call\` 说这条路（index ${e.index}）在这一步收尾，可它的参数与分片累下来的那一串对不上：` +
                `分片给了 ${open.args.length} 个字符，这一条给了 ${e.arguments.length} 个`,
            )
          }
          done.push({ id: e.id, name: open.name ?? e.name, arguments: open.args })
          parts.delete(e.index)
        }
        break
      }
      case 'usage': {
        if (typeof e.usage !== 'object' || e.usage === null) throw new EventSequenceError(`第 ${at} 条 \`usage\` 要带一个对象`)
        usage = usageUpdate(usage, e.usage)
        break
      }
      case 'stop': {
        if (!STOP_REASONS.includes(e.reason)) throw new EventSequenceError(`第 ${at} 条 \`stop\` 的 reason 没有这一种：${String(e.reason)}`)
        stop = e.reason
        over = e.reason
        rawStop = typeof e.raw === 'string' ? e.raw : null
        break
      }
      default: {
        const never: never = e
        throw new EventSequenceError(`没有这一种事件：${JSON.stringify(never)}`)
      }
    }
  }

  if (over === undefined) throw new EventSequenceError('这一串事件里没有 `stop`：一次调用的收尾必须恰好有一条（半截的响应不许当完整的用）')
  if (parts.size > 0) {
    const open = [...parts.keys()].join(' · ')
    throw new EventSequenceError(`有 ${parts.size} 条工具调用开着没收尾（index ${open}）：分片拼完了要有 \`tool-call\``)
  }
  // `stop` 已经是一条 `stop` 事件给的（上面那次检查），所以这里的 `stop` 一定是那五种之一。
  return { text, toolCalls: done, usage, stop: stop as StopReason, rawStop }
}

/** 把分片拼完的那几条工具调用取出来。**与 `checkEvents` 同一条实现**（一处，两个出口）。 */
export function toolCallsIn(events: readonly ModelEvent[]): ToolCall[] {
  return checkEvents(events).toolCalls
}

/** 一次调用停成了什么。**给循环判"还要不要再走一步"用**（`B4` 的三档 `StepOutcome`）。 */
export function stopped(events: readonly ModelEvent[]): StopReason {
  const stop = checkEvents(events).stop
  if (stop === null) throw new EventSequenceError('这一串事件里没有 `stop`')
  return stop
}

/**
 * 一个请求的 JSON 文本：**键按字典序**（同 `render.ts` 的 `stableStringify` 那条口径）。
 *
 * 它是断言 ③ 的度量：**同一份状态装配两次，请求体逐字节相同**。对象字面量的键序是写下来的顺序，
 * 而缓存要求的是**字节**——所以"逐字节相同"这句话得有一个确定的序列化才对得上。
 */
export function requestJson(r: ModelRequest): string {
  const order = (v: unknown): unknown => {
    if (v instanceof Uint8Array) return new TextDecoder().decode(v)
    if (Array.isArray(v)) return v.map(order)
    if (typeof v === 'object' && v !== null) {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const one = (v as Record<string, unknown>)[k]
        // `undefined` 的那一栏**整个不出现**（不是 `null`）：`JSON.stringify` 就是这么做的，
        // 而"这次不带工具"必须在字节上看得出来——写成 `null` 会让两条不同的请求长得一样。
        if (one !== undefined) out[k] = order(one)
      }
      return out
    }
    return v
  }
  return JSON.stringify(order(r))
}
