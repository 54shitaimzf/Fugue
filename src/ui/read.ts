// TUI 的第二版第九格：**阅读面**——diff · 契约正文 · 事件流（工具输出折叠 · 只重折尾部）。
//
// 出处：PLAN § 5.19 第二版「五 · 门口那一批怎么批」（"预览按类型分派……**diff 归 `T9`**"）· 第九节
// `T9` 那一行（"diff · 契约正文 · 事件流 + 工具输出折叠 + 只重折尾部；断言：面板与 `fugue diff
// --json` 读同一份数据；同一份输入重画两次逐字节相同"）· 架构 § 8.3（`Delta` 是变更序列）·
// § 9.2（账是唯一读源）· § 9.8。
//
// **这一份只读账**（`StatusRow[]`）：界面那一头没有第二个读源（`UI3` 那句"不另开读法、不新开读源"），
// 也没有真源句柄。于是"diff"这件事在账上读得到的那一半是 `view/*` 那五族的原文，读不到的那一半
// **说得出为什么读不到**：`View.diff()` 的 `add` 与 `modify` 要拿下层比、`bytes.length` 要读 blob，
// 账上没有那两样（`Delta` 的 `bytes` 是内容，不进日志）。**`DELTA_FACE` 那张表就是把这两半对上的
// 那一处**：`add` 与 `modify` 在读面上是同一格（`写`）。它与 `ui/stream.ts` 的 `FAMILY_KIND` 同一条
// 做法——**表是入参，不是模块私有的**：`read.test.ts` ① 的负对照就是把一格改掉，让那一面与
// `fugue diff --json` 当场对不上。
//
// 三条不许破的性质（第 ② ③ 条就是 `T9` 那两句话的可检形状）：
//
//   · **纯**：同一份行折两次逐字节相同——不读终端、不看时刻、一个字节都不写；
//   · **折是全序上的一段**（`readStateOf(rows, { prev })`）：拿上一次那份状态接着折，结果与从头折
//     **逐字段相同**；而"只折了尾部"这件事**数得出来**（`onRow` 那一颗钩子：折了几条就是几条）——
//     不这么定，跟随那一趟每来一条行都要把整份账重折一遍。
//     **接得上是有条件的**：合并序是 `(seq, writer)`，一个晚出现的 writer 的第一条会**插进旧账
//     中间**——下标当游标的增量折那时候就错了。所以游标带着"上一条是谁"（`last`），
//     `prefixOk` 那一步对不上就**从头折**（宁可慢一趟，不许少一条）；`read.test.ts` ③ 的负对照
//     量的是这一处；
//   · **少印要说出来**：一面最多印 `READ_LIMIT` 行，掐掉的那一截在头一行说清楚（逐条读法是
//     `fugue log`——抄本，不渲染不筛选）。
//
// **工具输出折叠**：一次 `run/start` 等它的 `run/end` 折成一行，一串连续的 `llm/call` 折成一行
// （"调了 N 次"）。这两族是**一步一条**的高频流水（28 族里 24 条是这一类），逐条进阅读面就只剩坐标；
// 折成一行之后"这一格跑了什么"才读得下去。折出来的行数在标题里说出来——**折叠不是丢**。
import type { Delta } from '../delta.ts'
import { FAMILY_KIND } from './stream.ts'
import { permanentLinesOf } from './stream.ts'
import { clustersOf } from './glyph.ts'
import type { StatusRow } from '../probe/status.ts'

/**
 * 读面上那一格变更：**账上的 `view/*` 那五族说得出的那几栏**（没有字节——账上没有它）。
 *
 * `write` 这一格是 `add` 与 `modify` 合起来的：`View.diff()` 分得出那两档是因为它能拿下层比，
 * 而账上只有"在 rev N 上写了这条路径"这一个事实。
 */
type DeltaFace =
  | { readonly kind: 'write'; readonly path: string }
  | { readonly kind: 'delete'; readonly path: string }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'chmod'; readonly path: string; readonly mode: number }
  | { readonly kind: 'symlink'; readonly path: string; readonly target: string }

