#!/usr/bin/env node
// 只读开发出口：既有 M0 日志 → 有界的逐模型调用 JSON，不开启产品写者。
import { resolve } from 'node:path'
import { openLog } from '../src/log/log.ts'
import { DEFAULT_CALL_LEDGER_ROWS, readCallLedger } from '../src/probe/call-ledger.ts'

const args = process.argv.slice(2)
if (args.length < 1 || args.length > 2) {
  console.error('usage: node tools/call-ledger.js <workspace-root> [max-rows]')
  process.exit(2)
}
// 只认十进制非负整数：`Number('')` 是 0、`Number('1e3')` 是 1000、`Number('0x10')` 是 16——
// 脚本里变量没设（空串）会悄悄变成「0 行、truncated」。
if (args[1] !== undefined && !/^\d+$/.test(args[1])) {
  console.error('max-rows must be a non-negative decimal integer')
  process.exit(2)
}
const limit = args[1] === undefined ? DEFAULT_CALL_LEDGER_ROWS : Number(args[1])
const log = openLog(resolve(args[0]))
try {
  const ledger = await readCallLedger(log.readMerged(), limit)
  console.log(JSON.stringify(ledger))
} finally {
  await log.close()
}
