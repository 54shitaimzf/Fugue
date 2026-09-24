// 模型这一栏：**表外的那一项**（架构 § 8.11 末段 · § 10.2 的自由项）。PLAN § 5.6 的 Z0。
//
// **它不是段，所以它没有位置。** 模型 · 推理强度 · 上限是**请求的字段**，提供方把它们读成
// 参数而不是文本——这条区别只有一个后果，而它正是这一份存在的理由：**`call` 不进前缀**。
// 于是 `fugue assemble` 会把它印在顶层（`AssembleResult`，见架构 § 9.6 那张表），不把它拼进
// 任何一区；拼进去的话，同一份状态换一个温度就换掉整条前缀，而缓存对此一无所知。
//
// **它是声明值，不是分支。** 架构 § 10.3 的判据：适配器里出现 `if (model === 'x')` 就是漏了
// 一个声明式字段。所以这一份里只有常量表与查表，没有一行按名字分岔的逻辑。
//
// **占位表在这一站撤掉了（S8 的 B0）。** 真的那份住 `src/model/contract.ts`（PLAN § 5.8）：
// 那里有 `provider` · `wire` · `model`（发给谁 · 走哪条线 · 那边叫什么）与凭据的引用。装配
// 这四样一个都不读，所以这一份拿的是它的**投影** `PREFIX_MODELS`——四个字段（名字 · 系统提示词
// 的更新方式 · 上限 · 调用配置），键域与声明表同域，载入时核对。
//
// **一份记录，两个面。** 上面那一段与这一段说的是同一件事：`fugue assemble` 读到的模型与
// `B2` 的适配器读到的模型不是两份数据。改一个模型的上限，改的是 `src/model/contract.ts` 那一行。
import { DEFAULT_MODEL as DECLARED_DEFAULT, MODEL_DECLS, PREFIX_MODELS, modelDeclOf, prefixDeclOf } from '../model/contract.ts'
import type { ModelDecl as ModelDeclaration } from '../model/contract.ts'

/**
 * 一个模型的声明（前缀那一侧的那四个字段）。
 *
 * `systemPromptUpdate` 的两行逐字来自架构 § 8.11 那张"模型的声明 → C 怎么增长"的表：
 * `'in-history'` 是"把历史中任意位置最新的 `system` 消息读作有效系统提示词"（于是 C 的变化
 * 可以追加在缓存历史之后），`'rewrite-head'` 是"只读开头那一条"（于是变化只能改写第 0 条，
 * 从该 token 起全部失效）。**取值是两行，落到处理上是三种**——那三种归提供方（§ 10.3），
 * 这一份只回答"这个模型声明了哪一种"。
 *
 * `call` 只要求**轮内固定**（§ 10.2 的必固四条之一）：它没有位置，所以不进前缀。
 *
 * **它是一条子集关系，不是第二份定义**：`Pick<ModelDecl, …>`——往声明里加一个前缀那一侧要读的
 * 字段，忘了投影就编译不过。
 */
export type ModelDecl = Pick<ModelDeclaration, 'id' | 'systemPromptUpdate' | 'contextLimit' | 'call'>

/** 缺省模型：声明表的第一条（Messages 优先，架构 § 10.3）。 */
export const DEFAULT_MODEL: ModelDecl = prefixDeclOf(DECLARED_DEFAULT)

/** 常量表：名字 → 声明。与 `PROTOCOLS` 同一种查法（`fugue assemble --model <id>` 读它）。 */
export const MODELS: Readonly<Record<string, ModelDecl>> = PREFIX_MODELS

/**
 * 按名字取一个声明。**查不到就拒，不替它挑一个**——"没写 model"与"写了一个没有的 model"是
 * 两件事：前者走缺省，后者是打错了一个字，静默替他选一个会让命令行那次装配的读数指着另一个
 * 模型。这一条与 `--agent` 拒未知名字是同一条口径（PLAN § 5.6 的 Z4）。
 *
 * **它就是 `modelDeclOf`**（`src/model/contract.ts` 那一处），转发一行是为了让 Z0 起的消费者
 * 不必改 import——两份查表逻辑会漂，一份不会。
 */
export function modelOf(id: string | undefined): ModelDecl {
  return prefixDeclOf(modelDeclOf(id))
}

/** 这一份认识的模型名，按声明表的键序。**给探针与走查对账用**，不是第二张表。 */
export const MODEL_IDS: readonly string[] = Object.keys(MODEL_DECLS)
