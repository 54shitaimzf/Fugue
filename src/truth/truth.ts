// M1 · 唯一真源的读写。出处：架构 § 8.2（接口与四项硬约束）· § 9.3（提交协议）。
//
// **不碰 HEAD、不碰索引、不碰工作树。** 落到实现上就是一条：只用 plumbing，而且完全不
// 落索引（§ 8.2 硬约束 1 的第二种形态）。per-agent 索引是硬约束 1 的另一种形态，它要多
// 一个共享可写文件；不落索引就没有这个问题，代价是树的组装要自己递归。
//
// 形状：blob 与 tree 都是**不可变、内容寻址**的对象，所以读路径上的缓存永远有效，
// 不需要失效逻辑——`trees` 与 `commitTrees` 因此是纯粹的加速项。
//
// 0.2.4 给读路径补上第三处缓存（前两处是 `trees` 与 `commitTrees`，它们存的是**解析过的**
// 形状）：
//
//   · **blob 字节进一张按字节封顶的 LRU**（`blobCache`，键是 `BlobId`）。它只装 blob 的原始
//     字节——tree/commit 的原始字节不进，那两个已经有解析形式的缓存，重复存白占容量。
//   · **info 小表**（`infoOf`，id → {type, size}）：`statAt` 的单条 info 与 `listAt` 的批量
//     info 都先查它。条目只有几十字节，所以不设上限（先例就是上面那两处）；**miss 不缓存**
//     ——blob 随后可能被 `putBlob` 写出来，缓存一个"不在"会把后来的命中错报成不在。
//   · **先滤后发**：凡是批量 info 与批量预取，发之前先把缓存里已有的 id 滤掉，不然热路径
//     照样发满额往返。
//
// 这三处都是**派生体，不是第二处真源**：清空随时安全，容量 0 就是直通（地板 = 变慢，不是
// 跑不起来）。跨进程不共享、不落盘——「单次进程 + 每次重建」没有被破坏。
import { GitError, openGit, type GitHandle, type ReadTier } from './git.ts'
import type { Conflict, ConflictStage, Truth } from './contract.ts'
import type { DirEntry, EntryKind, EntryMeta, ObjectId, TreeEntry } from '../entries.ts'
import type { BlobId, CommitId, RefName, RelPath, TreeId } from '../terms.ts'
import { BlobLru } from './blob-lru.ts'

/**
 * 一个句柄读得到的那点账：git 那一侧（起过多少进程 · 发过多少请求 · 当前读档位）与本句柄
 * 自己的缓存（blob · info 两张表）。
 *
 * **缓存字段是 0.2.4 起加的，单独一段**：它们是"这一层省下了什么"的归因读数——判据是
 * `gitRequests` **不涨**，而这里的 hit/miss/evicted 说明那个"不涨"是怎么来的。旧的三个字段
 * 一个不改（它们是别的断言的判据）。
 */
export interface TruthStats {
  /** 这个句柄起过多少个 git 进程。 */
  gitSpawns: number
  /** 这个句柄向 git 发过多少次请求。批量档下它远大于进程数——那正是批量的意义。 */
  gitRequests: number
  /** 当前实际在用的读档位。 */
  readTier: ReadTier
  /** blob 字节缓存：命中的次数（命中 = 没向 git 发这一条请求）。 */
  blobHits: number
  /** blob 字节缓存：未命中的次数（未命中才会去问 git；容量 0 时每一次都记在这里）。 */
  blobMisses: number
  /** blob 字节缓存：当前装了几条。 */
  blobEntries: number
  /** blob 字节缓存：当前装了多少字节（恒 ≤ `blobCacheBytes`）。 */
  blobBytes: number
  /** blob 字节缓存：因为容量不够被挤掉的条数。 */
  blobEvictions: number
  /** 当前生效的 blob 缓存容量（字节）。0 = 直通。 */
  blobCacheBytes: number
  /** info 小表：命中的次数。 */
  infoHits: number
  /** info 小表：未命中的次数（对象不在**不记**——那一条不缓存）。 */
  infoMisses: number
  /** info 小表：当前装了几条。 */
  infoEntries: number
}

