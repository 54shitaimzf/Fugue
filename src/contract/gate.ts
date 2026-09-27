// 门：**草案 → 契约集合，停在门口不发**。出处：架构 § 15.1.a 四步里的"判"与"停"（门默认为停 ·
// 出口三条 · "这道门只认契约集合"）· 架构 § 8.12（构造器不猜不补 · 值域持有者表 · 跨字段那两条 ·
// 预检两处同一个函数）· PLAN § 5.10 的 `C2` 行与 § 5.12 的序 6。
//
// **这一份一个契约都不发 · 不读日志 · 不碰 git。** 它把"判"与"停"收成一次调用：草案进去，
// 一批契约值加一次预检出来。派那一步（`contract/issue` · 起分支）归调用点——`round/start.ts`
// 是配置那一档的一次性派发，`round go` 是预备态那一档的放行（PLAN § 5.10 的 C4）。
//
// **门只认契约集合，所以"判"必须是纯的。** 同一份草案 · 同一份身份分配器，什么时候重算都得到
// 同一批值：于是"放行的是这一批"与"再跑一次不重复触发"两句比的是同一个对象，而不是两次各说
// 各话的渲染。唯一的例外是种子的量——它要读一棵树（`seedRuler`），而**从哪棵树取由调用方定**
// （架构 § 8.12：初次派发是轮次钉住的底，预备态是持轮者那份视图）。
//
// **两级判据，两个判者。** 一级是成形，机械判得了，就是这一份：键域（哪一节该有哪几个键）·
// 值域（逐字段调它的持有者）· 跨字段（`actionOutputs ⊆ ownedPaths` · 断言的动作在不在绑好的
// 表里）· 预检（相交只报对数）。二级是值不值——规模落在甜点区间的哪一处 · 写入面切得干不干净
// ——只有人能判，那是 `round go` 那一次批。这一份一个字都不替它判：拆分没有事前判据（架构
// § 8.12 自己写着"拆得太粗与拆得太细都没有事前判据"）。
//
// **两条前门，同一处判。** 持轮者写的那一份草案（`from: 'draft'`）与配置里人自己写好的那两栏
// （`from: 'split'`，`round.split` 那条路）走同一段判据，差别只在第一段要不要"读草案"。两处
// 共用一个函数的理由与预检那两处一样：同一个函数，因此不会给出不同答案。
import type { ActionName, CommitId, RelPath, RoundId } from '../terms.ts'
import type { Built, Identity, Intent, SplitAssignment } from './build.ts'
import { BuildError, build, seedTokensOf } from './build.ts'
import type { Draft, DraftSection } from './draft.ts'
import { DraftError, draftOf } from './draft.ts'
import type { PrecheckResult } from './precheck.ts'
import { planningGate } from './precheck.ts'
import type { Contract } from './types.ts'

/**
 * 一份种子的量法：**先装后量**。`load` 是那一次取（异步的：内容从某一棵树上取回来），
 * `tokensOf` 是同步的纯读。
 *
 * 分两步的理由与 `round/seed.ts` 同一句：`build()` 是纯函数，量法只能是一个**已经备好的值**，
 * 不能是"量的时候顺便去读一次树"。那一份里的 `SeedRuler` 就是这个形状（多几栏，结构上兼容）。
 */
export interface SeedMeasurer {
  readonly load: (paths: readonly RelPath[]) => Promise<void>
  readonly tokensOf: (paths: readonly RelPath[]) => number
}

/**
 * 门那一趟的输入：**两个变体各自带着自己有的那几样**，因为它们是两种来源。
 *
 * `draft` 是持轮者写的那一份（原文在视图里，`round/intent` 那一句由调用方给——草案里不再写
 * 一遍）；`split` 是配置里人自己写好的那两栏（`round.split` · 人拆那一档 · PLAN § 5.11 的地板）。
 * 两栏都带上自己的种子：`draft` 那一档从草案的每一节取，`split` 那一档由调用方给。
 */
