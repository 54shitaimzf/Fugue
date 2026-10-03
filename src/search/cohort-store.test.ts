import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { chmod, link, lstat, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import type { BlobId } from '../terms.ts'
import { buildBlobIndex } from './index-format.ts'
import { buildCohortIndex, cohortMightContain, encodeCohortIndex, MAX_COHORT_BLOBS, MAX_COHORT_BYTES } from './cohort-format.ts'
import { createCohortIndexStore } from './cohort-store.ts'

function fixture() {
  const root = tmpDir('fugue-cohort-store-')
  const records = ['banana\n', 'abcdef\n', '😀 next\n'].map(text => {
    const bytes = Buffer.from(text)
    const id = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    return buildBlobIndex(id, bytes)
  })
  const index = buildCohortIndex(records)
  const path = join(root, '.fugue', 'idx', 'v1', 'cohorts', `${index.key}.bin`)
  return { root, records, index, path, store: createCohortIndexStore(root) }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Scoped native hook; all owned handles retain a native closer even on injected failure. */
async function withOpenHook(run: () => Promise<void>, hook: (file: FileHandle, path: string) => void) {
  const original = fs.promises.open
  const closers: (() => Promise<void>)[] = []
  fs.promises.open = (async (...args: Parameters<typeof original>) => {
    const file = await original(...args)
    closers.push(file.close.bind(file))
    hook(file, String(args[0]))
    return file
  }) as typeof original
  syncBuiltinESMExports()
  try { await run() }
  finally {
    fs.promises.open = original
    syncBuiltinESMExports()
    await Promise.allSettled(closers.map(close => Promise.resolve().then(close)))
  }
}

test('one immutable artifact roundtrips the exact cohort; v1 leaves remain absent', async () => {
  const f = fixture()
  try {
    assert.equal(await f.store.read(f.index.blobs), null)
    assert.equal(await f.store.write(f.index), true)
    const read = await f.store.read([...f.index.blobs].reverse())
    assert.ok(read)
    assert.deepEqual(encodeCohortIndex(read), encodeCohortIndex(f.index))
    assert.equal(cohortMightContain(read, f.records[0].blob, ['ban']), true)
    assert.equal(cohortMightContain(read, f.records[1].blob, ['ban']), false)
    assert.deepEqual(await readdir(join(f.root, '.fugue', 'idx', 'v1')), ['cohorts'])
    assert.equal((await stat(f.path)).mode & 0o777, 0o600)
    assert.equal(f.store.stats().bytesRead, f.index.byteLength)
    assert.equal(await f.store.read(f.index.blobs.slice(1)), null)
  } finally { await f.store.close() }
})

test('exact maximum cohort uses one artifact and preserves every complete blob decision', async () => {
  const root = tmpDir('fugue-cohort-boundary-')
  const records = Array.from({ length: MAX_COHORT_BLOBS }, (_, ordinal) => {
    const bytes = Buffer.from(`record-${ordinal}-abc`)
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    return buildBlobIndex(blob, bytes)
  })
  const index = buildCohortIndex(records)
  const store = createCohortIndexStore(root)
  let artifactReads = 0
  try {
    assert.equal(await store.write(index), true)
    await withOpenHook(async () => {
      const read = await store.read(index.blobs)
      assert.ok(read)
      for (const record of records) {
        assert.equal(cohortMightContain(read, record.blob, ['abc']), true)
        assert.equal(cohortMightContain(read, record.blob, ['qqq']), false)
      }
    }, (_file, path) => { if (path.endsWith('.bin')) artifactReads++ })
    assert.equal(artifactReads, 1)
    assert.equal(store.stats().bytesRead, index.byteLength)
    assert.deepEqual(await readdir(join(root, '.fugue', 'idx', 'v1', 'cohorts')), [`${index.key}.bin`])
  } finally { await store.close() }
})

test('dense snapshots reject holes, duplicates, wrong IDs and budgets before any filesystem call', async () => {
  const f = fixture()
  let opens = 0
  const sparse = new Array(1) as BlobId[]
  sparse[Symbol.iterator] = function* () { yield* f.index.blobs }
  try {
    await withOpenHook(async () => {
      for (const ids of [sparse, [], ['HEAD'], [f.index.blobs[0], f.index.blobs[0]],
        new Array(MAX_COHORT_BLOBS + 1).fill(f.index.blobs[0])]) {
        assert.equal(await f.store.read(ids), null)
      }
      assert.equal(await f.store.write({ ...f.index }), false, 'unbranded handles are not persisted')
      assert.equal(await f.store.write(f.index, '../escape'), false)
      let coerced = false
      const nonce = { toString() { coerced = true; return 'a'.repeat(24) } }
      assert.equal(await f.store.write(f.index, nonce as unknown as string), false)
      assert.equal(coerced, false, 'non-string temporary names are rejected without coercion')
    }, () => { opens++ })
    assert.equal(opens, 0)
    const ids = [...f.index.blobs]
    let iteratorCalls = 0
    ids[Symbol.iterator] = function* () { iteratorCalls++; yield 'bad' }
    assert.equal(await f.store.write(f.index), true)
    assert.ok(await f.store.read(ids))
    assert.equal(iteratorCalls, 0)
  } finally { await f.store.close() }
})

test('shared groupwrite roots are compatible; private writable/readable controls and worldwrite roots refuse', async () => {
  const f = fixture()
  try {
    await chmod(f.root, 0o775)
    await mkdir(join(f.root, '.fugue'))
    await chmod(join(f.root, '.fugue'), 0o775)
    assert.equal(await f.store.write(f.index), true)
    const cohorts = join(f.root, '.fugue', 'idx', 'v1', 'cohorts')
    for (const mode of [0o750, 0o770, 0o707]) {
      await chmod(cohorts, mode)
      assert.equal(await f.store.read(f.index.blobs), null)
      assert.equal(await f.store.write(f.index), false)
    }
    await chmod(cohorts, 0o700)
    await chmod(f.path, 0o640)
    assert.equal(await f.store.read(f.index.blobs), null)
    assert.equal(await f.store.write(f.index), false)
    await chmod(f.path, 0o600)
    await chmod(f.root, 0o777)
    assert.equal(await f.store.read(f.index.blobs), null)
    assert.equal(await f.store.write(f.index), false)
  } finally { await f.store.close() }
})

test('symlink/hardlink leaves and control aliases never alter outside data', async () => {
  for (const alias of ['symlink', 'hardlink', 'ancestor']) {
    const f = fixture()
    const outside = tmpDir('fugue-cohort-outside-')
    const file = join(outside, 'file')
    await writeFile(file, 'outside')
    await chmod(file, 0o600)
    try {
      assert.equal(await f.store.write(f.index), true)
      const cohorts = join(f.root, '.fugue', 'idx', 'v1', 'cohorts')
      if (alias === 'ancestor') {
        await rename(cohorts, `${cohorts}-old`)
        await symlink(outside, cohorts)
      } else {
        await rename(f.path, `${f.path}-old`)
        if (alias === 'symlink') await symlink(file, f.path)
        else await link(file, f.path)
      }
      assert.equal(await f.store.read(f.index.blobs), null)
      assert.equal(await f.store.write(f.index), false)
      assert.equal((await readFile(file)).toString(), 'outside')
    } finally { await f.store.close() }
  }
})

test('corrupt, oversized and growing artifacts are unknown, never exclusions', async () => {
  const f = fixture()
  try {
    assert.equal(await f.store.write(f.index), true)
    await writeFile(f.path, 'corrupt')
    assert.equal(await f.store.read(f.index.blobs), null)
    await writeFile(f.path, Buffer.alloc(MAX_COHORT_BYTES + 1))
    assert.equal(await f.store.read(f.index.blobs), null)
    assert.equal(await f.store.write(f.index), true, 'owned corrupt cache is atomically replaceable without reading old bytes')
    assert.ok(await f.store.read(f.index.blobs))
    await writeFile(f.path, encodeCohortIndex(f.index))
    const entered = deferred(), release = deferred()
    await withOpenHook(async () => {
      const reading = f.store.read(f.index.blobs)
      await entered.promise
      await writeFile(f.path, Buffer.concat([Buffer.from(encodeCohortIndex(f.index)), Buffer.from([0])]))
      release.resolve()
      assert.equal(await reading, null)
    }, (file, path) => {
      if (!path.endsWith('.bin')) return
      const native = file.read.bind(file)
      let first = true
      file.read = (async (...args: Parameters<typeof native>) => {
        const result = await native(...args)
        if (first) { first = false; entered.resolve(); await release.promise }
        return result
      }) as typeof file.read
    })
  } finally { await f.store.close() }
})

test('held reads fail open on ancestor replacement or restored permission epoch', async () => {
  for (const change of ['replace', 'mode']) {
    const f = fixture()
    try {
      assert.equal(await f.store.write(f.index), true)
      const entered = deferred(), release = deferred()
      await withOpenHook(async () => {
        const reading = f.store.read(f.index.blobs)
        await entered.promise
        const idx = join(f.root, '.fugue', 'idx')
        if (change === 'replace') {
          await rename(idx, `${idx}-old`)
          await mkdir(idx, { mode: 0o700 })
        } else {
          await chmod(idx, 0o750)
          await chmod(idx, 0o700)
        }
        release.resolve()
        assert.equal(await reading, null)
      }, (file, path) => {
        if (!path.endsWith('.bin')) return
        const native = file.read.bind(file)
        let first = true
        file.read = (async (...args: Parameters<typeof native>) => {
          const result = await native(...args)
          if (first) { first = false; entered.resolve(); await release.promise }
          return result
        }) as typeof file.read
      })
    } finally { await f.store.close() }
  }
})

test('four admitted reads bound work; close observes held IO and refuses later calls', async () => {
  const f = fixture()
  assert.equal(await f.store.write(f.index), true)
  const entered = deferred(), release = deferred()
  let waiting = 0
  await withOpenHook(async () => {
    const reads = Array.from({ length: 4 }, () => f.store.read(f.index.blobs))
    await entered.promise
    assert.equal(f.store.stats().active, 4)
    assert.equal(await f.store.read(f.index.blobs), null)
    let settled = false
    const closing = f.store.close().then(() => { settled = true })
    await Promise.resolve()
    assert.equal(settled, false)
    assert.equal(await f.store.write(f.index), false)
    release.resolve()
    assert.deepEqual(await Promise.all(reads), [null, null, null, null])
    await closing
    assert.equal(f.store.stats().active, 0)
    assert.equal(await f.store.read(f.index.blobs), null)
  }, (file, path) => {
    if (!path.endsWith('.bin')) return
    const native = file.read.bind(file)
    let first = true
    file.read = (async (...args: Parameters<typeof native>) => {
      const result = await native(...args)
      if (first) { first = false; if (++waiting === 4) entered.resolve(); await release.promise }
      return result
    }) as typeof file.read
  })
})

test('reentrant close during input capture sees reserved work and performs no filesystem IO', async () => {
  const f = fixture()
  let closing: Promise<void> | undefined
  let opens = 0
  const ids = [...f.index.blobs]
  Object.defineProperty(ids, 0, { get() { closing = f.store.close(); return f.index.blobs[0] } })
  await withOpenHook(async () => {
    assert.equal(await f.store.read(ids), null)
    await closing
    assert.equal(f.store.stats().active, 0)
  }, () => { opens++ })
  assert.equal(opens, 0)
})

test('sync/async close failures are all observed and discard a completed read', async () => {
  const f = fixture()
  try {
    assert.equal(await f.store.write(f.index), true)
    let closes = 0, assigned = 0
    await withOpenHook(async () => {
      assert.equal(await f.store.read(f.index.blobs), null)
    }, file => {
      const number = assigned++
      const native = file.close.bind(file)
      file.close = () => {
        closes++
        if (number === 0) throw new Error('sync close')
        if (number === 1) return Promise.reject(new Error('async close'))
        return native()
      }
    })
    assert.equal(closes, assigned, 'no failed close may skip other owned handles')
    assert.ok(f.store.stats().closeFailures >= 2)
  } finally { await f.store.close() }
})

test('persistent own-temp close rejection still removes the known-created leaf', async () => {
  const f = fixture()
  try {
    await withOpenHook(async () => {
      assert.equal(await f.store.write(f.index), false)
    }, (file, path) => {
      if (path.includes('/.tmp-')) file.close = () => Promise.reject(new Error('persistent temp close'))
    })
    assert.deepEqual(await readdir(join(f.root, '.fugue', 'idx', 'v1', 'cohorts')), [])
    assert.ok(f.store.stats().closeFailures >= 2)
  } finally { await f.store.close() }
})

test('foreign nonce collisions and unknown old temporaries remain byte-identical', async () => {
  const f = fixture()
  const nonce = 'a'.repeat(24)
  try {
    assert.equal(await f.store.write(f.index), true)
    const path = join(f.root, '.fugue', 'idx', 'v1', 'cohorts', `.tmp-${process.pid}-${nonce}`)
    await writeFile(path, 'foreign')
    await chmod(path, 0o600)
    const before = await readFile(f.path)
    assert.equal(await f.store.write(f.index, nonce), false)
    assert.equal((await readFile(path)).toString(), 'foreign')
    assert.deepEqual(await readFile(f.path), before)
    assert.equal(await f.store.write(f.index), true)
    assert.equal((await readFile(path)).toString(), 'foreign', 'no sweeping unknown names')
  } finally { await f.store.close() }
})

test('successful rename disarms cleanup before a second same-nonce publisher creates its leaf', async () => {
  const f = fixture()
  const nonce = 'b'.repeat(24)
  const firstSync = deferred(), finishFirst = deferred(), secondWrite = deferred(), finishSecond = deferred()
  let temporaries = 0, syncs = 0
  try {
    await withOpenHook(async () => {
      const first = f.store.write(f.index, nonce)
      await firstSync.promise // first temp has already been consumed by rename
      const second = f.store.write(f.index, nonce)
      await secondWrite.promise
      finishFirst.resolve()
      assert.equal(await first, true)
      const path = join(f.root, '.fugue', 'idx', 'v1', 'cohorts', `.tmp-${process.pid}-${nonce}`)
      assert.ok((await lstat(path)).isFile(), 'first publisher must not unlink the new owner')
      finishSecond.resolve()
      assert.equal(await second, true)
    }, (file, path) => {
      if (path.endsWith('/cohorts')) {
        const native = file.sync.bind(file)
        file.sync = async () => {
          if (++syncs === 1) { firstSync.resolve(); await finishFirst.promise }
          await native()
        }
      }
      if (path.includes('/.tmp-') && ++temporaries === 2) {
        const native = file.writeFile.bind(file)
        file.writeFile = async (...args: Parameters<typeof native>) => {
          await native(...args)
          secondWrite.resolve()
          await finishSecond.promise
        }
      }
    })
    assert.deepEqual(await readdir(join(f.root, '.fugue', 'idx', 'v1', 'cohorts')), [`${f.index.key}.bin`])
  } finally { finishFirst.resolve(); finishSecond.resolve(); await f.store.close() }
})

test('write failure and replaced temporary name never delete the replacement inode', async () => {
  const f = fixture()
  const nonce = 'c'.repeat(24)
  try {
    await withOpenHook(async () => {
      assert.equal(await f.store.write(f.index, nonce), false)
    }, (file, path) => {
      if (!path.includes('/.tmp-')) return
      file.writeFile = async () => {
        const actual = join(f.root, '.fugue', 'idx', 'v1', 'cohorts', `.tmp-${process.pid}-${nonce}`)
        await rename(actual, `${actual}-old`)
        await writeFile(actual, 'replacement')
        throw new Error('injected write failure')
      }
    })
    const actual = join(f.root, '.fugue', 'idx', 'v1', 'cohorts', `.tmp-${process.pid}-${nonce}`)
    assert.equal((await readFile(actual)).toString(), 'replacement')
    assert.equal(await f.store.read(f.index.blobs), null)
  } finally { await f.store.close() }
})
