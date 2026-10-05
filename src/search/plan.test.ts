// 查询接线那一半的断言②：**派发**——这一问要不要走索引、走的时候只看哪几条路径。
// 跑法：cd ~/fugue && node --test src/search/plan.test.ts
//
// 语料是**纯内存**的（索引那一层只要求同宽的小写十六进制 id，这里用真的内容哈希，于是"同内容
// 多路径共一个 id"这条内容寻址的性质也进得来），所以这一份量的是判决本身，不掺真源的 I/O；
// 真装配那一趟（`host` + `execute` 的接线）在 `query.test.ts`。
//
//   ① 稀疏：走索引，交出来的路径**只有**那几条含这个三字组的
//   ② miss：一条都不含 → 空路径集（这一档省得最多：一份文件都不用读）
//   ③ 覆盖：盘上那一份罩不住视图 → 回扫描（**少了就是漏报**，这是这一层唯一不能犯的错）
//   ④ 覆盖的另一个方向：盘上那一份比视图大（视图少了几份）→ 照样能走（多余的条目只是不命中）
//   ⑤ 密集与两档折扣：同一份候选，早停那两档回扫描、计数那一档走索引（折扣就是这两档的差）
//   ⑥ 地板四态：缺席 · 损坏 · 没接线（手搓清单）· 短查询 → 一律 `paths: null`（回扫描）
//   ⑦ 固定开销那一关：工件整份比全扫还贵 → 连读都不读（本仓那种"字典与语料一样大"的形状）
//   ⑧ 进程内那一份值：同一份工件连问两次答案相同；盘上换了一份就重读（认账的键是 size:mtime）
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, rmSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPlanner } from './plan.ts'
import type { PlanAsk, PlanReading, SearchPlan, ViewRows } from './plan.ts'
import { idxFileOf, rebuildIndex } from '../index/store.ts'
import type { BlobSource } from '../index/store.ts'
import type { BlobId } from '../terms.ts'

/** 一份纯内存的语料：路径 · 文本 · id（id 是真的内容哈希——同一份内容在几条路径上共一个 id）。 */
interface Doc {
  readonly path: string
  readonly text: string
  readonly id: string
}

const hashOf = (text: string): string => createHash('sha1').update(text, 'utf8').digest('hex')

/** 窄字母表：8 个符号来回排（三字组的种类有上限，工件于是很小），外加每份一段自己的标记。 */
function narrow(n: number, size: number, marker: (i: number) => string | null): Doc[] {
  const alphabet = 'abcdefgh'
  const out: Doc[] = []
  for (let i = 0; i < n; i++) {
    let text = ''
    for (let at = 0; at < size; at++) text += alphabet[at % alphabet.length] as string
    const mark = marker(i)
    if (mark !== null) text += mark
    out.push({ path: `f${String(i).padStart(3, '0')}.txt`, text, id: hashOf(text) })
  }
  return out
}

/** 视图那一份名单：**走树那份清单里本来就有这两栏**，测试里直接按语料给。 */
function rowsOfDocs(docs: readonly Doc[]): ViewRows {
  const ids = new Map<string, BlobId>()
  const sizes = new Map<string, number>()
  for (const d of docs) {
    ids.set(d.path, d.id as BlobId)
    sizes.set(d.path, Buffer.byteLength(d.text, 'utf8'))
  }
  return { ids, sizes }
}

/** 把这份语料建成索引，落在临时根上。返回根与它的字节数。 */
async function build(docs: readonly Doc[]): Promise<{ root: string; bytes: number }> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-plan-'))
  const bodies = new Map<string, Uint8Array>()
  for (const d of docs) bodies.set(d.id, new Uint8Array(Buffer.from(d.text, 'utf8')))
  const source: BlobSource = {
    ids: async () => docs.map((d) => d.id as BlobId),
    read: async (id) => bodies.get(id) as Uint8Array,
  }
  const built = await rebuildIndex(root, source)
  assert.equal(built.wrote, true, '索引没落盘——这一条对照是空话')
  return { root, bytes: built.build.artifactBytes }
}

function askOf(pattern: string, docs: readonly Doc[], earlyStop = true): PlanAsk {
  return { pattern, walked: docs.map((d) => d.path), targets: docs.map((d) => d.path), earlyStop }
}

/** planner 的 `rowsOf` 是"按那份清单查两栏"——测试里清单就是 `docs`，查表忽略入参。 */
function plannerFor(root: string, docs: readonly Doc[]) {
  const rows = rowsOfDocs(docs)
  return createPlanner({ root, rowsOf: () => rows })
}

