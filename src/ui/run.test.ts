// TUI 的第二版第三格：**起命令**（PLAN § 5.19 第二版「二 · 按键」·「六 · 提交的四种去向」· 架构
// § 9.8「人的每个状态动作都是一条命令」）。跑法：cd ~/fugue && node --test src/ui/run.test.ts
//
// 这一份量的五样：
//
//   ① **一行字 → argv**：输入行敲的那一行与手敲的 `fugue --root <dir> <命令> <参数…>` **逐字相同** ·
//      不过 shell（`$HOME` 不展开 · `;` 不分成两条 · 引号里那个空格不进切分）· `Say` 那一档整句
//      落进 `say` 那一条命令的一个参数；认不出来的三档（空行 · 引号没闭合 · 行首 `!`）**各说一句
//      为什么**。
//   ② **起一次命令那一半**：argv 与手敲同形 · 跑着的时候按不起了第二次（同一个口只起一次进程）·
//      一行一行地收（跨块切开的行也要接起来）· 起不来与退了都报得出来。
//   ③ **账逐字节相同**（真子进程 · 夹具档 · 不花钱）：一个停在门口的靶子拷成两半，一半手敲
//      `round go`、一半给界面那一行字（真 `openRun` → 真子进程），两份账逐字节相同；**负对照**：
//      界面自己往账上写一条 `round/approve` 的那一版，账与手敲的那一版不同（而且契约一条都没发
//      出去）——这一条就是"界面不写日志、不持写句柄"那把尺的牙。
//   ④ **请它停下**（`T5` 取消链第二级）：没在跑的时候一个信号都不发 · 跑着的时候信号递到子进程
//      手里 · **请了不等于停了**（`running` 要等它真死）· 被信号杀掉的那一趟收尾是"退出码没有"。
//   ⑤ **有界地补一刀**（`T7`）：`SIGINT` 之后那一趟还没死就补一发 `SIGKILL`（同一个口递下去）；
//      **它自己死了就不补**（负对照那一档量的是它）· 给别的信号就直接发，不排那一刀。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { mock } from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { waitUntil } from '../../test/helpers/wait.ts'
import { openLog } from '../log/log.ts'
import type { WriterId } from '../terms.ts'
import type { LineMode, RunOutcome, SpawnFn } from './run.ts'
import { GO_LINE, lineArgvOf, openRun, selfArgvOf } from './run.ts'

/** 品牌类型那一栏（`RoundId` 一类）：这一份里那些值是拿来喂接口的，不是账上真发生过的。 */
const brand = (v: string): never => v as never

