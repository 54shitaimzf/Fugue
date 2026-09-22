// M4·V7 的断言。**一张转换表 + 五条边界**，逐条对 PLAN § 5.2 的 V7 行与 § 8.5 的六种情形。
//
// 这一份测的是 `landDeltas` 这一层，**不建仓库、不建视图、不挂载**：视图与 base 都是
// `ViewReads` 的替身（内存里的一张表），底与落地根是两个临时目录。V3 的 `ensure.test.ts` 测的是
// 整条线（日志 → 视图 → 清单 → 盘），这一份测的是那条线里最容易出错的一段——**每条路径上
// "视图要什么 × 盘上有什么"的转换**，以及目录这一维（V3 只走了文件级）。
//
// 判据不经过被测代码：落地根里那条的形状、模式、内容用原始 `fs` 调用读回来（`shape`/`modeOf`/
// `bytesOf`），幂等那一条用 `diffstat` 那把尺子（`scanTree`）扫两遍比 `(kind, mode, size, mtimeNs,
// hash)`——**同一批 delta 再来一次，一棵树逐字节不许动**。
//
// 表里每一行的期望都是字面量（不是拿被测函数算出来的），`sha()` 是测试自己算的 sha256（口径与
// § 8.5 的差异集一致：文件比内容、软链比目标那串字符）。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import type { Delta } from '../delta.ts'
import type { EntryMeta } from '../entries.ts'
import { scanTree } from './diffstat.ts'
import type { TreeStat } from './diffstat.ts'
import { LandError, landDeltas } from './land.ts'
import type { LandResult, ViewReads } from './land.ts'
import { makeWhiteout, removeTree } from './mount.ts'

const made: string[] = []
after(() => {
  for (const d of made) removeTree(d)
})

// ────────────────────────────────── 两个替身与三个读数

type Item =
  | { readonly kind: 'file'; readonly body: string; readonly mode?: number }
  | { readonly kind: 'symlink'; readonly target: string }
  | { readonly kind: 'dir' }

const file = (body: string, mode = 0o644): Item => ({ kind: 'file', body, mode })
const link = (target: string): Item => ({ kind: 'symlink', target })
const dir: Item = { kind: 'dir' }

const sha = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

/**
 * 一个读口。**目录要合成**：真视图（与 base 提交）的下层是一棵树，"它下面有东西"就意味着这一级
 * 是目录，而表里只写了叶子。
 */
function reader(items: Readonly<Record<string, Item>>, tombstones: readonly string[] = []): ViewReads {
  const keys = Object.keys(items)
  return {
    async stat(p: string): Promise<EntryMeta | null> {
      const it = items[p]
      if (it === undefined) {
        if (keys.some((k) => k.startsWith(p + '/'))) return { kind: 'dir', mode: 0o40000, size: 0, id: '' as never }
        return null
      }
      if (it.kind === 'dir') return { kind: 'dir', mode: 0o40000, size: 0, id: '' as never }
      if (it.kind === 'symlink') return { kind: 'symlink', mode: 0o120000, size: Buffer.byteLength(it.target), id: '' as never }
      const bytes = Buffer.from(it.body, 'utf8')
      return { kind: 'file', mode: it.mode === undefined ? 0o100644 : 0o100000 | it.mode, size: bytes.length, id: '' as never }
    },
    async read(p: string): Promise<Uint8Array | null> {
      const it = items[p]
      if (it === undefined) return null
      if (it.kind === 'file') return Buffer.from(it.body, 'utf8')
      if (it.kind === 'symlink') return Buffer.from(it.target, 'utf8')
      return null
    },
    tombstones: () => tombstones,
  }
}

function put(root: string, rel: string, it: Item): void {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  if (it.kind === 'dir') return void mkdirSync(abs, { recursive: true })
  if (it.kind === 'symlink') return void symlinkSync(it.target, abs)
  writeFileSync(abs, it.body, it.mode === undefined ? undefined : { mode: it.mode })
}

function tree(root: string, items: Readonly<Record<string, Item>>): void {
  for (const [rel, it] of Object.entries(items)) put(root, rel, it)
}

