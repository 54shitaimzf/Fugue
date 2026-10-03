import type { EntryMeta } from '../entries.ts'
import type { BlobId } from '../terms.ts'

export const PREFETCH_BYTE_BUDGET = 4 * 1024 * 1024

/** The concrete host's metadata prefix policy, shared by loading and proven all-hit elision. */
export function prefetchPlan(metas: readonly (EntryMeta | null)[]): { readonly ids: readonly BlobId[]; readonly covered: number } {
  const ids: BlobId[] = []
  let bytes = 0, covered = metas.length
  for (const [at, meta] of metas.entries()) {
    if (meta === null || meta.kind !== 'file') continue
    const id = meta.id
    if (id === undefined || id === null || id === '') continue
    if (bytes + meta.size > PREFETCH_BYTE_BUDGET) { covered = at; break }
    bytes += meta.size
    ids.push(id as BlobId)
  }
  return { ids, covered }
}
