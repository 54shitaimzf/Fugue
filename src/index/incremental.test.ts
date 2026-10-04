// 增量构建的判据：**只碰新进来的 blob** · **与全量重建逐字节相同** · 退化档。
// 出处：ROADMAP § 4 的增量构建那一行（随读随建 · 只爬新 blob）与它的验收格；底座是 § 9 的
// 「索引在盘格式」那一格（`trigram.idx` v1 冻结——格式面一个字节不动）。跑法：
//   cd ~/fugue && node --test src/index/incremental.test.ts
//
// 两条验收句各有一个点名对手，而且**互相补位**——这一对要一起看：
//
//   · 「与全量重建逐字节相同」抓**分叉**（漏一条 postings · 顺序号映射错一位 · 字典次序错了 ·
//     丢掉的那一份没清掉）。对手是一个"只把旧字节搬过来"的合并。
//   · 「只碰新 blob」抓**假增量**（嘴上增量、手上整库重爬），**也抓"合并坏了就悄悄回全量"**
//     ——回全量那一趟读的是整组，读数当场对不上。少了它，一个只会抛的合并会被全量兜成这样：
//     工件照样对，增量一次都没发生，而断言全绿。
//
//   ① 穷举等价：5 份 blob 的全部 32×32 组（旧组, 新组）配对（含空组与"删光"，且**有成对的
//      blob 共享窗口**），合并与全量重建逐字节相同。**直接调 `mergeTrigram`**（不走
//      `openOrRebuild` 的退化档）：那一条路上"合并抛了"就是红，不会被全量兜住
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { buildTrigram, encodeTrigram, mergeTrigram, sectionsOf } from './trigram.ts'
import type { BlobBytes, Trigram } from './trigram.ts'
import type { BlobId } from '../terms.ts'

const bytesOf = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'))
/** 内容的名字：**键控 blob id**（增量复用旧工件那一侧的贡献，靠的就是这一条）。 */
const idOf = (bytes: Uint8Array): BlobId => createHash('sha256').update(bytes).digest('hex') as BlobId

/** 一份内容池：id → 字节。语料都是常量，id 因此在一趟跑里稳定。 */
function poolOf(texts: readonly string[]): Map<BlobId, Uint8Array> {
  return new Map(texts.map((text) => [idOf(bytesOf(text)), bytesOf(text)] as [BlobId, Uint8Array]))
}

function blobsOf(pool: ReadonlyMap<BlobId, Uint8Array>, ids: readonly BlobId[]): BlobBytes[] {
  return ids.map((id) => ({ id, bytes: pool.get(id) as Uint8Array }))
}

/** 两份字节逐字节相同吗。**不同就报第一处不同的位置与两边的摘要**——不是一长串数组。 */
function assertSameBytes(got: Uint8Array, want: Uint8Array, what: string): void {
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  if (a.equals(b)) return
  let at = 0
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1
  const mark = (x: Buffer): string => createHash('sha256').update(x).digest('hex').slice(0, 16)
  assert.fail(
    `${what}：两份工件不同——${a.length} 对 ${b.length} 字节，第一处不同在第 ${at} 个；sha256 ${mark(a)} 对 ${mark(b)}`,
  )
}

// ── ① 穷举等价 ─────────────────────────────────────────────────────────────

test('① 穷举等价：5 份 blob 的 32×32 组配对，合并与全量重建逐字节相同', () => {
  // 这份语料**故意让几份 blob 共享窗口**，还带一个空文件与一个短于三个单元的：不共享的话，
  // "两路都有这个 gram"那一支一次都走不到，而"漏掉新解那一半"正是这一条要抓的对手
  // （负对照实测抓到过这一格空转——头一版语料里 16×16 组配对没有一组共享窗口）。
  const pool = poolOf(['', 'ab', 'abc xyz', 'abc xyz more', 'xyz 中文 abc'])
  const universe = [...pool.keys()].sort()
  /** 子集 → 全量那一趟的字节（**同一份语料只算一次**，全量那一侧因此不是每条断言都重算）。 */
  const whole = new Map<string, Uint8Array>()
  /** 子集 → 它那些 gram 键（给"这一格没空转"那一条读数用）。 */
  const keys = new Map<string, Set<Trigram>>()
  const keyOf = (ids: readonly BlobId[]): string => [...ids].sort().join(',')
  const rebuilt = (ids: readonly BlobId[]): Uint8Array => {
    const key = keyOf(ids)
    const hit = whole.get(key)
    if (hit !== undefined) return hit
    const made = encodeTrigram(buildTrigram(blobsOf(pool, ids)))
    whole.set(key, made)
    return made
  }
  const keysOf = (ids: readonly BlobId[]): Set<Trigram> => {
    const key = keyOf(ids)
    const hit = keys.get(key)
    if (hit !== undefined) return hit
    const made = new Set(buildTrigram(blobsOf(pool, ids)).grams.map((one) => one.gram))
    keys.set(key, made)
    return made
  }
  const subsets: BlobId[][] = []
  for (let mask = 0; mask < 32; mask++) subsets.push(universe.filter((_, i) => (mask & (1 << i)) !== 0))

  let pairs = 0
  let shared = 0
  for (const oldIds of subsets) {
    const old = sectionsOf(rebuilt(oldIds))
    assert.notEqual(old, null, `旧组（${oldIds.length} 份）的工件该读得回来`)
    for (const newIds of subsets) {
      const had = new Set(oldIds)
      const freshIds = newIds.filter((id) => !had.has(id))
      if ([...keysOf(oldIds)].some((gram) => keysOf(freshIds).has(gram))) shared += 1
      const fresh = buildTrigram(blobsOf(pool, freshIds))
      // 名单的**顺序与重复不算差别**：每两对里有一对把名单倒过来喂。
      const keep = pairs % 2 === 0 ? newIds : [...newIds].reverse()
      const merged = encodeTrigram(mergeTrigram(old as NonNullable<typeof old>, fresh, keep))
      assertSameBytes(merged, rebuilt(newIds), `旧 ${oldIds.length} 份 → 新 ${newIds.length} 份`)
      pairs += 1
    }
  }
  assert.ok(shared > 0, '一份共享窗口都没有：两路归并那一支一次都没走到，这条断言是空转')
  console.log(
    `① 读数：${pairs} 组配对（含空组与删光那一档 · ${shared} 组两路都有同一个 gram）逐字节相同 ·` +
      ` 全量那一侧共算了 ${whole.size} 份工件`,
  )
})