/** `advance` 输掉了 CAS。**这不是异常情况，是那把锁的全部意义**：并发推进同一 ref 时恰一个成功。 */
/**
 * CAS 推进的重试次数。**重试的理由不是"CAS 会失败"，是"锁会撞车"**：两个写者同时推进
 * 同一个 ref，后到的那个可能连锁都没拿到就失败（ref 的锁文件被占着），而那一刻 ref 还没
 * 动——不重试的话它会变成 GitError，"恰有一个成功"从调用方看就成了"其中一个坏了"。
 */
const ADVANCE_ATTEMPTS = 4

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export class RefConflictError extends Error {
  readonly ref: RefName
  readonly expected: CommitId | null
  /** ref 现在的值。可能不是提交——这里只报事实，不替它解释。 */
  readonly actual: string | null

  constructor(ref: RefName, expected: CommitId | null, actual: string | null) {
    super(
      `ref ${ref} 的 CAS 输了：期望 ${expected ?? '（不存在）'}，实际 ${actual ?? '（不存在）'}`,
    )
    this.name = 'RefConflictError'
    this.ref = ref
    this.expected = expected
    this.actual = actual
  }
}

/** ref 不存在。**与"存在但不是提交"分开报**：两者对调用者的含义完全不同。 */
export class RefNotFoundError extends Error {
  readonly ref: RefName

  constructor(ref: RefName, detail: string) {
    super(`ref 不存在：${ref}${detail.trim() === '' ? '' : '：' + detail.trim()}`)
    this.name = 'RefNotFoundError'
    this.ref = ref
  }
}

/**
 * ref 存在，但它指向的不是提交（比如指向一个 blob 或 tree）。
 *
 * 分开报有实际后果：调用者若把这一种也当成"没有 parent"，就会在一个其实有东西的位置上
 * 静默造出一个根提交——错得看不出来。
 */
export class RefNotCommitError extends Error {
  readonly ref: RefName
  readonly actual: string

  constructor(ref: RefName, actual: string, detail: string) {
    super(
      `ref 存在但不指向提交：${ref} → ${actual}${detail.trim() === '' ? '' : '：' + detail.trim()}`,
    )
    this.name = 'RefNotCommitError'
    this.ref = ref
    this.actual = actual
  }
}

/**
 * 条目类型。**认不出来的一律显式失败**，不猜——猜错的那一半（把 `160000` 当成文件、
 * 或当成一个可以下钻的目录）都不会报错，只会静默地把错的形状发给后面每一层。
 */
export function kindOf(mode: number): EntryKind {
  if (mode === 0o40000) return 'dir'
  if (mode === 0o160000) return 'gitlink'
  if (mode === 0o120000) return 'symlink'
  if (mode === 0o100644 || mode === 0o100755) return 'file'
  throw new Error(
    `M1 不认识这个条目类型：mode ${mode.toString(8)}。` +
      `树的模式只有 100644 / 100755 / 120000 / 40000 / 160000 五种`,
  )
}

interface RawEntry {
  mode: number
  name: string
  id: string
}

/** 把视图内的相对路径切成段。`..` 与绝对路径在这里挡住——M1 不该被喂进会走错门的东西。 */
function segments(path: RelPath): string[] {
  if (path.startsWith('/')) throw new Error(`M1 只收视图内的相对路径：${JSON.stringify(path)}`)
  const out: string[] = []
  for (const s of path.split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') throw new Error(`M1 不收含 .. 的路径：${JSON.stringify(path)}`)
    out.push(s)
  }
  return out
}

/** git 的树序：目录按**名字加一个 `/`** 参与比较（§ 8.2 的实测：`sub.txt` 排在 `sub/` 前）。 */
function treeOrder(name: string, isDir: boolean): Buffer {
  return Buffer.from(isDir ? name + '/' : name, 'utf8')
}

function modeText(mode: number): string {
  return mode.toString(8).padStart(6, '0')
}

/** `mktree` 的输入里，类型词必须与 mode 对得上：gitlink 指的是一个提交对象，不是 blob。 */
function typeWordFor(mode: number): string {
  const kind = kindOf(mode)
  if (kind === 'dir') return 'tree'
  if (kind === 'gitlink') return 'commit'
  return 'blob'
}

