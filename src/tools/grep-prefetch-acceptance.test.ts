// tier: real —— 真实 Git/Truth/View 的完整缓存批次预取省略与权威降级。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { truthViewFixture } from '../../test/helpers/truth-view.ts'
import { createToolHost } from './host.ts'
import { createCohortIndexStore } from '../search/cohort-store.ts'
import { createViewCohortLookup } from '../search/view-cohort.ts'
import { refHeadOf } from '../round/head.ts'
import { faceOf } from './execute.ts'
import type { ToolContext, ToolHost } from './execute.ts'
import { grepVerificationStats } from './grep-verifier.ts'
import type { AgentId, BlobId } from '../terms.ts'

const grep = faceOf('grep')!, mode = 0o100644
const modes = ['content', 'count', 'files_with_matches']
type Fixture = Awaited<ReturnType<typeof truthViewFixture>>
type Target = Awaited<ReturnType<Fixture['target']>>
const context = (t: Target): ToolContext => ({ agent: t.writer as AgentId, step: 0, cwd: '', holder: false })
const stats = (host: ToolHost) => { const s = grepVerificationStats(host); assert.ok(s); return s }
function observe(f: Fixture) {
  const batches: BlobId[][] = [], original = f.truth.prefetchBlobs.bind(f.truth)
  f.truth.prefetchBlobs = async ids => { batches.push([...ids]); await original(ids) }
  return batches
}
async function hostOf(f: Fixture, t: Target, optional = true) {
  const actions = { writer: t.writer, log: t.log, truth: f.truth, head: await refHeadOf(t.log, t.writer, f.base) }
  if (!optional) return createToolHost(t.view, f.roots, { actions })
  const store = f.own(createCohortIndexStore(f.root))
  const index = f.own(createViewCohortLookup(t.view, () => t.plain.walk(), store))
  return createToolHost(t.view, f.roots, { actions, cohortIndex: index })
}
async function exact(t: Target, host: ToolHost, batches: BlobId[][], args: Record<string, unknown>) {
  batches.length = 0
  const result = await grep(args, host, context(t)), called = batches.splice(0)
  // The clone uses the same original prefetch/reader and receipts, but owns no complete-record proof.
  assert.deepEqual(result, await grep(args, { ...host }, context(t)))
  batches.length = 0
  return { result, called }
}
function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function ready(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(() => { signal.removeEventListener('abort', abort); resolve() },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

test('real complete records elide the whole original batch only on the same optional host', async () => {
  const f = await truthViewFixture({ a: 'needle\nneedle\n', alias: 'needle\nneedle\n', miss: 'quiet\n' })
  try {
    const t = await f.target('all-ready'), batches = observe(f), host = await hostOf(f, t)
    const first = await exact(t, host, batches, { pattern: 'needle', output_mode: 'count' })
    assert.equal(first.called.length, 1); assert.equal(first.called[0]!.length, 3)
    assert.equal(stats(host).entries, 2, 'three paths bind two complete immutable blob records')
    for (const output_mode of modes) {
      const before = stats(host)
      const warm = await exact(t, host, batches, { pattern: 'needle', output_mode })
      assert.deepEqual(warm.called, [], 'every original path is ready: no Truth prefetch request')
      assert.equal(stats(host).sourceReads, before.sourceReads); assert.equal(stats(host).testedLines, before.testedLines)
      if (output_mode === 'count') assert.deepEqual(warm.result, first.result)
    }
    const other = await f.target('independent-ready'), foreign = await hostOf(f, other)
    assert.notEqual(other.view, t.view); assert.equal(stats(foreign).entries, 0)
    assert.equal((await exact(other, foreign, batches, { pattern: 'needle', output_mode: 'count' })).called.length, 1)
    const plain = await hostOf(f, t, false)
    assert.equal(grepVerificationStats(plain), null)
    for (let i = 0; i < 2; i++) assert.equal((await exact(t, plain, batches, { pattern: 'needle', output_mode: 'count' })).called.length, 1)
  } finally { await f.close() }
})

test('real mixed and early-stop records preserve prefetch; replaced reader/source callbacks bypass elision', async () => {
  const f = await truthViewFixture({ a: 'needle\nneedle tail\n', b: 'needle b\n' })
  try {
    const t = await f.target('mixed-ready'), batches = observe(f), host = await hostOf(f, t)
    await exact(t, host, batches, { pattern: 'needle', path: 'a', output_mode: 'files_with_matches' })
    assert.equal(stats(host).entries, 0, 'early stop is not complete proof')
    assert.equal((await exact(t, host, batches, { pattern: 'needle', path: 'a', output_mode: 'count' })).called.length, 1)
    assert.equal(stats(host).entries, 1)
    const mixed = await exact(t, host, batches, { pattern: 'needle', output_mode: 'count' })
    assert.equal(mixed.called.length, 1); assert.equal(mixed.called[0]!.length, 2, 'do not compress mixed hits into a smaller prefetch')
    assert.deepEqual((await exact(t, host, batches, { pattern: 'needle', output_mode: 'count' })).called, [])
    const read = host.readBytes
    host.readBytes = path => read(path)
    assert.equal((await exact(t, host, batches, { pattern: 'needle', output_mode: 'count' })).called.length, 1)
    host.readBytes = read
    const prefetch = f.truth.prefetchBlobs
    f.truth.prefetchBlobs = ids => prefetch(ids)
    assert.equal((await exact(t, host, batches, { pattern: 'needle', output_mode: 'count' })).called.length, 1,
      'changed source callback no longer owns the concrete metadata prefix policy')
  } finally { await f.close() }
})

test('actual rename/chmod/whiteout and an edit during held filtering recheck generation before elision', { timeout: 15_000 }, async tc => {
  const f = await truthViewFixture({ 'dir/a': 'needle old\n', b: 'quiet\n' })
  let pending: Promise<Awaited<ReturnType<typeof grep>>> | undefined
  const gate = deferred(), entered = deferred()
  try {
    const t = await f.target('generation-ready'), batches = observe(f), host = await hostOf(f, t)
    await exact(t, host, batches, { pattern: 'needle', output_mode: 'count' })
    for (const delta of [{ kind: 'rename' as const, from: 'dir/a', to: 'dir/renamed' },
      { kind: 'chmod' as const, path: 'dir/renamed', mode: 0o100755 }]) {
      await t.change(delta)
      assert.deepEqual((await exact(t, host, batches, { pattern: 'needle', output_mode: 'count' })).called, [])
    }
    const filter = host.filterCandidates!
    host.filterCandidates = async (paths, required) => { entered.release(); await gate.promise; return filter(paths, required) }
    batches.length = 0
    pending = grep({ pattern: 'needle', output_mode: 'count' }, host, context(t))
    await ready(entered.promise, tc.signal)
    await t.change({ kind: 'modify', path: 'b', bytes: Buffer.from('needle new\n'), mode })
    gate.release()
    const changed = await pending
    assert.equal(batches.length, 1, 'held old ready proof cannot elide the current generation prefetch')
    assert.match(changed.output, /b:1/)
    host.filterCandidates = filter
    assert.deepEqual(changed, (await exact(t, host, batches, { pattern: 'needle', output_mode: 'count' })).result)
    await t.change({ kind: 'delete', path: 'dir' })
    const deleted = await exact(t, host, batches, { pattern: 'needle', output_mode: 'count' })
    assert.deepEqual(deleted.called, []); assert.doesNotMatch(deleted.result.output, /dir\//)
    await t.change({ kind: 'add', path: 'dir/reborn', bytes: Buffer.from('needle old\n'), mode })
    const reborn = await exact(t, host, batches, { pattern: 'needle', output_mode: 'count' })
    assert.deepEqual(reborn.called, []); assert.match(reborn.result.output, /dir\/reborn:1/)
  } finally { gate.release(); await pending?.catch(() => {}); await f.close() }
})
