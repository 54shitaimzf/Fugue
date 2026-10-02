// M8 的能力表。出处：架构 § 8.9——那张「落在哪层状态 → 工具」的表与紧随其后的四条推论；
// 工具名的唯一出处是架构 § 8.10 那张目录，PLAN § 5.6 的 Z2。
//
// **它是那张推论表的机器可读副本。** § 8.9 说「全部行为分叉的集中处」：先物化 · 过路径围栏 ·
// 关进 OS 沙箱 · 可回写视图——四条推论各有各的消费方（`M4` 的 `ensure` · `M3` 的
// `Roots.resolveVirtual` · `M7.confine()` · `M6` 反向通道）。四条都由层推出来，所以那张表里的
// 层不是标签，是四个开关：这里只写层，四个开关由 `inferences()` 一处算出来，消费方读推论、不读层。
// 这一份之前一个格都没有，于是「执行类先物化」这类话在每个调用点各写一遍。
//
// **这张表以工具名为键，因此任何一格漏了，行为都会静默地少一条推论。** 架构 § 8.9 的原话是
// 「少了这一层都编译不过」：工具名只有 § 8.10 的工具目录一处定义，少一格就是编译期错误。这个
// 仓库直跑 `.ts`（strip-only · 不做类型检查），所以那句话的机器可读形态是**一张在测试里跑的网**
// （`tools/check-invariants.ts` 第一节 · `checkInvariant` 就是它读的那条判据），不是载入时的
// throw：原先那一句比的是**本文件里那份名字字面量**——自证，抓不住漂移（清障批 ②），而那份字面量
// 也在 清障批 ⑤ 撤了：名字只有 `src/tools/catalog.ts` 的 `TOOL_ENTRIES` 一处，这一份读它。
//
// **判定只读这一处。** `M3` 的路径投影器那一支回答「那把钥匙怎么在路径空间里落定」，这一支回答
// 「这个工具落在哪层状态」。两者不要合：合了以后，加一个工具就要同时动路径空间。

/** 一层状态：架构 § 8.9 那五行，逐字。 */
export type Layer = 'view' | 'execute' | 'truth' | 'log'

/**
 * 那十二个工具的名字：**定义处不在这里**，在 `src/tools/catalog.ts` 的 `TOOL_ENTRIES`（架构
 * § 8.10 那本目录：名字 · 描述 · `parameters`）。这一份以那套名字为键，所以它读那一处，
 * **不另立一份**——转发一行是为了让 Z2 的消费者（测试 · 变异脚本）不必改 import。
 *
 * **顺序不承重**：这一份的核对比的是集合（`checkInvariant` 读的就是它）；后缀的字节序归
 * § 8.10 硬纪律 2（跨状态逐字节稳定），不归"哪一处跟哪一处同序"。
 *
 * **这里原先有一份逐字的名字字面量**（清障批 ⑤ 撤了）：两份名字表不一致时前缀字节只是不同，
 * 没有别的报错，而漂移不报错——所以名字只有一处。
 */
export { TOOL_NAMES } from '../tools/catalog.ts'
import { TOOL_NAMES } from '../tools/catalog.ts'

/**
 * 能力标识。**一格一个名字**，与工具名同域。
 *
 * 它为什么不是「一层一个」而是一格一个：层只决定四条推论，而能力标识是**后面那些策略要指的
 * 那个东西**——`M7` 的动作声明集按它索引，「哪几个工具共用一条策略」这句话要写得出来。层可以
 * 合并，身份不能：合并了两个身份，就再也分不开它们。
 */
export type CapabilityId = string

/** 四条推论的名字，架构 § 8.9 那张表逐字。 */
export type InferenceId = 'materialize' | 'fence' | 'confine' | 'writeBack'

const INFERENCE_IDS: readonly InferenceId[] = ['materialize', 'fence', 'confine', 'writeBack']

/** 表里的一行：层 · 身份 · 有没有声明集。四条推论由这三样算出来，不写第二遍。 */
export interface CapabilityRow {
  readonly layer: Layer
  readonly capability: CapabilityId
  /** 声明的产出集（架构 § 8.6 的声明集）。只有执行层能有——那是「可回写视图」的前提。 */
  readonly decl: boolean
}

/**
 * 查出这个工具落在哪层状态之后的答案。
 *
 * **它是推论，所以四个开关都是布尔。** 调用点要问的是「我要不要先物化」，不是「它在哪一层」
 * ——把层交给调用点，等于让每个调用点各判一遍，那正是 § 8.9 要集中的那个分叉。
 */
export interface Capability {
  readonly tool: string
  readonly layer: Layer
  readonly capability: CapabilityId
  readonly materialize: boolean
  readonly fence: boolean
  readonly confine: boolean
  readonly writeBack: boolean
}

/**
 * 拒。**与 `M3` 的 `Denied` 同一条纪律**（架构 § 8.4 纪律 2）：拒的话里带着那个名字，并且指得出
 * 名字从哪来——模型打错一个字与能力表漏一格，是两件事，报出来的话不该是同一种。
 */
export interface Denied {
  readonly denied: true
  /** 被拒的那一串原文。 */
  readonly tool: string
  /** 给人看的整句，含名字与出处。 */
  readonly message: string
}

/** 查表的结果：要么是推论，要么是拒。 */
export type Lookup = Capability | Denied

