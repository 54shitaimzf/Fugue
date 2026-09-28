// TUI 的第二版第四格：**菜单与面板**——一张候选表，两个来源（命令 · 路径），三个入口（`/` · `Ctrl-P` · `@`）。
//
// 出处：PLAN § 5.19 第二版「二 · 按键」（"一张表，喂三处：提示行 · 帮助面板 · `/` 菜单的候选"，`/` 与
// `Ctrl-P` 两个入口同一张候选表）· 第九节 `T4` 那一行（"菜单里列出的命令集合与 `FLAGS_OF` 的键集合
// 逐字相同"）· 架构 § 9.8（**人的每个状态动作都是一条命令**）与 § 9.6（单次进程 + 每次重建）。
//
// 三条不许破的性质（`menu.test.ts` 逐条量）：
//
//   · **候选表就是命令面那一张**（`cli/flags.ts` 的 `FLAGS_OF`）：这一份不抄一份目录、不写死几条命令
//     ——"菜单里有、按下去没有"那一种坏法在这里没有入口。同类里有一家把帮助目录与真分发分成两张
//     互不相干的表，实测漂了 5 条（`?` · `l` · `v` · `g` · `G`）；
//   · **面板里没有查询词**：查询是从**输入行推出来的**（`queryOf`）——行首那个 `/` 与那个 `@` 就是
//     模式标记，于是"面板在筛什么"与"行里有什么"永远不打架：把那个记号删掉，面板自己就关了；
//   · **选中不是执行**：`acceptOf` 只还回"这一行该长什么样"，起不起那条命令仍然归 `ui/run.ts` 那一格
//     （`T3`）——菜单里少一条"自己就能发命令"的路。
//
// 两段候选都从同一张表推：先把命令名按**前缀**筛；名字一个都匹配不上时，看是不是**已经选定了某一条
// 命令**（`q` 以 `名字 + 空格` 开头），是就换成那一条的开关。于是"这个命令认哪些开关"这件事在界面上
// 也只有一个来源——`FLAGS_OF` 那一份（`T4` 那条断言量的就是它）。

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 候选从哪儿来。**三个来源**（PLAN § 5.19 二那条"一张表喂三处"与第九节 `T4` 那一行在两处各说了
 * 一半，这里是它们的收口）：
 *
 *   · `cmd`：命令面那一张表（`cli/flags.ts` 的 `FLAGS_OF`）——`/` 与 `Ctrl-P` 的那一档；
 *   · `keys`：键位表（`ui/keymap.ts`）——**提示行与帮助面板的第三处渲染**，`Ctrl-P`；
 *   · `path`：工作区里的路径——`@`。
 */
export type MenuSource = 'cmd' | 'keys' | 'path'

/** 一条候选是哪一类（**补全与接上那一行靠它，不靠名字长什么样**）。`key` 那一类接不进去（它只是一句读）。 */
type MenuKind = 'cmd' | 'flag' | 'path' | 'key'

/** 一条候选：名字是拿去补全的，说明是给人看的。 */
export interface MenuRow {
  readonly name: string
  readonly note: string
  readonly kind: MenuKind
}

/** 命令面那一张表的一格（`cli/flags.ts` 的 `FLAGS_OF` 每一格就是它）。**结构对得上就收**。 */
interface CommandSpec {
  readonly name: string
  readonly flags: readonly string[]
  readonly note?: string | undefined
}

/**
 * `FLAGS_OF` → 候选的输入。**键集合就是命令集合**（`T4` 那条断言的左边那一半），一格都不许少：
 * 这一份是"照单全收"，不是"挑几条好看的"。
 */
export function specsOf(
  tables: Readonly<Record<string, { readonly flags: readonly string[]; readonly note?: string | undefined }>>,
): readonly CommandSpec[] {
  return Object.entries(tables).map(([name, t]) => ({
    name,
    flags: t.flags,
    ...(t.note === undefined ? {} : { note: t.note }),
  }))
}

/** 这一行字是**命令**还是**话**（与 `ui/input.ts` 的 `modeOf` 同一条：行首那个 `/`）。 */
function isCommandLine(line: string): boolean {
  return line.startsWith('/')
}

/**
 * 面板此刻在筛什么。**推出来的，不是存下来的**：
 *
 *   · 命令：行首有 `/` 就筛斜杠后面那些字；没有（`Ctrl-P` 在话上按下）就一个都不筛——印全量，
 *     让人从单子上挑；
 *   · 路径：最后一个 `@` 后面那些字；一个 `@` 都没有时返回 `null`——**面板自己关了**（`@` 是
 *     面板开的，删掉它就没有面板了）。
 */
