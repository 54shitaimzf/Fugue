// M2 · 每 agent 一份的内存视图（§ 8.3）。**纯内存，且不知道自己的来源**：它没有
// open/close/flush，持久性全部由 M0 承担——先持久，后重建；重建就是重放。
//
// 三条规则决定这里的一切：
//
// 一 · **上层说了算，墓碑遮住下层的整棵子树。** 一个路径可见，当且仅当：它在 upper 里
//      （入口，不是墓碑），或它是 upper 某条入口的隐含目录，或它既不在 upper 里、也没被
//      某条墓碑遮住——那时才轮到 lower。于是"删掉一个目录"是一条墓碑，"删了再往里写一个
//      新文件"只需要一条写：目录自己回来，被删掉的兄弟不回来。
// 二 · **改名不搬字节。** 上层已有的入口整棵搬走；只有下层才有的，读上来再写下去（拷
//      上来）。目录改名要把下层整棵子树都拷上来——那是随目录大小无界的读，S1 明确拒绝，
//      不静默给出一个少了一半文件的结果。
// 三 · **`diff` 给的是变更序列，不是净差异。** 净差异里一次改名会退化成"删一条 + 加一
//      条"，而 § 8.5 要求 `applyDelta` 覆盖 `rename` 这一情形。序列是重放的片段：把它
//      交给 `applyDelta`，与交给任何一批 delta 没有区别。
import { createHash } from 'node:crypto'
import { MODE_FILE, normMode } from '../delta.ts'
import type { Delta } from '../delta.ts'
import { EMPTY_TREE_ID } from '../entries.ts'
import type { DirEntry, EntryMeta } from '../entries.ts'
import { agentFor } from '../identity.ts'
import { PathShapeError } from '../path-shape.ts'
import type { LogEvent, LogReader } from '../log/events.ts'
import type { AgentId, BlobId, CommitId, RelPath, ViewRev, WriterId } from '../terms.ts'
import type {
  Entry,
  LoadViewOptions,
  Lower,
  SnapEntry,
  UpperEntry,
  View,
  ViewSnapshot,
  ViewState,
} from './contract.ts'

const DIR_MODE = 0o40000
const SYMLINK_MODE = 0o120000

/**
 * 内容的 blob id：`sha1("blob <字节数>\0" + 内容)`。
 *
 * **不发一个进程**——上层的内容就在手里。下层文件的 id 来自 `list` 的行，也不读内容；
 * 于是"把整棵树读出来"这件事不读一个字节的 blob。代价是一处已知边界：sha256 仓库里
 * 这个算法不是 sha1（与 M1 那处未测的边界同源，见交付说明）。
 */
const blobIds = new WeakMap<Uint8Array, BlobId>()
function blobIdOf(bytes: Uint8Array): BlobId {
  const hit = blobIds.get(bytes)
  if (hit !== undefined) return hit
  const h = createHash('sha1')
  h.update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
  h.update(bytes)
  const id = h.digest('hex')
  blobIds.set(bytes, id)
  return id
}

function metaOf(e: Entry): EntryMeta {
  if (e.kind === 'file') {
    return { kind: 'file', mode: e.mode, size: e.bytes.length, id: blobIdOf(e.bytes) }
  }
  if (e.kind === 'symlink') {
    const bytes = Buffer.from(e.target, 'utf8')
    return { kind: 'symlink', mode: SYMLINK_MODE, size: bytes.length, id: blobIdOf(bytes) }
  }
  return dirMeta()
}

function dirMeta(): EntryMeta {
  return { kind: 'dir', mode: DIR_MODE, size: 0, id: EMPTY_TREE_ID }
}

function dirRow(name: string): DirEntry {
  return { name, ...dirMeta() }
}

function rowOf(name: string, e: Entry): DirEntry {
  return { name, ...metaOf(e) }
}

