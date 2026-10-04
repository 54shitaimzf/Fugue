// 索引在盘上的那一层：住哪儿 · 怎么落 · 读不回来怎么办。
//
// 出处：ROADMAP § 4 的「索引落盘格式」那一行（`.fugue/idx/`）· § 9 的「索引与真源解耦」那一格
// （派生物，损坏即重建、miss 回扫描）· TARGETS `T16` ②。容器在 `format.ts`，载荷在 `trigram.ts`，
// 这一份只管文件系统与退化档。
//
// 五条口径：
//
//   一 · **索引是派生体，伤不到真源。** 它只从 `BlobSource` 读真源字节，只写
//        `<realRoot>/.fugue/idx/` 一个目录；不碰视图、不碰日志、不碰工作树。所以它死了系统只是
//        **变慢**：`readIndex` 给 `null`，调用方照旧回扫描。
//   二 · **认不出来就是损坏。** 缺席 · 读不动 · 版本认不出 · 节缺了 · 摘要对不上 · 形状不对
//        ——六个出口合成同一个答案 `null`。分开报对今天没有接收方（用户面与模型面都是零变化），
//        于是不分开。
//   三 · **落盘是"先写临时名再改名"。** 崩在半途只会留下一份谁也不读的临时文件，下一次打开
//        仍然是"缺席 → 重建"。这道写法与 `view/snapshot.ts` 的 `writeSnapshot` 同一套；
//        **不额外 fsync**——它是派生体，没落稳的字节会被摘要挡住，退路本来就是重建。
//   四 · **开一份索引只读头部与节表，节体按需读。** 这是"固定开销瘦身"那条路的读法那一半：
//        打开的成本与工件大小无关（几十到几百字节），**拿到选择性只要再读字典那一节**——
//        postings 与 blob 表一个字节都不碰。`bytesRead` 记的就是这笔账，`store.test.ts` ⑤ 量它。
//   五 · **两条读法分工。** `readIndex` / `openOrRebuild` 是**给退化档用**的：三节都验一遍，
//        任何一处坏了都给 `null`（调用方据此回扫描或重建）。`openIndexAt` 是给"要那个粒度"的
//        调用方用的：按需读，读到的节当场核摘要，核不过**抛**——它不会把坏字节当成好字节答出去。
//   六 · **盘上那一份必须说的是这一组 blob。** 工件的身份就是 `blobs` 那一节自己（**不另存一份
//        摘要**：存一份推得出来的东西，就是给漂移留一个不报错的位置，而且候选那条路本来就要读
//        这一节）。`openOrRebuild` 拿源给的名单与它比对，对不上就重建。少这一问，"读得回来但是
//        另一组"会被当成命中——旧表里没有新 blob 的顺序号，新内容一个候选都拿不到，而候选少了
//        就是漏报。`readIndex` 只管"读得回来"，要身份那一问走 `openOrRebuild`。
//   七 · **构建有上限，越过去是"这一组建不出来"，不是一次失败。** 四条上限（真源字节 · blob 数 ·
//        三字组数 · 工件字节）都在越过的**当场**止住，报出是哪一条（数字与来处都在 `budget.ts`
//        一处）。`rebuildIndex` 把上限抛出来（明着要建就给明着的错），`openOrRebuild` 把它收成
//        一态交回——调用方据此记住不再重建，而不是每问一次就重来一遍。库这一层不留记忆。
import { mkdir, open, rename, stat, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CODEC,
  HEADER_BYTES,
  SECTION,
  SECTION_ENTRY_BYTES,
  decodeIndexHeader,
  digestOf,
  indexHeadBytes,
  sameBytes,
} from './format.ts'
import type { SectionRef } from './format.ts'
import {
  GRAM_RECORD_BYTES,
  buildTrigram,
  decodeTrigram,
  encodedBytesOf,
  encodeTrigram,
  findGram,
  indexOfParts,
} from './trigram.ts'
import type { BlobBytes, Trigram, TrigramIndex } from './trigram.ts'
import { INDEX_LIMITS, IndexBudgetExceeded } from './budget.ts'
import type { IndexBudget, IndexBudgetLimits } from './budget.ts'
import { kindOf } from '../truth/truth.ts'
import { snapshotOf } from '../view/snapshot.ts'
import type { View } from '../view/contract.ts'
import type { Truth } from '../truth/contract.ts'
import type { BlobId } from '../terms.ts'

/**
 * 分片的名字。**今天只有这一份**：`.fugue/idx/` 下一个文件就是整份索引。
 *
 * 判据是读数不是形状——今天的语料与工件都是兆字节量级，切分的代价（多一份清单、多一处一致性）
 * 换不来什么。要切的那一天，切法不必动格式：`format.ts` 的节表已经是带类型的，而"几份分片、
 * 各叫什么"是命名那一层的事。验收句里的「损坏一份分片」按这一个文件来演示。
 */
