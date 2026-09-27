// 前缀纪律读数：**"不破坏缓存"这句话的机制判据，从日志重算**。出处：架构 § 8.11（十二段三个区：
// A 区固定 · B 区逐 agent 稳 · C 区积累）· § 8.15（"不采集，只重算——因此任何指标都能被复核"）·
// PLAN § 5.6 的 Z0/Z1。
//
// **它判的不是"命中率"，是"字节纪律"**——两件事：命中与否是提供方认的账（`prefix-hit-rate`
// 那一栏），而"我们发出去的字节该稳的稳住了没有"本地就能判死，而且它是**前提**。前提不成立时，
// 命中率掉下来只说得清后果、说不清原因（架构 § 8.15 那条"前提可局部判死，主张只能整体判"）。
//
// 三条判据，每条都有一个具体的坏动作与它对应：
//
//   一 · **A 区跨全部 writer 恰好一份** —— A 区是"项目方针 + 系统状态 + 代码树"，同一次运行里是
//        常量。多一份 = 有人在 A 区里放了会变的东西（或运行中途换了配置/方针），缓存必然失效一次。
//   二 · **B 区逐 writer 恰好一份** —— B 区是这个 agent 的处境（工作总目标 · 文件内容 · 提交序列 ·
//        交接提示词 · 我的任务）。同一个 writer 里多一份 = 这个 agent 的处境中途漂过，从那一刻起
//        前缀全部重付。
//   三 · **C 区逐装配新增** —— C 区是积累段（运行时上下文），每走一步只许追加。装配了 n 次而 C 区
//        只有 m < n 份不同哈希 = 有一步没往 C 里加东西（那一步的账是空的）。
//   另有一条缺账的兜底：**调用了 n 次而一条装配都没有** —— 前缀账不完整，也是红。
//
// **它不判"装配与调用是不是 1:1"**：两个数分开给（`assembles` · `calls`），差值不合成结论。今天
// 没有一条口径说它们必须相等（一次装配配一次调用是常态，而重启那一档可能不是），所以这一份不拿
// 一个没定论的判据去判红——那条留给真档基线：读数先摆出来，口径后定。
import type { LogEvent } from '../log/events.ts'

/** 交错的读侧那一份形状（`probe/status.ts` 的 `StatusRow` 逐字，三处共用同一条读法）。 */
export interface PrefixRow {
  readonly pos: { readonly writer: string; readonly seq: number }
  readonly e: LogEvent
}

