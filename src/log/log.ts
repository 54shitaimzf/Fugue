// M0 · 持久的事件日志。出处：架构 § 8.1；存储格式、崩溃语义、耐久档位见 § 9.2–§ 9.5。
//
// 布局：`<realRoot>/.fugue/log/<writer>.jsonl`。每 writer 一份文件，各自持有单调
// 计数器——**并发写者之间不阻塞、不协调**（D11）。全序由 `(seq, writer)` 的字典序
// 隐含确定，不消费任何协调。
//
// **一份日志一个写者进程**：`write` 选项一给，句柄就握着那个 writer 的锁（`hold.ts`）直到
// `close()`。跨 writer 仍然是零协调（D11）——这道栅栏挡的是同一个 writer 的两个进程，不是并发。
//
// 写者一侧的三步顺序是：先落 blob · 再追加日志 · 最后改内存视图。本模块是中间那
// 一步，也是唯一需要保证顺序的一步；另外两步归 M1 与 M2。
import type { FileHandle } from 'node:fs/promises'
import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertIdent } from '../identity.ts'
import { clockOf } from '../clock.ts'
import type { Clock } from '../clock.ts'
import { decodeLine, encodeEvent } from './envelope.ts'
import type { Log, LogEvent, LogReader } from './events.ts'
import { holdWriter } from './hold.ts'
import type { Hold } from './hold.ts'
import type { LogPos, LogSeq, WriterId } from '../terms.ts'

export type SyncLevel = 'each' | 'batch' | 'never'

export interface LogOptions {
  /**
   * 耐久性档位（架构 § 9.5）。**正确性不依赖它**——blob 已经真实落盘，
   * 日志丢尾的后果是最近若干次路径指向消失，而不是产生一份错误视图。
   */
  sync?: SyncLevel
  /** `batch` 档每多少次追加落一次 fsync。 */
  batchEvery?: number
  /**
   * 这条句柄要**改**哪一份日志（不给 = 只读）。给了就在 `openLog` 里取那个 writer 的锁、
   * `close()` 里放——**一份日志一个写者进程**（`hold.ts`）。
   *
   * 取锁是同步的一步，因为 `openLog` 就是个同步工厂，而这一步只是建一个小文件。
   * **整条命令一个写者**（不是"只括住追加"）：一条 `ensure` 的写入不止一次追加，而它的
   * 挂载与落地那两段同样不许有第二个进程插进来（PLAN § 5.3 的疑点第一条）。
   */
  write?: WriterId
  /**
   * **已经拿到的那一把**（上一版拆件：`Hold` 外置）。给了它，这条句柄照常持有、`close()` 里
   * 放——但它**可以离开 `openLog` 单独发生**：调用方先把 N 把栅栏拿全（`holdWriter`），再一条
   * 一条开句柄。「要 N 把先拿全再开口」那条语义（§ 9.11）要的就是这个形状——中途撞上任何
   * 一把，已经拿到的由调用方全部放掉，**一个字节都没写**。
   *
   * `write` 与 `hold` 一起给是用法错（两种来路说不清谁持有）；两个都不给就是只读句柄
   * （§ 9.7：观察不加锁）。
   */
  hold?: Hold
  /**
   * **给不给信封钟**（`ts` · `boot` · `inc`，架构 § 9.2 的表）。缺省给：判据在写者一侧，
   * 命令行那一侧用 `--no-clock` 关掉。
   *
   * **关了的那一档一个字节都不多**——与这三栏之前编出来的行逐字节相同，而读的那一侧两种行
   * 都收（旧日志零迁移照读）。
   */
  clock?: boolean
}

/** `Log` 加一个生命周期口。契约本身仍是 § 8.1 的三个方法。 */
export interface LogHandle extends Log {
  close(): Promise<void>
  /**
   * 此刻有日志的全部 writer，排序。
   *
   * **读侧要它**：`replay --verify` 得逐个视图走一遍，而"有哪些视图"这件事只有日志目录
   * 知道。`readMerged` 也能枚举出来，但那是拿一个流去回答一个集合问题。
   */
  writers(): Promise<WriterId[]>
  /**
   * 每一行的钟（没给钟的行给 `null`），按 `(seq, writer)` 的合并序。
   *
   * **它读的是同一份日志、同一份解析记忆**（`readWriter` 的 `(mtimeMs, size)` 缓存），所以
   * "先把账重放一遍，再看一遍钟"那两趟不比一趟贵。它**不在 § 8.1 的三个方法里**——与
   * `writers()` 同一档：`Log` 的契约一个字不动，这是句柄自己的一个只读口。
   */
  clocks(): Promise<readonly ClockedRow[]>
}

