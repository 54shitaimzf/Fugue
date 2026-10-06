// 构建触发器：**缺省模式下工件什么时候建**这一件事只有这一处。出处：路线图 § 4 的缺省档那一行
// （「索引为缺省档」）与它那一句验收（按档派发：稀疏与未命中走索引 · 密集走扫描早停）。
//
// 0.3.3 把"建"这一侧留在查询路之外，理由写在那一版的 CHANGELOG 里：查询路只消费、不生产、不写账
// ——一问上多付一次全量构建，还往读路径写盘。这一站把那一句翻过来（缺省档就是索引），**但翻面的
// 代价要有个上界**；这一层的全部内容就是那条上界与它的账。
//
// 三条语义（可断言的那三条）：
//
//   一 · **建**：盘上没有工件（缺席 · 损坏 · 版本认不出）而这一问用得着它时建一份，走
//        `openOrRebuild` 那条全量路。**闸**：视图那一份的源字节超过 `TRIGGER_MAX_SOURCE_BYTES`
//        就不建——首查不替人付那一笔（最杂 ASCII 16 MiB 的全量建实测 9 041 ms），这一问照旧扫描。
//   二 · **增量**：盘上有工件、但它说的不是这一组 blob（视图动过）时走 `openOrRebuild` 里那条
//        增量路，只爬新进来的那些 blob。那一条读的真源与**新增的那几份**成正比，所以**它不受
//        字节闸管**：闸挡的是"从零建一整份"，不是"把旧的那份接上"。
//   三 · **不建**：短查询（取不出必含三字组）与清单缺 id/size 那两档在更早的地方就回扫描了
//        （`plan.ts` 的两条早退）；越限与没接真源在这里各收成一态。**同一份清单配同一份工件只判
//        一次**——进程内的一笔记账，不落盘、不进事件、不进视图。
//
// 账（`BuildAccount`）是**读数**：它进 `PlanReading`，不进回执、不进日志、不进视图。查询路这一侧
// 新增的持久化位置仍然只有 `.fugue/idx/` 那一处（派生体纪律：不进提交 · 不进视图 · 不进事件 · 不写账）。
import { openOrRebuild } from '../index/store.ts'
import type { BlobSource } from '../index/store.ts'
import type { IndexBudget, IndexBudgetLimits } from '../index/budget.ts'
import type { ViewRows } from './plan.ts'
import type { BlobId } from '../terms.ts'

/**
 * **视图那一份的源字节上限**：超过它就不从零建工件（增量那一条不受它管）。
 *
 * 它是这一站唯一的"花多少"常数，取值的两侧都是一等档 ext4 上的实测：
 *
 *   允许侧   本仓这类中文注释形状（293 份 · 4 469 121 字节）全量建 **537 ms**（518–595，0.3.2 读数）
 *   挡住侧   最杂 ASCII 16 MiB（128 份 × 128 KiB）全量建 **9 041 ms**（0.3.2 读数）——就是
 *            "首查不替人付"要挡住的那一笔
 *
 * 8 MiB 落在两者之间（本仓那一档的两倍以内、16 MiB 那一档的一半）。**挡住侧是按最贵速率外推的**：
 * 那个速率是 565 ms/MB（9 041 ms ÷ 16 MiB），8 MiB 处外推约 4.5 s——**外推，不是实测**，截至
 * 这一站没有 8 MiB 那一档的实测读数。这是这一站最粗的一处自决，改法只有一处常数：
 *
 * **改主意的条件**：一等档上量到 8 MiB 附近某一档的实建墙钟与上面那条外推差出一个量级，或者
 * 出现"建价的形状感知估计"（那时这条线换成代价估计，字节闸作废）；再或者真实用法里出现
 * "8 MiB 以上、每问都稀疏、建一次明显划算"的形状（那时闸要抬，抬之前先把那档的实测补上）。
 */
export const TRIGGER_MAX_SOURCE_BYTES = 8 * 1024 * 1024

/**
 * 没建的时候是哪一条挡住的。**每一个取值都要能指着一句口径**（与 `PlanWhy` 同一把尺子）。
 */
