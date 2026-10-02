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
import { MODE_FILE, normMode } from '../delta.ts'
import type { Delta } from '../delta.ts'
import { EMPTY_TREE_ID } from '../entries.ts'
import type { DirEntry, EntryMeta } from '../entries.ts'
import { agentFor } from '../identity.ts'
import { PathShapeError } from '../path-shape.ts'
import type { LogEvent, LogReader } from '../log/events.ts'
import type { AgentId, BlobId, CommitId, RelPath, ViewRev, WriterId } from '../terms.ts'
import { cloneDelta, copyBytes } from './owned.ts'
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
 * **内容的 id 不在这里算。** 算法是仓库的性质（sha1 与 sha256 是两把尺），所以每一条 `Entry` 自己
 * 带着真源给的那一份：`view/write` 事件与文件快照条目里本来就有 id；记录里没有 id 的两处
 * （`view/symlink` 事件 · 软链快照条目）问下层要（`Lower.putBlob`）。
 *
 * 这里原先那份按 sha1 自己算的实现（`sha1("blob <n>\0" + 内容)`）已删：它算出来的 id 在 sha256
 * 库里 git 不认，而症状是静默的——`mktree` 当场拒才知道（`tools/probe-hashfmt.sh` 的读数）。
 */

function metaOf(e: Entry): EntryMeta {
  if (e.kind === 'file') {
    return { kind: 'file', mode: e.mode, size: e.bytes.length, id: e.blob }
  }
  if (e.kind === 'symlink') {
    return { kind: 'symlink', mode: SYMLINK_MODE, size: Buffer.byteLength(e.target, 'utf8'), id: e.blob }
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
    throw new PathShapeError('a path is required (`.` is the root, not a file)')
  }
  if (p.startsWith('/')) throw new PathShapeError(`paths inside the view are relative: ${raw}`)
  for (const s of p.split('/')) {
    if (s === '') throw new PathShapeError(`path has an empty segment: ${raw}`)
    if (s === '.') throw new PathShapeError(`path has a . segment: ${raw}`)
    if (s === '..') throw new PathShapeError(`path has a ..: ${raw}`)
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
      if (own.kind === 'file') return copyBytes(own.bytes)
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
    const found = this.lower.base === null ? null : await this.lower.stat(p)
    const meta = found === null ? null : { ...found }
    if (meta === null) throw new Error(`路径不存在：${p}`)
    if (meta.kind === 'file') {
      const bytes = await this.lower.read(p)
      // 下层的 id 来自 `stat` 那一行（M1 从树里读的），**一个字节的内容都不用读来算它**。
      return { kind: 'file', bytes: copyBytes(bytes ?? new Uint8Array(0)), mode: meta.mode, blob: meta.id as BlobId }
    }
    if (meta.kind === 'symlink') {
      const bytes = await this.lower.read(p)
      return { kind: 'symlink', target: bytes === null ? '' : Buffer.from(bytes).toString('utf8'), blob: meta.id as BlobId }
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

  /**
   * 内容的那个 id：**记录里带着的就用它**，记录里没有的问下层（`Lower.putBlob`）。
   *
   * 两个来源都是真源给的，所以这一份里没有一处自己算内容地址。带 id 的那两处是 `view/write` 事件
   * 与文件快照条目；不带的那两处是 `view/symlink` 事件与软链快照条目——它们只有 `target` 一条字符串，
   * 而对象地址要问对象库。
   */
  private async idFor(bytes: Uint8Array, known?: BlobId): Promise<BlobId> {
    return known ?? (await this.lower.putBlob(bytes))
  }

  /** 只改内存。重放与活路径共用它——**两者语义不同才是 bug 的来源**。 */
  private async applyOne(d: Delta, known?: BlobId): Promise<void> {
    switch (d.kind) {
      case 'add':
      case 'modify': {
        const path = pathOf(d.path), mode = normMode(d.mode)
        const bytes = copyBytes(d.bytes)
        const blob = await this.idFor(bytes, known)
        this.setSlot(path, {
          kind: 'file',
          bytes,
          mode,
          blob,
        })
        return
      }
      case 'symlink': {
        const path = pathOf(d.path), target = d.target
        const blob = await this.idFor(Buffer.from(target, 'utf8'), known)
        this.setSlot(path, {
          kind: 'symlink',
          target,
          blob,
        })
        return
      }
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
        // **id 跟着内容走**：改模式不改内容，所以对象地址原地不动（带着它比再问一次便宜，也少一次
        // 到真源的路）。
        const p = pathOf(d.path)
        const own = this.upper.get(p)
        if (own !== undefined && own.kind === 'file') {
          this.setSlot(p, { kind: 'file', bytes: own.bytes, mode: normMode(d.mode), blob: own.blob })
          return
        }
        const src = await this.copyUp(p)
        if (src.kind !== 'file') throw new Error(`chmod 只对文件有意义：${p} 是 ${src.kind}`)
        this.setSlot(p, { kind: 'file', bytes: src.bytes, mode: normMode(d.mode), blob: src.blob })
        return
      }
    }
  }

  async write(path: RelPath, bytes: Uint8Array, mode: number = MODE_FILE): Promise<ViewRev> {
    const p = pathOf(path)
    const d: Delta = { kind: this.kindFor(p), path: p, bytes: copyBytes(bytes), mode: normMode(mode) }
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
    // Capture both bytes and primitive labels before the first check/put await.
    const captured = deltas.map(cloneDelta)
    let last = this.cur
    for (const d of captured) {
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
        upper.push({ path, kind: 'file', blob: e.blob, mode: e.mode })
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
    const rev = s.rev, points = [...s.points], upper = s.upper.map(e => ({ ...e }))
    for (const e of upper) {
      if (e.kind === 'tombstone') this.setSlot(e.path, { kind: 'tombstone' })
      else if (e.kind === 'symlink') {
        // 软链的快照条目只有 `target`（与 `view/symlink` 事件同一档）：对象地址问下层要。
        this.setSlot(e.path, {
          kind: 'symlink',
          target: e.target,
          blob: await this.lower.putBlob(Buffer.from(e.target, 'utf8')),
        })
      } else {
        const bytes = await this.lower.readBlob(e.blob)
        this.setSlot(e.path, { kind: 'file', bytes: copyBytes(bytes), mode: normMode(e.mode), blob: e.blob })
      }
    }
    for (const p of points) this.points.add(p)
    this.cur = Math.max(this.cur, rev)
    this.floor = rev
  }

  async replay(raw: LogEvent): Promise<void> {
    const e = { ...raw }
    switch (e.t) {
      case 'view/write': {
        const bytes = await this.lower.readBlob(e.blob)
        const d: Delta = { kind: this.kindFor(e.path), path: e.path, bytes: copyBytes(bytes), mode: e.mode }
        // **事件里那一栏就是这一条的 id**（`putBlob` 在落日志之前问过 git），不必再问一次。
        await this.applyOne(d, e.blob)
        this.note(e.rev, d)
        return
      }
      case 'view/symlink': {
        const d: Delta = { kind: 'symlink', path: e.path, target: e.target }
        // 这一条事件不带 id（架构 § 8.1 那一行只有 `target`），所以那一处问下层要。
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
  const from = useSnap ? snap.seq : 0
  if (snap !== undefined && useSnap) await view.seed(snap.state)
  for await (const e of log.readByWriter(agent, from)) {
    const rev = (e as { rev?: unknown }).rev
    if (stop !== undefined && typeof rev === 'number' && rev > stop) continue
    await view.replay(e)
  }
  return view
}