/** 落地根里那一条此刻的形状。**原始 `fs` 调用，不经过被测代码。** */
function shape(root: string, rel: string): 'none' | 'file' | 'symlink' | 'dir' | 'whiteout' | 'other' {
  let st
  try {
    st = lstatSync(join(root, rel))
  } catch {
    return 'none'
  }
  if (st.isSymbolicLink()) return 'symlink'
  if (st.isFile()) return 'file'
  if (st.isDirectory()) return 'dir'
  if (st.isCharacterDevice() && st.rdev === 0) return 'whiteout'
  return 'other'
}

const modeOf = (root: string, rel: string): number => lstatSync(join(root, rel)).mode & 0o777
const bytesOf = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8')
const linkOf = (root: string, rel: string): string => readlinkSync(join(root, rel))

/** 一棵树的读数：路径 → `(kind, mode, size, mtimeNs, hash)`。**扫两遍不许有差别。** */
function snap(root: string): string {
  const s: TreeStat = scanTree(root)
  return JSON.stringify(s.leaves.map((l) => [l.path, l.kind, l.mode, l.size, l.mtimeNs, l.hash]))
}

/**
 * 一棵树的"指纹"：每条路径的 `(kind, ino, size, mtimeNs, mode, 内容)`。`scanTree` 不带 inode，
 * 而"未变文件的 inode 也不许变"是 § 8.5 的承重性质四项里的一项，所以这里自己走一遍。
 */
function marks(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (rel: string): void => {
    const abs = rel === '' ? root : join(root, rel)
    for (const name of readdirSync(abs).sort()) {
      const child = rel === '' ? name : `${rel}/${name}`
      const st = lstatSync(join(root, child))
      if (st.isDirectory()) {
        out.set(child + '/', `dir ino=${st.ino}`)
        walk(child)
        continue
      }
      const body = st.isFile() ? readFileSync(join(root, child), 'utf8') : st.isSymbolicLink() ? readlinkSync(join(root, child)) : '?dev'
      out.set(child, `${st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other'} ino=${st.ino} size=${st.size} mtime=${st.mtimeNs} mode=${st.mode & 0o777} body=${body}`)
    }
  }
  walk('')
  return out
}

/** 与某一条 landed 路径有祖孙关系（它的变化是那次落地的直接后果）。 */
function kin(p: string, landed: readonly string[]): boolean {
  return landed.some((l) => p === l || p.startsWith(l + '/') || l.startsWith(p + '/') || p === l + '/')
}

// ────────────────────────────────── 一张表

/** 一行里那些按档不同的期望：`overlayfs` 档删除落成一条 whiteout，另两档就是真删。 */
interface Expect {
  /** 这条路在落地根里最后是什么形状。 */
  readonly shape: 'none' | 'file' | 'symlink' | 'dir' | 'whiteout'
  /** 清单：路径 → `'sha'` 表示"内容哈希"（测试自己算），`''` 表示"这儿没有了"。 */
  readonly manifest: Readonly<Record<string, string>>
  readonly landed: readonly string[]
  readonly untouched?: readonly string[]
}

interface Row {
  readonly name: string
  readonly lower?: Readonly<Record<string, Item>>
  /** base 提交那一份。不给就等于底（正常情形：工作树与提交一致）。 */
  readonly base?: Readonly<Record<string, Item>>
  /** 落地根里先有什么（上一批留下来的）。 */
  readonly target?: Readonly<Record<string, Item>>
  /** 落地根里先造一条硬链接到 `[底里的源, 落地根里的落点]`。 */
  readonly hardlink?: readonly [string, string]
  readonly before?: Readonly<Record<string, string>>
  readonly view: Readonly<Record<string, Item>>
  readonly dead?: readonly string[]
  readonly deltas: readonly Delta[]
  /** 落地根里那条路径（读数都看它）。 */
  readonly at: string
  readonly overlay: Expect
  readonly merged: Expect
  /** 期望报错（子串）；给了它就不看别的期望。 */
  readonly err?: string
}

