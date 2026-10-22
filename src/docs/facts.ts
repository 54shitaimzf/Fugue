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
import type { DocsPlan, SourceFact, TreeFacts } from './contract.ts'
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

/** 读提交里的 `package.json` 版本号。**读不到就是 `null`**——不编一个版本出来。 */
async function versionAt(truth: Truth, commit: CommitId): Promise<string | null> {
  const bytes = await truth.readAt(commit, 'package.json' as RelPath)
  if (bytes === null) return null
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown }
    return typeof v.version === 'string' && v.version !== '' ? v.version : null
  } catch {
    return null
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
  return {
    commit: String(commit),
    commitShort: String(commit).slice(0, 12),
    version: await versionAt(truth, commit),
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
  readonly text: string
  readonly bytes: number
  readonly truncated: boolean
}

/**
 * 从提交里取一份摘录（模型点名要读的那几份）。
 *
 * **三道上界**：单份 `limit` · 二进制跳过 · 不存在返回 `null`。返回 `truncated` 是为了让
 * 模型知道"这不是全文"——拿半份当全文写结论，比读不到更坏。
 */
export async function excerptAt(
  truth: Truth,
  commit: CommitId,
  path: string,
  limit: number,
): Promise<Excerpt | null> {
  const bytes = await truth.readAt(commit, path as RelPath)
  if (bytes === null) return null
  if (looksBinary(bytes)) return null
  const text = new TextDecoder().decode(bytes)
  const truncated = text.length > limit
  return {
    path,
    text: truncated ? `${text.slice(0, limit)}\n…（这份还有 ${text.length - limit} 个字符没贴；不要把它当全文）` : text,
    bytes: bytes.length,
    truncated,
  }
}
