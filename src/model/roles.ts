// 角色那一层（路线图 0.5.3）：持轮者 · 裁断 · 子格各配各的模型，一台机器多模型同时在场；
// 配错或供不上有**回退档**（缺省链写明：空——不换模型；链由人写明，回退那一跳由调用点落账）。
//
// **解析口径一处**：`round.models.<role>` > `round.model`（或旗标解析完递进来的那一档）> 目录第一条。
// 角色键住在 `round.models` 那一层（**与 `round.model` 平级、不嵌在它底下**——`round.model` 是
// 一个字符串，往它底下再放键是两种形状打架）。角色键给了却不是非空字符串，是打错了一个字
// ——照 `round.model` 那条纪律当场拒（`shared.ts` 的 `selectedModelId` 同一口径），不静默读成"没配"。
//
// **回退链是全局一份**（`round.fallback`，按次序）：三个角色共用同一条链。查表与拒未知走
// `modelDeclOf` 那一处；主脸自己与重复的名字当场拒——重试同一张脸属于传输那一层的事（P2f 的
// 重试档），换脸换到同一张没有意义。
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

/** 三个角色：持轮者（round plan/talk 那几趟）· 裁断（轮内收下问题那一次）· 子格（契约那一格）。 */
export type RoleName = 'holder' | 'ruler' | 'cell'

export const ROLE_NAMES: readonly RoleName[] = ['holder', 'ruler', 'cell']

/**
 * 一个角色的那一串脸：第一张是主脸，后面是回退链（**空链是正当配置**——不换模型）。
 *
 * `base` 是旗标那一档解析完的缺省（`--model` > `round.model` > `undefined`）：角色键盖过它，
 * 角色键不在才轮到它。于是 `--model X` 仍然是"三个角色都换到 X"，而 `round.models.holder Y`
 * 只换持轮者——旗标语义一个字节没变。
 */
export function roleChainOf(doc: ConfigDoc, cat: Catalog, role: RoleName, base: string | undefined): readonly ModelDecl[] {
  const key = `round.models.${role}`
  const own = getConfig(doc, key)
  if (own !== undefined && (typeof own !== 'string' || own === '')) {
    throw new UsageError(`${key} 要是一个模型名字（目录里有的那几个），拿到的是 ${JSON.stringify(own)}`)
  }
  const primary = modelDeclOf(own ?? base, cat)
  const raw = getConfig(doc, 'round.fallback')
  if (raw === undefined) return [primary]
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string' || x === '')) {
    throw new UsageError(`round.fallback 要是一份模型名字的表（按次序回退），拿到的是 ${JSON.stringify(raw)}`)
  }
  const seen = new Set([primary.id])
  const rest = (raw as readonly string[]).map((id) => {
    const d = modelDeclOf(id, cat)
    if (seen.has(d.id)) {
      throw new UsageError(
        `round.fallback 里的 ${id} 是重复的（或就是主脸自己）——重试同一张脸属于传输那一层的重试档，` +
          '换脸换到同一张没有意义；要去掉哪一张，把表里那一条删掉',
      )
    }
    seen.add(d.id)
    return d
  })
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

