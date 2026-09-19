// 供并发测试用的写者进程：一个进程、一个 writer、N 条事件。
//
// 它只做架构 § 9.3 的中间那一步——追加日志。用它来检验 D11 那条性质：
// 并发写者之间不阻塞、不协调，而全序仍由 (seq, writer) 隐含确定。
import { openLog } from '../../src/log/log.ts'
import type { AgentId } from '../../src/terms.ts'

const [root, writer, count] = process.argv.slice(2)
const log = openLog(root, { sync: 'never' })

for (let i = 1; i <= Number(count); i++) {
  await log.append(writer as AgentId, {
    t: 'view/write',
    agent: writer as AgentId,
    path: `src/a${i}.ts`,
    rev: i,
    blob: `b${i}`,
    mode: 420,
  })
}

await log.close()
