// 查询接线的那一半：**这一问要不要走索引，走的时候只看哪几条路径**。
// 出处：ROADMAP § 4 的查询接线那一行（trigram 候选 ∩ 视图 blob 集 → 缓存正则验证）· 它下面那一行
// （按档派发：稀疏与 miss 走索引 · 密集走扫描早停）。
//
// 四件事，按代价从低到高排：
//
//   一 · **模式那边先要得出"必须有"的三字组**（`pattern.ts`）。一条都取不出（单汉字/两字 ·
//        全是通配）→ 走扫描。这是「短查询走扫描」那条定稿规格的落点。
//   二 · **视图那一份名单与字节数从走树那一份枚举里来**（`rowsOf`）：同一次 `view.list` 的行
//        里本来就有 id 与 size，不必为查询再枚举一遍视图。取不到（夹具里那种手搓的 `walk()`）
//        → 走扫描。
//   三 · **盘上那一份工件**：`readIndex` 读回来（三节都核过摘要）· 读不回来就是缺席/损坏，
//        走扫描。工件整份要读的字节数从文件大小拿——这是这一层的固定开销。**"这份值不值得读"
//        判在它之前**（大小那一关），所以拒绝的那一趟一个字节都不读（本站 ③）。
//   四 · **候选 ∩ 视图**：拿最稀的那一条必须三字组的 postings，与视图里那些 blob 求交，
//        得出"这一趟可能命中的路径"。交完再算一次账：只有省下的字节够多才真的走它。
//
// 两条不变量（候选可以多，绝不能少）：
//
//   **覆盖**：盘上那一份必须认领视图里**每一个** blob（`I ⊇ V`）。少一个就有漏报——那一份
//   blob 在索引里没有 postings，`candidatesOf` 永远不会把它交出来。所以旧工件在那一条上
//   比新视图"大"是安全的（多余的条目只是不命中），"小"就必须回扫描。**这与构建那一侧的
//   `sameBlobSet` 不同**：那一边要的是"就是这一组"（合并的前提），这一边只要"罩得住"；
//   而且键是内容，同一份内容不论当初跟谁一起建的索引，postings 对它都作数。
//
//   **只减不增**：跳过的那些路径，一条都不许真的命中——它由 `pattern.ts` 的性质与上面那条
//   覆盖共同保证。验证永远在原卷上做（`tools/execute.ts` 那一趟照旧逐行试正则），这一层
//   只指路，不作证。
//
// 代价模型（**折算成真源字节**，量的是"这一趟要读的字节值多少"）：
//
//   走索引 = 工件整份（固定开销）× `ARTIFACT_WEIGHT` + 候选那些文件的字节（验证那一趟要读的）
//   全扫   = 这一趟范围内所有文件的字节
//
//   **两档的字节价相差约十倍**（工件 ≈ 0.65 ms/MB · 真源 ≈ 6.5 ms/MB），所以工件那一侧的字节先
//   折算再进两道闸（来处与改主意的条件都写在 `ARTIFACT_WEIGHT` 旁边）。按同一单价记会把"工件
//   不比语料小、但候选很稀"的问法一律拒掉——本仓那种形状四档两态一个数，就是这一笔记错的账。
//
//   判据是"索引那一侧更少"，而且要少到 `DENSE_FACTOR` 那个份上——有早停的那两档（内容 ·
//   路径）扫描会提前收工，密集模式下它读三五份就把回执填满了，索引再省也省不过它。
//   计数那一档不早停（它的答案是一个全量数），所以那一档的折扣是 1。
//
// **这一层不认识模式匹配，也不读真源字节**：它只回答"哪几条路径值得读"。
import { stat } from 'node:fs/promises'
import { idxFileOf, readIndex } from '../index/store.ts'
import { requiredTrigrams } from './pattern.ts'
import type { Trigram, TrigramIndex } from '../index/trigram.ts'
import type { BlobId } from '../terms.ts'

/**
 * 走树那一份清单里、查询接线要的两栏：**路径 → 内容标识**与**路径 → 字节数**。
 *
 * 它们与清单本身同源（同一个 `view.list` 的行），所以查询路上不必再枚举一遍视图——那是
 * `store.ts` 口径四说的"固定开销瘦身"里最容易被漏掉的一半。
 */
