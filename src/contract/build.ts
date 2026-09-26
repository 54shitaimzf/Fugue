// M11 的构造器：轮级意图 → N 份契约值。出处：架构 § 8.12（「契约是不可变值；可变的是构造它的
// 过程」· 第 3 级跨字段关系 · `seed` 那两条准则 · 超限拒绝派发）· 架构 § 14.1 的 `SpawnKit` 那七步
// 里的第 1 步与第 4 步 · PLAN § 5.7 的 A1 行。
//
// **它只造值，不派发。** 派发是 A4（起分支 · 落 `contract/issue`）；这一份的出口是三份/一批契
// 约值，加一份"逐字段核对过"的保证。这样排的理由是 PLAN § 5.7 的顺序表：契约是这一站第一个要造
// 的**值**，构造器定下来，后面每一条断言才有东西可派。
//
// **构造器不猜、不补、不"尽力解释"。** 草案缺键或类型不对就报错退回——一旦允许补全，"哪些字段
// 存在"就从类型退化成了构造器的善意（架构 § 8.12）。
//
// **三处向构造过程贡献字段，构造完成即产出定值**（架构 § 8.12 那张值域持有者表）：
// `id` 由这里生成 · `agent`/`branch` 由身份分配器给 · 其余来自意图与拆分。于是这一份里唯一
// "做判断"的地方只有三处，逐处都指得出出处：
//
//   一 · **`id` 的形状与序号**：`<轮次>.<变体>.<序号>`，逐变体从 1 起。它同时是"不跨轮复用"
//        （D9）那条的落地——轮次在 id 里，换个轮次就是另一批号。
//   二 · **`evidenceRequired` 的产物目录**：`evidence.<agent>.<note>`，三份契约三种落法，逐 agent
//        不同、逐 agent 稳定，因此它随最后一段进 B 区（架构 § 8.11），且**不可能与任何契约相交**。
//   三 · **`actionOutputs ⊆ ownedPaths`**：不作判断，只核。不成立就当场退回（架构 § 8.12：那个
//        动作本来会在执行中途被拒，而它本该在派发前就报错）。
import { identSegments } from '../identity.ts'
import { estimateTokensOfText } from '../runtime/budget.ts'
import { isSegment } from '../roots/paths.ts'
import type { ActionName, BranchId, CommitId, ContractId, RelPath, RoundId } from '../terms.ts'
import type { Assertion, Contract, Evidence, ImplementContract, InvestigateContract, ResolveContract } from './types.ts'
import {
  DEFAULT_MODEL_LIMIT,
  EVIDENCE_PREFIX,
  HANDOFF_MARGIN,
  seedLimitOf,
  VARIANT_FIELDS,
  ZONE_A_BUDGET,
  checkContract,
} from './types.ts'

/** 这一层自己的失败：草案不成立 · 跨字段关系不成立 · 种子超限。**拒，并且指得出是哪一条。** */
export class BuildError extends Error {}

/**
 * 轮级意图：**用户要求的 agent 理解版**（架构 § 15.1）。它就是 `Contract.goal` 的上一层，
 * 全部契约的 `goal` 都是它的切片——所以它不需要新形态。
 *
 * `question` 与 `evidenceRequired` 是**这一轮里要不要派调查型契约**以及要它交什么的那两条。
 * 它们留空就是不派：`investigate` 不是缺省，缺席就是缺席（架构 § 8.12：三种契约的差别是真实的）。
 */
export interface Intent {
  readonly goal: string
  /** 要查清的那一个问题。要给调查型契约就给，不给就不派。 */
  readonly question?: string
  /** 要它交的证据：`note` 是要求的形状，`artifact` 由构造器按位置定名（给了也只当备注）。 */
  readonly evidenceRequired?: readonly { readonly note: string }[]
}

/**
 * 拆分草案的一份：`implement` 的那一格（架构 § 15.1.a 的草案"键就是契约的键"）。
 *
 * **只带持轮者能定的那几笔。** 身份（`agent` · `branch`）由分配器给，`id` 由构造器给，
 * `seed` 与 `actionOutputs` 由预备态与动作绑定给——都不在这里。
 */
export interface SplitAssignment {
  readonly goal: string
  /** 写入集上界。**只可收窄，不可扩宽**（架构 § 8.12）：收窄不破坏 D6，扩宽使 Zone B 失效。 */
  readonly ownedPaths: readonly RelPath[]
  readonly deliverables?: readonly { readonly path: RelPath; readonly form: string }[]
  /** 这一份的验收项。不给就退回——零条断言会让「打回率低」这句话没有分母。 */
  readonly assertions: readonly Assertion[]
}

/** 一个 agent 的位置：三样身份由分配器给，构造器不认识它是怎么发出来的。 */
export interface Identity {
  readonly agent: string
  readonly branch: BranchId
}

