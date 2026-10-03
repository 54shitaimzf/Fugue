// M0 的栅栏：**一份日志一个写者进程**。出处：架构 § 9.2（`log/<writer>.jsonl`）· § 9.7（观察不加锁）。
//
// 为什么需要它：一个 writer 的序号是**从文件尾读一次**得来的（`log.ts` 的 `tailSeq`），串行化
// 只在进程内（那条 `serialize` 链）。两个进程同时读到同一个尾，就各领一个同样的号——于是同一
// 份日志里出现两条 `seq` 相同的事件，而**从快照重放**会把其中一条整条丢掉（快照的戳与内容错位）。
// 这是真源上的静默损坏，不是一次读写失败：`replay --verify` 有时抓得到它，有时连它都过。
//
// 三条边界：
//
//   · **按 writer 分文件**（`<root>/.fugue/log/<writer>.lock`）：挡的是"同一个 writer 的两个
//     进程"，不是并发本身。不同 agent 之间零协调，D11 一个字没动。
//   · **只在写命令上取**（`LogOptions` 的 `write` 选项 · CLI 的写组）。读命令一律不取：架构
//     § 9.7 把"加锁"与"预取、提前物化"并列——观察一旦加锁，它就成了第二个写入者。
//   · **陈旧锁自己拿回来**：判死看三样——boot id（跨启动 pid 号段会重来）· pid 还在不在 ·
//     进程起始时刻对不对得上（pid 会被复用）。**"文件还在"什么都不能说明**：`kill -9` 不清理
//     任何东西，而持者进程可能早就没了。
//
// **拿不到就是拒绝，不是等待。** 一次 CLI 调用就是一条命令的全部生命，等一个不知道多久的持者
// 会把"卡住"变成新的失败模式。被拒的是**同一个 writer**的命令——所以这个代价落在"同一个 agent
// 的两条命令同时敲"上，不在并发本身。
//
// 一处已知的窄窗（记在 PLAN § 5.3 的疑点清单里）：两个进程同时判死同一个陈旧锁时，都走
// "删掉再建"这一条路，`unlink` 与 `link` 之间理论上可以插进第三个进程刚建好的锁。窗口是微秒
// 级，且要求"一个死掉的持者 + 两个同时接管的进程"三件事同时成立。`link` 的原子性保证了最终
// 只有一个持有者，重试把它兜住——但这条窄窗是真的，不假装它不存在。
//
// 与 `log.ts` 是一对互相 import 的函数：它要 `holdWriter`，这里要 `logFileOf`（路径与身份
// 检查都只有一处实现）。环是安全的——两边都只在**调用时**用对方的东西，而函数声明在模块实例化
// 时就已就位。不把路径那半抄一份过来：身份这条规矩今天已经有两份实现（W3 要收掉它们），
// 第三份不是这一站该添的东西。
import { closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { logFileOf } from './log.ts'
import type { WriterId } from '../terms.ts'

/** 持者：消息里报的那两样（谁 · 什么时候起的）。 */
export interface Holder {
  readonly pid: number
  /** 持者进程的起始时刻，epoch 毫秒；读不出来（没有 `/proc`）给 `null`。 */
  readonly since: number | null
}

/** 拿到的那道锁。**`release()` 幂等**：放过的再放一次不算错。 */
export interface Hold {
  readonly writer: WriterId
  /** 锁文件：`<root>/.fugue/log/<writer>.lock`。 */
  readonly path: string
  readonly pid: number
  /** 拿到的时刻，epoch 毫秒。 */
  readonly since: number
  release(): void
}

/**
 * 这份日志已经有写者了。**带持者的 pid 与起始时刻**：一条只说"锁着"的文案让人只能去猜是哪个
 * 进程，而"哪一个进程"正是人接下来要判的东西（它还活着吗，该等还是该删）。
 */
export class LogHeldError extends Error {
  readonly writer: WriterId
  readonly path: string
  /** 持者；读不出来是 `null`（锁文件被人改过 · 写了一半就被杀）。 */
  readonly holder: Holder | null
  /** 判据：为什么判它活着（或者为什么判不出来）。 */
  readonly why: string

  constructor(writer: WriterId, path: string, holder: Holder | null, why: string) {
    super(heldMessage(writer, path, holder))
    this.name = 'LogHeldError'
    this.writer = writer
    this.path = path
    this.holder = holder
    this.why = why
  }
}

/** 失败要指路（§ 24 纪律 5）：**等**或者**删**，两条路都要给得出具体的那一条命令。 */
function heldMessage(writer: WriterId, path: string, holder: Holder | null): string {
  const who =
    holder === null
      ? '锁在那儿，但持者读不出来'
      : `pid ${holder.pid}${holder.since === null ? '' : `（起始于 ${new Date(holder.since).toISOString()}）`}`
  const road =
    holder === null
      ? '先确认没有别的写者在写这一份，再删掉那个锁文件。'
      : `等它结束再敲；确认它不在了（\`kill -0 ${holder.pid}\` 失败）就删掉那个锁文件。`
  return `${writer} 的日志已经有写者：${who} · 锁 ${path}\n一份日志一个写者进程。${road}`
}

/**
 * 该 writer 的锁文件：与它的日志**同一个目录、同一个名字**，只换后缀。
 *
 * 同目录不是随手：`<writer>.jsonl` 与 `<writer>.lock` 摆在一起，"这一份日志"与"这一份日志的
 * 锁"就只有一个坐标可指；`logFileOf` 顺带把身份检查也过了一遍（`dispose` 那条直接拿锁的路
 * 因此不必自己再检查一次）。
 */
export function lockFileOf(root: string, w: WriterId): string {
  return join(dirname(logFileOf(root, w)), w + '.lock')
}

/** 锁文件里的那条记录。**人读得出来**是它有这些字段的理由之一：出问题时要能直接 `cat` 它。 */
interface LockRecord {
  readonly v: number
  readonly writer: string
  readonly pid: number
  /** 进程起始时刻，内核 tick（`/proc/<pid>/stat` 第 22 个字段）。 */
  readonly start: number
  /** 机器这一次启动的 id（`/proc/sys/kernel/random/boot_id`）。 */
  readonly boot: string
  /** 拿到的时刻，epoch 毫秒。 */
  readonly t: number
}

/** 同时判死同一个锁的进程数上限。到了还没抢到就认输——拒绝，不是接着转。 */
const TAKEOVER_ROUNDS = 5

/** USER_HZ：`/proc/<pid>/stat` 的 `starttime` 以它为刻度（Linux 上恒为 100）。 */
const HZ = 100

function bootId(): string | null {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    return null
  }
}

