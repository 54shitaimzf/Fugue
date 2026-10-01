// 0.2.5：缓存只减少 list 调用，不改变候选顺序、边界或后续变更可见性。
import assert from 'node:assert/strict'
import test from 'node:test'
import type { DirEntry, EntryKind } from '../entries.ts'
import type { CommitId, RelPath } from '../terms.ts'
import { loadView } from '../view/view.ts'
import { createToolHost } from './host.ts'
import { createRoots } from '../roots/roots.ts'
import { createCachedWalk, createCachedWalkDetailed } from './walk.ts'

function row(name: string, kind: EntryKind = 'file'): DirEntry {
  return { name, kind, mode: kind === 'dir' ? 0o40000 : 0o100644, size: 0, id: '' }
}

function fakeView(tree: Record<string, DirEntry[]>) {
  const listed: string[] = []
  return {
    base: null as CommitId | null,
    rev: 0,
    listed,
    async list(dir: RelPath) { listed.push(dir); return tree[dir] ?? [] },
  }
}
const limits = { maxDepth: 24, maxRows: 5000 }

test('same-generation walks share traversal and return independent arrays', async () => {
  const view = fakeView({ '': [row('a'), row('d', 'dir')], d: [row('b')] })
  const walk = createCachedWalk(view, limits)
  const [first, concurrent] = await Promise.all([walk(), walk()])
  assert.deepEqual(first, ['a', 'd/b'])
  assert.deepEqual(concurrent, first)
  assert.notEqual(concurrent, first)
  ;(first as string[]).push('caller mutation')
  assert.deepEqual(await walk(), ['a', 'd/b'])
  assert.deepEqual(view.listed, ['', 'd'])
})

test('revision/base changes invalidate; independent walkers do not share state', async () => {
  const tree = { '': [row('a')] }
  const view = fakeView(tree)
  const walk = createCachedWalk(view, limits)
  assert.deepEqual(await walk(), ['a'])
  tree[''] = [row('b')]
  view.rev++
  assert.deepEqual(await walk(), ['b'])
  tree[''] = [row('c')]
  view.base = 'new-base'
  assert.deepEqual(await walk(), ['c'])
  assert.deepEqual(await createCachedWalk(view, limits)(), ['c'])
  assert.equal(view.listed.length, 4)
})

test('cached traversal preserves row order, depth/row bounds and no-follow behavior', async () => {
  const view = fakeView({
    '': [row('link', 'symlink'), row('submodule', 'gitlink'), row('d', 'dir'), row('last')],
    d: [row('first'), row('nested', 'dir'), row('second')],
    'd/nested': [row('too-deep')],
    link: [row('outside')],
  })
  const walk = createCachedWalk(view, { maxDepth: 1, maxRows: 2 })
  assert.deepEqual(await walk(), ['d/first', 'd/second'])
  assert.deepEqual(await walk(), ['d/first', 'd/second'])
  assert.deepEqual(view.listed, ['', 'd'])
  assert.deepEqual(await createCachedWalk(view, { maxDepth: 0, maxRows: 5 })(), ['last'])
})

test('failed enumeration is retried instead of poisoning a generation', async () => {
  let attempts = 0
  const view = { base: null, rev: 0, async list() {
    if (++attempts === 1) throw new Error('temporary list failure')
    return [row('recovered')]
  } }
  const walk = createCachedWalk(view, limits)
  await assert.rejects(walk(), /temporary list failure/)
  assert.deepEqual(await walk(), ['recovered'])
  assert.deepEqual(await walk(), ['recovered'])
  assert.equal(attempts, 2)
})

test('a generation changed during traversal is not reused', async () => {
  let release: () => void = () => {}
  const waiting = new Promise<void>((done) => { release = done })
  let calls = 0
  const view = { base: null, rev: 0, async list() {
    if (++calls === 1) await waiting
    return [row(`generation-${view.rev}`)]
  } }
  const walk = createCachedWalk(view, limits)
  const old = walk()
  view.rev = 1
  release()
  await old
  assert.deepEqual(await walk(), ['generation-1'])
  assert.equal(calls, 2)
})

test('late old success/failure cannot discard a newer cached generation', async () => {
  for (const fail of [false, true]) {
    let release: () => void = () => {}
    const waiting = new Promise<void>((done) => { release = done })
    let calls = 0
    const view = { base: null, rev: 0, async list() {
      if (++calls === 1) { await waiting; if (fail) throw new Error('old failure') }
      return [row(`generation-${view.rev}`)]
    } }
    const walk = createCachedWalk(view, limits)
    const old = walk()
    view.rev = 1
    assert.deepEqual(await walk(), ['generation-1'])
    release()
    if (fail) await assert.rejects(old, /old failure/)
    else await old
    assert.deepEqual(await walk(), ['generation-1'])
    assert.equal(calls, 2)
  }
})

