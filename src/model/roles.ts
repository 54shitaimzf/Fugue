// 角色那一层（角色层站·路线图多模型面那行）：持轮者 · 裁断 · 子格各配各的模型，一台机器多模型同时在场；
// 配错或供不上有**回退档**（缺省链写明：空——不换模型；链由人写明，回退那一跳由调用点落账）。
//
// **解析口径一处**：`--model` 旗标 > `round.models.<role>` 角色键 > `round.model` > 目录第一条。
// 旗标最高是「一次性的那一趟」的语义：`--model X` 就是把三个角色都换到 X，常驻的角色配置拦不住
// 它；旗标不在，角色键才说了算。角色键住在 `round.models` 那一层（**与 `round.model` 平级、不嵌
// 在它底下**——`round.model` 是一个字符串，往它底下再放键是两种形状打架）。角色键给了却不是非空
// 字符串，是打错了一个字——照 `round.model` 那条纪律当场拒（`shared.ts` 的 `selectedModelId`
// 同一口径），不静默读成"没配"。
//
// **回退链是全局一份**（`round.fallback`，按次序）：三个角色共用同一条链。查表与拒未知走
// `modelDeclOf` 那一处；**主脸自己与重复的名字按角色跳过**（重试同一张脸属于传输那一层的事，
// P2f 的重试档；一张脸在这一格里至多试一次）——`cell=A, ruler=B, fallback=[B]` 时子格的链是
// A→B、裁断的链是 B 单独一张：全局链里有一张是这一角色的主脸，不拦整轮开跑。
//
// **脸是惰性的**：`faceOf` 只带声明；目标（host · 凭据 · 线协议的头）在**真要用这张脸**那一刻
// 才拼（`targetAt` · `authWith` 都在那一跑）——回退脸的提供方没配凭据，不该在开跑之前就把整轮
// 拦下来，那一档的正经出路是「这一跳落账，换下一张」。主脸照旧由调用方 eagerly 拼好（与从前
// 逐字节相同的那一条路）。
import type { ConfigDoc } from '../config.ts'
import { getConfig } from '../config.ts'
import { UsageError } from '../value/types.ts'
import type { AuthRef, ModelDecl } from './contract.ts'
import { authWith } from './contract.ts'
import type { Catalog } from './catalog.ts'
import { modelDeclOf } from './catalog.ts'
import type { Target } from './http.ts'
import { targetAt } from './http.ts'
import type { AgentHandle } from '../runtime/step.ts'

/** 三个角色：持轮者（round plan/talk 那几趟）· 裁断（轮内收下问题那一次）· 子格（契约那一格）。 */
export type RoleName = 'holder' | 'ruler' | 'cell'

export const ROLE_NAMES: readonly RoleName[] = ['holder', 'ruler', 'cell']

/**
 * 一个角色的那一串脸：第一张是主脸，后面是回退链（**空链是正当配置**——不换模型）。
 *
 * `base` 是旗标那一档解析完的缺省（`--model` > `round.model` > `undefined`），`flag` 是
 * `--model` 自己——**旗标盖过角色键**：`--model X` 仍然是"三个角色都换到 X"，常驻的角色配置
 * 拦不住一次性的那一趟；旗标不在，`round.models.<role>` 只换它那一个角色。
 */
export function roleChainOf(doc: ConfigDoc, cat: Catalog, role: RoleName, base: string | undefined, flag?: string): readonly ModelDecl[] {
  const key = `round.models.${role}`
  const own = getConfig(doc, key)
  if (own !== undefined && (typeof own !== 'string' || own === '')) {
    throw new UsageError(`${key} 要是一个模型名字（目录里有的那几个），拿到的是 ${JSON.stringify(own)}`)
  }
  const primary = modelDeclOf(flag ?? own ?? base, cat)
  const raw = getConfig(doc, 'round.fallback')
  if (raw === undefined) return [primary]
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string' || x === '')) {
    throw new UsageError(`round.fallback 要是一份模型名字的表（按次序回退），拿到的是 ${JSON.stringify(raw)}`)
  }
  // 主脸自己与重复的名字跳过（不是拒）：一张脸在这一格里至多试一次，全局链是三个角色共用的，
  // 拒会把别的角色的正当组合拦死。
  const seen = new Set([primary.id])
  const rest: ModelDecl[] = []
  for (const id of raw as readonly string[]) {
    const d = modelDeclOf(id, cat)
    if (seen.has(d.id)) continue
    seen.add(d.id)
    rest.push(d)
  }
  return [primary, ...rest]
}

/** 一张脸：声明 + **惰性的**目标（真要用这张脸才取凭据、才拼 host 与头；拼一次缓存住）。 */
export interface ModelFace {
  readonly decl: ModelDecl
  /** 抛 = 这张脸用不了（凭据没配那一类）——那一档的正经出路是落一跳账、换下一张。 */
  target(): Target
}

/**
 * 声明 → 一张脸。
 *
 * `credential` 给了就**用它**（主脸那一档：调用方已经按 `--credential` / 回放档的口径拼好，
 * 与从前那条路逐字节相同）；不给才在第一次 `target()` 时按配置的引用表取（回退脸那一档）。
 */
export function faceOf(decl: ModelDecl, cat: Catalog, give: { readonly doc: ConfigDoc; readonly credential?: string }): ModelFace {
  let cached: Target | null = null
  return {
    decl,
    target(): Target {
      if (cached === null) {
        const cred =
          give.credential ??
          authWith(decl.provider, getConfig(give.doc, `credentials.${decl.provider}`) as readonly AuthRef[] | undefined, null)
        cached = targetAt(decl.id, cred, cat)
      }
      return cached
    },
  }
}

/**
 * **换一张脸**（角色层站的回退那一跳）：句柄上属于**模型**的那几栏照新声明换——我们这边的键 ·
 * 提供方的名字 · 目标 · 线协议 · 调用配置。**角色那一栏不动**：`protocol` 是"这一格是谁"
 * （持轮者 · 子格——工具派发与段序都读它），换模型不换角色；`state` 与坐标也不动（换脸不改
 * 这一格走到哪儿了），预算那一侧的声明由调用点跟着换（`planBudget` 读的是它）。
 *
 * 子格循环（`driver.ts`）与持轮者循环（`plan.ts`）换的是同一个函数——它住这一层（脸的事），
 * 不住驱动那个大模块：持轮者为换脸依赖整个驱动，方向不对。
 */
export function faceHandle(h: AgentHandle, f: ModelFace): AgentHandle {
  return {
    ...h,
    model: f.decl.id,
    wireModel: f.decl.model,
    target: f.target(),
    adapter: { name: f.decl.wire },
    call: f.decl.call,
  }
}

