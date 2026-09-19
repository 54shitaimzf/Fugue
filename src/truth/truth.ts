// M1 · 唯一真源的读写。出处：架构 § 8.2（接口与四项硬约束）· § 9.3（提交协议）。
//
// **不碰 HEAD、不碰索引、不碰工作树。** 落到实现上就是一条：只用 plumbing，而且完全不
// 落索引（§ 8.2 硬约束 1 的第二种形态）。per-agent 索引是硬约束 1 的另一种形态，它要多
// 一个共享可写文件；不落索引就没有这个问题，代价是树的组装要自己递归。
//
// 形状：blob 与 tree 都是**不可变、内容寻址**的对象，所以读路径上的缓存永远有效，
// 不需要失效逻辑——`trees` 与 `commitTrees` 因此是纯粹的加速项。
import { GitError, openGit, type GitHandle, type ReadTier } from './git.ts'
import type {
  Conflict,
  ConflictStage,
  DirEntry,
  EntryKind,
  EntryMeta,
  TreeEntry,
  Truth,
} from './contract.ts'
import type { BlobId, CommitId, RefName, RelPath, TreeId } from '../terms.ts'

export interface TruthStats {
  /** 这个句柄起过多少个 git 进程。 */
  gitSpawns: number
  /** 当前实际在用的读档位。 */
  readTier: ReadTier
}

/** `advance` 输掉了 CAS。**这不是异常情况，是那把锁的全部意义**：并发推进同一 ref 时恰一个成功。 */
export class RefConflictError extends Error {
  readonly ref: RefName
  readonly expected: CommitId | null
  readonly actual: CommitId | null

  constructor(ref: RefName, expected: CommitId | null, actual: CommitId | null) {
    super(
      `ref ${ref} 的 CAS 输了：期望 ${expected ?? '（不存在）'}，实际 ${actual ?? '（不存在）'}`,
    )
    this.name = 'RefConflictError'
    this.ref = ref
    this.expected = expected
    this.actual = actual
  }
}

export class RefNotFoundError extends Error {
  readonly ref: RefName

  constructor(ref: RefName, detail: string) {
    super(`ref 不存在或不是提交：${ref}${detail.trim() === '' ? '' : '：' + detail.trim()}`)
    this.name = 'RefNotFoundError'
    this.ref = ref
  }
}

/**
 * 条目类型。**认不出来的一律显式失败**，不猜：`160000`（submodule / gitlink）在架构
 * § 8.2 与 § 8.3 里没有位置——`Entry` 只有 file / symlink / dir 三类。把它报成一个
 * 0 字节的文件，会让后面每一层（物化 · 合并）都拿着一份错的形状干活。
 */
export function kindOf(mode: number): EntryKind {
  if (mode === 0o40000) return 'dir'
  if (mode === 0o120000) return 'symlink'
  if (mode === 0o100644 || mode === 0o100755) return 'file'
  throw new Error(
    `M1 不认识这个条目类型：mode ${mode.toString(8)}。架构 § 8.2 / § 8.3 只给了 file / symlink / dir 三类，` +
      `submodule（160000）没有位置——这里显式失败，不把它报成文件`,
  )
}

interface RawEntry {
  mode: number
  name: string
  id: string
}

/** 把视图内的相对路径切成段。`..` 与绝对路径在这里挡住——M1 只不该被喂进会走错门的东西。 */
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

interface DirNode {
  files: Map<string, { mode: number; id: string }>
  dirs: Map<string, DirNode>
}

function emptyNode(): DirNode {
  return { files: new Map(), dirs: new Map() }
}

/** `read` 选的是读的档位：`batch`（默认）或 `oneshot`（退化档，见 git.ts）。 */
export interface TruthOptions {
  read?: ReadTier
}

export interface TruthHandle extends Truth {
  close(): Promise<void>
  stats(): TruthStats
}

