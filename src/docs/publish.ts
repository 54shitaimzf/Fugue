// 保存：**整批替换**（交接单 § 3.2）与"最近一次生成"的单独归属（§ 3.3）。
//
// 三条性质，三个落点：
//
//   一 · **发布前一个字节都不动旧批次。** 新批次先写成一个**不可变批次目录**
//        （`<root>/.fugue/docs-batch-<指纹前 12 位>/`；名字由内容定，同内容不重写），全部写完
//        并通过校验才算数。
//   二 · **切换是一次改名，不是两次。** 公开入口 `<root>/.fugue/docs` 是一个**指向当前批次的
//        符号链接**；发布先在同级建一个临时链接，再把它改名到 `docs`——`rename` 是原子的，
//        因此**不存在"入口不存在"的窗口**（复审 R2 的那处缺口）。读者从入口读到的页面、资源
//        与清单永远是同一个完整批次（批次目录不可变）。
//   三 · **恢复不拿走退路。** `recoverPublish` 只收没被指向的批次与残留临时名；指针读不出来
//        或恢复失败时**一个批次都不删**——最后一份完整批次必须还在。
//
// `last.json` 住在 `.fugue/docs-last.json`，**不在任何一批里**：失败时只写它，旧批次原样留着；
// 它记的是"最近一次试了什么"，与"当前可读是哪一批"分开归属（交接单 § 3.3）。
//
// **老布局（`docs/` 是一个真目录）仍然读得出来**：这一版第一次发布时把旧目录整个挪到
// `docs-prev-<token>` 再上链接（那一次存在一个很窄的窗口，恢复会把它挪回来）；之后每次发布
// 都只换链接。读那一侧同时认两种形状，`docs status` 在迁移前照旧报"过期"而不是"未生成"。
import { lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { LastAttempt, Manifest } from './contract.ts'
import { DocsError, MANIFEST_VERSION, docsRootOf } from './contract.ts'

/** 一批里的一份文件：路径相对批次目录，内容是字节（正文与页面都是 UTF-8）。 */
export interface BatchFile {
  readonly path: string
  readonly bytes: Uint8Array
}

/** 批次目录名前缀：`docs-batch-<指纹前 12 位>`。 */
const BATCH_PREFIX = 'docs-batch-'
/** 临时链接名：`docs-link-<pid>-<time36>`（只在切换那一瞬间存在）。 */
const LINK_PREFIX = 'docs-link-'
/** 老布局迁移时旧目录的去处（恢复用）。 */
const PREV_PREFIX = 'docs-prev-'

/** 一次替换的标记：进程号加时刻（只用于临时名，不进任何清单）。 */
function tokenOf(): string {
  return `${process.pid}-${Date.now().toString(36)}`
}

/** 名字里的进程号（`<pid>-<time36>`）；认不出来就是 `null`。 */
function pidOf(name: string): number | null {
  const head = name.split('-')[0] ?? ''
  if (!/^\d+$/.test(head)) return null
  const n = Number(head)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** 这个进程还活着吗（`EPERM` 算活着：活着只是不归我们管）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

type Kind = 'missing' | 'link' | 'dir' | 'other'

async function kindOf(path: string): Promise<Kind> {
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink()) return 'link'
    if (st.isDirectory()) return 'dir'
    return 'other'
  } catch {
    return 'missing'
  }
}

/** 入口链接现在指向哪个批次 id；不是链接或读不出来就是 `null`。 */
async function pointerId(root: string): Promise<string | null> {
  const docs = docsRootOf(root)
  if ((await kindOf(docs)) !== 'link') return null
  let target: string
  try {
    target = await readlink(docs)
  } catch {
    return null
  }
  const name = target.split(/[\\/]/).filter(Boolean).pop() ?? ''
  return name.startsWith(BATCH_PREFIX) ? name.slice(BATCH_PREFIX.length) : null
}

/** 一个批次目录的绝对路径。 */
export function batchDirOf(root: string, id: string): string {
  return join(root, '.fugue', `${BATCH_PREFIX}${id}`)
}

/**
 * 这一批的 id：**按内容算**（清单指纹 + 每一份文件的名字与 sha）。
 *
 * 不用指纹前缀：同一份指纹两趟生成的清单里 `generatedAt` 不同，字节就不同——按内容命名才不会把
 * “同名不同字节”的批混成一批（读的人拿到的仍是同一批的页面与清单）。
 */