// ── ① 一行字 → argv ──────────────────────────────────────────────────────────
test('① 一行字翻成 argv：与手敲的那一条逐字相同 · 不过 shell · 认不出来就说出为什么', () => {
  const self = ['node', '/x/fugue.ts']
  const at = (line: string, mode?: LineMode): readonly string[] => lineArgvOf({ self, root: '/tmp/r', line, mode }).argv
  const handTyped = ['node', '/x/fugue.ts', '--root', '/tmp/r', 'round', 'go']
  assert.deepEqual(at('round go'), handTyped, '与手敲的 `fugue --root /tmp/r round go` 同一串')
  assert.deepEqual(at('/round go'), handTyped, '行首那个 `/` 是模式记号，不进 argv')
  assert.deepEqual(at('  round   go  '), handTyped, '多打的空白不算参数')
  assert.deepEqual(
    at('--agent r1 round go'),
    ['node', '/x/fugue.ts', '--root', '/tmp/r', '--agent', 'r1', 'round', 'go'],
    '旗子按人打的次序落在命令前面（与手敲同形）',
  )
  assert.deepEqual(
    at('commit -m "两个 词"'),
    ['node', '/x/fugue.ts', '--root', '/tmp/r', 'commit', '-m', '两个 词'],
    '引号里那一个空格不进切分：一个词就是一个参数',
  )
  assert.deepEqual(
    at('你好 世界', 'Say'),
    ['node', '/x/fugue.ts', '--root', '/tmp/r', 'say', '你好 世界'],
    '`Say` 那一档整句落进 `say` 那一条命令的一个参数（一个字都不切）',
  )
  // 认不出来的三档：空行 · 引号没闭合 · 行首 `!`——**各说一句为什么**（安静丢掉会让人以为"按下去
  // 没反应"）。
  const bad: readonly (readonly [string, string])[] = [
    ['   ', '空'],
    ['commit -m "没关引号', '引号没闭合'],
    ['!ls -la', '`!`'],
  ]
  for (const [line, want] of bad) {
    const cut = lineArgvOf({ self, root: '/tmp/r', line })
    assert.equal(cut.argv.length, 0, `这一行不该有 argv：${JSON.stringify(line)}`)
    assert.ok(cut.why !== null && cut.why.includes(want), `${line} 的 why 该提到「${want}」：${String(cut.why)}`)
  }
  // 负对照：真过 shell 会多出来的那些东西——`$HOME` 会被展开、`;` 会把一行变成两条命令。
  const sneaky = lineArgvOf({ self, root: '/tmp/r', line: 'say $HOME; rm -rf /' })
  assert.deepEqual([...sneaky.words], ['say', '$HOME;', 'rm', '-rf', '/'], 'argv 里就是这几个词，一个都没被 shell 动过')
  assert.equal(sneaky.words.includes(process.env['HOME'] ?? '\u0000'), false, '环境变量不许在界面这一层展开')
  console.log(
    `① 读数：${handTyped.join(' ')} ← "round go" / "/round go" / "--agent r1 round go" · ` +
      `引号里那个空格留住 · Say 那一档整句进一个参数 · 三种认不出来的各有一句 why`,
  )
})

// ── ② 起一次命令那一半 ───────────────────────────────────────────────────────
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

async function* from(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c
}

function scripted(o: {
  readonly out?: readonly Uint8Array[]
  readonly err?: readonly Uint8Array[]
  readonly code?: number | null
  readonly why?: string
}): { readonly spawn: SpawnFn; readonly calls: readonly string[] } {
  const calls: string[] = []
  const spawn: SpawnFn = (file, args) => {
    calls.push(`${file} ${args.join(' ')}`)
    return {
      out: o.out === undefined ? null : from(o.out),
      err: o.err === undefined ? null : from(o.err),
      done: Promise.resolve({ code: o.code === undefined ? 0 : o.code, why: o.why ?? null }),
      // 这一档的进程**一按就收尾**（`done` 当场 resolve），所以停不住它——量 `stop()` 的那一档是
      // 下面 `held()`（`done` 捏在测试手里）。
      stop: () => {},
    }
  }
  return { spawn, calls }
}

