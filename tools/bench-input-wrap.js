#!/usr/bin/env node
// 展开长输入的微基准；FUGUE_ROOT 可指向另一份 checkout，同一把尺比较前后。
// 只量单帧 inputFrameOf，不代表整套 TUI 或模型调用快了多少；不作 CI 时长断言。
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.env.FUGUE_ROOT ?? process.cwd())
const { emptyEditor, EMPTY_DRAFT, inputFrameOf } = await import(pathToFileURL(resolve(root, 'src/ui/input.ts')).href)
const samplesMs = []
for (let i = 0; i < 5; i++) {
  // 每次换长度，避免按串缓存让后几次变成同一份热读数。
  const n = 6000 + i
  const e = { ...emptyEditor(), draft: { ...EMPTY_DRAFT, text: 'a'.repeat(n), caret: n }, unfolded: true }
  const started = performance.now()
  const frame = inputFrameOf({ e, prompt: '> ', width: 80 })
  samplesMs.push(performance.now() - started)
  if (frame.rows.length !== 3) throw new Error('输入窗口行数不符')
}
console.log(JSON.stringify({ chars: '6000–6004', width: 80, samplesMs, medianMs: [...samplesMs].sort((a, b) => a - b)[2] }))