export const IDX_FILE_NAME = 'trigram.idx'

/** 索引住哪儿：`<realRoot>/.fugue/idx/`（与 `log/` · `mat/` · `snap/` 同一层）。 */
export function idxDir(root: string): string {
  return join(root, '.fugue', 'idx')
}

export function idxFileOf(root: string): string {
  return join(idxDir(root), IDX_FILE_NAME)
}

/**
 * 建索引要的那两样：**要索引哪些 blob**，以及**它们的字节**。
 *
 * 它比 `Truth` 窄（只要 `getBlob` 那一条读），也比 `View` 窄（只要一份 id 集合）——窄口让纯
 * 机制的测试不必起一份真视图与真仓库，也让"真源是 blob"这句话落在签名上：这一份拿不到任何
 * 写得进去的东西。
 */
export interface BlobSource {
  /** 要索引的 blob id。可以带重复（去重在构建那一侧做）；顺序不影响结果。 */
  ids(): Promise<readonly BlobId[]>
  /** 真源字节。**索引不自己存原文**，读的一侧永远回到这里。 */
  read(id: BlobId): Promise<Uint8Array>
}

/**
 * 从一份视图与它的真源造 `BlobSource`：**走一遍树拿 id，一个字节的原文都不读**（`snapshotOf`
 * 的 id 来自 `list` 的行与上层条目自己带的 id）。
 *
 * 收 `file` 与 `symlink` 两类：它们在 git 里指的都是一个 blob。`dir` 没有对象可读；`gitlink`
 * 指的是**另一个仓库里的一个提交**——把它当 blob 交给 `getBlob` 是错的，直接不收。
 */
export async function sourceOfView(view: View, truth: Truth): Promise<BlobSource> {
  const entries = await snapshotOf(view)
  const ids: BlobId[] = []
  for (const e of entries) {
    const kind = kindOf(e.mode)
    if (kind === 'file' || kind === 'symlink') ids.push(e.id as BlobId)
  }
  return {
    ids: async () => ids,
    read: (id) => truth.getBlob(id),
  }
}

/** 一次全量构建的读数。**都不是判据，是账**：0.3.2 的增量就是与这一份比出来的。 */
export interface BuildReading {
  /** 编出来的整份工件（还没落盘）。 */
  readonly bytes: Uint8Array
  readonly blobCount: number
  readonly gramCount: number
  readonly sourceBytes: number
  /** 收进来的这些 blob 一共解出多少个 UTF-16 单元——**三字组量的是它，不是字节数**。 */
  readonly textUnits: number
  readonly artifactBytes: number
  readonly postingsBytes: number
  readonly dictBytes: number
}

/**
 * 全量构建：把 `source` 给的那一组 blob 读一遍，编一份工件。**不落盘**（落盘是 `writeIndex`）。
 *
 * `limits` 是那道闸（缺省就是出货那一套）。收进来的两条账**随读随判**：每多收一份就是多留一份
 * 字节在内存里，等收完再判等于先把它全吃下去。工件字节那一关判在分配之前（`encodedBytesOf`）。
 */
export async function buildFrom(source: BlobSource, limits: IndexBudgetLimits = INDEX_LIMITS): Promise<BuildReading> {
  const ids = await source.ids()
  const seen = new Set<BlobId>()
  const blobs: BlobBytes[] = []
  let sourceBytes = 0
  for (const id of ids) {
    if (seen.has(id)) continue
    if (seen.size >= limits.blobs) {
      throw new IndexBudgetExceeded('blobs', `blob 数超过这一档的上限：${seen.size + 1} > ${limits.blobs}`)
    }
    const bytes = await source.read(id)
    sourceBytes += bytes.byteLength
    if (sourceBytes > limits.sourceBytes) {
      throw new IndexBudgetExceeded('source-bytes', `真源字节超过这一档的上限：${sourceBytes} > ${limits.sourceBytes}`)
    }
    seen.add(id)
    blobs.push({ id, bytes })
  }
  const parts = buildTrigram(blobs, limits.grams)
  const planned = encodedBytesOf(parts)
  if (planned > limits.artifactBytes) {
    throw new IndexBudgetExceeded('artifact-bytes', `工件字节超过这一档的上限：${planned} > ${limits.artifactBytes}`)
  }
  const bytes = encodeTrigram(parts)
  const header = decodeIndexHeader(bytes)
  if (header === null) throw new Error('刚编出来的索引读不回来——编码器与解码器对不上')
  const sizes = new Map(header.sections.map((s) => [s.kind, s.length]))
  return {
    bytes,
    blobCount: parts.blobIds.length,
    gramCount: parts.grams.length,
    sourceBytes,
    textUnits: parts.textUnits,
    artifactBytes: bytes.byteLength,
    postingsBytes: sizes.get(SECTION.postings) ?? 0,
    dictBytes: sizes.get(SECTION.dict) ?? 0,
  }
}

