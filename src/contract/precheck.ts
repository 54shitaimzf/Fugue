// M11 的写入集相交预检。出处：架构 § 8.12（「预检因此是一个动作，不是一层」·「写入集预检跑两次，
// 同一份检查」·「构造相交契约，必须在委派时而非合并时报出」）· 架构 § 8.14 的第 1 步 · D6 ·
// PLAN § 5.7 的 A2 行与"三处口径"第一条。
//
// **它判的是"两个契约会不会写同一处"。** 写入集是每个变体都有的东西，只是来源不同（架构 § 8.12）：
// `implement` 由持轮者声明 · `resolve` 等于它的冲突路径集 · `investigate` 落在构造器按位置定名
// 的专属目录里。所以这一份里第一件事是**把三种来源收成一处**（`writeSetOf`），第二件事才是相交。
//
// **两处调用，同一个函数。** 第一次在 `Planning`——权威判定；第二次在合并前——兜底
// （合并是不可逆点，它不信任上游的检查结果，自己再核一遍，与 § 15.7 硬要求 fail-closed 同一条
// 纪律）。「同一个函数」不是一句承诺：`intersect` 是唯一的判据实现，两处的差只在于拿到那几份契约
// 之后调它一次，以及拿到答案之后做什么。
//
// **一处严宽（这一站定的，见 PLAN § 5.7 的口径一）：相交报出来，照发。**
// 架构 § 8.12 的字面是"相交即拒绝派发"，这一站改成"相交即报出"：拆分的正确性在 S7 之前没有
// 任何读数（§ 8.12 自己写着"拆得太粗与拆得太细都没有事前判据"），而一个没有读数的预检去拦派发，
// 最先拦住的往往是自己拆的错。所以这里**只给判据，不给判决**：
//
//   `intersect(contracts)`        报出相交的那几对与路径（两处都调它）
//   `planningGate(contracts)`     `Planning` 那一档的判决：**报出即放行**，话里带着那几对
//   `mergeGate(contracts)`        合并前那一档的判决：**报出即拒**（不可逆点，兜底那一侧 fail-closed）
//
// 判决的形状留在这两个小函数里，调用点不各自 if 一遍——这样"改主意的代价是它被推回一档"那句话
// 落在一处：把 `planningGate` 的 `ok` 改成 `false` 就是把门立回 `Planning`。
import type { Contract, ContractIssue } from './types.ts'
import { EVIDENCE_PREFIX } from './types.ts'
import type { ContractId, RelPath } from '../terms.ts'

/** 一份契约的写入面，与它的来源。**来源那一栏是给人看的**：报出来的话要指得出这条路径从哪来。 */
export interface WriteSet {
  readonly id: ContractId
  readonly kind: Contract['kind']
  readonly from: string
  readonly paths: readonly RelPath[]
}

/**
 * 三种来源收成一处（架构 § 8.12 那条"每一种都有写入面"）。
 *
 * **`investigate` 的写入面不是一条路径，是一个目录。** 它的产物落在 `evidence/<agent 的每一段>/`，
 * 具体文件名由它自己定——所以它的写入面是那个目录，相交判据正是"一个是不是另一个的前缀"。
 */
export function writeSetOf(c: Contract): WriteSet {
  if (c.kind === 'implement') {
    return { id: c.id, kind: c.kind, from: 'ownedPaths（持轮者声明）', paths: [...c.ownedPaths] }
  }
  if (c.kind === 'resolve') {
    return { id: c.id, kind: c.kind, from: 'conflictPaths（冲突报告给的那个集合）', paths: [...c.conflictPaths] }
  }
  // 调查型：**它占住的是一个目录，不是它祖先的那几层。**
  // 把 `evidence` · `evidence/r1` 也列进来的话，这一份契约自己就与自己相交了——而"同一个写入面
  // 里的两条路径互相包含"是另一件事（自相交，见下）。写入面报的是那份契约占住的**边界**：
  // 一个目录就是一条路径，它覆盖底下的一切由 `covers` 那一处回答。
  return {
    id: c.id,
    kind: c.kind,
    from: '构造器按位置定名的专属目录',
    paths: [`${EVIDENCE_PREFIX}/${c.agent}`],
  }
}

/** 路径的包含：相等，或者 `a` 是 `b` 的祖先目录。**段对齐**，所以 `src/parse` 不覆盖 `src/parser.ts`。 */
export function covers(a: RelPath, b: RelPath): boolean {
  return a === b || b.startsWith(`${a}/`)
}

/** 一份契约占住的一条路径与另一份占住的一条路径之间的关系。 */
export interface PathHit {
  readonly a: ContractId
  readonly b: ContractId
  /** 两份各占的那一条路径（`aPaths` 里的那一条在前）。 */
  readonly paths: readonly [RelPath, RelPath]
}

/** 一对相交的契约：两份的 id · 变体 · 逐条相交的路径。 */
export interface Intersection {
  readonly a: ContractId
  readonly b: ContractId
  readonly kinds: readonly [Contract['kind'], Contract['kind']]
  readonly hits: readonly PathHit[]
  /** 是自相交不是两两相交：同一份契约里两条路径互相包含（写入集自己就不干净）。 */
  readonly self: boolean
}

/**
 * 报出相交的那几对与路径。**同一条判据，两处调用**（架构 § 8.12）。
 *
 * 判据是"路径的包含"而不是"路径的相等"：写入集是**上界**，一份契约写 `src/parse` 意味着它可能写
 * 那底下的任何东西，另一份声明 `src/parse/x.ts` 就撞上了。`src/parse` 与 `src/parser.ts` 不撞
 * ——段要对齐。
 *
 * 输出**有序**（按两份契约在入参里的位置）：两处调用给出同一答案这句话，因此可以被逐字节比。
 */
