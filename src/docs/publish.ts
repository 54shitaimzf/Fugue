// 保存：**整批替换**（交接单 § 3.2）与"最近一次生成"的单独归属（§ 3.3）。
//
// 三条性质，三个落点：
//
//   一 · **发布前一个字节都不动旧批次。** 新批次先写进与产物目录同级的暂存目录
//        （`<root>/.fugue/docs-stage-<token>/`），全部写完并通过校验才切换。
//   二 · **切换是两次改名**，不是一个文件一个文件换。两次改名之间进程若被杀，下一次
//        `recoverPublish` 会把旧批次改回来——"旧入口、页面、资源与清单仍对应同一个提交与
//        指纹"这条判据因此有一条可执行的退化档，而不是一句希望。
//   三 · **清单与页面同批替换**：`manifest.json` 就在批次里，与页面一起搬。当前读到的页面、
//        资源与清单永远是同一批。
//
// `last.json` 住在产物目录里，但**不属于任何一批**：失败时只写它，旧批次原样留着。
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { LastAttempt, Manifest } from './contract.ts'
import { DocsError, MANIFEST_VERSION, docsRootOf, stageRootOf } from './contract.ts'

/** 一批里的一份文件：路径相对产物目录，内容是字节（正文与页面都是 UTF-8）。 */
export interface BatchFile {
  readonly path: string
  readonly bytes: Uint8Array
}

/** 一次替换的标记：进程号加时刻（只用于临时目录名，不进任何清单）。 */
function tokenOf(): string {
  return `${process.pid}-${Date.now().toString(36)}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 写一批文件到暂存目录（路径里的父目录按需建）。 */
async function writeStage(stage: string, files: readonly BatchFile[]): Promise<void> {
  for (const f of files) {
    const abs = join(stage, f.path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, f.bytes)
  }
}

/**
 * 把一批文件发布成当前可读产物。返回产物目录。
 *
 * 失败一律抛 `DocsError('publish', …)`：这一层不吞错——"写不进去而报成功"会让下一条命令
 * 读着一份它以为是新的旧产物。
 */
export async function publishBatch(root: string, files: readonly BatchFile[]): Promise<string> {
  const docs = docsRootOf(root)
  const token = tokenOf()
  const stage = stageRootOf(root, token)
  const prev = join(root, '.fugue', `docs-prev-${token}`)
  await rm(stage, { recursive: true, force: true })
  try {
    await writeStage(stage, files)
    // 切换前先在暂存里核一遍：入口与清单都在，才值得动旧批次。
    if (!(await exists(join(stage, 'manifest.json')))) {
      throw new DocsError('publish', `暂存批次里没有 manifest.json：${stage}`)
    }
    if (!(await exists(join(stage, 'index.html')))) {
      throw new DocsError('publish', `暂存批次里没有 index.html：${stage}`)
    }
  } catch (err) {
    await rm(stage, { recursive: true, force: true })
    if (err instanceof DocsError) throw err
    throw new DocsError('publish', `写不进暂存目录：${(err as Error).message}`)
  }

  let moved = false
  try {
    if (await exists(docs)) {
      await rename(docs, prev)
      moved = true
    }
    await rename(stage, docs)
  } catch (err) {
    if (moved) {
      try {
        await rename(prev, docs)
      } catch {
        // 改不回来也留一条能查的话：prev 还在盘上，下一次 recoverPublish 会接上。
      }
    }
    await rm(stage, { recursive: true, force: true })
    throw new DocsError('publish', `切换批次失败：${(err as Error).message}`)
  }
  await rm(prev, { recursive: true, force: true })
  return docs
}

/**
 * 收上次没走完的切换。
 *
 * 三档：有 `docs-prev-*` 而产物目录不在 → 把旧批次改回来（返回那个 token）；两边都在 →
 * 删掉残留的 prev（新批次已经就位）；只有 `docs-stage-*` → 删掉（从没发布过）。
 * **它不是启动钩子**：由 `docs build` / `docs status` 在动手前各调一次，单次进程没有常驻状态。
 */
export async function recoverPublish(root: string): Promise<string | null> {
  const base = join(root, '.fugue')
  let names: string[] = []
  try {
    names = await readdir(base)
  } catch {
    return null
  }
  const prefs = names.filter((n) => n.startsWith('docs-prev-')).sort()
  const stages = names.filter((n) => n.startsWith('docs-stage-'))
  const docs = docsRootOf(root)
  let restored: string | null = null
  const docsThere = await exists(docs)
  if (!docsThere && prefs.length > 0) {
    const keep = prefs[prefs.length - 1]!
    try {
      await rename(join(base, keep), docs)
      restored = keep.slice('docs-prev-'.length)
    } catch {
      restored = null
    }
  }
  for (const p of prefs) {
    if (restored !== null && p.endsWith(restored)) continue
    await rm(join(base, p), { recursive: true, force: true })
  }
  for (const s of stages) await rm(join(base, s), { recursive: true, force: true })
  return restored
}

/** 读当前批次清单。**不在 = `null`**（还没生成过）；读不动 = 抛——那是产物损坏，不是"没生成"。 */
export async function readManifest(root: string): Promise<Manifest | null> {
  const file = join(docsRootOf(root), 'manifest.json')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new DocsError('publish', `清单读不出来：${file} —— ${(err as Error).message}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new DocsError('publish', `清单不是一份完整的 JSON：${file} —— ${(err as Error).message}`)
  }
  const m = raw as Partial<Manifest>
  if (typeof m !== 'object' || m === null || typeof m.fingerprint !== 'string' || !Array.isArray(m.pages)) {
    throw new DocsError('publish', `清单缺了关键几栏（fingerprint · pages）：${file}`)
  }
  if (m.version !== MANIFEST_VERSION) {
    throw new DocsError(
      'publish',
      `清单是第 ${String(m.version)} 版，这一版读到的是第 ${MANIFEST_VERSION} 版——重新生成一次（fugue docs build）`,
    )
  }
  return raw as Manifest
}

