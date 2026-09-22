// 探针：**目录这一维**在落地里的几种情形，加两条硬链接/清单的。取证用，不是产品的一部分。
//
// V3 的六种情形（add · modify · delete · rename · chmod · symlink）都是文件级的；这个探针问的是
// 目录级的那一维（删掉一整棵我们铺过的子树 · 删掉之后在同一个路径下重建 · 文件与目录互换），
// 外加两条：就地 chmod 会不会穿透共享的 inode（硬链接那一档），以及清单里会不会留下已经跟着
// 祖先一起消失的路径。每一例都真写真删，最后列出落地根里剩下什么。
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Delta } from '../src/delta.ts'
import type { EntryMeta } from '../src/entries.ts'
import { landDeltas } from '../src/materialize/land.ts'
import type { LandResult, ViewReads } from '../src/materialize/land.ts'
import { makeWhiteout } from '../src/materialize/mount.ts'

type Item = { kind: 'file'; body: string; mode?: number } | { kind: 'symlink'; target: string } | { kind: 'dir' }

function viewOf(map: Map<string, Item>, dead: string[] = []): ViewReads {
  return {
    async stat(p: string): Promise<EntryMeta | null> {
      const it = map.get(p)
      // 假视图也要合成目录：真视图的下层是 git 树，"有孩子"就意味着那一级是目录。
      if (it === undefined) {
        for (const k of map.keys()) if (k.startsWith(p + '/')) return { kind: 'dir', mode: 0o40000, size: 0, id: '' as never }
        return null
      }
      if (it.kind === 'dir') return { kind: 'dir', mode: 0o40000, size: 0, id: '' as never }
      if (it.kind === 'symlink') {
        return { kind: 'symlink', mode: 0o120000, size: Buffer.byteLength(it.target), id: '' as never }
      }
      const bytes = Buffer.from(it.body, 'utf8')
      return { kind: 'file', mode: it.mode ?? 0o100644, size: bytes.length, id: '' as never }
    },
    async read(p: string): Promise<Uint8Array | null> {
      const it = map.get(p)
      if (it === undefined) return null
      if (it.kind === 'file') return Buffer.from(it.body, 'utf8')
      if (it.kind === 'symlink') return Buffer.from(it.target, 'utf8')
      return null
    },
    tombstones: () => dead,
  }
}

function put(root: string, rel: string, it: Item): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  if (it.kind === 'dir') return void mkdirSync(abs, { recursive: true })
  if (it.kind === 'symlink') return void symlinkSync(it.target, abs)
  writeFileSync(abs, it.body, it.mode === undefined ? undefined : { mode: it.mode })
}

/** 落地根里此刻有什么（叶子 + 目录，whiteout 标出来）。 */
function listing(root: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const name of readdirSync(rel === '' ? root : join(root, rel)).sort()) {
      const child = rel === '' ? name : `${rel}/${name}`
      const st = lstatSync(join(root, child))
      if (st.isDirectory()) {
        out.push(child + '/')
        walk(child)
        continue
      }
      if (st.isCharacterDevice()) out.push(child + '  [whiteout]')
      else if (st.isSymbolicLink()) out.push(child + ' -> ' + readlinkSync(join(root, child)))
      else out.push(child + `  ${st.size}B mode=${(st.mode & 0o777).toString(8)}`)
    }
  }
  walk('')
  return out
}

const add = (path: string, body: string): Delta => ({ kind: 'add', path, bytes: Buffer.from(body, 'utf8'), mode: 0o100644 })
const del = (path: string): Delta => ({ kind: 'delete', path })

interface Step {
  readonly view: Map<string, Item>
  readonly deltas: readonly Delta[]
  /** 视图上层里的墓碑（给"一条 whiteout 打不开"那一支判据用）。 */
  readonly dead?: string[]
}

interface Case {
  readonly name: string
  readonly lower: Map<string, Item>
  readonly before?: Map<string, string>
  /** 落地之前先在这条路径上造一条硬链接（模拟 hardlink-ro 档）。 */
  readonly hardlink?: string
  readonly steps: readonly Step[]
  /** 收尾要看的那个文件在底里的模式（硬链接那一例看它有没有被穿透）。 */
  readonly watchModeOf?: string
}

const mk = (items: Record<string, Item>): Map<string, Item> => new Map(Object.entries(items))

