// A6 的断言（PLAN § 5.7 的 A6 行 · 架构 § 8.14 的 4–7 步与那句承重不变量 · § 8.12 末段的三档 ·
// § 9.10 的保留前缀 · 架构 § 20 S7 的第二条与第四条验证）。
//
//   ① **注入必然失败的断言 → 真实工作树的（全树哈希 · 逐条 (size,mtime,mode,hash)）一个都没动**，
//      且轮次不停在"通过"那一侧——负对照：把验收挪到推进之后 → ① 变红（真实工作树被改过）
//   ② **通过那一档：真实工作树与该 commit 的 tree 在保留前缀之外逐字节一致**（`scanTree` 对
//      `scanTree`，`.git`/`.fugue` 之外没有别的不一致），且与目标一致的那些文件**没被 touch**
//   ③ **保留前缀在真实工作树里不出现**：`.fugue/session/` 那几条在提交里，推进之后 `realRoot`
//      下没有
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Assertion } from '../contract/types.ts'
import type { BlobId, CommitId, RelPath } from '../terms.ts'
import type { TreeEntry } from '../entries.ts'
import { openTruth } from '../truth/truth.ts'
import type { TruthHandle } from '../truth/truth.ts'
import { scanTree } from '../materialize/diffstat.ts'
import { WORKSPACE_STATE } from '../materialize/diffstat.ts'
import { advance, commitThenAdvance, countsAsReject, entriesOf, verify } from './accept.ts'