/** 落盘。**先写临时名再改名**（口径三）：读者看到的要么是上一份，要么是这一份。 */
export async function writeIndex(root: string, bytes: Uint8Array): Promise<boolean> {
  const dir = idxDir(root)
  const tmp = join(dir, `${IDX_FILE_NAME}.tmp-${process.pid}`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(tmp, bytes)
    await rename(tmp, idxFileOf(root))
    return true
  } catch {
    return false
  }
}

/** 按需读的那一份句柄：节体读回来就核摘要、留着，读不动或核不过**抛**。 */
export interface IndexHandle {
  /** 这份索引里有几个三字组。**从节表那一栏直接算出来，一个节体都不读。** */
  readonly gramCount: number
  /** 到此为止从盘上读了多少字节（读数，不进判据）。 */
  readonly bytesRead: number
  /** 这一问只要字典那一节（口径四）。 */
  countOf(gram: Trigram): Promise<number>
  /** 这一问要字典与 postings 两节；改名由 blob 表那一节回。 */
  candidatesOf(gram: Trigram): Promise<readonly BlobId[]>
  blobIds(): Promise<readonly BlobId[]>
  /** 三节都取回来，收成一个纯值——"读一份、关掉"那条路走它。 */
  toValue(): Promise<TrigramIndex>
  close(): Promise<void>
}

/**
 * 打开一份索引文件。**开的时候只读头部与节表**（十六字节加节表），节体按需再读。
 *
 * 开不成的四种（缺席 · 太短 · 节数放不下 · 版本认不出 / 节表形状不对）给 `null`，句柄一定关掉；
 * 开成之后某一节坏掉由那一次调用**抛**（口径五）。
 */
export async function openIndexAt(path: string): Promise<IndexHandle | null> {
  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch {
    return null
  }
  let bytesRead = 0
  const opened = await (async (): Promise<{ refs: Map<number, SectionRef> } | null> => {
    const size = (await handle.stat()).size
    if (size < HEADER_BYTES) return null
    const first = new Uint8Array(HEADER_BYTES)
    bytesRead += (await handle.read(first, 0, HEADER_BYTES, 0)).bytesRead
    // **先按整份文件的大小挡住疯长的节数**，再按它分配：一个坏掉的节数不该换来一次巨额分配。
    const count = new DataView(first.buffer, first.byteOffset, first.byteLength).getUint32(12, true)
    if (count === 0 || indexHeadBytes(count) > size) return null
    const whole = new Uint8Array(indexHeadBytes(count))
    whole.set(first, 0)
    const got = await handle.read(whole, HEADER_BYTES, count * SECTION_ENTRY_BYTES, HEADER_BYTES)
    bytesRead += got.bytesRead
    if (got.bytesRead < count * SECTION_ENTRY_BYTES) return null
    const header = decodeIndexHeader(whole, size)
    if (header === null) return null
    return { refs: new Map(header.sections.map((s) => [s.kind, s])) }
  })().catch(() => null)
  if (opened === null) {
    await handle.close().catch(() => undefined)
    return null
  }

  const bodies = new Map<number, Uint8Array>()
  /** 取一节：读回来 → 核摘要 → 留着。**读多少核多少**，其余节一个字节不碰。 */
  const need = async (kind: number): Promise<Uint8Array> => {
    const hit = bodies.get(kind)
    if (hit !== undefined) return hit
    const ref = opened.refs.get(kind)
    if (ref === undefined || ref.codec !== CODEC.raw) throw new Error(`索引缺了这一节，或它的编码认不出：kind ${kind}`)
    const body = new Uint8Array(ref.length)
    const got = await handle.read(body, 0, ref.length, ref.offset)
    bytesRead += got.bytesRead
    if (got.bytesRead < ref.length) throw new Error(`索引的这一节读不全：kind ${kind}`)
    if (!sameBytes(digestOf(body), ref.digest)) throw new Error(`索引的这一节摘要对不上：kind ${kind}`)
    bodies.set(kind, body)
    return body
  }

  const postingsBytes = opened.refs.get(SECTION.postings)?.length ?? 0
  const dictBytes = opened.refs.get(SECTION.dict)?.length ?? 0
  let value: TrigramIndex | null = null
  const asValue = async (): Promise<TrigramIndex> => {
    if (value !== null) return value
    const built = indexOfParts(await need(SECTION.blobs), await need(SECTION.dict), await need(SECTION.postings))
    if (built === null) throw new Error('索引的三节形状对不上')
    value = built
    return built
  }

  return {
    gramCount: dictBytes / GRAM_RECORD_BYTES,
    get bytesRead(): number {
      return bytesRead
    },
    countOf: async (gram) => {
      // 三节已经在手里就走纯值那一份（一处实现）；否则**只把字典那一节取回来**。
      if (value !== null) return value.countOf(gram)
      const entry = findGram(await need(SECTION.dict), gram, postingsBytes)
      return entry === null ? 0 : entry.count
    },
    candidatesOf: async (gram) => (await asValue()).candidatesOf(gram),
    blobIds: async () => (await asValue()).blobIds,
    toValue: asValue,
    close: () => handle.close(),
  }
}

