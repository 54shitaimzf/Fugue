// Filesystem-only fence lifetime/root controls; each test owns all generated roots.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { holdWriter, lockFileOf, LogHeldError } from './hold.ts'
import { openLog, logFileOf } from './log.ts'
import type { Hold } from './hold.ts'
import type { LogEvent } from './events.ts'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

function roots() {
  const parent = tmpDir('fugue-hold-owner-'), a = join(parent, 'a'), b = join(parent, 'b')
  for (const dir of [a, b]) mkdirSync(join(dir, 'repo'), { recursive: true })
  return { a, b, repoA: join(a, 'repo'), repoB: join(b, 'repo') }
}

test('relative Hold release stays at its constructor root after cwd changes', () => {
  const f = roots(), cwd = process.cwd(); let first: Hold | undefined, second: Hold | undefined
  try {
    process.chdir(f.a); first = holdWriter('repo', 'round')
    process.chdir(f.b); second = holdWriter('repo', 'round')
    const otherBytes = readFileSync(lockFileOf(f.repoB, 'round'))
    first.release()
    assert.equal(existsSync(lockFileOf(f.repoA, 'round')), false)
    assert.deepEqual(readFileSync(lockFileOf(f.repoB, 'round')), otherBytes)
    assert.throws(() => holdWriter(f.repoB, 'round'), LogHeldError)
  } finally {
    process.chdir(f.a); first?.release(); process.chdir(f.b); second?.release(); process.chdir(cwd)
  }
})

test('old repeated release cannot remove a reacquired same-process writer fence', () => {
  const f = roots(), first = holdWriter(f.repoA, 'round'); let next: Hold | undefined
  try {
    first.release(); next = holdWriter(f.repoA, 'round')
    const current = readFileSync(next.path)
    first.release(); first.release()
    assert.deepEqual(readFileSync(next.path), current)
    assert.throws(() => holdWriter(f.repoA, 'round'), LogHeldError)
  } finally { next?.release(); first.release() }
})

test('same-process replacement inode is not owned by an unreleased older Hold', () => {
  const f = roots(), first = holdWriter(f.repoA, 'round'); let replacement: Hold | undefined
  try {
    // Only this generated fixture simulates removal/reacquisition beneath an older object.
    unlinkSync(first.path); replacement = holdWriter(f.repoA, 'round')
    const current = readFileSync(replacement.path)
    first.release()
    assert.deepEqual(readFileSync(replacement.path), current)
    assert.throws(() => holdWriter(f.repoA, 'round'), LogHeldError)
  } finally { replacement?.release(); first.release() }
})

test('relative Log read/write/close stay in one root and preserve another root fence', async () => {
  const f = roots(), cwd = process.cwd(); let log: ReturnType<typeof openLog> | undefined, other: Hold | undefined
  try {
    process.chdir(f.a); log = openLog('repo', { write: 'round', sync: 'never' })
    process.chdir(f.b); other = holdWriter('repo', 'round')
    const foreign = readFileSync(other.path)
    const event = { t: 'view/remove', agent: 'round', path: 'a', rev: 1 } as LogEvent
    assert.equal(await log.append('round', event), 1)
    assert.equal(existsSync(logFileOf(f.repoB, 'round')), false)
    const seen: LogEvent[] = []; for await (const row of log.readByWriter('round')) seen.push(row)
    assert.deepEqual(seen, [event])
    await log.close(); await log.close()
    assert.equal(existsSync(lockFileOf(f.repoA, 'round')), false)
    assert.deepEqual(readFileSync(other.path), foreign)
    assert.throws(() => holdWriter(f.repoB, 'round'), LogHeldError)
  } finally {
    process.chdir(f.a); await log?.close(); process.chdir(f.b); other?.release(); process.chdir(cwd)
  }
})