export type GateInput =
  | {
      readonly from: 'draft'
      /** 轮级意图那一句（`round/intent` 给的；调查型那一节不在草案里再写一遍）。 */
      readonly goal: string
      /** 草案原文。`null` = 这一份没写出来（`where` 要用来说那句话）。 */
      readonly text: string | null
      /** 草案住在哪（报"没写出来"时指路）。 */
      readonly where: RelPath
    }
  | {
      readonly from: 'split'
      readonly intent: Intent
      readonly split: readonly SplitAssignment[]
      /** 逐份的种子，**与构造次序同序**（配置那一档给空数组）。 */
      readonly seeds: readonly (readonly RelPath[])[]
    }

/** 判一批要的那几样。**全是值或注进去的接缝**，这一份不认识日志、真源与视图。 */
export interface GateDeps {
  readonly round: RoundId
  /** 轮次钉住的那个底（架构 § 8.14 的 C7 前半）：契约里的底就是它。 */
  readonly base: CommitId
  /** 第 `n` 个 agent 的身份（从 0 起 · 构造次序）。构造器不认识它是怎么发出来的（§ 14.1）。 */
  readonly identityFor: (n: number) => Identity
  /**
   * 绑好的动作表：名字 → 它声明的产出（配置里 `actions.<名字>` 那一条）。
   *
   * **给就核"断言的动作在不在表里"这一条**（架构 § 8.12 那张表：`assertions` 的候选是工作区
   * 配置），并按它算 `actionOutputs`。**不给就不核**：配置那一档（人拆）的断言走
   * `round.assertions` 那一份、按名字对，绑定表不由这一条核——那是人自己写的两处。
   */
  readonly actions?: Readonly<Record<string, readonly RelPath[]>>
  /** `from: 'split'` 那一档的动作产出（持轮者那一档按 `actions` 算，不看这一栏）。 */
  readonly actionOutputsOf?: (n: number) => Readonly<Record<ActionName, readonly RelPath[]>>
  /** 一份种子的量法：给就**先把这几份的内容取回来**再量（异步只在这一处）。 */
  readonly seedRuler?: SeedMeasurer
  /** 已经量好的一份量法（测试与"从别的树取"那一档从这个口进来）。 */
  readonly seedTokens?: (paths: readonly RelPath[]) => number
  readonly seedLimit?: number
  /**
   * **声明的模型上限**（`ModelDecl.contextLimit`）。`seed` 那一条的算式按它算——不给就走这一份的
   * 缺省（`DEFAULT_MODEL_LIMIT`），那不是一个真声明里的数。
   */
  readonly modelLimit?: number
}

/** 一次判的答案。**`held` 为真时 `built` 就是门后面那一批契约值**——一个字节都没发。 */
export interface GateVerdict {
  /** 停在门口：键域 · 值域 · 跨字段 · 绑定四样都过，这一批造得出来。 */
  readonly held: boolean
  /** 退回的每一处（哪一节哪个键 · 哪一条关系）。**空数组 = 停在门口**，不猜、不补。 */
  readonly problems: readonly string[]
  /** 读出来的那一份草案（配置那一档没有它——`null`）。 */
  readonly draft: Draft | null
  /** 轮级意图：调查型那一节的问题与证据从这里进契约，全部契约的 `goal` 是它的切片。 */
  readonly intent: Intent
  /** **门后面那一批**：停在门口时手上已经有这一批契约值。 */
  readonly built: Built | null
  /** `Planning` 那一档的预检（相交只报对数，照发——判据两处、判决一处，见 `precheck.ts`）。 */
  readonly precheck: PrecheckResult | null
}