export interface ViewRows {
  readonly ids: ReadonlyMap<string, BlobId>
  readonly sizes: ReadonlyMap<string, number>
}

export interface PlanDeps {
  /** 真源根（索引住 `<root>/.fugue/idx/`）。 */
  readonly root: string
  /** 走树那一份清单 → 那两栏。取不到给 `null`（没接线）。 */
  readonly rowsOf: (walked: readonly string[]) => ViewRows | null
}

export interface PlanAsk {
  readonly pattern: string
  /** `host.walk()` 交出来的那一份清单，原样（取 id 与字节数要它当钥匙）。 */
  readonly walked: readonly string[]
  /** 这一趟真的会看的路径（范围与 `glob` 已经收窄过）。 */
  readonly targets: readonly string[]
  /** 这一问的回执会不会早停：内容与路径两档会，计数那一档要读完才有全量数。 */
  readonly earlyStop: boolean
  /**
   * **匹配器身上那一套 flags**（`execute.ts` 的 `new RegExp(pattern, …)` 里那一栏，原样交过来）。
   *
   * 这一栏是**必需**的，不给缺省：`''` 才是"确证没有 flags"，而"没传"被读成"没有"正是
   * `pattern.ts` 头部说的那条漏报通道（不敏感的一侧抽出来的三字组不再"必须有"）。带着 flags 的模式
   * 在那一层直接交回空表 → 这一问回扫描。
   */
  readonly flags: string
}

/**
 * 为什么走了（或没走）索引。**每一个取值都要能指着一句口径**——它同时是这一层的账。
 */
export type PlanWhy =
  /** 走索引：这一趟只看 `paths` 那些路径。 */
  | 'candidates'
  /** 模式里一条"必须有"的三字组都取不出（单汉字/两字 · 全通配）。 */
  | 'no-grams'
  /** 这一份清单没带 id/size（夹具里手搓的 `walk()`）。 */
  | 'no-rows'
  /** 盘上没有索引，或者它读不回来（缺席 · 损坏 · 版本认不出 · 摘要不合）。 */
  | 'artifact-absent'
  /** 工件整份那一笔比全扫还贵（本仓这种"字典与语料一样大"的形状就是这一档）。 */
  | 'artifact-heavy'
  /** 盘上那一份认领的 blob 罩不住这一组视图（旧工件里没有新进来的那些）。 */
  | 'view-uncovered'
  /** 候选那些文件的字节数不值得换（密集档）。 */
  | 'candidates-dense'
  /** 索引那一层出了意外。**兜底**：查询绝不许因为索引而失败，这一档一律回扫描。 */
  | 'failed'

/** 这一层的账（**不进判据**）：算出来的每一栏都指得出源。 */
export interface PlanReading {
  readonly artifactBytes: number
  readonly scanBytes: number
  readonly candidateBytes: number
  readonly targets: number
  readonly viewBlobs: number
  readonly artifactGrams: number
  /** 挑中的那一条三字组与它在几个 blob 里出现过。 */
  readonly gram: Trigram | null
  readonly gramCount: number
}

export interface SearchPlan {
  readonly why: PlanWhy
  /** 走索引时：这一趟只有这些路径可能命中（不在里面的一律不读）。不接线时是 `null`。 */
  readonly paths: ReadonlySet<string> | null
  readonly reading: PlanReading
}

export type Planner = (ask: PlanAsk) => Promise<SearchPlan>

/**
 * 有早停的那两档的折扣：索引那一侧要读的字节必须小于全扫的 1/4 才走。
 *
 * 来处：扫描在内容档上拼够回执上限（8 KiB）就停，密集模式下它读三五份文件就收工，而索引
 * 那一侧固定要读整份工件。这一条是**取出来的参数**（收口那一笔的四档读数），不是推导
 * 出来的常数；改主意的条件是四档读数上这条线画错了（该走的没走 / 走了的更慢）。
 */
export const DENSE_FACTOR = 4