export function openTruth(root: string, opts: TruthOptions = {}): TruthHandle {
  const git: GitHandle = openGit(root, opts)

  /** 内容寻址 → 缓存永远有效。tree id → 条目。 */
  const trees = new Map<string, RawEntry[]>()
  /** 提交不可变 → 同样永远有效。 */
  const commitTrees = new Map<string, string>()

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

  async function sizeOf(id: string): Promise<number> {
    const r = await git.object('info', id)
    if (r === null) throw new Error(`对象不见了：${id}`)
    return r.size
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
      rows.push({ key: treeOrder(name, false), line: `${modeText(f.mode)} blob ${f.id}\t${name}` })
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

  async function resolveOrNull(ref: RefName): Promise<CommitId | null> {
    try {
      return await resolve(ref)
    } catch {
      return null
    }
  }

  async function resolve(ref: RefName): Promise<CommitId> {
    const r = await git.tryRun(['rev-parse', '--verify', '--quiet', ref + '^{commit}'])
    const id = r.stdout.toString('utf8').trim()
    if (r.status !== 0 || id === '') throw new RefNotFoundError(ref, r.stderr)
    return id as CommitId
  }

  return {
    async putBlob(bytes: Uint8Array): Promise<BlobId> {
      const out = await git.run(['hash-object', '-w', '--stdin'], bytes)
      return out.toString('utf8').trim() as BlobId
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
      // 拷一份再交出去：批量子进程那块缓冲区是本模块的内部状态，不该由调用者手里的
      // 视图继续指着。
      return Buffer.from(await need('contents', id, 'blob'))
    },

    async statAt(commit: CommitId, path: RelPath): Promise<EntryMeta | null> {
      const hit = await lookup(commit, path)
      if (hit === null) return null
      const kind = kindOf(hit.mode)
      return {
        kind,
        mode: hit.mode,
        // 目录没有字节。这个 0 是形状要求的占位，不是读数。
        size: kind === 'dir' ? 0 : await sizeOf(hit.id),
        id: hit.id as BlobId | TreeId,
      }
    },

    async readAt(commit: CommitId, path: RelPath): Promise<Uint8Array | null> {
      const hit = await lookup(commit, path)
      if (hit === null) return null
      if (kindOf(hit.mode) === 'dir') return null
      return Buffer.from(await need('contents', hit.id, 'blob'))
    },

    async listAt(commit: CommitId, dir: RelPath): Promise<DirEntry[]> {
      const hit = await lookup(commit, dir)
      if (hit === null || kindOf(hit.mode) !== 'dir') return []
      const out: DirEntry[] = []
      for (const e of await treeEntries(hit.id)) {
        const kind = kindOf(e.mode)
        out.push({
          name: e.name,
          kind,
          mode: e.mode,
          size: kind === 'dir' ? 0 : await sizeOf(e.id),
          id: e.id as BlobId | TreeId,
        })
      }
      return out
    },

    async advance(ref: RefName, to: CommitId, expectedOld: CommitId | null): Promise<void> {
      // `expectedOld === null` 的形态是"这个 ref 必须还不存在"：git 用全零 oid 表达它。
      // 零的长度随对象格式走（sha1 40 位、sha256 64 位），所以从 `to` 自己身上取。
      const args = ['update-ref', ref, to, expectedOld ?? '0'.repeat(to.length)]
      const r = await git.tryRun(args)
      if (r.status === 0) return
      // 非零有两种，必须分开报：ref 现在的值**不等于** expectedOld，那是 CAS 输了；
      // 相等却还是失败，那是别的原因——git 自己就拒绝把 `refs/heads/*` 指向非提交对象
      // （实测 `trying to write non-commit object`）。把后者报成 CAS 会把方向指错。
      const actual = await resolveOrNull(ref)
      if (actual !== expectedOld) throw new RefConflictError(ref, expectedOld, actual)
      throw new GitError(args, r.status, r.stderr)
    },

    resolve,

    async mergeTree(bases: CommitId[]): Promise<{ tree: TreeId } | { conflicts: Conflict[] }> {
      if (bases.length !== 2) {
        throw new Error(
          `mergeTree 只支持两个 base：git merge-tree --write-tree 的签名是 <branch1> <branch2>，` +
            `三个及以上直接退 129（实测）。给了 ${bases.length} 个——多于两个怎么折叠，架构 § 8.2 没说`,
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
    stats: () => ({ gitSpawns: git.spawns(), readTier: git.readTier() }),
  }
}