/** 最近一次生成尝试。**不在 = `null`**（还没试过）。 */
export async function readLast(root: string): Promise<LastAttempt | null> {
  const file = join(docsRootOf(root), 'last.json')
  try {
    const text = await readFile(file, 'utf8')
    const raw = JSON.parse(text) as LastAttempt
    return typeof raw.ok === 'boolean' ? raw : null
  } catch {
    return null
  }
}

/** 记一次尝试的结果。**失败也写**：它记的是"最近一次试了什么、为什么没成"。 */
export async function writeLast(root: string, attempt: LastAttempt): Promise<void> {
  const dir = docsRootOf(root)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'last.json'), JSON.stringify(attempt, null, 2) + '\n')
  } catch (err) {
    throw new DocsError('publish', `最近一次生成的结果写不进去：${join(dir, 'last.json')} —— ${(err as Error).message}`)
  }
}

/** 一批文件的指纹：路径 + sha256 + 字节数。**清单里 `files` 那一栏的来源**。 */
export function digestOf(files: readonly BatchFile[]): { path: string; sha: string; bytes: number }[] {
  return files.map((f) => ({
    path: f.path,
    sha: createHash('sha256').update(f.bytes).digest('hex'),
    bytes: f.bytes.length,
  }))
}

/**
 * 批次完整性：清单里那几条文件是不是真在、是不是还是那一份。
 *
 * 返回不一致的路径（空数组 = 完好）。它让"当前产物"不只看指纹——磁盘被手改、文件被删，
 * 也是"这一批不再可信"，而状态要说得出来。
 */
export async function batchIntegrity(root: string, manifest: Manifest): Promise<string[]> {
  const docs = docsRootOf(root)
  const bad: string[] = []
  for (const f of manifest.files) {
    try {
      const bytes = await readFile(join(docs, f.path))
      const sha = createHash('sha256').update(bytes).digest('hex')
      if (sha !== f.sha || bytes.length !== f.bytes) bad.push(f.path)
    } catch {
      bad.push(f.path)
    }
  }
  return bad
}