/** 一次冲突报告：`M13` 给的那几样（架构 § 8.12 那张表的最后两行）。 */
export interface ConflictReport {
  readonly base: CommitId
  readonly conflictPaths: readonly RelPath[]
  /** 给这一份契约的验收项。冲突解决要能证明解对了，所以它同样非空。 */
  readonly assertions: readonly Assertion[]
  /** 不给人话的时候按冲突路径拼一句。 */
  readonly goal?: string
}

/**
 * 造契约要的那几样**冻结输入**。逐样都指得出出处：
 *
 *   `round` 是 `Idle → Planning` 那一刻定下的轮次号（架构 § 8.13）；
 *   `base` 是**轮次开始时钉住的那个提交**（架构 § 8.14 的 C7 前半）——它由调用方一次读定，
 *   构造器不自己去读 HEAD：一份契约里的底与四条分支的底要**是同一个提交**（架构 § 4），
 *   而"同一个"只有"一次读定再传下来"保证得了。
 *   `seedTokens` 走调用方：种子是路径的指针，**量它取决于从哪一棵树取**（视图 · 工作区），
 *   而构造器不认识树。
 */
export interface BuildDeps {
  readonly round: RoundId
  readonly base: CommitId
  /** 第 `n` 个 agent 的身份（从 0 起）。给不出就拒——**不猜、不补**。 */
  readonly identityFor: (n: number) => Identity
  /** 拆分草案：一份一个 `implement`。给空数组就是不派实现型契约。 */
  readonly split?: readonly SplitAssignment[]
  /** 冲突报告：给了就造一份 `resolve`。 */
  readonly conflicts?: ConflictReport
  /** 每份契约的 `seed`（该阶段所需文件的指针 · 自重启时是该分支最近的几个改动文件）。 */
  readonly seedOf: (n: number) => readonly RelPath[]
  /** 动作绑定声明的产出：`动作名 → 产出路径`。**必须落在那份契约的 `ownedPaths` 内。** */
  readonly actionOutputsOf?: (n: number) => Readonly<Record<ActionName, readonly RelPath[]>>
  /** 一份种子的量怎么算（token）。不给就量指针清单（`seedTokensOf`）。 */
  readonly seedTokens?: (paths: readonly RelPath[]) => number
  readonly seedLimit?: number
}

/** 一次构造的产出：那几份值，加一句"逐字段核对过"。 */
export interface Built {
  readonly contracts: readonly Contract[]
  /** 这一批里各变体各几份。**空数组也是合法的一批**（那一轮不派这类活）。 */
  readonly counts: Readonly<Record<Contract['kind'], number>>
  readonly seedLimit: number
  /** 逐份的种子量（token 估账），给"超限拒绝派发"那句话里的两个数用。 */
  readonly seedTokens: readonly number[]
}

/**
 * 一份种子的量：**指针清单按那把尺估**（一条路径一行）——上限 88,000 是一个 token 数
 * （模型上限 − Zone A 预算 − 交接余量），量它的这一头因此也必须是 token，两头的口径才是同一个。
 *
 * **它量的是清单，不是内容**：内容有多少要读了树才知道，而构造器不认识树。所以调用方可以递
 * 一份自己的量法（`BuildDeps.seedTokens`）；缺省这一份量的是清单本身。
 */
export function seedTokensOf(paths: readonly RelPath[]): number {
  return estimateTokensOfText(paths.join('\n'))
}

function need(what: string, v: unknown): void {
  if (typeof v !== 'string' || v === '') throw new BuildError(`${what}不能是空的`)
}

/** 一个轮次号与一个变体，逐号发下去。序号从 1 起——`idShapeOf` 认的就是这个形状。 */
function idOf(round: RoundId, kind: Contract['kind'], n: number): ContractId {
  return `${round}.${kind}.${n}`
}

/** `seed` 超限：**拒绝派发，不是裁剪后照发**（架构 § 8.12）。话里带两个数——都是 token。 */
function assertSeedFits(seed: readonly RelPath[], limit: number, tokens: (p: readonly RelPath[]) => number): number {
  const n = tokens(seed)
  if (n > limit) {
    throw new BuildError(
      `种子超限：${n} token > 上限 ${limit} token（模型上限 − Zone A − 交接余量）——` +
        `超限要拒绝派发，不是裁剪后照发（架构 § 8.12）`,
    )
  }
  return n
}

/** 逐字段调用各持有者的检查，报出来就退回。**不落地。** */
function validate(contracts: readonly Contract[], ctx: { seedTokens: (p: readonly RelPath[]) => number; seedLimit: number }): void {
  const problems: string[] = []
  for (const c of contracts) {
    for (const m of checkContract(c, ctx)) problems.push(`${c.id}：${m}`)
  }
  if (problems.length > 0) {
    throw new BuildError(`造出来的契约过不了那份清单（构造器不猜、不补）：\n  ${problems.join('\n  ')}`)
  }
}

