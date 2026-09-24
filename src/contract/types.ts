// M11 的三个形状与那份核对清单。出处：架构 § 8.12（三种契约的字段表 · 值域持有者表 ·
// 可验性的三级分工）· 架构 § 14.6（`verifyGate` 的两个消费者）· 架构 § 23 U9（S7 的 A0 关掉它）。
//
// **A0 只定形状，不造值。** 这一份里没有一件事会去造契约——构造是 A1（`build.ts`）、相交是 A2
// （`precheck.ts`）。U9 是这一站的**入口条件**，与 S6 的 U7 同一个位置：三个形状不补齐，后面
// 八个单元对"一条断言"各写各的，而"打回率"这个读数连分母都没有。
//
// **`AssertionResult` 不在这里，在 `terms.ts`。** 它进 § 8.1 的 `merge/accept` 事件，而那份
// 事件联合只依赖 `terms.ts` 那份词汇表。两处各写一份的话，"三档"这句话就有两个定义——
// 其中一个会漂。`terms.ts` 另起一个 `AssertionVerdict` 收它，是为了让取值与档案分开：
// 取值进事件（判别联合），档案进契约（报告与打回率读它）。
//
// **三级分工在这一份里的样子**（架构 § 8.12 那张表逐行落地）：
//
//   本体（判别联合）  哪些字段存在      `Contract` 的三个变体 + `contractFields()`
//   字段类型          值是否合法        `FIELD_RULES`：一格一个值域持有者，指得出它住哪
//   构造器            跨字段与跨契约    `checkContract()` 里那两条跨字段的关系（A2 收跨契约）
//
// **可验性在字段类型上，不在契约本体上。** 因此这里没有"契约对不对"这一层判断，只有"这个
// 字段的值合不合法"；"这个值现在能不能用"（路径 × 视图 × 策略）是**关系**，归第三级。
import type { ActionName, AssertionResult as AssertionVerdictRecord, AssertionVerdict, CommitId, RelPath } from '../terms.ts'
import { isRelPath } from '../roots/paths.ts'

/**
 * 一条可执行的验收项（架构 § 23 U9：**已定（S7 的 A0）**）。
 *
 * 三样缺一不可：**命令**（哪一件事要跑）· **期望**（跑成什么样才算过）· **在哪跑**（在树的哪一处）。
 * 命令用**动作名**而不是裸命令行，理由与 `run_action` 同一条：执行要过 `M7` 的沙箱与 `M5` 的
 * 执行器，动作绑定（§ 15.3.a）是那条路上唯一一处声明点。裸命令行会让验收门绕开隔离——
 * 而"验收集"与"动作集"分成两套，就是把同一条执行路写两遍。
 *
 * `name` 是**给失败时指认用的**：`AssertionResult` 的第三档要"指出是哪一条断言的哪一步
 * 跑不起来"（§ 8.12 末段），而那一步靠名字指。
 */
export interface Assertion {
  /** 工作区配置 `actions.<名字>` 里的那个名字。值域持有者：工作区配置的候选 · 验证门的可执行性。 */
  readonly action: ActionName
  /** 指认用：报出来的话里带它。 */
  readonly name: string
  /** 视图内的相对路径，缺省 `''`（树的根）。两个消费者同一个口径：自己的视图 · 合并那棵树。 */
  readonly where?: RelPath
  /** 期望的退出码，缺省 0。判"没通过"与"通过"就看这一个数。 */
  readonly expect?: number
}

/**
 * 交付物：路径与形态（架构 § 23 U9）。
 *
 * **形态不带枚举。** 在这里给一组闭集，等于替工作区配置做决定，而配置是这个字段唯一的值域
 * 持有者（架构 § 8.12 那张表）。它今天要回答的问题只有一个——"这条交付物是什么"，
 * 好让人读报告时不必去猜。
 */
export interface Deliverable {
  readonly path: RelPath
  readonly form: string
}

/**
 * 契约本体：三个变体（架构 § 8.12 逐字）。
 *
 * **三种契约的差别是真实的，不是字段缺省。** 三种的写入面来源各不相同，而每一种都有写入面：
 * `implement` 由持轮者给的 `ownedPaths` 声明；`resolve` 等于它的冲突路径集；`investigate`
 * 的产物落在构造器按位置定名的专属目录里——因此它的写入面**不可能与任何契约相交**，不需要
 * 相交预检。把三者压成一个"字段全带、多数为空"的记录，会让每个消费方处理对它无意义的字段。
 */
