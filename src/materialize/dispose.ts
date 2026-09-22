// `dispose`：把整份物化删干净。它同时是物化的**退化档**（§ 3 那张表的第一行：增量 → 全量）。
//
// 出处：架构 § 8.5 的失败处理（"物化目录损坏 → 删除重建。它是派生且可弃的，**不尝试修复**"）·
// § 8.4 的四个坐标 · § 9.6 的物化行 · PLAN § 5.2 的 V5 行。
//
// 三条，各自的出处：
//
// 一 · **先卸后删。** 挂着的时候删挂载点，删的其实是底下那棵树——overlay 把底摊在挂载点上，
//      于是"删掉派生物"那一步会变成"删掉真源"。§ 8.5 那句"删除重建"只对**没挂着**的物化目录
//      成立，所以这个次序由 `mount.ts` 的 `clearMaterialization` 管，不由调用点各自记着。
// 二 · **四个坐标一起删**（`upper` · `merged` · `tmp` · `cache`，§ 8.4）。不留半个：留着的那半个
//      会被下一次 `fork` 当成"已经铺好的"，而它其实不知道是什么时候的。`work` 那个内核草稿本
//      在 `tmp` 底下，跟着一起走。
// 三 · **不写日志。** § 8.1 的事件表里没有 `mat/dispose`——加它属于改规格（由人批）。于是重放
//      读不出"物化已经被丢掉"这件事。清单是派生的，它的失效由下一次 `fork` 清空：`mat/fork`
//      一到，清单从头起（`manifest.ts` 的重放就是这么读的）。这条记在疑点里。
//
// **幂等**：什么都没有也照样成功——后置条件是"这些坐标下不留东西"，它已经成立了。所以
// `dispose` 既不需要日志，也不需要"先 fork 过"这个前提：它是删除，不是一次状态迁移。
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Roots } from '../roots/contract.ts'
import type { AbsPath, AgentId } from '../terms.ts'
import { clearMaterialization } from './mount.ts'

export interface DisposeDeps {
  readonly roots: Roots
}

export interface DisposeResult {
  readonly agent: AgentId
  /** 这个 agent 的物化根：`<realRoot>/.fugue/mat/<agent>/`（四个坐标住在它底下）。 */
  readonly mat: AbsPath
  readonly upper: AbsPath
  readonly merged: AbsPath
  readonly temp: AbsPath
  readonly cache: AbsPath
  /** 删之前有没有东西。**没有也算成功**（幂等）。 */
  readonly existed: boolean
  /** 删掉之后还剩下什么（正常是空的；不为空说明有东西删不动）。 */
  readonly left: readonly AbsPath[]
  readonly ms: number
}

export async function dispose(deps: DisposeDeps, agent: AgentId): Promise<DisposeResult> {
  const started = performance.now()
  const { roots } = deps
  const upper = roots.scratchRoot(agent)
  const merged = roots.mergedRoot(agent)
  const temp = roots.tempRoot(agent)
  const cache = roots.cacheRoot(agent)
  // **容器自己也删**：`mat/<agent>/` 空了就该跟着走。留一个空目录，下一次读到的人会以为这儿
  // 还有一份物化——而"不留东西"是这条命令的后置条件。
  const mat = dirname(upper)
  const parts = [upper, merged, temp, cache, mat]
  const existed = parts.some((p) => existsSync(p))
  // 先卸后删是硬顺序（`clearMaterialization` 里那一段说了为什么）。
  clearMaterialization(merged, parts)
  return {
    agent,
    mat,
    upper,
    merged,
    temp,
    cache,
    existed,
    left: parts.filter((p) => existsSync(p)),
    ms: Math.round(performance.now() - started),
  }
}
