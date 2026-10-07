// 命令值层的形状。出处：架构 § 9.6「**命令本身是一份值层，CLI 是它的第一个壳**」——
// 每条命令收一份**参数**、出一份**值**，值就是 § 9.8 契约表里 `--json` 印出来的那一份；CLI 这一层
// 只做三件事：把 argv 解析成参数 · 把值排成人读或 `--json` · 决定退出码。**同一个值层还有第二个
// 壳**：serve（§ 9.11）把同一批动词摆到 JSON-RPC 的报文上，出的还是同一个值。
//
// 这一份只定类型，不实现命令。**两条脸都是同一格值的投影**——于是「CLI 与 serve 出同一个值」这句
// 话在类型上就成立，而不是靠两处各写一遍对得上。
//
// 值分三档（**今天真实存在的三种输出形状**，不是设计出来的分类）：
//
//   · `unit`——一次请求出**一个** JSON 值（`{...}` 或 `[...]`）。今天 `--json` 印的就是
//     `JSON.stringify(v)` 加一个换行；serve 的 `result` 就是这个 `v`。
//   · `bytes`——载荷是字节（今天的 `read`）。人读那一面把字节原样写 stdout；`--json` 那一面印的
//     是**元数据**（`{path, size, mode, id, kind}`）。§ 9.11「字节走带外」说的就是这一档：v1 的
//     方法面只到元数据那一条边，字节仍走它今天走的那条路。
//   · `stream`——一次请求出**一串行**（今天的 `log` · `watch`）。NDJSON 一行一个；serve 那一趟
//     把这一串装进一条回执（§ 9.11「一趟调用一趟事」）。
//
// **两条脸的字节由命令那一步给全**（`faces`），值层不猜渲染：人读那一面有的是对齐 · 有的是
// 制表符 · 有的是 `JSON.stringify`——把它们收进同一条 return，才谈得上「挪渲染」这回事。
//
// 退出码不在值里：值说的是「这条命令出了什么」，退出码说的是「这一趟算成没成」——§ 9.8 的四档
// （0/1/2/3）与 § 9.11 的两段错误码对的就是后者。

/** 一次请求的两个投影。`json` = `--json`（也是 serve 的 `result`）· `human` = 人读缺省面。 */
export interface Faces {
  /** `--json` 那一面的正文（**不含**末尾换行；壳按行拼）。 */
  readonly json: string
  /** 人读缺省面的正文（多行用 `\n` 连；**不含**末尾换行）。 */
  readonly human: string
}

/** 值的三档。 */
export type Value =
  | { readonly kind: 'unit'; readonly jsonValue: unknown; readonly faces: Faces }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array; readonly faces: Faces }
  | { readonly kind: 'stream'; readonly rows: readonly unknown[]; readonly faces: Faces }

/** 一条命令失败：退出码 1（§ 9.8「做不成」）。`hint` 与 `subject` 就是错误那两栏。 */
export class CommandError extends Error {
  readonly hint: string | undefined
  readonly subject: string | undefined
  constructor(message: string, o: { hint?: string; subject?: string } = {}) {
    super(message)
    this.name = 'CommandError'
    this.hint = o.hint
    this.subject = o.subject
  }
}

/** 命令行本身不成立：退出码 2（§ 9.8「敲错了」）。 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** 一次请求的结果：成了给值，没成给一句话（退出码按类落四档，壳来判）。 */
export type ValueResult =
  | {
      readonly ok: true
      readonly value: Value
      /**
       * 写在 stderr 上的那几行（**不是错**：`chmod` 的「没有变化」· `fork` 的档位说明那一类）。
       * 收在这里而不是让命令自己写 stderr：壳要把同一条命令摆到 serve 上——那边没有 stderr，
       * 这几行就跟着值走。
       */
      readonly notes?: readonly string[]
    }
  | {
      readonly ok: false
      readonly code: 1 | 2 | 3
      readonly message: string
      readonly hint?: string
      readonly subject?: string
    }

/** 一条命令收到的参数：**argv 解析之后**的那一份（`rest` 只有 `run` 收）。 */
export interface ValueArgs {
  readonly root: string
  readonly flags: Map<string, string | true>
  /** 命令之后的位置参数（`positional.slice(1)`）。 */
  readonly args: readonly string[]
  /** `--` 之后的原文（`run` 的 `k=v…`）。 */
  readonly rest: readonly string[]
}

/** 一条命令的值：**同一格值的两条投影**，加一个回执里用得上的结构化那一份。 */
export interface CommandValue<T = unknown> {
  /** 结构化那一条（serve 的 `result`；`unit` 那一档就是它）。 */
  readonly value: T
  /** 两条脸的字节。 */
  readonly faces: Faces
  /** 载荷是字节的那一档（今天的 `read`）：人读那一面写的是它，不是 `faces.human`。 */
  readonly bytes?: Uint8Array
}

/** 一次请求成了：给值。 */
export function ok<T>(v: CommandValue<T>, notes?: readonly string[]): ValueResult {
  const kind: Value['kind'] = v.bytes === undefined ? 'unit' : 'bytes'
  const value: Value =
    v.bytes === undefined
      ? { kind, jsonValue: v.value, faces: v.faces }
      : { kind: 'bytes', bytes: v.bytes, faces: v.faces }
  return { ok: true, value, ...(notes === undefined || notes.length === 0 ? {} : { notes }) }
}

/**
 * 一档值的常用形状：**一个 JSON 值 + 一个人读投影**。今天的命令里绝大多数就是它——
 * `--json` 那一面是 `JSON.stringify(value)`，人读那一面是几行字。
 */
export function unit<T>(value: T, human: string | readonly string[]): CommandValue<T> {
  return {
    value,
    faces: {
      json: JSON.stringify(value),
      human: typeof human === 'string' ? human : human.join('\n'),
    },
  }
}