test('② 起一次命令：argv 与手敲同形 · 跑着的时候按不起了第二次 · 一行一行地收 · 起不来也报得出来', async () => {
  assert.deepEqual(
    lineArgvOf({ self: ['node', '/x/fugue.ts'], root: '/tmp/r', line: GO_LINE }).argv,
    ['node', '/x/fugue.ts', '--root', '/tmp/r', 'round', 'go'],
  )
  // `selfArgvOf` 给的是绝对路径（子进程的 cwd 与这一趟不一定相同）。
  assert.deepEqual(selfArgvOf(['node', 'src/cli/fugue.ts']), [process.execPath, join(process.cwd(), 'src/cli/fugue.ts')])

  const s = scripted({
    // 一块里切开两处：第 1 行被拆在两个字块之间，第 2 行与第 1 行同块。
    out: [bytes('1\tbase\t放行：1 份'), bytes('契约\n  契约 a\tagent/r1/1\n'), bytes('尾巴没有换行')],
    err: [bytes('一句警告\n')],
    code: 0,
  })
  const lines: string[] = []
  let finished: RunOutcome | null = null
  let settle: () => void = () => {}
  const done = new Promise<void>((r) => {
    settle = r
  })
  const run = openRun({
    root: '/tmp/r',
    self: ['node', '/x/fugue.ts'],
    spawn: s.spawn,
    onLine: (l) => lines.push(l),
    onDone: (r) => {
      finished = r
      settle()
    },
  })
  assert.equal(run.press(GO_LINE), true, '第一次按该起得来')
  assert.equal(run.running, true)
  assert.equal(run.press(GO_LINE), false, '跑着的时候又起了一次（同一条命令叠了第二个进程）')
  assert.equal(run.press('   '), false, '认不出来的那一行也起不动（空行）')
  await done
  assert.deepEqual(s.calls, ['node /x/fugue.ts --root /tmp/r round go'], `起命令那一头拿到的是 ${s.calls.join(' · ')}`)
  // **两条流之间的先后不承诺**（两个管道没有共同次序）：这里只钉"每一条流自己的次序"。
  assert.deepEqual(lines.filter((l) => l !== '一句警告'), ['1\tbase\t放行：1 份契约', '  契约 a\tagent/r1/1', '尾巴没有换行'])
  assert.ok(lines.includes('一句警告'), `stderr 那一句没收到：${lines.join(' · ')}`)
  assert.deepEqual(finished, { code: 0, why: null })
  assert.equal(run.running, false, '收尾之后还是"跑着"')

  // 起不来那一档：退出码是"没有"，不是 0；那句话传得出来。
  const bad = scripted({ why: 'spawn node ENOENT', code: null })
  let badOutcome: RunOutcome | null = null
  const bad1 = openRun({
    root: '/tmp/r',
    self: ['node', '/x/fugue.ts'],
    spawn: bad.spawn,
    onLine: () => {},
    onDone: (r) => {
      badOutcome = r
    },
  })
  bad1.press(GO_LINE)
  await waitUntil(() => badOutcome !== null, 500, '起不来的那一趟也该报出收尾（onDone）')
  assert.deepEqual(badOutcome, { code: null, why: 'spawn node ENOENT' })
  console.log(
    `② 读数：argv「${lineArgvOf({ self: ['node', '/x/fugue.ts'], root: '/tmp/r', line: GO_LINE }).argv.join(' ')}」· ` +
      `跨块切开的 3 条行 + stderr 1 条都接上了 · 第二次按起不动（1 次进程）· 起不来报 ${String(badOutcome?.why ?? '')}`,
  )
})

// ── ③ 账逐字节相同（真子进程 · 夹具档）────────────────────────────────────────
const CLI = fileURLToPath(new URL('../cli/fugue.ts', import.meta.url))

const DRAFT_MD = [
  '## 一 · 写 a.ts',
  '',
  '```json',
  JSON.stringify(
    {
      kind: 'implement',
      goal: '写一份 a.ts',
      ownedPaths: ['a.ts'],
      deliverables: [{ path: 'a.ts', form: '一份文件' }],
      assertions: [{ name: '总是过', action: 'ok' }],
      seed: [],
    },
    null,
    2,
  ),
  '```',
].join('\n')

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** 一道命令：**只留 PATH 与 HOME**（这一份里没有一条断言靠环境里的凭据或配置）。 */
function fugue(root: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: '',
    maxBuffer: 1 << 26,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? '/tmp' },
  })
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

function tmpRoot(): string {
  const root = tmpDir('fugue-run-')
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  return root
}

/** 一个停在门口等人点头的靶子：底 + 一份写进视图的草案 → `round plan --judge`（停 · 一条契约不发）。 */
function gatedRoot(): string {
  const root = tmpRoot()
  const outside = tmpDir('fugue-run-src-')
  const bottom = join(outside, 'bottom.txt')
  writeFileSync(bottom, '底。\n')
  assert.equal(fugue(root, 'write', 'README.md', '--from', bottom).code, 0)
  assert.equal(fugue(root, 'commit', '-m', '底').code, 0)
  assert.equal(
    fugue(root, 'config', 'set', 'actions.ok', JSON.stringify({ argv: ['/bin/sh', '-c', 'true'], outputs: [] })).code,
    0,
  )
  const draft = join(outside, 'r1.md')
  writeFileSync(draft, DRAFT_MD)
  const wrote = fugue(root, 'write', '.fugue/plan/r1.md', '--from', draft)
  assert.equal(wrote.code, 0, `把草案写进视图那一趟退了 ${wrote.code}：${wrote.stderr}`)
  const plan = fugue(root, '--json', 'round', 'plan', '写一份 a.ts', '--judge')
  assert.equal(plan.code, 0, `round plan 退了 ${plan.code}：${plan.stderr}`)
  assert.equal((JSON.parse(plan.stdout) as { held: boolean }).held, true, '这一趟该停在门口')
  return root
}