const KEEP = process.env.KEEP === '1'
const roots: string[] = []
process.on('exit', () => {
  // **默认收干净，`KEEP=1` 才留现场。** 两条路都要：留下来的那几个目录是给人看的，而
  // "每跑一次 /tmp 里多四个 `a6-*`"不是——实测跑一趟整套会留下四个。
  if (KEEP) {
    if (roots.length > 0) console.log(`（KEEP=1，现场留着：${roots.join(' · ')}）`)
    return
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** 一份临时目录：`real/` 是真实工作树，`store/` 是对象库（**两处分开**，真源与工作树各是各的）。 */
function scratch(): { real: string; store: string } {
  const base = mkdtempSync(join(tmpdir(), 'a6-'))
  const real = join(base, 'real')
  const store = join(base, 'store')
  mkdirSync(real, { recursive: true })
  mkdirSync(store, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: store })
  // 真实工作树自己也常是个仓库——放一个 `.git` 进去，用来量"保留前缀不被动"。
  mkdirSync(join(real, '.git'), { recursive: true })
  writeFileSync(join(real, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(real, '.fugue', 'log'), { recursive: true })
  writeFileSync(join(real, '.fugue', 'log', 'round.jsonl'), '{"旧":1}\n')
  roots.push(base)
  return { real, store }
}

async function commitOf(
  t: TruthHandle,
  files: Readonly<Record<string, string>>,
  parents: readonly CommitId[],
  msg: string,
): Promise<CommitId> {
  const entries: TreeEntry[] = []
  for (const [path, text] of Object.entries(files)) {
    const id: BlobId = await t.putBlob(new TextEncoder().encode(text))
    entries.push({ name: path, mode: 0o100644, id })
  }
  return t.commit(await t.putTree(entries), [...parents], msg)
}

/** 一张全树快照的指纹：逐条 `(path,kind,mode,size,mtime,hash)` 串起来求一次哈希。 */
function fingerprint(root: string): string {
  const st = scanTree(root, { skip: WORKSPACE_STATE })
  return JSON.stringify(st.leaves)
}

/** 真实工作树的全指纹，**连保留前缀一起**（`.git` 与 `.fugue` 也要比——它们也不该被碰）。 */
function fingerprintAll(root: string): string {
  return JSON.stringify(scanTree(root).leaves)
}

const PASS_SPEC = (name: string, argv: readonly string[], cwd?: RelPath) => ({
  assertion: { action: 'a', name, expect: 0 } as Assertion,
  argv,
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  ...(cwd === undefined ? {} : { cwd }),
})

test('① 注入必然失败的断言：真实工作树一个字节都没动', async () => {
  const { real, store } = scratch()
  const t = openTruth(store)
  try {
    // 真实工作树一开始有一份自己的内容（与目标不同——推进之后它就该被改）。
    writeFileSync(join(real, 'a.txt'), '工作树里原来的 a\n')
    writeFileSync(join(real, 'extra.txt'), '工作树里多出来的一个文件\n')

    const commit = await commitOf(t, { 'a.txt': '合并结果里的 a\n', 'b.txt': '新来的 b\n' }, [], '合并结果')
    // 验收跑在哪棵树上：另铺一棵"物化树"，它与真实工作树是两回事。
    const mat = join(roots[roots.length - 1] as string, 'mat')
    mkdirSync(mat, { recursive: true })
    writeFileSync(join(mat, 'a.txt'), '合并结果里的 a\n')
    writeFileSync(join(mat, 'b.txt'), '新来的 b\n')

    const before = fingerprint(real)
    const beforeAll = fingerprintAll(real)

    // **必然失败的那一条**：`false` 不在树上，退出码 1。
    const out = await commitThenAdvance({
      truth: t,
      realRoot: real,
      tree: mat,
      specs: [PASS_SPEC('必然失败', ['/bin/sh', '-c', 'exit 1'])],
      commit,
    })
    assert.equal(out.report.ok, false, '这一档该判成没通过')
    assert.equal(out.report.fail, 1)
    assert.equal(out.report.unrunnable, 0, '"没通过"与"跑不起来"要分得开')
    assert.equal(out.commit, undefined, '没通过就不该定格')
    assert.equal(out.advanced, undefined, '没通过就不该推进')
    assert.equal(fingerprint(real), before, '真实工作树的内容被改过')
    assert.equal(fingerprintAll(real), beforeAll, '真实工作树里（连保留前缀）有东西被碰过')

    // **红负对照**：把验收挪到推进之后——先 `advance`，再跑同一条必然失败的断言。
    const shifted = await advance({ truth: t, realRoot: real }, commit)
    assert.equal(fingerprint(real) === before, false, '负对照里真实工作树该被改过——不然这条测不出东西')
    assert.ok(shifted.written.length > 0)
    // ……而真品那一侧什么都没动，两者因此在这一条上答案相反。
    assert.notEqual(fingerprint(real), before)
  } finally {
    await t.close()
  }
})

test('② 通过那一档：保留前缀之外逐字节一致，且内容相同的文件没被 touch', async () => {
  const { real, store } = scratch()
  const t = openTruth(store)
  try {
    // 真实工作树里先放一条**与目标一致**的文件（推进不该 touch 它——mtime 要保持）。
    writeFileSync(join(real, 'same.txt'), '一样的\n')
    writeFileSync(join(real, 'gone.txt'), '待会儿该被删掉\n')
    const sameMtime = JSON.stringify(scanTree(real).leaves.find((l) => l.path === 'same.txt'))

    const commit = await commitOf(t, { 'same.txt': '一样的\n', 'b.txt': '新来的 b\n' }, [], '合并结果')
    const mat = join(roots[roots.length - 1] as string, 'mat')
    mkdirSync(mat, { recursive: true })
    writeFileSync(join(mat, 'same.txt'), '一样的\n')
    writeFileSync(join(mat, 'b.txt'), '新来的 b\n')
    // 提交里还有一条**保留前缀**（§ 9.10：它在视图与提交里，不进真实工作树）。
    const withSession = await commitOf(
      t,
      { 'same.txt': '一样的\n', 'b.txt': '新来的 b\n', '.fugue/session/state.json': '{"保留":1}\n' },
      [commit],
      '合并结果 + 保留前缀',
    )

    const out = await commitThenAdvance({
      truth: t,
      realRoot: real,
      tree: mat,
      specs: [PASS_SPEC('必然通过', ['/bin/sh', '-c', 'exit 0'])],
      commit: withSession,
    })
    assert.equal(out.report.ok, true, `该判成通过：${JSON.stringify(out.report.results)}`)
    assert.equal(out.report.pass, 1)
    assert.equal(out.commit, withSession, '通过就该定格到那个提交')
    assert.ok(out.advanced !== undefined)

    // ② 第四条验证：真实工作树与该 commit 的 tree 在保留前缀之外逐字节一致。
    const got = scanTree(real, { skip: WORKSPACE_STATE })
    const want = await materializeForCompare(t, withSession)
    assert.deepEqual(
      got.leaves.map((l) => [l.path, l.kind, l.mode, l.size, l.hash]),
      want.map((l) => [l.path, l.kind, l.mode, l.size, l.hash]),
      '推进之后的真实工作树与那棵树对不上（保留前缀之外）',
    )
    // 内容相同的没被 touch：mtime 与推进之前逐字节相同。
    const sameNow = JSON.stringify(scanTree(real).leaves.find((l) => l.path === 'same.txt'))
    assert.equal(sameNow, sameMtime, '内容一样的文件被 touch 了——那会让工具链重新编译整个项目')
    // 多出来的那条被删了。
    assert.equal(existsSync(join(real, 'gone.txt')), false, '目标里没有的文件该被删掉')
    assert.ok(out.advanced.removed.includes('gone.txt'))
    assert.ok(out.advanced.written.includes('b.txt'))
  } finally {
    await t.close()
  }
})

test('③ 保留前缀不进真实工作树', async () => {
  const { real, store } = scratch()
  const t = openTruth(store)
  try {
    writeFileSync(join(real, 'a.txt'), '旧的\n')
    const commit = await commitOf(
      t,
      { 'a.txt': '新的\n', '.fugue/session/state.json': '{"保留":1}\n', '.fugue/bin/wrap.sh': '#!/bin/sh\n' },
      [],
      '带保留前缀的合并结果',
    )
    const mat = join(roots[roots.length - 1] as string, 'mat')
    mkdirSync(mat, { recursive: true })
    writeFileSync(join(mat, 'a.txt'), '新的\n')

    const out = await advance({ truth: t, realRoot: real }, commit)
    assert.equal(readFileSync(join(real, 'a.txt'), 'utf8'), '新的\n')
    // § 9.10：`.fugue/session/` 那几条在视图与提交里，推进之后 `realRoot` 下**没有**。
    assert.equal(existsSync(join(real, '.fugue', 'session')), false, '保留前缀进真实工作树了')
    assert.equal(existsSync(join(real, '.fugue', 'bin')), false, '保留前缀进真实工作树了')
    // 而工作树里原有的 `.fugue/log/round.jsonl` **没被动过**（跳过 = 不改也不删）。
    assert.equal(readFileSync(join(real, '.fugue', 'log', 'round.jsonl'), 'utf8'), '{"旧":1}\n')
    assert.ok(out.skipped.some((p) => p === '.fugue' || p.startsWith('.fugue/')))
    // 快照里也不该有它们（`scanTree` 跳 `WORKSPACE_STATE`）。
    assert.equal(scanTree(real, { skip: WORKSPACE_STATE }).leaves.some((l) => l.path.startsWith('.fugue')), false)
  } finally {
    await t.close()
  }
})

test('跑不起来那一档：命令不在 → unrunnable，不进"没通过"的计数', async () => {
  const { real, store } = scratch()
  const t = openTruth(store)
  try {
    writeFileSync(join(real, 'a.txt'), '旧的\n')
    const commit = await commitOf(t, { 'a.txt': '新的\n' }, [], '合并结果')
    const mat = join(roots[roots.length - 1] as string, 'mat')
    mkdirSync(mat, { recursive: true })
    writeFileSync(join(mat, 'a.txt'), '新的\n')

    const out = await commitThenAdvance({
      truth: t,
      realRoot: real,
      tree: mat,
      specs: [
        PASS_SPEC('命令不在', ['/nonexistent/nosuchcmd']),
        PASS_SPEC('退出码 127', ['/bin/sh', '-c', 'nosuchcmd-xyz']),
        PASS_SPEC('这条过', ['/bin/sh', '-c', 'exit 0']),
      ],
      commit,
    })
    assert.equal(out.report.unrunnable, 2, `两条该判成跑不起来：${JSON.stringify(out.report.results)}`)
    assert.equal(out.report.fail, 0, '"跑不起来"不许进"没通过"')
    assert.equal(out.report.pass, 1)
    // 一份里有跑不起来的，整批**不算通过**（它既不是好也不是坏，是没量到）。
    assert.equal(out.report.ok, false)
    assert.equal(out.commit, undefined, '不算通过就不该定格')
    assert.equal(readFileSync(join(real, 'a.txt'), 'utf8'), '旧的\n', '真实工作树被动了')
    // 三档的计数逐条对得上，且"算不算打回"只有 `fail` 那一档。
    assert.deepEqual(out.report.results.map(countsAsReject), [false, false, false])
    assert.match(out.report.results[0].note, /命令不在/)
    assert.match(out.report.results[1].note, /127/)

    // `verify` 单独用（它收不到 `realRoot`）：只读那一半也能跑。
    const only = verify(mat, [PASS_SPEC('过', ['/bin/sh', '-c', 'exit 0'])])
    assert.equal(only.ok, true)
    const none = verify(mat, [])
    assert.equal(none.ok, false, '一条断言都没有 = 没量到，不算通过')
  } finally {
    await t.close()
  }
})

/** 拿一个提交在盘上铺一份"参照树"，好与真实工作树逐条比。 */
async function materializeForCompare(t: TruthHandle, commit: CommitId): Promise<{ path: string; kind: string; mode: number; size: number; hash: string }[]> {
  const dir = join(roots[roots.length - 1] as string, `ref-${commit.slice(0, 6)}`)
  mkdirSync(dir, { recursive: true })
  for (const e of await entriesOf(t, commit)) {
    const abs = join(dir, e.name)
    mkdirSync(join(abs, '..'), { recursive: true })
    if (e.mode === 0o120000) {
      const target = new TextDecoder().decode((await t.getBlob(e.id as BlobId)) as Uint8Array)
      rmSync(abs, { force: true })
      execFileSync('ln', ['-sfn', target, abs])
      continue
    }
    writeFileSync(abs, (await t.getBlob(e.id as BlobId)) as Uint8Array)
  }
  // **同一把尺子**：真实工作树那一侧跳 `WORKSPACE_STATE`，参照树这一侧也跳——否则比的是
  // "保留前缀在不在真实工作树里"，而那是 ③ 那条断言的事。
  return scanTree(dir, { skip: WORKSPACE_STATE }).leaves.map((l) => ({ path: l.path, kind: l.kind, mode: l.mode, size: l.size, hash: l.hash }))
}