/** 某个进程的起始时刻（内核 tick）。读不到——没有 `/proc`，或者 pid 不在——给 `null`。 */
function startOf(pid: number): number | null {
  let text: string
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return null
  }
  // 第二个字段是 comm，**它自己可以带空格与括号**，所以从最后一个 `)` 之后开始切。
  const close = text.lastIndexOf(')')
  if (close === -1) return null
  const fields = text.slice(close + 2).split(' ')
  const start = Number(fields[19]) // `state` 是第 3 个字段 → 第 22 个字段的下标是 19
  return Number.isInteger(start) ? start : null
}

/** 机器这一次的启动时刻（epoch 毫秒）。读不到给 `null`。 */
function bootMs(): number | null {
  try {
    const up = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0])
    return Number.isFinite(up) ? Date.now() - Math.round(up * 1000) : null
  } catch {
    return null
  }
}

/**
 * tick → epoch 毫秒。**只给人读**（消息里那个"起始于"）：判定一律用 tick 本身比，因为换算
 * 要借 `/proc/uptime`，而那是个近似值。
 */
function sinceOf(start: number): number | null {
  const base = bootMs()
  return base === null ? null : base + Math.round((start * 1000) / HZ)
}

interface Verdict {
  readonly alive: boolean
  readonly why: string
}

