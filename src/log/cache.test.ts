// U5（句柄内解析记忆）的断言。**断言正确性，不断言快慢**——缓存省下的是重读重解析，
// 那一笔账是读数（提交信息记），不是判据。四条盯的都是同一件事：**缓存不许把旧的当新的，
// 也不许把新的读丢**：
//
//   ① 同一条句柄两趟无写入 → 逐条相同（缓存的底线：命不命中都得出同样的答案）；
//   ② 追加 N 条后同一句柄再读 == 旧全量 + 新 N 条（外部追加，正是跟随档每一趟的处境）；
//   ③ 负对照——`utimes` 把 mtime 归回旧值，缓存仍必须失效：只认 mtime 的那一版当场红
//      （size 那一半存在的理由）；
//   ④ 写者档句柄自读自账：自己 append 之后自己读，走同一条失效路（`append` 不碰缓存，
//      失效全靠 stat 的键）。
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { LogEvent } from './events.ts'
import { logDir, openLog } from './log.ts'
import type { LogPos, WriterId } from '../terms.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'fugue-cache-'))
const W = (s: string): WriterId => s as WriterId

const ev = (i: number): LogEvent => ({
  t: 'view/write',
  agent: 'a' as never,
  path: `src/f${i}.ts`,
  rev: i,
  blob: `b${i}`,
  mode: 420,
})

/** 收一整趟 `readMerged`，压成可比对的字（(writer, seq, t) 一条一行）。 */
async function face(log: { readMerged: (from?: number) => AsyncGenerator<{ pos: LogPos; e: LogEvent }> }): Promise<string> {
  const out: string[] = []
  for await (const { pos, e } of log.readMerged()) out.push(`${pos.writer} ${pos.seq} ${e.t}`)
  return out.join('\n')
}

test('① 同一条句柄两趟无写入：逐条相同（命中与不命中是同一份答案）', async () => {
  const root = tmp()
  const w = openLog(root, { sync: 'never', write: W('a') })
  await w.append(W('a'), ev(1))
  await w.append(W('a'), ev(2))
  await w.close()

  const log = openLog(root)
  try {
    const first = await face(log)
    const second = await face(log)
    assert.equal(second, first, '第二趟（应命中缓存）与第一趟逐条不同')
    assert.equal(first.split('\n').length, 2, '两趟都是两条')
  } finally {
    await log.close()
  }
})

test('② 外部追加 N 条：同一句柄再读 == 旧全量 + 新 N 条', async () => {
  const root = tmp()
  const w = openLog(root, { sync: 'never', write: W('a') })
  await w.append(W('a'), ev(1))
  await w.append(W('a'), ev(2))
  await w.close()

  const log = openLog(root)
  const before = await face(log)
  // 外部追加（另一条写者句柄，模拟跟随档看着别人写）：正是缓存最怕的「我没动，账变了」。
  const other = openLog(root, { sync: 'never', write: W('b') })
  await other.append(W('b'), ev(3))
  await other.append(W('b'), ev(4))
  await other.append(W('b'), ev(5))
  await other.close()

  const after = await face(log)
  try {
    assert.equal(
      after.split('\n').length,
      before.split('\n').length + 3,
      `追加 3 条后该是 ${before.split('\n').length + 3} 条，读到 ${after.split('\n').length}`,
    )
    // 合并序是 (seq, writer)——seq 是主键：新 writer 的 seq 1 会**插进**旧账中间，
    // 所以「旧全量」不是 after 的前缀。不变的判据换成两条：writer a 自己那几条逐条
    // 原样在场；多出来的恰好是 b 那 3 条。
    const oldLines = before.split('\n')
    const aLines = after.split('\n').filter((l) => l.startsWith('a '))
    assert.deepEqual(aLines, oldLines, 'writer a 的那几条被缓存改了（次序或内容）')
    assert.equal(after.split('\n').filter((l) => l.startsWith('b ')).length, 3, 'b 的新三条都该在场')
    assert.ok(after.includes('b 1 view/write'), '新 writer 的第一条进了合并序')
  } finally {
    await log.close()
  }
})

test('③ 负对照：utimes 把 mtime 归回旧值，缓存仍必须失效（size 那一半）', async () => {
  const root = tmp()
  const w = openLog(root, { sync: 'never', write: W('a') })
  await w.append(W('a'), ev(1))
  await w.close()

  const file = join(logDir(root), 'a.jsonl')
  // `Date` 只有整毫秒精度：先把 mtime 摆到**整毫秒**上再读，缓存里存的键就是整数，
  // 之后 `utimes` 才摆得回**同一个值**（第一读若带小数毫秒，经 Date 回写会取整——摆不回去）。
  const anchor = new Date(Math.floor(Date.now()))
  utimesSync(file, anchor, anchor)
  const log = openLog(root)
  const before = await face(log)
  const st = statSync(file)

  // 外部追加一条，然后**把 mtime 摆回读前那一刻**——只认 mtime 的缓存会把旧账当成新的。
  const other = openLog(root, { sync: 'never', write: W('a') })
  await other.append(W('a'), ev(2))
  await other.close()
  utimesSync(file, st.atime, st.mtime)
  assert.equal(statSync(file).mtimeMs, st.mtimeMs, '负对照没摆成：mtime 还在变')
  assert.notEqual(statSync(file).size, st.size, '负对照的前提：size 变了')

  const after = await face(log)
  try {
    assert.equal(
      after.split('\n').length,
      before.split('\n').length + 1,
      `mtime 归一后仍该看到新的一条（缓存必须被 size 逼失效），读到 ${after.split('\n').length} 条`,
    )
  } finally {
    await log.close()
  }
})

test('④ 写者档句柄自读自账：append 之后自己读，走同一条失效路', async () => {
  const root = tmp()
  const log = openLog(root, { sync: 'never', write: W('a') })
  try {
    await log.append(W('a'), ev(1))
    await log.append(W('a'), ev(2))
    await log.append(W('a'), ev(3))
    assert.equal((await face(log)).split('\n').length, 3, '写者档第一趟：三条全见（缓存此刻存下 3 条）')

    await log.append(W('a'), ev(4))
    await log.append(W('a'), ev(5))
    const again = await face(log)
    assert.equal(again.split('\n').length, 5, `写完再读该是 5 条（缓存必须失效），读到 ${again.split('\n').length}`)
    assert.ok(again.includes('a 5 view/write'), '第五条（最新那条）进了答案')
  } finally {
    await log.close()
  }
})
