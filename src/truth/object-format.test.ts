// tier: real —— 真 Git 进程与 SHA1/SHA256 对象库；不要求沙箱或挂载。
// Repository storage format determines absent-ref CAS width, even for abbreviated targets.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import type { CommitId } from '../terms.ts'
import { openTruth, RefConflictError } from './truth.ts'
import { objectFormatProbe } from './object-format.ts'
import { GitError, openGit } from './git.ts'

const env = {
  PATH: process.env.PATH, HOME: tmpDir('fugue-hash-home-'), LC_ALL: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue', GIT_AUTHOR_EMAIL: 'fugue@localhost',
  GIT_COMMITTER_NAME: 'fugue', GIT_COMMITTER_EMAIL: 'fugue@localhost',
}

function git(root: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

function snapshot(root: string): unknown[] {
  const rows: unknown[] = []
  function walk(dir: string): void {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const st = lstatSync(path)
      // Git may transiently create/remove a ref lock on denied CAS, changing directory mtime.
      rows.push([path.slice(root.length), st.mode, st.isDirectory() ? null : st.mtimeMs,
        st.isDirectory() ? null : st.isSymbolicLink() ? readlinkSync(path) : readFileSync(path).toString('hex')])
      if (st.isDirectory()) walk(path)
    }
  }
  walk(root)
  return rows
}

for (const format of ['sha1', 'sha256'] as const) {
  test(`${format}: format probe is lazy, coalesced and byte-for-byte read-only`, async (ctx) => {
    const root = tmpDir('fugue-hash-probe-')
    git(root, 'init', '-q', `--object-format=${format}`)
    writeFileSync(join(root, 'untouched'), 'worktree\n')
    const handle = openGit(root)
    ctx.after(() => handle.close())
    const probe = objectFormatProbe(handle)
    assert.equal(handle.spawns(), 0)
    const before = snapshot(root)
    const first = probe()
    assert.equal(probe(), first)
    assert.deepEqual(await Promise.all([first, probe()]), format === 'sha1' ? [20, 20] : [32, 32])
    assert.equal(await probe(), format === 'sha1' ? 20 : 32)
    assert.equal(handle.spawns(), 1)
    assert.equal(handle.requests(), 1)
    await handle.close()
    assert.deepEqual(snapshot(root), before)
  })
  test(`${format}: absent-ref CAS accepts an abbreviated commit and preserves HEAD/index/worktree`, async (ctx) => {
    const root = tmpDir('fugue-hash-format-')
    git(root, 'init', '-q', `--object-format=${format}`)
    writeFileSync(join(root, 'untouched'), 'physical worktree\n')
    const truth = openTruth(root)
    ctx.after(() => truth.close())
    const blob = await truth.putBlob(Buffer.from('virtual body\n'))
    const tree = await truth.putTree([{ name: 'file', mode: 0o100644, id: blob }])
    const commit = await truth.commit(tree, [], 'format test')
    assert.equal(commit.length, format === 'sha1' ? 40 : 64)
    const protectedFiles = ['.git/HEAD', 'untouched'].map(p => readFileSync(join(root, p)))
    await truth.advance('refs/heads/probe-short', commit.slice(0, 12) as CommitId, null)
    assert.equal(await truth.resolve('refs/heads/probe-short'), commit)
    await truth.advance('refs/heads/probe-full', commit, null)
    assert.equal(await truth.resolve('refs/heads/probe-full'), commit)
    const next = await truth.commit(tree, [commit], 'next format test')
    await truth.advance('refs/heads/probe-full', next, commit)
    assert.equal(await truth.resolve('refs/heads/probe-full'), next)
    assert.equal((await truth.readAt(commit, 'file'))?.toString(), 'virtual body\n')
    assert.equal((await truth.listAt(commit, ''))[0].id, blob)
    assert.deepEqual(['.git/HEAD', 'untouched'].map(p => readFileSync(join(root, p))), protectedFiles)
    assert.equal(readdirSync(join(root, '.git')).includes('index'), false)
    const before = snapshot(root)
    await assert.rejects(truth.advance('refs/heads/probe-full', commit, null), RefConflictError)
    assert.deepEqual(snapshot(root), before, 'absent-ref CAS conflict must preserve the existing ref')
    await assert.rejects(truth.advance('refs/heads/probe-invalid', 'not-an-object' as CommitId, null), GitError)
    assert.deepEqual(snapshot(root), before, 'refusal must not alter repository or physical worktree')
  })
}

test('unknown/malformed formats and subprocess failure remain retryable, without a guessed SHA1 default', async () => {
  const failure = new Error('probe failed')
  const replies: Array<Buffer | Error> = [
    failure, Buffer.from('sha1'), Buffer.from('sha512\n'), Buffer.from('sha1\nsha256\n'),
    Buffer.alloc(1 << 20, 0x78), Buffer.from('sha256\n'),
  ]
  let calls = 0
  const probe = objectFormatProbe({ run: async (args) => {
    assert.deepEqual(args, ['rev-parse', '--show-object-format=storage'])
    const reply = replies[calls++]
    if (reply instanceof Error) throw reply
    return reply
  } })
  await assert.rejects(probe(), e => e === failure)
  for (let i = 0; i < 4; i++) {
    await assert.rejects(probe(), e => e instanceof Error && e.message.length < 120)
  }
  assert.equal(await probe(), 32)
  assert.equal(await probe(), 32)
  assert.equal(calls, 6)
})