const add = (path: string, body: string, mode = 0o644): Delta => ({ kind: 'add', path, bytes: Buffer.from(body, 'utf8'), mode: 0o100644 | mode })
const mod = add
const del = (path: string): Delta => ({ kind: 'delete', path })
const sym = (path: string, target: string): Delta => ({ kind: 'symlink', path, target })
const chmod = (path: string, mode: number): Delta => ({ kind: 'chmod', path, mode })

const ROWS: readonly Row[] = [
  {
    name: '① 新增一个文件（底里没有它）',
    view: { 'new.txt': file('hi\n') },
    deltas: [add('new.txt', 'hi\n')],
    at: 'new.txt',
    overlay: { shape: 'file', manifest: { 'new.txt': 'sha' }, landed: ['new.txt'] },
    merged: { shape: 'file', manifest: { 'new.txt': 'sha' }, landed: ['new.txt'] },
  },
  {
    name: '② 改写一个文件',
    lower: { 'a.txt': file('one\n') },
    view: { 'a.txt': file('two\n') },
    deltas: [mod('a.txt', 'two\n')],
    at: 'a.txt',
    overlay: { shape: 'file', manifest: { 'a.txt': 'sha' }, landed: ['a.txt'] },
    merged: { shape: 'file', manifest: { 'a.txt': 'sha' }, landed: ['a.txt'] },
  },
  {
    name: '③ 写回原内容：不碰盘 · 清单里划掉',
    lower: { 'a.txt': file('same\n') },
    view: { 'a.txt': file('same\n') },
    deltas: [mod('a.txt', 'same\n')],
    at: 'a.txt',
    // overlayfs 档：`upper` 里什么都不留（底给得出这一份）。另两档：`merged` 本来就有那一份
    // 拷贝，落地器一个字都不许动它——"没动盘"在那两档上不是"盘上没有了"。
    overlay: { shape: 'none', manifest: {}, landed: [], untouched: ['a.txt'] },
    merged: { shape: 'file', manifest: {}, landed: [], untouched: ['a.txt'] },
  },
  {
    name: '④ 删掉一个底里的文件',
    lower: { 'a.txt': file('one\n') },
    view: {},
    deltas: [del('a.txt')],
    at: 'a.txt',
    overlay: { shape: 'whiteout', manifest: { 'a.txt': '' }, landed: ['a.txt'] },
    merged: { shape: 'none', manifest: { 'a.txt': '' }, landed: ['a.txt'] },
  },
  {
    name: '⑤ 删掉一个底里也没有的路径：无害',
    view: {},
    deltas: [del('ghost.txt')],
    at: 'ghost.txt',
    overlay: { shape: 'none', manifest: {}, landed: [], untouched: ['ghost.txt'] },
    merged: { shape: 'none', manifest: {}, landed: [], untouched: ['ghost.txt'] },
  },
  {
    name: '⑥ 顶层路径（深度 1）· 空文件',
    view: { 'top.txt': file('') },
    deltas: [add('top.txt', '')],
    at: 'top.txt',
    overlay: { shape: 'file', manifest: { 'top.txt': 'sha' }, landed: ['top.txt'] },
    merged: { shape: 'file', manifest: { 'top.txt': 'sha' }, landed: ['top.txt'] },
  },
  {
    name: '⑦ 十层深路径',
    view: { 'a/b/c/d/e/f/g/h/i/j/k.ts': file('deep\n') },
    deltas: [add('a/b/c/d/e/f/g/h/i/j/k.ts', 'deep\n')],
    at: 'a/b/c/d/e/f/g/h/i/j/k.ts',
    overlay: { shape: 'file', manifest: { 'a/b/c/d/e/f/g/h/i/j/k.ts': 'sha' }, landed: ['a/b/c/d/e/f/g/h/i/j/k.ts'] },
    merged: { shape: 'file', manifest: { 'a/b/c/d/e/f/g/h/i/j/k.ts': 'sha' }, landed: ['a/b/c/d/e/f/g/h/i/j/k.ts'] },
  },
  {
    name: '⑧ 悬空软链 · 文件换成软链',
    lower: { 'l': file('was a file\n') },
    view: { l: link('nowhere/none') },
    deltas: [sym('l', 'nowhere/none')],
    at: 'l',
    overlay: { shape: 'symlink', manifest: { l: 'sha' }, landed: ['l'] },
    merged: { shape: 'symlink', manifest: { l: 'sha' }, landed: ['l'] },
  },
  {
    name: '⑨ 只改模式（内容一样）：就地 chmod，mtime/inode 不动',
    lower: { 'run.sh': file('#!/bin/sh\n') },
    view: { 'run.sh': file('#!/bin/sh\n', 0o755) },
    deltas: [chmod('run.sh', 0o100755)],
    at: 'run.sh',
    overlay: { shape: 'file', manifest: { 'run.sh': 'sha' }, landed: ['run.sh'] },
    merged: { shape: 'file', manifest: { 'run.sh': 'sha' }, landed: ['run.sh'] },
  },
  {
    name: '⑩ 删掉一整棵我们铺过的子树（底里没有它）',
    target: { 'src/gen/x.ts': file('x\n'), 'src/gen/deep/y.ts': file('y\n') },
    before: { 'src/gen/x.ts': 'sha', 'src/gen/deep/y.ts': 'sha' },
    view: {},
    dead: ['src/gen'],
    deltas: [del('src/gen')],
    at: 'src/gen',
    overlay: { shape: 'none', manifest: {}, landed: ['src/gen'] },
    merged: { shape: 'none', manifest: {}, landed: ['src/gen'] },
  },
  {
    name: '⑪ 删掉底里的一个目录：一条 whiteout，孩子跟着划掉',
    lower: { 'docs/a.md': file('a\n'), 'docs/b.md': file('b\n') },
    before: { 'docs/a.md': 'sha' },
    view: {},
    dead: ['docs'],
    deltas: [del('docs')],
    at: 'docs',
    overlay: { shape: 'whiteout', manifest: { docs: '' }, landed: ['docs'] },
    merged: { shape: 'none', manifest: { docs: '' }, landed: ['docs'] },
  },
  {
    name: '⑫ 文件换成目录（同名）',
    lower: { 'src/a.ts': file('a\n') },
    view: { 'src/a.ts/x.ts': file('x\n') },
    dead: ['src/a.ts'],
    deltas: [del('src/a.ts'), add('src/a.ts/x.ts', 'x\n')],
    at: 'src/a.ts/x.ts',
    overlay: { shape: 'file', manifest: { 'src/a.ts/x.ts': 'sha' }, landed: ['src/a.ts', 'src/a.ts/x.ts'] },
    merged: { shape: 'file', manifest: { 'src/a.ts/x.ts': 'sha' }, landed: ['src/a.ts', 'src/a.ts/x.ts'] },
  },
  {
    name: '⑬ 目录换成文件（同名）',
    lower: { 'src/gen/x.ts': file('x\n') },
    view: { 'src/gen': file('now a file\n') },
    dead: ['src/gen'],
    deltas: [del('src/gen'), add('src/gen', 'now a file\n')],
    at: 'src/gen',
    overlay: { shape: 'file', manifest: { 'src/gen': 'sha' }, landed: ['src/gen'] },
    merged: { shape: 'file', manifest: { 'src/gen': 'sha' }, landed: ['src/gen'] },
  },
  {
    name: '⑭ 上一批删掉一个文件，这一批在同一路径下建目录（whiteout 挡在中间）',
    lower: { 'src/a.ts': file('a\n') },
    target: {},
    before: { 'src/a.ts': '' },
    view: { 'src/a.ts/x.ts': file('x\n') },
    dead: ['src/a.ts'],
    deltas: [add('src/a.ts/x.ts', 'x\n')],
    at: 'src/a.ts/x.ts',
    overlay: { shape: 'file', manifest: { 'src/a.ts/x.ts': 'sha' }, landed: ['src/a.ts/x.ts'] },
    merged: { shape: 'file', manifest: { 'src/a.ts/x.ts': 'sha' }, landed: ['src/a.ts/x.ts'] },
  },
  {
    name: '⑮ 改名：来源那条落成"没有了"，落点那条落成新内容',
    lower: { 'vendor/lib.txt': file('v\n') },
    view: { 'vendor/lib2.txt': file('v\n') },
    deltas: [{ kind: 'rename', from: 'vendor/lib.txt', to: 'vendor/lib2.txt' }, mod('vendor/lib2.txt', 'v\n')],
    at: 'vendor/lib2.txt',
    overlay: { shape: 'file', manifest: { 'vendor/lib.txt': '', 'vendor/lib2.txt': 'sha' }, landed: ['vendor/lib.txt', 'vendor/lib2.txt'] },
    merged: { shape: 'file', manifest: { 'vendor/lib.txt': '', 'vendor/lib2.txt': 'sha' }, landed: ['vendor/lib.txt', 'vendor/lib2.txt'] },
  },
  {
    name: '⑯ 同一批里同一条路径先写后删：终态是"没有了"',
    lower: { 'a.txt': file('one\n') },
    view: {},
    deltas: [mod('a.txt', 'two\n'), del('a.txt')],
    at: 'a.txt',
    overlay: { shape: 'whiteout', manifest: { 'a.txt': '' }, landed: ['a.txt'] },
    merged: { shape: 'none', manifest: { 'a.txt': '' }, landed: ['a.txt'] },
  },
  {
    name: '⑰ base 与底不一致（工作树被人手改过）：清单按 base 算，不多那一条',
    lower: { 'k.txt': file('hand-edited\n') },
    base: { 'k.txt': file('committed\n') },
    target: { 'k.txt': file('committed\n') },
    view: { 'k.txt': file('committed\n') },
    deltas: [mod('k.txt', 'committed\n')],
    at: 'k.txt',
    overlay: { shape: 'file', manifest: {}, landed: [], untouched: ['k.txt'] },
    merged: { shape: 'file', manifest: {}, landed: [], untouched: ['k.txt'] },
  },
]