/**
 * `Delta.kind` → 读面那一格。**唯一一处**（命令面与阅读面读的是它）。
 *
 * 键写成 `Record<Delta['kind'], …>`：`Delta` 长了新的一档而这里没跟上，是编译期的事；这一版没有
 * 构建步骤（约定 § 六），所以真正的判据在 `read.test.ts` ① 的负对照上。
 */
export const DELTA_FACE: Readonly<Record<Delta['kind'], DeltaFace['kind']>> = {
  add: 'write',
  modify: 'write',
  delete: 'delete',
  rename: 'rename',
  chmod: 'chmod',
  symlink: 'symlink',
}

/** 账上那一条行是不是 `view/*`（五族）；是就折成读面那一格，不是就 `null`。 */
function deltaFaceOf(row: StatusRow): DeltaFace | null {
  const e = row.e
  switch (e.t) {
    case 'view/write':
      return { kind: 'write', path: e.path }
    case 'view/remove':
      return { kind: 'delete', path: e.path }
    case 'view/rename':
      return { kind: 'rename', from: e.from, to: e.to }
    case 'view/chmod':
      return { kind: 'chmod', path: e.path, mode: e.mode }
    case 'view/symlink':
      return { kind: 'symlink', path: e.path, target: e.target }
    default:
      return null
  }
}

/**
 * 命令面那一份那几栏。**只要这几栏**：一个 `Delta`（带字节）与 `fugue diff --json` 印出来的那一条
 * （不带字节——`deltaJson` 一个字节都不进去）都落在这个形状里。
 */
interface DeltaLike {
  readonly kind: Delta['kind']
  readonly path?: string | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly mode?: number | undefined
  readonly target?: string | undefined
}

/**
 * 命令面那一份（`fugue diff --json` 的那一条 · 或者一个 `Delta`）→ 读面这一格。**与 `deltaFaceOf`
 * 同一张表，两个方向**——"面板与 `fugue diff --json` 读同一份数据"这句话，在代码里就是这两条路
 * 都过 `DELTA_FACE`。
 *
 * `table` 是入参（缺省就是 `DELTA_FACE`）：测试把一格改掉，用它证明这条对账真的在读那张表。
 */
export function faceOfDelta(d: DeltaLike, table: Readonly<Record<string, DeltaFace['kind'] | undefined>> = DELTA_FACE): DeltaFace | null {
  const kind = table[d.kind]
  if (kind === undefined) return null
  if (kind === 'rename') return { kind, from: d.from ?? d.path ?? '', to: d.to ?? '' }
  if (kind === 'chmod') return { kind, path: d.path ?? '', mode: d.mode ?? 0 }
  if (kind === 'symlink') return { kind, path: d.path ?? '', target: d.target ?? '' }
  return { kind, path: d.path ?? '' }
}

/**
 * 一格变更的**键**：路径 · 改名两端 · 模式那三栏——**命令面与阅读面对得上的就是它**。
 *
 * 挂在这一层而不是行那一层，是因为行里还带着账上的坐标（`<writer> <seq> · `），而命令面那一份
 * 没有坐标。要比的是"同一批行"，不是"同一行字"。
 */
export function faceKeyOf(d: DeltaFace): string {
  switch (d.kind) {
    case 'rename':
      return `rename\t${d.from}\t${d.to}`
    case 'chmod':
      return `chmod\t${d.path}\t${(d.mode & 0o777).toString(8)}`
    case 'symlink':
      return `symlink\t${d.path}\t${d.target}`
    default:
      return `${d.kind}\t${d.path}`
  }
}

/** 契约正文那一面的一份：**账上那一条 `contract/issue` 说得出的那几栏**。 */
interface ContractFace {
  readonly round: string
  readonly id: string
  readonly agent: string
  readonly paths: readonly string[]
  readonly body: string
}

/** 还没收口的那一组（工具输出折叠的那两族）。 */
type OpenGroup =
  | { readonly kind: 'calls'; readonly agent: string; readonly n: number; readonly model: string }
  | { readonly kind: 'run'; readonly agent: string; readonly step: string; readonly action: string; readonly argv0: string }

/**
 * 折到哪儿了。**这是 `prev` 那一档的全部内容**：折过几条 · 折的是哪一格 · 哪一组还开着。
 *
 * 换一格（`agent` 变了）就得从头折：`seen` 是**筛过之后那份行**里的下标，换一份筛法它就不作数了。
 */