/** 一行在账上的位置，加它信封里的钟。 */
export interface ClockedRow {
  readonly pos: LogPos
  readonly clock: Clock | null
}

// 只用可擦除语法：Node 直跑 .ts 是 strip-only，参数属性带运行时语义，用不了。
export class LogCorruptError extends Error {
  readonly writer: WriterId
  readonly line: number
  readonly reason: string

  constructor(writer: WriterId, line: number, reason: string) {
    super(`${writer} 第 ${line} 行：${reason}`)
    this.name = 'LogCorruptError'
    this.writer = writer
    this.line = line
    this.reason = reason
  }
}

export function logDir(root: string): string {
  return join(root, '.fugue', 'log')
}

const DEFAULT_BATCH_EVERY = 64
const TAIL_WINDOW = 64 * 1024

/**
 * writer 标识同时是文件名，所以它先过一遍身份名的检查。`snap/<writer>/` 也走这一关。
 *
 * **规矩只有一处**（`identity.ts` 的 `assertIdent`）：`M0` 与 `M3` 各调它一次，所以同一个名字在
 * 日志与物化两侧得到同一个答案——这条规矩原先两处各写一遍，已经漂移过一次（见那一份的文件头）。
 */
export function assertWriterId(w: WriterId): void {
  assertIdent(w, 'writer 标识')
}

/**
 * 该 writer 的日志文件。**导出是给快照用的**：快照要拿它的字节数，判断自己是不是比日志新
 * （`snap.ts` 顶部的第三条失守）。除此之外没有第二个调用者。
 */
export function logFileOf(root: string, w: WriterId): string {
  assertWriterId(w)
  return join(logDir(root), w + '.jsonl')
}

interface Row {
  pos: LogPos
  e: LogEvent
  /** 信封里的钟；没给钟的行是 `null`。**它不进 `readMerged` 的输出**（那是 § 8.1 的形状）。 */
  clock: Clock | null
}

/**
 * 把一份日志文本解析成事件序列。
 *
 * 两条规矩分开，是 § 9.3 的原话：**半行在尾部 → 截断继续；中段损坏 → 拒绝加载**。
 * 中间丢一行会让重放产生一份与当时不同的视图，所以宁可显式失败并指出行号。
 */
function parseWriterText(w: WriterId, text: string): Row[] {
  if (text.length === 0) return []
  const body = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1)
  const rows: Row[] = []
  let line = 0
  for (const raw of body.split('\n')) {
    line++
    if (raw.length === 0) continue
    const d = decodeLine(raw)
    if (!d.ok) throw new LogCorruptError(w, line, d.reason)
    if (d.pos.writer !== w) {
      throw new LogCorruptError(w, line, `信封里的 writer 与文件名不符：${d.pos.writer}`)
    }
    rows.push({ pos: d.pos, e: d.event, clock: d.clock })
  }
  return rows
}

async function readWriterUncached(root: string, w: WriterId): Promise<Row[]> {
  let text: string
  try {
    text = await readFile(logFileOf(root, w), 'utf8')
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return []
    throw err
  }
  return parseWriterText(w, text)
}

/** 枚举全部 writer。**排序**，好让 (seq, writer) 的合并序不依赖目录的枚举顺序。 */
async function listWriters(root: string): Promise<WriterId[]> {
  const out: string[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return
      throw err
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(join(dir, e.name), prefix + e.name + '/')
      else if (e.name.endsWith('.jsonl')) out.push(prefix + e.name.slice(0, -'.jsonl'.length))
    }
  }
  await walk(logDir(root), '')
  return out.sort()
}

/**
 * 窗口里最后一条完整行的**字节终点**（窗口内坐标；加上窗口起点就是磁盘偏移）。`0` = 窗口里一条
 * 完整行都没有。
 *
 * **不能拿字符串算这个位置**：窗口的第一行可能从半个码点中间开始，那段字节解出来是替换符
 * （U+FFFD，三个字节），拿解出来的字符串再去量，坐标就整体挪了位。`\n` 在 UTF-8 里是单字节，
 * 所以最后一个 `0x0a` 在字节里的位置就是它在磁盘上的位置——这一份量的就是它。
 *
 * 今天这条坐标只用来切出"完整的那一段"；将来那一步（截掉未提交的尾段）要拿它当文件偏移用，
 * 所以现在就从原字节上取。
 */
