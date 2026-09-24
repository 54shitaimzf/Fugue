// 探针：编排这一维的站前读数。出处：PLAN § 5.7 的 A0 行 + 它上面那张站前读数表。
// **取证用，不是产品的一部分**（仓库约定 § 七）。
//
// 它取三处读数，**一处一条**——判的不是"看着像"，是"这个数今天取不取得到、取出来是什么"：
//
//   一 · 打回的那三个计数点，在今天的事件流里取不取得到。A8 的接口是"从日志重算"，某个数
//        推不出来就得先补事件，而不是先在状态机上记一个数。这一节真起一份日志、真写三条
//        事件、真读回来，再数一遍——**并检查那三个字段名在 `src/` 里只有事件形状一处定义**
//        （没有第二处计数器：有的话，重算与采集就有了两个来源）。
//   二 · 真实工作树的脏路径集怎么取：`scanTree` 与 `diffStat` 够不够用，`WORKSPACE_STATE`
//        那条排除之外还剩什么。A7 的判据是"脏路径 ∩ 合并要写的路径"——**取不干净的话，
//        被拦下的与被放行的都会错，而错在放行那一侧是静默的**。
//   三 · `mergeTree` 的折叠：它只吃两个 base（三个及以上直接退 129，实测），N 个分支怎么折、
//        每折一步要不要落一次提交才给得下一折当输入。A5 的接口由这条读数定——这一节真建
//        一个仓库、真折一次、真比对最后一折的树。
//
// **读数不是断言。** 每一节报出来的是一句"量到了什么"，外加一条"这一跑本身对不对劲"的
// 自检（例如：折出来的树对不对得上逐条改动的结果）。自检红了要非零退出——那说明这一跑
// 没量到东西，而不是说明架构不对。
//
// 跑法：cd ~/fugue && node tools/probe-round.ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLog } from '../src/log/log.ts'
import type { LogEvent } from '../src/log/events.ts'
import { WORKSPACE_STATE, diffStat, scanTree } from '../src/materialize/diffstat.ts'
import type { Change } from '../src/materialize/diffstat.ts'
import { openTruth } from '../src/truth/truth.ts'
import type { AgentId, BlobId, BranchId, CommitId, TreeId } from '../src/terms.ts'
import type { TreeEntry } from '../src/entries.ts'

/** 代码工作区：探针就住在它底下，所以它由 `import.meta.url` 定，不由环境变量定。 */
const REPO = fileURLToPath(new URL('..', import.meta.url))

let failed = 0
function ok(msg: string): void {
  console.log(`  ok   ${msg}`)
}
function bad(msg: string): void {
  failed++
  console.log(`  FAIL ${msg}`)
}
function say(msg: string): void {
  console.log(`  ·    ${msg}`)
}
/** 读数：这一节量到了什么。**它不是断言**——摆在那给写提交信息的人抄。 */
function read(what: string, value: string): void {
  console.log(`  读数 ${what}：${value}`)
}
function eq(what: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) ok(`${what}：${g}`)
  else bad(`${what}：拿到 ${g}，要的是 ${w}`)
}