export function queryOf(line: string, source: MenuSource): string | null {
  if (source === 'path') {
    const at = line.lastIndexOf('@')
    return at < 0 ? null : line.slice(at + 1)
  }
  // 键表那一档：**行里那几个字就是筛子**（面板是 `Ctrl-P` 开在话上的那一档，行里没字就印全部）。
  if (source === 'keys') return isCommandLine(line) ? line.slice(1) : line
  return isCommandLine(line) ? line.slice(1) : ''
}

/** 已经选定的那条命令（`q` 以 `名字 + 空格` 开头时**最长**的那一条——`round go` 赢过 `round`）。 */
function pickCommand(specs: readonly CommandSpec[], q: string): CommandSpec | null {
  let hit: CommandSpec | null = null
  for (const s of specs) {
    if (q.startsWith(`${s.name} `) && (hit === null || s.name.length > hit.name.length)) hit = s
  }
  return hit
}

/**
 * 命令那一段的候选：**前缀**匹配（不是包含——名字是拿来补全的，包含匹配会让人补出个不想按的）。
 * 名字一个都匹配不上时进第二段：那一条命令的开关。
 */
function cmdRowsOf(specs: readonly CommandSpec[], q: string): readonly MenuRow[] {
  const head = specs.filter((s) => s.name.startsWith(q))
  if (head.length > 0) {
    return head.map((s) => ({ name: s.name, note: s.note ?? `${s.flags.length} 个开关`, kind: 'cmd' as const }))
  }
  const picked = pickCommand(specs, q)
  if (picked === null) return []
  const word = q.slice(q.lastIndexOf(' ') + 1)
  return picked.flags
    .map((f) => `--${f}`)
    .filter((f) => f.startsWith(word))
    .map((f) => ({ name: f, note: '', kind: 'flag' as const }))
}

/** 路径那一段：**名字里含这几个字**就算（路径是拿来认的，前缀匹配漏得太多）。次序是走出来的次序。 */
export function pathRowsOf(paths: readonly string[], q: string): readonly MenuRow[] {
  return paths.filter((p) => p.includes(q)).map((p) => ({ name: p, note: '', kind: 'path' as const }))
}

/** 这一刻的候选（**面板那一层只调它**：来源不同，推法不同，出来的都是同一形状）。 */
export function candidatesOf(o: {
  readonly specs: readonly CommandSpec[]
  readonly paths?: readonly string[] | undefined
  readonly keys?: readonly MenuRow[] | undefined
  readonly line: string
  readonly source: MenuSource
}): readonly MenuRow[] {
  const q = queryOf(o.line, o.source)
  if (q === null) return []
  if (o.source === 'path') return pathRowsOf(o.paths ?? [], q)
  // 键表那一档：一行整句（键串 + 短提示）拿这几个字去筛——"哪一条跟 `Ctrl` 有关"这一问答得出来。
  if (o.source === 'keys') return (o.keys ?? []).filter((r) => r.name.includes(q))
  return cmdRowsOf(o.specs, q)
}

/** 选中项落在候选里（候选变少了、或者刚翻开时，那个下标要夹回来）。 */
export function clampSel(n: number, sel: number): number {
  return n <= 0 ? 0 : Math.max(0, Math.min(n - 1, sel))
}

/** `↑`/`↓`：**环**——到底了再按一下回到另一头（面板里翻到底还在按，那就是想回头）。 */
export function moveSel(n: number, sel: number, d: -1 | 1): number {
  if (n <= 0) return 0
  return (clampSel(n, sel) + d + n) % n
}

/** 带空格的路得带引号（`ui/run.ts` 的切词认引号——`@` 引一条带空格的路径就是它）。 */
function quoted(p: string): string {
  return p.includes(' ') ? `"${p}"` : p
}

/**
 * 选中那一条之后**这一行该长什么样**。**只还回一行字，不起命令**（起命令是 `ui/run.ts` 那一格）。
 * `null` = 这个来源此刻没有查询词（面板已经该关了），不接。
 */
export function acceptOf(line: string, source: MenuSource, row: MenuRow): string | null {
  if (source === 'path') {
    const at = line.lastIndexOf('@')
    if (at < 0) return null
    return `${line.slice(0, at + 1)}${quoted(row.name)}`
  }
  // 键表那一档**只是读**（它是帮助面板的第三个渲染）：接不进这一行，所以 `null`。
  if (source === 'keys' || row.kind === 'key') return null
  const q = queryOf(line, 'cmd')
  if (q === null) return null
  // 开关那一段：换掉手里正在打的那个词，前头那几个字原地不动。
  if (row.kind === 'flag') return `/${q.slice(0, q.lastIndexOf(' ') + 1)}${row.name} `
  return `/${row.name} `
}