/** 视图内的相对路径。空串是根，只有 `list` 收它。 */
function pathOf(raw: RelPath, opts: { root?: boolean } = {}): string {
  let p = raw.trim()
  while (p.startsWith('./')) p = p.slice(2)
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  if (p === '' || p === '.') {
    if (opts.root === true) return ''
    throw new PathShapeError('需要一个路径（`.` 是根，不指某一条文件）')
  }
  if (p.startsWith('/')) throw new PathShapeError(`视图内的路径是相对的：${raw}`)
  for (const s of p.split('/')) {
    if (s === '') throw new PathShapeError(`路径里有空段：${raw}`)
    if (s === '.') throw new PathShapeError(`路径里有 . 段：${raw}`)
    if (s === '..') throw new PathShapeError(`路径里有 ..：${raw}`)
  }
  return p
}

/** 严格在 `p` 下面的前缀，由远到近；不含 `p`。 */
function ancestorsOf(p: string): string[] {
  const out: string[] = []
  for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) out.push(p.slice(0, i))
  return out
}

function under(p: string, dir: string): boolean {
  return dir === '' ? p !== '' : p.startsWith(dir + '/')
}

function cloneDelta(d: Delta): Delta {
  switch (d.kind) {
    case 'add':
    case 'modify':
      return { ...d, bytes: d.bytes.slice() }
    default:
      return { ...d }
  }
}

class MemoryView implements View {
  readonly id: AgentId
  private readonly lower: Lower
  private readonly upper: Map<string, UpperEntry>
  /** 隐含目录：严格在它下面的活入口数。0 的键删掉，`has` 即为判据。 */
  private readonly counts: Map<string, number>
  private readonly ops: { rev: ViewRev; delta: Delta }[]
  private readonly points: Set<ViewRev>
  private cur: ViewRev
  /** 从快照起时的起点：比它更早的修订点与变更序列不在这个视图里（见 `diff`）。 */
  private floor: ViewRev

  constructor(id: AgentId, lower: Lower) {
    this.id = id
    this.lower = lower
    this.upper = new Map()
    this.counts = new Map()
    this.ops = []
    this.points = new Set()
    this.cur = 0
    this.floor = 0
  }

  get base(): CommitId | null {
    return this.lower.base
  }

  get rev(): ViewRev {
    return this.cur
  }

  /**
   * 全部可达修订点，升序，**不重复**。
   *
   * 去重不是洁癖：`ckpt/commit` 会把当刻的 rev 再记一次（空视图上的第一次提交记的就是 0），
   * 于是从 0 全量重放会数出两个 0，而从快照起的视图数不出——`replay --verify` 的两条路
   * 一比就分家。修订点是**集合**，不是计数。
   */
  get revs(): ViewRev[] {
    return [...new Set([0, ...this.points])].sort((a, b) => a - b)
  }

  hasUpper(path: RelPath): boolean {
    return this.upper.has(pathOf(path))
  }

  /**
   * 这次写是 `add` 还是 `modify`：**只看上层有没有它，不看下层**。
   *
   * 看下层会随 base 前移而变——同一个 `view/write` 事件，活路径上可能是 `add`，重放时
   * 下层已经有了就成 `modify`，而 § 8.3 的验证性质要求 `diff()` 在重放前后逐字节一致。
   * 只看上层就没有这个问题：它只由日志前缀决定。
   */
  private kindFor(p: string): 'add' | 'modify' {
    const own = this.upper.get(p)
    return own !== undefined && own.kind !== 'tombstone' ? 'modify' : 'add'
  }

  /** 装配体落日志前问的那一句。与重放的定名共用 `kindFor`——**这就是"重放必须一致"的落点**。 */
  kindOf(path: RelPath): 'add' | 'modify' {
    return this.kindFor(pathOf(path))
  }

  // ────────────────────────────────── 状态：只有这三处会动 upper 与 counts

  private countUp(p: string): void {
    for (const a of ancestorsOf(p)) this.counts.set(a, (this.counts.get(a) ?? 0) + 1)
  }

  private countDown(p: string): void {
    for (const a of ancestorsOf(p)) {
      const n = (this.counts.get(a) ?? 0) - 1
      if (n <= 0) this.counts.delete(a)
      else this.counts.set(a, n)
    }
  }

