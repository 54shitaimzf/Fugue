// 系统状态与项目方针：A 区里那两个「由配置与文件决定」的源。PLAN § 5.6 的 Z5。
//
// **系统状态 = 配置对本工作区的投影**（架构 § 15.3.a · § 8.11 的 A 区表那一行）。它不是配置文件
// 本身，也不是"环境里有什么"：它是**这个工作区拿得到的那些能力**，一份键序稳定的值。所以这一
// 份只做两件事——把配置里那几栏读出来，把键排成稳定的次序。
//
// **项目方针 = `<realRoot>/AGENTS.md` 的字节**（架构 § 9.9）：人编辑的那一份住在真实工作树里、
// 不在视图里，读它的入口在 `sources.ts` 的 `readPolicy`——位置即纪律（模型只有视图内的相对
// 路径）。这一份转发它，是为了让「A 区那两个源」有一个地方一起被读到。
//
// **两段都不认识 agent。** 架构 § 8.11 的验证性质说 A 区跨 N 个 agent 全等，而全等的那一半
// 取决于**源的输出**，不取决于读它的那个 agent。这两段的源没有 agent 这一栏，所以"读它的那个
// agent"无从影响字节——② 那条断言量的就是这件事（给两个不同的坐标，两个段的输出逐字节相同）。
//
// **不进来的两样**：宿主那几条绝对路径（`<realRoot>` · scratch · cache）与环境标识（主机名 ·
// 轮次编号 · 逐 agent 各不相同的产物目录）——架构 § 8.11 的约束 2 与 3 就落在这一份上。它们是
// A 区的第一条禁令：A 区要求 N 个 agent 逐字节相同，任何逐 agent 或逐步变化的值都不行。
import type { ConfigDoc } from '../config.ts'
import { getConfig } from '../config.ts'
import { stableStringify } from './render.ts'
import type { AgentCoord, AssembleState } from './sources.ts'
import { readPolicy } from './sources.ts'

/** 配置里那几栏的键。**只列这个仓库今天真的会读的**——写一个没人读的键进前缀是白付缓存。 */
const EXPOSED: readonly string[] = ['platform', 'workspace', 'config.net', 'ports.range', 'docs']

/**
 * 系统状态：**一份双向稳定的值**。
 *
 * - `entries`：配置对本工作区的投影（点分键 → 值），键按字典序。投影而不是原文：配置里可以
 *   有与这一步无关的东西，而写进前缀的每一个字节都要付一遍缓存。
 * - `platform` · `workspace` · `net`：那三条单独拎出来，因为它们是**能力面**——"这个工作区
 *   拿得到什么"这句话最常问的就是这三样。
 *
 * **没有 `realRoot`。** 它是宿主的坐标，不是工作区的能力：进了这一份就同时踩中约束 2 与 3，
 * 而 A 区的全等当场不成立（负对照量的就是这一条）。
 */
export interface SystemStatus {
  readonly entries: readonly { readonly key: string; readonly value: unknown }[]
  readonly platform: unknown
  readonly workspace: unknown
  readonly net: unknown
}

/**
 * 系统状态那一刻的值：**纯函数**，收（配置 · 那两栏），不碰环境。
 *
 * 它不收 agent，也不收根路径——那是这一份的设计：② 断言要读的那条性质由签名保证，不是由
 * 调用方的自觉保证。
 */
export function projectConfig(config: ConfigDoc): SystemStatus {
  const entries = EXPOSED.filter((k) => k !== 'platform' && k !== 'workspace')
    .map((key) => ({ key, value: getConfig(config, key) }))
    .filter((e) => e.value !== undefined)
  return {
    entries,
    platform: config['platform'],
    workspace: config['workspace'],
    net: getConfig(config, 'config.net'),
  }
}

/** 系统状态那一段的段值：`json` 那一档，键序由 `render.ts` 的稳定序列化定。 */
export function systemSegment(config: ConfigDoc): SystemStatus {
  return projectConfig(config)
}

/**
 * 装一份状态：把这两个源接上 `AssembleState`。
 *
 * 它是命令行与走查的接缝——`sources.ts` 那一层只认值，这里把（配置 · 真实根）变成值。
 */
export function stateWithState(base: AssembleState, config: ConfigDoc, realRoot: string): AssembleState {
  return { ...base, system: systemSegment(config), policy: readPolicy(realRoot) }
}

/**
 * 四个不同的 agent 读同一份配置：**系统状态那一段逐字节相同**。
 *
 * 它不是断言，是一条读数用的入口（`sources-state.test.ts` 的 ②）：给一串坐标，每个坐标拿到的
 * 系统状态是同一个值的序列化。函数本身与坐标无关，因为这一份里没有任何一处收 agent。
 */
export function systemForEachAgent(config: ConfigDoc, agents: readonly AgentCoord[]): string[] {
  return agents.map(() => stableStringify(systemSegment(config)))
}