/**
 * 这个持者还活着吗。**三样一起看**，少一样就会把死锁读成活锁（或者反过来）：
 *
 *   · boot id —— 机器重启过，记录里的 pid 属于上一次启动，号段早重来了；
 *   · pid 在不在 —— `/proc/<pid>` 没有就是不在了；
 *   · 起始时刻对不对得上 —— pid 被复用（内核绕回来发给了另一个进程）时，只有这一条分得开。
 *
 * 读不到 boot id（没有 `/proc`）时**按活着处理**：拒绝是安全的失败，放行不是。
 */
function judge(rec: LockRecord): Verdict {
  const boot = bootId()
  if (boot === null) return { alive: true, why: '读不到 boot id，判不了死活——按活着处理' }
  if (rec.boot !== boot) {
    return { alive: false, why: `那是上一次启动留下的（boot ${rec.boot.slice(0, 8)}）` }
  }
  const start = startOf(rec.pid)
  if (start === null) return { alive: false, why: `pid ${rec.pid} 不在了` }
  if (start !== rec.start) {
    return { alive: false, why: `pid ${rec.pid} 已经被复用了（起始时刻 ${start} ≠ ${rec.start}）` }
  }
  return { alive: true, why: `pid ${rec.pid} 还活着` }
}

type Read = { readonly rec: LockRecord } | { readonly bad: string }

/** 读锁文件。**读不动与"没有锁"是两回事**：前者给 `{bad}`（拒绝，并把原因说出来），后者给 `null`。 */
function readRecord(path: string): Read | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null
    return { bad: (err as Error).message }
  }
  let v: LockRecord
  try {
    v = JSON.parse(text) as LockRecord
  } catch (err) {
    return { bad: `不是一段 JSON（${(err as Error).message}）` }
  }
  if (typeof v?.pid !== 'number' || typeof v?.start !== 'number' || typeof v?.boot !== 'string') {
    return { bad: `字段不全：${text.trim().slice(0, 80)}` }
  }
  return { rec: v }
}

function drop(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // 已经不在了 = 目的已经达到。
  }
}

/** **只删空的**：非空（别人还在用这一层）与已经不在了，都不是错。 */
function dropDir(dir: string): void {
  try {
    rmdirSync(dir)
  } catch {
    // ENOTEMPTY / ENOENT：两种都说明这一层不用我管。
  }
}

/**
 * 拿这道锁。拿不到抛 `LogHeldError`，**不等待、不重试到天荒地老**。
 *
 * 建成的方式是 `link` 而不是 `open('wx')`：写内容与占位**必须是一步**。分成两步的话，另一个
 * 进程会读到一个刚建好、还没有内容的锁——那要么被当成"没人持"，要么被当成"持者不明"，
 * 两种都不是事实。
 *
 * 持者是**本进程**时同样拒绝：一份日志一个写者，而"同一个进程里两份句柄"是这条规矩的一个特例，
 * 不是例外。同一进程里再拿一次是程序错误，报出来比放行好。
 */
