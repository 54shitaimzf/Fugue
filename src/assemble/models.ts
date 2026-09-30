// 模型这一栏：**表外的那一项**（架构 § 8.11 末段 · § 10.2 的自由项）。PLAN § 5.6 的 Z0。
//
// **它不是段，所以它没有位置。** 模型 · 推理强度 · 上限是**请求的字段**，提供方把它们读成
// 参数而不是文本——这条区别只有一个后果，而它正是这一份存在的理由：**`call` 不进前缀**。
// 于是 `fugue assemble` 会把它印在顶层（`AssembleResult`，见架构 § 9.6 那张表），不把它拼进
// 任何一区；拼进去的话，同一份状态换一个温度就换掉整条前缀，而缓存对此一无所知。
//
// **它是声明值，不是分支。** 架构 § 10.3 的判据：适配器里出现 `if (model === 'x')` 就是漏了
// 一个声明式字段。所以这一份里只有查表转发，没有一行按名字分岔的逻辑。
//
// **常量出口随 P2d 撤了**（`DEFAULT_MODEL` · `MODELS` · `MODEL_IDS`）：目录成了数据
// （`catalog.ts` 的 `readCatalog`），派生常量没有"哪一份目录"这个答案就立不住——留着就会
// 有人拿到内置档那份而另一头在跑文件档。留下的转发只有 `modelOf(id, cat)`：Z0 起的消费者
// 不必改 import 的那一半照旧成立，另一半（目录从参数来）跟着查表走。
import { prefixDeclOf } from '../model/contract.ts'
import type { ModelDecl as ModelDeclaration } from '../model/contract.ts'
import { modelDeclOf } from '../model/catalog.ts'
import type { Catalog } from '../model/catalog.ts'

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

/**
 * 按名字取一个声明。**查不到就拒，不替它挑一个**——"没写 model"与"写了一个没有的 model"是
 * 两件事：前者走缺省，后者是打错了一个字，静默替他选一个会让命令行那次装配的读数指着另一个
 * 模型。这一条与 `--agent` 拒未知名字是同一条口径（PLAN § 5.6 的 Z4）。
 *
 * **它就是 `modelDeclOf`**（`src/model/catalog.ts` 那一处），转发一行是为了让 Z0 起的消费者
 * 不必改 import——两份查表逻辑会漂，一份不会。
 */
export function modelOf(id: string | undefined, cat: Catalog): ModelDecl {
  return prefixDeclOf(modelDeclOf(id, cat))
}