/**
 * 一行的落地根与底：临时目录里摆好。
 *
 * **`merged` 那两档的落地根一开始就是底的一份拷贝**（`fork` 铺出来的，§ 8.5 的策略表）——
 * 不给 `target` 的行按这个摆；给了的行自己说了上一批留下了什么。
 */
function bench(row: Row, overlay: boolean): { lower: string; target: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'fugue-land-'))
  made.push(root)
  const lower = join(root, 'real')
  const target = join(root, 'root')
  mkdirSync(lower, { recursive: true })
  mkdirSync(target, { recursive: true })
  tree(lower, row.lower ?? {})
  tree(target, row.target ?? (overlay ? {} : (row.lower ?? {})))
  if (row.hardlink !== undefined) {
    const [src, dst] = row.hardlink
    mkdirSync(dirname(join(target, dst)), { recursive: true })
    linkSync(join(lower, src), join(target, dst))
  }
  return { lower, target, cleanup: () => removeTree(root) }
}

async function land(row: Row, overlay: boolean, b: { lower: string; target: string }): Promise<LandResult> {
  return await landDeltas(
    {
      target: b.target,
      lower: b.lower,
      base: reader(row.base ?? row.lower ?? {}),
      overlay,
      whiteout: overlay ? (abs: string) => makeWhiteout(abs, 'direct') : null,
      pruneEmptyDirs: true,
      view: reader(row.view, row.dead ?? []),
    },
    new Map(Object.entries(row.before ?? {})),
    row.deltas,
  )
}