export type TriggerWhy =
  /** 这一问建了（或者盘上那一份就是这一组 blob）。 */
  | ''
  /** 没接真源（夹具档）：建不了——查询照旧扫描。 */
  | 'no-source'
  /** 清单缺 id/size 栏（手搓的 `walk()`）：建出来的那份罩不住这一组，建了也是白建。 */
  | 'rows-incomplete'
  /** 视图那一份的源字节过了 `TRIGGER_MAX_SOURCE_BYTES`：首查不替人付那一笔。 */
  | 'over-ceiling'
  /** 四条构建上限里有一条越了（`over` 指得出是哪一条）：这一组输入建不出来。 */
  | 'over-limits'

/**
 * 这一问在构建那一侧做了什么。**它是账，不是回执**——回执一个字节都不跟着变。
 *
 *   `hit`     盘上那一份就是这一组 blob：没建、没写盘（读回来核过身份那一趟算在里面）
 *   `grown`   增量：只爬了新进来的那些 blob
 *   `rebuilt` 全量重建（缺席 · 损坏 · 版本认不出 · 增量那条路走不通）
 *   `none`    没建：这一问用不着索引（短查询 · 没接线），或者这一对"清单 + 工件"已经判过
 *   `skipped` 没建，而且账面说得出为什么（`why`）
 */
export interface BuildAccount {
  readonly kind: 'hit' | 'grown' | 'rebuilt' | 'none' | 'skipped'
  readonly why: TriggerWhy
  /** 视图那一份的源字节（闸拿它判的那个数；清单缺栏时是 0）。 */
  readonly viewBytes: number
  /** 这一趟为建工件向真源要了几份 blob（`hit` / `none` / `skipped` 是 0）。 */
  readonly freshBlobs: number
  /** 要回来的那些字节（增量档只数新进来的那些）。 */
  readonly sourceBytes: number
  /** 落下去的那一份有多大；`hit` 报盘上那一刻的大小。 */
  readonly artifactBytes: number
  /** `over-limits` 时指得出是哪一条上限，其余是 `null`。 */
  readonly over: IndexBudget | null
}

/** 一份"什么都没建"的账（`plan.ts` 的 `PlanReading` 用它当零值）。 */
export const NO_BUILD: BuildAccount = Object.freeze({
  kind: 'none',
  why: '',
  viewBytes: 0,
  freshBlobs: 0,
  sourceBytes: 0,
  artifactBytes: 0,
  over: null,
})

/** 这一问要的几样。`artifact` 是 `plan.ts` 那一次 `stat` 的结果（缺席给 `null`）。 */
export interface TriggerAsk {
  /** `host.walk()` 交出来的那一份清单，原样。**同一个代是同一个引用**——它就是"哪一代"那把钥匙。 */
  readonly walked: readonly string[]
  readonly rows: ViewRows
  readonly artifact: { readonly bytes: number; readonly key: string } | null
}

/** 触发器的出口形状：与 `plan.ts` 的 `PlanDeps.ensureIndex` 同一件事。 */
export type EnsureIndex = (ask: TriggerAsk) => Promise<BuildAccount>

export interface TriggerDeps {
  /** 真源根（索引住 `<root>/.fugue/idx/`）。 */
  readonly root: string
  /**
   * 真源字节。**不给就不建**（夹具档）——与查询接线那条地板同一条：机制缺席只是慢，不是坏掉。
   */
  readonly readBlob: ((id: BlobId) => Promise<Uint8Array>) | undefined
  /**
   * 四条构建上限。**不给就是出货那一套**（`openOrRebuild` 的缺省）；与 store 那一层开的是同一条缝，
   * 测试据此把"越限"那一档摆出来——那条路要走通一遍，它记过之后不再重试也是。
   */
  readonly limits?: IndexBudgetLimits
}

const account = (kind: BuildAccount['kind'], viewBytes: number, why: TriggerWhy = ''): BuildAccount => ({
  kind,
  why,
  viewBytes,
  freshBlobs: 0,
  sourceBytes: 0,
  artifactBytes: 0,
  over: null,
})