export interface ReadState {
  readonly seen: number
  readonly agent: string | null
  /**
   * 折过的最后那一条是谁（`(writer, seq)`）。**它是"接得上"的判据**：`seen` 只是个下标，而
   * `(seq, writer)` 那个合并序会**插进旧账中间**（晚出现的 writer 第一条是 `seq = 1`）。
   */
  readonly last: { readonly writer: string; readonly seq: number } | null
  readonly open: OpenGroup | null
  readonly diff: readonly DeltaFace[]
  /** 与 `diff` 一一对应的坐标（`<writer> <seq> · `）。 */
  readonly diffAt: readonly string[]
  readonly contracts: readonly ContractFace[]
  readonly stream: readonly string[]
  /** 只记条数那一档（其余那几族）：一族一个数，不进 `stream`。 */
  readonly tally: Readonly<Record<string, number>>
  /** 折成永久行的条数（`ui/stream.ts` 那张表说了算）。 */
  readonly permanent: number
  /** 折成工具输出行的条数（折叠之后的**行**数——**不是**吃了多少条行）。 */
  readonly tool: number
  /** 只记条数那一档吃掉的**行**数。 */
  readonly counted: number
}

/** 空的那一份（一帧都没读过）。 */
export const EMPTY_READ: ReadState = {
  seen: 0,
  agent: null,
  last: null,
  open: null,
  diff: [],
  diffAt: [],
  contracts: [],
  stream: [],
  tally: {},
  permanent: 0,
  tool: 0,
  counted: 0,
}

/**
 * 上一次那一份还接得上吗：**前 `seen` 条与当时逐条一致**（只看末一条是谁——插进旧账中间那一条
 * 一定会把这个位置顶掉）。
 */
export function prefixOk(prev: ReadState, list: readonly StatusRow[]): boolean {
  if (prev.seen === 0) return true
  if (prev.seen > list.length) return false
  const last = list[prev.seen - 1]
  if (last === undefined || prev.last === null) return false
  return last.pos.writer === prev.last.writer && last.pos.seq === prev.last.seq
}

interface ReadOptions {
  /** 只读某一格（`null` / 不给 = 整份账）——与 `status --agent <x>` 同一句口径。 */
  readonly agent?: string | null
  /** 上一次那一份：**给了就只折尾部**（`seen` 之后那几条）；换了一格就自动从头折。 */
  readonly prev?: ReadState | undefined
  /**
   * 折一条就报一次。**入参，不是模块私有的**（与 `ui/stream.ts` 的 `table` 同一条）：`read.test.ts`
   * ③ 用它数"这一次折了几条"——"只折尾部"这句话就靠这颗钩子兑现。
   */
  readonly onRow?: ((row: StatusRow) => void) | undefined
}

/** 一行读面前缀：**账上的坐标**（与 `fugue log` 前两栏同一个写法）。 */
function at(row: StatusRow): string {
  return `${row.pos.writer} ${row.pos.seq} · `
}

/** 一串调用那一行（`n` 变一次重写一次：折的是**同一行**，不是每天一行）。 */
function callsLine(g: { readonly agent: string; readonly n: number; readonly model: string }): string {
  return `格 ${g.agent} · 调用 ${g.n} 次 · 最近 ${g.model}`
}

/** 一次起进程那一行的头（`run/end` 到了就在它后面接尾巴）。 */
function runHead(g: { readonly agent: string; readonly step: string; readonly action: string; readonly argv0: string }): string {
  return `格 ${g.agent} · 步 ${g.step} · 起了 ${g.argv0}（${g.action}）`
}

/**
 * 折一步：`rows` 是**这一刻的全量行**（跟随每来一条就把它整体递进来），`prev` 是上一次那一份。
 * 返回的是**累计**的那一份（标题里那几个数 · 三面 · 折到哪儿）。
 *
 * **它不做渲染**：一面的行怎么排版、掐到几行由 `facesOf` 管——"折"与"印"分开之后，"只折尾部"与
 * "重画两次一样"这两件事各证各的。
 */
