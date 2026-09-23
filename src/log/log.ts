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
import { mkdir, open, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertIdent } from '../identity.ts'
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
    rows.push({ pos: d.pos, e: d.event })
  }
  return rows
}

async function readWriter(root: string, w: WriterId): Promise<Row[]> {
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
 * 从文件尾取回该 writer 的下一个序号。**只读一个窗口**，不读整份日志——
 * 追加的代价因此与已有日志的长度无关（架构 § 9.4 的重建代价上界）。
 */
async function tailSeq(fh: FileHandle, w: WriterId): Promise<LogSeq> {
  const st = await fh.stat()
  if (st.size === 0) return 0
  const want = Math.min(st.size, TAIL_WINDOW)
  const buf = Buffer.alloc(want)
  await fh.read(buf, 0, want, st.size - want)
  let text = buf.toString('utf8')
  if (want < st.size) {
    // 窗口的第一行可能被切断，丢掉它。
    const nl = text.indexOf('\n')
    text = nl === -1 ? '' : text.slice(nl + 1)
  }
  const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1)
  if (complete.length === 0) {
    // 窗口里一条完整行都没有。两种情形必须分开：整份文件就是一条半行（崩溃在第一
    // 次追加的中间，序号从 1 起）；或者窗口比一行还短——那就不能猜。
    if (want < st.size) {
      throw new LogCorruptError(w, 0, `尾部 ${TAIL_WINDOW} 字节内没有完整行，无法确定下一个序号`)
    }
    return 0
  }
  const last = complete.slice(0, -1)
  const d = decodeLine(last.slice(last.lastIndexOf('\n') + 1))
  if (!d.ok) throw new LogCorruptError(w, 0, `日志尾部不可解析：${d.reason}`)
  return d.pos.seq
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
  // **拿不到就当场抛**——不等一个不知道多久的持者（`hold.ts` 的头一段）。
  const hold: Hold | null = opts.write === undefined ? null : holdWriter(root, opts.write)

  async function state(w: WriterId): Promise<WriterState> {
    const hit = writers.get(w)
    if (hit) return hit
    const file = logFileOf(root, w)
    await mkdir(dirname(file), { recursive: true })
    const fh = await open(file, 'a+')
    let nextSeq: LogSeq
    try {
      nextSeq = (await tailSeq(fh, w)) + 1
    } catch (err) {
      await fh.close()
      throw err
    }
    const s: WriterState = { fh, nextSeq, sinceSync: 0, chain: Promise.resolve() }
    writers.set(w, s)
    return s
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
      await s.fh.write(encodeEvent(seq, w, e) + '\n')
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
    for (const row of await readWriter(root, w)) {
      if (row.pos.seq > fromSeq) yield row.e
    }
  }

  /**
   * 按 `(seq, writer)` 的字典序合并全部 writer。k 路归并，每取一条比较 k 次——
   * writer 数以十计，比堆的常数因子划算。
   */
  async function* readMerged(fromSeq: LogSeq = 0): AsyncGenerator<{ pos: LogPos; e: LogEvent }> {
    const lists: Row[][] = []
    for (const w of await listWriters(root)) {
      lists.push((await readWriter(root, w)).filter((r) => r.pos.seq > fromSeq))
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
      yield { pos: row.pos, e: row.e }
    }
  }

  async function close(): Promise<void> {
    const all = [...writers.values()]
    writers.clear()
    await Promise.all(all.map((s) => s.fh.close().catch(() => undefined)))
    if (hold !== null) hold.release()
  }

  return { append, readByWriter, readMerged, writers: () => listWriters(root), close }
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
