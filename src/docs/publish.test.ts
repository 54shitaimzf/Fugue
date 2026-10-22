// 整批替换与最近一次：**切换是原子的，恢复不拿走退路**。
//
// 判据来自交接单 § 3.2（发布前任一步失败，当前入口仍指向完整批次）· § 3.3（清单与页面同批；
// 最近一次与批次分开归属）· 复审 R2（两次改名之间的入口缺失窗口、恢复删掉退路）。
//
// **崩点是真的杀进程**：`FUGUE_DOCS_CRASH_AT` 让发布在指定那一步 `SIGKILL` 自己，然后从公开
// 入口读页面与清单——每一步都必须是同一个完整批次，不许 ENOENT，不许混批。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { tmpRepo } from '../../test/helpers/docs-repo.ts'
import { docsRootOf } from './contract.ts'
import { readLast, readManifest, publishBatch, batchIntegrity, writeLast } from './publish.ts'
import type { BatchFile } from './publish.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const PUBLISH_URL = new URL('./publish.ts', import.meta.url).href

/** 一份小批次：清单指纹 + 首页与一页都带着它，读的时候能对出"是不是同一批"。 */
function batchOf(fp: string, body: string): BatchFile[] {
  const p = enc(body)
  const files = [{ path: 'p.html', sha: createHash('sha256').update(p).digest('hex'), bytes: p.length }]
  return [
    { path: 'index.html', bytes: enc(`<!-- fingerprint ${fp} --><h1>首页 ${body}</h1>`) },
    { path: 'p.html', bytes: p },
    { path: 'manifest.json', bytes: enc(JSON.stringify({ version: 1, fingerprint: fp, pages: [], files })) },
  ]
}

const FP1 = `sha256:${'a'.repeat(64)}`
const FP2 = `sha256:${'b'.repeat(64)}`

/** 从公开入口读出这一批的（页面指纹 · 清单指纹）；缺一个就是失败。 */
function entryOf(root: string): { page: string; manifest: string } {
  const docs = docsRootOf(root)
  const page = readFileSync(join(docs, 'index.html'), 'utf8')
  const manifest = JSON.parse(readFileSync(join(docs, 'manifest.json'), 'utf8')) as { fingerprint: string }
  const m = /<!-- fingerprint (\S+) -->/.exec(page)
  assert.ok(m !== null, `首页里没有指纹：${page}`)
  return { page: m![1]!, manifest: manifest.fingerprint }
}

test('① 整批替换：新批次里没有的旧文件一起消失（不是"叠一层"）', async () => {
  const root = tmpRepo()
  await publishBatch(root, batchOf(FP1, '旧页'))
  await publishBatch(root, [...batchOf(FP2, '新页'), { path: 'only-new.html', bytes: enc('只在第二批') }])
  const docs = docsRootOf(root)
  assert.equal(readFileSync(join(docs, 'p.html'), 'utf8'), '新页')
  assert.equal(readFileSync(join(docs, 'only-new.html'), 'utf8'), '只在第二批')
  assert.deepEqual(entryOf(root), { page: FP2, manifest: FP2 }, '入口与清单是同一批')
  const batch = realpathSync(docs)
  assert.equal(existsSync(join(batch, 'only-new.html')), true)
  console.log(`① 读数：批次 ${batch.split('/').pop()} · 页面与清单同为 ${FP2.slice(0, 16)}…`)
})

