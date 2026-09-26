// M3 的路径算术。**纯函数：不碰文件系统，不看配置，不认识权限。**
//
// 它管两件事，各自只有一处实现：
//
//   一 · 虚拟空间的路径语法——一串字符是不是视图内的合法路径（`RelPath`）；
//   二 · 虚拟路径与物理落点之间的算术——四个根 · 三处拼 · 一处拆。
//
// 围栏（`fence.ts`）与落点探测（`host.ts`）不在这里：那两处要读文件系统。四个文件互不认识，
// 装配在 `roots.ts`——换掉任何一份都不动另外三份。
//
// **语法是严格的，宽容只留给围栏。** `assertRelPath` 收的是"已经是视图内的路径"的值：里面
// 出现 `..`／空段／绝对路径，说明调用方把一个没解析过的字符串当成了路径——那是程序错误
// （抛），不是用户输入（围栏返回 `Denied`，带指路文案）。两者的形状因此也不同。
//
// **反斜杠与空字节在这里就拒。** 视图的路径语义不跟着平台变（架构 § 8.4 末段：UNC · 盘符 ·
// 大小写不敏感认的是另一套语义，它们随 Windows 作为执行目标那一步才进来），所以 `\` 不是
// 一个普通字符，是一个"在另一套语义里才是分隔符"的字符。
import { isAbsolute, join, normalize } from 'node:path'
import { identSegments } from '../identity.ts'
import type { AbsPath, AgentId, RelPath } from '../terms.ts'
import type { DenyKind } from './contract.ts'

/** 一个路径段：非空 · 不含分隔符与空字节 · 不是 `.` 或 `..`。 */
export function isSegment(raw: string): boolean {
  return (
    raw.length > 0 &&
    raw !== '.' &&
    raw !== '..' &&
    !raw.includes('/') &&
    !raw.includes('\\') &&
    !raw.includes('\0')
  )
}

/** 视图内的路径：相对 · `/` 分段 · 段段合法。**空串是视图的根**（`list ''` 就是列根）。 */
export function isRelPath(raw: string): boolean {
  if (raw === '') return true
  if (isAbsolute(raw)) return false
  return raw.split('/').every(isSegment)
}

export function assertRelPath(raw: string): RelPath {
  if (!isRelPath(raw)) throw new Error(`不是视图内的路径：${JSON.stringify(raw)}`)
  return raw
}

/**
 * 一个根：绝对 · 已经规整过。规整过 = 没有结尾的 `/` · 没有 `.`／`..` 段 · 没有重复的 `/`。
 *
 * 两道判断是必要的：`normalize` 消得掉 `.`／`..`／重复的 `/`，但**保留结尾的那一个 `/`**
 * （实测 `normalize('/a/b/')` 还是 `'/a/b/'`），所以它由第二道单独判。
 * 让 `/a/b` 与 `/a/b/` 同时是"根"，就是让同一棵树有两个坐标。
 */
export function assertRoot(root: AbsPath): AbsPath {
  if (!isAbsolute(root) || root.includes('\0')) {
    throw new Error(`落点要是一个绝对路径：${JSON.stringify(root)}`)
  }
  if (root.length > 1 && root.endsWith('/')) {
    throw new Error(`落点不能带结尾的 /：${JSON.stringify(root)}`)
  }
  if (normalize(root) !== root) {
    throw new Error(`落点要是一个规整过的绝对路径：${JSON.stringify(root)}`)
  }
  return root
}

/**
 * 原始输入 → 视图内的路径。`cwd` 是当前目录，`.` 原地不动，`..` 往上走一级，走出根就是越界。
 *
 * 宽容只有两处，都对着人在 shell 里的写法：打头的 `./` 与结尾的 `/`。**空段不宽容**：
 * `a//b` 不是两种写法，是写错了。名字里的空格是真名字的一部分——这里不 `trim`。
 * 空串与 `.` 都读成 `cwd`（"就在这儿"）。
 */
