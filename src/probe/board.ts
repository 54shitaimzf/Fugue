/**
 * **样本盘的判据：拿一份"已知答案"去判最后那棵工作树。**
 *
 * 为什么要有它：这一版此前量得到的东西只有两种——机制对不对（夹具 · 逐字节 · 停因），
 * 与模型自己报的（它选的断言跑没跑过）。**"改对了没有"从来没有一个独立于模型的判据**：
 * 断言是模型从动作里挑的，它挑一条永远为真的，验收照样绿。样本盘补的就是这一格——
 * 出题的人先写下答案（哪份文件必须在 · 哪份必须没了 · 里面必须/不许出现什么），
 * 跑完拿**真实工作树**去比对。
 *
 * 三条纪律：
 * 一 · **答案只写结果，不写过程**：不规定它怎么拆、改几步、用哪条工具——那是"怎么切"，
 *      归模型（计划 § 5.12 的分工表）。
 * 二 · **一条判据都没有 = 不过**，与 `merge/accept.ts` 那句"没人能判不算绿"同一个口径。
 * 三 · **纯读**：它只吃一棵树的快照（`Tree`），不碰盘、不发网、不写日志——所以样本盘
 *      能在离线档上先跑一遍自检（`solved` 该过 · `base` 该不过）。
 */

/** 一条已知判据：某路径应当在 / 不应当在，在的话内容里必须有什么、不许有什么。 */
export type AnswerCheck = {
  readonly path: string
  readonly form: 'file' | 'absent'
  /** `form: 'file'` 时：内容里必须出现这几段（逐段包含）。 */
  readonly contains?: readonly string[]
  /** `form: 'file'` 时：内容里不许出现这几段。 */
  readonly notContains?: readonly string[]
}

export type Answer = readonly AnswerCheck[]

/** 一棵树的快照：路径 → 内容；`null` = 那一条不在（判据与 `view` 的 tombstone 同一个读法）。 */
export type Tree = Readonly<Record<string, string | null | undefined>>

export type CheckVerdict = {
  readonly path: string
  readonly verdict: 'pass' | 'fail'
  /** 一句话，指得出差在哪（红了也说不清的判据等于没有判据）。 */
  readonly note: string
}

export type BoardVerdict = {
  readonly ok: boolean
  readonly verdicts: readonly CheckVerdict[]
  /** 红的那几条（路径），给账那一行用。 */
  readonly failed: readonly string[]
  /** 一句话结论。 */
  readonly why: string
}

function judgeOne(c: AnswerCheck, tree: Tree): CheckVerdict {
  const got = tree[c.path]
  const there = got !== null && got !== undefined
  if (c.form === 'absent') {
    return there
      ? { path: c.path, verdict: 'fail', note: '应当不在，实得在（' + String(got.length) + ' 字节）' }
      : { path: c.path, verdict: 'pass', note: '不在' }
  }
  if (!there) return { path: c.path, verdict: 'fail', note: '应当在，实得不在' }
  const text = got as string
  for (const one of c.contains ?? []) {
    if (!text.includes(one)) return { path: c.path, verdict: 'fail', note: '内容里找不到 ' + JSON.stringify(one) }
  }
  for (const one of c.notContains ?? []) {
    if (text.includes(one)) return { path: c.path, verdict: 'fail', note: '内容里不该有 ' + JSON.stringify(one) }
  }
  return { path: c.path, verdict: 'pass', note: '在（' + String(text.length) + ' 字节）' + ((c.contains ?? []).length ? ' · 该有的都有' : '') }
}

/** **判**：一份已知答案 × 一棵树的快照 → 过不过 + 每一条的读数。 */
export function judgeOf(answer: Answer, tree: Tree): BoardVerdict {
  const verdicts = answer.map((c) => judgeOne(c, tree))
  const failed = verdicts.filter((v) => v.verdict === 'fail').map((v) => v.path)
  if (verdicts.length === 0) {
    return { ok: false, verdicts, failed, why: '这一份答案一条判据都没有——没人能判，不算过' }
  }
  return {
    ok: failed.length === 0,
    verdicts,
    failed,
    why: failed.length === 0
      ? '已知答案全中（' + String(verdicts.length) + ' 条）'
      : '红 ' + String(failed.length) + '/' + String(verdicts.length) + ' 条：' + failed.join(' · '),
  }
}

/** 给人看的那几行（每条一行，红的那几条带上"差在哪"）。 */
export function boardLines(name: string, v: BoardVerdict): string[] {
  const out = ['  ' + name + '：' + v.why]
  for (const one of v.verdicts) if (one.verdict === 'fail') out.push('    ! ' + one.path + '：' + one.note)
  return out
}