test('acquired and refused holder pins retire exactly once, preserving primary refusal', () => {
  const originalOpen = fs.openSync, originalClose = fs.closeSync
  const active = new Set<number>(), closed: number[] = []
  const f = roots(); let hold: Hold | undefined
  fs.openSync = ((...args: Parameters<typeof originalOpen>) => {
    const fd = originalOpen(...args)
    if (String(args[0]).endsWith(`.tmp-${process.pid}`) && args[1] === 'r') active.add(fd)
    return fd
  }) as typeof originalOpen
  fs.closeSync = ((fd: number) => {
    if (active.delete(fd)) closed.push(fd)
    return originalClose(fd)
  }) as typeof originalClose
  syncBuiltinESMExports()
  try {
    hold = holdWriter(f.repoA, 'round')
    assert.equal(active.size, 1)
    assert.throws(() => holdWriter(f.repoA, 'round'), LogHeldError)
    assert.equal(active.size, 1); assert.equal(closed.length, 1, 'refused constructor retires its pin')
    hold.release(); hold.release()
    assert.equal(active.size, 0); assert.equal(closed.length, 2)
    hold = holdWriter(f.repoA, 'round')
    writeFileSync(hold.path, 'unknown generated record\n')
    hold.release(); hold.release()
    assert.equal(active.size, 0, 'unknown-record refusal still retires the private pin')
    assert.equal(closed.length, 3)
    assert.equal(readFileSync(hold.path, 'utf8'), 'unknown generated record\n')
    unlinkSync(hold.path) // Explicit fixture cleanup; the product preserved the unknown name.
    // A secondary pin-close report must not replace the actual acquisition refusal.
    hold = holdWriter(f.repoA, 'round')
    fs.closeSync = ((fd: number) => {
      if (active.delete(fd)) { closed.push(fd); originalClose(fd); throw new Error('secondary close control') }
      return originalClose(fd)
    }) as typeof originalClose
    syncBuiltinESMExports()
    assert.throws(() => holdWriter(f.repoA, 'round'), LogHeldError)
    assert.equal(active.size, 1)
  } finally {
    fs.openSync = originalOpen; fs.closeSync = originalClose; syncBuiltinESMExports()
    hold?.release()
    for (const fd of active) { try { originalClose(fd) } catch { /* already retired by release */ } }
  }
})

test('a failed initial pin stat closes its descriptor and preserves the original error', () => {
  const originalOpen = fs.openSync, originalClose = fs.closeSync, originalStat = fs.fstatSync
  const active = new Set<number>(), failure = new Error('pin stat control'), f = roots()
  fs.openSync = ((...args: Parameters<typeof originalOpen>) => {
    const fd = originalOpen(...args)
    if (String(args[0]).endsWith(`.tmp-${process.pid}`) && args[1] === 'r') active.add(fd)
    return fd
  }) as typeof originalOpen
  fs.fstatSync = ((fd: number, ...rest: unknown[]) => {
    if (active.has(fd)) throw failure
    return originalStat(fd, ...rest as [])
  }) as typeof originalStat
  fs.closeSync = ((fd: number) => { active.delete(fd); return originalClose(fd) }) as typeof originalClose
  syncBuiltinESMExports()
  try {
    assert.throws(() => holdWriter(f.repoA, 'round'), error => error === failure)
    assert.equal(active.size, 0)
    assert.equal(existsSync(lockFileOf(f.repoA, 'round')), false)
    assert.deepEqual(readdirSync(dirname(lockFileOf(f.repoA, 'round'))), [])
  } finally {
    fs.openSync = originalOpen; fs.closeSync = originalClose; fs.fstatSync = originalStat; syncBuiltinESMExports()
    for (const fd of active) { try { originalClose(fd) } catch { /* observed attempt */ } }
  }
})

test('pin-open failure cleans its own temporary while an existing temporary remains unmodified', () => {
  const originalOpen = fs.openSync, failure = new Error('pin open control'), f = roots()
  fs.openSync = ((...args: Parameters<typeof originalOpen>) => {
    if (String(args[0]).endsWith(`.tmp-${process.pid}`) && args[1] === 'r') throw failure
    return originalOpen(...args)
  }) as typeof originalOpen
  syncBuiltinESMExports()
  try {
    assert.throws(() => holdWriter(f.repoA, 'round'), error => error === failure)
    const path = lockFileOf(f.repoA, 'round'), tmp = `${path}.tmp-${process.pid}`
    assert.deepEqual(readdirSync(dirname(path)), [])
    writeFileSync(tmp, 'foreign generated temporary\n')
    assert.throws(() => holdWriter(f.repoA, 'round'), { code: 'EEXIST' })
    assert.equal(readFileSync(tmp, 'utf8'), 'foreign generated temporary\n')
    assert.equal(existsSync(path), false)
  } finally {
    fs.openSync = originalOpen; syncBuiltinESMExports()
  }
})

test('missing-name release does not remove a later same-process pathname', () => {
  const f = roots(), first = holdWriter(f.repoA, 'round'), originalStat = fs.lstatSync
  let next: Hold | undefined, injected = false
  fs.lstatSync = ((...args: Parameters<typeof originalStat>) => {
    if (!injected && args[0] === first.path) {
      injected = true
      unlinkSync(first.path)
      next = holdWriter(f.repoA, 'round')
      throw Object.assign(new Error('controlled missing name'), { code: 'ENOENT' })
    }
    return originalStat(...args)
  }) as typeof originalStat
  syncBuiltinESMExports()
  try {
    first.release()
    assert.equal(injected, true)
    assert.ok(next)
    assert.equal(existsSync(next.path), true)
    assert.throws(() => holdWriter(f.repoA, 'round'), LogHeldError)
  } finally {
    fs.lstatSync = originalStat; syncBuiltinESMExports()
    try { next?.release() } finally { first.release() }
  }
})
