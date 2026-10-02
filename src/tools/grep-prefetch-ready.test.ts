// Pure complete-record authority and original-prefix coverage controls; no external IO.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { View } from '../view/contract.ts'
import { faceOf } from './execute.ts'
import type { ToolContext, ToolHost } from './execute.ts'
import { bindGrepVerifier, readyGrepBatch, verifiedGrepMatches, MAX_VERIFICATION_ENTRIES } from './grep-verifier.ts'
import { prefetchPlan, PREFETCH_BYTE_BUDGET } from './prefetch-plan.ts'

const ctx: ToolContext = { agent: 'reader', step: 0, cwd: '', holder: false }
const grep = faceOf('grep')!
const idOf = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function ready<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
function fixture(files: Record<string, string>, byteBound = false) {
  const values = new Map(Object.entries(files).map(([path, text]) => [path, Buffer.from(text)]))
  const ids = new Map([...values].map(([path, bytes]) => [path, idOf(bytes)]))
  const metadata: string[] = [], reads: string[] = [], batches: string[][] = [], plans: [number, number][] = []
  const view = { base: null, rev: 0, async stat(path: string) {
    metadata.push(path)
    return ids.has(path) ? { kind: 'file', id: ids.get(path)!, mode: 0o100644, size: values.get(path)!.length } : null
  } }
  const host = {
    async walkDetailed() { return { paths: [...values.keys()], truncated: false, limits: [] } },
    async readBytes(path: string) { reads.push(path); return values.has(path) ? { bytes: values.get(path)!, mode: 0o100644 } : null },
    async prefetch(paths: readonly string[]) {
      batches.push([...paths])
      if (byteBound) return prefetchPlan(await Promise.all(paths.map(path => view.stat(path)))).covered
    },
  } as ToolHost
  let sourceCurrent = true
  bindGrepVerifier(host, view as unknown as View, {
    current: () => sourceCurrent,
    covered(metas) {
      const covered = prefetchPlan(metas).covered; plans.push([metas.length, covered]); return covered
    },
  })
  return { host, view, metadata, reads, batches, plans, values, changeSource() { sourceCurrent = false }, change(path: string, text: string) {
    const bytes = Buffer.from(text); values.set(path, bytes); ids.set(path, idOf(bytes)); view.rev++
  } }
}
async function warm(f: ReturnType<typeof fixture>, path: string, re = /hit/) {
  const proof = await verifiedGrepMatches(f.host, path, re)
  assert.ok(proof)
  return [...proof.matches]
}

test('complete all-candidate proofs skip only whole warm batches with identical all-mode receipts', async () => {
  const f = fixture({ a: 'none', b: 'hit\nhit', c: 'also none' })
  assert.equal(await readyGrepBatch(f.host, ['a', 'b', 'c'], /hit/), undefined)
  assert.deepEqual(f.metadata, [], 'an empty cache adds no metadata work')
  const first = await grep({ pattern: 'hit' }, f.host, ctx)
  assert.deepEqual(f.batches, [['a', 'b', 'c']])
  f.batches.length = 0
  for (const output_mode of ['content', 'count', 'files_with_matches']) {
    const reads = f.reads.length
    const out = await grep({ pattern: 'hit', output_mode }, f.host, ctx)
    assert.deepEqual(f.batches, []); assert.equal(f.reads.length, reads)
    assert.deepEqual(out, await grep({ pattern: 'hit', output_mode }, { ...f.host }, ctx))
    f.batches.length = 0
    if (output_mode === 'content') assert.deepEqual(out, first)
  }
})

test('one uncached original path preserves filtered prefix coverage instead of translating hits', async () => {
  const f = fixture({ a: 'hit a', b: 'hit b', c: 'hit c' })
  await warm(f, 'a'); await warm(f, 'c')
  f.host.filterCandidates = async paths => paths.filter(path => path !== 'b')
  const expected = await grep({ pattern: 'hit', output_mode: 'count' }, { ...f.host }, ctx)
  f.batches.length = 0
  assert.deepEqual(await grep({ pattern: 'hit', output_mode: 'count' }, f.host, ctx), expected)
  assert.deepEqual(f.batches, [['a', 'c']], 'an uncached original path prevents elision even when filtering removes it')
})