interface DirNode {
  files: Map<string, { mode: number; id: string }>
  dirs: Map<string, DirNode>
}

function emptyNode(): DirNode {
  return { files: new Map(), dirs: new Map() }
}

/**
 * blob 缓存的缺省容量：**8 MiB**。
 *
 * 出处是量出来的，不是拍的：本仓 `src/` 的工作集 3.79 MB（254 个文件 · 20 核 ext4 实测），
 * 一轮 `grep` 要读的就是这个量级；取"覆盖一个仓的工作集"的两倍再向上取到 2 的幂，得到 8 MiB。
 * 它是一条**缺省**，不是常数条款：`blobCacheBytes` 给多少就按多少算，给 0 就是直通。
 */
export const DEFAULT_BLOB_CACHE_BYTES = 8 * 1024 * 1024

/**
 * 一次 `objectMany` 里塞多少条。批量请求是一趟往返，但**回载的字节要在内存里同时活着**，
 * 所以按条数分块而不是一次全发。这个数不参与任何断言（预取是提示，不是承诺）。
 */
const OBJECT_MANY_CHUNK = 256

/**
 * `read` 选的是读的档位：`batch`（默认）或 `oneshot`（退化档，见 git.ts）。
 * `blobCacheBytes` 是 blob 字节缓存的上限（缺省 `DEFAULT_BLOB_CACHE_BYTES`，**显式给 0 即关**）。
 */
export interface TruthOptions {
  read?: ReadTier
  blobCacheBytes?: number
}

export interface TruthHandle extends Truth {
  close(): Promise<void>
  stats(): TruthStats
  /**
   * **一次往返把这几条 blob 的字节取回来放进缓存。**
   *
   * 它是**提示，不是承诺**：谁也不许依赖"调过之后一定命中"（换句柄、换档位、容量不够都会
   * 让它落空），调用方照旧按"读不到就问"的顺序走。已缓存的 id 在这里被滤掉——热路径上
   * 这一步省的正是"满额往返"。
   */
  prefetchBlobs(ids: readonly BlobId[]): Promise<void>
}

