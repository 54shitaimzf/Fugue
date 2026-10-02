// M2 的三条断言（PLAN § 5 的 U3）＋ 两条规则落地的负对照。
//
// 这一份**完全不碰 git**：下层是一个内存里的假体。理由是那三条断言都是纯逻辑的（重放 ·
// 合并读出 · 变更序列），而假体可以把"下层有什么"直接摆出来——真 git 那条路由
// `src/cli/fugue.test.ts` 端到端走。
import assert from 'node:assert/strict'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import type { Delta } from '../delta.ts'
import { EMPTY_TREE_ID } from '../entries.ts'
import type { DirEntry, EntryMeta } from '../entries.ts'
import { openLog } from '../log/log.ts'
import type { Log, LogEvent } from '../log/events.ts'
import type { AgentId, BlobId, CommitId, LogPos, LogSeq, WriterId } from '../terms.ts'
import type { Lower, View } from './contract.ts'
import { loadView } from './view.ts'

const AGENT = 'round' as AgentId

/** 内存里的下层。形状照 M1：目录是隐含的、符号链接的字节就是 target、gitlink 不可读。 */
class FakeLower implements Lower {
  readonly base: CommitId | null
  private readonly files = new Map<string, { bytes: Uint8Array; mode: number } | { target: string } | { gitlink: string }>()
  private readonly blobs = new Map<BlobId, Uint8Array>()

  constructor(base: CommitId | null = 'c0' as CommitId, files?: Map<string, never>) {
    this.base = base
  }

  file(path: string, text: string, mode = 0o100644): this {
    this.files.set(path, { bytes: Buffer.from(text), mode })
    return this
  }

  link(path: string, target: string): this {
    this.files.set(path, { target })
    return this
  }

  gitlink(path: string, id: string): this {
    this.files.set(path, { gitlink: id })
    return this
  }

  blob(id: BlobId, text: string): this {
    this.blobs.set(id, Buffer.from(text))
    return this
  }

  async readBlob(id: BlobId): Promise<Uint8Array> {
    const b = this.blobs.get(id)
    if (b === undefined) throw new Error(`下层没有这个对象：${id}`)
    return b
  }

  /**
   * 内容的 id。**假体按内容定**（这一份不碰 git，所以口径由这里给）：同一串字节问两次给同一个 id
   * ——真源那一侧（`Truth.putBlob`）的性质就是这个。
   */
  async putBlob(bytes: Uint8Array): Promise<BlobId> {
    return `blob:${Buffer.from(bytes).toString('utf8')}` as BlobId
  }

  async stat(path: string): Promise<EntryMeta | null> {
    const own = this.files.get(path)
    if (own !== undefined) {
      if ('bytes' in own) return { kind: 'file', mode: own.mode, size: own.bytes.length, id: `id:${path}` }
      if ('target' in own) {
        return { kind: 'symlink', mode: 0o120000, size: Buffer.byteLength(own.target), id: `id:${path}` }
      }
      return { kind: 'gitlink', mode: 0o160000, size: 0, id: own.gitlink }
    }
    if ([...this.files.keys()].some((k) => k.startsWith(path + '/'))) {
      return { kind: 'dir', mode: 0o40000, size: 0, id: EMPTY_TREE_ID }
    }
    return null
  }

  async read(path: string): Promise<Uint8Array | null> {
    const own = this.files.get(path)
    if (own === undefined) return null
    if ('bytes' in own) return own.bytes.slice()
    if ('target' in own) return Buffer.from(own.target)
    return null
  }