async function planOf(root: string, docs: readonly Doc[], pattern: string, earlyStop = true): Promise<SearchPlan> {
  return await plannerFor(root, docs)(askOf(pattern, docs, earlyStop))
}

function pathsOf(plan: SearchPlan): string[] {
  return [...(plan.paths ?? new Set<string>())].sort()
}

function show(reading: PlanReading): string {
  return `工件 ${reading.artifactBytes} · 全扫 ${reading.scanBytes} · 候选 ${reading.candidateBytes} 字节 · 视图 blob ${reading.viewBlobs} · 最稀的那一条在 ${reading.gramCount} 份里`
}

// ── ① 稀疏 ───────────────────────────────────────────────────────────────────

test('① 稀疏：走索引，交出来的只有含那一条三字组的路径', async () => {
  const docs = narrow(40, 8 * 1024, (i) => (i === 3 || i === 17 ? 'zzz' : null))
  const { root, bytes } = await build(docs)
  try {
    const plan = await planOf(root, docs, 'zzz')
    assert.equal(plan.why, 'candidates')
    assert.deepEqual(pathsOf(plan), ['f003.txt', 'f017.txt'])
    // 带标记的那两份内容相同 → 一个 blob（内容寻址）：所以是 40 条路径 · 2 个 blob，
    // 而那一条三字组只出现在**一个** blob 里。
    assert.equal(plan.reading.gramCount, 1)
    assert.equal(plan.reading.artifactBytes, bytes)
    assert.equal(plan.reading.viewBlobs, 2)
    assert.ok(plan.reading.candidateBytes < plan.reading.scanBytes / 10, '候选那些字节没比全扫少一个量级——这一档不该走索引')
    for (const p of plan.paths ?? []) assert.ok(docs.some((d) => d.path === p), '交出来一条不在这一趟清单里的路径')
    console.log(`① 读数：${show(plan.reading)} · 路径 ${pathsOf(plan).length}/${docs.length}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ② miss ──────────────────────────────────────────────────────────────────

test('② miss：一条都不含 → 空路径集（一份文件都不用读）', async () => {
  const docs = narrow(40, 8 * 1024, () => null)
  const { root } = await build(docs)
  try {
    const plan = await planOf(root, docs, 'qqq')
    assert.equal(plan.why, 'candidates')
    assert.equal(pathsOf(plan).length, 0)
    assert.equal(plan.reading.gramCount, 0)
    assert.equal(plan.reading.candidateBytes, 0)
    console.log(`② 读数：这一条三字组在 0 份里 → 路径 0 条（${show(plan.reading)}）`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ③④ 覆盖 ────────────────────────────────────────────────────────────────

test('③ 覆盖：盘上那一份罩不住视图 → 回扫描（少了就是漏报）', async () => {
  // 最后那一份的内容是独一份的（索引建的时候还不存在它）：它在索引里没有 postings。
  const docs = narrow(40, 8 * 1024, (i) => (i === 39 ? 'www' : null))
  const { root } = await build(docs.slice(0, 39))
  try {
    const plan = await planOf(root, docs, 'abcdefg')
    assert.equal(plan.why, 'view-uncovered')
    assert.equal(plan.paths, null)
    assert.equal(plan.reading.viewBlobs, 2)
    console.log(`③ 读数：视图里一个 blob 不在盘上那一份的名单里 → paths: null（${show(plan.reading)}）`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('④ 覆盖的另一个方向：盘上那一份比视图大 → 照样能走', async () => {
  const built = narrow(40, 8 * 1024, (i) => (i === 5 ? 'zzz' : null))
  const { root } = await build(built)
  try {
    const plan = await planOf(root, built.slice(0, 20), 'zzz')
    assert.equal(plan.why, 'candidates')
    assert.deepEqual(pathsOf(plan), ['f005.txt'])
    console.log('④ 读数：视图 20 份 / 盘上 40 份 → candidates（大是安全的：多余的顺序号只是不命中）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ⑤ 密集与两档折扣 ────────────────────────────────────────────────────────

test('⑤ 密集与两档折扣：早停那两档回扫描 · 计数那一档走索引', async () => {
  // 每 5 份里有 2 份带标记（候选占四成）：早停那一档该让给扫描，计数那一档（要读完）该走索引。
  const docs = narrow(40, 8 * 1024, (i) => (i % 5 < 2 ? 'zzz' : null))
  const { root } = await build(docs)
  try {
    const early = await planOf(root, docs, 'zzz', true)
    const full = await planOf(root, docs, 'zzz', false)
    assert.equal(early.why, 'candidates-dense')
    assert.equal(early.paths, null)
    assert.equal(full.why, 'candidates')
    assert.equal(pathsOf(full).length, 16)
    // 密集那一趟不许把候选当答案：它交回的是"回扫描"，不是一份缩小过的路径集。
    assert.equal(early.reading.candidateBytes, full.reading.candidateBytes)
    console.log(`⑤ 读数：${show(full.reading)} · 早停档 → ${early.why} · 计数档 → ${full.why}（${pathsOf(full).length} 条路径）`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ⑥ 地板四态 ──────────────────────────────────────────────────────────────

test('⑥ 地板：缺席 · 损坏 · 没接线 · 短查询 → 一律回扫描', async () => {
  const docs = narrow(8, 1024, (i) => (i === 0 ? 'zzz' : null))
  const where = mkdtempSync(join(tmpdir(), 'fugue-plan-empty-'))
  try {
    const absent = await planOf(where, docs, 'zzz')
    assert.equal(absent.why, 'artifact-absent')
    assert.equal(absent.paths, null)

    // 手搓清单（没有 id/size）：不接线。
    const bare = await createPlanner({ root: where, rowsOf: () => null })(askOf('zzz', docs))
    assert.equal(bare.why, 'no-rows')
    assert.equal(bare.paths, null)
  } finally {
    rmSync(where, { recursive: true, force: true })
  }

  const { root } = await build(docs)
  try {
    // 单汉字与两字：键空间里没有它们那一条（0.3.1 口径二），抽不出三字组。
    for (const short of ['zz', 'z', '导', '导出']) {
      const plan = await planOf(root, docs, short)
      assert.equal(plan.why, 'no-grams', `${JSON.stringify(short)} 该走扫描`)
      assert.equal(plan.paths, null)
    }
    // 损坏：把工件截短（版本/节表读不回来）→ 当缺席。
    truncateSync(idxFileOf(root), 30)
    const broken = await planOf(root, docs, 'zzz')
    assert.equal(broken.why, 'artifact-absent')
    assert.equal(broken.paths, null)
    console.log('⑥ 读数：缺席 · 手搓清单 · 单汉字 · 两字 · 截短的工件 —— 五态都回扫描（paths: null）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ⑦ 固定开销那一关 ────────────────────────────────────────────────────────

test('⑦ 工件整份比全扫还贵：连读都不读（本仓那种形状）', async () => {
  // 语料小到工件本身（头部 + 节表 + 三节）就比这些文件加起来还大。
  const docs = narrow(4, 64, (i) => (i === 0 ? 'zzz' : null))
  const { root, bytes } = await build(docs)
  try {
    const plan = await planOf(root, docs, 'zzz')
    assert.equal(plan.why, 'artifact-heavy')
    assert.equal(plan.paths, null)
    assert.ok(bytes * 4 >= plan.reading.scanBytes, '这一档没有真的"贵"——这一条对照是空话')
    console.log(`⑦ 读数：${show(plan.reading)} → artifact-heavy（连工件都不读）`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ⑧ 进程内那一份值 ────────────────────────────────────────────────────────

test('⑧ 同一份工件连问两次答案相同；盘上换了一份就重读', async () => {
  const docs = narrow(40, 8 * 1024, (i) => (i === 3 ? 'zzz' : null))
  const { root } = await build(docs)
  const other = narrow(40, 8 * 1024, (i) => (i === 3 ? 'www' : null))
  const spare = await build(other)
  try {
    // 视图也跟着换（换的是盘上那一份，不是这一份清单的读法）：同一个 planner 实例连着问。
    let current = docs
    const planner = createPlanner({ root, rowsOf: () => rowsOfDocs(current) })
    const first = await planner(askOf('zzz', docs))
    const again = await planner(askOf('zzz', docs))
    assert.deepEqual(pathsOf(first), ['f003.txt'])
    assert.deepEqual(pathsOf(again), ['f003.txt'])
    // 盘上那一份换掉（同一组路径 · 不同的 blob 集 → 工件字节不同），认账的键跟着变。
    copyFileSync(idxFileOf(spare.root), idxFileOf(root))
    current = other
    const after = await planner(askOf('www', other))
    assert.equal(after.why, 'candidates')
    assert.deepEqual(pathsOf(after), ['f003.txt'])
    console.log('⑧ 读数：同问两次 → 同一份答案；工件换了一份（size/mtime 变）→ 读的是新的那一份')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(spare.root, { recursive: true, force: true })
  }
})
