// 构建那四条上限的判据：越过去**不建**，而且报得出是哪一条；上限之内照建。
// 跑法：cd ~/fugue && node --test src/index/budget.test.ts
//
//   ① **上限是闭的**：贴着量出来的值给，四条都不越、照样建得出来；四条各减一，各自报出那一条
//      对手：把上限写成"必须小于"的实现（等于把每一条都偷偷减一）· 报错却不说是哪一条的实现
//   ② 越限那一趟**一条工件都不落盘**，而且同一组再问一次还是同一态（不是随机失败）
//   ③ `encodedBytesOf` **不是估的**：算出来的长度与真编出来的逐字节相等——预算那一关据它判
//      对手：拿一个上界糊弄过去的估算（上限会被算错，判据就落空了）
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { INDEX_LIMITS, IndexBudgetExceeded } from './budget.ts'
import type { IndexBudget, IndexBudgetLimits } from './budget.ts'
import { buildFrom, indexExists, rebuildIndex } from './store.ts'
import type { BlobSource } from './store.ts'
import { buildTrigram, encodedBytesOf, encodeTrigram } from './trigram.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'

const asBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'))

/** 一份语料：够杂就行（含中文与空文件那一档）。 */
const CORPUS = [
  'export function lineWindow(bytes, offset, limit) {',
  'postings 键控 blob id —— 一处真相',
  'abc',
  'abcdef',
]

/** 一份不碰文件系统的源：上限判的是账，不是仓。 */
function sourceOf(texts: readonly string[]): BlobSource {
  const blobs = texts.map((text) => {
    const bytes = asBytes(text)
    return { id: createHash('sha1').update(bytes).digest('hex'), bytes }
  })
  return {
    ids: async () => blobs.map((b) => b.id),
    read: async (id) => {
      const hit = blobs.find((b) => b.id === id)
      if (hit === undefined) throw new Error(`这一份不在语料里：${id}`)
      return hit.bytes
    },
  }
}

/** 上限那一栏 → 报出来该是哪一条。 */
const OVER_OF: Record<keyof IndexBudgetLimits, IndexBudget> = {
  sourceBytes: 'source-bytes',
  blobs: 'blobs',
  grams: 'grams',
  artifactBytes: 'artifact-bytes',
}

// ── ① 上限是闭的 ───────────────────────────────────────────────────────────

test('① 上限是闭的：贴着量出来的值给建得出来，四条各减一就报出那一条', async () => {
  const source = sourceOf(CORPUS)
  const exact = await buildFrom(source)
  const tight: IndexBudgetLimits = {
    sourceBytes: exact.sourceBytes,
    blobs: exact.blobCount,
    grams: exact.gramCount,
    artifactBytes: exact.artifactBytes,
  }
  // 一次不多不少：四条都贴边，照样建得出来——上限是**允许的最大值**，不是"必须小于"。
  const bounded = await buildFrom(source, tight)
  assert.equal(bounded.artifactBytes, exact.artifactBytes)
  assert.equal(bounded.gramCount, exact.gramCount)

  for (const field of Object.keys(OVER_OF) as (keyof IndexBudgetLimits)[]) {
    const cut: IndexBudgetLimits = { ...tight, [field]: tight[field] - 1 }
    const error = await buildFrom(source, cut).then(() => null, (thrown: unknown) => thrown)
    assert.ok(error instanceof IndexBudgetExceeded, `${field} 减一之后该报 IndexBudgetExceeded`)
    assert.equal(error.over, OVER_OF[field], `${field} 减一之后报错了条目`)
  }
  console.log(
    `① 读数：这一份语料 ${exact.blobCount} 份 blob · 源 ${exact.sourceBytes} 字节 · 工件 ${exact.artifactBytes} 字节 ·` +
      ` ${exact.gramCount} 个三字组（四条各贴边建得出来，各减一各自报出那一条）`,
  )
})

test('① 出货那一套上限的量级：四条都不是 0，也不是"永远够"', () => {
  assert.equal(INDEX_LIMITS.sourceBytes, 64 * 1024 * 1024)
  assert.equal(INDEX_LIMITS.blobs, 65_536)
  assert.equal(INDEX_LIMITS.grams, 1_000_000)
  assert.equal(INDEX_LIMITS.artifactBytes, 64 * 1024 * 1024)
})