  async list(dir: string): Promise<DirEntry[]> {
    const rows = new Map<string, DirEntry>()
    for (const [k, v] of this.files) {
      if (!(dir === '' ? k !== '' : k.startsWith(dir + '/'))) continue
      const rest = dir === '' ? k : k.slice(dir.length + 1)
      const slash = rest.indexOf('/')
      const name = slash === -1 ? rest : rest.slice(0, slash)
      if (slash !== -1) {
        if (!rows.has(name)) rows.set(name, { name, kind: 'dir', mode: 0o40000, size: 0, id: EMPTY_TREE_ID })
        continue
      }
      const meta = await this.stat(k)
      if (meta !== null) rows.set(name, { name, ...meta })
    }
    return [...rows.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
  }
}

class FakeLog implements Log {
  private readonly events: LogEvent[] = []
  constructor(events: LogEvent[] = []) {
    this.events = events
  }
  async append(_w: WriterId, e: LogEvent): Promise<LogSeq> {
    this.events.push(e)
    return this.events.length
  }
  async *readByWriter(_w: WriterId, _from?: LogSeq): AsyncIterable<LogEvent> {
    for (const e of this.events) yield e
  }
  async *readMerged(_from?: LogSeq): AsyncIterable<{ pos: LogPos; e: LogEvent }> {
    for (let i = 0; i < this.events.length; i++) {
      yield { pos: { writer: AGENT as WriterId, seq: i + 1 }, e: this.events[i] }
    }
  }
}

/** 一份固定的下层：普通文件 · 子目录 · 符号链接 · gitlink。 */
function baseLower(): FakeLower {
  return new FakeLower()
    .file('a.txt', '底层的 a\n')
    .file('b.txt', '底层的 b\n')
    .file('d/x.txt', '底层的 x\n')
    .file('d/e/z.txt', '深一层\n')
    .link('link', 'a.txt')
    .gitlink('sub', 'c0ffee')
}

/** 全量读出：路径 · 类型 · 模式 · 内容（base64，符号链接就是它的 target）。 */
async function readAll(view: View): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const row of await view.list(dir)) {
      const p = dir === '' ? row.name : `${dir}/${row.name}`
      if (row.kind === 'dir') {
        await walk(p)
        continue
      }
      const bytes = await view.read(p)
      out.push(`${p}\t${row.kind}\t${row.mode.toString(8)}\t${bytes === null ? '-' : Buffer.from(bytes).toString('base64')}`)
    }
  }
  await walk('')
  return out
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const POOL = ['a.txt', 'b.txt', 'c.txt', 'd/x.txt', 'd/y.txt', 'd/e/z.txt', 'link', 'sub']

async function randomOp(v: View, rnd: () => number): Promise<void> {
  const pick = (): string => POOL[Math.floor(rnd() * POOL.length)]
  const n = Math.floor(rnd() * 5)
  const bytes = Buffer.from(`内容 ${Math.floor(rnd() * 1000)}\n`)
  if (n === 0) return await v.write(pick(), bytes)
  if (n === 1) return await v.remove(pick())
  if (n === 2) return await v.rename(pick(), pick())
  if (n === 3) return await v.chmod(pick(), rnd() < 0.5 ? 0o755 : 0o644)
  return await v.writeSymlink(pick(), pick())
}

test('断言①：随机操作序列的 diff 应用回 base，等于全量读出', async () => {
  for (const seed of [1, 7, 42, 99, 20260419]) {
    const lower = baseLower()
    const a = await loadView(new FakeLog(), AGENT, { lower })
    const rnd = mulberry32(seed)
    let ok = 0
    for (let i = 0; i < 60; i++) {
      try {
        await randomOp(a, rnd)
        ok++
      } catch {
        // 被拒的操作用来撞边界（目录改名 · 往 gitlink 里写 · 目标已存在），不计入
      }
    }
    assert.ok(ok >= 20, `seed ${seed}：只成功了 ${ok} 次，随机面太窄`)

    const b = await loadView(new FakeLog(), AGENT, { lower })
    await b.applyDelta(a.diff())

    assert.deepEqual(await readAll(b), await readAll(a), `seed ${seed}：diff 应用回 base 之后与全量读出不一致`)
    assert.equal(b.rev, a.rev, `seed ${seed}：rev`)
    assert.deepEqual(b.revs, a.revs, `seed ${seed}：修订点`)
  }
})

test('断言②：remove 之后再 write 同名，删除意图消失', async () => {
  const v = await loadView(new FakeLog(), AGENT, { lower: baseLower() })

  await v.remove('a.txt')
  assert.equal(await v.stat('a.txt'), null, '删掉之后读不到')
  await v.write('a.txt', Buffer.from('又回来了\n'))
  assert.equal((await v.read('a.txt'))?.toString(), '又回来了\n', '同名再写，内容就是新的')
  assert.equal((await v.stat('a.txt'))?.kind, 'file', '墓碑被这次写覆盖')

  // 目录那一条：删掉一个下层目录，再往里写一个新文件——**目录自己回来，被删掉的兄弟不回来**。
  await v.remove('d')
  assert.equal(await v.stat('d/x.txt'), null, '墓碑遮住下层整棵子树')
  assert.equal(await v.stat('d/e/z.txt'), null, '深处的也一样')
  await v.write('d/new.txt', Buffer.from('新\n'))
  assert.deepEqual(
    (await v.list('d')).map((r) => r.name),
    ['new.txt'],
    '目录回来了，但只有新写的那一个',
  )
  assert.equal((await v.stat('d'))?.kind, 'dir', '隐含目录：上层有入口，它就是目录')
})

