#!/usr/bin/env node
// 把 `src/cli/__fixture__/wire-in/` 里那份录制请求**就地**改齐当前工具目录（离线 · 不碰网 ·
// 不读凭据 · 不动响应）。改了目录的描述或 schema 之后跑这一条：
//
//   node tools/adapt-wire-in.ts
//
// 它只动 `tools` 那一栏与跟着它派生的那几栏（见 `test/helpers/wire-catalog.ts` 的注释），
// 并把这件事记进 `src/cli/__fixture__/wire-in/provenance.json`。**响应仍是历史那一份**：
// 这不是重录，重录要真跑一趟（`tools/record-wire-in.sh`）。
//
// 盘上那一份本来就一致时它一个字节都不写回去（`changed` 全是 false），所以反复跑是安全的。
import { fileURLToPath } from 'node:url'
import { adaptWireIn } from '../test/helpers/wire-catalog.ts'

const root = fileURLToPath(new URL('../src/cli/__fixture__/wire-in/', import.meta.url))
const got = adaptWireIn(root, true)
console.log(JSON.stringify({ directory: root, ...got }, null, 2))
console.log(
  `目录指纹 ${got.catalogHash} · ${got.calls.length} 条调用 · 改写 ${got.calls.filter((c) => c.changed).length} 条 · 一次 fetch 都没有`,
)
