// 探针：**物化那两条命令每次要读多少日志**。取证用，不是产品的一部分。
//
// `matState` 与 `loadView` 都走 `Log.readByWriter`，而它一次读整份文件、逐行 JSON.parse。
// 这里量的是"读完一份 N 条事件的日志要多久"，与事件类型无关（两者都不看 `run/*`）。
import { mkdtempSync, rmSync } from 'node:fs'
import type { Lower } from '../src/view/contract.ts'
import { openLog } from '../src/log/log.ts'
import { loadView } from '../src/view/view.ts'
import { matState } from '../src/materialize/manifest.ts'

const W = 'round'
const lower: Lower = {
  base: null,
  readBlob: async () => new Uint8Array(0),
  stat: async () => null,
  read: async () => null,
  list: async () => [],
}

for (const n of [300, 3_000, 15_000]) {
  const dir = mkdtempSync(`/tmp/fugue-logcost-${n}-`)
  const log = openLog(dir, { sync: 'never' })
  const t0 = performance.now()
  for (let i = 0; i < n; i++) {
    await log.append(W, { t: 'run/start', agent: W as never, step: `s${i}` as never, action: 'x', argv0: 'x' })
  }
  const writeMs = performance.now() - t0
  const t1 = performance.now()
  const st = await matState(log, W as never)
  const matMs = performance.now() - t1
  const t2 = performance.now()
  await loadView(log, W, { lower })
  const viewMs = performance.now() - t2
  console.log(
    `${String(n).padStart(6)} 条事件：写 ${writeMs.toFixed(0).padStart(6)} ms · matState ${matMs.toFixed(0).padStart(6)} ms（${((matMs / n) * 1000).toFixed(0)} µs/条） · loadView ${viewMs.toFixed(0).padStart(6)} ms（${((viewMs / n) * 1000).toFixed(0)} µs/条） · 一次 ensure = 两者之和 ${(matMs + viewMs).toFixed(0)} ms · fork 过=${st.forked}`,
  )
  await log.close()
  rmSync(dir, { recursive: true, force: true })
}
