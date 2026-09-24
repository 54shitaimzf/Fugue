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
// **今天这一份是打桩的。** 真实模型目录属于 S8（选型在架构 § 10.3，接模型在架构 § 20 的 S8），
// 这一站只要求"有一个值能走通装配"，所以下面那一条是**占位名**，`contextLimit` 取的是这一档
// 常见量级。换真模型时改的是这张表的值，`ModelDecl` 的类型与读它的那一处都不动。
import type { ModelId } from './contract.ts'

/**
 * 一个模型的声明。
 *
 * `systemPromptUpdate` 的两行逐字来自架构 § 8.11 那张"模型的声明 → C 怎么增长"的表：
 * `'in-history'` 是"把历史中任意位置最新的 `system` 消息读作有效系统提示词"（于是 C 的变化
 * 可以追加在缓存历史之后），`'rewrite-head'` 是"只读开头那一条"（于是变化只能改写第 0 条，
 * 从该 token 起全部失效）。**取值是两行，落到处理上是三种**——那三种归提供方（§ 10.3），
 * 这一份只回答"这个模型声明了哪一种"。
 *
 * `call` 只要求**轮内固定**（§ 10.2 的必固四条之一）：它没有位置，所以不进前缀。
 */
export interface ModelDecl {
  readonly id: ModelId
  readonly systemPromptUpdate: 'in-history' | 'rewrite-head'
  readonly contextLimit: number
  readonly call: {
    readonly temperature?: number
    readonly maxTokens?: number
  }
}

/** 缺省模型。占位名——真目录在 S8。 */
export const DEFAULT_MODEL: ModelDecl = {
  id: 'fugue-default' as ModelId,
  systemPromptUpdate: 'in-history',
  contextLimit: 200_000,
  call: { temperature: 0.2 },
}

/** 常量表：名字 → 声明。与 `PROTOCOLS` 同一种查法（`fugue assemble --model <id>` 读它）。 */
export const MODELS: Readonly<Record<string, ModelDecl>> = {
  [DEFAULT_MODEL.id]: DEFAULT_MODEL,
}

/**
 * 按名字取一个声明。**查不到就拒，不替它挑一个**——"没写 model"与"写了一个没有的 model"是
 * 两件事：前者走缺省，后者是打错了一个字，静默替他选一个会让命令行那次装配的读数指着另一个
 * 模型。这一条与 `--agent` 拒未知名字是同一条口径（PLAN § 5.6 的 Z4）。
 */
export function modelOf(id: string | undefined): ModelDecl {
  if (id === undefined || id === '') return DEFAULT_MODEL
  const m = MODELS[id]
  if (m === undefined) {
    throw new Error(`没有这个模型：${id}（目录里只有 ${Object.keys(MODELS).join(' · ')}）`)
  }
  return m
}