export interface ContractBase {
  readonly id: string
  readonly agent: string
  readonly branch: string
  readonly goal: string
}

export interface ImplementContract extends ContractBase {
  readonly kind: 'implement'
  /** 写入集上界，派发时冻结。只可收窄，不可扩宽（架构 § 8.12）。 */
  readonly ownedPaths: readonly RelPath[]
  readonly deliverables: readonly Deliverable[]
  readonly assertions: readonly Assertion[]
  /** 预备态列出的该阶段所需文件的指针（初次派发）或该分支最近的几个改动文件（自重启）。 */
  readonly seed: readonly RelPath[]
  /** 动作声明的产出：必须落在 `ownedPaths` 内（第 3 级跨字段关系）。 */
  readonly actionOutputs: Readonly<Record<ActionName, readonly RelPath[]>>
}

export interface InvestigateContract extends ContractBase {
  readonly kind: 'investigate'
  readonly question: string
  readonly evidenceRequired: readonly Evidence[]
  readonly seed: readonly RelPath[]
}

export interface ResolveContract extends ContractBase {
  readonly kind: 'resolve'
  /** `M13` 的冲突报告给的那棵树：解决要基于冲突发生处，不是自己的底。 */
  readonly base: CommitId
  /** 写入集 = 冲突路径集，不另立一个字段——两者是同一个集合（架构 § 8.12 那张表）。 */
  readonly conflictPaths: readonly RelPath[]
  readonly assertions: readonly Assertion[]
}

export type Contract = ImplementContract | InvestigateContract | ResolveContract

/** 持轮者说要哪些证据，构造器说放哪：目录名是契约在集合中位置的纯函数。 */
export interface Evidence {
  readonly artifact: RelPath
  readonly note: string
}

/** 这份清单对着一份契约报出来的问题，逐条是人话。空数组 = 没问题。 */
export type ContractIssue = string

// ── 值域持有者：一格一处，指得出它住哪 ────────────────────────────────────────
//
// 架构 § 8.12：「预检因此是一个动作，不是一层。构造完成后按声明式清单逐项调用各持有者自己的
// 检查，全部不落地。持有者是既有模块，检查是既有代码路径——**不引入新的接口类型**。」
//
// 所以下面这一格一格**不是检查器实现**，而是"这一格的值域归谁"这条事实加一句它会说的话。
// 凡持有者已有代码路径的（路径语法 · 动作名 · 提交名 · 证据的形状），这里就调它。