const CASES: readonly Case[] = [
  {
    name: '① 删掉一整棵我们铺过的子树（底里没有它）',
    lower: mk({}),
    steps: [
      { view: mk({ 'src/gen/x.ts': { kind: 'file', body: 'x\n' }, 'src/gen/deep/y.ts': { kind: 'file', body: 'y\n' } }), deltas: [add('src/gen/x.ts', 'x\n'), add('src/gen/deep/y.ts', 'y\n')] },
      { view: mk({}), deltas: [del('src/gen')], dead: ['src/gen'] },
    ],
  },
  {
    name: '② 删掉底里就有的目录',
    lower: mk({ 'docs/a.md': { kind: 'file', body: 'a\n' }, 'docs/b.md': { kind: 'file', body: 'b\n' } }),
    steps: [{ view: mk({}), deltas: [del('docs')], dead: ['docs'] }],
  },
  {
    name: '③ 删掉之后再在同一个路径下重建（两次 ensure）→ 口径：拒绝',
    lower: mk({ 'docs/a.md': { kind: 'file', body: 'a\n' } }),
    steps: [
      { view: mk({}), deltas: [del('docs')], dead: ['docs'] },
      { view: mk({ 'docs/again.md': { kind: 'file', body: 'again\n' } }), deltas: [add('docs/again.md', 'again\n')], dead: ['docs'] },
    ],
  },
  {
    name: '④ 同一批里先删目录、再往它下面写 → 口径：拒绝',
    lower: mk({ 'docs/a.md': { kind: 'file', body: 'a\n' } }),
    steps: [
      { view: mk({ 'docs/again.md': { kind: 'file', body: 'again\n' } }), deltas: [del('docs'), add('docs/again.md', 'again\n')], dead: ['docs'] },
    ],
  },
  {
    name: '⑤ 文件换成目录（同名）',
    lower: mk({ 'src/a.ts': { kind: 'file', body: 'a\n' } }),
    steps: [{ view: mk({ 'src/a.ts/x.ts': { kind: 'file', body: 'x\n' } }), deltas: [del('src/a.ts'), add('src/a.ts/x.ts', 'x\n')], dead: ['src/a.ts'] }],
  },
  {
    name: '⑥ 目录换成文件（同名）',
    lower: mk({ 'src/gen/x.ts': { kind: 'file', body: 'x\n' } }),
    steps: [{ view: mk({ 'src/gen': { kind: 'file', body: 'now a file\n' } }), deltas: [del('src/gen'), add('src/gen', 'now a file\n')], dead: ['src/gen'] }],
  },
  {
    name: '⑦ 只改模式（内容一样）· 落地根里那条是**硬链接到真源**的',
    lower: mk({ 'vendor/lib.txt': { kind: 'file', body: 'vendored\n', mode: 0o644 } }),
    hardlink: 'vendor/lib.txt',
    watchModeOf: 'vendor/lib.txt',
    steps: [{ view: mk({ 'vendor/lib.txt': { kind: 'file', body: 'vendored\n', mode: 0o100755 } }), deltas: [{ kind: 'chmod', path: 'vendor/lib.txt', mode: 0o100755 }] }],
  },
  {
    name: '⑧ 清单不再留下已经跟着祖先一起消失的路径',
    lower: mk({ 'docs/a.md': { kind: 'file', body: 'a\n' } }),
    before: new Map([['docs/a.md', 'deadbeef'], ['docs/old.md', 'deadbeef']]),
    steps: [{ view: mk({}), deltas: [del('docs')], dead: ['docs'] }],
  },
  {
    name: '⑩ 前一批删掉一个**文件**，这一批在同一个路径下建目录（whiteout 挡在中间）',
    lower: mk({ 'src/a.ts': { kind: 'file', body: 'a\n' } }),
    steps: [
      { view: mk({}), deltas: [del('src/a.ts')], dead: ['src/a.ts'] },
      { view: mk({ 'src/a.ts/x.ts': { kind: 'file', body: 'x\n' } }), deltas: [add('src/a.ts/x.ts', 'x\n')], dead: ['src/a.ts'] },
    ],
  },
  {
    name: '⑨ 悬空软链 · 空文件 · 十层深路径',
    lower: mk({}),
    steps: [
      { view: mk({ l: { kind: 'symlink', target: 'nowhere/none' }, 'empty.txt': { kind: 'file', body: '' } }), deltas: [{ kind: 'symlink', path: 'l', target: 'nowhere/none' }, add('empty.txt', '')] },
      { view: mk({ l: { kind: 'symlink', target: 'nowhere/none' }, 'a/b/c/d/e/f/g/h/i/j/k.ts': { kind: 'file', body: '' } }), deltas: [add('a/b/c/d/e/f/g/h/i/j/k.ts', '')] },
      { view: mk({ l: { kind: 'symlink', target: 'nowhere/none' } }), deltas: [del('a')], dead: ['a'] },
    ],
  },
]

