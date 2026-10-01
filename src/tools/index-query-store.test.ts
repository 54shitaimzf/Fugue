// 当前视图 + 真 Git blobs + 私有派生索引：关闭/缺失/损坏/变更时逐字节对照。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { openTruth } from '../truth/truth.ts'
import { openLog } from '../log/log.ts'
import { loadView } from '../view/view.ts'
import { lowerAt } from '../view/lower.ts'
import { applyEdit } from '../view/edit.ts'
import { createRoots } from '../roots/roots.ts'
import { createBlobIndexLookup } from '../search/blob-index.ts'
import { createBlobIndexStore } from '../search/index-store.ts'
import { createToolHost } from './host.ts'
import { faceOf } from './execute.ts'
import type { ToolContext } from './execute.ts'
import type { AgentId, BlobId, RelPath, WriterId } from '../terms.ts'
import type { Delta } from '../delta.ts'

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue', GIT_AUTHOR_EMAIL: 'fugue@localhost', GIT_COMMITTER_NAME: 'fugue', GIT_COMMITTER_EMAIL: 'fugue@localhost' }
const writer = 'indexed-reader' as WriterId
const ctx: ToolContext = { agent: writer as AgentId, step: 0, cwd: '', holder: false }
const grep = faceOf('grep')!

async function setup() {
  const root = tmpDir('fugue-indexed-tool-')
  execFileSync('git', ['init', '-q', root], { env })
  const truth = openTruth(root)
  const log = openLog(root, { write: writer, sync: 'never' })
  const entries = []
  for (const [name, content] of [['dir/a', 'none'], ['dir/b', 'needle\nneedle\n'], ['elsewhere', 'none']]) {
    entries.push({ name, mode: 0o100644, id: await truth.putBlob(Buffer.from(content)) })
  }
  const base = await truth.commit(await truth.putTree(entries), [], 'indexed tool fixture')
  const view = await loadView(log, writer, { lower: lowerAt(truth, base) })
  const roots = createRoots(root)
  const index = createBlobIndexLookup(root, (id) => truth.getBlob(id))
  const indexed = createToolHost(view, roots, { blobIndex: index })
  const plain = createToolHost(view, roots)
  const change = (delta: Delta) => applyEdit({ view, truth, log, writer }, delta)
  const check = async (pattern = 'needle') => {
    for (const output_mode of ['content', 'count', 'files_with_matches']) {
      const args = { pattern, output_mode }
      assert.deepEqual(await grep(args, indexed, ctx), await grep(args, plain, ctx))
    }
  }
  const prepare = async () => {
    for (const path of await indexed.walk()) {
      const meta = await view.stat(path as RelPath)
      if (meta?.kind === 'file') {
        await index.mightContain(meta.id as BlobId, ['nee']); await index.drain()
      }
    }
  }
  const close = async () => { await index.close(); await log.close(); await truth.close() }
  return { root, truth, view, roots, index, indexed, plain, change, check, prepare, close }
}

test('real Truth/View indexed and scan modes agree across live upper mutations and independent hosts', async () => {
  const f = await setup()
  try {
    await f.check(); await f.index.drain(); await f.prepare(); await f.check()
    const reads: string[] = []
    const measured = { ...f.indexed, readBytes: async (path: string) => { reads.push(path); return f.indexed.readBytes(path) } }
    assert.deepEqual(await grep({ pattern: 'needle' }, measured, ctx), await grep({ pattern: 'needle' }, f.plain, ctx))
    assert.deepEqual(reads, ['dir/b'], 'validated disk/memory index must prune the nonmatching actual blobs')
    await f.change({ kind: 'modify', path: 'dir/a', bytes: Buffer.from('needle'), mode: 0o100644 }); await f.check()
    await f.change({ kind: 'add', path: 'dir/new', bytes: Buffer.from('needle'), mode: 0o100644 }); await f.check()
    await f.change({ kind: 'rename', from: 'dir/a', to: 'renamed' }); await f.check()
    await f.change({ kind: 'chmod', path: 'renamed', mode: 0o100755 }); await f.check()
    await f.change({ kind: 'delete', path: 'dir' }); await f.check()
    await f.change({ kind: 'add', path: 'dir/recreated', bytes: Buffer.from('needle'), mode: 0o100644 }); await f.check()
    await f.prepare(); await f.check('^needle$'); await f.check('nee.*le')
    await f.change({ kind: 'add', path: 'invalid-utf8', bytes: Buffer.from([0xff, 0x61, 0x62]), mode: 0o100644 })
    await f.change({ kind: 'add', path: 'emoji', bytes: Buffer.from('😀xy'), mode: 0o100644 })
    await f.prepare(); await f.check('�ab'); await f.check('😀x')
    const otherLog = openLog(f.root, { write: 'other', sync: 'never' })
    const otherView = await loadView(otherLog, 'other', { lower: lowerAt(f.truth, null) })
    // 空下层独立 View 即使共享 immutable 索引，也不能得到本 View 的路径集合。
    const other = createToolHost(otherView, f.roots, { blobIndex: f.index })
    try { assert.equal((await grep({ pattern: 'needle' }, other, ctx)).output, 'no line matches needle.') }
    finally { await otherLog.close() }
  } finally { await f.close() }
})

test('corrupt disk, disabled pending budget and source failure keep exact ordinary receipts', async () => {
  const f = await setup()
  const handles = []
  try {
    await f.prepare()
    const id = (await f.view.stat('dir/b'))!.id as BlobId
    writeFileSync(join(f.root, '.fugue/idx/v1', id.slice(0, 2), `${id}.json`), '{"torn":')
    assert.equal(await createBlobIndexStore(f.root).read(id), null)
    for (const options of [{ maxPending: 0 }, {}]) {
      const index = createBlobIndexLookup(f.root, async () => { throw new Error('optional source unavailable') }, options)
      handles.push(index)
      const host = createToolHost(f.view, f.roots, { blobIndex: index })
      assert.deepEqual(await grep({ pattern: 'needle' }, host, ctx), await grep({ pattern: 'needle' }, f.plain, ctx))
      await index.drain()
    }
  } finally { await Promise.all(handles.map(handle => handle.close())); await f.close() }
})