/** 一笔：一个字段名 · 它的值域持有者 · 它自己的检查。 */
export interface FieldRule {
  /** 值域持有者，指得出它住哪（架构 § 8.12 那张表的第三列）。 */
  readonly holder: string
  /** `null` = 这个值合法；一串话 = 为什么不合法。**只判"什么算一个合法的 X"。** */
  readonly check: (value: unknown) => string | null
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function nonEmptyString(v: unknown, what: string): string | null {
  if (typeof v !== 'string') return `${what}要是一个字符串`
  if (v === '') return `${what}不能是空的`
  return null
}

/** 视图内的路径：语法归 `M3` 的 `isRelPath` 一处判（`..` · `\\` · 空字节 · 绝对路径都在那里拒）。 */
function pathField(v: unknown, what: string): string | null {
  if (typeof v !== 'string') return `${what}要是一个字符串`
  if (!isRelPath(v)) return `${what}不是视图内的路径：${JSON.stringify(v)}（语法归 M3 的 isRelPath 一处判）`
  return null
}

/**
 * 一条路径的**上界**位置：非空且不是视图的根。
 *
 * 空串是视图的根——一份"写入集 = 视图的根"的契约把所有东西都算进来了，这正是相交预检要拦
 * 的形状（A2）。种子同理：整棵树当种子，前缀里装不下。
 */
function upperBoundField(v: unknown, what: string): string | null {
  const bad = pathField(v, what)
  if (bad !== null) return bad
  return v === '' ? `${what}不能是视图的根（空串）——上界要指到具体位置` : null
}

function pathArrayField(v: unknown, what: string, item: (p: unknown, w: string) => string | null): string | null {
  if (!Array.isArray(v)) return `${what}要是一个数组`
  const bad: string[] = []
  v.forEach((p, i) => {
    const one = item(p, `${what}[${i}]`)
    if (one !== null) bad.push(one)
  })
  return bad.length === 0 ? null : bad.join('；')
}

/** 契约的 id：`<轮次>.<变体>.<序号>`（A1 的构造器按这个形状发）。**序号从 1 起。** */
export function idShapeOf(id: unknown): { round: string; kind: 'implement' | 'investigate' | 'resolve'; n: number } | null {
  if (typeof id !== 'string') return null
  const parts = id.split('.')
  if (parts.length !== 3) return null
  const [round, kind, tail] = parts
  if (round === '' || round.includes('/')) return null
  if (kind !== 'implement' && kind !== 'investigate' && kind !== 'resolve') return null
  if (!/^[1-9][0-9]*$/.test(tail)) return null
  return { round, kind, n: Number(tail) }
}

function assertionProblem(a: unknown, what: string): string | null {
  if (!isObject(a)) return `${what}要是一个对象`
  const bad: string[] = []
  const action = nonEmptyString(a.action, `${what}.action`)
  if (action !== null) bad.push(action)
  const name = nonEmptyString(a.name, `${what}.name`)
  if (name !== null) bad.push(name)
  if (a.where !== undefined) {
    const where = pathField(a.where, `${what}.where`)
    if (where !== null) bad.push(where)
  }
  if (a.expect !== undefined) {
    const expect = a.expect
    if (typeof expect !== 'number' || !Number.isInteger(expect) || expect < 0 || expect > 255) {
      bad.push(`${what}.expect 要是一个 0–255 之间的整数`)
    }
  }
  return bad.length === 0 ? null : bad.join('；')
}

function deliverableProblem(d: unknown, what: string): string | null {
  if (!isObject(d)) return `${what}要是一个对象`
  const bad: string[] = []
  const path = upperBoundField(d.path, `${what}.path`)
  if (path !== null) bad.push(path)
  const form = nonEmptyString(d.form, `${what}.form`)
  if (form !== null) bad.push(form)
  return bad.length === 0 ? null : bad.join('；')
}

function evidenceProblem(e: unknown, what: string): string | null {
  if (!isObject(e)) return `${what}要是一个对象`
  const bad: string[] = []
  const artifact = upperBoundField(e.artifact, `${what}.artifact`)
  if (artifact !== null) bad.push(artifact)
  const note = nonEmptyString(e.note, `${what}.note`)
  if (note !== null) bad.push(note)
  return bad.length === 0 ? null : bad.join('；')
}

function listProblem(
  v: unknown,
  what: string,
  item: (x: unknown, w: string) => string | null,
  opts: { nonEmpty?: boolean } = {},
): string | null {
  if (!Array.isArray(v)) return `${what}要是一个数组`
  if (opts.nonEmpty === true && v.length === 0) return `${what}不能是空的`
  const bad: string[] = []
  v.forEach((x, i) => {
    const one = item(x, `${what}[${i}]`)
    if (one !== null) bad.push(one)
  })
  return bad.length === 0 ? null : bad.join('；')
}

/**
 * 一格一个值域持有者。**键是字段名，值是这一格归谁。**
 *
 * 值的这一面只判"这个值合不合法"。像"这条路径现在存不存在"、"这个动作绑定现在在不在配置里"
 * 这类问题**不在这里**——它们是关系（路径 × 视图 × 策略），归第三级。
 */
export const FIELD_RULES: Readonly<Record<string, FieldRule>> = {
  // 这一格是三个变体的判别键。"它已经由联合类型保证了"在这里不成立：`checkContract` 收的是
  // 一份从别处来的值（配置 · 草稿 · 日志里读回来的），那一刻 `kind` 还只是一串字符。
  kind: {
    holder: '契约本体（三个变体）',
    check: (v) =>
      v === 'implement' || v === 'investigate' || v === 'resolve'
        ? null
        : `kind 取 implement · investigate · resolve 之一：${JSON.stringify(v)}`,
  },
  id: {
    holder: 'M11（唯一生成者）——形状见 idShapeOf；唯一性由构造器保证：同一个轮次里同一变体逐号发，轮与轮之间不重用（D9）',
    check: (v) => (idShapeOf(v) === null ? `id 要写成 <轮次>.<变体>.<序号>：${JSON.stringify(v)}` : null),
  },
  // 三格身份：值的**存在性**由分配器与 M1 判（分支在不在 · 名字是不是登录名），这里只判它是不是一个名字。
  agent: { holder: '身份分配器（§ 14.1）', check: (v) => nonEmptyString(v, 'agent') },
  branch: { holder: '身份分配器（§ 14.1）；存在性由 M1 判', check: (v) => nonEmptyString(v, 'branch') },
  goal: { holder: 'round/intent（轮级意图是它的上界）', check: (v) => nonEmptyString(v, 'goal') },
  question: { holder: 'round/intent（轮级意图是它的上界）', check: (v) => nonEmptyString(v, 'question') },

  // 两格路径集合：语法归 M3（`isRelPath`），这里只用它。
  ownedPaths: {
    holder: 'M3（路径语法）',
    check: (v) => pathArrayField(v, 'ownedPaths', upperBoundField),
  },
  conflictPaths: {
    holder: 'M13（即报告的冲突路径集）',
    check: (v) => pathArrayField(v, 'conflictPaths', upperBoundField),
  },
  seed: {
    holder: 'M3（路径语法）；上界那一条由构造器按 § 8.12 的两条准则判（见 seedProblems）',
    check: (v) => pathArrayField(v, 'seed', upperBoundField),
  },

  deliverables: {
    holder: '工作区配置',
    check: (v) => listProblem(v, 'deliverables', deliverableProblem, { nonEmpty: true }),
  },
  // `assertions` 留空是合法的：**验收门只剩一条断言那一档**从"零条"开始就没有下限了，
  // 而"零条"会让「打回率低」这句话没有分母。所以这一格非空（PLAN § 5.7 的地板第二档）。
  assertions: {
    holder: '工作区配置（候选）· 验证门（可执行性）',
    check: (v) => listProblem(v, 'assertions', assertionProblem, { nonEmpty: true }),
  },
  evidenceRequired: {
    holder: 'M3（路径合法性）· M13（增量核对）',
    check: (v) => listProblem(v, 'evidenceRequired', evidenceProblem, { nonEmpty: true }),
  },

  actionOutputs: {
    holder: '系统级动作白名单（ActionName）· 构造器（⊆ ownedPaths）',
    check: (v) => {
      if (!isObject(v)) return 'actionOutputs 要是一个对象：键是动作名，值是产出路径'
      const bad: string[] = []
      for (const [k, paths] of Object.entries(v)) {
        if (k === '') bad.push('actionOutputs 里有一个空的动作名')
        const one = pathArrayField(paths, `actionOutputs.${k}`, upperBoundField)
        if (one !== null) bad.push(one)
        else if ((paths as readonly string[]).length === 0) bad.push(`actionOutputs.${k} 是空的：声明了动作却不声明产出`)
      }
      return bad.length === 0 ? null : bad.join('；')
    },
  },
  base: { holder: 'M1', check: (v) => nonEmptyString(v, 'base') },
}

/**
 * 丑话在前：**这一处封的是"静默失效"，不是"写错了"**。
 *
 * 加一个字段的代价由架构 § 8.12 定成恒定的三处：变体里加一笔 · 指名值域持有者 · 消费方调用
 * 那一个检查。第二处漏了的话，新字段进不了清单——于是它**一个检查都不跑**，而"这份契约没问题"
 * 与"这个字段没人看"在读数上长得一模一样。所以载入时当场炸，与 `M8` 的能力表同一条纪律
 * （那边是"少一格都编译不过"，这边是"少一格就是一格静默"）。
 */
export function unownedFields(
  fields: Readonly<Record<string, readonly string[]>>,
  rules: Readonly<Record<string, { holder: string }>>,
): string[] {
  const out: string[] = []
  for (const [kind, names] of Object.entries(fields)) {
    for (const n of names) {
      if (rules[n] === undefined) out.push(`${kind} 的 ${n} 没有值域持有者`)
    }
  }
  return out
}

/** 一个变体有哪几个字段。**这是"哪些字段存在"的机器可读副本**（本体那一级）。 */
export const VARIANT_FIELDS: Readonly<Record<Contract['kind'], readonly string[]>> = {
  implement: ['kind', 'id', 'agent', 'branch', 'goal', 'ownedPaths', 'deliverables', 'assertions', 'seed', 'actionOutputs'],
  investigate: ['kind', 'id', 'agent', 'branch', 'goal', 'question', 'evidenceRequired', 'seed'],
  resolve: ['kind', 'id', 'agent', 'branch', 'goal', 'base', 'conflictPaths', 'assertions'],
}

/**
 * 一份契约实际带着哪几个字段：**判别联合那一级的答案**，也是值域持有者表的键集。
 *
 * 它不读 `VARIANT_FIELDS`——那一份是给"三个变体各该有哪几笔"这条断言做对照用的。合成一份
 * 契约的字段清单之后自己核自己，那是恒等式，测不出漂移。
 */
export function contractFields(c: Contract): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(c as unknown as Record<string, unknown>)) {
    if (v !== undefined) out.push(k)
  }
  return out.sort()
}

