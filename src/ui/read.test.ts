// TUI 的第二版第九格：**阅读面**（PLAN § 5.19 第二版「五 · 门口那一批」那一句"diff 归 `T9`"·
// 第九节 `T9` 那一行 · 架构 § 8.3 · § 9.8）。跑法：cd ~/fugue && node --test src/ui/read.test.ts
//
// 这一份量的四样：
//
//   ① **面板与 `fugue diff --json` 读同一份数据**（`T9` 那句断言的前半）：一个真根上走四条写命令
//      （写两条 · 删一条 · 改名一条 · 改权限一条），账上折出来的那一面与**真跑一遍**
//      `fugue diff --json` 印出来的那几条**逐格对得上**（路径 · 改名两端 · 模式）。
//      · 负对照：把 `DELTA_FACE` 里的 `delete` 改成 `write` → 两条路当场分家
//   ② **同一份输入重画两次逐字节相同**（后半句）：折两次 · 排版两次，`ReadState` 与那一面那几行
//      都逐字节相同；而且**接着折的那一份与从头折的逐字段相同**（`prev` 不给 / 给 / 给错的都给一遍）
//   ③ **只重折尾部**（`T9` 那一格里那半句）：`onRow` 数出来的条数 = 新来的那几条；负对照是
//      `prev: undefined`（从头折 → 数出来是全部）与 `prev.seen` 被顶掉（**晚出现的 writer 第一条
//      插进旧账中间** → 前缀对不上 → 老实从头折，**不是**少折几条）
//   ④ **工具输出折叠**：一次 `run/start` 等它的 `run/end` 折成一行 · 一串 `llm/call` 折成一行；
//      折掉多少条在标题里说出来（折叠不是丢）；负对照：没等到 `run/end` 的那一条也印得出来
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { runCli } from '../../test/helpers/run-cli.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import { rowsOf } from '../probe/status.ts'
import type { StatusRow } from '../probe/status.ts'
import type { AgentId, BlobId, RoundId, ViewRev, WriterId } from '../terms.ts'
import {
  DELTA_FACE,
  EMPTY_READ,
  READ_LIMIT,
  faceKeyOf,
  faceOfDelta,
  facesOf,
  firstFace,
  prefixOk,
  readStateOf,
  stepFace,
  stepTop,
} from './read.ts'

const A = 'agent/r1/1' as AgentId

/** 一条 `llm/call`（形状照 `src/log/events.ts`，与 `probe/status.test.ts` 的夹具同一份写法）。 */
function call(agent: string, step: string): LogEvent {
  return {
    t: 'llm/call',
    agent: agent as AgentId,
    step: step as never,
    model: 'm1' as never,
    wire: 'anthropic-messages',
    toolCount: 9,
    invocations: 1,
    status: null,
    headers: null,
    thinking: 'high',
    usage: { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: null },
    rawStop: 'end_turn',
    stop: 'end-turn',
  }
}

let seq = 0
/** 一条行（缺省落在持轮者那一份上）。**纯函数那几条用不着真日志**——与 `probe/status.test.ts` 同形。 */
const row = (e: LogEvent, w = 'round'): StatusRow => ({ pos: { writer: w, seq: (seq += 1) }, e })

/** 一份手里拼的账：一串调用 · 一次起进程（连着两条 end）+ 一条没等到 end 的 · 契约正文 · 视图流水。 */
function script(): StatusRow[] {
  seq = 0
  const r1 = 'r1' as RoundId
  return [
    row({ t: 'round/intent', round: r1, base: 'b0' as never, digest: 'd0', body: '写一份 a.ts' }),
    row({ t: 'round/state', round: r1, from: 'Planning' as never, to: 'Delegated' as never }),
    row({ t: 'contract/issue', round: r1, contract: 'r1.implement.1' as never, owner: A, paths: ['src/a.ts'] as never[], body: '{"kind":"implement","goal":"写 a.ts"}' }),
    row({ t: 'round/approve', round: r1, fingerprint: 'f0', contracts: ['r1.implement.1' as never] }),
    row(call(A, '1'), A),
    row(call(A, '1'), A),
    row({ t: 'run/start', agent: A, step: '1' as never, action: 'bash', argv0: '/bin/sh', argv: ['/bin/sh', '-c', 'ls'] }, A),
    row({ t: 'run/end', agent: A, step: '1' as never, exit: 0, ms: 9, denied: false }, A),
    row({ t: 'run/start', agent: A, step: '2' as never, action: 'bash', argv0: '/bin/echo', argv: ['/bin/echo'] }, A),
    row({ t: 'view/write', agent: A, path: 'src/a.ts' as never, rev: 1 as ViewRev, blob: 'bl1' as BlobId, mode: 0o100644 }, A),
    row({ t: 'view/remove', agent: A, path: 'src/b.ts' as never, rev: 2 as ViewRev }, A),
    row({ t: 'mat/fork', agent: A, base: 'b0' as never, strategy: 'copy' as never, paths: ['src/a.ts'] as never[], hashes: ['h1'], ms: 2 }, A),
    row({ t: 'agent/stop', agent: A, steps: 2, stopped: '收敛', handoffs: 0 }, A),
  ]
}

