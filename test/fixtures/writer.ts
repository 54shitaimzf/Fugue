// 崩溃恢复实验的写者：**一个进程写一批文件，然后在某个时刻被杀掉**。
//
// 它是探针，不是产品的一部分（工作区约定 § 7「探针与基准脚本」）：验收要"写完一批后强杀 →
// 重建 == 已落盘的完整事件前缀"，就得有一个能被杀的批写者。命令行一条一条敲是模拟不出来的
// ——每条命令一个进程，杀在哪一条之间都是干净的边界。
//
// 用法：node test/fixtures/writer.ts <root> <writer> <个数> [每份字节数]
//
// **`sync: 'each'`**：§ 9.5 把这个档位留给"提交点、检查点、崩溃一致性实验"，这里正是它。
import { openLog } from '../../src/log/log.ts'
import { openTruth } from '../../src/truth/truth.ts'
import type { WriterId } from '../../src/terms.ts'
import { applyEdit } from '../../src/view/edit.ts'
import { lowerFor } from '../../src/view/lower.ts'
import { loadView } from '../../src/view/view.ts'

const [root, writer, countRaw, padRaw] = process.argv.slice(2)
if (root === undefined || writer === undefined) {
  process.stderr.write('用法：writer.ts <root> <writer> <个数> [每份字节数]\n')
  process.exit(2)
}
const count = Number(countRaw ?? '100')
const pad = Number(padRaw ?? '0')

/** 第 i 份的内容。**这一行是探针与断言之间的约定**：测试按同一个式子算期望值。 */
function contentOf(i: number, padBytes: number): Buffer {
  return Buffer.from(`文件 ${i}\n` + 'x'.repeat(padBytes))
}

const log = openLog(root, { sync: 'each' })
const truth = await openTruth(root)
try {
  const w = writer as WriterId
  const view = await loadView(log, w, { lower: await lowerFor(truth, w) })
  for (let i = 0; i < count; i++) {
    await applyEdit(
      { log, truth, view, writer: w },
      { kind: 'add', path: `f${i}.txt`, bytes: contentOf(i, pad), mode: 0o100644 },
    )
  }
} finally {
  await log.close()
  await truth.close()
}