export function readStateOf(rows: readonly StatusRow[], opts: ReadOptions = {}): ReadState {
  const agent = opts.agent ?? null
  const same = opts.prev !== undefined && opts.prev.agent === agent
  // **筛在折之前**（与 `probe/status.ts` 的 `readings` 同一处口径）：`seen` 因此是这一份筛过的行里的
  // 下标，而"换一格"与"前缀被顶掉"由上面那一句与 `prefixOk` 挡住——接不上就从头折。
  const list = agent === null ? rows : rows.filter((r) => r.pos.writer === agent)
  const prev = same && prefixOk(opts.prev as ReadState, list) ? (opts.prev as ReadState) : { ...EMPTY_READ, agent }

  const diff = [...prev.diff]
  const diffAt = [...prev.diffAt]
  const contracts = [...prev.contracts]
  const stream = [...prev.stream]
  const tally = { ...prev.tally }
  let open = prev.open
  let permanent = prev.permanent
  let tool = prev.tool
  let counted = prev.counted

  for (let i = prev.seen; i < list.length; i += 1) {
    const row = list[i] as StatusRow
    if (opts.onRow !== undefined) opts.onRow(row)
    const e = row.e

    // 一 · diff 那一面（`view/*` 那五族）。
    const face = deltaFaceOf(row)
    if (face !== null) {
      diff.push(face)
      diffAt.push(at(row))
    }
    // 二 · 契约正文那一面。
    if (e.t === 'contract/issue') {
      open = null
      contracts.push({ round: e.round, id: e.contract, agent: e.owner, paths: [...e.paths], body: e.body })
    }

    // 三 · 事件流那一面。**工具输出折叠的那两族先走**，其余的走 `ui/stream.ts` 那张分法。
    if (e.t === 'llm/call') {
      if (open !== null && open.kind === 'calls' && open.agent === e.agent) {
        open = { kind: 'calls', agent: e.agent, n: open.n + 1, model: e.model }
        stream[stream.length - 1] = callsLine(open)
      } else {
        open = { kind: 'calls', agent: e.agent, n: 1, model: e.model }
        stream.push(callsLine(open))
        tool += 1
      }
      continue
    }
    if (e.t === 'run/start') {
      open = { kind: 'run', agent: e.agent, step: e.step, action: e.action, argv0: e.argv0 }
      stream.push(runHead(open))
      tool += 1
      continue
    }
    if (e.t === 'run/end') {
      const tail = `· exit ${e.exit} · ${e.ms}ms${e.denied ? ' · 被内核拒' : ''}`
      if (open !== null && open.kind === 'run' && open.step === e.step && open.agent === e.agent) {
        stream[stream.length - 1] = `${runHead(open)} ${tail}`
      } else {
        // 没等到它的 `run/start`（从前半截账起读 · 或那一行只记了结束）：**照样印出来**。
        stream.push(`格 ${e.agent} · 步 ${e.step} ${tail}`)
        tool += 1
      }
      open = null
      continue
    }
    if (FAMILY_KIND[e.t] === 'permanent') {
      open = null
      stream.push(permanentLinesOf([row])[0] as string)
      permanent += 1
      continue
    }
    // 其余那几族（`prefix/*` · `mat/*` · `ckpt/*` · `holder/*` · `run/confined` · `view/*` 的流水）：
    // **只记条数**。逐条进这一面等于把阅读面淹掉，而逐条读法本来就在（`fugue log`）。
    open = null
    tally[e.t] = (tally[e.t] ?? 0) + 1
    counted += 1
  }

  return {
    seen: list.length,
    agent,
    last: list.length === 0 ? null : { writer: (list[list.length - 1] as StatusRow).pos.writer, seq: (list[list.length - 1] as StatusRow).pos.seq },
    open,
    diff,
    diffAt,
    contracts,
    stream,
    tally,
    permanent,
    tool,
    counted,
  }
}

/** 一面（标题 + 那几行）。 */
interface ReadFace {
  readonly title: string
  readonly lines: readonly string[]
}

/** 三面。**没有的那一面是 `null`**（不是空的一行——"没有"与"有但是空的"要分得开）。 */
interface ReadFaces {
  readonly diff: ReadFace | null
  readonly contract: ReadFace | null
  readonly stream: ReadFace
}