function batchIdOf(files: readonly BatchFile[]): string {
  const digests = digestOf(files)
    .map((f) => `${f.path}:${f.sha}:${f.bytes}`)
    .sort()
    .join('\n')
  const manifest = files.find((f) => f.path === 'manifest.json')
  let fingerprint = ''
  if (manifest !== undefined) {
    try {
      const m = JSON.parse(new TextDecoder().decode(manifest.bytes)) as { fingerprint?: unknown }
      if (typeof m.fingerprint === 'string') fingerprint = m.fingerprint
    } catch {
      // 清单不是 JSON 时只按文件内容算（发布出去的那一份仍然可复现）。
    }
  }
  return createHash('sha256').update(fingerprint).update('\n').update(digests).digest('hex').slice(0, 12)
}

/** 写完的一批是不是完整（入口与清单都在）。 */
async function completeBatch(dir: string): Promise<boolean> {
  return (await exists(join(dir, 'index.html'))) && (await exists(join(dir, 'manifest.json')))
}

/** 写一批文件到暂存目录（路径里的父目录按需建）。 */
async function writeStage(stage: string, files: readonly BatchFile[]): Promise<void> {
  for (const f of files) {
    const abs = join(stage, f.path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, f.bytes)
  }
}

/** 测试用的崩点：`FUGUE_DOCS_CRASH_AT=<点名>` 时在这一步真的杀掉自己（断言"每个崩点都可读"）。 */
function crashAt(name: string): void {
  if (process.env['FUGUE_DOCS_CRASH_AT'] !== name) return
  process.kill(process.pid, 'SIGKILL')
}

/** 把临时链接改名到入口（**原子**：要么还是旧的，要么已经是新的）。 */
async function swapPointer(root: string, linkTmp: string): Promise<void> {
  const docs = docsRootOf(root)
  const kind = await kindOf(docs)
  if (kind === 'dir') {
    // 老布局迁移：旧目录整个挪到 prev（恢复能把它挪回来），再上链接。
    await rename(docs, join(root, '.fugue', `${PREV_PREFIX}${tokenOf()}`))
  }
  await rename(linkTmp, docs)
}

/**
 * 把一批文件发布成当前可读产物。返回产物目录。
 *
 * 失败一律抛 `DocsError('publish', …)`：这一层不吞错——"写不进去而报成功"会让下一条命令
 * 读着一份它以为是新的旧产物。
 */
export async function publishBatch(root: string, files: readonly BatchFile[]): Promise<string> {
  const base = join(root, '.fugue')
  const id = batchIdOf(files)
  const token = tokenOf()
  const stage = join(base, `${BATCH_PREFIX}${id}.tmp-${token}`)
  const final = batchDirOf(root, id)
  await mkdir(base, { recursive: true })
  try {
    await writeStage(stage, files)
    // 切换前先核一遍：入口与清单都在，才值得动指针。
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
  crashAt('stage')

  // 同一份指纹的批次已经在盘上：内容逐字节相同，直接用它（不重写一个正在被读的批次）。
  try {
    if (await completeBatch(final)) await rm(stage, { recursive: true, force: true })
    else await rename(stage, final)
  } catch (err) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    throw new DocsError('publish', `批次落不下来：${(err as Error).message}`)
  }
  crashAt('batch')

  const linkTmp = join(base, `${LINK_PREFIX}${token}`)
  try {
    await symlink(`${BATCH_PREFIX}${id}`, linkTmp)
  } catch (err) {
    throw new DocsError('publish', `切换指针建不起来：${(err as Error).message}`)
  }
  crashAt('link')
  try {
    await swapPointer(root, linkTmp)
  } catch (err) {
    await rm(linkTmp, { force: true }).catch(() => undefined)
    throw new DocsError('publish', `切换批次失败：${(err as Error).message}`)
  }
  crashAt('swap')
  await collect(root)
  crashAt('cleanup')
  return docsRootOf(root)
}

