// 坐标布局（U2，2026-09 评审计划）：自 `boundary/confine.ts` 下沉——`XDG_DIR` 与
// `cacheLayoutOf` 是**纯布局计算**（不探针、不 bwrap），内核的回收（`execute/reclaim.ts`）
// 与边界的挂载两侧都要读它。原先住在 boundary，让内核上仰边界（架构 § 5 的方向反了）；
// 坐标本就是 M3 roots（虚拟↔物理映射）的辖区，下沉之后内核→内核、边界→内核，各归各的方向。
import { join } from 'node:path'
import type { Roots } from './contract.ts'
import type { AbsPath, AgentId, RelPath } from '../terms.ts'

/**
 * 本 agent 缓存目录（`cacheRoot(a)`）里的三块。**一处定义**：`confine` 的绑定源、命令面要建
 * 的目录、以及断言里读产物落在哪儿，读的都是它。
 */
/** `XDG_CACHE_HOME` 在缓存里的那一层目录名：**一处拼**，缓存侧与子进程侧都从它来。 */
export const XDG_DIR = 'xdg-cache'

export interface CacheLayout {
  /** 子进程的家与缓存（沙箱档挂 `/cache`）：本 agent 的缓存目录。 */
  readonly home: AbsPath
  /** 子进程的 `XDG_CACHE_HOME`（沙箱档是 `/cache/xdg-cache`）。 */
  readonly xdgCache: AbsPath
  /** 一个声明目录的绑定源：`<cacheRoot(a)>/<rel>`（架构 § 8.6 第 2 步那一条逐字）。 */
  readonly bound: (rel: RelPath) => AbsPath
}

export function cacheLayoutOf(roots: Roots, a: AgentId): CacheLayout {
  const cache = roots.cacheRoot(a)
  return { home: cache, xdgCache: join(cache, XDG_DIR), bound: (rel: RelPath) => join(cache, rel) }
}