/**
 * 一节草案的动作产出。**核两件事，都是架构 § 8.12 那张表上的关系**：
 *
 *   一 · 这一条断言的动作**在不在绑好的表里**（`assertions` 的值域持有者是"工作区配置（候选）"）。
 *        不在就报出这个名字与现有的有哪几个——**不猜、不补、不替它挑**（PLAN § 5.10 的 C1 ⑦）。
 *   二 · 在表里的话，按它的绑定算这一份契约的 `actionOutputs`。**只收有产出的那几个**：一条只跑
 *        退出码的断言（测试那一类）不声明产出，而 `actionOutputs` 里一个空数组是要被拒的
 *        （`types.ts` 的字段清单："声明了动作却不声明产出"）——那两句话不能同时成立，所以没产出的
 *        那几个不进 `actionOutputs`。
 *
 * `⊆ ownedPaths` 那一条不在这里判：它是构造器的跨字段关系（`checkContract` 一处给），报出来的
 * 话带得出是哪一条动作的哪一条产出。
 */
function outputsOf(
  s: DraftSection,
  actions: Readonly<Record<string, readonly RelPath[]>>,
  at: number,
  problems: string[],
): Record<ActionName, readonly RelPath[]> {
  const out: Record<ActionName, readonly RelPath[]> = {}
  if (s.kind !== 'implement') return out
  for (const a of s.assertions) {
    const got = actions[a.action]
    if (got === undefined) {
      const have = Object.keys(actions).sort()
      problems.push(
        `第 ${at} 节的断言「${a.name}」指向一个没绑的动作：${a.action}——` +
          (have.length === 0 ? '配置里一个动作都没绑（`actions.<名字>`）' : `绑好的有：${have.join(' · ')}`) +
          '。不猜、不补、不替它挑（PLAN § 5.10 的 C1 ⑦）',
      )
      continue
    }
    if (got.length > 0) out[a.action] = [...got]
  }
  return out
}

/**
 * 一批契约的**编号**：拆分的形状过一遍。出处：架构 § 15.1.a（放行那一档要一个"这一批"的可核对
 * 对象）· PLAN § 5.10 的 C4 行。
 *
 * **它是形状的编号，不是身份的编号。** `id` · `agent` · `branch` 与 `base` 都不进：前三个带着
 * 轮次号（`r1.implement.1` 与 `r2.implement.1`），于是"同一份拆分换个轮次"永远比不出相等；底是
 * 钉住的那个提交，与"这一批活长什么样"不是一回事。进去的是每节的 `kind` · `goal` · 写入面 ·
 * 交付物 · 断言 · `seed`，**按构造次序**。
 *
 * **它不作数。** 编号相同不代表可以照上次放行（架构 § 15.1.a：新的一批一律停在门口等人点头）。
 * 它是给人看的一个名字（`round/approve` 记它 · `RoundFacts.approvals` 读回来对照），所以**不需要抗碰撞**：
 * 这里用 FNV-1a 64 位——这一份拿不到任何 IO，也就不引 `node:crypto`。
 */
export function fingerprintOf(built: Built): string {
  return fnv1a64(built.contracts.map(shapeOf).join('\n'))
}

/** 一份契约里能进编号的那几栏，按本文的次序拼成一个字符串（分隔符 `\u0001`：路径里不会有它）。 */
function shapeOf(c: Contract): string {
  const parts: string[] = [c.kind, c.goal]
  if (c.kind === 'implement') {
    parts.push(...c.ownedPaths)
    parts.push(...c.deliverables.map((d) => `${d.path}(${d.form})`))
    parts.push(...c.assertions.map((a) => `${a.name}@${a.action}`))
    parts.push(...c.seed)
  } else if (c.kind === 'resolve') {
    parts.push(...c.conflictPaths)
    parts.push(...c.assertions.map((a) => `${a.name}@${a.action}`))
  } else {
    parts.push(c.question)
    parts.push(...c.evidenceRequired.map((e) => `${e.note}@${e.artifact}`))
    parts.push(...c.seed)
  }
  return parts.join('\u0001')
}

/** FNV-1a 64 位，十六位十六进制：**一个名字，不是一把锁**（不抗碰撞，也不需要抗）。 */
function fnv1a64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let h = 0xcbf29ce484222325n
  for (const b of bytes) {
    h ^= BigInt(b)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0')
}