/** 清单的期望 → 实际（`'sha'` 换成测试自己算的哈希）。 */
function wantManifest(m: Readonly<Record<string, string>>, row: Row, at: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [p, v] of Object.entries(m)) {
    if (v !== 'sha') {
      out[p] = v
      continue
    }
    const it = row.view[p]
    if (it === undefined) throw new Error(`表里 ${p} 写了 'sha'，视图里却没有这一条`)
    out[p] = it.kind === 'file' ? sha(it.body) : it.kind === 'symlink' ? sha(it.target) : (() => { throw new Error('目录没有哈希') })()
  }
  void at
  return out
}

const asObject = (m: ReadonlyMap<string, string>): Record<string, string> => Object.fromEntries([...m].sort())

for (const overlay of [true, false]) {
  const rung = overlay ? 'overlayfs 档（落 upper · 删除 = whiteout）' : 'copy / hardlink 档（落 merged · 删除 = 真删）'
  test(`V7 · 转换表：${rung}`, async () => {
    for (const row of ROWS) {
      const exp = overlay ? row.overlay : row.merged
      const b = bench(row, overlay)
      try {
        const before = new Map(Object.entries(row.before ?? {}))
        const marks0 = marks(b.target)
        const out = await land(row, overlay, b)
        // **只有 landed 里那些路径的盘上读数可以变**（承重性质：mtime · inode · 内容逐字节不变）。
        const changed = [...marks(b.target)]
          .filter(([p, m]) => marks0.get(p) !== m)
          .map(([p]) => p)
          .filter((p) => !kin(p, out.landed))
          .filter((p) => ![...out.landed].some((l) => l.startsWith(p.replace(/\/$/, '') + '/')))
        assert.deepEqual(changed, [], `${row.name} · 没落到的那几条盘上不该动`)
        assert.equal(shape(b.target, row.at), exp.shape, `${row.name} · 形状`)
        assert.deepEqual(asObject(out.manifest), wantManifest(exp.manifest, row, row.at), `${row.name} · 清单`)
        assert.deepEqual([...out.landed].sort(), [...exp.landed].sort(), `${row.name} · 落地的路径`)
        assert.deepEqual([...out.untouched].sort(), [...(exp.untouched ?? [])].sort(), `${row.name} · 没动盘的路径`)
        // **幂等**：同一批 delta 再来一次，一棵树逐字节不动、清单不动。
        const before2 = snap(b.target)
        const lower2 = snap(b.lower)
        const again = await land(row, overlay, b)
        assert.deepEqual(asObject(again.manifest), asObject(out.manifest), `${row.name} · 第二次的清单`)
        assert.deepEqual([...again.landed], [], `${row.name} · 第二次不该动盘`)
        assert.equal(snap(b.target), before2, `${row.name} · 第二次之后落地根变了`)
        assert.equal(snap(b.lower), lower2, `${row.name} · 第二次之后底变了`)
        void before
      } finally {
        b.cleanup()
      }
    }
  })
}

