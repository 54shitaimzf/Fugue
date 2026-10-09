// 观察组的**值层**：`status` · `watch` · `log` 三条。出处：架构 § 9.6 那张观察表 ·
// § 9.11 的事件通道（一趟调用一趟事 · 游标每 writer 一个 · 沿用 `--resume` 串形）。
//
// **三条都是纯读**：不开写句柄、不取栅栏、不新增事件（§ 9.7「观察不得影响状态」）。
//
// 两条脸的字节与 `src/cli/cmd/observe.ts` 那一份逐字节相同（黄金帧锁着）：`status` 是「一个
// 对象 + 几行字」· `log` 与 `watch` 是 NDJSON（`--json` 一行一个 `{pos,e}`，人读一行一个制表符
// 分隔的摘要）。
//
// **跟随那一档的流由壳收**（`onBatch`）：`watch --follow` 一个人读那一面是实时印的，攒到最后
// 再印就不是它了。值层给的是「这一趟读到哪些行 + 读过之后的游标」——一次请求一条回执，正是
// § 9.11「一趟调用一趟事」的形状。
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import type { LogPos } from '../terms.ts'
import { phaseOf } from '../model/price.ts'
import { readCatalog } from '../model/catalog.ts'
import { readings, readingsLines } from '../probe/status.ts'
import type { StatusReadings, StatusRow } from '../probe/status.ts'
import { cursorsOf, follow, readNew, tokenOf } from '../probe/watch.ts'
import type { Cursors } from '../probe/watch.ts'
import { readConfig } from '../config.ts'
import { intervalOf as intervalFlagOf } from '../cli/flags.ts'
import { PHRASES } from '../phrases.ts'
import { actionCommandsOf } from '../round/actions.ts'
import { CommandError, UsageError, ok } from './types.ts'
import type { ValueArgs, ValueResult } from './types.ts'

/**
 * TSV 那四列的名字，**列头与行同源**：`--header` 印的是这一份，`eventLine` 拼行照的也是它
 * 那个顺序。为什么要一处——列头是给人一眼看明白哪一列是什么的，**它跟它下面那些行对不上
 * 就比不印更坏**（`cli/header.test.ts` ① 量的就是"列数相同"）。
 */
export const EMIT_COLUMNS: readonly string[] = ['writer', 'seq', 't', 'payload']

/** `--header` 印的那一行（制表符分隔，与它下面每一行同一种形状）。 */
export const EMIT_HEADER = EMIT_COLUMNS.join('\t')

/**
 * `--header`（列头那一行）：要不要印，以及**与 `--json` 说不到一起**。
 *
 * `--json` 那一份是对象，本来就有键名——再塞一行列头进去是把机器读的那条流弄脏（NDJSON 那
 * 一档逐行可解析这条纪律就破了）。一处判据，两个消费者（`log` 与 `watch` 印的是同一种行）。
 */
export function headerWanted(a: ValueArgs): boolean {
  if (!a.flags.has('header')) return false
  if (a.flags.has('json')) {
    throw new UsageError('--header 说的是列头那一行；--json 那一份是对象，没有列——两者说不到一起')
  }
  return true
}

/** 一行事件的**人读那一面**（与 `cmd/observe.ts` 的 `emit` 逐字节相同）。 */
export function eventLine(pos: LogPos, e: LogEvent): string {
  const { t, ...payload } = e as { t: string } & Record<string, unknown>
  const brief = Object.keys(payload)
    .map((k) => `${k}=${JSON.stringify(payload[k])}`)
    .join(' ')
  // **列名与取值同一张表**：顺序由 `EMIT_COLUMNS` 说，这一行照着它取——两处各写一遍顺序，
  // 列头就会跟它下面那些行走岔，而走岔了不报错（`cli/header.test.ts` ① 量这一条）。
  const cells: Record<string, string> = { writer: pos.writer, seq: String(pos.seq), t, payload: brief }
  return EMIT_COLUMNS.map((name) => cells[name]!).join('\t')
}

/** 一行事件的 `--json` 那一面。 */
export function eventJson(pos: LogPos, e: LogEvent): string {
  return JSON.stringify({ pos, e })
}

/**
 * **这一台机器上已绑定动作的命令行**（账上「走法」那一栏的第二半用它）。读不出来就是空的那一份：
 * 这一栏说的是「读账的人手里有什么」，配置坏了不该让整条 `status` 读不出来。
 */