/** 账上那一串（一行一条，原样）：**这就是"逐字节"里那个字节**。没有账时是空串。 */
function accountOf(root: string): readonly string[] {
  const at = join(root, '.fugue', 'log', 'round.jsonl')
  if (!existsSync(at)) return []
  return readFileSync(at, 'utf8').split('\n').filter((l) => l !== '')
}

test('③ 界面那一行字与手敲 round go 落下的账逐字节相同（负对照：界面自己往账上写 → 当场不同）', async () => {
  const gate = gatedRoot()
  // 三个孪生放在一个**登记过**的目录里：`tmpDir` 那张清理表是按目录收的（`test/helpers/tmp.ts`
  // 头上那段说的就是这件事——平铺着建就会攒在 `/tmp` 里，谁也不去看）。
  const box = tmpDir('fugue-run-twins-')
  const hand = join(box, 'hand')
  const byLine = join(box, 'line')
  const naive = join(box, 'naive')
  for (const t of [hand, byLine, naive]) cpSync(gate, t, { recursive: true })
  assert.deepEqual(accountOf(hand), accountOf(byLine), '拷出来的两半一开始就该是同一份账')

  // 一 · 手敲：`fugue --root <dir> round go`
  const typed = fugue(hand, 'round', 'go')
  assert.equal(typed.code, 0, `手敲那一趟退了 ${typed.code}：${typed.stderr}`)

  // 二 · 界面那一行字：真 `openRun`（给 `round go`）→ 真子进程
  const lines: string[] = []
  let settle: () => void = () => {}
  const done = new Promise<void>((r) => {
    settle = r
  })
  const run = openRun({
    root: byLine,
    self: [process.execPath, CLI],
    onLine: (l) => lines.push(l),
    onDone: () => settle(),
  })
  assert.equal(run.argvOf(GO_LINE).argv.join(' '), [process.execPath, CLI, '--root', byLine, 'round', 'go'].join(' '), '界面这一条与手敲那一条同形')
  assert.equal(run.press(GO_LINE), true, '这一行该起得来')
  await done

  const a = accountOf(hand)
  const b = accountOf(byLine)
  assert.deepEqual(b, a, `界面那一行与手敲落下的账不同：手敲 ${a.length} 条 · 界面 ${b.length} 条`)
  assert.ok(a.length > 0, '两半的账都是空的——这一条量不到东西')
  const types = (rows: readonly string[]): readonly string[] => rows.map((l) => (JSON.parse(l) as { t: string }).t)
  assert.ok(types(a).includes('round/approve'), `手敲那一趟账上没有放行那一笔：${types(a).join(' ')}`)
  assert.equal(types(a).filter((t) => t === 'contract/issue').length, 1, `契约发出去的条数不对：${types(a).join(' ')}`)

  // 三 · 负对照：界面自己往账上写一条 `round/approve`（**这一档手里没有写句柄的那件事的反面**）
  const log = openLog(naive)
  await log.append('round' as WriterId, { t: 'round/approve', round: brand('r1'), fingerprint: 'naive', contracts: [] })
  await log.close()
  const c = accountOf(naive)
  assert.notDeepEqual(c, a, '界面自己写的那一版与手敲的那一版账相同——这把尺没有牙')
  assert.equal(types(c).includes('contract/issue'), false, '自己写一条放行就把契约发出去了？')

  console.log(
    `③ 读数：手敲那一趟账 ${a.length} 条（${types(a).join(' ')}）· 界面那一行 ${b.length} 条 · 两串逐字节相同；` +
      `界面自己写一条 round/approve 的那一版 ${c.length} 条、契约 0 条——与手敲那一版不同`,
  )
})

