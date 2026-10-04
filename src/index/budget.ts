// 构建的四条上限：**数字只有这一处**（与 `roots/paths.ts` 那条"路径表只有一份"同一个理由）。
//
// 四条都在越过的**当场**止住，并报出是哪一条。它们不是"够用就行"的许愿，而是拿一等档 ext4 上量出来
// 的读数从**越过去的那一边**反推的（读数写在本站收口那一笔的 CHANGELOG 段里，探针随读数归档已删）：
//
//   sourceBytes     64 MiB = 路线图那一格「16 MB 级」的 4 倍。管的是"收进来的字节"：随读随判，
//                   越过就停，不然光是语料本身就先把内存吃掉。
//   blobs           65,536 = 量过的那一档（20,000 份小 blob，最长 postings 20,000 条，枚举它一次
//                   582 µs）的 3.3 倍。blob 表在候选那条路上要整个读回来，按 32 字节宽的 id 算，
//                   上限处约 2.1 MB。
//   grams           1,000,000 = 量出来的最杂那一档（16 MiB 可打印 ASCII → 857,364 个三字组 ·
//                   工件 28.3 MiB · 建 8.0 s · 常驻堆 295 MiB）再往上留一点。字典 18 字节一条 ⇒
//                   上限处 18 MB。**这一条是真正的那道闸**：构建的累加结构现在是"每个三字组一个数组"
//                   （量到约 0.3 KB/个），所以三字组数就是内存与时间的那把尺。
//   artifactBytes   64 MiB = 量过的最大工件（28.3 MiB）的 2.3 倍。这一关在分配 postings 之前过
//                   （`encodedBytesOf` 算得出来就不必先分配再判），不然上限就成了摆设。
//
// **改主意的条件**：支持范围要抬到 16 MiB 的**最杂**那一档、而常驻内存要压在 512 MB 以下——
// 那就该换掉构建的累加结构（把它们收进一张按 gram 排序的平表，而不是每个 gram 一个数组），
// 而不是抬 `grams`。上限抬上去只换来"更晚才失败"。
export type IndexBudget = 'source-bytes' | 'blobs' | 'grams' | 'artifact-bytes'

/**
 * 越限的**那一组输入**建不出来——它不会因为再试一次就变好（内容变了才会），所以这一条要报得出来，
 * 而不是混进"读不回来"那一堆 `null` 里。`over` 指得出是哪一条。
 */
export class IndexBudgetExceeded extends Error {
  readonly over: IndexBudget
  constructor(over: IndexBudget, detail: string) {
    super(detail)
    this.name = 'IndexBudgetExceeded'
    this.over = over
  }
}

/** 一套上限。**四个数一起给**——只改一个就成了一处会漂的第二份口径。 */
export interface IndexBudgetLimits {
  readonly sourceBytes: number
  readonly blobs: number
  readonly grams: number
  readonly artifactBytes: number
}

/** 出货的那一套。测试与将来的配置从这里换一套（缝），判据本身按"哪一条越过去了"写。 */
export const INDEX_LIMITS: IndexBudgetLimits = {
  sourceBytes: 64 * 1024 * 1024,
  blobs: 65_536,
  grams: 1_000_000,
  artifactBytes: 64 * 1024 * 1024,
}
