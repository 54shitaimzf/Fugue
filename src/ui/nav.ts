// TUI 的第二版第八格：**导航**——树（主线为根 · 按父级缩进）+ `Alt-1…9` + `Tab`。
//
// 出处：PLAN § 5.19 第二版「二 · 按键」那张表（`Tab`：补全；没有补全可补时在面板之间循环 · `Alt-1…9`：
// 直接切到第 n 格 agent 或第 n 轮）· 第九节 `T8` 那一行（"树（主线为根、按父级缩进）+ `Alt-1…9` +
// `Tab`；断言：切过去之后面板与 `status --agent <x> --once` 逐字相同"）· 架构 § 9.8。
//
// **"切过去"在这一份里就是一件事：换一个读的 writer。** 主线那一档**不滤**（`writer: null` = 整份账）
// ——处境那一条链住在持轮者那一份日志里（`round/state`），把主线也滤成 `round` 会让"切回主线"看不见
// 轮次；agent 那一档滤成它自己那一个 writer，与 `status --agent <x>` · `watch --agent <x>` ·
// `log --agent <x>` 是同一句口径（"只按 writer 选一份"，架构 § 9.6 那三行）。**于是 `T8` 那句断言
// 查得动**：界面的面板与 `status --agent <x> --once` 读的是同一份折法的同一批行（`status.test.ts` ⑫）。
//
// **树是推出来的，不是存下来的**：节点 = 账上出现过的 writer（主线在前、agent 按名字排），父级是轮次
// （主线），所以只有一级缩进。界面这一头没有第二份"有哪几格"的清单——账一动，树跟着动（§ 5.19 一 · 3）。
import type { StatusRow } from '../probe/status.ts'
import { clip } from './frame.ts'

/** 树上的一个节点。**`writer: null` = 整份账**（主线那一档）。 */
export interface NavNode {
  readonly id: string
  readonly label: string
  /** 缩进级数（主线 0 · agent 1）。 */
  readonly depth: number
  /** 切到它时读哪一份：`null` = 不滤（整份账）。 */
  readonly writer: string | null
}

/** 缩进一级几个空格。 */
export const NAV_INDENT = 2

/**
 * 账上出现过的 writer → 树。**主线（持轮者那一份）在最前**，agent 按名字排；同一个 writer 只出一个。
 *
 * 一份账都没有时是空表（`navRowsOf` 给空表，面板那一栏一个字节都不占）。
 */
export function navNodesOf(rows: readonly StatusRow[]): readonly NavNode[] {
  const seen: string[] = []
  for (const r of rows) {
    const w = r.pos.writer as string
    if (!seen.includes(w)) seen.push(w)
  }
  const lines = seen.filter((w) => !w.startsWith('agent/')).sort()
  const agents = seen.filter((w) => w.startsWith('agent/')).sort()
  return [
    ...lines.map((w) => ({ id: w, label: `主线（${w}）`, depth: 0, writer: null })),
    ...agents.map((w) => ({ id: w, label: w, depth: 1, writer: w })),
  ]
}

/** 第几号节点夹回范围里。 */
export function clampNav(n: number, at: number): number {
  if (n <= 0) return 0
  if (!Number.isInteger(at) || at < 0) return 0
  return at >= n ? n - 1 : at
}

/** 走一个节点（`Tab` 用）：**环形**——最后一个再往下回到第一个，这就是"在面板之间循环"。 */
export function stepNav(n: number, at: number, delta: number): number {
  if (n <= 0) return 0
  return (((clampNav(n, at) + delta) % n) + n) % n
}

/**
 * `Alt-n` 直选（`n` 从 **1** 起）：第 n 格 **agent** 的下标。主线不在里头（它是"切回全部"那一档，
 * 用 `Tab` 循环回去）；没有那么多个就是 `null`——**安静丢掉，不猜**（认不出来的字节也同一条）。
 */
export function altAt(nodes: readonly NavNode[], n: number): number | null {
  const agents = nodes.map((x, i) => [x, i] as const).filter(([x]) => x.depth > 0)
  const hit = agents[n - 1]
  return hit === undefined ? null : hit[1]
}

/** 切到第几号时读哪一份（`null` = 不滤）。没有节点时也是 `null`。 */
export function writerAt(nodes: readonly NavNode[], at: number): string | null {
  return nodes[clampNav(nodes.length, at)]?.writer ?? null
}

/** 树那几行：**一行一个节点**，缩进按 `depth`，选中那个带 `▸`（`frame.ts` 那一层只管整行放上去）。 */
export function navRowsOf(nodes: readonly NavNode[], at: number, columns = 0): readonly string[] {
  const sel = clampNav(nodes.length, at)
  return nodes.map((x, i) => {
    const line = `${' '.repeat(x.depth * NAV_INDENT)}${x.label}`
    const marked = `${i === sel ? '▸' : ' '} ${line}`
    return columns > 0 ? clip(marked, columns) : marked
  })
}
