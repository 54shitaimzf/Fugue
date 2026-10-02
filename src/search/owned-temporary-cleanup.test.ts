import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createBlobIndexStore, settleOwnedTemporary } from './index-store.ts'

const idOf = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
test('persistent temporary close failure still attempts the actually created leaf cleanup', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'fugue-close-cleanup-'))
  const originalOpen = fs.open, held: Array<() => Promise<void>> = []
  fs.open = async function (...args: Parameters<typeof fs.open>) {
    const file = await originalOpen.apply(this, args)
    if (String(args[0]).includes('/.tmp-')) {
      held.push(file.close.bind(file))
      file.close = async () => { throw new Error('controlled persistent close failure') }
    }
    return file
  }
  syncBuiltinESMExports()
  try {
    const bytes = Buffer.from('owned temporary cleanup'), blob = idOf(bytes)
    assert.equal((await createBlobIndexStore(root).rebuild(blob, bytes)).stored, false)
    assert.deepEqual((await fs.readdir(join(root, '.fugue/idx/v1', blob.slice(0, 2)))).filter(name => name.startsWith('.tmp-')), [])
  } finally {
    fs.open = originalOpen; syncBuiltinESMExports()
    try { await Promise.allSettled(held.map(close => Promise.resolve().then(close))) }
    finally { await fs.rm(root, { recursive: true, force: true }) }
  }
})

test('write/sync errors retain priority while synchronous close and unlink failures are both observed', async () => {
  for (const stage of ['write', 'sync']) {
    const primary = new Error(stage), calls: string[] = []
    await assert.rejects(settleOwnedTemporary({ failed: true, failure: primary },
      () => { calls.push('close'); throw new Error('close') },
      async () => { calls.push('unlink'); throw new Error('unlink') },
    ), error => error === primary)
    assert.deepEqual(calls, ['close', 'unlink'])
  }
})

test('cleanup failure retains its first cause and waits for a later held unlink attempt', async () => {
  const closeError = new Error('close'), calls: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>(done => { release = done })
  let settled = false
  const result = settleOwnedTemporary({ outcome: 'completed', failed: false },
    async () => { calls.push('close'); throw closeError },
    async () => { calls.push('unlink'); await gate; calls.push('removed'); throw new Error('unlink') },
  ).then(() => { throw new Error('expected close failure') }, error => { settled = true; assert.equal(error, closeError) })
  await new Promise<void>(done => setImmediate(done))
  assert.equal(settled, false); assert.deepEqual(calls, ['close', 'unlink'])
  release(); await result
  assert.deepEqual(calls, ['close', 'unlink', 'removed'])
})

test('exclusive-open collision never unlinks an existing foreign temporary', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'fugue-temp-owner-'))
  try {
    const bytes = Buffer.from('collision source'), blob = idOf(bytes), nonce = 'a'.repeat(24)
    const directory = join(root, '.fugue/idx/v1', blob.slice(0, 2))
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `.tmp-${process.pid}-${nonce}`)
    await fs.writeFile(path, 'another operation', { mode: 0o600 })
    assert.equal((await createBlobIndexStore(root).rebuild(blob, bytes, nonce)).stored, false)
    assert.equal(await fs.readFile(path, 'utf8'), 'another operation')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('actual write/sync failures still reach owned unlink when close also rejects', async () => {
  for (const stage of ['write', 'sync']) {
    const root = await fs.mkdtemp(join(tmpdir(), 'fugue-temp-primary-'))
    const originalOpen = fs.open, originalUnlink = fs.unlink
    const held: Array<() => Promise<void>> = [], calls: string[] = []
    fs.open = async function (...args: Parameters<typeof fs.open>) {
      const file = await originalOpen.apply(this, args)
      if (String(args[0]).includes('/.tmp-')) {
        held.push(file.close.bind(file))
        if (stage === 'write') file.writeFile = async () => { calls.push('write'); throw new Error('primary write') }
        else file.sync = async () => { calls.push('sync'); throw new Error('primary sync') }
        file.close = async () => { calls.push('close'); throw new Error('secondary close') }
      }
      return file
    }
    fs.unlink = async path => {
      if (String(path).includes('/.tmp-')) { calls.push('unlink'); throw new Error('secondary unlink') }
      await originalUnlink(path)
    }
    syncBuiltinESMExports()
    try {
      const bytes = Buffer.from('primary failure source')
      assert.equal((await createBlobIndexStore(root).rebuild(idOf(bytes), bytes)).stored, false)
      assert.deepEqual(calls, [stage, 'close', 'unlink'])
    } finally {
      fs.open = originalOpen; fs.unlink = originalUnlink; syncBuiltinESMExports()
      try { await Promise.allSettled(held.map(close => Promise.resolve().then(close))) }
      finally { await fs.rm(root, { recursive: true, force: true }) }
    }
  }
})

test('an undefined primary throw remains the primary rejection after all cleanup attempts', async () => {
  const calls: string[] = []
  await settleOwnedTemporary({ failed: true, failure: undefined },
    async () => { calls.push('close'); throw new Error('close') },
    async () => { calls.push('unlink'); throw new Error('unlink') },
  ).then(() => assert.fail('expected primary rejection'), error => assert.equal(error, undefined))
  assert.deepEqual(calls, ['close', 'unlink'])
})

test('a successful rename consumes ownership before a second publisher reuses the supplied nonce', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'fugue-temp-reuse-'))
  const bytes = Buffer.from('same nonce publishers'), blob = idOf(bytes), nonce = 'b'.repeat(24)
  const originalOpen = fs.open
  let releaseFirst: () => void = () => {}, releaseSecond: () => void = () => {}
  let firstAtSync: () => void = () => {}, secondAtWrite: () => void = () => {}
  const firstGate = new Promise<void>(done => { releaseFirst = done })
  const secondGate = new Promise<void>(done => { releaseSecond = done })
  const syncEntered = new Promise<void>(done => { firstAtSync = done })
  const writeEntered = new Promise<void>(done => { secondAtWrite = done })
  let shardSelected = false, temporaries = 0
  fs.open = async function (...args: Parameters<typeof fs.open>) {
    const file = await originalOpen.apply(this, args), path = String(args[0])
    if (!shardSelected && path.endsWith('/' + blob.slice(0, 2))) {
      shardSelected = true
      const nativeSync = file.sync.bind(file)
      file.sync = async () => { await nativeSync(); firstAtSync(); await firstGate }
    }
    if (path.includes('/.tmp-') && ++temporaries === 2) {
      const nativeWrite = file.writeFile.bind(file)
      file.writeFile = async (...values: Parameters<typeof file.writeFile>) => {
        await nativeWrite(...values); secondAtWrite(); await secondGate
      }
    }
    return file
  }
  syncBuiltinESMExports()
  let first: ReturnType<ReturnType<typeof createBlobIndexStore>['rebuild']> | undefined
  let second: typeof first
  try {
    const store = createBlobIndexStore(root)
    first = store.rebuild(blob, bytes, nonce)
    await syncEntered
    second = store.rebuild(blob, bytes, nonce)
    await writeEntered
    releaseFirst()
    assert.equal((await first).stored, true)
    releaseSecond()
    assert.equal((await second).stored, true, 'the first writer must not unlink the later writer temporary')
  } finally {
    releaseFirst(); releaseSecond()
    try { await Promise.allSettled([first, second]) }
    finally { fs.open = originalOpen; syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }) }
  }
})
