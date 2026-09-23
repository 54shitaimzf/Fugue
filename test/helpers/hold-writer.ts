// 供 W0 的断言用的持锁进程：拿到该 writer 的锁，报出自己的 pid，然后一直不放手。
//
// **不注册任何退出处理**（没有 `process.on('exit')`、没有 `finally`）：`kill -9` 它之后锁文件
// 留在原地，才是"持者不在了、锁还在"那个现场——陈旧判死那一条要的正是它。
import { holdWriter } from '../../src/log/hold.ts'
import type { WriterId } from '../../src/terms.ts'

const [root, writer] = process.argv.slice(2)
const hold = holdWriter(root, writer as WriterId)
process.stdout.write(String(hold.pid) + '\n')
setInterval(() => {}, 1000)