async function boundCommandsOf(root: string): Promise<readonly string[]> {
  try {
    return Object.values(actionCommandsOf(await readConfig(root)))
  } catch {
    return []
  }
}

/** 折一次账（`--wait` 与不给它那一档共用这一条；值层里只有这一处折）。 */
async function statusOnce(
  a: ValueArgs,
): Promise<{ result: ValueResult; value: StatusReadings; human: readonly string[] }> {
  const log = openLog(a.root)
  try {
    // 钱那一栏要一个档：**读的时候按当时的钟算**（官方价目分峰谷两档）。
    const phase = phaseOf(new Date())
    // 价目与模型目录按这一台算（P2d：`~/.fugue/models.json` 在就是它）。
    const cat = readCatalog()
    const only = a.flags.get('agent')
    const r = await readings(log, {
      // 钟那三栏（架构 § 9.2）：**看一眼账上的回拨**——它是读得出来的事实，不是账的错。
      clocks: await log.clocks(),
      metrics: a.flags.has('metrics'),
      report: a.flags.has('report'),
      // **每调用成本台账**：钱要价目与峰谷档，走法那一栏要这一台已绑定动作的命令行。
      ...(a.flags.has('ledger')
        ? { ledger: { cat, phase, bindings: await boundCommandsOf(a.root) } }
        : {}),
      ...(typeof only === 'string' ? { agent: only } : {}),
    })
    const human = readingsLines(r, { phase, cat })
    return {
      result: ok({ value: r, faces: { json: JSON.stringify(r), human: human.join('\n') } }),
      value: r,
      human,
    }
  } finally {
    await log.close()
  }
}

/** 轮询的间隔（毫秒）——**纯轮询**，不引守护进程（施工单 § 五 ④）。取值依据：折一遍账是毫秒
 * 级，500 ms 是「人眨眼」的一档，而它也不会把 CPU 咬住。 */
export const WAIT_POLL_MS = 500

/** `--timeout <秒>` 的缺省：30 秒（与 `serve` 的闲时阈值同一档——都是「人看着等」的尺度）。 */
export const WAIT_TIMEOUT_S = 30

/** `--timeout <秒>` 的解析（不给就是 `WAIT_TIMEOUT_S`；读不动是用法错）。 */
function timeoutOf(a: ValueArgs): number {
  const raw = a.flags.get('timeout')
  if (raw === undefined) return WAIT_TIMEOUT_S
  if (typeof raw !== 'string') throw new UsageError('--timeout 要一个数（秒）：--timeout 30')
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`--timeout 要一个正数（秒），拿到 ${JSON.stringify(raw)}`)
  }
  return n
}

/**
 * 账上那一刻的状态名：**每一条轮次链最后那句 `round/state`**（架构 § 8.13 那张状态机的取值）。
 *
 * **agent 那一格里没有状态这一栏**（`AgentStatus` 记的是调用 · 步数 · 拒绝那几样），所以
 * `--wait` 认的名字就是 `Idle` · `Planning` · `Working` 那一族——一条轮次都还没开过的时候
 * 这个集合是空的，`--wait` 到点如实报超时（那不是错，是「账上现在没有这个状态」）。
 */
function statesOf(r: StatusReadings): readonly string[] {
  const out = new Set<string>()
  for (const round of r.snapshot.rounds) out.add(round.state)
  return [...out]
}

/** 睡一会儿（`--wait` 的轮询用它——**纯轮询**，没有第二条管道）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

/** 睡一会儿，**信号一到就当场醒**（`probe/watch.ts` 里那一只同一条口径：定时器不 `unref`，
 * 监听器要摘掉）。跟随那一档走共享读源时用它。 */
function sleepMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    let settled = false
    const t = setTimeout(finish, ms)
    function finish(): void {
      if (settled) return
      settled = true
      clearTimeout(t)
      signal.removeEventListener('abort', finish)
      done()
    }
    if (signal.aborted) finish()
    else signal.addEventListener('abort', finish)
  })
}

/**
 * `status [--once] [--metrics] [--report] [--ledger] [--agent <id>] [--wait <状态>] [--timeout <秒>]`：
 * **把账重放一次**，给人看这一刻的处境。纯读两头都占了：开日志口不带 `write`、不建视图、不碰真源。
 *
 * `--wait` 那一档（施工单 § 五 ④）：每隔 `WAIT_POLL_MS` 折一遍账，等到状态集合里出现那个名字；
 * 到点如实报超时（退出码 1，报出等到的那一刻是什么样）——**不静默成功**。这一句也是 serve 客户端
 * 的等待语义：想等的人不必自己挂一个 tmux 加脚本。
 */