// ── ② 越限那一条不落盘 ─────────────────────────────────────────────────────

test('② 越限那一趟不落盘：一条工件都没有，报得出来是哪一条', async () => {
  const root = tmpDir('fugue-budget-')
  const source = sourceOf(CORPUS)
  const bent = { ...INDEX_LIMITS, grams: 1 }
  const error = await rebuildIndex(root, source, bent).then(() => null, (thrown: unknown) => thrown)
  assert.ok(error instanceof IndexBudgetExceeded)
  assert.equal(error.over, 'grams')
  assert.equal(await indexExists(root), false, '建不出来就不该落盘')
  // 同一组再问一次还是同一态：这是"这一组建不出来"，不是一次随机失败。
  const again = await rebuildIndex(root, source, bent).then(() => null, (thrown: unknown) => thrown)
  assert.ok(again instanceof IndexBudgetExceeded)
  assert.equal(again.over, 'grams')
  assert.equal(await indexExists(root), false)
})

// ── ③ 算得出来的长度就是真的长度 ───────────────────────────────────────────

// ── ④ 收进来的两条账随读随判 ───────────────────────────────────────────────

test('④ 收进来的两条账随读随判：越过就停，不多读一份', async () => {
  const texts = Array.from({ length: 50 }, (_, i) => `payload ${i} ${'x'.repeat(40)}`)
  const sizes = texts.map((text) => asBytes(text).byteLength)
  let reads = 0
  const source: BlobSource = {
    ids: async () =>
      texts.map((text) => createHash('sha1').update(asBytes(text)).digest('hex')),
    read: async (id) => {
      reads += 1
      const text = texts.find((t) => createHash('sha1').update(asBytes(t)).digest('hex') === id)
      if (text === undefined) throw new Error(`这一份不在语料里：${id}`)
      return asBytes(text)
    },
  }
  // 真源字节那一关：上限刚好装得下两份，第三份越过去——**读的次数就是"随读随判"的读数**。
  const byteLimit = sizes[0] + sizes[1]
  const overBytes = await buildFrom(source, { ...INDEX_LIMITS, sourceBytes: byteLimit }).then(() => null, (e: unknown) => e)
  assert.ok(overBytes instanceof IndexBudgetExceeded)
  assert.equal(overBytes.over, 'source-bytes')
  assert.equal(reads, 3, `越过之后不该再读：读了 ${reads} 份`)
  // blob 数那一关同理：上限 2 就只读 2 份。
  reads = 0
  const overBlobs = await buildFrom(source, { ...INDEX_LIMITS, blobs: 2 }).then(() => null, (e: unknown) => e)
  assert.ok(overBlobs instanceof IndexBudgetExceeded)
  assert.equal(overBlobs.over, 'blobs')
  assert.equal(reads, 2, `越过之后不该再读：读了 ${reads} 份`)
  console.log(`④ 读数：真源字节越限读到第 ${3} 份就停 · blob 数越限读到第 2 份就停（上限 ${byteLimit} 字节 / 2 份）`)
})

test('③ encodedBytesOf 不是估的：算出来的长度与真编出来的相等', () => {
  const blobs = CORPUS.map((text) => {
    const bytes = asBytes(text)
    return { id: createHash('sha1').update(bytes).digest('hex'), bytes }
  })
  const parts = buildTrigram(blobs)
  const encoded = encodeTrigram(parts)
  assert.equal(encodedBytesOf(parts), encoded.byteLength)
  // 空的那一份也得对得上（三节都在，节体可以有空的那一节）。
  const empty = buildTrigram([])
  assert.equal(encodedBytesOf(empty), encodeTrigram(empty).byteLength)
  console.log(
    `③ 读数：算出来的 ${encodedBytesOf(parts)} 字节 = 真编出来的 ${encoded.byteLength} 字节` +
      `（字典 ${parts.grams.length} × 13 · postings 差分 varint 逐条算）`,
  )
})