// ────────────────────────────────── 三条单独立着的（表里摆不下）

test('V7 · 硬链接纪律的另一半：就地 chmod 不许穿透到真源', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-land-hl-'))
  made.push(root)
  const lower = join(root, 'real')
  const target = join(root, 'root')
  mkdirSync(join(lower, 'vendor'), { recursive: true })
  mkdirSync(join(target, 'vendor'), { recursive: true })
  put(lower, 'vendor/lib.txt', file('vendored\n'))
  linkSync(join(lower, 'vendor/lib.txt'), join(target, 'vendor/lib.txt'))
  const lowIno = lstatSync(join(lower, 'vendor/lib.txt')).ino
  assert.equal(lstatSync(join(target, 'vendor/lib.txt')).ino, lowIno, '夹具：这一条要是同一条 inode')

  // 视图只改模式（内容一样）——正是走"就地 chmod"那一支的形状。
  const out = await landDeltas(
    {
      target,
      lower,
      base: reader({ 'vendor/lib.txt': file('vendored\n') }),
      overlay: false,
      whiteout: null,
      pruneEmptyDirs: true,
      view: reader({ 'vendor/lib.txt': file('vendored\n', 0o755) }),
    },
    new Map(),
    [chmod('vendor/lib.txt', 0o100755)],
  )
  assert.deepEqual(out.landed, ['vendor/lib.txt'])
  assert.equal(modeOf(target, 'vendor/lib.txt'), 0o755, '落地根里那条要变成 755')
  assert.equal(modeOf(lower, 'vendor/lib.txt'), 0o644, '**真源的模式不许动**')
  assert.equal(bytesOf(lower, 'vendor/lib.txt'), 'vendored\n', '真源的内容也不许动（断链重写）')
  assert.notEqual(lstatSync(join(target, 'vendor/lib.txt')).ino, lowIno, '这条链要断掉')
  removeTree(root)
})

