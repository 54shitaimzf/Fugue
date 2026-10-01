import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { performance } from 'node:perf_hooks'

// 仅开发探针的本进程API观察器，不是kernel tracer；调用方先结清所开的句柄再restore。
export function observeIndexReads(api = fs, syncExports = syncBuiltinESMExports) {
  const samples = new Map()
  const originalOpen = api.open
  let restored = false
  function record(name, start) {
    const values = samples.get(name) ?? []
    values.push(performance.now() - start)
    samples.set(name, values)
  }
  api.open = async function (...args) {
    const start = performance.now()
    try {
      const file = await originalOpen.apply(this, args)
      for (const name of ['stat', 'read', 'close']) {
        const original = file[name]
        file[name] = async function (...values) {
          const start = performance.now()
          try { return await original.apply(this, values) }
          finally { record(name, start) }
        }
      }
      return file
    } finally { record('open', start) }
  }
  try { syncExports() }
  catch (error) {
    api.open = originalOpen
    // 同步钩子可能半途失败；尽量把命名导出也接回，但保留最初的安装错误。
    try { syncExports() } catch { /* 原绑定已经恢复；不让二次钩子遮盖原错。 */ }
    throw error
  }
  return {
    metrics() {
      return Object.fromEntries([...samples].map(([name, values]) => {
        const sorted = [...values].sort((a, b) => a - b)
        return [name, {
          calls: values.length,
          overlappingTotalMs: values.reduce((sum, value) => sum + value, 0),
          medianMs: sorted[Math.floor(sorted.length / 2)],
          p95Ms: sorted[Math.floor(sorted.length * 0.95)],
        }]
      }))
    },
    restore() {
      if (restored) return
      restored = true
      api.open = originalOpen
      syncExports()
    },
  }
}