// ── ① 面板与 `fugue diff --json` 读同一份数据（真根 · 真命令） ─────────────────────────────

test('① 面板那一面与 `fugue diff --json` 逐格对得上（负对照：改掉 `DELTA_FACE` 的一格当场分家）', async () => {
  // 临时目录走 `tmpDir`（U18：登记过、文件收尾统一删——不再自己 try/finally 删）。
  const dir = tmpDir('fugue-read-diff-')
  const src = tmpDir('fugue-read-src-')
  {
    // **真源是既有的 git 对象库**（架构 § 9.1：M1 不建仓库），所以夹具自己建一个。
    const git = (...args: readonly string[]): void => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
      assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`)
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(dir, 'seed.txt'), '底\n')
    git('add', '-A')
    git('commit', '-qm', 'seed')

    writeFileSync(join(src, 'a.ts'), '第一份\n')
    const sh: readonly (readonly string[])[] = [
      ['write', 'src/a.ts', '--from', join(src, 'a.ts')],
      ['write', 'src/b.ts', '--from', join(src, 'a.ts')],
      ['remove', 'src/b.ts'],
      ['rename', 'src/a.ts', 'src/c.ts'],
      ['chmod', 'src/c.ts', '755'],
    ]
    for (const args of sh) {
      const r = await runCli(['--root', dir, ...args])
      assert.equal(r.code, 0, `${args.join(' ')} 该成功：${r.stderr}`)
    }

    const log = openLog(dir, { sync: 'each' })
    const rows = await rowsOf(() => log.readMerged())
    const state = readStateOf(rows)
    const mine = state.diff.map(faceKeyOf)

    const cli = await runCli(['--root', dir, 'diff', '--json', '--agent', 'round'])
    assert.equal(cli.code, 0, `diff --json 该成功：${cli.stderr}`)
    const theirs = (JSON.parse(cli.stdout) as readonly never[]).map((d) => faceKeyOf(faceOfDelta(d as never) as never))

    console.log(`① 读数：账上折出 ${mine.length} 条 · \`fugue diff --json\` 印出 ${theirs.length} 条`)
    for (const k of theirs) console.log(`   命令面 ${k}`)
    assert.deepEqual(mine, theirs, '面板那一面与 `fugue diff --json` 是同一批行（路径 · 改名两端 · 模式）')
    assert.ok(mine.some((k) => k.startsWith('write\t')), '至少要有一条「写」')
    assert.ok(mine.some((k) => k.startsWith('delete\t')), '至少要有一条「删」')
    assert.ok(mine.some((k) => k.startsWith('rename\t')), '至少要有一条「改名」')
    assert.ok(mine.some((k) => k.startsWith('chmod\t')), '至少要有一条「改权限」')

    // **负对照**：把读面那张表里的一格改掉，两条路当场分家（这条对账真的在读那张表）。
    const wrong: Record<string, 'write' | 'delete' | 'rename' | 'chmod' | 'symlink'> = { ...DELTA_FACE, delete: 'write' }
    const broke = (JSON.parse(cli.stdout) as readonly never[]).map((d) => faceKeyOf(faceOfDelta(d as never, wrong) as never))
    console.log(`① 负对照：把 \`delete\` 读成 \`write\` → 命令面那 ${broke.length} 条里有 ${broke.filter((k) => k.startsWith('write\t')).length} 条「写」`)
    assert.notDeepEqual(broke, mine, '改掉一格之后还对得上，说明这条对账没在读那张表')
  }
})

// ── ② 同一份输入重画两次逐字节相同 ────────────────────────────────────────────────────