/**
 * **工件字节的单价 / 真源字节的单价**（方案里写作 `w`）。代价模型两侧的字节不再是同一把
 * 尺：同一份字节，从工件那一节读回来比从真源读回来便宜约十倍。所以工件那一侧的字节先折算成
 * "值多少真源字节"再进两道闸。`DENSE_FACTOR` 那一笔照旧只当早停折扣，不再兼职价格比。
 *
 * 来处（一等档 ext4 · 20 核 · Node v24.21.0 · 页缓存热 7 趟中位，原始输出在方案 § 五.7）：
 *
 *   工件 `readIndex`   0.62–0.72 ms/MB（本仓 5,515,652 字节 3.98 ms = 0.72；16 MiB 三档 0.62–0.66）
 *   真源 整篇扫        6.41–7.00 ms/MB（窄字母表 16 MB 6.41 · 中文注释 64 字 7.00 · 最杂 ASCII
 *                      6.55；本仓那一档 12.5 ms/MB——每份小文件一笔协议开销，所以它是最贵的一档）
 *
 * 取 0.1（0.65 / 6.5）。**它不改任何一次读盘，只改一次比较**——改的是把已经量到的两个单价带进
 * 模型，所以这一条的常数是 0。
 *
 * **改主意的条件**：一等档上重新取的两处单价之比离开 0.1 一个量级（比如工件那一侧换成了按节读、
 * 或者真源那一侧换成了批量预取），或者四档读数上出现"该走却没走"与"走了更慢"。
 */
export const ARTIFACT_WEIGHT = 0.1

/** 这一层读回来的那一份：工件是不可变内容，同进程里读一次就一直在（键里带 `size:mtime` 认账）。 */
interface Cached {
  readonly key: string
  readonly index: TrigramIndex
}