test('断言②的重放面：同一条历史从日志重放出来，结果一样', async () => {
  const lower = baseLower().blob('blob:new' as BlobId, '又回来了\n')
  const log = new FakeLog([
    { t: 'view/remove', agent: AGENT, path: 'a.txt', rev: 1 },
    { t: 'view/write', agent: AGENT, path: 'a.txt', rev: 2, blob: 'blob:new' as BlobId, mode: 0o100644 },
    { t: 'view/remove', agent: AGENT, path: 'd', rev: 3 },
    { t: 'view/write', agent: AGENT, path: 'd/new.txt', rev: 4, blob: 'blob:new' as BlobId, mode: 0o100644 },
  ])
  const v = await loadView(log, AGENT, { lower })
  assert.equal((await v.read('a.txt'))?.toString(), '又回来了\n')
  assert.equal(await v.stat('d/x.txt'), null)
  assert.deepEqual((await v.list('d')).map((r) => r.name), ['new.txt'])
  assert.equal(v.rev, 4)
})

test('断言③：一次改名在 diff 里是一条 rename（一对 from/to）', async () => {
  const lower = baseLower()
  const v = await loadView(new FakeLog(), AGENT, { lower })
  await v.write('c.txt', Buffer.from('要改名的\n'))
  await v.rename('c.txt', 'd/新名字.txt')

  const renames = v.diff().filter((d) => d.kind === 'rename')
  assert.equal(renames.length, 1, '改名在变更序列里占一条，不是删一条加一条')
  assert.deepEqual(renames[0], { kind: 'rename', from: 'c.txt', to: 'd/新名字.txt' })
  assert.equal(await v.stat('c.txt'), null)
  assert.equal((await v.read('d/新名字.txt'))?.toString(), '要改名的\n')

  // 变更序列是重放的片段：单独一条 rename 应用不了（源还没被写出来），整段可以。
  const fresh = await loadView(new FakeLog(), AGENT, { lower })
  await fresh.applyDelta(v.diff())
  assert.deepEqual(await readAll(fresh), await readAll(v))
})

test('上下层合起来读：上层赢、目录并集、符号链接的字节就是 target', async () => {
  const lower = baseLower()
  const v = await loadView(new FakeLog(), AGENT, { lower })
  await v.write('a.txt', Buffer.from('上层改过的\n'))
  await v.write('d/y.txt', Buffer.from('上层新增的\n'))

  assert.deepEqual(
    (await v.list('')).map((r) => `${r.name}:${r.kind}`),
    ['a.txt:file', 'b.txt:file', 'd:dir', 'link:symlink', 'sub:gitlink'],
  )
  assert.deepEqual(
    (await v.list('d')).map((r) => r.name),
    ['e', 'x.txt', 'y.txt'],
    '上层的与下层的并起来',
  )
  assert.equal((await v.read('a.txt'))?.toString(), '上层改过的\n')
  assert.equal((await v.read('b.txt'))?.toString(), '底层的 b\n', '上层没碰过的从下层读')
  assert.equal((await v.read('link'))?.toString(), 'a.txt', '符号链接')
  assert.equal((await v.stat('d'))?.kind, 'dir')
  assert.equal((await v.stat('a.txt'))?.kind, 'file')
})

test('改名与改权限把下层文件拷上来；目录改名明确拒绝', async () => {
  const v = await loadView(new FakeLog(), AGENT, { lower: baseLower() })

  await v.chmod('b.txt', 0o755)
  assert.equal((await v.stat('b.txt'))?.mode, 0o100755)
  assert.equal((await v.read('b.txt'))?.toString(), '底层的 b\n', '内容照旧')

  await v.rename('b.txt', 'b-new.txt')
  assert.equal(await v.stat('b.txt'), null)
  assert.equal((await v.read('b-new.txt'))?.toString(), '底层的 b\n')

  await assert.rejects(() => v.rename('d', 'd2'), /目录改名/)
  await assert.rejects(() => v.rename('a.txt', 'd/x.txt'), /已经存在/)
  await assert.rejects(() => v.rename('没有这个', 'x'), /不存在/)
  await assert.rejects(() => v.write('d', Buffer.from('x')), /是一个目录/)
  await assert.rejects(() => v.write('a.txt/x', Buffer.from('x')), /是一个 file/)
})

test('gitlink：读不到字节，也不让往里写——但它可以整个删掉', async () => {
  const v = await loadView(new FakeLog(), AGENT, { lower: baseLower() })
  assert.equal((await v.stat('sub'))?.kind, 'gitlink')
  assert.equal(await v.read('sub'), null, '它指的是另一个仓库的一个提交，不是这个路径的字节')
  await assert.rejects(() => v.write('sub/x.txt', Buffer.from('x')), /submodule/)
  await v.remove('sub')
  assert.equal(await v.stat('sub'), null)
  assert.equal((await v.list('')).some((r) => r.name === 'sub'), false)
})