/** 最长公共前缀（空表 → 空串）。 */
export function commonPrefix(names: readonly string[]): string {
  const first = names[0]
  if (first === undefined) return ''
  let out = first
  for (const n of names) {
    let i = 0
    while (i < out.length && i < n.length && out[i] === n[i]) i += 1
    out = out.slice(0, i)
    if (out === '') break
  }
  return out
}

/**
 * `Tab`：把手里这个词补到候选的**最长公共前缀**；只剩一条候选时补成整条（命令后面补一个空格，
 * 好接着打开关）。**补不动就 `null`**——那时 `Tab` 去干表里那另一件事（在各面板之间轮换，`T8`），
 * 而不是安静地把这一行改坏。
 */
export function completeOf(o: {
  readonly rows: readonly MenuRow[]
  readonly line: string
  readonly source: MenuSource
}): string | null {
  if (o.source === 'keys') return null
  const q = queryOf(o.line, o.source)
  if (q === null || o.rows.length === 0) return null
  // **换哪一段**（这一处错了就会补出 `/round round go` 那种东西）：命令名那一段，手里那个"词"就是
  // **整个查询词**（`round g` 是"正在打一条命令名"）；开关那一段只换最后一个词（前头那两段不动）；
  // 路径那一段换掉 `@` 后面那些字。
  const wholeName = o.source === 'cmd' && (o.rows[0] as MenuRow).kind === 'cmd'
  const cut = o.source === 'path' || wholeName ? 0 : q.lastIndexOf(' ') + 1
  const head = o.source === 'path' ? o.line.slice(0, o.line.lastIndexOf('@') + 1) : `/${q.slice(0, cut)}`
  const word = o.source === 'path' ? q : q.slice(cut)
  const only = o.rows.length === 1 ? (o.rows[0] as MenuRow).name : null
  const next = only !== null && only.startsWith(word) ? only : commonPrefix(o.rows.map((r) => r.name))
  if (next.length > word.length) return `${head}${next}`
  // 补不动了——除非只剩一条、而且它已经补全了：这一下补的是**后面那个空格**。
  if (only !== null && only === word) return `${head}${next} `
  return null
}

/** 候选那几行印出来什么样：名字那一列按本屏最长的那一条对齐，说明跟在后面。 */
export function rowsTextOf(rows: readonly MenuRow[]): readonly string[] {
  let w = 0
  for (const r of rows) w = Math.max(w, r.name.length)
  return rows.map((r) => (r.note === '' ? r.name : `${r.name}${' '.repeat(w - r.name.length + 2)}${r.note}`))
}

/** 路径那一档的边界：**深度与条数都有界**（一个 `@` 不该把整棵树读进内存里）。 */
export const PATHS_DEPTH = 3
const PATHS_MAX = 200

/** 这几样一律不走进去（构建产物与版本库元数据不是"工作区里的一条路径"）。 */
const SKIP: readonly string[] = ['node_modules', 'dist', 'build', '__pycache__', 'target']

/**
 * 工作区里那些路径（`@` 那一档的候选）。**读不到的目录跳过，不抛**：一条路径列不出来不是"这一档坏
 * 了"（地板那一档的说法是"少印几条"，不是"跑不起来"）。每一层按名字排好，于是同一棵树两次走出来的
 * 次序逐字相同（`menu.test.ts` 量它）。
 *
 * 根是**这一趟的 cwd**（`--root` 说的是账在哪，不是人在哪；命令行里的相对路径按 cwd 算）。
 */
export function pathsOf(
  root: string,
  o: { readonly depth?: number; readonly limit?: number } = {},
): readonly string[] {
  const maxDepth = o.depth ?? PATHS_DEPTH
  const limit = o.limit ?? PATHS_MAX
  const out: string[] = []
  const walk = (dir: string, prefix: string, d: number): void => {
    if (d > maxDepth || out.length >= limit) return
    let entries: readonly { readonly name: string; isDirectory(): boolean }[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of sorted) {
      if (out.length >= limit) return
      if (e.name.startsWith('.') || SKIP.includes(e.name)) continue
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
      if (e.isDirectory()) {
        out.push(`${rel}/`)
        walk(join(dir, e.name), rel, d + 1)
      } else {
        out.push(rel)
      }
    }
  }
  walk(root, '', 1)
  return out
}
