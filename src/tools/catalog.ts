// M9 的工具目录。出处：架构 § 8.10——那张 `Tool` 的形状与两条硬纪律；PLAN § 5.6 的 Z3。
//
// **零策略：只有名字 · 描述 · `parameters`。** 这一份回答「模型看见哪些工具、每个工具收什么
// 参数」，不回答「这个工具落到哪一层状态」（那是能力表，`src/capability/table.ts`）、也不回答
// 「它怎么兑现」（那是 `M8` 与 `M7`）。架构 § 8.10 的实现纪律：工具内不含策略，策略在能力层。
//
// **跨状态逐字节稳定是这一份的第一性质**（架构 § 8.10 硬纪律 2 · § 8.11 的验证性质）：工具
// schema 属于前缀，schema 随状态变化即前缀字节变化。所以 `catalog()` 收一个状态、吐同一份目录
// ——**这一份里没有一处读它**。`exit_plan_mode` 在计划模式未激活时仍留在目录里，正是这件事的
// 那个例子：目录不以「这一步有没有用」为条件。计划模式开与关都不改一个字节，所以第三条状态
// （有一条待办）也一样——`todo_write` 的 schema 说的是"怎么写待办"，不是"现在有几条"。
//
// **只公布能兑现的选项**（硬纪律 1）：每一条的 `parameters` 只列这个仓库今天真的会读的键。
// 加一个字段要先有读它的那一处——否则模型按 schema 给了一个参数，而没有人接，那比不公布更坏。

import { createHash } from 'node:crypto'
import { stableStringify } from '../assemble/render.ts'

// 工具的 `parameters`：JSON Schema 的一个子集。**只写用得到的几个关键字**，不自造方言：
// 这个仓库里没有任何一处校验它（校验是提供方的事），它是一份声明——形状越窄，越不容易
// 与提供方的实现漂移。
export type JSONSchema = Readonly<Record<string, unknown>>

/**
 * 一个工具条目。架构 § 8.10 那张 `Tool` 的前三个字段——**`execute` 不在这一份里**。
 *
 * 那不是一个省略：`execute` 是 `M8` 与 `M7` 的调用点（S7 · S8 的接线），而目录的哈希必须与
 * 它无关——前缀里进的是这份声明，不是那个函数。把它放进来，这一份就不再是数据了。
 */
export interface ToolEntry {
  readonly name: string
  readonly description: string
  readonly parameters: JSONSchema
}

/** 一小段公共片段：路径一律是视图内的相对路径（架构 § 1.5 结论 3）。 */
const PATH = { type: 'string', description: '视图内的相对路径' } as const

/**
 * 那十五个工具，逐个写它的参数面。**顺序不承重**：承重的是名字的域——能力表（§ 8.9）以这套
 * 名字为键，那一份载入时的核对比的就是集合（`checkInvariant`）。仓库里这份列的顺序、能力表
 * 那份的顺序、§ 8.10 那张表按类别分行的顺序，三处都不同；而进字节流的是这一列扁平条目的先
 * 后，所以它只被 § 8.10 硬纪律 2 管（跨状态逐字节稳定），不被"哪一处跟哪一处同序"管。
 *
 * **描述的写法**：一句话说清「这个工具做什么 · 参数是什么意思」。纪律那类的话（先物化 · 过
 * 围栏）不写在这里——模型读的是能力，不是我们的实现。
 */