test('partial and wrong-address records, unsupported patterns and unbound readers never prove readiness', async () => {
  const f = fixture({ a: 'hit a', b: 'hit b\nhit tail', wrong: 'correct source' })
  await warm(f, 'a')
  const partial = await verifiedGrepMatches(f.host, 'b', /hit/)
  assert.ok(partial)
  for (const _line of partial.matches) break
  f.values.set('wrong', Buffer.from('hit wrong-address'))
  await warm(f, 'wrong')
  const reads = f.reads.length
  for (const path of ['b', 'wrong', 'absent']) assert.equal(await readyGrepBatch(f.host, [path], /hit/), undefined)
  for (const re of [/hit/g, /hit/y, /other/, new (class extends RegExp {})('hit')]) {
    re.lastIndex = 3
    assert.equal(await readyGrepBatch(f.host, ['a'], re), undefined)
    assert.equal(re.lastIndex, 3)
  }
  assert.equal(await readyGrepBatch({ ...f.host }, ['a'], /hit/), undefined)
  f.host.readBytes = async () => ({ bytes: Buffer.from('replacement'), mode: 0o100644 })
  assert.equal(await readyGrepBatch(f.host, ['a'], /hit/), undefined)
  assert.equal(f.reads.length, reads, 'readiness never loads sources even when fallback is necessary')
})

test('metadata-await generation/reader changes invalidate all-hit proof and observe the pending probe', { timeout: 10_000 }, async t => {
  for (const changedReader of [false, true]) {
    const f = fixture({ a: 'hit a', b: 'hit b' })
    await warm(f, 'a'); await warm(f, 'b')
    const gate = deferred(), entered = deferred(), stat = f.view.stat
    f.view.stat = async path => { entered.release(); await gate.promise; return stat(path) }
    const pending = readyGrepBatch(f.host, ['a', 'b'], /hit/)
    try {
      await ready(Promise.race([entered.promise, pending.then(() => { assert.fail('readiness completed without the held probe') })]), t.signal)
      if (changedReader) f.host.readBytes = async () => ({ bytes: Buffer.from('replacement'), mode: 0o100644 })
      else f.change('b', 'new hit')
      gate.release(); assert.equal(await pending, undefined)
    } finally { gate.release(); await pending.catch(() => {}) }
  }
})

test('an all-hit proof rechecks generation and reader immediately after candidate-filter awaits', async () => {
  for (const changedReader of [false, true]) {
    const f = fixture({ a: 'hit a', b: 'hit b' })
    await warm(f, 'a'); await warm(f, 'b')
    f.host.filterCandidates = async paths => {
      if (changedReader) f.host.readBytes = async path => ({ bytes: Buffer.from(`hit replacement ${path}`), mode: 0o100644 })
      else f.change('b', 'hit newly matching content')
      return paths
    }
    const result = await grep({ pattern: 'hit' }, f.host, ctx)
    assert.deepEqual(f.batches, [['a', 'b']])
    assert.match(result.output, changedReader ? /replacement b/ : /newly matching content/)
  }
})

test('cache eviction expires an admitted all-hit proof before the prefetch decision', async () => {
  const f = fixture({ a: 'hit' })
  await warm(f, 'a')
  const proof = await readyGrepBatch(f.host, ['a'], /hit/)
  assert.ok(proof?.current())
  f.host.filterCandidates = async paths => {
    for (let at = 0; at < MAX_VERIFICATION_ENTRIES; at++) await warm(f, 'a', new RegExp(`missing-${at}`))
    assert.equal(proof.current(), false)
    assert.equal(await readyGrepBatch(f.host, ['a'], /hit/), undefined)
    return paths
  }
  await grep({ pattern: 'hit' }, f.host, ctx)
  assert.deepEqual(f.batches, [['a']])
})