/**
 * 判一批：草案（或已经成型的那两栏）→ 契约集合 + 预检。**停在门口，不发。**
 *
 * 四段的次序是承重的：键域不成立就没有"哪一节"可说；绑定与值域要在构造之前（绑不上就不该按
 * 它算产出）；预检要一批造好的契约。每一段报出来的话都带得出位置——退回一次要能改完，不然
 * 就是让人陪着一处一处试（`draft.ts` 同一条规矩）。
 */
export async function gateOf(input: GateInput, deps: GateDeps): Promise<GateVerdict> {
  const problems: string[] = []
  let draft: Draft | null = null
  let intent: Intent
  let split: readonly SplitAssignment[]
  let seeds: readonly (readonly RelPath[])[]
  let sections: readonly DraftSection[] = []

  // 一 · 键域：草案这一档的第一件事。**不成立就把每一处报出来**（退回重写草案），而不是猜着补齐。
  if (input.from === 'split') {
    intent = input.intent
    split = input.split
    seeds = input.seeds
  } else {
    if (input.text === null) {
      return {
        held: false,
        problems: [
          `草案不在视图里：${input.where}——持轮者这一趟没写出那一份` +
            '（一个任务一节，每节一个标 `json` 的围栏块，键就是契约的键）',
        ],
        draft: null,
        intent: { goal: input.goal },
        built: null,
        precheck: null,
      }
    }
    try {
      draft = draftOf(input.text)
    } catch (err) {
      if (!(err instanceof DraftError)) throw err
      return { held: false, problems: err.problems, draft: null, intent: { goal: input.goal }, built: null, precheck: null }
    }
    intent = {
      goal: input.goal,
      ...(draft.question === undefined ? {} : { question: draft.question }),
      ...(draft.evidenceRequired === undefined ? {} : { evidenceRequired: draft.evidenceRequired }),
    }
    split = draft.split
    seeds = draft.seeds
    sections = draft.sections
  }

  // 二 · 逐节的断言：动作名在不在绑好的表里（给了那一份表才算这一条）。
  const outputs: Record<ActionName, readonly RelPath[]>[] = []
  if (input.from === 'draft' && deps.actions !== undefined) {
    const table = deps.actions
    sections.forEach((s, i) => outputs.push(outputsOf(s, table, i + 1, problems)))
  }

  // 三 · 构造：值域持有者逐字段核 · 跨字段两条 · `seed` 超限拒发（全在 `build` 里，一处实现）。
  //     **量法在这里装**：种子是路径的指针，而账量的是"这些指针在某一棵树上取出多少"——所以
  //     `load` 要在构造之前跑完，构造器收的才是量过的那个数。
  let built: Built | null = null
  if (problems.length === 0) {
    if (deps.seedRuler !== undefined) await deps.seedRuler.load(seeds.flat())
    const tokens = deps.seedRuler?.tokensOf ?? deps.seedTokens ?? seedTokensOf
    const actionOutputsOf = input.from === 'split' ? deps.actionOutputsOf : (n: number) => outputs[n] ?? {}
    try {
      built = build(intent, {
        round: deps.round,
        base: deps.base,
        identityFor: deps.identityFor,
        split,
        seedOf: (n: number) => [...(seeds[n] ?? [])],
        ...(actionOutputsOf === undefined ? {} : { actionOutputsOf }),
        seedTokens: tokens,
        ...(deps.seedLimit === undefined ? {} : { seedLimit: deps.seedLimit }),
        ...(deps.modelLimit === undefined ? {} : { modelLimit: deps.modelLimit }),
      })
    } catch (err) {
      if (!(err instanceof BuildError)) throw err
      problems.push(...err.message.split('\n').filter((line) => line !== ''))
    }
  }

  // 四 · 预检：`Planning` 那一档的权威判定。**相交只报对数，照发**（PLAN § 5.7 的口径一）——
  //     判决那两行住在 `precheck.ts`，这一份不自己 if 一遍。
  const precheck = built === null ? null : planningGate(built.contracts).result

  return { held: built !== null && problems.length === 0, problems, draft, intent, built, precheck }
}