export function openTruth(root: string, opts: TruthOptions = {}): TruthHandle {
  const git: GitHandle = openGit(root, opts)

  /** 内容寻址 → 缓存永远有效。tree id → 条目。 */
  const trees = new Map<string, RawEntry[]>()
  /** 提交不可变 → 同样永远有效。 */
  const commitTrees = new Map<string, string>()
  /**
   * blob 字节：内容寻址 ⇒ 不需要失效逻辑，只需要一个上限。`trees`/`commitTrees` 存的是
   * **解析过的形状**（条目数组、一个 tree id），这里是**原始字节**，所以它按字节封顶。
   */
  const blobCache = new BlobLru(opts.blobCacheBytes ?? DEFAULT_BLOB_CACHE_BYTES)
  /** id → {type, size}。**对象不在不记**（blob 随后可能被写出来）。 */
  const infoOf = new Map<string, { type: string; size: number }>()
  let infoHits = 0
  let infoMisses = 0

  function hashBytesOf(id: string): number {
    const n = id.length / 2
    if (!Number.isInteger(n) || n === 0) throw new Error(`对象标识不像十六进制：${JSON.stringify(id)}`)
    return n
  }

  async function need(want: 'info' | 'contents', id: string, what: string): Promise<Buffer> {
    const r = await git.object(want, id)
    if (r === null) throw new Error(`${what}不见了：${id}`)
    return r.body
  }

  /**
   * 一条 blob 的字节：**缓存里有就直接给，没有才去问 git，拿回来顺手填进去**。
   *
   * 返回的是缓存里那一份**本身**（不是拷贝）——所以它只给本模块内部用：出口那两处
   * （`getBlob` / `readAt`）照旧各拷一份再交出去，纪律不变。
   */
  async function blobBytesOf(id: string, what: string): Promise<Uint8Array> {
    const hit = blobCache.get(id)
    if (hit !== undefined) return hit
    const r = await git.object('contents', id)
    if (r === null) throw new Error(`${what}不见了：${id}`)
    // **填缓存之前必须换成独立的一份**：`parseReply` 交出来的 body 是那块读缓冲区的一个
    // 视图（`subarray`），直接存进去会让整块流缓冲被一条 blob 拖着不放。
    blobCache.set(id, r.body)
    return r.body
  }

  /** info 小表那一趟：查得到就用，查不到就发一次单条 info（**对象不在不填**）。 */
  async function infoOfId(id: string): Promise<{ type: string; size: number } | null> {
    const hit = infoOf.get(id)
    if (hit !== undefined) {
      infoHits++
      return hit
    }
    infoMisses++
    const r = await git.object('info', id)
    if (r === null) return null
    const row = { type: r.type, size: r.size }
    infoOf.set(id, row)
    return row
  }

  /** 一批 id 的 info：**先滤后发**（缓存里已有的不发），回来的逐条填表。 */
  async function infoOfMany(ids: readonly string[]): Promise<Array<{ type: string; size: number } | null>> {
    const want: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (infoOf.has(id)) {
        infoHits++
        continue
      }
      if (seen.has(id)) continue
      seen.add(id)
      want.push(id)
    }
    const out = new Map<string, { type: string; size: number }>()
    for (let i = 0; i < want.length; i += OBJECT_MANY_CHUNK) {
      const chunk = want.slice(i, i + OBJECT_MANY_CHUNK)
      infoMisses += chunk.length
      const replies = await git.objectMany(
        'info',
        chunk,
      )
      for (const [j, id] of chunk.entries()) {
        const r = replies[j]
        if (r === null) continue
        const row = { type: r.type, size: r.size }
        infoOf.set(id, row)
        out.set(id, row)
      }
    }
    return ids.map((id) => {
      const row = infoOf.get(id)
      return row === undefined ? null : row
    })
  }

  async function treeOf(commit: CommitId): Promise<string> {
    const hit = commitTrees.get(commit)
    if (hit !== undefined) return hit
    const r = await git.object('contents', commit)
    if (r === null) throw new Error(`提交不存在：${commit}`)
    if (r.type !== 'commit') throw new Error(`不是提交对象（${r.type}）：${commit}`)
    const m = /^tree ([0-9a-f]+)\n/.exec(r.body.toString('utf8'))
    if (m === null) throw new Error(`提交里读不出 tree：${commit}`)
    commitTrees.set(commit, m[1])
    return m[1]
  }

  /** 树对象的字节格式：`<八进制 mode> SP <名字> NUL <hashBytes 个原始字节>`，逐条相接。 */
  function parseTree(body: Buffer, hashBytes: number): RawEntry[] {
    const out: RawEntry[] = []
    let i = 0
    while (i < body.length) {
      const sp = body.indexOf(0x20, i)
      const nul = sp === -1 ? -1 : body.indexOf(0x00, sp + 1)
      if (sp === -1 || nul === -1 || nul + 1 + hashBytes > body.length) {
        throw new Error('树对象的字节格式不对（mode/名字/hash 的长度对不上）')
      }
      out.push({
        mode: parseInt(body.subarray(i, sp).toString('utf8'), 8),
        name: body.subarray(sp + 1, nul).toString('utf8'),
        id: body.subarray(nul + 1, nul + 1 + hashBytes).toString('hex'),
      })
      i = nul + 1 + hashBytes
    }
    return out
  }

  async function treeEntries(tree: string): Promise<RawEntry[]> {
    const hit = trees.get(tree)
    if (hit !== undefined) return hit
    const r = await git.object('contents', tree)
    if (r === null) throw new Error(`tree 不存在：${tree}`)
    if (r.type !== 'tree') throw new Error(`不是 tree 对象（${r.type}）：${tree}`)
    const parsed = parseTree(r.body, hashBytesOf(tree))
    trees.set(tree, parsed)
    return parsed
  }

  /** 路径 → 条目。**逐段下树，代价是深度，不是仓库大小。** */
  async function lookup(commit: CommitId, path: RelPath): Promise<RawEntry | null> {
    const segs = segments(path)
    const root: RawEntry = { mode: 0o40000, name: '', id: await treeOf(commit) }
    if (segs.length === 0) return root
    let node = root.id
    for (let i = 0; i < segs.length; i++) {
      const hit = (await treeEntries(node)).find((e) => e.name === segs[i])
      if (hit === undefined) return null
      if (i === segs.length - 1) return hit
      if (kindOf(hit.mode) !== 'dir') return null
      node = hit.id
    }
    return null
  }

  async function emit(node: DirNode): Promise<TreeId> {
    const rows: Array<{ key: Buffer; line: string }> = []
    for (const [name, sub] of node.dirs) {
      rows.push({
        key: treeOrder(name, true),
        line: `${modeText(0o40000)} tree ${await emit(sub)}\t${name}`,
      })
    }
    for (const [name, f] of node.files) {
      rows.push({
        key: treeOrder(name, false),
        line: `${modeText(f.mode)} ${typeWordFor(f.mode)} ${f.id}\t${name}`,
      })
    }
    // 自己排一遍，不把顺序托给 mktree：同一个条目集必须得到同一个 tree id，
    // 这条性质要由本模块成立，不能由"mktree 恰好也排"成立。
    rows.sort((a, b) => Buffer.compare(a.key, b.key))
    // 空目录不发那个换行：`mktree` 把"只有一行空行"当成格式错（实测
    // `fatal: input format error: (blank line only valid in batch mode)`）。
    const text = rows.length === 0 ? '' : rows.map((r) => r.line).join('\n') + '\n'
    const out = await git.run(['mktree'], text)
    return out.toString('utf8').trim() as TreeId
  }

  async function putTree(entries: TreeEntry[]): Promise<TreeId> {
    const root = emptyNode()
    for (const e of entries) {
      // 目录由路径推出来，不作为叶子条目：两种写法都能表达"这里有个目录"的话，
      // 就会有两种 tree，而同一个条目集必须只对应一个 tree id。
      if (kindOf(e.mode) === 'dir') {
        throw new Error(`putTree 不收目录条目（目录由路径推出来）：${e.name}`)
      }
      const segs = segments(e.name)
      if (segs.length === 0) throw new Error(`putTree 收到空路径：${JSON.stringify(e.name)}`)
      let node = root
      for (let i = 0; i < segs.length - 1; i++) {
        const seg = segs[i]
        if (node.files.has(seg)) throw new Error(`同一个名字既是文件又是目录：${seg}`)
        let sub = node.dirs.get(seg)
        if (sub === undefined) {
          sub = emptyNode()
          node.dirs.set(seg, sub)
        }
        node = sub
      }
      const leaf = segs[segs.length - 1]
      if (node.dirs.has(leaf)) throw new Error(`同一个名字既是文件又是目录：${segs.join('/')}`)
      if (node.files.has(leaf)) throw new Error(`同一个路径给了两次：${e.name}`)
      node.files.set(leaf, { mode: e.mode, id: e.id })
    }
    return emit(root)
  }

  function parseConflicts(chunks: string[]): Conflict[] {
    const byPath = new Map<string, ConflictStage[]>()
    for (const chunk of chunks) {
      if (chunk === '') continue
      const m = /^([0-7]{6}) ([0-9a-f]+) ([123])\t([\s\S]+)$/.exec(chunk)
      if (m === null) continue
      const path = m[4]
      const list = byPath.get(path) ?? []
      list.push({ stage: Number(m[3]) as 1 | 2 | 3, mode: parseInt(m[1], 8), id: m[2] as BlobId })
      byPath.set(path, list)
    }
    return [...byPath].map(([path, stages]) => ({ path, stages }))
  }

  /** ref 现在的值，**不要求它是提交**。CAS 的判定要的是这个，不是 `resolve`。 */
  async function rawRefValue(ref: RefName): Promise<string | null> {
    const r = await git.tryRun(['rev-parse', '--verify', '--quiet', ref])
    const id = r.stdout.toString('utf8').trim()
    return r.status === 0 && id !== '' ? id : null
  }

  /**
   * ref → 它指向的提交。
   *
   * **先取一次值，再对那个值问"是不是提交"**——不是对 ref 再问一次。对 ref 问两次会读到两个
   * 时刻：另一个写者在这中间推进了 ref，第一次读到的"不存在"就在第二次读里变成"存在但不是
   * 提交"，一次良性竞争被报成一条不可重试的硬错误（实测：两个 `checkpoint` 抢同一个 ref，
   * 每十次里有一次）。**值是 oid，对象不可变——问它才是稳的。**
   */
  async function resolve(ref: RefName): Promise<CommitId> {
    const raw = await rawRefValue(ref)
    if (raw === null) {
      const probe = await git.tryRun(['rev-parse', '--verify', '--quiet', ref])
      throw new RefNotFoundError(ref, probe.stderr)
    }
    const r = await git.tryRun(['rev-parse', '--verify', '--quiet', raw + '^{commit}'])
    const id = r.stdout.toString('utf8').trim()
    if (r.status === 0 && id !== '') return id as CommitId
    throw new RefNotCommitError(ref, raw, r.stderr)
  }

  return {
    async putBlob(bytes: Uint8Array): Promise<BlobId> {
      const out = await git.run(['hash-object', '-w', '--stdin'], bytes)
      const id = out.toString('utf8').trim() as BlobId
      // **字节就在手里，顺手回填缓存**：零成本，而且这一条之后多半会被立刻读回来
      // （`write` 之后 `read`、提交之后重放）。存不下（容量 0 / 超容量）时 `set` 自己拒。
      blobCache.set(id, bytes)
      return id
    },

    putTree,

    async commit(tree: TreeId, parents: CommitId[], msg: string): Promise<CommitId> {
      const args = ['commit-tree', tree]
      for (const p of parents) args.push('-p', p)
      // 提交信息走 stdin：`-m` 只吃一行，而交接与提交信息是多行的。
      const out = await git.run(args, msg)
      return out.toString('utf8').trim() as CommitId
    },

    async getBlob(id: BlobId): Promise<Uint8Array> {
      // 拷一份再交出去：缓存里那一份（或批量子进程那块缓冲区）是本模块的内部状态，不该由
      // 调用者手里的视图继续指着。
      return Buffer.from(await blobBytesOf(id, 'blob'))
    },

    async statAt(commit: CommitId, path: RelPath): Promise<EntryMeta | null> {
      const hit = await lookup(commit, path)
      if (hit === null) return null
      const kind = kindOf(hit.mode)
      const sized = kind === 'file' || kind === 'symlink'
      const r = sized ? await infoOfId(hit.id) : null
      if (sized && r === null) throw new Error(`对象不见了：${hit.id}`)
      return { kind, mode: hit.mode, size: r === null ? 0 : r.size, id: hit.id }
    },

    async readAt(commit: CommitId, path: RelPath): Promise<Uint8Array | null> {
      const hit = await lookup(commit, path)
      if (hit === null) return null
      const kind = kindOf(hit.mode)
      // 目录没有字节；gitlink 指的是另一个仓库的一个提交，把它那个提交对象的字节当成
      // 这个路径的内容交出去是错的。
      if (kind === 'dir' || kind === 'gitlink') return null
      // 与 `getBlob` 同一条出口纪律：拷一份再交出去。
      return Buffer.from(await blobBytesOf(hit.id, 'blob'))
    },

    async listAt(commit: CommitId, dir: RelPath): Promise<DirEntry[]> {
      const hit = await lookup(commit, dir)
      if (hit === null || kindOf(hit.mode) !== 'dir') return []
      const entries = await treeEntries(hit.id)
      // **一个目录的 size 一次问完。** 逐条问的话，进程数还是一个，往返数却是 O(条目数)。
      const sized = entries.filter((e) => {
        const k = kindOf(e.mode)
        return k === 'file' || k === 'symlink'
      })
      const rows = await infoOfMany(sized.map((e) => e.id))
      const sizes = new Map<string, number>()
      for (const [i, e] of sized.entries()) {
        const r = rows[i]
        if (r === null) throw new Error(`条目 ${e.name} 的对象不见了：${e.id}`)
        sizes.set(e.id, r.size)
      }
      return entries.map((e) => {
        const kind = kindOf(e.mode)
        const size = sizes.get(e.id)
        if ((kind === 'file' || kind === 'symlink') && size === undefined) {
          throw new Error(`条目 ${e.name} 没拿到 size：${e.id}`)
        }
        return { name: e.name, kind, mode: e.mode, size: size ?? 0, id: e.id }
      })
    },

    async prefetchBlobs(ids: readonly BlobId[]): Promise<void> {
      const want: string[] = []
      const seen = new Set<string>()
      for (const id of ids) {
        // **先滤后发**：已经在缓存里的不发（热路径上这一步省的正是满额往返）。
        if (blobCache.has(id)) continue
        if (seen.has(id)) continue
        seen.add(id)
        want.push(id)
      }
      for (let i = 0; i < want.length; i += OBJECT_MANY_CHUNK) {
        const chunk = want.slice(i, i + OBJECT_MANY_CHUNK)
        const replies = await git.objectMany('contents', chunk)
        for (const [j, id] of chunk.entries()) {
          const r = replies[j]
          if (r === null) continue
          blobCache.set(id, r.body)
        }
      }
    },

    async advance(ref: RefName, to: CommitId, expectedOld: CommitId | null): Promise<void> {
      // `expectedOld === null` 的形态是"这个 ref 必须还不存在"：git 用全零 oid 表达它。
      // 零的长度随对象格式走（sha1 40 位、sha256 64 位），所以从 `to` 自己身上取。
      const args = ['update-ref', ref, to, expectedOld ?? '0'.repeat(to.length)]
      for (let attempt = 0; ; attempt++) {
        const r = await git.tryRun(args)
        if (r.status === 0) return
        // 非零有两种，必须分开报：ref 现在的值**不等于** expectedOld，那是 CAS 输了；
        // 相等却还是失败，那是别的原因——git 自己就拒绝把 `refs/heads/*` 指向非提交对象
        // （实测 `trying to write non-commit object`）。把后者报成 CAS 会把方向指错。
        const actual = await rawRefValue(ref)
        if (actual !== expectedOld) throw new RefConflictError(ref, expectedOld, actual)
        if (attempt >= ADVANCE_ATTEMPTS) throw new GitError(args, r.status, r.stderr)
        await sleep(5 * (attempt + 1))
      }
    },

    resolve,

    async mergeTree(bases: CommitId[]): Promise<{ tree: TreeId } | { conflicts: Conflict[] }> {
      if (bases.length !== 2) {
        throw new Error(
          `mergeTree 只支持两个 base：git merge-tree --write-tree 的签名是 <branch1> <branch2>，` +
            `三个及以上直接退 129（实测）。给了 ${bases.length} 个——多于两个由调用方逐路折叠（§ 8.2 硬约束 4）`,
        )
      }
      const args = ['merge-tree', '-z', '--write-tree', bases[0], bases[1]]
      const r = await git.tryRun(args)
      const chunks = r.stdout.toString('utf8').split('\0')
      if (r.status === 0) {
        if (chunks[0] === '') throw new Error('merge-tree 退 0 却没给出 tree')
        return { tree: chunks[0] as TreeId }
      }
      // **成功判据是退出码，不是"拿到了 tree"。** 冲突时它照样写出一个 tree，其中冲突
      // 文件是带冲突标记的 blob（§ 8.2）。所以非零一律不给 tree——这个联合类型让那棵
      // 有毒的树在类型上就取不到。
      const conflicts = parseConflicts(chunks.slice(1))
      if (r.status === 1 && conflicts.length > 0) return { conflicts }
      throw new GitError(args, r.status, r.stderr.trim() === '' ? chunks.join('\n') : r.stderr)
    },

    close: () => git.close(),
    stats: () => ({
      gitSpawns: git.spawns(),
      gitRequests: git.requests(),
      readTier: git.readTier(),
      blobHits: blobCache.hits,
      blobMisses: blobCache.misses,
      blobEntries: blobCache.size,
      blobBytes: blobCache.bytes,
      blobEvictions: blobCache.evictions,
      blobCacheBytes: blobCache.capacityBytes,
      infoHits,
      infoMisses,
      infoEntries: infoOf.size,
    }),
  }
}