/** 一次性的临时目录，退出时清掉。`KEEP=1` 留下现场。 */
const KEEP = process.env.KEEP === '1'
const roots: string[] = []
function scratch(prefix: string): string {
  const p = mkdtempSync(join(tmpdir(), prefix))
  roots.push(p)
  return p
}
process.on('exit', () => {
  if (KEEP) {
    console.log(`\n（KEEP=1，现场留着：${roots.join(' · ')}）`)
    return
  }
  for (const p of roots) rmSync(p, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** 源码里的一份文件：相对仓库根的路径 + 正文。 */
interface SourceFile {
  readonly rel: string
  readonly text: string
}

/**
 * 扫一遍 `src/` 下的源码。**用 Node 读，不用 `grep`**——这一节问的是"这个字段名在几个文件里
 * 出现"，而任何一次 grep 调用都要经一层 shell（变量会被外层展开、`|` 与引号各要一层转义）。
 * 数文件这件事，读进来数就是了。`rel` 是相对**仓库根**的路径，与架构文档里写的路径同一个写法。
 *
 * 测试与探针不算：它们不是"第二处来源"，是照着形状写出来的用例。
 */
function scanSources(repo: string, base = 'src'): SourceFile[] {
  const abs = join(repo, base)
  const out: SourceFile[] = []
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${base}/${e.name}`
    if (e.isDirectory()) out.push(...scanSources(repo, rel))
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.startsWith('probe-')) {
      out.push({ rel, text: readFileSync(join(abs, e.name), 'utf8') })
    }
  }
  return out
}

// ── 一 · 打回的那三个计数点 ────────────────────────────────────────────────────
console.log('\n一 · 打回的三个计数点，在今天的事件流里取不取得到')

{
  const root = scratch('probe-round-log-')
  git(root, ['init', '-q'])
  const log = openLog(root, { sync: 'each' })

  // 一份最小的轮次：一条冲突的合并、一次验收打回、一次被拒的动作。形状逐字照 § 8.1。
  const written: LogEvent[] = [
    { t: 'round/state', round: 'r1', from: 'Idle', to: 'Planning' },
    { t: 'contract/issue', round: 'r1', contract: 'r1.implement.1', owner: 'a1', paths: ['src/a.ts'] },
    { t: 'mat/fork', agent: 'a1' as unknown as AgentId, base: 'c0ffee' as CommitId, strategy: 'copy', paths: [], hashes: [], ms: 1 },
    { t: 'round/state', round: 'r1', from: 'Planning', to: 'Delegated' },
    { t: 'round/state', round: 'r1', from: 'Delegated', to: 'Working' },
    { t: 'round/state', round: 'r1', from: 'Working', to: 'Collecting' },
    { t: 'round/state', round: 'r1', from: 'Collecting', to: 'Merging' },
    { t: 'merge/attempt', round: 'r1', branches: ['b1', 'b2'] as unknown as BranchId[], conflicts: 2 },
    { t: 'round/state', round: 'r1', from: 'Merging', to: 'Verifying' },
    { t: 'round/state', round: 'r1', from: 'Verifying', to: 'Working' },
    { t: 'run/end', agent: 'a1' as unknown as AgentId, step: 's1', exit: 1, ms: 5, denied: true },
    { t: 'merge/accept', round: 'r1', commit: 'c0ffee' as CommitId, assertions: [{ assertion: '测试', verdict: 'fail' }] },
  ]
  for (const e of written) await log.append('round', e)
  await log.close()

  const back = openLog(root)
  const seen: LogEvent[] = []
  for await (const { e } of back.readMerged()) seen.push(e)
  await back.close()

  eq('写下去几条、读回来几条', seen.length, written.length)
  eq('读回来的与写下去的逐条相同', seen, written)
  if (seen.length === written.length) ok('三条事件都能原样写下去、原样读回来')

  // 三个计数点各自的取法——**只读事件流，不读任何别的状态**。
  const conflicts = seen.filter((e) => e.t === 'merge/attempt')
  const verdicts = seen.filter((e) => e.t === 'merge/accept')
  const denials = seen.filter((e) => e.t === 'run/end')

  const nConflict = conflicts.reduce((n, e) => n + (e as { conflicts: number }).conflicts, 0)
  const nReject = verdicts.reduce(
    (n, e) => n + (e as { assertions: readonly { verdict: string }[] }).assertions.filter((a) => a.verdict === 'fail').length,
    0,
  )
  const nDenied = denials.filter((e) => (e as { denied: boolean }).denied).length

  read('①冲突数（merge/attempt 的 conflicts 求和）', String(nConflict))
  read('②打回数（merge/accept 的 assertions 里 verdict=fail 的条数）', String(nReject))
  read('③动作被拒的次数（run/end 的 denied 为真的条数）', String(nDenied))

  eq('① 与写下去的那一份对得上', nConflict, 2)
  eq('② 与写下去的那一份对得上', nReject, 1)
  eq('③ 与写下去的那一份对得上', nDenied, 1)

  // **同一个数不许有第二处来源。** 三个字段名如果在 `src/` 里另有定义处，重算与采集就成了
  // 两个来源——那正是"不采集，只重算"这条纪律要防的。逐个名字扫一遍源码，名单原样记下来。
  const SRC = scanSources(REPO)
  const POINTS: readonly (readonly [string, string, string])[] = [
    // 标签 · 事件形状里那一行的标志（逐字）· 要扫的字段名
    ['① 冲突数', "t: 'merge/attempt'", 'conflicts'],
    ['② 打回数', "t: 'merge/accept'", 'verdict'],
    ['③ 动作被拒的次数', "t: 'run/end'", 'denied'],
  ]
  const eventsText = readFileSync(join(REPO, 'src', 'log', 'events.ts'), 'utf8')
  for (const [label, mark, field] of POINTS) {
    if (eventsText.includes(mark)) ok(`${label}：事件形状里有那一行（${mark}）`)
    else bad(`${label}：事件形状里找不到那一行（${mark}）——那个数今天取不到`)
    const hits = SRC.filter((f) => f.text.includes(field)).map((f) => f.rel).sort()
    read(`${label} 的字段名 \`${field}\` 出现的文件`, hits.join(' · ') || '（一处都没有）')
  }
  // ② 的取值走的是类型引用，不走字段名——这一条单独指认。
  if (/AssertionResult/.test(eventsText)) ok('② 的取值经 `AssertionResult` 进事件（src/log/events.ts 引它）')
  else bad('② 的取值没有进事件那一份——`merge/accept` 拿不到三档')
  if (SRC.some((f) => f.text.includes('AssertionVerdict'))) ok('② 的三档取值有唯一一处定义')
  else bad('② 的三档取值没有定义处')

  // 三个字段的出处逐行指认——量的是"它在哪一行"，不是"它应该在"。
  for (const [file, needle] of [
    ['src/log/events.ts', "t: 'merge/attempt'"],
    ['src/log/events.ts', "t: 'merge/accept'"],
    ['src/log/events.ts', "t: 'run/end'"],
    ['src/log/events.ts', "t: 'round/state'"],
  ] as const) {
    const text = readFileSync(join(REPO, file), 'utf8')
    const at = text.split('\n').findIndex((l) => l.includes(needle))
    if (at >= 0) ok(`${needle} 在 ${file}:${at + 1}`)
    else bad(`${file} 里找不到 ${needle}`)
  }
}

// ── 二 · 真实工作树的脏路径集 ──────────────────────────────────────────────────
console.log('\n二 · 真实工作树的脏路径集：`scanTree` 与 `diffStat` 够不够用')

{
  const root = scratch('probe-round-tree-')
  git(root, ['init', '-q'])

  // 一棵像样的树：两个源文件 · 一个子目录 · 一个软链，外加**工作区自己的本子**
  // （`.fugue/` 与 `.git/`）——后者正是 A7 要跳开的那一片。
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  mkdirSync(join(root, '.fugue', 'log'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'src', 'deep', 'b.ts'), 'export const b = 2\n')
  writeFileSync(join(root, 'README.md'), '# x\n')
  writeFileSync(join(root, '.fugue', 'log', 'round.jsonl'), '{"a":1}\n')
  writeFileSync(join(root, '.fugue', 'config'), '{}\n')

  const before = scanTree(root)
  const beforeSkipped = scanTree(root, { skip: WORKSPACE_STATE })

  // 轮次中发生三件事：改一条文件 · 加一条文件 · 工作区自己的日志长大。
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 11\n')
  writeFileSync(join(root, 'src', 'new.ts'), 'export const c = 3\n')
  writeFileSync(join(root, '.fugue', 'log', 'round.jsonl'), '{"a":1}\n{"a":2}\n')

  const after = scanTree(root)
  const afterSkipped = scanTree(root, { skip: WORKSPACE_STATE })
  const raw = diffStat(before, after)
  const skipped = diffStat(beforeSkipped, afterSkipped)

  const paths = (cs: readonly Change[]): string[] => cs.map((c) => `${c.status}:${c.path}`).sort()
  read('不跳 `WORKSPACE_STATE` 时的脏路径集', paths(raw).join(' · '))
  read('跳开 `WORKSPACE_STATE` 之后的脏路径集', paths(skipped).join(' · '))
  read('这一跳开覆盖的目录（叶子数）', `${beforeSkipped.leaves.length} 片叶子在册，跳掉的目录 ${WORKSPACE_STATE.join(' · ')}`)

  // 自检：跳开之后，脏路径集恰好是那两条真改动——不多不少。
  eq('跳开之后恰好两条', paths(skipped), ['added:src/new.ts', 'changed:src/a.ts'])
  // 自检：不跳的话，工作区自己的本子会被算成树的改动——**这就是 A7 必须跳的理由**。
  ok(`不跳的话多出来 ${raw.length - skipped.length} 条（工作区自己的本子），它们会冒充"用户改了工作树"`)
  eq('不跳时多出来的那一条', paths(raw).filter((p) => !paths(skipped).includes(p)), ['changed:.fugue/log/round.jsonl'])

  // 自检：`scanTree` 是按路径排序的，两次扫同一棵静置的树逐字节相同——A7 的判据要能比。
  eq('静置的树两次扫出来相同', JSON.stringify(scanTree(root, { skip: WORKSPACE_STATE })), JSON.stringify(afterSkipped))

  // 自检：脏路径集能不能"只取会被覆盖的那些"——那正是 A7 的判据形状（相交，不是相等）。
  const mergePaths = ['src/a.ts', 'src/other.ts']
  const dirty = paths(skipped).map((p) => p.slice(p.indexOf(':') + 1))
  const hit = dirty.filter((p) => mergePaths.some((m) => p === m || p.startsWith(m + '/')))
  eq('脏路径 ∩ 这次合并要写的路径', hit, ['src/a.ts'])
  read('判据形状', '脏路径 ∩ 合并要写的路径 —— 相交即拒，不相交照常（不新造检测机制）')

  // `diffStat` 的列能不能分出"只碰了时间"与"改了内容"——A6 的"全树哈希与逐条 (size,mtime,mode)
  // 一个都没动"读的是同一把尺子。
  const touched = scanTree(root, { skip: WORKSPACE_STATE })
  const t = join(root, 'src', 'a.ts')
  const st = statSync(t)
  writeFileSync(t, readFileSync(t))
  const touched2 = scanTree(root, { skip: WORKSPACE_STATE })
  const onlyTime = diffStat(touched, touched2)
  read('重写同内容之后报出来的列', onlyTime.map((c) => `${c.path}[${c.columns.join(',')}]`).join(' · ') || '（一条都没报）')
  say(`src/a.ts 的 mtime 变了没有：${String(st.mtimeMs !== statSync(t).mtimeMs)}`)
}

// ── 三 · `mergeTree` 的折叠 ───────────────────────────────────────────────────
console.log('\n三 · `mergeTree` 只吃两个 base：N 路怎么折、每折一步要不要落一次提交')

{
  const root = scratch('probe-round-fold-')
  git(root, ['init', '-q'])
  const truth = openTruth(root)

  /** 一份 tree：路径 → 字节。中间目录由 `putTree` 那一份实现自己拼（它收的是一张摊平的条目表）。 */
  async function treeOf(files: Readonly<Record<string, string>>): Promise<TreeId> {
    const entries: TreeEntry[] = []
    for (const [path, text] of Object.entries(files)) {
      const blob: BlobId = await truth.putBlob(new TextEncoder().encode(text))
      entries.push({ name: path, mode: 0o100644, id: blob })
    }
    return truth.putTree(entries)
  }
  async function readAll(c: CommitId): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    const walk = async (dir: string): Promise<void> => {
      const list = await truth.listAt(c, dir)
      for (const e of list) {
        const p = dir === '' ? e.name : `${dir}/${e.name}`
        if (e.kind === 'dir') await walk(p)
        else {
          const bytes = await truth.readAt(c, p)
          out[p] = bytes === null ? '（读不出来）' : new TextDecoder().decode(bytes)
        }
      }
    }
    await walk('')
    return out
  }

  const base = await truth.commit(await treeOf({ 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' }), [], 'base')
  // 三条分支各改一处不相交的路径：这正是折叠要合的那一份。
  const b1 = await truth.commit(await treeOf({ 'a.txt': 'a1\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' }), [base], 'b1')
  const b2 = await truth.commit(await treeOf({ 'a.txt': 'a0\n', 'b.txt': 'b1\n', 'c.txt': 'c0\n' }), [base], 'b2')
  const b3 = await truth.commit(await treeOf({ 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c1\n' }), [base], 'b3')

  // 三个 base 直接给进去：架构 § 8.2 的硬约束 4 就是这么写的。
  let refused = ''
  try {
    await truth.mergeTree([b1, b2, b3])
  } catch (err) {
    refused = (err as Error).message
  }
  ok(`三个 base 给进去当场被拒：${refused.split('\n')[0].slice(0, 96)}…`)
  read('三个 base 的报法', refused.includes('只支持两个') ? '拒，且话里指得出「多于两个由调用方逐路折叠」' : `（意外）${refused}`)

  // 折第一路：b1 + b2。`merge-tree --write-tree` 不建提交，它只给一棵树。
  const m12 = await truth.mergeTree([b1, b2])
  if ('conflicts' in m12) {
    bad(`b1 与 b2 该合得上（两处改动不相交），却报了 ${m12.conflicts.length} 处冲突`)
  } else {
    const t12 = m12.tree
    const c12 = await truth.commit(t12, [b1, b2], 'fold(b1,b2)')
    read('第一折', `tree=${t12.slice(0, 8)} 落了提交 ${c12.slice(0, 8)}（父 b1 · b2）`)
    ok('第一折的树出得来，且它当场落得成一次提交')

    // 第二折：把第一折当成一个 base，与 b3 再折一次。**这一条就是那个设计问题的答案**——
    // 折出来的中间树要给下一折当输入的话，它得有一个提交能指。
    const m123 = await truth.mergeTree([c12, b3])
    if ('conflicts' in m123) {
      bad(`第二折报了 ${m123.conflicts.length} 处冲突——折叠在被折过的那一路上不成立`)
    } else {
      const files = await readAll(await truth.commit(m123.tree, [c12, b3], 'fold(fold(b1,b2),b3)'))
      const want = { 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n' }
      eq('两折之后的树与三处改动逐字节相同', files, want)
      read('第二折', `拿的是「第一折那个提交」，不是那棵树本身——merge-tree 的入参是两个提交`)
      read('折叠的形状', 'N 路折叠要每折落一个提交（不然下一折没有 base 可指）')
    }

    // 同一折，若**不落提交**、直接拿第一折的树当 base，会发生什么？——量出来，别猜。
    let bare = ''
    try {
      await truth.mergeTree([t12 as unknown as CommitId, b3])
      bare = '（居然收下了）'
    } catch (err) {
      bare = (err as Error).message.split('\n')[0]
    }
    read('拿树当 base 的报法', bare.slice(0, 120))
  }
  await truth.close()
}

// ── 收尾 ──────────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '读数取到了（三个计数点 · 脏路径集 · 折叠的形状）；自检全部通过' : `FAIL ${failed} 处`}`)
process.exit(failed === 0 ? 0 : 1)