export type Parsed =
  | { readonly ok: true; readonly rel: RelPath }
  | { readonly ok: false; readonly kind: DenyKind; readonly detail: string }

export function resolveRaw(raw: string, cwd: RelPath): Parsed {
  const base = assertRelPath(cwd)
  if (raw.startsWith('/')) return { ok: false, kind: 'absolute', detail: '它以 / 开头' }
  let text = raw
  while (text.startsWith('./')) text = text.slice(2)
  while (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1)
  if (text === '' || text === '.') return { ok: true, rel: base }
  const segs = base === '' ? [] : base.split('/')
  for (const s of text.split('/')) {
    if (s === '') return { ok: false, kind: 'not-a-path', detail: '里面有一个空段' }
    if (s === '.') continue
    if (s === '..') {
      if (segs.length === 0) return { ok: false, kind: 'escape', detail: '它走到了视图的根之上' }
      segs.pop()
      continue
    }
    if (s.includes('\\')) return { ok: false, kind: 'not-a-path', detail: '里面有一个反斜杠' }
    if (s.includes('\0')) return { ok: false, kind: 'not-a-path', detail: '里面有一个空字节' }
    segs.push(s)
  }
  return { ok: true, rel: segs.join('/') }
}

/** 物理落点 = 根 + 视图内的路径。**两样都判**：根要绝对且规整，路径要是 `RelPath`。 */
export function toPhysical(root: AbsPath, rel: RelPath): AbsPath {
  const r = assertRoot(root)
  const p = assertRelPath(rel)
  return p === '' ? r : join(r, p)
}

/**
 * 拆：一个物理坐标在不在这个根下面。在 → 相对的那一段（根自身给 `''`）；不在，或者拆出来
 * 的不是一条视图内的路径（比如多一个结尾 `/`）→ `null`。
 */
export function underRoot(root: AbsPath, abs: AbsPath): RelPath | null {
  const r = assertRoot(root)
  if (abs === r) return ''
  if (!abs.startsWith(r + '/')) return null
  const rel = abs.slice(r.length + 1)
  return isRelPath(rel) ? rel : null
}

/**
 * 这个 agent 那一套物化的根：`<realRoot>/.fugue/mat/<agent>/`（架构 § 8.4）。
 *
 * **名字按段展开**（`agent/r1/1` → `mat/agent/r1/1/`）：它与 `log/<writer>.jsonl` 同一层、
 * 同一个名字（§ 9.2 的布局），所以"身份名同时是一条路径"这条规矩由 `identity.ts` 一处说了算，
 * 这里只把段拼起来。
 */
export function matRoot(realRoot: AbsPath, a: AgentId): AbsPath {
  return join(assertRoot(realRoot), '.fugue', 'mat', ...identSegments(a, 'agent 标识'))
}

/**
 * 物化根下的四样，名字只写一遍。`upper` 与 `merged` 是同一份物化的两个面（架构 § 8.4），
 * `dispose` 要按这四个名字删干净（架构 § 8.5）。
 */
export const MAT_PARTS = {
  scratch: 'upper',
  merged: 'merged',
  temp: 'tmp',
  cache: 'cache',
} as const

/**
 * 物化那三样落点的拼法：**只写一遍**。
 *
 * `Roots` 的四个方法是它唯一的消费者，而有一处要的**不是 `Roots`、是坐标本身**：执行面
 * （`tools/host.ts` 那个执行根缓存）要凑出 `fork` 收的那一份形状，而它不该为此认识 `Roots`
 * 的四个方法——拼法在这里抽成纯函数，两边读同一处。`cache` 不在这里：它是 `M5` 的，`fork`
 * 不碰它（架构 § 8.6）。
 */
export function matParts(realRoot: AbsPath, a: AgentId): { upper: AbsPath; merged: AbsPath; temp: AbsPath } {
  const at = matRoot(realRoot, a)
  return {
    upper: toPhysical(at, MAT_PARTS.scratch),
    merged: toPhysical(at, MAT_PARTS.merged),
    temp: toPhysical(at, MAT_PARTS.temp),
  }
}
