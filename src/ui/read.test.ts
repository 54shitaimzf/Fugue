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
//   ⑧ **详情面**（第二幕 ⑧）：主面收掉的那几样原始读数（图上走了几步 · 内核拒 · 边界挡 ·
//      最近）——印的与 `statusOf` 折出来的**同一个数**；**不给快照就没有这一面**，`Tab` 也跳过它。
//   ⑦ **折行与洁净**（0.2.8 U1）：`readWrap` 把一行折成物理行——**拼回来逐字节相等**（`glyph.wrap`
//      折在词尾、还会吃空白与行首那个 `· `，正文一个字节都不能少，所以这一面自己折）· 切点整簇
//      （一个 emoji 不许拆成两半）· 控制字节先转义（`[\x00-\x1f\x7f-\x9f]` → `\uXXXX`）再量宽
//      ——ESC 序列不再原样落终端。负对照：旧版是未折的原文由框那一层截断（尾部丢），或走通用折行（吃字节）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { runCli } from '../../test/helpers/run-cli.ts'
import { tmpDir } from '../../test/helpers/tmp.ts'
import type { LogEvent } from '../log/events.ts'
import { openLog } from '../log/log.ts'
import { rowsOf, statusOf } from '../probe/status.ts'
import { WORDS } from '../words.ts'
import type { StatusRow } from '../probe/status.ts'
import type { AgentId, BlobId, RoundId, ViewRev, WriterId } from '../terms.ts'
import { clip, clustersOf, widthOf, wrap } from './glyph.ts'
import {
  DELTA_FACE,
  EMPTY_READ,
  READ_LIMIT,
  escapeOf,
  faceKeyOf,
  faceOfDelta,
  faceRowsOf,
  facesOf,
  firstFace,
  prefixOk,
  readStateOf,
  readWrap,
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
// ── ⑦ 折行与洁净（0.2.8 U1）：往返 · 整簇 · 控制字节先转义 ──────────────────────────────
test('⑦ 折行与洁净：物理行拼回原文逐字节相等 · 切点整簇 · 控制字节先转义再量宽', () => {
  // **往返**（不折在词尾、不吃空白）：折出来的物理行拼回去，与进去的那一串逐字节相等。
  // 负对照：回到旧版（未折的原文交给框那一层 `clip`）——尾部丢了，这一条当场红。
  const cases: readonly string[] = [
    '账上那一行 · 写 src/a.ts · rev 1',
    'a  b   c · d',
    '中文与英文混排 ascii 与 空格',
    '👨‍👩‍👧 一家三口 + 👩‍💻 与 xxxxxxxxxx',
    '没有空格的一整段xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  ]
  for (const s of cases) {
    for (const cols of [1, 2, 3, 5, 7, 12, 40]) {
      const lines = readWrap(s, cols)
      assert.equal(lines.join(''), s, `cols=${cols} 拼回来该逐字节相等：${JSON.stringify(lines)}`)
      // 每一条物理行都停在**簇边界**上（一个 emoji 不许被拆成两半）。
      let at = 0
      for (const one of lines) {
        at += one.length
        assert.ok(
          clustersOf(s).some((c) => c.end === at),
          `cols=${cols} 时第 ${at} 个 code unit 不在簇边界上（把一个字拆开了）：${JSON.stringify(lines)}`,
        )
      }
      // 宽度守得住：放得下就 ≤ cols；一整个簇比 cols 还宽时恰放一个整簇（不许原地打转）。
      for (const one of lines) {
        assert.ok(
          widthOf(one) <= cols || clustersOf(one).length === 1,
          `cols=${cols} 这一行超宽了：${JSON.stringify(one)}`,
        )
      }
    }
  }
  console.log(`⑦ 读数：${cases.length} 串 × 7 档列宽（1–40）：拼回来逐字节相等 · 切点全在簇边界上`)

  // **控制字节先转义**（不可见字节不许原样落终端）：`\x1b` 变成能读的 `\u001b`，原字符一个不留，
  // 而宽度按**转义之后**那几个字符算——折行因此不会被不可见字节骗过去。
  const raw = 'a\x1bb[2Jc\x07\x00\x9b'
  const escaped = 'a\\u001bb[2Jc\\u0007\\u0000\\u009b'
  const one = readWrap(raw, 80)
  assert.equal(one.length, 1, '80 列一幅装得下')
  assert.equal(one[0], escaped, '每一个控制字节都换成了可见形状')
  assert.equal(widthOf(one[0] as string), escaped.length, '宽度按转义后的字符算（全是单列字符）')
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(one[0] as string), '整幅里一个控制字节都没有')
  const narrow = readWrap(raw, 7)
  assert.equal(narrow.join(''), escaped, '转了义之后照样折得回来（仍是逐字节往返）')
  assert.equal(narrow[0], 'a\\u001b', '折在 7 列上：整簇切（这一行恰 7 列）')
  assert.ok(narrow.every((l) => widthOf(l) <= 7), '每一行都在列宽里')
  assert.equal(escapeOf('\u0000'), '\\u0000', '零字节也有可见形状（它就是撕帧的那一个）')
  console.log(`⑦ 读数：转义档 ${JSON.stringify(raw)} → ${JSON.stringify(narrow)}`)

  // **面那一层接上了它**：`faceRowsOf` 把标题与每一行都折进 `cols`——折开的那一份拼起来，与不折
  // 的那一份全等（一条正文都不许少）。
  const faces = facesOf(readStateOf(script()))
  const plain = [faces.stream.title, ...faces.stream.lines]
  const wide = faceRowsOf(faces, 'stream', 200)
  const boxed = faceRowsOf(faces, 'stream', 24)
  assert.deepEqual([...wide], [...plain], '宽到装得下时一行都不折')
  assert.equal(boxed.join(''), plain.join(''), '窄列只是折开，一个字节都不丢')
  assert.ok(boxed.length > wide.length, `窄列该折出更多物理行（宽 ${wide.length} · 窄 ${boxed.length}）`)
  for (const l of boxed) assert.ok(widthOf(l) <= 24, `窄列那一档每一行都在 24 列里：${JSON.stringify(l)}`)
  console.log(`⑦ 读数：事件流那一面 200 列 ${wide.length} 行 · 24 列 ${boxed.length} 行（拼回去全等）`)

  // **回不到旧版**（两条旧路各自必红）：旧版显示端是 `clip`（吃尾部、留一个 `…`），通用折行是
  // `glyph.wrap`（吃空白 · 吃行首那个 `· ` · 不转义）。正文一个字节都不许少，所以这一面自己折。
  assert.notEqual(clip('abcdef', 3), 'abcdef', '旧版显示端截断：尾部没了（往返断言当场红）')
  assert.notEqual(wrap('a  b · c', 3).join(''), 'a  b · c', '通用折行吃空白与 `· `——正文不能走它')
  assert.ok(wrap('a\x1bb', 40).join('').includes('\x1b'), '通用折行不转义：ESC 原样落终端（这一面自己转义）')
})
// ── ⑧ 折行改写（U1 补记）：整行只聚簇一次（长行照样是线性） ─────────────────────────────
test('⑧ 折行改写（U1 补记）：长行照样逐字节往返 · 行数就是列宽除出来的那个数', () => {
  // **值这一半照旧**：一行多长都拼得回来、每一行都在列宽里、行数就是除出来的那个数。
  for (const n of [4008, 40_080]) {
    const long = 'x'.repeat(n)
    for (const cols of [20, 37, 80]) {
      const lines = readWrap(long, cols)
      assert.equal(lines.join(''), long, `${n} 字符 @ ${cols} 列：拼回来逐字节相等`)
      assert.equal(lines.length, Math.ceil(n / cols), `${n} 字符 @ ${cols} 列：行数就是除出来的那个数`)
      for (const one of lines) assert.ok(widthOf(one) <= cols, `超宽：${one.length}`)
    }
  }
  const mixed = '中文与 emoji 👩‍💻 混排'.repeat(400)
  const mixedRows = readWrap(mixed, 24)
  assert.equal(mixedRows.join(''), mixed, '混排的长行也逐字节往返')
  assert.ok(mixedRows.every((l) => widthOf(l) <= 24), '混排的每一行都在列宽里（宽簇不拆）')
  console.log(
    `⑧ 读数：4008 字符 @ 20 列 ${readWrap('x'.repeat(4008), 20).length} 行 · ` +
      `40080 字符 @ 20 列 ${readWrap('x'.repeat(40_080), 20).length} 行 · 混排 ${mixed.length} 字符 @ 24 列 ${mixedRows.length} 行`,
  )

  // **"长度不炸"这一条是这份折法的形状**（整行只聚簇一次），**它的对手是"慢"，不是"红"**：
  // 逐段调 `cutAt`/`widthOf` 那一版上面这些值照样全对，只是一次调用 6 秒以上（实测：一份 200 条
  // 4008 字符的 `view/write`、20 列，`faceRowsOf` 一次 >6 s）。所以这一格没有"回到旧版必红"的
  // 断言——读数记在提交信息里，口径写在 `readWrap` 的头注上（什么条件下改主意：那些读数回到秒级
  // 就说明有人把它写回逐段聚簇了）。
})

// ── ⑧ 详情面（第二幕 ⑧）：主面收掉的那几样原始读数 ──────────────────────────────
test('⑧ 详情面：图上走了几步 · 内核拒 · 边界挡 · 最近——数与 `statusOf` 同一处算出来（不给快照就没有这一面）', () => {
  seq = 0
  const r1 = 'r1' as RoundId
  const rows: readonly StatusRow[] = [
    row({ t: 'round/state', round: r1, from: 'Idle' as never, to: 'Planning' as never }),
    row({ t: 'round/state', round: r1, from: 'Planning' as never, to: 'Delegated' as never }),
    row({ t: 'round/state', round: r1, from: 'Verifying' as never, to: 'Rebuilding' as never }),
    row({ t: 'run/end', agent: A, step: '1' as never, exit: 1, ms: 5, denied: true }, A),
    row({ t: 'bound/deny', agent: A, path: 'etc/passwd' as never, rule: 'scope' as never, space: 'virtual' as never }, A),
  ]
  const snap = statusOf(rows)
  // 这一条量的是**同一个数**：详情面印的就是 `statusOf` 折出来的那几栏（不是另一处再算一遍）。
  assert.equal(snap.agents[0]?.denies, 1, '一处 `run/end` 带 `denied` → denies 1')
  assert.equal(snap.agents[0]?.bounds, 1, '一条 `bound/deny` → bounds 1')
  assert.equal(snap.agents[0]?.last, 'bound/deny', '那一格最后一条事件就是它')
  assert.equal(snap.rounds[0]?.hops, 4, '三条转移：1 ＋ 1 ＋ 2 ＝ 4 步（跳步那一条按最短路算）')
  const faces = facesOf(readStateOf(rows, { snapshot: snap }))
  assert.ok(faces.detail !== null, '给了快照就有详情面')
  const text = (faces.detail?.lines ?? []).join('\n')
  for (const want of ['图上走了 4 步', `${WORDS.denies} 1`, `${WORDS.bounds} 1`, `${WORDS.last} bound/deny`]) {
    assert.ok(text.includes(want), `详情面上少了这一处「${want}」：\n${text}`)
  }
  // 不给快照：那一面是 `null`（"没有"与"有但是空的"分得开），而且 `Tab` 跳过它。
  const bare = facesOf(readStateOf(rows))
  assert.equal(bare.detail, null, '不给快照就没有详情面')
  assert.equal(stepFace(bare, 'stream', 1), 'stream', '三面都没有时照旧停在 `stream`（详情面不在环里）')
  assert.equal(stepFace(faces, 'stream', 1), 'detail', '给了快照：环里多了详情这一面')
  assert.equal(stepFace(faces, 'detail', 1), 'stream', '详情之后绕回来')
  console.log(`⑧ 读数：${(faces.detail?.title ?? '').split('（')[0]} · ${faces.detail?.lines.length ?? 0} 行 · 不给快照 → 那一面是 null`)
})