/**
 * 视图那一份的源字节 —— **每一个走过的路径都要有 id 与 size**，少一栏就给 `null`。
 *
 * 为什么少一栏就不建：工件是"喂进去那一组 blob"的纯函数，缺 id 的那一条进不去，建出来的那份
 * 于是罩不住这一组视图——查询那一侧的覆盖判据会把它判回扫描，而下一问又是同样一份，**每问白建
 * 一次**。这不是正确性问题（覆盖那一条守着漏报），是"别白付"。
 */
function viewBytesOf(ask: TriggerAsk): number | null {
  let bytes = 0
  for (const path of ask.walked) {
    const size = ask.rows.sizes.get(path)
    const id = ask.rows.ids.get(path)
    if (size === undefined || id === undefined) return null
    bytes += size
  }
  return bytes
}

export function createTrigger(deps: TriggerDeps): EnsureIndex {
  /**
   * 上一次落定的那一对（清单引用 · 盘上工件那一刻的认账）。
   *
   * **它是提示，不是判据**：清单换了代就是另一个引用（`walk-cache.ts` 硬性三），工件动过就是另一个
   * 键。落在这一笔上跳过的那一问，正确性照旧由查询那一侧的覆盖判据兜着（罩不住就回扫描）——
   * 与 `plan.ts` 里那个 `size:mtime` 认账键同一条口径。
   *
   * 它同时是"越限/落不下去"那两档的刹车：那一档上不记账的话，每一问都会重来一次全量构建。
   */
  let settled: { readonly walked: readonly string[]; readonly key: string } | null = null

  return async function ensure(ask: TriggerAsk): Promise<BuildAccount> {
    const key = ask.artifact === null ? 'absent' : ask.artifact.key
    if (settled !== null && settled.walked === ask.walked && settled.key === key) {
      return account('none', 0)
    }
    const remember = (one: BuildAccount): BuildAccount => {
      settled = { walked: ask.walked, key }
      return one
    }

    const viewBytes = viewBytesOf(ask)
    if (deps.readBlob === undefined) return remember(account('skipped', viewBytes ?? 0, 'no-source'))
    if (viewBytes === null) return remember(account('skipped', 0, 'rows-incomplete'))
    // **闸只管"从零建一整份"**：盘上已经有工件时走的是增量，代价与新增的那几份成正比。
    if (ask.artifact === null && viewBytes > TRIGGER_MAX_SOURCE_BYTES) {
      return remember(account('skipped', viewBytes, 'over-ceiling'))
    }

    const readBlob = deps.readBlob
    const source: BlobSource = {
      // 顺序与重复都不算差别（`store.ts` 口径六），去重在这一侧做，`collectBlobs` 那一侧照旧再收一遍。
      ids: async () => [...new Set(ask.rows.ids.values())],
      read: (id) => readBlob(id),
    }
    const outcome = await openOrRebuild(deps.root, source, deps.limits)
    if (!outcome.ready) {
      return remember({ ...account('skipped', viewBytes, 'over-limits'), over: outcome.over })
    }
    if (!outcome.rebuilt) {
      return remember({
        ...account('hit', viewBytes),
        artifactBytes: ask.artifact === null ? 0 : ask.artifact.bytes,
      })
    }
    // 增量那一趟报得出"这一趟读了几份、几字节"；全量重建那一趟的账在 `BuildReading` 里。两条都收。
    const grown = outcome.grew
    const full = outcome.built
    return remember({
      kind: grown === null ? 'rebuilt' : 'grown',
      why: '',
      viewBytes,
      freshBlobs: grown === null ? (full === null ? 0 : full.blobCount) : grown.freshBlobs,
      sourceBytes: grown === null ? (full === null ? 0 : full.sourceBytes) : grown.sourceBytes,
      artifactBytes: grown === null ? (full === null ? 0 : full.artifactBytes) : grown.artifactBytes,
      over: null,
    })
  }
}
