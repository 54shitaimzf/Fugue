// tier: real —— 真实 Truth 对象、M2 字节所有权与 held Lower.putBlob 的一致性。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { truthViewFixture } from '../../test/helpers/truth-view.ts'
import { lowerAt } from '../view/lower.ts'
import { loadView } from '../view/view.ts'
import { createToolHost } from './host.ts'
import { faceOf } from './execute.ts'
import type { ToolContext } from './execute.ts'
import type { AgentId, BlobId, RelPath } from '../terms.ts'
import type { View } from '../view/contract.ts'

type Fixture = Awaited<ReturnType<typeof truthViewFixture>>
const grep = faceOf('grep')!
const expected = Buffer.from('first\n'), other = Buffer.from('other\n')
function ready<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
async function consistent(f: Fixture, view: View, path: RelPath) {
  const meta = await view.stat(path)
  assert.equal(meta?.kind, 'file')
  const current = await view.read(path)
  assert.deepEqual(Buffer.from(current!), expected, 'the View owns the admitted first bytes')
  assert.deepEqual(Buffer.from(await f.truth.getBlob(meta!.id as BlobId)), expected,
    'the retained immutable ID and View byte snapshot address identical actual Git content')
  const ctx: ToolContext = { agent: view.id as AgentId, step: 0, cwd: '', holder: false }
  const host = createToolHost(view, f.roots)
  // The maintained optional pipeline is reached only after the actual Git/byte
  // binding assertions; the official ba4 failure-first stops above this point.
  const { createCohortIndexStore } = await import('../search/cohort-store.ts')
  const { createViewCohortLookup } = await import('../search/view-cohort.ts')
  const store = f.own(createCohortIndexStore(f.root))
  const index = f.own(createViewCohortLookup(view, () => host.walk(), store))
  assert.equal(await index.prepare(blob => f.truth.getBlob(blob)), true)
  const optioned = createToolHost(view, f.roots, { cohortIndex: index })
  for (const output_mode of ['content', 'count', 'files_with_matches']) {
    const result = await grep({ pattern: 'first', path, output_mode }, host, ctx)
    assert.deepEqual(result, await grep({ pattern: 'first', path, output_mode }, { ...host }, ctx))
    assert.deepEqual(await grep({ pattern: 'first', path, output_mode }, optioned, ctx), result,
      'actual immutable cohort and complete regex proof preserve the original admitted bytes')
    assert.match(result.output, new RegExp(path))
  }
}

test('actual Truth held putBlob cannot separate Entry bytes, immutable ID and recorded delta after caller mutation', { timeout: 15_000 }, async testContext => {
  const f = await truthViewFixture({})
  let release!: () => void, enter!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { enter = resolve })
  let pending: Promise<unknown> | undefined
  try {
    const t = await f.target('held-source'), lower = lowerAt(f.truth, f.base), put = lower.putBlob.bind(lower)
    let hold = true
    lower.putBlob = async bytes => {
      if (hold) { hold = false; enter(); await gate }
      return put(bytes)
    }
    const view = await loadView(t.log, t.writer, { lower }), input = new Uint8Array(expected)
    pending = view.write('a', input)
    try { await ready(entered, testContext.signal); input.set(other) }
    finally { release() }
    await pending
    await consistent(f, view, 'a')
    const delta = view.diff().find(item => item.kind === 'add')
    assert.equal(delta?.kind, 'add')
    if (delta?.kind === 'add') assert.deepEqual(Buffer.from(delta.bytes), expected, 'recorded history owns the same admitted snapshot')
  } finally { release(); await pending?.catch(() => {}); await f.close() }
})

test('Buffer input mutation after write cannot change admitted View bytes, immutable ID or revision', async () => {
  const f = await truthViewFixture({})
  try {
    const t = await f.target('buffer-input'), input = Buffer.from(expected)
    await t.view.write('a', input)
    const rev = t.view.rev, id = (await t.view.stat('a'))!.id
    input.set(other)
    assert.equal(t.view.rev, rev); assert.equal((await t.view.stat('a'))!.id, id)
    await consistent(f, t.view, 'a')
    const delta = t.view.diff().find(item => item.kind === 'add')
    assert.equal(delta?.kind, 'add')
    if (delta?.kind === 'add') delta.bytes.set(other)
    const fresh = t.view.diff().find(item => item.kind === 'add')
    assert.equal(fresh?.kind, 'add')
    if (fresh?.kind === 'add') assert.deepEqual(Buffer.from(fresh.bytes), expected, 'returned diff bytes cannot mutate stored history')
    assert.deepEqual(Buffer.from((await t.view.read('a'))!), expected, 'returned history cannot mutate Entry bytes')
  } finally { await f.close() }
})

test('Buffer lower copy-up and returned read mutation cannot change owned View bytes or retained identity', async () => {
  const f = await truthViewFixture({ a: expected })
  try {
    const t = await f.target('buffer-read'), lower = lowerAt(f.truth, f.base), read = lower.read.bind(lower)
    lower.read = async path => { const bytes = await read(path); return bytes === null ? null : Buffer.from(bytes) }
    const view = await loadView(t.log, t.writer, { lower })
    await view.rename('a', 'renamed')
    const rev = view.rev, id = (await view.stat('renamed'))!.id
    const returned = await view.read('renamed')
    assert.notEqual(returned, null); returned!.set(other)
    assert.equal(view.rev, rev); assert.equal((await view.stat('renamed'))!.id, id)
    await consistent(f, view, 'renamed')
  } finally { await f.close() }
})