export function createPlanner(deps: PlanDeps): Planner {
  let cached: Cached | null = null

  /**
   * 盘上那一份有多大 · 以及"要不要重读"的认账键。**只 `stat`，一个字节都不读。**
   *
   * 它是大小那一关（`artifact-heavy`）的落点：`st.size` 在 `readIndex` 之前就拿到了，而拒绝的
   * 那一趟原先还白读了一整份工件（三节全读、三节各核一遍 sha256）。夹具把这一条钉在两种形态上
   * ——`plan.test.ts` ⑨ 用 chmod 000 的工件：`stat` 拿得到 size、`read` 吃 EACCES，于是
   * 「大小关在读之前」给 `artifact-heavy`、「挪回读之后」给 `artifact-absent`，两者分得开。
   *
   * 拿不到（缺席 · 不是文件）给 `null`（当缺席）。
   */
  async function probeOnce(): Promise<{ bytes: number; key: string } | null> {
    const st = await stat(idxFileOf(deps.root)).catch(() => null)
    if (st === null || !st.isFile()) return null
    return { bytes: st.size, key: `${st.size}:${st.mtimeMs}` }
  }

  /**
   * 读一次盘上那一份。**同进程里读一次就够**（一轮里连发几问时，"每问重核一遍索引"正是要
   * 避开的常数）；文件变了（大小或 mtime 变了）就重读。读不回来给 `null`（当缺席）。
   *
   * **它只在"这一问值得读"之后才被走到**：大小那一关夹在 `probeOnce` 与这一句之间（`plan` 里）。
   *
   * 认账的键（大小 · mtime）**只是「要不要重读」那一个提示，正确性不靠它**：靠的是上面那条
   * 覆盖。blob id 是内容的名字，所以一份旧工件只要罩得住视图，它对这些 id 的 postings 就与
   * 它是哪一代工件无关；罩不住就回扫描。于是「缓存读到旧的那一份」最多是少一次重读，不是漏报。
   */
  async function readOnce(probe: { bytes: number; key: string }): Promise<{ index: TrigramIndex; bytes: number } | null> {
    if (cached !== null && cached.key === probe.key) return { index: cached.index, bytes: probe.bytes }
    const index = await readIndex(deps.root)
    if (index === null) {
      cached = null
      return null
    }
    cached = { key: probe.key, index }
    return { index, bytes: probe.bytes }
  }

  return async function plan(ask: PlanAsk): Promise<SearchPlan> {
    const blank: PlanReading = {
      artifactBytes: 0,
      scanBytes: 0,
      candidateBytes: 0,
      targets: ask.targets.length,
      viewBlobs: 0,
      artifactGrams: 0,
      gram: null,
      gramCount: 0,
    }
    const give = (why: PlanWhy, reading: Partial<PlanReading> = {}): SearchPlan => ({
      why,
      paths: null,
      reading: { ...blank, ...reading },
    })

    // **兜底包住整条**：索引那一层出任何意外都只是这一问回扫描，绝不许把问询打死
    // （地板：索引缺席 · 损坏 · 越限 · 短查询，四条都是"变慢"，没有一条是"跑不起来"）。
    try {
      // flags 与模式一起交进去：抽取器只认"确证无 flags"的那一档（`plan.ts` 的 `PlanAsk.flags`）。
      const grams = requiredTrigrams(ask.pattern, ask.flags)
      if (grams.length === 0) return give('no-grams')

      const rows = deps.rowsOf(ask.walked)
      if (rows === null) return give('no-rows')

      let scanBytes = 0
      const viewIds = new Set<BlobId>()
      for (const path of ask.targets) {
        const id = rows.ids.get(path)
        // 清单里的一行取不到 id：这一条路径的身份不可知，那就不许跳过它（宁可整条回扫描）。
        if (id === undefined) return give('view-uncovered', { targets: ask.targets.length })
        viewIds.add(id)
        scanBytes += rows.sizes.get(path) ?? 0
      }

      const factor = ask.earlyStop ? DENSE_FACTOR : 1
      // **大小那一关挪到读之前**（本站 ③）：`st.size` 这一刻就在手里，而拒绝的那一趟原先在判它
      // 之前就把整份工件读完了（三节全读、三节各核一遍 sha256）。读数那一栏跟着挪——拒绝这一档
      // 没有读工件，`artifactGrams` 报手里正好有同一份（缓存键对得上）时的那个数，否则报 0
      // （0 在这里是"这一问没读"，不是"这一份里一个三字组都没有"）。
      const probe = await probeOnce()
      if (probe === null) return give('artifact-absent', { scanBytes, viewBlobs: viewIds.size })
      const base: Partial<PlanReading> = {
        artifactBytes: probe.bytes,
        scanBytes,
        viewBlobs: viewIds.size,
        artifactGrams: cached !== null && cached.key === probe.key ? cached.index.gramCount : 0,
      }
      // 固定开销那一关先过：工件整份**折算之后**比全扫的 1/factor 还大，读它就已经亏了。
      if (probe.bytes * ARTIFACT_WEIGHT * factor >= scanBytes) return give('artifact-heavy', base)

      const read = await readOnce(probe)
      if (read === null) return give('artifact-absent', base)
      const loaded: Partial<PlanReading> = { ...base, artifactGrams: read.index.gramCount }

      // 覆盖：视图里每一个 blob 都要在盘上那一份的名单里（少一个就是漏报那一档）。
      const known = new Set(read.index.blobIds)
      for (const id of viewIds) if (!known.has(id)) return give('view-uncovered', loaded)

      // 挑最稀的那一条（`countOf` 只看字典那一节；三节这时已经在手里，一个字节都不再读）。
      let gram: Trigram | null = null
      let count = Number.POSITIVE_INFINITY
      for (const g of grams) {
        const c = read.index.countOf(g)
        if (c < count) {
          count = c
          gram = g
        }
      }
      if (gram === null) return give('no-grams', loaded)
      const hit = new Set(read.index.candidatesOf(gram))

      const paths = new Set<string>()
      let candidateBytes = 0
      for (const path of ask.targets) {
        const id = rows.ids.get(path)
        if (id === undefined || !hit.has(id)) continue
        paths.add(path)
        candidateBytes += rows.sizes.get(path) ?? 0
      }

      const reading: Partial<PlanReading> = { ...loaded, candidateBytes, gram, gramCount: count }
      // 兑现那一关：工件**折算之后** + 候选要读的字节，仍然要小于全扫的 1/factor 才走（读到这一步
      // 才知道候选有多少；不够格就回扫描，欠的是这一步判断，不是把候选当答案）。
      if ((read.bytes * ARTIFACT_WEIGHT + candidateBytes) * factor >= scanBytes) return give('candidates-dense', reading)
      return { why: 'candidates', paths, reading: { ...blank, ...reading } }
    } catch {
      // 意外一律回扫描——**这一档今天按构造到不了**（解析器每一支都有出口 · `readIndex` 自己把
      // 六种坏法收成 `null`）。留着它是为了这道地板：索引那一层出任何意外都只是这一问慢一点，
      // 不许把问询本身打死。它不把该报红的放行成通过——答案照旧由扫描那一趟现验出来。
      return give('failed')
    }
  }
}