test('actual ToolHost invalidates after write, rename, chmod, tombstone and recreation', async () => {
  const view = await loadView({ async *readByWriter() {} }, 'round', { lower: {
    base: null,
    async readBlob() { throw new Error('no lower blobs') },
    async stat() { return null },
    async read() { return null },
    async list() { return [] },
  } })
  await view.write('d/a', Buffer.from('a'))
  await view.write('d/b', Buffer.from('b'))
  let calls = 0
  const originalList = view.list.bind(view)
  view.list = async (dir) => { calls++; return originalList(dir) }
  const host = createToolHost(view, createRoots('/tmp/fugue-walk-memory-only'))
  assert.deepEqual(await host.walk(), ['d/a', 'd/b'])
  assert.deepEqual(await host.walk(), ['d/a', 'd/b'])
  assert.equal(calls, 2, 'hot walk must not enumerate directories again')
  await view.rename('d/a', 'd/c')
  assert.deepEqual(await host.walk(), ['d/b', 'd/c'])
  const beforeChmod = calls
  await view.chmod('d/c', 0o100755)
  assert.deepEqual(await host.walk(), ['d/b', 'd/c'])
  assert.ok(calls > beforeChmod)
  await view.remove('d')
  assert.deepEqual(await host.walk(), [])
  await view.write('d/new', Buffer.from('new'))
  assert.deepEqual(await host.walk(), ['d/new'])
  assert.deepEqual(await host.walk(), ['d/new'])
})


test('detailed walk distinguishes exact row limit from an unvisited file/subtree', async () => {
  for (const tail of [[], [row('link', 'symlink')], [row('submodule', 'gitlink')]]) {
    const walk = createCachedWalkDetailed(fakeView({ '': [row('a'), row('b'), ...tail] }), { maxDepth: 1, maxRows: 2 })
    assert.deepEqual(await walk(), { paths: ['a', 'b'], truncated: false, limits: [] })
  }
  for (const tail of [row('c'), row('directory', 'dir')]) {
    const walk = createCachedWalkDetailed(fakeView({ '': [row('a'), row('b'), tail] }), { maxDepth: 1, maxRows: 2 })
    assert.deepEqual(await walk(), { paths: ['a', 'b'], truncated: true, limits: ['rows'] })
  }
})

test('detailed walk reports depth and rows independently without changing the candidate prefix', async () => {
  const view = fakeView({ '': [row('deep', 'dir'), row('a'), row('b')], deep: [row('unvisited')] })
  const walk = createCachedWalkDetailed(view, { maxDepth: 0, maxRows: 1 })
  assert.deepEqual(await walk(), { paths: ['a'], truncated: true, limits: ['rows', 'depth'] })
  const cached = await walk()
  ;(cached.limits as string[]).length = 0
  ;(cached.paths as string[]).length = 0
  assert.deepEqual(await walk(), { paths: ['a'], truncated: true, limits: ['rows', 'depth'] })
})

test('ToolHost detailed and legacy reads reuse the same cached enumeration', async () => {
  const view = await loadView({ async *readByWriter() {} }, 'round', { lower: {
    base: null,
    async readBlob() { throw new Error('no lower blobs') },
    async stat() { return null }, async read() { return null }, async list() { return [] },
  } })
  await view.write('a', Buffer.from('a'))
  let calls = 0
  const list = view.list.bind(view)
  view.list = async (dir) => { calls++; return list(dir) }
  const host = createToolHost(view, createRoots('/tmp/fugue-detailed-walk-memory-only'))
  assert.deepEqual(await host.walkDetailed(), { paths: ['a'], truncated: false, limits: [] })
  assert.deepEqual(await host.walk(), ['a'])
  assert.equal(calls, 1)
})

test('production row/depth thresholds report incomplete traversal without exceeding bounds', async () => {
  const files = Array.from({ length: 5001 }, (_, i) => row(String(i)))
  const wide = await createCachedWalkDetailed(fakeView({ '': files }), limits)()
  assert.equal(wide.paths.length, 5000)
  assert.equal(wide.paths[4999], '4999')
  assert.deepEqual(wide.limits, ['rows'])
  const tree: Record<string, DirEntry[]> = {}
  let path = ''
  for (let depth = 0; depth <= 25; depth++) {
    tree[path] = [row('file'), row('next', 'dir')]
    path = path === '' ? 'next' : `${path}/next`
  }
  const deep = await createCachedWalkDetailed(fakeView(tree), limits)()
  assert.equal(deep.paths.length, 25)
  assert.deepEqual(deep.limits, ['depth'])
})