export async function statusValue(a: ValueArgs): Promise<ValueResult> {
  const wait = a.flags.get('wait')
  const wanted = typeof wait === 'string' ? wait : undefined
  const timeoutS = timeoutOf(a)
  const deadline = Date.now() + timeoutS * 1000
  for (;;) {
    const once = await statusOnce(a)
    if (wanted === undefined) return once.result
    if (statesOf(once.value).includes(wanted)) {
      const v = { ...once.value, waited: true, wait: wanted, timeoutS }
      return ok({
        value: v,
        faces: { json: JSON.stringify(v), human: [`等到了：${wanted}`, ...once.human].join('\n') },
      })
    }
    if (Date.now() >= deadline) {
      // **到点如实报超时**：等到的那一刻是什么样，照实说。
      throw new CommandError(
        `等到点也没等到 ${wanted}（--timeout ${timeoutS} 秒）：` +
          `账上现在是 ${statesOf(once.value).join(' · ') || '（一条状态都没有）'}`,
      )
    }
    await sleep(WAIT_POLL_MS)
  }
}


/**
 * `--resume <游标串>`：接着读的入口（架构 § 9.11 的事件通道——游标是每个 writer 一个，语义是
 * 排他下界）。读不动是用法错（退 2），不猜。
 */
export function resumeFrom(a: ValueArgs): Cursors | undefined {
  const raw = a.flags.get('resume')
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || raw === '') {
    throw new UsageError('--resume 要一个游标串：--resume agent/r1/2:7,round:3')
  }
  const parsed = cursorsOf(raw)
  if (typeof parsed === 'string') throw new UsageError(parsed)
  return parsed
}

/** `log [--agent <id>] [--header]`：把账原样列出来，一行一条事件，不做任何加工。 */
export async function logValue(a: ValueArgs): Promise<ValueResult> {
  const only = a.flags.get('agent')
  const head = headerWanted(a)
  const log = openLog(a.root)
  const rows: StatusRow[] = []
  try {
    for await (const { pos, e } of log.readMerged()) {
      if (typeof only === 'string' && pos.writer !== only) continue
      rows.push({ pos, e })
    }
  } finally {
    await log.close()
  }
  // 列头只在人读那一面（`--json` 那一面是对象，见 `headerWanted`）——它在最前面一行。
  const lines = rows.map((r) => eventLine(r.pos, r.e))
  return ok({
    value: rows.map((r) => ({ pos: r.pos, e: r.e })),
    faces: {
      json: rows.map((r) => eventJson(r.pos, r.e)).join('\n'),
      human: (head ? [EMIT_HEADER, ...lines] : lines).join('\n'),
    },
  })
}

/** `watch` 那一趟要的两样：一个读数（`--json` 那一面用的对象）与一条流（人读那一面用的行）。 */
export interface WatchValue {
  readonly events: readonly { pos: LogPos; e: LogEvent }[]
  readonly cursors: Cursors
  readonly resume: string
}

/**
 * 一条**只按游标答一趟**的读源（`serve/tail.ts` 的尾部索引）：`pass(from)` 先推一趟账，
 * 再把索引之外的那些行按 `from` 筛一遍交出来。
 *
 * 值层收它**只为一件事**：serve 那一头的扫描按根做一次、N 个客户端共用；CLI 那一条路不给
 * 它（自己开账本，与从前逐字节相同）。**它不是第二份读法**——尾部索引走的还是账本那一条
 * `readMerged`，只是把「读过的行」记在了两个壳的外面。
 */
export interface RowTail {
  pass(from: Cursors): Promise<readonly StatusRow[]>
}

/**
 * `watch [--follow] [--interval <毫秒>] [--resume <游标串>]`：**顺着 NDJSON 账读**。
 *
 * 不给 `--follow` 就把账上有的念一遍就停（这一档是 serve 事件通道「一趟调用一趟事」的原型）；
 * 给了就一直跟着，直到信号来。**退出时印游标串**——那是接着读的入口（走 stderr）。
 *
 * `onBatch` 是**实时那一档的出口**：跟随的每一批到了就递出去（一个人读那一面要边读边印），
 * 同时照旧攒进这一趟的读数里。`signal` 一到，`follow` 那一趟收尾返回。
 */
