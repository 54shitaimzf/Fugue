#!/usr/bin/env node
// 勘察/测试用的小件（**仓库外**用的那一份在 `src/serve/serve.test.ts` 里另有一段同形状的）：
// 拿住某个 writer 的栅栏，把 pid 与锁路径写进一段 JSON，然后一直握着不放——
// `kill -9` 之后盘上留下的就是「一条没清理的锁」。
// 用法：node test/golden/hold.mjs <root> <writer> <readyFile>
import { writeFileSync } from 'node:fs'
import { holdWriter, lockFileOf } from '../../src/log/hold.ts'

const [root, writer, ready] = process.argv.slice(2)
const hold = holdWriter(root, writer)
writeFileSync(ready, JSON.stringify({ pid: process.pid, path: lockFileOf(root, writer), writer }))
// 不放：等外面把我们杀掉。
setInterval(() => {}, 1000)