  private setSlot(p: string, e: UpperEntry): void {
    const old = this.upper.get(p)
    if (old !== undefined && old.kind !== 'tombstone') this.countDown(p)
    this.upper.set(p, e)
    if (e.kind !== 'tombstone') this.countUp(p)
  }

  private dropSlot(p: string): void {
    const old = this.upper.get(p)
    if (old === undefined) return
    if (old.kind !== 'tombstone') this.countDown(p)
    this.upper.delete(p)
  }

  /** 严格在 `p` 下面的全部 upper 键。 */
  private subtree(p: string): string[] {
    return [...this.upper.keys()].filter((k) => under(k, p))
  }

  private hasLive(p: string): boolean {
    return (this.counts.get(p) ?? 0) > 0
  }

  private maskedByAncestor(p: string): boolean {
    for (const a of ancestorsOf(p)) {
      const s = this.upper.get(a)
      if (s !== undefined && s.kind === 'tombstone') return true
    }
    return false
  }

  private note(rev: ViewRev, d: Delta): void {
    this.cur = Math.max(this.cur, rev)
    this.points.add(rev)
    this.ops.push({ rev, delta: cloneDelta(d) })
  }

  private record(d: Delta): ViewRev {
    const rev = this.cur + 1
    this.note(rev, d)
    return rev
  }

  // ────────────────────────────────── 读

  async stat(path: RelPath): Promise<EntryMeta | null> {
    const p = pathOf(path)
    const own = this.upper.get(p)
    if (own !== undefined && own.kind !== 'tombstone') return metaOf(own)
    if (this.hasLive(p)) return dirMeta()
    if (own !== undefined) return null
    if (this.maskedByAncestor(p)) return null
    if (this.lower.base === null) return null
    return await this.lower.stat(p)
  }

  async read(path: RelPath): Promise<Uint8Array | null> {
    const p = pathOf(path)
    const own = this.upper.get(p)
    if (own !== undefined) {
      if (own.kind === 'file') return own.bytes.slice()
      // 符号链接的字节就是它的 target——git 就是这么存的，M1 的 `readAt` 也这么给。
      if (own.kind === 'symlink') return Buffer.from(own.target, 'utf8')
      return null
    }
    if (this.hasLive(p)) return null
    if (this.maskedByAncestor(p)) return null
    if (this.lower.base === null) return null
    return await this.lower.read(p)
  }