export function completeEndOf(buf: Buffer): number {
  const lastNewline = buf.lastIndexOf(0x0a)
  return lastNewline === -1 ? 0 : lastNewline + 1
}

/**
 * 把窗口读满，返回**真正读到的字节数**。
 *
 * **`read` 允许短读**（返回的字节数比要的少，甚至为 0），所以"读了一次"不等于"窗口在那儿"：
 * 拿半份窗口去算序号，是在替这份日志猜。读到 0 就停下（提前到了文件尾，或者文件在读取中变短）
 * ——拒不拒由调用方定，这一层只如实报数。
 */
export async function readFully(
  fh: { read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> },
  buf: Buffer,
  start: number,
): Promise<number> {
  let used = 0
  while (used < buf.length) {
    const read = await fh.read(buf, used, buf.length - used, start + used)
    if (read.bytesRead === 0) break
    used += read.bytesRead
  }
  return used
}

/**
 * 写者准备时从文件尾取回下一个序号，并给出**最后一个完整行的字节终点**。
 *
 * B04：读那一侧一直容忍半行（`parseWriterText`），但写这一侧原先不截；重新打开之后下一条完整
 * 事件直接接在半行后面，拼成一条坏 JSON。**只有拿着该 writer 锁的写者**才可以截：只读路径
 * 仍然一个字节都不改。
 *
 * 窗口从 64 KiB 起**向后再退**（审查 B04 的第二个边界）：合法事件没有大小上限，最后一行可能
 * 比窗口长；固定窗口会让一份本来完好的日志报“无法确定序号”。这里只在没找到换行时把窗口往前
 * 扩，代价与那一行的长度成正比——不拿“截短契约”换固定代价。
 */
async function tailState(fh: FileHandle, w: WriterId): Promise<{ readonly seq: LogSeq; readonly completeEnd: number }> {
  const st = await fh.stat()
  if (st.size === 0) return { seq: 0, completeEnd: 0 }
  const readAt = async (start: number, length: number): Promise<Buffer> => {
    const buf = Buffer.alloc(length)
    const used = await readFully(fh, buf, start)
    if (used !== length) throw new LogCorruptError(w, 0, '日志尾部在读取中改变，拒绝恢复')
    return buf
  }
  // 一 · 最后一个换行（= 最后一条完整行的终点）。
  let end = st.size
  let lastNl = -1
  while (end > 0) {
    const start = Math.max(0, end - TAIL_WINDOW)
    const buf = await readAt(start, end - start)
    const at = buf.lastIndexOf(0x0a)
    if (at >= 0) {
      lastNl = start + at
      break
    }
    end = start
  }
  // 整份文件一条换行都没有：就是一条没写完的行（崩溃在第一次追加中间），序号从 1 重新起。
  if (lastNl < 0) return { seq: 0, completeEnd: 0 }
  const completeEnd = lastNl + 1

  // 二 · 这一行自己的起点（它前面那个换行）。
  let scan = lastNl
  let prevNl = -1
  while (scan > 0) {
    const start = Math.max(0, scan - TAIL_WINDOW)
    const buf = await readAt(start, scan - start)
    const at = buf.lastIndexOf(0x0a)
    if (at >= 0) {
      prevNl = start + at
      break
    }
    scan = start
  }
  const lineStart = prevNl + 1
  const last = (await readAt(lineStart, lastNl - lineStart)).toString('utf8')
  const d = decodeLine(last)
  if (!d.ok) throw new LogCorruptError(w, 0, `日志尾部不可解析：${d.reason}`)
  // **信封里的 writer 也要与这一份文件名对得上**：读那一侧早就查（`parseWriterText`），写这一侧
  // 原先不查——一份改名或拷错的日志会顺着别人的序号往下写，而那段序号区间不属于它。
  if (d.pos.writer !== w) {
    throw new LogCorruptError(w, 0, `信封里的 writer 与文件名不符：${JSON.stringify(d.pos.writer)}`)
  }
  return { seq: d.pos.seq, completeEnd }
}

interface WriterState {
  fh: FileHandle
  nextSeq: LogSeq
  sinceSync: number
  chain: Promise<unknown>
}