export function intersect(contracts: readonly Contract[]): Intersection[] {
  const sets = contracts.map(writeSetOf)
  const out: Intersection[] = []
  for (let i = 0; i < sets.length; i++) {
    // 自相交：同一份契约里两条路径互相包含。它同样是"合并判据不成立"，而且它比两两相交更早
    // 该被发现——那一份契约自己就说不清它要写哪儿。
    const self = selfHits(sets[i])
    if (self.length > 0) {
      out.push({ a: sets[i].id, b: sets[i].id, kinds: [sets[i].kind, sets[i].kind], hits: self, self: true })
    }
    for (let j = i + 1; j < sets.length; j++) {
      const hits: PathHit[] = []
      for (const p of sets[i].paths) {
        for (const q of sets[j].paths) {
          if (covers(p, q) || covers(q, p)) hits.push({ a: sets[i].id, b: sets[j].id, paths: [p, q] })
        }
      }
      if (hits.length > 0) {
        out.push({ a: sets[i].id, b: sets[j].id, kinds: [sets[i].kind, sets[j].kind], hits, self: false })
      }
    }
  }
  return out
}

function selfHits(s: WriteSet): PathHit[] {
  const out: PathHit[] = []
  for (let i = 0; i < s.paths.length; i++) {
    for (let j = i + 1; j < s.paths.length; j++) {
      if (covers(s.paths[i], s.paths[j]) || covers(s.paths[j], s.paths[i])) {
        out.push({ a: s.id, b: s.id, paths: [s.paths[i], s.paths[j]] })
      }
    }
  }
  return out
}

/** 一次预检的答案：那几对相交，加一句能直接印出来的话。 */
export interface PrecheckResult {
  readonly intersections: readonly Intersection[]
  /** 空数组 = 一份都不相交。 */
  readonly issues: readonly ContractIssue[]
  /** 逐对的判据可复核：把这两条路径拿出来，`covers` 一跑就知道。 */
  readonly lines: readonly string[]
}

/** 把一次相交报成一句人话：哪两份契约 · 哪两条路径 · 后一条是谁占的。 */
function lineOf(x: Intersection): string {
  const where = x.self ? `契约自己也说不清（${x.a}）` : `${x.a} 与 ${x.b}`
  const first = x.hits[0]
  const also = x.hits.length > 1 ? `（共 ${x.hits.length} 条路径相交）` : ''
  return `${where}：${first.paths[0]} ↔ ${first.paths[1]}${also}`
}

/**
 * 跑一遍预检。**两处调用的是它**——`Planning` 那一档与合并前那一档拿到的 `intersections`
 * 逐条相同（架构 § 8.12：「两处跑的是同一个函数，因此不会给出不同答案」）。
 */
export function precheck(contracts: readonly Contract[]): PrecheckResult {
  const intersections = intersect(contracts)
  return {
    intersections,
    issues: intersections.map(lineOf),
    lines: intersections.map((x) => `${lineOf(x)}　[${x.kinds.join(' × ')}]`),
  }
}

/**
 * `Planning` 那一档的判决。
 *
 * **报出即放行**（PLAN § 5.7 的口径一）：相交的那几对进答案与日志，派发照做。改主意就是把这一行
 * 的 `ok` 改成 `false`——那一档的门立回来，其余一个字不动。
 */
export function planningGate(contracts: readonly Contract[]): { ok: boolean; result: PrecheckResult; say: string } {
  const result = precheck(contracts)
  const ok = true
  const say =
    result.intersections.length === 0
      ? '写入集两两不相交'
      : `写入集有 ${result.intersections.length} 对相交，照发（这一站的口径：报出来、照发，撞上了由冲突环接住）\n  ` +
        result.lines.join('\n  ')
  return { ok, result, say }
}

/**
 * 合并前那一档的判决。
 *
 * **报出即拒。** 合并是不可逆点，这一档不信任上游的检查结果（架构 § 8.12：兜底那一次自己再核
 * 一遍，与 § 15.7 硬要求 fail-closed 同一条纪律）。同一个 `precheck`，不同的判决——"判据一处、
 * 判决两处"就是这两行的意思。
 */
export function mergeGate(contracts: readonly Contract[]): { ok: boolean; result: PrecheckResult; say: string } {
  const result = precheck(contracts)
  const ok = result.intersections.length === 0
  const say = ok
    ? '写入集两两不相交，合并照做'
    : `写入集有 ${result.intersections.length} 对相交，拒绝合并（合并不可逆）\n  ` + result.lines.join('\n  ')
  return { ok, result, say }
}

/**
 * 调查型的产物目录**不与任何契约相交**（架构 § 8.12 的验证性质）——这句话在这里是可以核的：
 * `evidence/` 那一段归构造器，而一份契约的写入集里出现那一段就该被拒（`types.ts` 的
 * `ownedPaths` 那一格有这条检查）。这一条断言把两处对上：**只要没有契约占住那个前缀，
 * 调查型就不可能相交**。
 */
export function evidenceIsReserved(contracts: readonly Contract[]): string[] {
  const bad: string[] = []
  for (const c of contracts) {
    if (c.kind === 'investigate') continue
    const paths = c.kind === 'implement' ? c.ownedPaths : c.conflictPaths
    for (const p of paths) {
      if (p === EVIDENCE_PREFIX || p.startsWith(`${EVIDENCE_PREFIX}/`)) {
        bad.push(`${c.id} 的写入集占住了构造器留给调查型的位置：${p}——${EVIDENCE_PREFIX}/ 那一段归构造器`)
      }
    }
  }
  return bad
}