// ── ④ 请它停下（`T5` 取消链第二级）────────────────────────────────────────────
//
// 链那一头（`ui/cancel.ts` 的 `escStepOf`/`ctrlCStepOf`）说"这一下该打断"之后，落地的那一下就是
// `RunLauncher.stop()`。这一条量的就是它：**没在跑的时候一个信号都不许发出去**——不然"弹层开着时
// `Esc` 只关弹层"那把尺在链那一头是对的、在这一头就漏了；跑着的时候信号递到子进程手里；
// **请了不等于停了**（`running` 要等它真死——不许这一趟还在死、下一趟就起来）。
function held(): {
  readonly spawn: SpawnFn
  readonly calls: string[]
  readonly signals: string[]
  readonly finish: (o?: { readonly code?: number | null; readonly why?: string }) => void
} {
  const calls: string[] = []
  const signals: string[] = []
  let res: (r: RunOutcome) => void = () => {}
  const spawn: SpawnFn = (file, args) => {
    calls.push(`${file} ${args.join(' ')}`)
    const done = new Promise<RunOutcome>((r) => {
      res = r
    })
    return { out: null, err: null, done, stop: (signal: string) => signals.push(signal) }
  }
  return {
    spawn,
    calls,
    signals,
    finish: (o = {}) => res({ code: o.code === undefined ? null : o.code, why: o.why ?? null }),
  }
}

test('④ 请它停下：没在跑就一个信号都不发 · 跑着时递到子进程 · 请了不等于停了 · 收尾是"被信号杀掉"那一档', async () => {
  const h = held()
  let finished: RunOutcome | null = null
  let settle: () => void = () => {}
  const done = new Promise<void>((r) => {
    settle = r
  })
  const run = openRun({
    root: '/tmp/r',
    self: ['node', '/x/fugue.ts'],
    spawn: h.spawn,
    onLine: () => {},
    onDone: (r) => {
      finished = r
      settle()
    },
  })
  // 空闲那一下：什么都没发生。这一条是"弹层开着时 `Esc` 只关弹层"在**这一头**的牙——链说 overlay，
  // 这一头就不该冒出信号来。
  assert.equal(run.stop(), false, '没在跑：什么都不做（返回 false，于是调用方不必自己先判 running）')
  assert.deepEqual(h.signals, [], '没在跑的那一下一个信号都不许发出去')
  assert.deepEqual(h.calls, [], '没在跑的那一下也不该起进程')
  assert.equal(run.press(GO_LINE), true, '这一行该起得来')
  assert.equal(run.running, true)
  assert.equal(run.stop(), true, '跑着：请了')
  assert.deepEqual(h.signals, ['SIGINT'], '缺省那一下是 SIGINT（先礼后兵的那一下）')
  assert.equal(run.stop('SIGKILL'), true, '再请一次还是请得动（幂等：不抛）')
  assert.deepEqual(h.signals, ['SIGINT', 'SIGKILL'], `两下都递到子进程手里了：${h.signals.join(' · ')}`)
  assert.equal(run.running, true, '**请了不等于停了**：它还没死之前 `running` 一直是 true')
  assert.equal(run.press(GO_LINE), false, '还在死的那一趟压着，第二次起不动')
  h.finish({ code: null })
  await done
  assert.deepEqual(finished, { code: null, why: null }, '被信号杀掉：退出码是"没有"（不是 0）')
  assert.equal(run.running, false, '真死了之后才落到"没在跑"')
  assert.equal(run.stop(), false, '已经死了：又是"没在跑"')
  assert.deepEqual(h.signals, ['SIGINT', 'SIGKILL'], '死了之后又请的那一下没有多出信号')
  console.log(
    `④ 读数：空闲 stop 0 个信号 0 次进程 · 跑着时 SIGINT 与 SIGKILL 各递 1 次 · 请过之后 running 仍是 true` +
      `（第二次 press 起不动）· 收尾 ${JSON.stringify(finished)} 之后 stop 又从 false 起算`,
  )
})