/** 这一份清单对不对得起三个变体的字段表。**载入时炸**，与 `types.ts` 那道封口同一条纪律。 */
export function variantFieldsMatch(fields: Readonly<Record<string, readonly string[]>>, got: readonly Contract[]): string[] {
  return got
    .map((c) => ({ c, want: [...(fields[c.kind] ?? [])].sort() }))
    .filter(({ c, want }) => {
      const have = Object.entries(c as unknown as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k)
        .sort()
      return have.join(' ') !== want.join(' ')
    })
    .map(({ c, want }) => `${c.id} 的字段与 ${c.kind} 那一份对不上：${want.join(' · ')}`)
}

/**
 * 把一轮意图与一份拆分草案造成契约值。
 *
 * 顺序是承重的：**先逐份造 · 再逐份核对 · 再一次性交出去**。中途不交半批——一批里有一份过不了
 * 清单，整批退回。这与"超限要拒绝派发"同一条纪律：半批契约派出去，那一轮的分母就残了。
 */
export function build(intent: Intent, deps: BuildDeps): Built {
  need('意图的总目标', intent.goal)
  need('轮次号', deps.round)
  need('钉住的底', deps.base)

  const limit = deps.seedLimit ?? seedLimitOf({ seedLimit: deps.seedLimit })
  const tokens = deps.seedTokens ?? seedTokensOf
  const out: Contract[] = []
  const seedTokens: number[] = []

  /** 第 `n` 个身份（从 0 起）。**给不出就拒**，构造器不替分配器猜。 */
  const idAt = (n: number): Identity => {
    const id = deps.identityFor(n)
    need(`第 ${n + 1} 个 agent 的名字`, id.agent)
    need(`第 ${n + 1} 个 agent 的分支`, id.branch)
    return id
  }

  // 一 · 调查型：一份（这一轮要不要调查，由意图里有没有那个问题定）。
  let idx = 0
  if (intent.question !== undefined) {
    need('调查的问题', intent.question)
    const id = idAt(idx)
    const seed = [...deps.seedOf(idx)]
    seedTokens.push(assertSeedFits(seed, limit, tokens))
    const evidence = evidenceFor(id.agent, intent)
    out.push({
      kind: 'investigate',
      id: idOf(deps.round, 'investigate', 1),
      agent: id.agent,
      branch: id.branch,
      goal: intent.goal,
      question: intent.question,
      evidenceRequired: evidence,
      seed,
    } satisfies InvestigateContract)
    idx++
  }

  // 二 · 实现型：一份草案一份契约。**序号与身份按同一顺序发下去**，于是"第 n 份契约"在一批里
  // 只有一个意思——A4 落 `contract/issue` 与起分支时读的就是这个顺序。
  const split = deps.split ?? []
  split.forEach((one, i) => {
    need(`第 ${i + 1} 份草案的目标`, one.goal)
    if (!Array.isArray(one.ownedPaths) || one.ownedPaths.length === 0) {
      throw new BuildError(`第 ${i + 1} 份草案的 ownedPaths 不能是空的：写入集是那份契约的判据（架构 § 8.12）`)
    }
    if (!Array.isArray(one.assertions) || one.assertions.length === 0) {
      throw new BuildError(
        `第 ${i + 1} 份草案没有断言：零条断言会让「打回率低」这句话没有分母（PLAN § 5.7 的地板第二档）`,
      )
    }
    const id = idAt(idx)
    const seed = [...deps.seedOf(idx)]
    seedTokens.push(assertSeedFits(seed, limit, tokens))
    out.push({
      kind: 'implement',
      id: idOf(deps.round, 'implement', i + 1),
      agent: id.agent,
      branch: id.branch,
      goal: one.goal,
      ownedPaths: [...one.ownedPaths],
      deliverables: [...(one.deliverables ?? [])],
      assertions: [...one.assertions],
      seed,
      actionOutputs: copyOutputs(deps.actionOutputsOf?.(idx) ?? {}),
    } satisfies ImplementContract)
    idx++
  })

  // 三 · 解决型：一次冲突报告一份契约。**写入集 = 冲突路径集**，不另立一个字段——
  // 那两样是同一个集合（架构 § 8.12），所以这里不读 `ownedPaths`，它压根不在这个变体上。
  if (deps.conflicts !== undefined) {
    const rep = deps.conflicts
    need('冲突报告里的底', rep.base)
    if (!Array.isArray(rep.conflictPaths) || rep.conflictPaths.length === 0) {
      throw new BuildError('冲突报告里一条冲突路径都没有——那就没有要解的冲突，不该造解决型契约')
    }
    if (!Array.isArray(rep.assertions) || rep.assertions.length === 0) {
      throw new BuildError('解决型契约没有断言：「解对了没有」就没有判据（架构 § 8.14 第 6 步）')
    }
    const id = idAt(idx)
    out.push({
      kind: 'resolve',
      id: idOf(deps.round, 'resolve', 1),
      agent: id.agent,
      branch: id.branch,
      goal: rep.goal ?? `解掉这些路径上的冲突：${rep.conflictPaths.join(' · ')}`,
      base: rep.base,
      conflictPaths: [...rep.conflictPaths],
      assertions: [...rep.assertions],
    } satisfies ResolveContract)
  }

  const bad = variantFieldsMatch(VARIANT_FIELDS, out)
  if (bad.length > 0) throw new BuildError(`造出来的契约与三个变体的字段表对不上：\n  ${bad.join('\n  ')}`)
  validate(out, { seedTokens: tokens, seedLimit: limit })

  const counts: Record<Contract['kind'], number> = { implement: 0, investigate: 0, resolve: 0 }
  for (const c of out) counts[c.kind]++
  return { contracts: out, counts, seedLimit: limit, seedTokens }
}