export function holdWriter(inputRoot: string, w: WriterId): Hold {
  const root = resolve(inputRoot)
  const path = lockFileOf(root, w) // 身份检查在 logFileOf 里，只有一处
  const dir = dirname(path)
  const up = dirname(dir)
  // **自己建的那两层空目录，放锁时要还回去。** 锁住在 `log/` 底下，于是「取锁」这一步会顺手
  // 把 `.fugue/log/`（连同 `.fugue/`）建出来——而「一条没成的命令不在盘上留下任何东西」是壳
  // 那一层已经立着的断言（`fugue.test.ts` 的退出码那条：一条 `remove` 一个不存在的路径也
  // 算在里面）。自己建的就自己收，别让它替别人留下痕迹。
  const madeLog = !existsSync(dir)
  const madeUp = !existsSync(up)
  mkdirSync(dir, { recursive: true })
  const since = Date.now()
  const rec: LockRecord = {
    v: 1,
    writer: w,
    pid: process.pid,
    start: startOf(process.pid) ?? 0,
    boot: bootId() ?? '',
    t: since,
  }
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(rec) + '\n', { mode: 0o644, flag: 'wx' })

  // Keep the original inode alive even if its directory entry is removed/replaced.
  // A numeric inode snapshot alone could be reused after unlink.
  let created: Stats | undefined, fd: number | undefined
  const dropTemporary = (): void => {
    if (created === undefined) return
    let current: Stats
    try { current = lstatSync(tmp) } catch { return }
    if (current.isFile() && current.dev === created.dev && current.ino === created.ino) drop(tmp)
  }
  let released = false
  try {
    created = lstatSync(tmp)
    if (!created.isFile()) throw new Error('临时锁已换成非普通文件，拒绝持有')
    const pin = openSync(tmp, 'r')
    fd = pin
    const owned = fstatSync(pin)
    if (!owned.isFile() || owned.dev !== created.dev || owned.ino !== created.ino) {
      throw new Error('临时锁在打开时已换成别的文件，拒绝持有')
    }
    const release = (): void => {
      if (released) return
      released = true
      try {
        let current
        try { current = lstatSync(path) }
        catch { return }
        if (!current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) return
        // Preserve the existing PID/start policy as well as creation identity.
        const cur = readRecord(path)
        if (cur !== null && 'bad' in cur) return
        if (cur !== null && 'rec' in cur && (cur.rec.pid !== rec.pid || cur.rec.start !== rec.start)) return
        drop(path)
        if (madeLog) {
          dropDir(dir)
          if (madeUp) dropDir(up)
        }
      } finally { closeSync(pin) }
    }

    for (let round = 0; round < TAKEOVER_ROUNDS; round++) {
      try {
        linkSync(tmp, path) // 原子：建得上就是我的；EEXIST 说明有人
        const linked = lstatSync(path)
        if (!linked.isFile() || linked.dev !== owned.dev || linked.ino !== owned.ino) {
          throw new Error('锁路径在取得时已换成别的文件，拒绝持有')
        }
        dropTemporary()
        return { writer: w, path, pid: rec.pid, since, release }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          // 另一个进程刚把它自己建的那两层空目录收走了（见 `release`）：再建一次，接着抢。
          mkdirSync(dir, { recursive: true })
          continue
        }
        if (code !== 'EEXIST') {
          dropTemporary()
          throw new Error(`锁建不出来（${path}）：${code ?? (err as Error).message}`)
        }
      }
      const cur = readRecord(path)
      if (cur === null) continue // 刚好被放掉了：再抢一次
      if ('bad' in cur) {
        dropTemporary()
        throw new LogHeldError(w, path, null, `锁文件读不动：${cur.bad}`)
      }
      const verdict = judge(cur.rec)
      if (verdict.alive) {
        dropTemporary()
        throw new LogHeldError(
          w,
          path,
          { pid: cur.rec.pid, since: sinceOf(cur.rec.start) },
          verdict.why,
        )
      }
      // 死的：把它请走，再抢一次。**删之前按记录比对一次**——这中间可能已经换人了。
      const again = readRecord(path)
      if (again !== null && 'rec' in again && again.rec.pid === cur.rec.pid && again.rec.start === cur.rec.start) {
        drop(path)
      }
    }
    dropTemporary()
    const last = readRecord(path)
    const holder =
      last !== null && 'rec' in last ? { pid: last.rec.pid, since: sinceOf(last.rec.start) } : null
    throw new LogHeldError(w, path, holder, `连着 ${TAKEOVER_ROUNDS} 次都有人抢先`)
  } catch (err) {
    // Acquisition failures keep their original classification; still observe pin retirement.
    try { dropTemporary() } catch { /* still attempt descriptor retirement */ }
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* primary refusal/error wins */ }
    }
    throw err
  }
}