test('readiness owns one dense bounded path snapshot without custom iterators or repeated length reads', { timeout: 10_000 }, async t => {
  const f = fixture({ a: 'hit a', b: 'hit b' })
  await warm(f, 'a'); await warm(f, 'b'); f.metadata.length = 0
  let lengths = 0, indexed = 0
  const paths = new Proxy(['a'], { get(target, key, receiver) {
    if (key === 'length') return ++lengths === 1 ? 1 : 10_000
    if (key === '0') indexed++
    if (key === Symbol.iterator) assert.fail('path iterator consumed')
    return Reflect.get(target, key, receiver)
  } })
  assert.ok((await readyGrepBatch(f.host, paths, /hit/))?.current())
  assert.equal(lengths, 1); assert.equal(indexed, 1)
  f.metadata.length = 0
  for (const input of [new Array(1), new Array(129).fill('a')]) assert.equal(await readyGrepBatch(f.host, input, /hit/), undefined)
  assert.deepEqual(f.metadata, [])
  const inherited = new Array(1)
  Object.setPrototypeOf(inherited, { 0: 'a' })
  assert.equal(await readyGrepBatch(f.host, inherited, /hit/), undefined)
  assert.deepEqual(f.metadata, [], 'prototype values do not fill sparse input admission')
  assert.ok((await readyGrepBatch(f.host, new Array(128).fill('a'), /hit/))?.current())
  const original = ['a', 'b'], gate = deferred(), entered = deferred(), stat = f.view.stat
  let first = true
  f.view.stat = async path => { if (first) { first = false; entered.release(); await gate.promise } return stat(path) }
  const pending = readyGrepBatch(f.host, original, /hit/)
  try {
    await ready(Promise.race([entered.promise, pending.then(() => { assert.fail('readiness completed before the first metadata callback') })]), t.signal)
    original.splice(0, original.length, 'unknown')
    gate.release(); assert.ok((await pending)?.current())
    assert.deepEqual(f.metadata.slice(-2), ['a', 'b'])
  } finally { gate.release(); await pending.catch(() => {}) }
})

test('all-hit 128-candidate batches retain the concrete 4 MiB prefix boundaries and receipts', async () => {
  const files = Object.fromEntries(Array.from({ length: 160 }, (_, at) => {
    const head = `none-${at}-`
    return [`f${at}`, head + 'x'.repeat(72 * 1024 - head.length)]
  }))
  const f = fixture(files, true)
  const cold = await grep({ pattern: 'hit', output_mode: 'count' }, f.host, ctx)
  assert.deepEqual(f.batches.map(paths => paths.length), [32, 128, 72, 16])
  f.batches.length = 0; f.plans.length = 0
  const reads = f.reads.length
  assert.deepEqual(await grep({ pattern: 'hit', output_mode: 'count' }, f.host, ctx), cold)
  assert.deepEqual(f.batches, []); assert.equal(f.reads.length, reads)
  assert.deepEqual(f.plans, [[32, 32], [128, 56], [72, 56], [16, 16]])
  assert.equal(Math.floor(PREFETCH_BYTE_BUDGET / (72 * 1024)), 56)
  assert.deepEqual(await grep({ pattern: 'hit', output_mode: 'count' }, { ...f.host }, ctx), cold)
  assert.deepEqual(f.batches.map(paths => paths.length), [32, 128, 72, 16])
})

test('proof prefix planning refuses injection/reordering and replaced prefetch callbacks', async () => {
  const f = fixture({ a: 'hit a', b: 'hit b', c: 'hit c' })
  await warm(f, 'a'); await warm(f, 'b'); await warm(f, 'c')
  const proof = await readyGrepBatch(f.host, ['a', 'b', 'c'], /hit/)
  assert.ok(proof)
  assert.equal(proof.covered(['a', 'c']), 2)
  for (const selected of [['c', 'a'], ['a', 'injected'], ['a', 'a']]) assert.equal(proof.covered(selected), undefined)
  const old = f.host.prefetch!
  f.host.prefetch = paths => old(paths)
  assert.equal(proof.current(), false); assert.equal(proof.covered(['a', 'b']), undefined)
  await grep({ pattern: 'hit' }, f.host, ctx)
  assert.deepEqual(f.batches, [['a', 'b', 'c']])
  const changedSource = fixture({ a: 'hit' })
  await warm(changedSource, 'a')
  const prior = await readyGrepBatch(changedSource.host, ['a'], /hit/)
  assert.ok(prior?.current())
  changedSource.changeSource()
  assert.equal(prior.current(), false)
  assert.equal(prior.covered(['a']), undefined)
  await grep({ pattern: 'hit' }, changedSource.host, ctx)
  assert.deepEqual(changedSource.batches, [['a']])
})