/**
 * 这一份索引说的是不是这一组 blob。**顺序与重复都不算差别**（`sourceOfView` 本来就可能给重复，
 * 走树的顺序也不必与 id 升序一致）；比的只是"同一组 id"。
 *
 * `index.blobIds` 按约定是升序去重的（构建那一侧保证），所以这边只把交进来的名单收一遍。
 * 对不上就交给调用方重建——**偏向重建那一侧是安全的**。
 */
export function sameBlobSet(index: TrigramIndex, ids: readonly BlobId[]): boolean {
  const want = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const has = index.blobIds
  if (want.length !== has.length) return false
  for (let i = 0; i < want.length; i++) if (want[i] !== has[i]) return false
  return true
}

/**
 * 图省事的那一条：读一份、三节都验一遍、关掉、把索引值交出去。**任何一处坏了都是 `null`。**
 *
 * 给退化档用（口径五）：调用方拿到 `null` 就回扫描或重建，不需要分辨是哪一种坏。
 * **它不问身份**（口径六）："读得回来但说的是另一组 blob"在这里读得回来，要那一问走
 * `openOrRebuild`。
 */
export async function readIndex(root: string): Promise<TrigramIndex | null> {
  const handle = await openIndexAt(idxFileOf(root))
  if (handle === null) return null
  try {
    return await handle.toValue()
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** 全量重建并落盘。**落盘失败不算失败**：内存里那一份照旧能用（`wrote: false` 是读数）。 */
export async function rebuildIndex(
  root: string,
  source: BlobSource,
  limits: IndexBudgetLimits = INDEX_LIMITS,
): Promise<{ index: TrigramIndex; build: BuildReading; wrote: boolean }> {
  const build = await buildFrom(source, limits)
  const wrote = await writeIndex(root, build.bytes)
  const index = decodeTrigram(build.bytes)
  if (index === null) throw new Error('刚编出来的索引读不回来——编码器与解码器对不上')
  return { index, build, wrote }
}

/**
 * 读得到就用，读不到就重建。**这是"miss · 损坏 · 认不出版本 → 重建"那条退化档的入口**：
 * 三个状态在这里合成同一条路，调用方不必分开判。
 *
 * **回扫描那一侧不在这里**：索引只出候选，真正的答案永远从真源字节里验出来（0.3.3 的验证那一
 * 格）。这一份能保证的是"拿不到索引时不抛"——调用方拿到 `null`（`readIndex`）就照旧走全扫。
 */
/**
 * `openOrRebuild` 的两态：建出来了（`rebuilt` 说这一趟是不是新建的），或者**这一组输入建不出来**
 * （`over` 指得出是哪一条上限）。后者不是一次失败：再问一次还是它，内容变了才会变。
 */
export type IndexOutcome =
  | { readonly ready: true; readonly index: TrigramIndex; readonly rebuilt: boolean }
  | { readonly ready: false; readonly over: IndexBudget }

export async function openOrRebuild(
  root: string,
  source: BlobSource,
  limits: IndexBudgetLimits = INDEX_LIMITS,
): Promise<IndexOutcome> {
  const hit = await readIndex(root)
  // 读得回来还不够：还要问它说的是不是**这一组** blob（口径六）。少这一问，换了内容之后旧那一份
  // 照旧被当成命中，而它对新 blob 一个候选都答不出来——那是漏报。
  if (hit !== null && sameBlobSet(hit, await source.ids())) return { ready: true, index: hit, rebuilt: false }
  try {
    const fresh = await rebuildIndex(root, source, limits)
    return { ready: true, index: fresh.index, rebuilt: true }
  } catch (error) {
    // 越限是**这一组输入**的性质（口径七），不是"读不回来"那一类。收成一态交回：调用方据此记住
    // 别再重建，而不是每问一次就重来一遍。库这一层不留记忆——记忆是调用方的事。
    if (error instanceof IndexBudgetExceeded) return { ready: false, over: error.over }
    throw error
  }
}

/** 索引在不在盘上（读数与测试用；不解析内容）。 */
export async function indexExists(root: string): Promise<boolean> {
  try {
    return (await stat(idxFileOf(root))).isFile()
  } catch {
    return false
  }
}