test('② 同一份输入折两次 · 排两次版：逐字节相同（接着折的那一份与从头折的逐字段也相同）', () => {
  const rows = script()
  const one = readStateOf(rows)
  const two = readStateOf(rows)
  assert.deepEqual(one, two, '同一份行折两次：逐字段相同')
  assert.deepEqual(facesOf(one), facesOf(two), '同一份状态排两次版：逐行相同')
  assert.deepEqual(readStateOf(rows, { prev: one }), one, '拿自己当 prev 再折一遍（零条新行）：一个字段都不动')
  assert.deepEqual(readStateOf(rows, { prev: readStateOf(rows.slice(0, 4)) }), one, '接着折与从头折：逐字段相同')

  const faces = facesOf(one)
  assert.equal(faces.diff?.lines.length, 2, '这一份账里有两条视图流水（写一条 · 删一条）')
  assert.equal(firstFace(faces), 'diff', '有 diff 就先看 diff')
  assert.equal(stepFace(faces, 'diff', 1), 'contract', '有契约正文时 `Tab` 从 diff 走到契约')
  assert.equal(stepFace(faces, 'contract', 1), 'stream', '再走一步到事件流')
  assert.equal(stepFace(faces, 'stream', 1), 'diff', '环形回到 diff')
  assert.equal(stepFace({ ...faces, contract: null }, 'diff', 1), 'stream', '没有的那一面跳过去（不留在一张空纸上）')
})

// ── ③ 只重折尾部 ─────────────────────────────────────────────────────────────────────

test('③ 只重折尾部：`onRow` 数出来的就是新来的那几条（负对照：不给 `prev` 就是全部）', () => {
  const rows = script()
  let folded = 0
  const fromScratch = readStateOf(rows, { onRow: () => { folded += 1 } })
  console.log(`③ 读数：从头折 ${folded} 条（行 ${rows.length} 条）`)
  assert.equal(folded, rows.length, '从头折：一条不落')

  for (const cut of [1, 4, 7, rows.length]) {
    const head = readStateOf(rows.slice(0, cut))
    let again = 0
    const tail = readStateOf(rows, { prev: head, onRow: () => { again += 1 } })
    console.log(`③ 读数：折到 ${cut} 条之后接着折：重折了 ${again} 条（新来 ${rows.length - cut} 条）`)
    assert.equal(again, rows.length - cut, `prev 是前 ${cut} 条：只该折后面那几条`)
    assert.deepEqual(tail, fromScratch, `prev 是前 ${cut} 条：结果与从头折的逐字段相同`)
  }

  // **负对照一**：不给 `prev` → 全部重折（这个数真的在量"折了几条"）。
  let none = 0
  readStateOf(rows, { onRow: () => { none += 1 } })
  assert.equal(none, rows.length, '不给 prev：从头折')
  assert.notEqual(none, rows.length - 3, '与"只折尾部"那一档分得开')

  // **负对照二**：游标的位置被顶掉（晚出现的 writer 第一条是 `seq = 1`，它**插进旧账中间**）→ 前缀
  // 对不上 → 老实从头折，**不是**少折几条（下标当游标的增量折那时候就错了）。
  const head = readStateOf(rows.slice(0, 5))
  const moved = [...rows.slice(0, 2), row({ t: 'signal', agent: A, kind: 'SIGINT', id: 's1' } as never, 'agent/r9/1'), ...rows.slice(2)]
  assert.equal(prefixOk(head, moved), false, '插进旧账中间之后，前缀对不上')
  let after = 0
  const fixed = readStateOf(moved, { prev: head, onRow: () => { after += 1 } })
  console.log(`③ 读数：前缀被顶掉之后重折了 ${after} 条（行现在 ${moved.length} 条）`)
  assert.deepEqual(fixed, readStateOf(moved), '接不上就从头折：结果仍与从头折的逐字段相同')
  assert.ok(after > moved.length - 5, '不是"少折几条"——是老实重折')

  // 换了哪一格：`prev` 直接作废（`seen` 是筛过那份行里的下标，换一份筛法它就不作数了）。
  const forA = readStateOf(rows, { agent: 'agent/r1/1' })
  let other = 0
  const forRound = readStateOf(rows, { agent: 'round', prev: forA, onRow: () => { other += 1 } })
  assert.deepEqual(forRound, readStateOf(rows, { agent: 'round' }), '换一格：从头折，结果一样')
  assert.ok(other > 0, '换一格真的重折了')
})

// ── ④ 工具输出折叠 ───────────────────────────────────────────────────────────────────

