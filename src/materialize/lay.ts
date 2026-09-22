// `copy` 与 `hardlink-ro` 两档的铺树。**底是真实工作树**（§ 8.4）：`fork` 不搬运、
// 不复制底——但这两档没有 overlay 可用，只能把底真的铺一份出来。
//
// 三件事各自有出处：
//
// 一 · **哪些路径跳掉。** `.git` 与 `.fugue` 是工作区的状态，不是项目的一部分
//      （`WORKSPACE_STATE`，§ 9.6 的 `diff-stat` 用同一个口径）。`.fugue` 还非跳不可：
//      这次物化的目标就住在它里面，照铺会自己吃自己。
//
// 二 · **硬链接只在声明过的只读子树上用**（§ 8.5 硬链接纪律）。它有一条直接的负对照：
//      对 `cp -al` 出来的树就地写一个字节，底里那条的 `(size, mtime, inode)` 跟着变——
//      共享 inode 被穿透，真源被污染。所以"哪些能链"不是这一层自己猜的，是调用点声明的；
//      没声明就一个都不链（那一档因此直接不可用，由 `capability.ts` 说清）。
//
// 三 · **软链照抄，不跟。** 跟过去会把链外的东西搬进物化树，而视图里那个路径就是一个链。
//
// 认不出来的条目类型（fifo · socket · 设备）**显式失败并报出是哪个路径**：静默跳过会让
// 物化树少东西而不报错，那是这一层最不该有的失败模式。
import {
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  utimesSync,
} from 'node:fs'
import { join } from 'node:path'
import { assertRelPath } from '../roots/paths.ts'
import type { AbsPath, RelPath } from '../terms.ts'

export class LayError extends Error {
  readonly path: RelPath

  constructor(path: RelPath, why: string) {
    super(`${why}：${path}`)
    this.name = 'LayError'
    this.path = path
  }
}

export interface LayOptions {
  /** 声明为只读的子树：它们用硬链接，其余一律复制。 */
  readonly readOnly: readonly RelPath[]
  readonly preserveMtime: boolean
  /** 顶层要跳过的名字（`WORKSPACE_STATE`）。**只判顶层**，与 `diffstat.ts` 同一口径。 */
  readonly skip: readonly RelPath[]
}

export interface LayResult {
  files: number
  links: number
  symlinks: number
  dirs: number
}

/** `rel` 在不在某个声明过的只读子树里。声明本身先过一遍语法（段段合法 · 相对路径）。 */
function underReadOnly(rel: RelPath, readOnly: readonly RelPath[]): boolean {
  for (const raw of readOnly) {
    const ro = assertRelPath(raw)
    if (ro !== '' && (rel === ro || rel.startsWith(ro + '/'))) return true
  }
  return false
}

/** 一个普通文件：复制，然后把模式与时间戳按底调回去。 */
function copyOne(src: AbsPath, dst: AbsPath, o: LayOptions): void {
  copyFileSync(src, dst)
  const st = lstatSync(src, { bigint: true })
  chmodSync(dst, Number(st.mode) & 0o7777)
  if (o.preserveMtime) utimesSync(dst, Number(st.atimeNs) / 1e9, Number(st.mtimeNs) / 1e9)
}

/**
 * 把 `src` 铺到 `dst`。`dst` 必须是空的（`fork` 先清后建，见 `mount.ts` 的
 * `clearMaterialization`）。
 */
export function layTree(src: AbsPath, dst: AbsPath, o: LayOptions): LayResult {
  const out: LayResult = { files: 0, links: 0, symlinks: 0, dirs: 0 }
  walk(src, dst, '', o, out)
  return out
}

function walk(dir: AbsPath, to: AbsPath, prefix: string, o: LayOptions, out: LayResult): void {
  for (const name of readdirSync(dir).sort()) {
    if (prefix === '' && o.skip.includes(name)) continue
    const rel: RelPath = prefix === '' ? name : prefix + '/' + name
    const src = join(dir, name)
    const dst = join(to, name)
    const st = lstatSync(src)
    const big = lstatSync(src, { bigint: true })
    if (st.isDirectory()) {
      mkdirSync(dst)
      out.dirs++
      walk(src, dst, rel, o, out)
      continue
    }
    if (st.isSymbolicLink()) {
      symlinkSync(readlinkSync(src), dst)
      if (o.preserveMtime) {
        lutimesSync(dst, Number(big.atimeNs) / 1e9, Number(big.mtimeNs) / 1e9)
      }
      out.symlinks++
      continue
    }
    if (st.isFile()) {
      if (underReadOnly(rel, o.readOnly)) {
        linkSync(src, dst)
        out.links++
      } else {
        copyOne(src, dst, o)
        out.files++
      }
      continue
    }
    throw new LayError(rel, '这一档铺不动它：既不是目录、软链，也不是普通文件（fifo · socket · 设备）')
  }
}
