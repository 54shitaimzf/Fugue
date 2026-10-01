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
const PATH = { type: 'string', description: 'Relative path inside the view' } as const

/**
 * 那十二个工具，逐个写它的参数面。**顺序不承重**：承重的是名字的域——能力表（§ 8.9）以这套
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
    description: 'Write the full contents of a file: create it, or replace the whole file. Every call writes the entire text, so a small change in the middle of a file should use edit rather than retyping it (retyping drops changes made elsewhere). The file is in the view as soon as this step lands: later reads and runs see it.',
    parameters: {
      type: 'object',
      properties: { path: PATH, content: { type: 'string', description: 'The text to write' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit',
    description: 'Replace one exact string in a file: give old_string enough context to appear exactly once. When it is not unique the call reports that instead of guessing which one — then make old_string longer, or pass replace_all. To replace the whole file use write.',
    parameters: {
      type: 'object',
      properties: {
        path: PATH,
        old_string: { type: 'string', description: 'The exact text to replace' },
        new_string: { type: 'string', description: 'The text to put in its place' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default: one only)' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_image',
    description: 'Read an image and return the image itself. read only handles text files; images go through this one.',
    parameters: {
      type: 'object',
      properties: { path: PATH },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command and get its exit code and output. **Only declared paths survive**: with a read-only work tree this command cannot change any file; with a writable one (round work) writes land in the tree but only the declared write paths are written back — anything outside them is reported and discarded. To produce files use write, or run an action (run_action). Suited to running tests, looking at repo state, or doing arithmetic.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run' },
        cwd: { type: 'string', description: 'Relative path to run in (default: the view root)' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'read',
    description: 'Read a file and return its text. Read a slice when the file is long (offset is 1-based, limit caps the lines; a slice comes back with the original line numbers, the whole file comes back verbatim) — locate with grep first; that is cheaper than reading the whole file. To change it use edit or write; for images use read_image.',
    parameters: {
      type: 'object',
      properties: {
        path: PATH,
        offset: { type: 'integer', description: 'First line to read (1-based)' },
        limit: { type: 'integer', description: 'Maximum number of lines' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'glob',
    description: 'Find files by path pattern and return the matching paths. Use it when you know part of a file name but not where it is; to search contents use grep. Searches from this step\'s working directory by default.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Path pattern, for example src/**/*.ts' },
        path: { type: 'string', description: 'Relative path to search under (default: the view root)' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'grep',
    description: 'Find files by content and return matching lines, file names, or counts (output_mode picks which; use content when unsure). To search paths rather than contents use glob.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to match' },
        path: { type: 'string', description: 'Relative path to search under (default: the view root)' },
        glob: { type: 'string', description: 'Only look at these paths (path pattern)' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Which kind of result to return' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'todo_write',
    description: 'Record the current to-do list: give it in full and it replaces the previous list. Write it before starting multi-step work and update the line as you advance (the one you are on uses in_progress). It is progress for yourself, not a report for anyone else.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete list',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'What this item is' },
              activeForm: { type: 'string', description: 'How to phrase it while in progress' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Where it stands' },
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
    name: 'ask_user_question',
    description: 'Ask a person a question, with options to choose from. **Use it only when the answer belongs to a person**: look up what is lookable (where the code is, how it works today), and settle what you can settle by the "cleanest and most extensible" rule. Several questions at a time are fine, each with options and a one-line note on what the choice costs.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'Questions to ask; several at a time are fine',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'What to ask' },
              header: { type: 'string', description: 'Short heading' },
              multiSelect: { type: 'boolean', description: 'May more than one be selected' },
              options: {
                type: 'array',
                description: 'The answers to pick from',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'The answer itself' },
                    description: { type: 'string', description: 'One line on what this choice costs' },
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
    description: 'Say that the planning phase is done: real work comes next, and a person opens the gate. Call it once the plan is complete, and make it the last call of that step — after handing it over you wait for approval before anything is touched.',
    parameters: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'What you intend to do next' },
        planFilePath: { type: 'string', description: 'Which file this plan is written in' },
      },
      required: ['plan'],
      additionalProperties: false,
    },
  },
  {
    name: 'checkpoint',
    description: 'Freeze the current view into one commit and get its id. Use it to leave a point you can come back to when a piece of work lands; a round also commits once by itself when it ends.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'What this commit says' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_action',
    description: 'Run an action bound in this workspace (a build, a test). The bound actions are listed in the system state, each with its name and the command line it runs; pass extra arguments as args and they are appended to that command line. For a one-off command use bash.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'The action name, bound in the config' },
        args: { type: 'array', description: 'Arguments passed to this action', items: { type: 'string' } },
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
