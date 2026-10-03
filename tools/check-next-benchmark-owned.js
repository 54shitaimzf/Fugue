#!/usr/bin/env node
// Focused developer failure sentinels; not a product performance threshold test.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { settleBenchmarkCleanups } from './benchmark-cleanup.js'
const repo = resolve(import.meta.dirname, '..'), afterAt = process.argv.indexOf('--after')
assert.ok(afterAt >= 0, 'usage: node tools/check-batch-benchmark-owned.js --after /path/to/after')
const after = resolve(process.argv[afterAt + 1]), regexAt = process.argv.indexOf('--regex-after'), regexAfter = resolve(process.argv[regexAt + 1]), argv = process.argv
assert.ok(regexAt >= 0, 'supply --regex-after /path/to/regex-source')
const parent = fs.mkdtempSync(join(repo, '.benchmark-check-'))
const bindings = { readFile: fsp.readFile, stat: fsp.stat, open: fsp.open, mkdirSync: fs.mkdirSync, mkdtempSync: fs.mkdtempSync, fstatSync: fs.fstatSync }
let nonce = 0, checks = 0
const sentinel = new Error('owned setup sentinel')
async function rejected(script, args, expected) {
  process.argv = [process.execPath, join(repo, 'tools', script), ...args, '--temp-parent', parent]
  try { await assert.rejects(import(pathToFileURL(join(repo, 'tools', script)).href + '?sentinel=' + ++nonce), expected); assert.deepEqual(fs.readdirSync(parent), [], `${script} left owned temporary data`); assert.equal(fsp.readFile, bindings.readFile); assert.equal(fsp.stat, bindings.stat); assert.equal(fsp.open, bindings.open); assert.equal(fs.fstatSync, bindings.fstatSync); checks++ }
  finally { process.argv = argv }
}
try {
  const invalid = join(parent, 'nonexistent-source')
  await rejected('bench-reader-stat-paired.js', ['--before', invalid, '--after', after], /Cannot find module/)
  await rejected('bench-reader-stat-paired.js', ['--before', repo, '--after', invalid], /Cannot find module/)
  await rejected('bench-regex-verification-paired.js', ['--before', invalid, '--after', regexAfter], /Cannot find module/)
  await rejected('bench-regex-verification-paired.js', ['--before', repo, '--after', invalid], /Cannot find module/)
  await rejected('bench-regex-verification-paired.js', ['--before', repo, '--after', repo], /source hashes must differ/)
  fs.mkdirSync = () => { throw sentinel }; syncBuiltinESMExports()
  try { await rejected('bench-reader-stat-paired.js', ['--before', repo, '--after', after, '--writers', '1', '--rows', '1', '--runs', '1'], error => error === sentinel) }
  finally { fs.mkdirSync = bindings.mkdirSync; syncBuiltinESMExports() }
  let allocations = 0
  fs.mkdtempSync = (...args) => { if (++allocations === 2) throw sentinel; return bindings.mkdtempSync(...args) }; syncBuiltinESMExports()
  try { await rejected('bench-regex-verification-paired.js', ['--before', repo, '--after', regexAfter, '--files', '64', '--runs', '1'], error => error === sentinel) }
  finally { fs.mkdtempSync = bindings.mkdtempSync; syncBuiltinESMExports() }
  const seen = [], cleanupFailure = new Error('cleanup sentinel'), primary = new Error('primary sentinel')
  await assert.rejects(settleBenchmarkCleanups([() => { seen.push(1); throw cleanupFailure }, () => seen.push(2), () => { seen.push(3); throw new Error('secondary') }], { failed: true, error: primary }), error => error === primary)
  assert.deepEqual(seen, [1, 2, 3]); checks++
  seen.length = 0
  await assert.rejects(settleBenchmarkCleanups([() => { seen.push(1); throw cleanupFailure }, () => seen.push(2)]), error => error === cleanupFailure)
  assert.deepEqual(seen, [1, 2]); checks++
  console.log(JSON.stringify({ passed: checks, coverage: 'invalid before/after references, same-backend admission, reader async/sync-fs restoration after body failure, regex owned HOME cleanup after later allocation failure, attempt-all cleanup and primary-error preservation' }))
} finally {
  process.argv = argv; fs.mkdirSync = bindings.mkdirSync; fs.mkdtempSync = bindings.mkdtempSync; syncBuiltinESMExports(); fs.rmSync(parent, { recursive: true, force: true })
}
