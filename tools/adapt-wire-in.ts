#!/usr/bin/env node
// 从 original/ 的不可变历史种子派生合成目录兼容夹具，不发送 live 请求。
// 重复执行不改字节或mtime；writtenFiles报告本次实际写入，provenance只含确定性来历。
import { fileURLToPath } from 'node:url'
import { adaptWireIn } from '../test/helpers/wire-catalog.ts'

const root = fileURLToPath(new URL('../src/cli/__fixture__/wire-in/', import.meta.url))
const got = adaptWireIn(root, true)
console.log(JSON.stringify({ directory: root, ...got }, null, 2))
console.log(
  `目录指纹 ${got.catalogHash} · ${got.calls.length} 条调用 · 写入 ${got.writtenFiles} 个文件 · 一次 fetch 都没有`,
)