async function run(overlay: boolean): Promise<void> {
  console.log(`\n═══ ${overlay ? 'overlayfs 档（落 upper · 删除 = whiteout）' : 'copy / hardlink 档（落 merged · 删除 = 真删）'} ═══`)
  for (const c of CASES) {
    const base = mkdtempSync('/tmp/fugue-probe-')
    const lower = join(base, 'real')
    const target = join(base, overlay ? 'upper' : 'merged')
    mkdirSync(lower, { recursive: true })
    mkdirSync(target, { recursive: true })
    for (const [rel, it] of c.lower) put(lower, rel, it)
    // **`merged` 那两档的落地根一开始就是底的一份拷贝**（`fork` 铺的，§ 8.5 的策略表）；
    // `upper` 一开始是空的。探针要照这个摆，不然量的是另一种情形。
    if (!overlay) for (const [rel, it] of c.lower) put(target, rel, it)
    if (c.hardlink !== undefined) {
      // 硬链接那一档：源写在底里，落点是**链**过去的一条（`hardlink-ro`，或 `--ro` 声明过的子树）。
      mkdirSync(join(target, 'vendor'), { recursive: true })
      try {
        unlinkSync(join(target, c.hardlink))
      } catch {
        // 目标里本来没有
      }
      linkSync(join(lower, c.hardlink), join(target, c.hardlink))
    }
    let manifest = new Map<string, string>(c.before ?? [])
    console.log(`\n── ${c.name}`)
    const shown = [...manifest].length > 0 ? `（起始清单 ${[...manifest.keys()].join(' · ')}）` : ''
    if (shown !== '') console.log(`   ${shown}`)
    let step = 0
    for (const s of c.steps) {
      step++
      let out: LandResult | null = null
      let err: Error | null = null
      try {
        out = await landDeltas(
          {
            target,
            lower,
            base: viewOf(c.lower),
            overlay,
            whiteout: overlay ? (abs: string) => makeWhiteout(abs, 'direct') : null,
            pruneEmptyDirs: true,
            view: viewOf(s.view, s.dead),
          },
          manifest,
          s.deltas,
        )
      } catch (e) {
        err = e as Error
      }
      if (err !== null) {
        const first = err.message.split('\n')[0]
        console.log(`  第 ${step} 步：**${err.name}: ${first}**`)
        console.log(`    落地根： ${listing(target).join(' · ') || '（空）'}`)
        continue
      }
      const o = out as LandResult
      manifest = o.manifest
      console.log(
        `  第 ${step} 步：落地 ${o.landed.length} 条（${o.landed.join(' · ') || '—'}） · 原样 ${o.untouched.length} 条 · whiteout ${o.whiteouts} · 清空目录 ${o.pruned}`,
      )
      console.log(`    清单： ${[...o.manifest].map(([k, v]) => `${k}=${v === '' ? '（没有了）' : v.slice(0, 6)}`).join(' · ') || '（空）'}`)
      console.log(`    落地根： ${listing(target).join(' · ') || '（空）'}`)
    }
    if (c.watchModeOf !== undefined) {
      const st = lstatSync(join(lower, c.watchModeOf))
      const tp = lstatSync(join(target, c.watchModeOf))
      console.log(
        `    真源 ${c.watchModeOf}：mode=${(st.mode & 0o777).toString(8)} inode=${st.ino} ｜ 落地根：mode=${(tp.mode & 0o777).toString(8)} inode=${tp.ino} → ${st.ino === tp.ino ? '仍是同一条 inode（同一条链）' : '已断链'}`,
      )
    }
    rmSync(base, { recursive: true, force: true })
  }
}

await run(true)
await run(false)