/** 只构造一次的形状核对。`bad` 在模块载入时算出来，不放进函数里每调一次重算。 */
const bad = unownedFields(VARIANT_FIELDS, FIELD_RULES)
if (bad.length > 0) {
  throw new Error(`契约的字段与值域持有者对不上：\n  ${bad.join('\n  ')}`)
}

// ── `AssertionResult` 的三档 ──────────────────────────────────────────────────
//
// 架构 § 8.12 末段：**一次验收有三种结果，不是两种。** 前两样关于契约（活干得对不对），
// 第三样关于仪器（这条断言根本执行不了）。分开的理由是打回率这个读数——把仪器故障并进
// "没通过"，一次环境问题就会让读数飙高，而读数一脏，下一轮拿它改拆分就改错了方向。

/**
 * 一条断言的判决**档案**：取值那一档是 `terms.ts` 的 `AssertionVerdict`，这里补上人要看的那几样。
 *
 * 形状收得比事件要的窄（`verdict` 从那个联合收成三个字面量之一），所以它照样进得了
 * `merge/accept`；而反过来不成立——事件那一头不承诺 `exit` 这些字段，因为它不该读它们。
 */
export type AssertionResult = AssertionVerdictRecord & {
  readonly verdict: AssertionVerdict
  /** 给人读的一句话：哪一步 · 退出码 · 为什么跑不起来。 */
  readonly note: string
  /** 跑起来了才有：真实的退出码与它花了多久。 */
  readonly exit?: number
  readonly ms?: number
  /** 期望的退出码，跑起来了才有——`fail` 那一档靠它指认差在哪。 */
  readonly expect?: number
}