test('④ 工具输出折叠：一串调用折成一行 · 一次起进程折成一行 · 折掉多少条在标题里说出来', () => {
  const state = readStateOf(script())
  const faces = facesOf(state)
  const lines = faces.stream.lines
  for (const l of lines) console.log(`④ 事件流 ${l}`)

  assert.ok(lines.some((l) => /格 agent\/r1\/1 · 调用 2 次 · 最近 m1$/.test(l)), '两条 `llm/call` 折成一行')
  assert.ok(lines.some((l) => /起了 \/bin\/sh（bash） *· exit 0 · 9ms$/.test(l)), '`run/start` + `run/end` 折成一行')
  assert.ok(
    lines.some((l) => /起了 \/bin\/echo（bash）$/.test(l)),
    '没等到 `run/end` 的那一条照样印出来（那一组还开着）',
  )
  assert.ok(lines.some((l) => l.startsWith('其余事件 ')), '只计数那一档要说一句（一族一个数）')
  assert.ok(!lines.some((l) => l.includes('llm/call')), '折掉的那两族不许再逐条出现')
  console.log(`④ 读数：${faces.stream.title}`)
  assert.equal(state.permanent, 5, '永久行 5 条（意图 · 转移 · 契约 · 放行 · 停止）')
  assert.equal(state.tool, 3, '工具输出折成 3 行（调用 1 行 + 起进程 2 行）')

  // 一行一条：**没有哪一行里带着换行**（终端那边一行就是一行，历史才对得上）。
  for (const l of lines) assert.ok(!l.includes('\n'), `这一行里有换行：${JSON.stringify(l)}`)

  // **上限**：一面最多印 `READ_LIMIT` 行，掐掉的那一截在头一行说清楚。
  const small = facesOf(state, { limit: 3 })
  assert.equal(small.stream.lines.length, 3, '上限就是上限')
  assert.ok(small.stream.lines[0]?.includes('前面还有'), `掐掉了要说出来：${small.stream.lines[0]}`)
})

// ── ⑤ 契约正文那一面 ─────────────────────────────────────────────────────────────────

test('⑤ 契约正文那一面：账上那一条说得出的那几栏（写入面逐条 · 正文原文一行）', () => {
  const faces = facesOf(readStateOf(script()))
  const c = faces.contract
  assert.ok(c !== null, '这一份账里有一条 `contract/issue`')
  for (const l of c.lines) console.log(`⑤ ${l}`)
  assert.ok(c.lines[0]?.includes('契约 r1.implement.1 · 轮次 r1 · 归属 agent/r1/1'), '头一行是"哪一份 · 谁的"')
  assert.ok(c.lines.some((l) => l.includes('写入面 1 条（src/a.ts）')), '写入面逐条')
  assert.ok(c.lines.some((l) => l.includes('"goal":"写 a.ts"')), '正文原文在（一个字节都不改，只是折成一行）')

  const empty = facesOf(EMPTY_READ)
  assert.equal(empty.diff, null, '一条变更都没有：那一面是 `null`（不是空的一行）')
  assert.equal(empty.contract, null, '一份契约都没有：那一面是 `null`')
  assert.equal(firstFace(empty), 'stream', '都没有就看事件流')
})

// ── ⑥ 翻到哪一行（U14）：`stepTop` 夹住、到头停，翻页与跳首尾共用它 ──────────────
test('⑥ 翻到哪一行（U14）：±1 / ±PAGE_STEP / 跳首尾都夹住，到头停住不绕回', () => {
  // 30 行的正文：↑↓ ±1。
  assert.equal(stepTop(30, 10, 1), 11, '↓ 一行')
  assert.equal(stepTop(30, 10, -1), 9, '↑ 一行')
  // PgUp/PgDn ±PAGE_STEP。
  assert.equal(stepTop(30, 10, 4), 14, 'PgDn 半屏')
  assert.equal(stepTop(30, 10, -4), 6, 'PgUp 半屏')
  // Ctrl-Home/Ctrl-End：分发处给一个够大的数，`stepTop` 夹到端点。
  assert.equal(stepTop(30, 10, -30), 0, '跳到头')
  assert.equal(stepTop(30, 10, 30), 29, '跳到尾')
  // 到头停住（不绕回）：头再往上、尾再往下都是原地。
  assert.equal(stepTop(30, 0, -4), 0, '头上再翻还是头')
  assert.equal(stepTop(30, 29, 4), 29, '尾上再翻还是尾')
  // 越界的 top 先夹回来（分发处给的 top 永远在界内，这一条是它自己的把关）。
  assert.equal(stepTop(30, 99, 0), 29, '越界的 top 夹回末行')
  assert.equal(stepTop(0, 5, 4), 0, '一页都没有时给 0')
  console.log(`⑥ 读数：±1 · ±4 · 跳首尾 夹住到头停 · 越界 top 夹回`)
})
