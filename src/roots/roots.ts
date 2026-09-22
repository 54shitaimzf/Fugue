// M3 的装配：把路径算术 · 围栏 · 落点探测接成一份 `Roots`（架构 § 8.4）。
//
// **它自己没有逻辑**：三处判断各有各的家，这里只把"哪个根"与"哪一段路径"喂进去。装配放在
// 单独一份，是为了让"根长什么样"这件事只有一个地方说——`mat/<agent>/{upper, merged, tmp,
// cache}`（§ 8.4）改一次，只改 `paths.ts` 的 `MAT_PARTS`，调用点一个字不动。
//
// **无状态**：没有缓存、没有句柄、没有需要收尾的东西。同一条路径问两次得到同一串字符，
// 而真实落点上有没有那个文件是另一件事（那由 M1／M4 回答）。
import type { AbsPath, AgentId, RelPath } from '../terms.ts'
import type { Outside, Result, Roots, Denied } from './contract.ts'
import { resolveVirtual } from './fence.ts'
import { MAT_PARTS, assertRoot, matRoot, toPhysical, underRoot } from './paths.ts'

/** 一套 `Roots`。`realRoot` 要绝对且规整（`paths.ts` 的 `assertRoot` 判），非法当场抛。 */
export function createRoots(realRoot: AbsPath): Roots {
  const root = assertRoot(realRoot)
  const part = (a: AgentId, name: string): AbsPath => toPhysical(matRoot(root, a), name)
  const scratch = (a: AgentId): AbsPath => part(a, MAT_PARTS.scratch)

  return {
    realRoot: root,
    scratchRoot: scratch,
    tempRoot: (a) => part(a, MAT_PARTS.temp),
    cacheRoot: (a) => part(a, MAT_PARTS.cache),
    mergedRoot: (a) => part(a, MAT_PARTS.merged),

    toScratch: (a, rel) => toPhysical(scratch(a), rel),
    toMerged: (a, rel) => toPhysical(part(a, MAT_PARTS.merged), rel),
    toReal: (rel) => toPhysical(root, rel),

    fromScratch: (a, abs): RelPath | Outside => {
      const s = scratch(a)
      const rel = underRoot(s, abs)
      return rel === null ? { outside: true, abs, root: s } : rel
    },

    resolveVirtual: (path, cwd): Result<RelPath, Denied> => resolveVirtual(root, path, cwd),
  }
}