  async list(dir: RelPath): Promise<DirEntry[]> {
    const d = pathOf(dir, { root: true })
    const rows = new Map<string, DirEntry>()
    for (const [k, v] of this.upper) {
      if (!under(k, d)) continue
      const rest = d === '' ? k : k.slice(d.length + 1)
      const slash = rest.indexOf('/')
      if (slash !== -1) {
        const name = rest.slice(0, slash)
        if (!rows.has(name)) rows.set(name, dirRow(name))
        continue
      }
      if (v.kind === 'tombstone') continue
      rows.set(rest, rowOf(rest, v))
    }
    if (this.lower.base !== null) {
      for (const r of await this.lower.list(d)) {
        const q = d === '' ? r.name : `${d}/${r.name}`
        if (this.upper.has(q) || rows.has(r.name) || this.maskedByAncestor(q)) continue
        rows.set(r.name, r)
      }
    }
    return [...rows.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /** 这个路径现在存在吗（墓碑与下层一起算）。 */
  private async existsAt(p: string): Promise<boolean> {
    const own = this.upper.get(p)
    if (own !== undefined) return own.kind !== 'tombstone' || this.hasLive(p)
    if (this.hasLive(p)) return true
    if (this.maskedByAncestor(p)) return false
    if (this.lower.base === null) return false
    return (await this.lower.stat(p)) !== null
  }

  /** 把只在 lower 里的路径读成一个上层入口。**这是"懒"的那一半唯一被写下来的地方。** */
  private async copyUp(p: string): Promise<Entry> {
    const own = this.upper.get(p)
    if (own !== undefined && own.kind !== 'tombstone') return own
    const meta = this.lower.base === null ? null : await this.lower.stat(p)
    if (meta === null) throw new Error(`路径不存在：${p}`)
    if (meta.kind === 'file') {
      const bytes = await this.lower.read(p)
      return { kind: 'file', bytes: bytes ?? new Uint8Array(0), mode: meta.mode }
    }
    if (meta.kind === 'symlink') {
      const bytes = await this.lower.read(p)
      return { kind: 'symlink', target: bytes === null ? '' : Buffer.from(bytes).toString('utf8') }
    }
    if (meta.kind === 'gitlink') {
      throw new Error(`${p} 是一个 submodule（gitlink）：它指的是另一个仓库的一个提交，视图不改它`)
    }
    throw new Error(`${p} 是一个目录`)
  }

  // ────────────────────────────────── 问答与执行：同一段判断，两处调用

  async check(d: Delta): Promise<void> {
    switch (d.kind) {
      case 'add':
      case 'modify': {
        const p = pathOf(d.path)
        if (this.hasLive(p)) throw new Error(`写 ${p}：这个路径是一个目录`)
        const own = this.upper.get(p)
        if (own === undefined || own.kind !== 'tombstone') {
          // 上层没说过这里是什么，就问下层：下层是目录或 gitlink 的话，写下去会把它顶掉。
          const m = this.lower.base === null ? null : await this.lower.stat(p)
          if (m !== null && m.kind === 'dir') throw new Error(`写 ${p}：这个路径是一个目录`)
          if (m !== null && m.kind === 'gitlink') {
            throw new Error(`写 ${p}：这个路径是一个 submodule（gitlink），视图不写它`)
          }
        }
        for (const a of ancestorsOf(p)) {
          const s = this.upper.get(a)
          if (s !== undefined && s.kind !== 'tombstone') throw new Error(`写 ${p}：${a} 是一个 ${s.kind}`)
          if (s !== undefined || this.lower.base === null) continue
          const m = await this.lower.stat(a)
          if (m === null) continue
          if (m.kind === 'gitlink') {
            throw new Error(`写 ${p}：${a} 是一个 submodule（gitlink），视图不往里写`)
          }
          if (m.kind !== 'dir') throw new Error(`写 ${p}：${a} 是一个 ${m.kind}`)
        }
        return
      }
      case 'symlink':
        await this.check({ kind: 'add', path: d.path, bytes: new Uint8Array(0), mode: SYMLINK_MODE })
        return
      case 'delete': {
        const p = pathOf(d.path)
        if (!(await this.existsAt(p))) throw new Error(`删除 ${p}：这个路径不存在`)
        return
      }
      case 'rename': {
        const f = pathOf(d.from)
        const t = pathOf(d.to)
        if (f === t) throw new Error('改名的两端是同一个路径')
        if (under(t, f)) throw new Error(`改名不能把 ${f} 挪进它自己里面`)
        if (this.hasLive(f)) {
          throw new Error(`目录改名 S1 不做：${f} 要先把下层整棵子树拷上来（见 view.ts 顶部第二条规则）`)
        }
        const meta = this.upper.has(f) || this.lower.base === null ? null : await this.lower.stat(f)
        if (meta !== null && meta.kind === 'dir') {
          throw new Error(`目录改名 S1 不做：${f} 要先把下层整棵子树拷上来（见 view.ts 顶部第二条规则）`)
        }
        if (!(await this.existsAt(f))) throw new Error(`改名：${f} 不存在`)
        if (await this.existsAt(t)) throw new Error(`改名：${t} 已经存在`)
        await this.check({ kind: 'add', path: t, bytes: new Uint8Array(0), mode: MODE_FILE })
        return
      }
      case 'chmod': {
        const p = pathOf(d.path)
        const own = this.upper.get(p)
        if (own !== undefined && own.kind === 'symlink') {
          throw new Error(`chmod 对符号链接没有意义：${p}`)
        }
        if (own !== undefined && own.kind !== 'tombstone') return
        const meta = this.lower.base === null ? null : await this.lower.stat(p)
        if (meta === null) throw new Error(`chmod：${p} 不存在`)
        if (meta.kind !== 'file') throw new Error(`chmod 只对文件有意义：${p} 是 ${meta.kind}`)
        return
      }
    }
  }

  /** 只改内存。重放与活路径共用它——**两者语义不同才是 bug 的来源**。 */
  private async applyOne(d: Delta): Promise<void> {
    switch (d.kind) {
      case 'add':
      case 'modify':
        this.setSlot(pathOf(d.path), { kind: 'file', bytes: d.bytes.slice(), mode: normMode(d.mode) })
        return
      case 'symlink':
        this.setSlot(pathOf(d.path), { kind: 'symlink', target: d.target })
        return
      case 'delete': {
        const p = pathOf(d.path)
        for (const k of this.subtree(p)) this.dropSlot(k)
        this.setSlot(p, { kind: 'tombstone' })
        return
      }
      case 'rename': {
        const f = pathOf(d.from)
        const t = pathOf(d.to)
        const src = await this.copyUp(f)
        for (const k of this.subtree(f)) this.dropSlot(k)
        this.dropSlot(f)
        this.setSlot(t, src)
        // 源处留一条墓碑：它下面无论有什么下层内容，从这条路都再也走不到。
        this.setSlot(f, { kind: 'tombstone' })
        return
      }
      case 'chmod': {
        const p = pathOf(d.path)
        const own = this.upper.get(p)
        if (own !== undefined && own.kind === 'file') {
          this.setSlot(p, { kind: 'file', bytes: own.bytes, mode: normMode(d.mode) })
          return
        }
        const src = await this.copyUp(p)
        if (src.kind !== 'file') throw new Error(`chmod 只对文件有意义：${p} 是 ${src.kind}`)
        this.setSlot(p, { kind: 'file', bytes: src.bytes, mode: normMode(d.mode) })
        return
      }
    }
  }

  async write(path: RelPath, bytes: Uint8Array, mode: number = MODE_FILE): Promise<ViewRev> {
    const p = pathOf(path)
    const d: Delta = { kind: this.kindFor(p), path: p, bytes, mode: normMode(mode) }
    await this.check(d)
    await this.applyOne(d)
    return this.record(d)
  }

  async writeSymlink(path: RelPath, target: string): Promise<ViewRev> {
    const d: Delta = { kind: 'symlink', path: pathOf(path), target }
    await this.check(d)
    await this.applyOne(d)
    return this.record(d)
  }

  async remove(path: RelPath): Promise<ViewRev> {
    const d: Delta = { kind: 'delete', path: pathOf(path) }
    await this.check(d)
    await this.applyOne(d)
    return this.record(d)
  }

  async rename(from: RelPath, to: RelPath): Promise<ViewRev> {
    const d: Delta = { kind: 'rename', from: pathOf(from), to: pathOf(to) }
    await this.check(d)
    await this.applyOne(d)
    return this.record(d)
  }

  async chmod(path: RelPath, mode: number): Promise<ViewRev> {
    const d: Delta = { kind: 'chmod', path: pathOf(path), mode: normMode(mode) }
    await this.check(d)
    await this.applyOne(d)
    return this.record(d)
  }

  diff(since?: ViewRev): Delta[] {
    const from = since === undefined ? 0 : since
    // 状态里不含有过哪些变更：从快照起的视图说不出快照之前发生了什么。宁可显式拒绝——
    // 悄悄少给一段，与 § 8.3「diff 是变更序列」这句话正好相反。
    if (from < this.floor) {
      throw new Error(
        `这个视图从 rev ${this.floor} 的快照起：rev ${from} 之前的历史不在它里面（要历史就全量重放）`,
      )
    }
    return this.ops.filter((o) => o.rev > from).map((o) => cloneDelta(o.delta))
  }

  async applyDelta(deltas: Delta[]): Promise<ViewRev> {
    let last = this.cur
    for (const d of deltas) {
      await this.check(d)
      await this.applyOne(d)
      last = this.record(d)
    }
    return last
  }

  // ────────────────────────────────── 状态的可持久形式与重放

  /** 上层折叠成一份能写成 JSON 的状态（§ 9.4 的快照）。**按路径排序**，好让文件逐字节可比。 */
  state(): ViewState {
    const upper: SnapEntry[] = []
    for (const [path, e] of this.upper) {
      if (e.kind === 'tombstone') upper.push({ path, kind: 'tombstone' })
      else if (e.kind === 'file') {
        upper.push({ path, kind: 'file', blob: blobIdOf(e.bytes), mode: e.mode })
      } else upper.push({ path, kind: 'symlink', target: e.target })
    }
    upper.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { rev: this.cur, points: [...this.points].sort((a, b) => a - b), upper }
  }

  /**
   * 从一份状态起（快照）。**它只铺上层**，下层照旧按需读——所以 base 前移与它无关。
   *
   * 变更序列不在这里面，所以 `floor` 立起来：`diff` 从此不回答更早的修订点。
   */
  async seed(s: ViewState): Promise<void> {
    for (const e of s.upper) {
      if (e.kind === 'tombstone') this.setSlot(e.path, { kind: 'tombstone' })
      else if (e.kind === 'symlink') this.setSlot(e.path, { kind: 'symlink', target: e.target })
      else {
        const bytes = await this.lower.readBlob(e.blob)
        this.setSlot(e.path, { kind: 'file', bytes, mode: normMode(e.mode) })
      }
    }
    for (const p of s.points) this.points.add(p)
    this.cur = Math.max(this.cur, s.rev)
    this.floor = s.rev
  }

  async replay(e: LogEvent): Promise<void> {
    switch (e.t) {
      case 'view/write': {
        const bytes = await this.lower.readBlob(e.blob)
        const d: Delta = { kind: this.kindFor(e.path), path: e.path, bytes, mode: e.mode }
        await this.applyOne(d)
        this.note(e.rev, d)
        return
      }
      case 'view/symlink': {
        const d: Delta = { kind: 'symlink', path: e.path, target: e.target }
        await this.applyOne(d)
        this.note(e.rev, d)
        return
      }
      case 'view/remove': {
        const d: Delta = { kind: 'delete', path: e.path }
        await this.applyOne(d)
        this.note(e.rev, d)
        return
      }
      case 'view/rename': {
        const d: Delta = { kind: 'rename', from: e.from, to: e.to }
        await this.applyOne(d)
        this.note(e.rev, d)
        return
      }
      case 'view/chmod': {
        const d: Delta = { kind: 'chmod', path: e.path, mode: e.mode }
        await this.applyOne(d)
        this.note(e.rev, d)
        return
      }
      case 'ckpt/commit':
        // 提交不改视图的内容，但它是一个修订点（`revs` 要能回到它）。
        this.cur = Math.max(this.cur, e.rev)
        this.points.add(e.rev)
        return
      default:
        return
    }
  }
}

/**
 * 重放（§ 9.4）：有快照就从快照起，没有就从 seq=0 起；只重放到 `upToRev` 为止。
 *
 * **快照只在它不晚于 `upToRev` 时才用**——它换掉的是历史，问一个比它更早的修订点时它帮不上
 * 忙，忽略它只是慢一点。除此之外没有任何一条判断依赖快照有没有、对不对。
 */
export async function loadView(log: LogReader, agent: WriterId, opts: LoadViewOptions): Promise<View> {
  const view = new MemoryView(agentFor(agent), opts.lower)
  const stop = opts.upToRev
  const snap = opts.snap
  const useSnap = snap !== undefined && (stop === undefined || snap.state.rev <= stop)
  if (snap !== undefined && useSnap) await view.seed(snap.state)
  for await (const e of log.readByWriter(agent, useSnap ? snap.seq : 0)) {
    const rev = (e as { rev?: unknown }).rev
    if (stop !== undefined && typeof rev === 'number' && rev > stop) continue
    await view.replay(e)
  }
  return view
}
