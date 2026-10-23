// 来源文件里的相对路径 → 提交里的仓库相对路径。
//
// 两处共用一个口径：正文里的图片（`assets.ts`）与跨页链接（`build.ts` 的 bySource 那一路）。
// 带 scheme 的、越界的、空路径一律 `null`——调用方据此决定“照原样写”还是“落成链接”。
import { posix } from 'node:path'

export function repoPathOf(source: string, raw: string): string | null {
  const clean = raw.split('#')[0]!.split('?')[0]!
  if (clean === '' || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null
  const p = clean.startsWith('/') ? clean.slice(1) : posix.normalize(posix.join(posix.dirname(source), clean))
  if (p.startsWith('..') || p === '' || p === '.') return null
  return p
}