// ── ⑤ 有界地补一刀（`T7`）────────────────────────────────────────────────────
//
// `SIGINT` 是**请求**：一个卡在系统调用里、或者自己把 `SIGINT` 关掉的子进程可以永远不理它。所以礼
// 之后有一刀，而那一刀**有界**（`KILL_AFTER_MS`，测试里给 20 毫秒，不必真等两秒）。两条负对照：
// 它自己收尾了就不补（不许往一个可能已被复用的 pid 上发）· 给别的信号就直接发、不排那一刀。
test('⑤ 打断了之后有界地补一刀：`SIGINT` 之后还没死就发 `SIGKILL` · 自己死了就不发', async () => {
  // 杀窗是 `run.ts` 里那个裸 `setTimeout`（`killAfterMs`，测试给 20 毫秒）：全趟换假钟——窗口到没到
  // 用 tick 兑现，不再赌「睡 60ms 应该够」。负对照也因此更硬：tick 过窗还没发，证明的是
  // `kid === target && running` 那道守卫真的在，而不是「恰好没等到」。
  // 微事件（`done` 传到 `onDone` 那一串）不经定时器，用 setImmediate 放干——它不在假钟的 apis 里。
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    // 一 · 不收尾的那一趟：礼之后那一刀到。
    const h = held()
    const run = openRun({
      root: '/tmp/r',
      self: ['node', '/x/fugue.ts'],
      spawn: h.spawn,
      killAfterMs: 20,
      onLine: () => {},
      onDone: () => {},
    })
    assert.equal(run.press(GO_LINE), true)
    assert.equal(run.stop(), true)
    assert.deepEqual(h.signals, ['SIGINT'], '礼先到')
    mock.timers.tick(21)
    assert.deepEqual(h.signals, ['SIGINT', 'SIGKILL'], `礼之后那一刀该到：${h.signals.join(' · ')}`)
    assert.equal(run.running, true, '它一直没收尾，于是这一档照旧是"跑着"')
    h.finish({ code: null })
    await settle()
    assert.equal(run.running, false)
    // 二 · **负对照**：它自己收尾了就不补那一刀。
    const h2 = held()
    const run2 = openRun({
      root: '/tmp/r',
      self: ['node', '/x/fugue.ts'],
      spawn: h2.spawn,
      killAfterMs: 20,
      onLine: () => {},
      onDone: () => {},
    })
    assert.equal(run2.press(GO_LINE), true)
    assert.equal(run2.stop(), true)
    h2.finish({ code: null })
    await settle()
    mock.timers.tick(21)
    assert.deepEqual(h2.signals, ['SIGINT'], `自己死了就不许补那一刀：${h2.signals.join(' · ')}`)
    // 三 · 给别的信号：直接发，不排那一刀（那是"兵"，不是"礼"）。
    const h3 = held()
    const run3 = openRun({
      root: '/tmp/r',
      self: ['node', '/x/fugue.ts'],
      spawn: h3.spawn,
      killAfterMs: 20,
      onLine: () => {},
      onDone: () => {},
    })
    assert.equal(run3.press(GO_LINE), true)
    assert.equal(run3.stop('SIGKILL'), true)
    mock.timers.tick(21)
    assert.deepEqual(h3.signals, ['SIGKILL'], `给兵就发兵，不排那一刀：${h3.signals.join(' · ')}`)
    h3.finish({ code: null })
    await settle()
  } finally {
    mock.timers.reset()
  }
  console.log(
    `⑤ 读数：假钟 tick 过 20ms 杀窗——SIGINT 之后补上 SIGKILL（不收尾那一趟）· ` +
      `自己收尾的那一趟只有 SIGINT（tick 过窗仍不发）· 直接给 SIGKILL 的那一趟只有 SIGKILL`,
  )
})