export const TOOL_ENTRIES: readonly ToolEntry[] = [
  {
    name: 'write',
    description: '把一个文件的全部内容写成给定文本：新建，或整篇替换。每一次都写全文，所以改文件中间的一小处应当用 edit，不要重抄一遍（那会把别处的改动抹掉）。写完这一步的文件就在视图里，后续的读与跑都看得见。',
    parameters: {
      type: 'object',
      properties: { path: PATH, content: { type: 'string', description: '要写进去的文本' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit',
    description: '在一处精确替换一个文件里的字符串：old_string 要带上足够的上下文，好让它在文件里只出现一次。不唯一时它先报出来，不猜是哪一处——那时把 old_string 写长一点，或者给 replace_all。整篇换掉用 write。',
    parameters: {
      type: 'object',
      properties: {
        path: PATH,
        old_string: { type: 'string', description: '要被替换掉的那一段原文' },
        new_string: { type: 'string', description: '换成的那一段' },
        replace_all: { type: 'boolean', description: '把每一处都换掉（缺省只换一处）' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_image',
    description: '读一张图片，返回图片本身。read 只认文本文件，图片要走这一个。',
    parameters: {
      type: 'object',
      properties: { path: PATH },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'bash',
    description: '执行一条命令，拿到它的退出码与输出。**工作区是只读的**：这条命令改不了任何文件，要产出文件用 write 或跑一个动作（run_action）。适合验证与查看这一类只读的活（跑测试、看仓库状态、算个数）。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令行' },
        cwd: { type: 'string', description: '在哪个相对路径下执行（缺省是视图的根）' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'read',
    description: '读一个文件的内容，返回带行号的原文。可以只读一段（offset 从 1 数，limit 是最多几行）——长文件先用 grep 定位，再读那一段，比整篇读进来省。要改它用 edit 或 write；图片用 read_image。',
    parameters: {
      type: 'object',
      properties: {
        path: PATH,
        offset: { type: 'integer', description: '从第几行开始（从 1 数）' },
        limit: { type: 'integer', description: '最多读几行' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'glob',
    description: '按路径模式找文件，返回匹配的路径。知道文件名的一部分而不知道它在哪时用它；要找的是文件的内容用 grep。缺省从这一步的工作目录起找。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '路径模式，例如 src/**/*.ts' },
        path: { type: 'string', description: '在哪个相对路径下找（缺省是视图的根）' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'grep',
    description: '按内容找文件，返回匹配的行、文件名或条数（output_mode 决定哪一种；不确定要哪一种时用 content）。要找的是路径而不是内容用 glob。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要匹配的正则' },
        path: { type: 'string', description: '在哪个相对路径下找（缺省是视图的根）' },
        glob: { type: 'string', description: '只看这些路径（路径模式）' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: '要哪一种结果' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'todo_write',
    description: '记下当前的待办清单：一次给全，它整体覆盖上一次那一份。多步的活开始前写上，每推进一步更新那一行（正在做的那一条用 in_progress）。它是给自己看的进度，不是给人看的汇报。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '这一份完整的清单',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '这件事要做什么' },
              activeForm: { type: 'string', description: '正在做它时的说法' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '它到哪一步了' },
            },
            required: ['content', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
  },
  {
    name: 'subagent',
    description: '把一个自足的任务派给另一个 agent，它在自己的上下文里做完再把结果交回来。',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '三五个词的任务名，给人看' },
        prompt: { type: 'string', description: '完整的任务说明——它看不到这里的对话' },
        run_in_background: { type: 'boolean', description: '派出去就返回，不等结果（缺省等）' },
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_agents',
    description: '列出自己派出去的那些 agent：它们的 id 与状态。派出去之后要动手（追问、打断、收结果）先在这里拿 id；**回话会自己送到**，不用一直查。',
    parameters: {
      type: 'object',
      properties: { scope: { type: 'string', enum: ['children', 'descendants'], description: '只看直接子 agent，还是整棵树' } },
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description: '给一个已经派出去的 agent 发一条消息：它在忙就插到最近的一步，闲下来就让它接着做。',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: '目标 agent 的 id' },
        message: { type: 'string', description: '要说的话' },
      },
      required: ['agent_id', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_user_question',
    description: '问人一个问题，给出可选的答案。**只在答案归人时用它**：查得到的（代码在哪、现在怎么做的）先自己查，能自己定的按"最干净、最可扩展"定下来。一次可以问几个，每个给几个选项、各带一句代价说明。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: '要问的问题，一次可以问几个',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '问什么' },
              header: { type: 'string', description: '短标题' },
              multiSelect: { type: 'boolean', description: '可以多选吗' },
              options: {
                type: 'array',
                description: '可选的答案',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '答案本身' },
                    description: { type: 'string', description: '一句话说清这个选择的代价' },
                  },
                  required: ['label'],
                  additionalProperties: false,
                },
              },
            },
            required: ['question'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
  },
  {
    name: 'exit_plan_mode',
    description: '说一声预备态做完了：接下来要动真东西，门由人开。计划写完整了再调它，而且它是那一步的最后一个调用——交出去之后等人批，批了才动手。',
    parameters: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: '接下来打算怎么做' },
        planFilePath: { type: 'string', description: '这份计划写在哪个文件里' },
      },
      required: ['plan'],
      additionalProperties: false,
    },
  },
  {
    name: 'checkpoint',
    description: '把当前视图定格成一次提交，拿到它的提交号。产出告一段落时用它留一个可以回的落点；一轮结束时系统也会自己收一次。',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: '这一次提交说的是什么' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_action',
    description: '跑一个已经绑好的动作（构建 · 测试一类），它声明的产出会写回视图。动作是配好的、可复现的那几条命令：要跑的是临时的一条命令用 bash，要看某个动作收什么参数用它的名字去配置里查。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '动作的名字，绑在配置里' },
        args: { type: 'array', description: '传给这个动作的参数', items: { type: 'string' } },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
]

/**
 * 那份名字表：能力表以它为键，协议值的 `toolCatalog` 是它。**从目录算出来，不另写一份。**
 *
 * 这是名字的唯一定义处（架构 § 8.10）：两处名字表不一致时，前缀字节只是不同，没有别的报错
 * ——所以它只有一处，别的都是它的投影。
 */
export const TOOL_NAMES: readonly string[] = TOOL_ENTRIES.map((t) => t.name)

/**
 * 这一步的状态。**目录不读它**——它在这里是为了把「跨状态稳定」这句话写成一条能跑的断言：
 * 三份不同的状态，同一份目录。
 *
 * 它不是 `M2` 的视图、也不是 `M1` 的真源：那两样是段值的来源（Z4），而目录的字节不许受它们
 * 影响。给成三样最小的状态，恰好覆盖架构 § 8.10 那两个会诱使人往 schema 里塞东西的点：
 * 计划模式开与关、有没有待办。
 */
export interface CatalogState {
  readonly planMode: boolean
  readonly pendingTodos: number
}

/** 三种状态，取哈希用（架构 § 20 S6 的第四条验证那三种）。 */
export const CATALOG_STATES: readonly CatalogState[] = [
  { planMode: false, pendingTodos: 0 },
  { planMode: true, pendingTodos: 0 },
  { planMode: false, pendingTodos: 1 },
]

/**
 * 这一步的目录。**收一个状态，吐同一份目录。**
 *
 * `state` 是参数而不是「没有参数」：调用点手里有它，而这个签名把「它不许影响输出」写在明面上
 * ——② 那条断言量的就是这件事。真到了某一天某个 schema 真的要随状态变，它在这里变，而 ② 会
 * 当场红：**那正是这一条要拦下的东西**（schema 一变，前缀从第一个改变的 token 起全部失效）。
 */
export function catalog(_state: CatalogState): ToolEntry[] {
  return TOOL_ENTRIES.map((t) => ({ ...t }))
}

/** 一份目录的字节：键序稳定 · 无空格（口径与 Z0 的那一份一致，`assemble/render.ts` 的 `json`）。 */
export function catalogBytes(entries: readonly ToolEntry[]): string {
  return stableStringify(entries)
}

/** 一个工具条目的指纹：`sha256` 前 16 位（口径与 Z1 的 `hashOf` 一致）。 */
export function toolHash(entry: ToolEntry): string {
  return createHash('sha256').update(stableStringify(entry)).digest('hex').slice(0, 16)
}

/** 整份目录的指纹：`sha256` 前 16 位。**它进 A 区**（架构 § 8.11 的 `toolCatalog` 那一栏）。 */
export function catalogHash(entries: readonly ToolEntry[]): string {
  return createHash('sha256').update(catalogBytes(entries)).digest('hex').slice(0, 16)
}

/** 那些名字，给调用点一个不必自己 map 的入口。**与 `TOOL_NAMES` 同一份**（这一处是双向对账）。 */
export function catalogNames(entries: readonly ToolEntry[]): string[] {
  return entries === TOOL_ENTRIES ? [...TOOL_NAMES] : entries.map((t) => t.name)
}

const dup = TOOL_ENTRIES.map((t) => t.name).filter((n, i, all) => all.indexOf(n) !== i)
if (dup.length > 0) {
  throw new Error(`工具目录里有重名：${dup.join(' · ')}`)
}
const EMPTY = TOOL_ENTRIES.filter((t) => t.description === '' || Object.keys(t.parameters).length === 0)
if (EMPTY.length > 0) {
  throw new Error(`这几条没有描述或没有参数面：${EMPTY.map((t) => t.name).join(' · ')}`)
}
