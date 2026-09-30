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
import { actionNames, readBinding } from '../boundary/binding.ts'
import { projectToolchain } from '../materialize/toolchain.ts'
import type { ToolchainLine } from '../materialize/toolchain.ts'
import { stableStringify } from './render.ts'
import type { AgentCoord, AssembleState } from './sources.ts'
import { readPolicy } from './sources.ts'

/**
 * 动作那一行（`actions` 栏的一行，P3b2 拍平）：绑定里模型要看到的那几个字。
 *
 * **`env` 的值不投影**（负对照在 sources-state.test ⑤ 钉着）：环境变量是给人配的（凭据走
 * 引用、值不进任何模型面），进了这一栏就同时进夹具与日志。
 */
export interface ActionLine {
  readonly name: string
  readonly argv: readonly string[]
  /** 给模型看的一句话（绑定的 `doc`，可缺）。 */
  readonly doc?: string
  /** 声明要回写视图的产出（空就不出现那一栏）。 */
  readonly outputs?: readonly string[]
}

/**
 * 系统状态：**一份双向稳定的值**（P3b2 拍平：一栏能力一列，`entries` 信封与 `net` 双投删掉）。
 *
 * 每一栏**不在配置里就不投影**（不是投影成 `undefined`）：`json` 渲染器序列化不了 undefined，
 * 而"这个工作区没配它"是常态，不是异常——一份空配置投影成 `{}`，照样装得出 A 区。
 *
 * **两串清单按 name 排序**：`stableStringify` 只排对象的键，数组的次序原样过——逐字节稳定
 * 得靠排序自己给。
 *
 * **没有 `realRoot`。** 它是宿主的坐标，不是工作区的能力：进了这一份就同时踩中约束 2 与 3，
 * 而 A 区的全等当场不成立（负对照量的就是这一条）。
 */
export interface SystemStatus {
  readonly platform?: unknown
  readonly workspace?: unknown
  readonly net?: unknown
  readonly ports?: unknown
  readonly docs?: unknown
  readonly actions?: readonly ActionLine[]
  readonly toolchain?: readonly ToolchainLine[]
}

/**
 * 系统状态那一刻的值：**纯函数**，收配置，不碰环境。
 *
 * 它不收 agent，也不收根路径——那是这一份的设计：② 断言要读的那条性质由签名保证，不是由
 * 调用方的自觉保证。投影而不是原文：配置里可以有与这一步无关的东西，而写进前缀的每一个
 * 字节都要付一遍缓存——所以只投影有人消费的那几栏。
 */
export function projectConfig(config: ConfigDoc): SystemStatus {
  const out: {
    platform?: unknown
    workspace?: unknown
    net?: unknown
    ports?: unknown
    docs?: unknown
    actions?: readonly ActionLine[]
    toolchain?: readonly ToolchainLine[]
  } = {}
  if (config['platform'] !== undefined) out.platform = config['platform']
  if (config['workspace'] !== undefined) out.workspace = config['workspace']
  const net = getConfig(config, 'config.net')
  if (net !== undefined) out.net = net
  const ports = getConfig(config, 'ports.range')
  if (ports !== undefined) out.ports = ports
  const docs = getConfig(config, 'docs')
  if (docs !== undefined) out.docs = docs
  // 动作清单：`readBinding` 一处解析（跑它的人与投影同一份），名字排序。
  const names = actionNames(config)
  if (names.length > 0) {
    out.actions = names.map((name) => {
      const b = readBinding(config, name)
      return {
        name,
        argv: b.argv,
        ...(b.doc === undefined ? {} : { doc: b.doc }),
        ...(b.outputs.length === 0 ? {} : { outputs: [...b.outputs] }),
      }
    })
  }
  // 工具链：声明照抄、读数只在出自当前 probe 时带上（toolchain.ts 的 projectToolchain）。
  const toolchain = projectToolchain(config)
  if (toolchain !== undefined) out.toolchain = toolchain
  return out
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
