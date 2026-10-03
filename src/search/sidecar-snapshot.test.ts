import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { snapshotForSidecar } from './sidecar-snapshot.ts'
import type { View } from '../view/contract.ts'
function view(bytes: Uint8Array) {
  return { base: null, rev: 0, stat: async () => ({ kind: 'file' }), read: async () => bytes } as unknown as Pick<View, 'base' | 'rev' | 'stat' | 'read'>
}

test('private snapshot bytes come from captured View and cannot follow source physical-tree mutations', async () => {
  const bytes = Buffer.from('virtual only\n'), source = view(bytes), root = tmpDir('fugue-sidecar-snapshot-')
  const result = await snapshotForSidecar(source, ['corpus/file'], root)
  bytes.fill(0)
  assert.equal(readFileSync(join(root, 'corpus/file'), 'utf8'), 'virtual only\n')
  assert.equal(result.bytes, 13); assert.equal(result.rev, 0)
})

test('generation change during read rejects partial snapshot instead of declaring mixed state valid', async () => {
  let rev = 0
  const source = { base: null, get rev() { return rev }, stat: async () => ({ kind: 'file' }), read: async () => { rev++; return Buffer.from('new') } } as unknown as Pick<View, 'base' | 'rev' | 'stat' | 'read'>
  const root = tmpDir('fugue-sidecar-race-')
  await assert.rejects(snapshotForSidecar(source, ['corpus/file'], root), /view changed/)
  assert.ok(!existsSync(join(root, 'corpus/file')))
})

test('path/file/byte budgets reject escapes, aliases and unavailable data', async () => {
  const root = tmpDir('fugue-sidecar-bounds-')
  for (const path of ['/outside', '../outside', 'a/../outside', 'a\\outside', 'a//b']) await assert.rejects(snapshotForSidecar(view(Buffer.from('x')), [path], root), /invalid snapshot/)
  await assert.rejects(snapshotForSidecar(view(Buffer.from('x')), Array(1025).fill('a'), root), /file budget/)
  await assert.rejects(snapshotForSidecar(view(Buffer.alloc(32 * 1024 * 1024 + 1)), ['big'], root), /byte budget/)
  const missing = { ...view(Buffer.from('x')), read: async () => null }
  await assert.rejects(snapshotForSidecar(missing, ['missing'], root), /disappeared/)
  const alias = { ...view(Buffer.from('x')), stat: async () => ({ kind: 'symlink' }) } as unknown as Pick<View, 'base' | 'rev' | 'stat' | 'read'>
  await assert.rejects(snapshotForSidecar(alias, ['link'], root), /current-view files/)
})

test('snapshot root must be fresh/private and cannot already contain a redirect', async () => {
  const root = tmpDir('fugue-sidecar-owned-'), outside = tmpDir('fugue-sidecar-outside-')
  const { symlinkSync } = await import('node:fs')
  symlinkSync(outside, join(root, 'corpus'))
  await assert.rejects(snapshotForSidecar(view(Buffer.from('x')), ['corpus/file'], root), /empty private owned/)
  assert.ok(!existsSync(join(outside, 'file')))
})

test('admission captures dense numeric paths and never consumes a caller iterator', async () => {
  const root = tmpDir('fugue-sidecar-admission-')
  let reads = 0, iteratorCalls = 0
  const source = { ...view(Buffer.from('x')), read: async () => { reads++; return Buffer.from('x') } }
  await assert.rejects(snapshotForSidecar(source, Array(1), root), /invalid snapshot path/)
  assert.equal(reads, 0)
  const paths = ['one']
  paths[Symbol.iterator] = function* () { iteratorCalls++; for (let n = 0; n < 1025; n++) yield String(n) }
  const got = await snapshotForSidecar(source, paths, root)
  assert.equal(iteratorCalls, 0)
  assert.equal(reads, 1)
  assert.equal(got.files, 1)
  assert.equal(readFileSync(join(root, 'one'), 'utf8'), 'x')
})

test('pending source work cannot replace or extend the captured request list', async () => {
  const root = tmpDir('fugue-sidecar-path-mutation-'), paths = ['one', 'two'], calls: string[] = []
  const source = { ...view(Buffer.from('x')), stat: async (path: string) => {
    calls.push(path)
    paths[1] = '../escape'
    paths.push('three')
    return { kind: 'file' }
  } } as unknown as Pick<View, 'base' | 'rev' | 'stat' | 'read'>
  const got = await snapshotForSidecar(source, paths, root)
  assert.deepEqual(calls, ['one', 'two'])
  assert.equal(got.files, 2)
  assert.ok(!existsSync(join(root, 'three')))
})