/** 动作绑定的产出拷一份：契约是不可变值，交给调用方的那一份不该与调用方手里那份共用一个对象。 */
function copyOutputs(src: Readonly<Record<ActionName, readonly RelPath[]>>): Record<ActionName, readonly RelPath[]> {
  const out: Record<ActionName, readonly RelPath[]> = {}
  for (const [k, v] of Object.entries(src)) out[k] = [...v]
  return out
}

/**
 * 调查型的产物目录：**按位置定名**——`evidence/<agent 的每一段>/<备注>`。
 *
 * 三处是这个位置的性质，不是排版：`evidence` 是这一类产物的固定前缀（构造器一处给）；
 * agent 那几段让逐 agent 不同、逐 agent 稳定，因此它随最后一段进 B 区（架构 § 8.11）；
 * 最后一段是人写给自己的那条备注。**写入面因此不与任何契约相交**——两份契约的 agent 不是
 * 同一条身份名，于是 `evidence/` 底下那两条路径逐段不同，一个不可能是另一个的前缀。
 *
 * **agent 那几段要摊开，不能拼成一个带斜杠的段。** 身份名本身就是一条路径（§ 4 的
 * `agent/<round>/<n>` 就是三层目录，`identity.ts` 的文件头），所以 `r1/1` 落出来的目录是
 * `evidence/r1/1/<备注>`——**一个目录，不是三个**。反过来说：把 `evidence.r1/1.备注` 这样一串
 * 当成一个名字，那个名字里就带着分隔符，它落到树里的哪一层由读者去猜。
 *
 * 段名过 `identSegments`：与 `mat/<agent>/` · `log/<writer>.jsonl` 同一条规矩，名字落在两侧
 * 是同一份答案。备注因此是一个段——带斜杠 · 带点 · 空段在这里当场被拒。
 */
export function evidenceFor(agent: string, intent: Intent): Evidence[] {
  const who = identSegments(agent, '证据所属的 agent')
  const required = intent.evidenceRequired ?? []
  return required.map((one, i) => {
    const note = one.note.trim()
    const name = note === '' ? `note-${i + 1}` : note
    // 备注**是一个段，不是一条路径**：`identSegments` 收 `a/b`（它是合法的身份名），
    // 而备注收下它就等于让人自己指定目录层次——那正是"按位置定名"要收上来的东西。
    // 一个段的规矩只有一处实现（`M3` 的 `isSegment`），这里用它。
    if (!isSegment(name)) {
      throw new BuildError(`第 ${i + 1} 条证据的备注要是一个段（不含 / 与 \\，不以点开头）：${JSON.stringify(one.note)}`)
    }
    const artifact = [EVIDENCE_PREFIX, ...who, name].join('/')
    identSegments(artifact, `第 ${i + 1} 条证据的产物目录`)
    return { artifact, note: one.note }
  })
}

/** 构造器认的那几个字面量，给走查与报告印用。 */
export const KIND_OF: Readonly<Record<Contract['kind'], string>> = {
  implement: '实现型：写入集由持轮者声明（`ownedPaths`），交付物与断言随契约',
  investigate: `调查型：产物落在构造器按位置定名的专属目录（\`${EVIDENCE_PREFIX}/<agent 的每一段>/<备注>\`），因此不与任何契约相交`,
  resolve: '解决型：写入集 = 冲突路径集（`conflictPaths`），底是冲突报告给的那棵树',
}

/** 模型上限的缺省三件套，给报告印"上限是怎么算出来的"用。 */
export const SEED_BUDGET = {
  model: DEFAULT_MODEL_LIMIT,
  zoneA: ZONE_A_BUDGET,
  handoff: HANDOFF_MARGIN,
} as const