export function openLog(root: string, opts: LogOptions = {}): LogHandle {
  const sync: SyncLevel = opts.sync ?? 'batch'
  const batchEvery = opts.batchEvery ?? DEFAULT_BATCH_EVERY
  const writers = new Map<WriterId, WriterState>()
  // **同一个 writer 只初始化一次**：两笔并发追加都走 `state(w)`，各开一个句柄、各自从尾部读一次
  // 序号——两个句柄于是拿到同一个序号，而"同一 writer 内序号唯一"是承重的。在飞的初始化挂在这
  // 一份表里，后来的人等它。
  const initializing = new Map<WriterId, Promise<WriterState>>()
  // **拿不到就当场抛**——不等一个不知道多久的持者（`hold.ts` 的头一段）。
  if (opts.write !== undefined && opts.hold !== undefined) {
    throw new Error('openLog：`write` 与 `hold` 只能给一个——两种来路说不清谁持有那一把栅栏')
  }
  // **栅栏的两条来路**（上一版拆件）：`write` 是「这条句柄自己取」（单 writer 那八条写命令），
  // `hold` 是「调用方已经拿全了再开口」（多 writer 的命令——「要 N 把先拿全再开口」，§ 9.11）。
  const hold: Hold | null =
    opts.hold ?? (opts.write === undefined ? null : holdWriter(root, opts.write))
  // **给钟的判据在写者一侧**：缺省给，`clock: false` 是不给的那一档（命令行是 `--no-clock`）。
  const stamp = opts.clock !== false

  /**
   * **句柄内的解析记忆**（U5）。`readMerged` 每一趟对每份日志全量 `readFile` + 逐行
   * `JSON.parse`（`watch.ts` 头上那句「每一趟读全量」如实写的代价）；跟随档一个会话成千趟
   * 静默轮询，全部花在重读上。缓存的键是 `(mtimeMs, size)` **双要素，只认两个都没变**：
   * 追加只改 size（mtime 可能落在同一毫秒里），`utimes` 只改 mtime——每个方向都由另一半
   * 逼它失效。缓存放这条句柄的闭包里，**不进 `Log` 的方法面**（§ 8.1 三个方法一个不增）；
   * 写者档不特殊对待：`append` 落盘后 size 变了，缓存自然失效、重读。stat 与 readFile
   * 之间又被追加的最坏情形是缓存的键偏旧——下一趟 stat 一对就失效，多读一次，不出错读。
   */
  const parsed = new Map<WriterId, { mtimeMs: number; size: number; rows: Row[] }>()
  async function readWriter(w: WriterId): Promise<Row[]> {
    const file = logFileOf(root, w)
    let st
    try {
      st = await stat(file)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        parsed.delete(w)
        return []
      }
      throw err
    }
    const hit = parsed.get(w)
    if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.rows
    const rows = await readWriterUncached(root, w)
    parsed.set(w, { mtimeMs: st.mtimeMs, size: st.size, rows })
    return rows
  }

  function state(w: WriterId): Promise<WriterState> {
    const hit = writers.get(w)
    if (hit !== undefined) return Promise.resolve(hit)
    const pending = initializing.get(w)
    if (pending !== undefined) return pending
    const file = logFileOf(root, w)
    const opening = (async (): Promise<WriterState> => {
      await mkdir(dirname(file), { recursive: true })
      const fh = await open(file, 'a+')
      let nextSeq: LogSeq
      try {
        const tail = await tailState(fh, w)
        // **B04：拿着锁的写者，在第一次追加之前把未提交的尾段截到完整行边界。**
        // 只读路径不走到这里（它们不改盘上任何字节）；中段损坏照旧由读者拒绝。
        const size = (await fh.stat()).size
        if (tail.completeEnd < size) await fh.truncate(tail.completeEnd)
        nextSeq = tail.seq + 1
      } catch (err) {
        await fh.close()
        throw err
      }
      const s: WriterState = { fh, nextSeq, sinceSync: 0, chain: Promise.resolve() }
      writers.set(w, s)
      return s
    })()
    initializing.set(w, opening)
    // **两个收尾分支都只删自己那一份**：失败不留在表里，后一次可以重试（谁的表谁收拾）。
    const settled = (): void => {
      if (initializing.get(w) === opening) initializing.delete(w)
    }
    void opening.then(settled, settled)
    return opening
  }

  /** 同一个 writer 内序号必须唯一且有序，所以它的追加串成一条链；跨 writer 不串。 */
  function serialize<T>(s: WriterState, fn: () => Promise<T>): Promise<T> {
    const run = s.chain.then(fn, fn)
    s.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function append(w: WriterId, e: LogEvent): Promise<LogSeq> {
    // 持着 a1 的锁却往 a2 里追加，是"一次命令一个 writer"这条规矩被违反——当面报出来。
    if (hold !== null && hold.writer !== w) {
      throw new Error(
        `这条句柄持的是 ${hold.writer} 的锁，却要往 ${w} 的日志里追加：一次命令只写一个 writer`,
      )
    }
    const s = await state(w)
    return serialize(s, async () => {
      const seq = s.nextSeq
      // 取钟**只在写者那一侧**（渲染器不塑造事件模型，也不产生时刻）；不给钟时给 `null`。
      await s.fh.write(encodeEvent(seq, w, e, stamp ? clockOf() : null) + '\n')
      s.nextSeq = seq + 1
      s.sinceSync++
      if (sync === 'each' || (sync === 'batch' && s.sinceSync >= batchEvery)) {
        await s.fh.sync()
        s.sinceSync = 0
      }
      return seq
    })
  }

  async function* readByWriter(w: WriterId, fromSeq: LogSeq = 0): AsyncGenerator<LogEvent> {
    for (const row of await readWriter(w)) {
      if (row.pos.seq > fromSeq) yield row.e
    }
  }

  /**
   * 按 `(seq, writer)` 的字典序合并全部 writer。k 路归并，每取一条比较 k 次——
   * writer 数以十计，比堆的常数因子划算。**内部那一份带钟**，对外的两条读法各自摘自己那几栏。
   */
  async function* mergedRows(fromSeq: LogSeq = 0): AsyncGenerator<Row> {
    const lists: Row[][] = []
    for (const w of await listWriters(root)) {
      lists.push((await readWriter(w)).filter((r) => r.pos.seq > fromSeq))
    }
    const idx = lists.map(() => 0)
    for (;;) {
      let best = -1
      for (let i = 0; i < lists.length; i++) {
        if (idx[i] >= lists[i].length) continue
        if (best === -1) {
          best = i
          continue
        }
        const a = lists[i][idx[i]].pos
        const b = lists[best][idx[best]].pos
        if (a.seq < b.seq || (a.seq === b.seq && a.writer < b.writer)) best = i
      }
      if (best === -1) return
      const row = lists[best][idx[best]]
      idx[best]++
      yield row
    }
  }

  /** § 8.1 的那一条读法：`{ pos, e }`——钟不进这里。 */
  async function* readMerged(fromSeq: LogSeq = 0): AsyncGenerator<{ pos: LogPos; e: LogEvent }> {
    for await (const row of mergedRows(fromSeq)) yield { pos: row.pos, e: row.e }
  }

  async function clocks(): Promise<readonly ClockedRow[]> {
    const out: ClockedRow[] = []
    for await (const row of mergedRows()) out.push({ pos: row.pos, clock: row.clock })
    return out
  }

  async function close(): Promise<void> {
    const all = [...writers.values()]
    writers.clear()
    await Promise.all(all.map((s) => s.fh.close().catch(() => undefined)))
    if (hold !== null) hold.release()
  }

  return { append, readByWriter, readMerged, writers: () => listWriters(root), clocks, close }
}

/**
 * 把**交错的全序流**切成某个 writer 的那一份，冒充它的日志（只读）。
 *
 * 两个地方要它：`replay --verify` 与第四单元的交错断言。它兑现的是 § 9.2 那句话——
 * `writer` 字段是"重放时用于交错排序"的，于是**同一份历史有两种读法**：按 writer 读，
 * 或按交错序读再筛。两种读法重建出来的视图必须逐字节相同，否则"重建结果只由自己的操作
 * 决定"就是空的。
 *
 * 它不实现 `append`：这条面是只读的，重放不该有写路径。
 */
export function mergedFace(log: Log, w: WriterId): LogReader {
  return {
    readByWriter: async function* (target: WriterId, fromSeq: LogSeq = 0): AsyncGenerator<LogEvent> {
      for await (const { pos, e } of log.readMerged(fromSeq)) {
        if (pos.writer === target) yield e
      }
    },
  }
}