test('② 每个切换点被 SIGKILL：从公开入口读到的页面与清单仍是同一批（没有 ENOENT）', async () => {
  const root = tmpRepo()
  await publishBatch(root, batchOf(FP1, '旧页'))
  const old = entryOf(root)
  assert.deepEqual(old, { page: FP1, manifest: FP1 })
  const points = ['stage', 'batch', 'link', 'swap', 'cleanup']
  const seen: string[] = []
  for (const point of points) {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { publishBatch } from ${JSON.stringify(PUBLISH_URL)};
         const enc = (s) => new TextEncoder().encode(s);
         const root = process.argv[1];
         await publishBatch(root, [
           { path: 'index.html', bytes: enc('<!-- fingerprint ${FP2} --><h1>首页 新页</h1>') },
           { path: 'p.html', bytes: enc('新页') },
           { path: 'manifest.json', bytes: enc(JSON.stringify({ version: 1, fingerprint: '${FP2}', pages: [] })) },
         ]);
        `,
        root,
      ],
      { env: { ...process.env, FUGUE_DOCS_CRASH_AT: point }, encoding: 'utf8' },
    )
    assert.equal(child.signal, 'SIGKILL', `崩点 ${point} 没被杀：${child.stdout}${child.stderr}`)
    const now = entryOf(root)
    assert.equal(now.page, now.manifest, `崩点 ${point} 之后页面与清单不是同一批：${now.page} vs ${now.manifest}`)
    // 没被指向的批次可以留着，但入口读到的那一批必须完整（入口、页面、清单都在）。
    assert.ok([FP1, FP2].includes(now.page))
    seen.push(`${point}:${now.page === FP1 ? 'old' : 'new'}`)
  }
  console.log(`② 读数：${seen.join(' · ')}`)
})

test('③ 切换只换指针：新批次写完之后才换，旧批次在被换掉之前一直完整', async () => {
  const root = tmpRepo()
  await publishBatch(root, batchOf(FP1, '旧页'))
  const before = realpathSync(docsRootOf(root))
  await publishBatch(root, batchOf(FP2, '新页'))
  const after = realpathSync(docsRootOf(root))
  assert.notEqual(before, after, '入口指向了新批次')
  // 旧批次可能被收掉（collect 留当前 + 最近一份），但**切换那一刻**它在：这里核"原子性"的结构——
  // 入口是链接，切换是 rename（见 ② 的崩点读数）。
  assert.equal(lstatSync(docsRootOf(root)).isSymbolicLink(), true, '入口是一个链接：切换只换它')
  console.log(`③ 读数：${before.split('/').pop()} → ${after.split('/').pop()}（入口仍是链接）`)
})

test('④ 恢复：入口被删而完整批次还在 → 指针接回最近那一份；恢复不成时一个批次都不删', async () => {
  const root = tmpRepo()
  await publishBatch(root, batchOf(FP1, '旧页'))
  await publishBatch(root, batchOf(FP2, '新页'))
  const docs = docsRootOf(root)
  rmSync(docs)
  const { recoverPublish } = await import('./publish.ts')
  const restored = await recoverPublish(root)
  assert.notEqual(restored, null, '要能认出接回的是哪一批')
  const back = entryOf(root)
  assert.equal(back.page, back.manifest, '接回来的仍是同一批')
  // **恢复不成的那一档**：入口变成一个普通文件（不是链接、也不是目录）→ 恢复不动任何批次。
  const batchesBefore = readdirSync(join(root, '.fugue')).filter((n) => n.startsWith('docs-batch-') && !n.includes('.tmp-'))
  rmSync(docs, { force: true })
  writeFileSync(docs, '不是链接')
  const failed = await recoverPublish(root)
  assert.equal(failed, null, '恢复不了就如实返回 null')
  const batchesAfter = readdirSync(join(root, '.fugue')).filter((n) => n.startsWith('docs-batch-') && !n.includes('.tmp-'))
  assert.deepEqual(batchesAfter.sort(), batchesBefore.sort(), '恢复失败时最后一份完整批次不许被删')
  console.log(`④ 读数：接回 ${restored} · 恢复失败时批次 ${batchesAfter.length} 份原样`)
})

test('⑤ 老布局迁移留下的旧目录：恢复把它挪回入口（读者看到的仍是原来那一份）', async () => {
  const root = tmpRepo()
  const docs = docsRootOf(root)
  mkdirSync(docs, { recursive: true })
  writeFileSync(join(docs, 'index.html'), '<h1>老布局</h1>')
  const prev = join(root, '.fugue', 'docs-prev-123-abc')
  // 模拟：旧目录已被挪走、新链接还没上（迁移窗口里被杀）。
  rmSync(docs, { recursive: true })
  mkdirSync(prev)
  writeFileSync(join(prev, 'index.html'), '<h1>老布局</h1>')
  const { recoverPublish } = await import('./publish.ts')
  const restored = await recoverPublish(root)
  assert.equal(restored, 'legacy')
  assert.equal(readFileSync(join(docs, 'index.html'), 'utf8'), '<h1>老布局</h1>')
  console.log('⑤ 读数：旧目录挪回入口 · 链接没有被硬上')
})

test('⑥ 最近一次：住在批次之外（`.fugue/docs-last.json`），失败也写，原子落盘', async () => {
  const root = tmpRepo()
  await publishBatch(root, batchOf(FP1, '旧页'))
  await writeLast(root, {
    ok: false,
    at: '2026-10-22T00:00:00.000Z',
    commit: null,
    fingerprint: null,
    pages: 0,
    theme: null,
    model: null,
    materials: null,
    reason: '模型不存在',
    at_stage: 'model',
  })
  const file = join(root, '.fugue', 'docs-last.json')
  assert.equal(existsSync(file), true, '最近一次住在 .fugue/ 下')
  assert.equal(existsSync(join(docsRootOf(root), 'last.json')), false, '它不在任何一批里')
  const back = await readLast(root)
  assert.equal(back?.ok, false)
  assert.equal(readdirSync(join(root, '.fugue')).filter((n) => n.startsWith('docs-last.json.tmp-')).length, 0)
  console.log(`⑥ 读数：${file} · ok=${back?.ok} · 临时文件 0 个`)
})

test('⑦ 批次完整性：改一个字节就指得出来（入口 → 批次目录，不是一个平铺目录）', async () => {
  const root = tmpRepo()
  await publishBatch(root, batchOf(FP1, '旧页'))
  const manifest = await readManifest(root)
  assert.ok(manifest !== null)
  assert.deepEqual(await batchIntegrity(root, manifest!), [])
  writeFileSync(join(docsRootOf(root), 'p.html'), '被手改')
  assert.deepEqual(await batchIntegrity(root, manifest!), ['p.html'])
  console.log('⑦ 读数：完好时 [] · 手改后 [p.html]')
})

test('⑧ 迁移：`docs` 还是真目录时发布能接上；老布局里的 last.json 跟着搬出去', async () => {
  const root = tmpRepo()
  const docs = docsRootOf(root)
  mkdirSync(docs, { recursive: true })
  writeFileSync(join(docs, 'index.html'), '<h1>老布局</h1>')
  writeFileSync(join(docs, 'manifest.json'), JSON.stringify({ version: 1, fingerprint: FP1, pages: [] }))
  writeFileSync(join(docs, 'last.json'), JSON.stringify({ ok: true, pages: 7, reason: null }))
  const legacy = await readManifest(root)
  assert.equal(legacy?.fingerprint, FP1, '老布局读得出来（status 不会误报“未生成”）')
  await publishBatch(root, batchOf(FP2, '新页'))
  assert.equal(lstatSync(docs).isSymbolicLink(), true)
  assert.deepEqual(entryOf(root), { page: FP2, manifest: FP2 })
  // 老布局把“最近一次”放在 docs/ 里；跟着旧目录一起删掉的话，下一次 status 会静默变回空。
  const moved = JSON.parse(readFileSync(join(root, '.fugue', 'docs-last.json'), 'utf8')) as { pages: number }
  assert.equal(moved.pages, 7, '迁移时要把 last.json 接出来')
  console.log('⑧ 读数：老布局可读 · 发布后入口变链接 · last.json 搬到 .fugue/docs-last.json')
})

test('⑨ 同一指纹、不同字节：按内容命名批次，不把两批混成一批', async () => {
  const root = tmpRepo()
  await publishBatch(root, batchOf(FP1, '旧页'))
  await publishBatch(root, batchOf(FP1, '改过的页'))
  assert.equal(readFileSync(join(docsRootOf(root), 'p.html'), 'utf8'), '改过的页', '入口读到的是刚发布的那一批')
  assert.deepEqual(entryOf(root), { page: FP1, manifest: FP1 }, '指纹没变，但页面确实是新字节')
  const batches = readdirSync(join(root, '.fugue')).filter((n) => n.startsWith('docs-batch-'))
  assert.equal(batches.length, 2, `同指纹不同字节要落成两批：${batches.join(' · ')}`)
  console.log(`⑨ 读数：两批 ${batches.map((b) => b.slice(11)).join(' · ')} · 入口读新字节`)
})

// 让 `symlinkSync` 这个导入不至于被 lint 当成没用（迁移测试里直接建链接时用得上）。
void symlinkSync