/** 一条断言跑出来的东西：三档之一。`note` 是给人读的：哪一步 · 退出码 · 头几行输出。 */
export type AssertionRun =
  | { readonly kind: 'ran'; readonly ms: number; readonly exit: number; readonly note: string }
  /** 根本没跑成：命令不在 · 工作树里没有那个脚本 · 退出码 127 那一类。 */
  | { readonly kind: 'not-run'; readonly note: string }

/** `expect` 的缺省：期望退出码 0。 */
export const DEFAULT_EXPECT = 0

/**
 * 一条断言的判决。**三档由"跑没跑成"与"对不对"两问定**，不是由退出码一个数定：
 * 没跑成 → `unrunnable`；跑成了且退出码等于期望 → `pass`；跑成了但不等 → `fail`。
 */
export function resultOf(a: Assertion, run: AssertionRun): AssertionResult {
  if (run.kind === 'not-run') return { assertion: a.name, verdict: 'unrunnable', note: run.note }
  const expect = a.expect ?? DEFAULT_EXPECT
  const verdict: 'pass' | 'fail' = run.exit === expect ? 'pass' : 'fail'
  return { assertion: a.name, verdict, note: run.note, exit: run.exit, expect, ms: run.ms }
}

/** 工具那一面用的读法：一条断言是不是过。`unrunnable` 既不是过也不是没过。 */
export function passing(r: AssertionResult): boolean {
  return r.verdict === 'pass'
}

/**
 * 这三档各是什么，给报告与走查印的那一栏用（架构 § 8.12 末段那一段话的行内版本）。
 *
 * **第三档在这一份里不进任何计数**：A8 的三个数只数"没通过"那一档。把这句话写成一个常量，
 * 是为了让"仪器故障不进打回率"这件事有一处指得出来——而不是散在报告代码的 if 里。
 */