test('diff(since) 与 revs：修订点是事件给的，不是自己数的', async () => {
  const v = await loadView(new FakeLog(), AGENT, { lower: baseLower() })
  await v.write('c.txt', Buffer.from('一\n'))
  await v.chmod('c.txt', 0o755)
  await v.remove('c.txt')
  assert.equal(v.rev, 3)
  assert.deepEqual(v.revs, [0, 1, 2, 3])
  assert.equal(v.diff().length, 3)
  assert.equal(v.diff(1).length, 2, 'since 是排他下界')
  assert.equal(v.diff(3).length, 0)
})

test('真日志上的重放：写 · 改名 · 删 走一遍，与内存里的同一条历史一致', async (ctx) => {
  const root = tmpDir('fugue-view-')
  const log = openLog(root, { sync: 'never' })
  ctx.after(() => log.close())

  const lower = baseLower()
  // 真日志里的事件带 blob id，所以下层的按 id 取对象要能供上。
  lower.blob('blob:one' as BlobId, '第一版\n').blob('blob:two' as BlobId, '第二版\n')
  const events: LogEvent[] = [
    { t: 'view/write', agent: AGENT, path: 'd/x.txt', rev: 1, blob: 'blob:one' as BlobId, mode: 0o100644 },
    { t: 'view/rename', agent: AGENT, from: 'b.txt', to: 'b2.txt', rev: 2 },
    { t: 'view/write', agent: AGENT, path: 'a.txt', rev: 3, blob: 'blob:two' as BlobId, mode: 0o100755 },
    { t: 'view/remove', agent: AGENT, path: 'link', rev: 4 },
    { t: 'ckpt/commit', agent: AGENT, commit: 'c1' as CommitId, rev: 4, msg: '一次提交' },
  ]
  for (const e of events) await log.append(AGENT as WriterId, e)

  const v = await loadView(log, AGENT, { lower })
  assert.equal((await v.read('d/x.txt'))?.toString(), '第一版\n')
  assert.equal((await v.read('b2.txt'))?.toString(), '底层的 b\n', '下层的 b.txt 被改名拷了上来')
  assert.equal(await v.stat('b.txt'), null)
  assert.equal((await v.stat('a.txt'))?.mode, 0o100755)
  assert.equal(await v.stat('link'), null)
  assert.equal(v.rev, 4, '提交不改内容，但它的 rev 也在修订点里')
  assert.deepEqual(v.revs, [0, 1, 2, 3, 4])

  // 同一条历史用内存假体重放一遍，两份读出必须逐字节相同。
  const inMemory = await loadView(new FakeLog(events), AGENT, { lower })
  assert.deepEqual(await readAll(inMemory), await readAll(v))
})

test('upToRev：只重放到某个修订点', async () => {
  const lower = baseLower().blob('blob:one' as BlobId, '一\n').blob('blob:two' as BlobId, '二\n')
  const log = new FakeLog([
    { t: 'view/write', agent: AGENT, path: 'c.txt', rev: 1, blob: 'blob:one' as BlobId, mode: 0o100644 },
    { t: 'view/write', agent: AGENT, path: 'c.txt', rev: 2, blob: 'blob:two' as BlobId, mode: 0o100644 },
  ])
  const v = await loadView(log, AGENT, { lower, upToRev: 1 })
  assert.equal((await v.read('c.txt'))?.toString(), '一\n')
  assert.equal(v.rev, 1)
})

test('diff 在重放前后逐字节一致：活路径记的与重放算的是同一套', async () => {
  const lower = baseLower().blob('blob:one' as BlobId, '一\n').blob('blob:two' as BlobId, '二\n')
  const live = await loadView(new FakeLog(), AGENT, { lower })
  await live.write('c.txt', Buffer.from('一\n'))
  await live.write('c.txt', Buffer.from('二\n'))
  await live.remove('b.txt')
  await live.rename('c.txt', 'c2.txt')

  const replayed = await loadView(
    new FakeLog([
      { t: 'view/write', agent: AGENT, path: 'c.txt', rev: 1, blob: 'blob:one' as BlobId, mode: 0o100644 },
      { t: 'view/write', agent: AGENT, path: 'c.txt', rev: 2, blob: 'blob:two' as BlobId, mode: 0o100644 },
      { t: 'view/remove', agent: AGENT, path: 'b.txt', rev: 3 },
      { t: 'view/rename', agent: AGENT, from: 'c.txt', to: 'c2.txt', rev: 4 },
    ]),
    AGENT,
    { lower },
  )

  assert.deepEqual(replayed.diff(), live.diff(), '第一条写是 add，第二条是 modify——两边都要这么算')
  assert.deepEqual(await readAll(replayed), await readAll(live))
  assert.equal(replayed.rev, live.rev)
})