/** 三面的名字（按键在它们之间轮换）。 */
export type ReadFaceName = 'diff' | 'contract' | 'stream'

/** 一面的上限（行）。**它是一个常量，可调**：掐掉的那一截在头一行说清楚。 */
export const READ_LIMIT = 200

/** 只留尾部那 `limit` 行；掐掉了就在最前面说一句（**少印要说出来**）。 */
function tail(lines: readonly string[], limit: number): readonly string[] {
  if (lines.length <= limit) return lines
  const cut = lines.length - limit + 1
  return [`… 前面还有 ${cut} 行（这一面最多印 ${limit} 行；逐条读法是 \`fugue log\`）`, ...lines.slice(cut)]
}

/** 一格变更那一行：坐标 + 那一格。 */
function deltaLinesOf(d: DeltaFace, at_: string): readonly string[] {
  switch (d.kind) {
    case 'write':
      return [`${at_}写 ${d.path}`]
    case 'delete':
      return [`${at_}删 ${d.path}`]
    case 'rename':
      return [`${at_}改名`, `  从 ${d.from}`, `  到 ${d.to}`]
    case 'chmod':
      return [`${at_}改权限 ${d.path} ${(d.mode & 0o777).toString(8)}`]
    case 'symlink':
      return [`${at_}符号链接`, `  路径 ${d.path}`, `  目标 ${d.target}`]
  }
}

/** 契约只排已有数据：每条写入路径与正文段落都可翻到，不另读文件。 */
function contractLinesOf(c: ContractFace): readonly string[] {
  return [
    `契约 ${c.id} · 轮次 ${c.round} · 归属 ${c.agent}`,
    `  写入面 ${c.paths.length} 条`,
    ...c.paths.map((path) => `    ${path}`),
    '  正文',
    ...c.body.replace(/\r\n?/g, '\n').split('\n').map((line) => `    ${line}`),
  ]
}

/** 只记条数那一档那一行（一族一个数，多的说出来）。 */
function tallyLineOf(tally: Readonly<Record<string, number>>): string | null {
  const names = Object.keys(tally).sort()
  if (names.length === 0) return null
  const total = names.reduce((n, k) => n + (tally[k] as number), 0)
  const shown = names
    .map((k) => `${k} ${tally[k] as number}`)
    .slice(0, 6)
    .join(' · ')
  const more = names.length > 6 ? ' · …' : ''
  return `其余事件 ${total} 条（${shown}${more}；逐条读法是 \`fugue log\`）`
}

/**
 * 三面：**只排版，不再折**（进去的是 `readStateOf` 那一份）。`limit` 是每一面的行数上限。
 *
 * 一面的标题里带着那一面自己的读数（几条变更 · 几份契约 · 折掉了多少），于是"折叠不是丢"这句话
 * 在屏幕上是看得见的。
 */
export function facesOf(state: ReadState, opts: { readonly limit?: number } = {}): ReadFaces {
  const limit = opts.limit ?? READ_LIMIT
  const diffLines = state.diff.flatMap((d, i) => [...deltaLinesOf(d, state.diffAt[i] as string)])
  const contractLines = state.contracts.flatMap((c) => [...contractLinesOf(c)])
  const tally = tallyLineOf(state.tally)
  const streamAll = tally === null ? [...state.stream] : [...state.stream, tally]
  return {
    diff:
      state.diff.length === 0
        ? null
        : {
            title: `diff · ${state.diff.length} 条变更（写 = add / modify）`,
            lines: tail(diffLines, limit),
          },
    contract:
      state.contracts.length === 0
        ? null
        : { title: `契约正文 · ${state.contracts.length} 份（到达序）`, lines: tail(contractLines, limit) },
    stream: {
      title:
        `事件流 · ${state.seen} 条（永久行 ${state.permanent} · 工具输出折成 ${state.tool} 行` +
        `（吃了 ${state.seen - state.permanent - state.counted} 条） · 只计数 ${state.counted} 条）`,
      lines: tail(streamAll, limit),
    },
  }
}

