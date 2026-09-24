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

/** 提供方那边的一个模型名（发给它的 `model` 字段）。与 `ModelId` 不是一回事：那是我们这边的键。 */
export type WireModel = string

/** 两条线协议。**名字是这条线上的叫法**，不是我们这边的叫法（架构 § 10.3：Messages 优先）。 */
export type WireName = 'anthropic-messages' | 'openai-chat'

/** 两条线协议的名字，一处。`WIRES` 与它同域。 */
export const WIRE_NAMES: readonly WireName[] = ['anthropic-messages', 'openai-chat']

/** 声明里写错一个线协议名是打错了一个字，不是"以后再支持"——所以它当场拒，并列出有的。 */
export class ModelDeclError extends Error {}

/** 一条线协议：它自己的路径那一段。**host 不在这一份里**——那是提供方的，不是协议的。 */
export const WIRES: Readonly<Record<WireName, { readonly path: string }>> = {
  'anthropic-messages': { path: '/anthropic/v1/messages' },
  'openai-chat': { path: '/v1/chat/completions' },
}

/**
 * 凭据从哪来。**它是一个引用，不是一份值。**
 *
 * 两档就是两种真实的放法：环境变量（`from: 'env'`，值是那个变量的**名字**）与工作区外的一个
 * 文件（`from: 'file'`，值是路径）。两档都不把凭据写进仓库，也都不让它进事件 · 夹具 · 沙箱环境。
 */
export type AuthRef = { readonly from: 'env'; readonly name: string } | { readonly from: 'file'; readonly path: string }

/**
 * 一个提供方：一个 host 加一处凭据的引用。
 *
 * **`host` 是不带路径的那一段**（`https://api.deepseek.com`）：端点由 `WIRES` 与它相乘得到，
 * 于是"同一个 host 上两条路"是一件事，不是两条各写一遍的常量。凭据挂在提供方上：同一个 key
 * 走两条路，这正是"同一模型两个协议可比"那条验证能落地的地方（PLAN § 5.8 的第一处读数）。
 */
export interface ProviderDecl {
  readonly id: string
  readonly host: string
  readonly auth: AuthRef
}

/** 提供方的常量表。**第一条是缺省**（与 `MODEL_DECLS` 同一条口径）。 */
export const PROVIDERS: Readonly<Record<string, ProviderDecl>> = {
  deepseek: {
    id: 'deepseek',
    host: 'https://api.deepseek.com',
    // 名字在这里，值在环境里——`authOf()` 是唯一取值处。
    auth: { from: 'env', name: 'DEEPSEEK_API_KEY' },
  },
}

/**
 * 一个模型的声明。七个字段，每一个都有一条被读的理由：
 *
 * - `id`：我们这边的键，也是命令行 `--model` 收的那一串。
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

/** 两条路上的一份调用配置：轮内固定（架构 § 10.2）。 */
export const DEFAULT_CALL: Readonly<{ temperature?: number; maxTokens?: number }> = { temperature: 0.2 }

/**
 * 模型目录。**今天两条记录，同一个模型的两个线协议。**
 *
 * 两条都留着，是因为"同一模型两个协议可比"是 S8 的第二条验证（架构 § 20）：只声明一条的话，
 * 那条验证在 `B2` 就没法落地（两个适配器里有一个没有声明喂它）。`budget` 两行都由
 * `triggerAt(contextLimit)` 算出来，于是"上限 · 触发点 · 交接余量"三者的关系只有一处。
 */
export const MODEL_DECLS: Readonly<Record<string, ModelDecl>> = {
  'deepseek-chat/anthropic': {
    id: 'deepseek-chat/anthropic' as ModelId,
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
 * 一处凭据的引用合不合法。**只判形状，不判它指得到指不到**——指不到是 `authOf()` 的失败，
 * 那时才有人读得到那句话。
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
 * 取一次凭据。**这一份里唯一读凭据的地方，而它只在真要出网时被调用。**
 *
 * 两档各自指路：环境变量没设时说清楚要设哪一个；文件读不到时说清楚它试过哪个路径。**不返回
 * 空串顶替**——空凭据发出去换来一个 401，那看起来像"模型不行"，而其实是没配。
 */
export function authOf(p: ProviderDecl): string {
  const a = p.auth
  if (a.from === 'env') {
    const v = process.env[a.name]
    if (v === undefined || v === '') {
      throw new ModelDeclError(
        `提供方 ${p.id} 的凭据不在：环境变量 ${a.name} 没有设。` +
          `夹具档与装配一条断言都不需要它——只有真要出网的那一档要（PLAN § 5.8 的口径一）。`,
      )
    }
    return v
  }
  let text: string
  try {
    text = readFileSync(a.path, 'utf8')
  } catch (err) {
    throw new ModelDeclError(
      `提供方 ${p.id} 的凭据不在：读不到 ${a.path}（${(err as NodeJS.ErrnoException).code ?? '未知原因'}）。`,
    )
  }
  const v = text.trim()
  if (v === '') throw new ModelDeclError(`提供方 ${p.id} 的凭据文件是空的：${a.path}`)
  return v
}

/**
 * 载入时那一次核对：**两份表的键域同域**，加上那几条一眼看得出写错的声明。
 *
 * 它封的是"静默失效"那一类：投影漏掉一条记录，命令行那次装配的读数就指着另一个模型，而
 * 没有一处会报错。与 `contract/types.ts` 的 `unownedFields` 载入时当场炸是同一条纪律。
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
  if (!isAuthRef(p.auth)) mismatch.push(`提供方 ${id} 的凭据引用不合形状：${JSON.stringify(p.auth)}`)
}
for (const [name, m] of Object.entries(MODEL_DECLS)) {
  if (!WIRE_NAMES.includes(m.wire)) mismatch.push(`${name} 的线协议没有这一条：${m.wire}`)
  if (PROVIDERS[m.provider] === undefined) mismatch.push(`${name} 指的提供方没有声明：${m.provider}`)
}
if (mismatch.length > 0) {
  throw new Error(`模型声明与它的投影对不上：\n  ${mismatch.join('\n  ')}`)
}