test('V7 · 一条 whiteout 打不开的那一支：动手之前拒绝，盘上一条不动', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-land-ro-'))
  made.push(root)
  const lower = join(root, 'real')
  const target = join(root, 'root')
  mkdirSync(lower, { recursive: true })
  mkdirSync(target, { recursive: true })
  put(lower, 'docs/a.md', file('a\n'))
  // 上一批：视图删掉 docs → 一条 whiteout。
  const first = await landDeltas(
    {
      target,
      lower,
      base: reader({ 'docs/a.md': file('a\n') }),
      overlay: true,
      whiteout: (abs: string) => makeWhiteout(abs, 'direct'),
      pruneEmptyDirs: true,
      view: reader({}, ['docs']),
    },
    new Map(),
    [del('docs')],
  )
  assert.equal(shape(target, 'docs'), 'whiteout')
  assert.deepEqual(asObject(first.manifest), { docs: '' })

  // 这一批：视图又在 docs 下面建东西了 —— 落不了地，也不许落一半。
  const target0 = snap(target)
  await assert.rejects(
    () =>
      landDeltas(
        {
          target,
          lower,
          base: reader({ 'docs/a.md': file('a\n') }),
          overlay: true,
          whiteout: (abs: string) => makeWhiteout(abs, 'direct'),
          pruneEmptyDirs: true,
          view: reader({ 'docs/again.md': file('again\n') }, ['docs']),
        },
        new Map([['docs', '']]),
        [add('docs/again.md', 'again\n')],
      ),
    (err: Error) => err instanceof LandError && /一条 whiteout 遮住的是下层的一整棵目录/.test(err.message),
  )
  assert.equal(snap(target), target0, '拒绝之后落地根必须与拒绝之前逐字节相同')
  removeTree(root)
})

test('V7 · 目录删除之后清单里不留已经跟着消失的路径', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-land-drop-'))
  made.push(root)
  const lower = join(root, 'real')
  const target = join(root, 'root')
  mkdirSync(lower, { recursive: true })
  mkdirSync(target, { recursive: true })
  put(lower, 'docs/a.md', file('a\n'))
  const out = await landDeltas(
    {
      target,
      lower,
      base: reader({ 'docs/a.md': file('a\n') }),
      overlay: true,
      whiteout: (abs: string) => makeWhiteout(abs, 'direct'),
      pruneEmptyDirs: true,
      view: reader({}, ['docs']),
    },
    new Map([
      ['docs/a.md', sha('a\n')],
      ['docs/old.md', sha('gone\n')],
    ]),
    [del('docs')],
  )
  assert.deepEqual(asObject(out.manifest), { docs: '' }, '清单里只该剩目录那一条')
  removeTree(root)
})

test('V7 · 另两档上的"重开"：落地根是我们自己那棵树，对完账视图不要的一条不留', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fugue-land-open-'))
  made.push(root)
  const lower = join(root, 'real')
  const target = join(root, 'root')
  mkdirSync(lower, { recursive: true })
  mkdirSync(target, { recursive: true })
  tree(lower, { 'docs/a.md': file('a\n'), 'docs/b.md': file('b\n') })
  // 另两档的落地根一开始就是底的一份拷贝（`fork` 铺的），里面还带着那两个文件。
  tree(target, { 'docs/a.md': file('a\n'), 'docs/b.md': file('b\n') })

  const out = await landDeltas(
    {
      target,
      lower,
      base: reader({ 'docs/a.md': file('a\n'), 'docs/b.md': file('b\n') }),
      overlay: false,
      whiteout: null,
      pruneEmptyDirs: true,
      view: reader({ 'docs/again.md': file('again\n') }, ['docs']),
    },
    new Map([['docs', '']]),
    [add('docs/again.md', 'again\n')],
  )
  assert.equal(shape(target, 'docs/a.md'), 'none', '被删掉的那个孩子不许留')
  assert.equal(shape(target, 'docs/b.md'), 'none', '被删掉的那个孩子不许留')
  assert.equal(bytesOf(target, 'docs/again.md'), 'again\n')
  assert.deepEqual(asObject(out.manifest), { 'docs/again.md': sha('again\n') })
  assert.deepEqual([...out.landed].sort(), ['docs/a.md', 'docs/again.md', 'docs/b.md'], '对账删掉的那两条也报进账')
  removeTree(root)
})
