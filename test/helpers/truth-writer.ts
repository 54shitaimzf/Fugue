// 供并发与崩溃实验用的写者进程。一个进程一条路，**它只做架构 § 9.3 那三步**：
// 先把 blob 写进 M1 · 再追加日志 · 最后改内存视图。U2 只验前两步里属于 M1 的部分。
//
// 用法：node test/helpers/truth-writer.ts <root> <ref> <模式> [参数…]
//
//   commit <n>                    造 n 个提交，每个都 CAS 推进自己的 ref（零协调）
//   race <expectedOld> <栅栏文件>  造一个提交，等栅栏出现，再 CAS 推进同一个 ref
//   crash                         落一个 blob、自报 id，然后挂住——等外面 SIGKILL
//                                 （协议第 1 步之后、第 2 步之前）
//
// 输出：每行一条 JSON。**CAS 输掉不算异常**，照样一行 JSON、退出码 0——那是那把锁
// 正常工作时的样子，不是这个进程出错。
import { existsSync } from 'node:fs'
import { openTruth } from '../../src/truth/truth.ts'
import type { TreeEntry } from '../../src/entries.ts'
import type { RefName } from '../../src/terms.ts'

const [root, ref, mode, ...rest] = process.argv.slice(2)
const truth = openTruth(root)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function say(row: unknown): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(JSON.stringify(row) + '\n', () => resolve())
  })
}

if (mode === 'commit') {
  const n = Number(rest[0])
  const entries: TreeEntry[] = []
  let parent: CommitId | null = null
  try {
    parent = await truth.resolve(ref as RefName)
  } catch {
    parent = null
  }
  for (let i = 1; i <= n; i++) {
    const blob = await truth.putBlob(Buffer.from(`${ref} 的第 ${i} 条内容\n`))
    entries.push({ name: `w${i}.txt`, mode: 0o100644, id: blob })
    const tree = await truth.putTree(entries)
    const commit = await truth.commit(tree, parent === null ? [] : [parent], `${ref} #${i}`)
    await truth.advance(ref as RefName, commit, parent)
    parent = commit
    await say({ ok: true, commit })
  }
} else if (mode === 'race') {
  const expectedOld = rest[0] as CommitId
  const barrier = rest[1]
  const blob = await truth.putBlob(Buffer.from(`race ${process.pid}\n`))
  const tree = await truth.putTree([{ name: `race-${process.pid}.txt`, mode: 0o100644, id: blob }])
  const commit = await truth.commit(tree, [expectedOld], `race ${process.pid}`)
  while (!existsSync(barrier)) await sleep(1)
  try {
    await truth.advance(ref as RefName, commit, expectedOld)
    await say({ ok: true, commit })
  } catch (err) {
    await say({ ok: false, commit, error: (err as Error).name, message: (err as Error).message })
  }
} else if (mode === 'crash') {
  const blob = await truth.putBlob(Buffer.from('孤儿 blob：写完了，日志还没写\n'))
  // 自报 id 之后挂住，等外面 SIGKILL——**不是优雅退出**，是进程在半途上没了。
  await say({ ok: true, blob })
  await new Promise(() => undefined)
} else {
  process.stderr.write(`未知模式：${mode}\n`)
  process.exit(2)
}

await truth.close()