/**
 * 那张表。**以工具名为键，一格一行。**
 *
 * 层从架构 § 8.9 那张表逐行读下来；`decl` 只有一格为真，就是 § 8.9 唯一单独说的那句：执行类里
 * `run_action` 经声明集把产出的字节写回视图，`bash` 不能。
 */
const LAYER_TABLE: Readonly<Record<Layer, readonly string[]>> = {
  view: ['read', 'write', 'edit', 'read_image', 'glob', 'grep'],
  execute: ['bash', 'run_action'],
  truth: ['checkpoint'],
  log: ['todo_write', 'ask_user_question', 'exit_plan_mode'],
}

/** 有声明集的那几个（架构 § 8.9 那一句 · § 8.6 的声明集）。 */
const WITH_DECL: readonly string[] = ['run_action']

/**
 * 能力表：工具名 → 层 · 身份 · 声明集。**它就是架构 § 8.9 那张表本身。**
 *
 * 它从 `LAYER_TABLE` 长出来而不是手写十二行：手写一份的话，「哪个工具落在哪一层」就有两处可改，
 * 而两处不一致只会表现成某个调用点少了一条推论——没有报错。这样只有一处。
 */
export const CAPABILITY_TABLE: Readonly<Record<string, CapabilityRow>> = Object.fromEntries(
  Object.entries(LAYER_TABLE).flatMap(([layer, tools]) =>
    tools.map((tool) => [tool, { layer: layer as Layer, capability: tool, decl: WITH_DECL.includes(tool) }]),
  ),
)

/**
 * 四条推论：层 → 四个开关。
 *
 * 前三条由层定（架构 § 8.9 的「成立条件」那一列），第四条由声明集再收一道：落在执行层**且**
 * 声明了产出集，才谈得上回写。收这一道不是装饰——`bash` 也在执行层，而它没有回写通道
 * （§ 8.7 · D7：反向通道限声明集，否则子进程的隐性改动会进视图，冲突来源不可枚举）。
 */
export function inferences(layer: Layer, decl: boolean): Omit<Capability, 'tool' | 'layer' | 'capability'> {
  return {
    materialize: layer === 'execute',
    fence: layer === 'view' || layer === 'execute',
    confine: layer === 'execute',
    writeBack: layer === 'execute' && decl,
  }
}

function sentence(tool: string, row: CapabilityRow): Capability {
  return { tool, layer: row.layer, capability: row.capability, ...inferences(row.layer, row.decl) }
}

/**
 * 查一个工具：给推论，或者给拒。**未声明即拒**（架构 § 8.9：「这张表是全函数」）。
 *
 * 收的是一串原样输入而不是类型化的名字：名字是从模型那一侧来的，那一刻它还是一串字符串。
 * 签名收那个联合类型的话，未声明的那条路就只能由调用方去拒——那正是「未声明即拒」这句话要
 * 收上来的东西。
 */
export function lookup(tool: string): Lookup {
  const row = CAPABILITY_TABLE[tool]
  if (row === undefined) {
    return {
      denied: true,
      tool,
      message: `能力表里没有这个工具：${tool}——工具名的唯一出处是架构 § 8.10 那张目录（${TOOL_NAMES.length} 个），能力表以它为键。`,
    }
  }
  return sentence(tool, row)
}

/** 某一层上的那几个工具名，给「要一份名单」的地方用。 */
export function namesOn(layer: Layer): string[] {
  return Object.entries(CAPABILITY_TABLE)
    .filter(([, row]) => row.layer === layer)
    .map(([tool]) => tool)
}

/**
 * 载入时的核对：**这份表对得起那份名字表**（架构 § 8.9：任一格少了都「编译不过」）。
 *
 * `names` 是参数而不是直接把 `TOOL_NAMES` 读进来：这条核对要能被指着一份截短的名字表跑（测试
 * 里那一条），否则「少一格会炸」这句话就没有一处量得到它。
 */
export function checkInvariant(table: Readonly<Record<string, CapabilityRow>>, names: readonly string[]): string[] {
  const missing = names.filter((n) => table[n] === undefined)
  const extra = Object.keys(table).filter((t) => !names.includes(t))
  return [
    ...missing.map((n) => `目录里有这个工具，表里没有它：${n}`),
    ...extra.map((t) => `表里有这个工具，目录里没有它：${t}`),
    ...Object.entries(table)
      .filter(([, row]) => row.decl && row.layer !== 'execute')
      .map(([t]) => `只有执行层能有声明集，而这一格不在执行层：${t}`),
  ]
}

// **载入时那道核对搬走了**（清障批 ②）：这一份与工具目录是**两份各自独立声明的名字域**，判它们
// 是不是同一份的地方在 `tools/check-invariants.ts` 第一节，挂在 `test/check-invariants.test.ts`
// （fast 组）。`checkInvariant` 留着——判据本身没变，变的是谁在什么时候读它。

/** 四条推论的名字与各自那一句话，给读表的人与走查用（架构 § 8.9 那张表逐字）。 */
export const INFERENCES: Readonly<Record<InferenceId, string>> = {
  materialize: '先物化——落在执行层：M4 的 ensure(rev)',
  fence: '过路径围栏——落在视图层或执行层：M3 的 Roots.resolveVirtual',
  confine: '关进 OS 沙箱——落在执行层：M7.confine() 包装出 ConfinedArgv 再交 M5',
  writeBack: '可回写视图——落在执行层，且该能力声明了声明集：M6 反向通道',
}

/** 四条推论，按那张表的顺序。 */
export const INFERENCE_LIST: readonly InferenceId[] = INFERENCE_IDS
