// 只留受控完整表已证实的必要gram；未知项不能把部分知识当成完整索引。
// 此容器不认证来源。调用方必须从内容地址核对/受控存储读到的完整表学习。
export interface IndexFactOptions {
  readonly maxBlobs?: number
  readonly maxFacts?: number
  readonly maxLogicalBytes?: number
}
export interface IndexFactCache {
  query(blob: string, keys: readonly number[]): boolean | null
  remember(blob: string, observations: readonly (readonly [number, boolean])[]): boolean
  clear(): void
  stats(): { blobs: number; facts: number; logicalBytes: number; evictions: number; conflicts: number }
}
const FACT_BYTES = 9 // 一份48位键按8字节记账，加1字节布尔值；不是Map实际RSS。
function validBlob(blob: string): boolean { return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(blob) }
function validKey(key: number): boolean { return Number.isSafeInteger(key) && key >= 0 && key <= 0xffff_ffff_ffff }
function budget(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > maximum) throw new Error('invalid index fact budget')
  return selected
}
export function createIndexFactCache(options: IndexFactOptions = {}): IndexFactCache {
  const maxBlobs = budget(options.maxBlobs, 2048, 16384)
  const maxFacts = budget(options.maxFacts, 32768, 262144)
  const maxBytes = budget(options.maxLogicalBytes, 1024 * 1024, 16 * 1024 * 1024)
  const rows = new Map<string, Map<number, boolean>>()
  let facts = 0, logicalBytes = 0, evictions = 0, conflicts = 0
  function remove(blob: string): void {
    const row = rows.get(blob)
    if (row === undefined) return
    facts -= row.size; logicalBytes -= blob.length + row.size * FACT_BYTES
    rows.delete(blob)
  }
  function refresh(blob: string, row: Map<number, boolean>): void { rows.delete(blob); rows.set(blob, row) }
  return {
    query(blob, keys) {
      if (!validBlob(blob) || keys.length === 0 || keys.length > 256) return null
      for (const key of keys) if (!validKey(key)) return null
      const row = rows.get(blob)
      if (row === undefined) return null
      refresh(blob, row)
      let unknown = false
      for (const key of keys) {
        const known = row.get(key)
        if (known === false) return false
        if (known === undefined) unknown = true
      }
      return unknown ? null : true
    },
    remember(blob, observations) {
      if (!validBlob(blob) || observations.length === 0 || observations.length > 256 || maxBlobs === 0 || maxFacts === 0 || maxBytes === 0) return false
      const captured = new Map<number, boolean>()
      for (const observation of observations) {
        if (!Array.isArray(observation) || observation.length !== 2) return false
        const [key, present] = observation
        if (!validKey(key) || typeof present !== 'boolean') return false
        const previous = captured.get(key)
        if (previous !== undefined && previous !== present) { remove(blob); conflicts++; return false }
        captured.set(key, present)
      }
      const old = rows.get(blob)
      for (const [key, present] of captured) {
        const previous = old?.get(key)
        if (previous !== undefined && previous !== present) { remove(blob); conflicts++; return false }
      }
      const row = old ?? new Map<number, boolean>()
      if (old === undefined) logicalBytes += blob.length
      for (const [key, present] of captured) {
        if (!row.has(key)) { facts++; logicalBytes += FACT_BYTES }
        row.set(key, present)
      }
      refresh(blob, row)
      while (rows.size > maxBlobs || facts > maxFacts || logicalBytes > maxBytes) {
        const victim = rows.keys().next().value!
        remove(victim); evictions++
      }
      return rows.has(blob)
    },
    clear() { rows.clear(); facts = 0; logicalBytes = 0 },
    stats() { return { blobs: rows.size, facts, logicalBytes, evictions, conflicts } },
  }
}
