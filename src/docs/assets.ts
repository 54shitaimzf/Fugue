// 图片的落点：从提交里复制到 `_assets/`，名字按内容哈希（同一张图只存一份）。
//
// 从 build.ts 搬出来时补的断言：搬之前 ./assets.ts 不存在；行为由 build ⑫（跨页引用）
// 与产物字节覆盖。这一份不认识清单与页面渲染，只把正文里的图片按提交落到批次里。
import { posix } from 'node:path'
import type { CommitId } from '../terms.ts'
import type { Truth } from '../truth/contract.ts'
import type { PageDef, TreeFacts } from './contract.ts'
import type { BatchFile } from './publish.ts'
import { repoPathOf } from './paths.ts'

/** 图片的落点：从提交里复制到 `_assets/`，名字按内容哈希（同一张图只存一份）。 */
export interface AssetPlan {
  readonly files: BatchFile[]
  readonly hrefOf: (pageId: string, raw: string) => string | null
}

export async function planAssets(o: {
  readonly pages: readonly { def: PageDef; markdown: string }[]
  readonly facts: TreeFacts
  readonly truth: Truth
  readonly commit: CommitId
}): Promise<AssetPlan> {
  const byPath = new Map<string, { href: string; bytes: Uint8Array }>()
  const byPage = new Map<string, Map<string, string>>()
  const known = new Set(o.facts.paths)
  for (const { def, markdown } of o.pages) {
    const map = new Map<string, string>()
    const re = /!\[([^\]]*)\]\(([^)\s]+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(markdown)) !== null) {
      const raw = m[2]!
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue
      const path = repoPathOf(def.source, raw)
      if (path === null || !known.has(path)) continue
      const hit = byPath.get(path)
      if (hit !== undefined) {
        map.set(raw, hit.href)
        continue
      }
      const bytes = await o.truth.readAt(o.commit, path as never)
      if (bytes === null) continue
      const href = `_assets/${await assetNameOf(bytes, path)}`
      byPath.set(path, { href, bytes })
      map.set(raw, href)
    }
    byPage.set(def.id, map)
  }
  return {
    files: [...byPath.values()].map((v) => ({ path: v.href, bytes: v.bytes })),
    hrefOf: (pageId, raw) => byPage.get(pageId)?.get(raw) ?? null,
  }
}

/** `_assets/` 里那份文件叫什么：内容哈希前 8 位 + 原名（同名不同内容也撞不上）。 */
async function assetNameOf(bytes: Uint8Array, path: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const base = posix.basename(path).replace(/[^\w.-]/g, '_')
  return `${sha}-${base}`
}