/** 留下当前批次与最近一份完整批次，收掉其余没被指向的批次与残留临时名。 */
async function collect(root: string): Promise<void> {
  const base = join(root, '.fugue')
  const cur = await pointerId(root)
  // **指针读不出来就一个都不删**：最后一份完整批次不许因为一次读失败被收走。
  if (cur === null) return
  let names: string[] = []
  try {
    names = await readdir(base)
  } catch {
    return
  }
  const batches: { name: string; id: string; at: number; complete: boolean }[] = []
  for (const name of names) {
    if (!name.startsWith(BATCH_PREFIX)) continue
    const rest = name.slice(BATCH_PREFIX.length)
    if (rest.includes('.tmp-')) {
      const pid = pidOf(rest.split('.tmp-')[1] ?? '')
      if (pid !== null && pid !== process.pid && alive(pid)) continue
      await rm(join(base, name), { recursive: true, force: true }).catch(() => undefined)
      continue
    }
    const mtime = await stat(join(base, name)).then((s) => s.mtimeMs).catch(() => 0)
    batches.push({ name, id: rest, at: mtime, complete: await completeBatch(join(base, name)) })
  }
  const linked = batches.find((b) => b.id === cur)
  const others = batches
    .filter((b) => b.id !== cur && b.complete)
    .sort((a, b) => b.at - a.at)
  const keep = new Set<string>([cur])
  if (others[0] !== undefined) keep.add(others[0].id)
  // 指针指向的那一批不完整时，保留最近一份完整批次作为退路（不删它）。
  if (linked === undefined || !linked.complete) return
  for (const b of batches) {
    if (keep.has(b.id)) continue
    await rm(join(base, b.name), { recursive: true, force: true }).catch(() => undefined)
  }
  // 残留的临时链接（交换没走完的那一次）与迁移留下的旧目录：指针有效时才收。
  for (const name of names) {
    if (name.startsWith(LINK_PREFIX)) await rm(join(base, name), { force: true }).catch(() => undefined)
    if (name.startsWith(PREV_PREFIX)) {
      // **迁移时先把“最近一次”接出来**：老布局把它放在 docs/ 下，而它不属于任何一批——
      // 跟着旧目录一起删掉，下一次 status 的“最近一次”就会静默变回空。
      const oldLast = join(base, name, 'last.json')
      const newLast = lastPathOf(root)
      try {
        if (!(await exists(newLast)) && (await exists(oldLast))) await rename(oldLast, newLast)
      } catch {
        // 接不出来也不阻塞切换：readLast 仍认老位置。
      }
      await rm(join(base, name), { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

/**
 * 收上次没走完的那一次切换。**它不改当前批次的字节，只在入口缺失时把指针接回去。**
 *
 * 四档：入口缺失而迁移旧目录在 → 把它挪回入口（旧批次仍是那一份）；入口缺失或悬空而有完整
 * 批次 → 把指针接到最近那一份；入口有效 → 只收残留临时名。**恢复失败时一个批次都不删**。
 */
export async function recoverPublish(root: string): Promise<string | null> {
  const base = join(root, '.fugue')
  const docs = docsRootOf(root)
  let names: string[] = []
  try {
    names = await readdir(base)
  } catch {
    return null
  }
  const kind = await kindOf(docs)
  const linked = kind === 'link' ? await pointerId(root) : null
  const pointerOk = linked !== null && (await completeBatch(batchDirOf(root, linked)))
  let restored: string | null = null

  if (kind === 'missing' || (kind === 'link' && !pointerOk)) {
    // 一 · 迁移留下的旧目录：优先挪回入口（读者看到的是原来那一份完整旧批）。
    const prevs = names.filter((n) => n.startsWith(PREV_PREFIX))
    if (prevs.length > 0 && kind === 'missing') {
      const withTime = await Promise.all(prevs.map(async (p) => ({ p, t: (await stat(join(base, p)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })))
      withTime.sort((a, b) => b.t - a.t)
      try {
        await rename(join(base, withTime[0]!.p), docs)
        restored = 'legacy'
        names = names.filter((n) => n !== withTime[0]!.p)
      } catch {
        // 挪不回去就什么都不删（下面直接返回）。
        return null
      }
    } else {
      const batches: { id: string; at: number }[] = []
      for (const name of names) {
        if (!name.startsWith(BATCH_PREFIX) || name.includes('.tmp-')) continue
        const id = name.slice(BATCH_PREFIX.length)
        if (!(await completeBatch(join(base, name)))) continue
        batches.push({ id, at: await stat(join(base, name)).then((s) => s.mtimeMs).catch(() => 0) })
      }
      batches.sort((a, b) => b.at - a.at)
      const newest = batches[0]
      if (newest === undefined) return null
      const tmp = join(base, `${LINK_PREFIX}${tokenOf()}`)
      try {
        await symlink(`${BATCH_PREFIX}${newest.id}`, tmp)
        await rename(tmp, docs)
        restored = newest.id
      } catch {
        await rm(tmp, { force: true }).catch(() => undefined)
        return null
      }
    }
  }

  // 收残留：死的暂存目录与临时链接（**不删任何完整批次**——那是下一次发布 `collect` 的事）。
  for (const name of names) {
    if (name.startsWith(BATCH_PREFIX) && name.includes('.tmp-')) {
      const pid = pidOf(name.split('.tmp-')[1] ?? '')
      if (pid !== null && pid !== process.pid && alive(pid)) continue
      await rm(join(base, name), { recursive: true, force: true }).catch(() => undefined)
    }
    if (name.startsWith(LINK_PREFIX)) await rm(join(base, name), { force: true }).catch(() => undefined)
  }
  return restored
}

/** 当前可读批次所在目录：入口链接 → 批次目录；老布局就是入口自己。 */
async function currentDirOf(root: string): Promise<string | null> {
  const docs = docsRootOf(root)
  const kind = await kindOf(docs)
  if (kind === 'dir') return docs
  if (kind !== 'link') return null
  const id = await pointerId(root)
  return id === null ? null : batchDirOf(root, id)
}

/** 读当前批次清单。**不在 = `null`**（还没生成过）；读不动 = 抛——那是产物损坏，不是"没生成"。 */
export async function readManifest(root: string): Promise<Manifest | null> {
  const dir = await currentDirOf(root)
  if (dir === null) return null
  const file = join(dir, 'manifest.json')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // 入口在而清单不在：指针指着一批不完整的东西，不是"没生成"。
      if ((await kindOf(docsRootOf(root))) === 'link') {
        throw new DocsError('publish', `入口指向的批次里没有清单：${file}`)
      }
      return null
    }
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

/** 最近一次生成尝试的位置：**与任何一批都无关**（`<root>/.fugue/docs-last.json`）。 */
function lastPathOf(root: string): string {
  return join(root, '.fugue', 'docs-last.json')
}

/** 最近一次生成尝试。**不在 = `null`**（还没试过）；老布局的 `docs/last.json` 也认。 */
export async function readLast(root: string): Promise<LastAttempt | null> {
  for (const file of [lastPathOf(root), join(docsRootOf(root), 'last.json')]) {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as LastAttempt
      if (typeof raw.ok === 'boolean') return raw
    } catch {
      continue
    }
  }
  return null
}

/** 记一次尝试的结果。**失败也写**：它记的是“最近一次试了什么、为什么没成”。
 *
 * **原子写**：先写同目录的临时名再改名。直接覆盖时，进程死在半途会留下一段半 JSON，
 * 下一次读到的是“没有记录”——“最近一次”那一栏就静默退回空，比报一个旧值更坏。
 */
export async function writeLast(root: string, attempt: LastAttempt): Promise<void> {
  const base = join(root, '.fugue')
  const file = lastPathOf(root)
  const tmp = join(base, `docs-last.json.tmp-${tokenOf()}`)
  try {
    await mkdir(base, { recursive: true })
    await writeFile(tmp, JSON.stringify(attempt, null, 2) + '\n')
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw new DocsError('publish', `最近一次生成的结果写不进去：${file} —— ${(err as Error).message}`)
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
  const dir = await currentDirOf(root)
  if (dir === null) return manifest.files.map((f) => f.path)
  const bad: string[] = []
  for (const f of manifest.files) {
    try {
      const bytes = await readFile(join(dir, f.path))
      const sha = createHash('sha256').update(bytes).digest('hex')
      if (sha !== f.sha || bytes.length !== f.bytes) bad.push(f.path)
    } catch {
      bad.push(f.path)
    }
  }
  return bad
}
