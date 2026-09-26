// 一份种子怎么量。出处：架构 § 8.12（`seed` 那两条准则 · 上界是「总量（token 估账）」· 超限拒绝
// 派发）· 架构 § 8.11（那一份内容进的是 B 区，而量它的是同一把尺）· PLAN § 5.10 的 C1 断言④。
//
// **种子是指针，而账量的是「这些指针取出多少」。** 架构 § 8.12 那句话分两半：指针进契约
// （`seed: RelPath[]`，不是内容复述），而**内容按内容寻址存放，组装时才取**——于是"这一份种子
// 占多少"只有到某一棵树上取过才答得出来。这一份把两半接成一段、过 `B6` 那一把尺、量一次：
// 只量指针那一侧的话，那个上界（模型上限 − Zone A − 交接余量）对着一条几行的清单永远不响。
//
// **从哪一棵树取由调用方定。** 派发那一趟是轮次钉住的那个底（`truth.readAt(base, ·)`）；预备态
// 那一趟是持轮者那份视图（也铺在同一个底上）。这一份只收一个 `SeedSource`——它不认识 git，也
// 不认识视图，于是"量法只有一处"与"树由调用方给"同时成立。
//
// **退化档：读不到就只算指针那一侧。** 每一条路径一次 `read`，取不回来的（树上没有 · 底层读
// 失败）只算它自己那一行。这一份因此**永远不会量得比"只量指针清单"更少**，而那一侧正是这一份
// 之前的全部行为——地板不在这一处降低：尺抽掉了照旧给得出一个数，给的还是那一侧。
import type { CommitId, RelPath } from '../terms.ts'
import type { Truth } from '../truth/contract.ts'
import { estimateTokensOfText } from '../runtime/budget.ts'
import { seedTextOf } from '../contract/build.ts'

/**
 * 一棵树的读口：**一条路径一次，取不回来给 `null`**。
 *
 * 形状刻意与 `Truth.readAt(commit, path)` 同一条（少了那个 `commit`——"哪一棵树"在造这一份
 * 的时候就已经定了），于是两个调用点各自把树闭在闭包里，这一份不认识它们。
 */
export type SeedSource = (path: RelPath) => Promise<Uint8Array | null>

/** 量一份种子的是哪一份量法、读到几份内容、哪几条在这一棵树上没有。**读数，不参与判断。** */
export interface SeedReading {
  /** `tree` = 在这一棵树上取过内容；`given` = 调用方递了量法，这一份没量。 */
  readonly from: 'tree' | 'given'
  /** 取到内容的条数（去重之后）。 */
  readonly loaded: number
  /** 这一棵树上没有的那几条（按第一次见到的次序）。 */
  readonly missing: readonly RelPath[]
}

/**
 * 一份种子的尺。**先装后量**：`load` 是那一次取（异步），`textOf`/`tokensOf` 是同步的纯读。
 *
 * 分两步的理由是 `planBudget` 与 `build()` 都是纯函数：量法只能是一个**已经备好的值**，
 * 不能是"量的时候顺便去读一次树"。装之前量的是指针那一侧（退化档）。
 */
export interface SeedRuler {
  /** 把这几份种子在这棵树上取一遍。**同一条路径只读一次**，重复给不重复读。 */
  load(paths: readonly RelPath[]): Promise<void>
  /** 一份种子的正文：指针清单 + 取到的那几份内容，接成一段。 */
  textOf(paths: readonly RelPath[]): string
  /** 一份种子的账（token）：正文过那把尺。**`tools`/`seed` 进的是同一笔账**（`planBudget`）。 */
  tokensOf(paths: readonly RelPath[]): number
  readonly reading: SeedReading
}

/**
 * 造一份尺。**闭包自己拿着缓存，所以 `tokensOf` 可以脱手传**（`this` 那一栏在这里是空的：
 * 量法传进 `build()` 之后就不再属于任何对象）。
 */
export function seedRulerOf(source: SeedSource): SeedRuler {
  const taken = new Map<RelPath, string>()
  const missing: RelPath[] = []
  const seen = new Set<RelPath>()
  const decoder = new TextDecoder()

  const textOf = (paths: readonly RelPath[]): string => {
    const parts: string[] = [seedTextOf(paths)]
    for (const p of paths) {
      const content = taken.get(p)
      // **空文件也算读到了**：它一份内容都不占，而那与"树上没有它"是两件事（一条读到了的空
      // 文件不该出现在 `missing` 里）。所以这里按 `undefined` 判，不按空串判。
      if (content !== undefined) parts.push(content)
    }
    return parts.join('\n')
  }

  const tokensOf = (paths: readonly RelPath[]): number => estimateTokensOfText(textOf(paths))

  const reading: SeedReading = {
    from: 'tree',
    get loaded() {
      return taken.size
    },
    get missing() {
      return [...missing]
    },
  }

  return {
    async load(paths: readonly RelPath[]): Promise<void> {
      for (const p of paths) {
        if (seen.has(p)) continue
        seen.add(p)
        let bytes: Uint8Array | null = null
        try {
          bytes = await source(p)
        } catch {
          // **读失败与"树上没有"在这里是同一件事**：这一条只算它那一行。理由与退化档同一条——
          // 量法不该因为树的脾气变而抛，它给的是一个数。
          bytes = null
        }
        if (bytes === null) missing.push(p)
        else taken.set(p, decoder.decode(bytes))
      }
    },
    textOf,
    tokensOf,
    reading,
  }
}

/** 派发那一趟的尺：**轮次钉住的那个底**（架构 § 8.14 的 C7 前半）。 */
export function seedRulerAt(truth: Truth, base: CommitId): SeedRuler {
  return seedRulerOf((p) => truth.readAt(base, p))
}

/**
 * 递进来的量法那一档的读数：**这一份没量**，所以读数是"没量"而不是 0。
 *
 * 与 `budget.ts` 的 `UNCALIBRATED` 同一条纪律：没读数就说没读数，不拿 0 顶——0 会被读成
 * "这份种子是空的"。
 */
export const SEED_FROM_GIVEN: SeedReading = { from: 'given', loaded: 0, missing: [] }