export const VERDICTS: Readonly<Record<string, string>> = {
  pass: '通过——跑成了，退出码等于期望',
  fail: '没通过——跑成了，但结果不对（进打回计数）',
  unrunnable: '跑不起来——这条断言根本执行不了（命令不在 · 脚本不在 · 退出码 127 那一类；不进打回计数）',
}

// ── 第三级：跨字段的关系，加上那份清单本身 ────────────────────────────────────

/** 模型的上下文上界，给 `seed` 那条判据当默认值。 */
export const DEFAULT_MODEL_LIMIT = 200_000
/** Zone A（前缀里的稳定那一段）的占地估计。 */
export const ZONE_A_BUDGET = 24_000
/** 交接余量：自重启时要留出的那一片。 */
export const HANDOFF_MARGIN = 16_000

/**
 * 审计一份契约要的那点上下文。**缺省是"不知道"**：种子那一格只在同时给了总量与预算时才判，
 * 否则报"没判"而不是默认放行——这与 § 15.7 的 fail-closed 同一条纪律。
 */
export interface ContractContext {
  readonly seedLimit?: number
  readonly seedBytes?: (paths: readonly RelPath[]) => number
  /** 字节数的算法：UTF-8 的字节。`Buffer` 在宿主上，`TextEncoder` 在两处都在。 */
  readonly limitNote?: string
}

/** `seed` 那一条：总字节 ≤ 模型上限 − Zone A − 交接余量（架构 § 8.12 的两条准则共用一个上界）。 */
export function seedLimitOf(ctx: ContractContext): number {
  if (ctx.seedLimit !== undefined) return ctx.seedLimit
  return DEFAULT_MODEL_LIMIT - ZONE_A_BUDGET - HANDOFF_MARGIN
}

/**
 * `actionOutputs` 声明的输出必须落在 `ownedPaths` 内——否则动作会在执行中途被拒，而它本该在
 * 派发前就报错。这是第 3 级"跨字段关系"除写入集相交之外的第二个实例（架构 § 8.12）。
 */
export function actionOutputsOutside(owned: readonly RelPath[], outputs: Readonly<Record<string, readonly RelPath[]>>): string[] {
  const out: string[] = []
  for (const [action, paths] of Object.entries(outputs)) {
    for (const p of paths) {
      if (!owned.some((o) => p === o || p.startsWith(o + '/'))) {
        out.push(`动作 ${action} 的产出 ${p} 不在 ownedPaths 内`)
      }
    }
  }
  return out
}

/**
 * 那份核对清单：**一个动作，不是一层**（架构 § 8.12）。
 *
 * 逐字段调值域持有者的检查，再跑第三级那两条跨字段关系，全部不落地。报出来的是一串人话，
 * 空数组 = 没问题。**它不认识 git，也不读工作区配置**——"这个值现在能不能用"是关系，
 * 由调用方（A1 的构造器 · A2 的预检）把上下文递进来。
 */
export function checkContract(c: Contract, ctx: ContractContext = {}): ContractIssue[] {
  const issues: string[] = []
  for (const [field, value] of Object.entries(c as unknown as Record<string, unknown>)) {
    if (value === undefined) continue
    const rule = FIELD_RULES[field]
    if (rule === undefined) {
      // 载入时那一处封口已经炸过了；走到这里说明有人绕过了它。**报，不放过。**
      issues.push(`${field} 没有值域持有者：这一格一个检查都不跑`)
      continue
    }
    const one = rule.check(value)
    if (one !== null) issues.push(`${field}：${one}`)
  }
  if (c.kind === 'implement') {
    for (const one of actionOutputsOutside(c.ownedPaths, c.actionOutputs)) issues.push(`actionOutputs：${one}`)
  }
  if (c.kind === 'implement' || c.kind === 'investigate') {
    const bytes = ctx.seedBytes?.(c.seed)
    if (bytes === undefined) {
      // 不判就说出来。**默认放行会让"超限拒绝派发"这句话无处落地。**
      issues.push(`seed：没判超限——这一跑没给 seedBytes（缺省上限 ${seedLimitOf(ctx)} 字节）`)
    } else {
      const limit = seedLimitOf(ctx)
      if (bytes > limit) issues.push(`seed：${bytes} 字节超过上限 ${limit} 字节——超限要拒绝派发，不裁剪后照发`)
    }
  }
  return issues
}