/** 去重，按首次出现的次序。要的是"有几份"，印出来要的是"哪几份"。 */
function uniq(xs: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of xs) {
    if (seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  return out
}

/** 短指纹：日志里那几栏本来就是短哈希。印全了没人读，印短了还能对上账。 */
function short(h: string): string {
  return h.length <= 12 ? h : h.slice(0, 12) + '…'
}

/** 一个 writer 上的前缀纪律。**每一栏都指得到 `prefix/assemble` 那几条事件，一处推断都没有。** */
export interface WriterPrefix {
  readonly writer: string
  /** 这个 writer 装配了几次（`prefix/assemble` 条数）。 */
  readonly assembles: number
  /** 这个 writer 调用了几次模型（`llm/call` 条数）。**与上一栏分开给**：1:1 这件事今天没有口径。 */
  readonly calls: number
  /** A 区去重之后那几份（按首次出现次序）。 */
  readonly zoneA: readonly string[]
  /** B 区去重之后那几份。 */
  readonly zoneB: readonly string[]
  /** C 区去重之后那几份。 */
  readonly zoneC: readonly string[]
  /** A 区在这个 writer 上是不是常量。**跨 writer 的那一条在 `PrefixReading.aShared`。** */
  readonly aStable: boolean
  /** B 区在这个 writer 上是不是常量。 */
  readonly bStable: boolean
  /** C 区是不是逐装配新增（去重后份数 == 装配条数）。 */
  readonly cGrew: boolean
}

/** 一次运行的前缀纪律。**`aShared` 是那一条承重的读数**：它为假，缓存必然白失效过。 */
export interface PrefixReading {
  readonly writers: readonly WriterPrefix[]
  /** 全部 writer 合起来的 A 区哈希（去重，按首次出现次序）。 */
  readonly zoneA: readonly string[]
  /** **A 区跨全部 writer 恰好一份。** */
  readonly aShared: boolean
  readonly assembles: number
  readonly calls: number
  /** 人读的那几行：先是总账，再逐 writer，最后是把不合格的逐条报出来。 */
  readonly lines: readonly string[]
}

/**
 * 从一条交错的读侧算这份读数。**纯函数**：同一串事件折两次同值（可复核性那条验证性质）。
 *
 * 按 writer 归拢而不是按 agent 字段：`prefix/assemble` 与 `llm/call` 的 `agent` 字段说的是"谁的
 * 前缀"，而写进哪一份日志由 `pos.writer` 说。两者不一致的那一档（写错了本子）**这一份不判**——
 * 它只读 `pos.writer`，那一件事归日志那一层。
 */
export function prefixOf(rows: readonly PrefixRow[]): PrefixReading {
  const order: string[] = []
  const per = new Map<string, { a: string[]; b: string[]; c: string[]; calls: number }>()
  const slotOf = (w: string): { a: string[]; b: string[]; c: string[]; calls: number } => {
    let s = per.get(w)
    if (s === undefined) {
      s = { a: [], b: [], c: [], calls: 0 }
      per.set(w, s)
      order.push(w)
    }
    return s
  }
  for (const { pos, e } of rows) {
    if (e.t === 'prefix/assemble') {
      const s = slotOf(pos.writer)
      s.a.push(e.zoneAHash)
      s.b.push(e.zoneBHash)
      s.c.push(e.zoneCHash)
      continue
    }
    if (e.t === 'llm/call') slotOf(pos.writer).calls += 1
  }

  const writers: WriterPrefix[] = order.map((w) => {
    const s = per.get(w) as { a: string[]; b: string[]; c: string[]; calls: number }
    const a = uniq(s.a)
    const b = uniq(s.b)
    const c = uniq(s.c)
    return {
      writer: w,
      assembles: s.a.length,
      calls: s.calls,
      zoneA: a,
      zoneB: b,
      zoneC: c,
      aStable: a.length === 1,
      bStable: b.length === 1,
      cGrew: s.a.length > 0 && c.length === s.a.length,
    }
  })

  const zoneA = uniq(writers.flatMap((w) => w.zoneA))
  const assembles = writers.reduce((n, w) => n + w.assembles, 0)
  const calls = writers.reduce((n, w) => n + w.calls, 0)
  const aShared = zoneA.length === 1
  const sharers = writers.filter((w) => w.assembles > 0).length

  const lines: string[] = []
  lines.push(
    `前缀纪律：装配 ${assembles} 次 · 调用 ${calls} 次 · A 区 ${zoneA.length} 份` +
      (aShared ? `（跨 ${sharers} 个 writer 共用 · ${short(zoneA[0] ?? '')}）` : '（**该只有一份**）'),
  )
  if (assembles === 0) lines.push('  · 一条 prefix/assemble 都没有：这一份日志上的前缀账是空的')
  for (const w of writers) {
    if (w.assembles === 0) {
      lines.push(`  ${w.writer}：装配 0 次 · 调用 ${w.calls} 次 · 三区都还没有一份（一条 prefix/assemble 都没有）`)
      continue
    }
    const a = w.aStable ? short(w.zoneA[0] ?? '') : `${w.zoneA.length} 份`
    const b = w.bStable ? short(w.zoneB[0] ?? '') : `${w.zoneB.length} 份`
    lines.push(`  ${w.writer}：装配 ${w.assembles} 次 · 调用 ${w.calls} 次 · A ${a} · B ${b} · C ${w.zoneC.length} 份`)
  }
  if (zoneA.length > 1) {
    lines.push(`  ! A 区出现了 ${zoneA.length} 份：${zoneA.map(short).join(' · ')}——同一次运行里 A 区是常量，多一份就是缓存失效一次`)
  }
  for (const w of writers) {
    // **没有装配的 writer 只报缺账那一条**：B/C 那两条在「一份都没有」上没有意义——多报两行会把
    // 真正的 finding 埋掉（实测：不收的话一屏里三条 `!` 有两条是废话）。
    if (w.assembles === 0) {
      if (w.calls > 0) lines.push(`  ! ${w.writer} 调用了 ${w.calls} 次而一条装配都没有——前缀账不完整`)
      continue
    }
    if (!w.bStable) {
      lines.push(`  ! ${w.writer} 的 B 区有 ${w.zoneB.length} 份：${w.zoneB.map(short).join(' · ')}——这个 agent 的处境在中途漂过，从那一刻起前缀全部重付`)
    }
    if (!w.cGrew) {
      lines.push(`  ! ${w.writer} 的 C 区有 ${w.zoneC.length} 份而装配了 ${w.assembles} 次——C 区是积累段，每装配一次就该新增一份`)
    }
  }
  return { writers, zoneA, aShared, assembles, calls, lines }
}