/**
 * 三面里的第几面：`Tab` 在它们之间轮换。**没有的那一面跳过去**（`diff` 一条变更都没有时按下
 * `Tab` 不该停在一张空纸上）；三面都没有（不可能：`stream` 总在）时给 `stream`。
 */
export function stepFace(faces: ReadFaces, name: ReadFaceName, delta: number): ReadFaceName {
  const names = (['diff', 'contract', 'stream'] as const).filter((n) => faces[n] !== null)
  const list = names.length === 0 ? (['stream'] as const) : names
  const at = list.indexOf(name)
  const next = at < 0 ? 0 : (((at + delta) % list.length) + list.length) % list.length
  return list[next] as ReadFaceName
}

/**
 * 那一面从第几行看起（U14）：`↑`/`↓` 是 ±1，`PgUp`/`PgDn` 是 ±`PAGE_STEP`，`Ctrl-Home`/`Ctrl-End`
 * 用一个够大的数一步到头。**夹住，到头停**——正文是一串有头有尾的东西，翻过头绕回来会让人以为
 * 自己没动（与门口 `stepAt` 同一条口径）。
 */
export function stepTop(length: number, top: number, delta: number): number {
  const last = Math.max(0, length - 1)
  const now = Math.max(0, Math.min(top, last))
  return Math.max(0, Math.min(now + delta, last))
}

/** 打开阅读面时先看哪一面：有 diff 就看 diff，没有就看事件流。 */
export function firstFace(faces: ReadFaces): ReadFaceName {
  return faces.diff !== null ? 'diff' : 'stream'
}

/**
 * 阅读面的显示行：按完整簇折行，保留路径、正文的空格与标点。
 * 与通用 `wrap` 不同，这里不吃分隔符或空白（它们可能是正文的一部分）。
 * 续行缩进使坐标 / 动作与正文易区分；不足两列时不能展示宽簇，明确印 …。
 */
function readWrap(line: string, columns: number): readonly string[] {
  const width = Math.max(1, Math.floor(columns))
  const indent = width >= 8 ? '  ' : ''
  const out: string[] = []
  // 生的控制字节不是显示簇：显式转义，防止正文改变光标或终端属性。
  const visible = line.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  const clusters = clustersOf(visible)
  let at = 0
  while (at < clusters.length) {
    const prefix = out.length === 0 ? '' : indent
    const budget = width - prefix.length
    let used = 0
    let end = at
    let space = -1
    while (end < clusters.length && used + (clusters[end]?.width ?? 0) <= budget) {
      const c = clusters[end] as (typeof clusters)[number]
      used += c.width
      end += 1
      if (c.text === ' ') space = end
    }
    if (end === at) {
      // 一列放不下宽簇：明确省略，免得终端自动换行破坏面板几何。
      out.push(`${prefix}…`)
      at += 1
      continue
    }
    // 整词能放下时在空格之后断，空格本身保留；长路径无空格则硬折。
    if (end < clusters.length && space > at && clusters[end]?.text !== ' ') end = space
    out.push(prefix + clusters.slice(at, end).map((c) => c.text).join(''))
    at = end
  }
  if (out.length === 0) out.push('')
  return out
}

/** 标题算第 0 行；给列宽时返回可逐行翻到的物理行，显示与滚动共用这一份。 */
export function faceRowsOf(faces: ReadFaces, name: ReadFaceName, columns?: number): readonly string[] {
  const one = faces[name]
  if (one === null) return []
  if (columns === undefined) return [one.title, ...one.lines]
  const width = Math.max(1, Math.floor(columns))
  // 最多 READ_LIMIT 条显示行，超限仍在头部声明。标记自己也按列宽折。
  const rows = [one.title, ...one.lines].flatMap((line) => [...readWrap(line, width)])
  if (rows.length <= READ_LIMIT) return rows
  let cut = rows.length - READ_LIMIT + 1
  let notice = readWrap(`… 前面还有 ${cut} 显示行（全文 fugue log）`, width)
  while (cut !== rows.length - READ_LIMIT + notice.length) {
    cut = rows.length - READ_LIMIT + notice.length
    notice = readWrap(`… 前面还有 ${cut} 显示行（全文 fugue log）`, width)
  }
  return [...notice, ...rows.slice(cut)]
}
