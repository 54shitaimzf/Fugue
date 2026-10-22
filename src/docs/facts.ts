// 事实：**提交 C 的完整树**（交接单 § 2.4 · 架构 § 9.9 的"状态源"）。
//
// 三条边界，每一条都让"哪一版的事实"这个问题只有一个答案：
//
//   一 · **读的是提交，不是盘上**。`commit` 是调用方钉住的那一个（收口时是刚写回的提交，
//        手动 `--at` 时是指定的那一个）——盘上正在编辑的字节不是任何一版的事实。
//   二 · **完整树，不是本轮变化**。本轮改了什么是线索，树里现在有什么才是正文的依据；
//        这一份因此把整棵树的路径表带回来（模型据此提出要读哪几份）。
//   三 · **缺了就说缺**。来源在 C 里找不到时进 `missing`，由调用方报出"是哪一份、哪一条
//        路径"——不拿空正文顶上（那会让一次生成看起来成功）。
//
// 这一份不认识模型、不认识配置的形状：它收一份已经核过的计划（`DocsPlan`），出事实。
import type { Truth } from '../truth/contract.ts'
import type { CommitId, RelPath } from '../terms.ts'
import { createHash } from 'node:crypto'
import type { DocsPlan, FileRange, SourceFact, TreeFacts } from './contract.ts'
import { DocsError } from './contract.ts'

/** 整棵树的路径表与两个数。 */
export interface TreeWalk {
  /** 文件路径（字典序）；目录不在里面。 */
  readonly paths: readonly string[]
  readonly files: number
  readonly topDirs: readonly { readonly name: string; readonly files: number }[]
}

/**
 * 从提交里走一遍完整树。
 *
 * 只走目录条目、只数文件：`symlink` 与 `gitlink` 不是正文的来源，但它们在树里存在，所以
 * 路径表照收（模型可能引用它们，读者可能去找）——"文件数"只数 `file` 这一类，两者分得开。
 */
export async function walkTree(truth: Truth, commit: CommitId): Promise<TreeWalk> {
  const paths: string[] = []
  let files = 0
  const dirFiles = new Map<string, number>()

  const walk = async (dir: string): Promise<void> => {
    const entries = await truth.listAt(commit, dir as RelPath)
    for (const e of entries) {
      const p = dir === '' ? e.name : `${dir}/${e.name}`
      if (e.kind === 'dir') {
        await walk(p)
        continue
      }
      paths.push(p)
      if (e.kind === 'file') {
        files += 1
        const slash = p.indexOf('/')
        if (slash > 0) {
          const top = p.slice(0, slash)
          dirFiles.set(top, (dirFiles.get(top) ?? 0) + 1)
        }
      }
    }
  }
  await walk('')
  paths.sort()
  const topDirs = [...dirFiles.entries()]
    .map(([name, n]) => ({ name, files: n }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { paths, files, topDirs }
}

/** 一段字节的 sha256（十六进制）。宿主那一半的"逐字节可复现"用它量。 */
export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 读提交里的 `package.json` 的版本号与项目名。**读不到就是 `null`**——不编一个出来。 */
async function packageAt(truth: Truth, commit: CommitId): Promise<{ version: string | null; name: string | null }> {
  const bytes = await truth.readAt(commit, 'package.json' as RelPath)
  if (bytes === null) return { version: null, name: null }
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown; name?: unknown }
    return {
      version: typeof v.version === 'string' && v.version !== '' ? v.version : null,
      name: typeof v.name === 'string' && v.name !== '' ? v.name : null,
    }
  } catch {
    return { version: null, name: null }
  }
}

/** 一份来源在 C 里的事实；不在（或不是文件）就是 `null`。 */
async function sourceAt(truth: Truth, commit: CommitId, id: string, source: string): Promise<SourceFact | null> {
  const meta = await truth.statAt(commit, source as RelPath)
  if (meta === null || meta.kind !== 'file') return null
  return { id, source, sha: String(meta.id), bytes: meta.size }
}

/**
 * 提交 C 的事实：版本 · 提交 · 文件数 · 顶层目录 · 每份来源的 blob · 缺失的来源 · 路径表。
 *
 * **走两遍树是有意的**：`walkTree` 只数形状，来源那几份用 `statAt` 单点取（它们的 sha 要
 * 精确到 blob，而不是从路径表再推一遍）。两遍都很便宜——文档不是热路径。
 */