export async function watchValue(
  a: ValueArgs,
  hooks: {
    readonly signal?: AbortSignal
    readonly onBatch?: (batch: readonly StatusRow[]) => void
    /** 给了它就不自己开账本（serve 那一头按根共用的那一份）。 */
    readonly tail?: RowTail
  } = {},
): Promise<{ result: ValueResult; value: WatchValue }> {
  const intervalMs = intervalFlagOf(a.flags)
  if (typeof intervalMs === 'string') throw new UsageError(intervalMs)
  const head = headerWanted(a)
  const from = resumeFrom(a)
  const only = a.flags.get('agent')
  const tail = hooks.tail
  const log = tail === undefined ? openLog(a.root) : null
  const ac = new AbortController()
  const onAbort = (): void => ac.abort()
  hooks.signal?.addEventListener('abort', onAbort)
  // **游标自己记**（每个 writer 一个）：记的是"读到哪了"，不是"印了哪几条"——`--agent` 只筛印
  // 出去的那些，而游标串要能接着读整份账。
  const cursors: Record<string, number> = { ...(from ?? {}) }
  const rows: StatusRow[] = []
  const seen = (row: StatusRow): void => {
    if (row.pos.seq > (cursors[row.pos.writer] ?? 0)) cursors[row.pos.writer] = row.pos.seq
  }
  const keep = (row: StatusRow): void => {
    if (typeof only !== 'string' || row.pos.writer === only) rows.push(row)
  }
  /** 读进来的那一段：**先记游标再筛印**——游标说的是"读到哪了"（整份账），不是"印了哪几条"
   * ——`--agent` 只筛印出去的那些，而游标串要能接着读整份账。 */
  const take = (batch: readonly StatusRow[]): void => {
    for (const row of batch) seen(row)
    for (const row of batch) keep(row)
  }
  try {
    if (!a.flags.has('follow')) {
      if (tail !== undefined) {
        take(await tail.pass(from ?? {}))
      } else {
        const p = await readNew(log as NonNullable<typeof log>, from ?? {})
        take(p.rows)
      }
    } else {
      if (tail !== undefined) {
        // serve 那一头：跟随也走那一份共享的读源——每一趟 `pass()` 先把账推一次（并发的那些
        // 合并在同一次扫描上），再按这一端的游标筛。**游标仍住客户端**：它每一趟都带进来。
        for (;;) {
          if (ac.signal.aborted) break
          const batch = await tail.pass(cursors)
          take(batch)
          hooks.onBatch?.(typeof only === 'string' ? batch.filter((r) => r.pos.writer === only) : batch)
          if (batch.length === 0) await sleepMs(intervalMs, ac.signal)
        }
      } else {
        const opts = { intervalMs, signal: ac.signal, ...(from === undefined ? {} : { from }) }
        for await (const batch of follow(log as NonNullable<typeof log>, opts)) {
          take(batch)
          hooks.onBatch?.(typeof only === 'string' ? batch.filter((r) => r.pos.writer === only) : batch)
        }
      }
    }
  } finally {
    hooks.signal?.removeEventListener('abort', onAbort)
    // **自己开的那一条自己关**：`tail` 是调用方的（它按根共用，收尾由它自己 `dispose()`）。
    if (log !== null) await log.close()
  }
  const token = tokenOf(cursors)
  const value: WatchValue = {
    events: rows.map((r) => ({ pos: r.pos, e: r.e })),
    cursors,
    resume: token,
  }
  // **实时那一档的行已经随读随印了**（壳给了 `onBatch`）：收尾这一份人读面因此是空的——
  // 两处都印的话，人按一下 Ctrl-C 之后每一行都会出现两次（实测 2 条事件印出 4 行）。
  // 这不是"少印"：印出去的那些行已经在 stdout 上了，这一份只是同一批行的第二份拷贝。
  const streamed = hooks.onBatch !== undefined
  // 列头那一行（`--header`）：实时那一档的行已经随读随印了，所以那一档由壳在开头把这一行印掉
  // ——这里（以及下面那一格空的 `human`）都不再补。人读那一面的第一行因此永远是列头。
  const lines = rows.map((r) => eventLine(r.pos, r.e))
  const notes = a.flags.has('follow') ? [`${PHRASES.resumeHead}：--resume ${token}`] : []
  return {
    result: ok(
      {
        value,
        faces: {
          json: rows.map((r) => eventJson(r.pos, r.e)).join('\n'),
          human: streamed ? '' : (head ? [EMIT_HEADER, ...lines] : lines).join('\n'),
        },
      },
      notes,
    ),
    value,
  }
}