export async function treeFactsOf(truth: Truth, commit: CommitId, plan: DocsPlan): Promise<TreeFacts> {
  const walk = await walkTree(truth, commit)
  const sources: SourceFact[] = []
  const missing: { id: string; source: string }[] = []
  for (const p of plan.pages) {
    const fact = await sourceAt(truth, commit, p.id, p.source)
    if (fact === null) missing.push({ id: p.id, source: p.source })
    else sources.push(fact)
  }
  const pkg = await packageAt(truth, commit)
  return {
    commit: String(commit),
    commitShort: String(commit).slice(0, 12),
    version: pkg.version,
    name: pkg.name,
    files: walk.files,
    topDirs: walk.topDirs,
    sources,
    missing,
    paths: walk.paths,
  }
}

/** 一份来源的正文（utf8）。**缺失就抛**，话里带这一份的 id 与路径——那是"报出是哪一份"。 */
export async function sourceTextOf(truth: Truth, commit: CommitId, id: string, source: string): Promise<string> {
  const bytes = await truth.readAt(commit, source as RelPath)
  if (bytes === null) {
    throw new DocsError('facts', `来源缺失：文档 ${id} 的 source 指向 ${source}，而提交 ${String(commit).slice(0, 12)} 里没有这一份`)
  }
  if (looksBinary(bytes)) {
    throw new DocsError('facts', `来源不是文本：文档 ${id} 的 source ${source} 看起来是二进制（含 NUL 字节）`)
  }
  return new TextDecoder().decode(bytes)
}

/** 前 1 KiB 里出现 NUL 就当二进制。**判据是形状，不是猜内容**。 */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 1024)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

/** 一段摘录：给模型读的那一份。 */
export interface Excerpt {
  readonly path: string
  /** 贴出来的原文（多段时中间标出跳过的行）。 */
  readonly text: string
  readonly bytes: number
  /** 这份文件一共多少行 · 多少字符（截断范围的判据）。 */
  readonly lines: number
  readonly chars: number
  /** 真贴出来的行段（1 起，含两端；按行序、不重叠）。 */
  readonly shown: readonly FileRange[]
  readonly truncated: boolean
}

/** 两段行之间合并：重叠或相邻就连成一段。 */
function mergeRanges(ranges: readonly FileRange[], lines: number): FileRange[] {
  const clean = ranges
    .map((r) => ({ from: Math.max(1, Math.min(lines, Math.floor(r.from))), to: Math.max(1, Math.min(lines, Math.floor(r.to))) }))
    .filter((r) => r.to >= r.from)
    .sort((a, b) => a.from - b.from || a.to - b.to)
  const out: FileRange[] = []
  for (const r of clean) {
    const last = out[out.length - 1]
    if (last !== undefined && r.from <= last.to + 1) {
      if (r.to > last.to) out[out.length - 1] = { from: last.from, to: r.to }
      continue
    }
    out.push(r)
  }
  return out
}

/**
 * 从提交里取一份摘录（模型点名要读的那几份）。
 *
 * **两份材料**：开头一段（`limit` 个字符）与模型点名补读的行段（`ranges`）。两样合起来就是
 * 这一次真看到的内容；`shown` 把行段逐段记下来，清单里据此能说出"哪些结论只看到开头"。
 *
 * 三道上界：单份 `limit` · 二进制跳过 · 不存在返回 `null`。
 */
export async function excerptAt(
  truth: Truth,
  commit: CommitId,
  path: string,
  opts: { readonly limit: number; readonly ranges?: readonly FileRange[] },
): Promise<Excerpt | null> {
  const bytes = await truth.readAt(commit, path as RelPath)
  if (bytes === null) return null
  if (looksBinary(bytes)) return null
  const text = new TextDecoder().decode(bytes)
  const all = text.split('\n')
  const lines = all.length
  const chars = text.length
  // 开头一段：一直取到超过 limit 个字符的那一行之前。
  let headEnd = 0
  let taken = 0
  while (headEnd < lines && (headEnd === 0 || taken + all[headEnd]!.length + 1 <= opts.limit)) {
    taken += all[headEnd]!.length + 1
    headEnd += 1
  }
  const wanted: FileRange[] = [{ from: 1, to: Math.max(1, headEnd) }, ...(opts.ranges ?? [])]
  const shown = mergeRanges(wanted, lines)
  const parts: string[] = []
  let expect = 1
  for (const r of shown) {
    if (r.from > expect) parts.push(`…（跳过第 ${expect}–${r.from - 1} 行）…`)
    parts.push(all.slice(r.from - 1, r.to).join('\n'))
    expect = r.to + 1
  }
  if (expect <= lines) parts.push(`…（第 ${expect} 行到第 ${lines} 行没贴）…`)
  return {
    path,
    text: parts.join('\n'),
    bytes: bytes.length,
    lines,
    chars,
    shown,
    truncated: shown.length === 0 || shown[0]!.from > 1 || shown[shown.length - 1]!.to < lines,
  }
}
