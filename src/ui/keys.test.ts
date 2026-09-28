// TUI 的第五格：**门那儿按一下**（PLAN § 5.19 第五段 `UI4` 那一行 · 架构 § 9.8「人的每个状态动作
// 都是一条命令」）。跑法：cd ~/fugue && node --test src/ui/keys.test.ts
//
// 这一份量的五样：
//
//   ① **表**：动作联合里的每一个动作都有键 · 每一个键都落在一个动作上 · 每个动作都有一句短提示
//      （`HINT_OF`）· **没有两个键抢同一个字节**（抢了就是"按了这个出来那个"）· 提示那一行由表推
//      出来（加一条键它就跟着变——命令面上那一行与真认的那几个字节不许有两份）。
//   ② **解码**：字母 · 控制字符（`Ctrl-C`/`Ctrl-D`）· 一串里好几个动作 · 认不出来的字节安静丢掉；
//      负对照是这一份最容易错的地方：**`ESC` 起头的那一段整段吃掉**——方向键（`ESC [ A`）· 终端
//      报出来的组合键（`ESC [ 27;5;103~`，那是 Ctrl-Alt-g）· `Alt-q`（`ESC q`）都不是按键。
//   ③ **raw mode 的开与关**：TTY 上开 · 关的时候归位且摘监听（**负对照：不摘监听的话，关掉之后
//      再喂一个字节还会触发动作**）· `close()` 幂等 · 不是 TTY 就一个字节都不读（`on` 一次都不调）。
//   ④ **起命令那一半**：argv 与手敲的那一条同形 · 跑着的时候按不起了第二次（同一个口只起一次
//      进程）· 一行一行地收（跨块切开的行也要接起来）· 起不来与退了都报得出来。
//   ⑤ **账逐字节相同**（真子进程 · 夹具档 · 不花钱）：一个停在门口的靶子拷成两半，一半手敲
//      `round go`、一半按 `g`（真 `openKeys` → 真 `openGo` → 真子进程），两份账逐字节相同；
//      **负对照**：界面自己往账上写一条 `round/approve` 的那一版，账与手敲的那一版不同（而且
//      契约一条都没发出去）——这一条就是"界面不写日志、不持写句柄"那把尺的牙。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { openLog } from '../log/log.ts'
import type { WriterId } from '../terms.ts'
import type { GoOutcome, SpawnFn } from './go.ts'
import { goArgvOf, openGo, selfArgvOf } from './go.ts'
import type { Action, KeyInput } from './keys.ts'
import { ACTION_KEYS, HINT_OF, KEYS, actionsOf, escapeAt, keysHintOf, openKeys } from './keys.ts'

/** 品牌类型那一栏（`RoundId` 一类）：这一份里那些值是拿来喂接口的，不是账上真发生过的。 */
const brand = (v: string): never => v as never

// ── ① 表：动作与键两头都要对上 ────────────────────────────────────────────────
test('① 表：每个动作都有键 · 每个键都落在动作上 · 字节不重复 · 提示那一行由表推出来', () => {
  for (const a of ACTION_KEYS) {
    const keys = KEYS.filter((b) => b.action === a)
    assert.ok(keys.length > 0, `动作 ${a} 一条键都没有——它按不出来`)
    assert.ok((HINT_OF[a] ?? '') !== '', `动作 ${a} 没有短提示（提示那一行里会空一块）`)
  }
  for (const b of KEYS) {
    assert.ok(ACTION_KEYS.includes(b.action), `键 ${b.key} 落在一个不在动作联合里的动作上：${b.action}`)
    assert.ok(b.bytes.length > 0 && b.note !== '', `键 ${b.key} 没有字节或没有说明`)
  }
  const all = KEYS.flatMap((b) => [...b.bytes])
  assert.equal(new Set(all).size, all.length, `两个键抢了同一个字节：${all.join(' ')}`)
  const hint = keysHintOf()
  for (const a of ACTION_KEYS) assert.ok(hint.includes(HINT_OF[a]), `提示那一行里没有动作 ${a} 那一句：${hint}`)
  // 提示里写出来的键名就是表里那个（不是另写一遍）。
  assert.ok(hint.includes(KEYS[0]?.key ?? ''), `提示那一行里的键名与表对不上：${hint}`)
  console.log(`① 读数：动作 ${ACTION_KEYS.length} 个 · 键 ${KEYS.length} 条 · 字节 ${all.length} 个不重 · 提示「${hint}」`)
})

// ── ② 解码（负对照：序列不许被当成按键）──────────────────────────────────────
test('② 解码：字母 · 控制字符 · 一串好几个 · 序列整段吃掉（方向键 · Ctrl-Alt-g · Alt-q）', () => {
  const cases: readonly (readonly [string, readonly Action[]])[] = [
    ['g', ['go']],
    ['G', ['go']],
    ['q', ['quit']],
    ['\u0003', ['quit']],
    ['\u0004', ['quit']],
    ['?', ['help']],
    ['h', ['help']],
    ['gq', ['go', 'quit']],
    ['gg', ['go', 'go']],
    ['x\n中 5', []],
    ['\u001b[A', []],
    ['\u001b[1;5A', []],
    ['\u001b[27;5;103~', []],
    ['\u001b[<0;12;3M', []],
    ['\u001bq', []],
    ['\u001b', []],
    ['\u001b[', []],
    // `ESC g` 是 Alt-g（整两个字符吃掉），后面那个 `q` 照旧是按键——"吃掉一段"不是"吃掉后面那些"。
    ['\u001bgq', ['quit']],
  ]
  for (const [chunk, want] of cases) {
    assert.deepEqual(actionsOf(chunk), [...want], `${JSON.stringify(chunk)} 解出来不对`)
  }
  assert.equal(escapeAt('g', 0), 0)
  assert.equal(escapeAt('\u001b', 0), 1)
  assert.equal(escapeAt('\u001b[A', 0), 3)
  assert.equal(escapeAt('\u001b[27;5;103~', 0), 11)
  console.log('② 读数：19 条解码逐条对上（含 7 条序列负对照：方向键 · Ctrl-Alt-g · 鼠标报告 · Alt-q · Alt-g 后面那个 q · 半截）')
})

// ── ③ raw mode 的开与关 ───────────────────────────────────────────────────────
interface FakeInput extends KeyInput {
  readonly calls: string[]
  feed(s: string): void
}

function fakeInput(o: { readonly tty: boolean } = { tty: true }): FakeInput {
  const listeners = new Set<(chunk: string | Uint8Array) => void>()
  const calls: string[] = []
  const input: FakeInput = {
    calls,
    ...(o.tty ? { isTTY: true } : {}),
    setRawMode(raw: boolean): unknown {
      calls.push(`raw=${String(raw)}`)
      return undefined
    },
    on(_ev: 'data', l: (chunk: string | Uint8Array) => void): unknown {
      calls.push('on')
      listeners.add(l)
      return undefined
    },
    removeListener(_ev: 'data', l: (chunk: string | Uint8Array) => void): unknown {
      calls.push('off')
      listeners.delete(l)
      return undefined
    },
    feed(s: string): void {
      for (const l of [...listeners]) l(s)
    },
  }
  return input
}

test('③ raw mode：开 · 关的时候归位并摘监听（摘了就不再触发）· close 幂等 · 不是 TTY 一个字节都不读', () => {
  const got: Action[] = []
  const input = fakeInput()
  const keys = openKeys({ input, onAction: (a) => got.push(a) })
  assert.equal(keys.raw, true, 'TTY 上该进 raw mode')
  assert.deepEqual(input.calls, ['raw=true', 'on'], `开的时候调了这些：${input.calls.join(' ')}`)
  input.feed('g')
  input.feed('\u0003')
  assert.deepEqual(got, ['go', 'quit'])
  keys.close()
  assert.deepEqual(input.calls, ['raw=true', 'on', 'off', 'raw=false'], `关的时候调了这些：${input.calls.join(' ')}`)
  // 负对照：摘掉监听之后再喂一个字节，**一个动作都不该出来**（不摘的话这里会多一个 'go'）。
  input.feed('g')
  assert.deepEqual(got, ['go', 'quit'], '关掉之后还认得出按键——监听没摘干净')
  keys.close()
  assert.equal(input.calls.filter((c) => c === 'raw=false').length, 1, '`close()` 不幂等（raw mode 被归位两次）')
  // 地板：不是 TTY → 一个字节都不读。
  const piped = fakeInput({ tty: false })
  const quiet = openKeys({ input: piped, onAction: (a) => got.push(a) })
  assert.equal(quiet.raw, false)
  assert.deepEqual(piped.calls, [], `不是 TTY 却动了输入：${piped.calls.join(' ')}`)
  piped.feed('g')
  quiet.close()
  assert.deepEqual(got, ['go', 'quit'], '不是 TTY 的那一档认了按键')
  console.log(`③ 读数：TTY 上 ${input.calls.filter((c) => c === 'on' || c === 'off').length} 次监听调动 · 关掉之后再喂一个字节 0 个动作 · 不是 TTY ${piped.calls.length} 次调用`)
})

// ── ④ 起命令那一半 ───────────────────────────────────────────────────────────
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

async function* from(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c
}

function scripted(o: {
  readonly out?: readonly Uint8Array[]
  readonly err?: readonly Uint8Array[]
  readonly code?: number | null
  readonly why?: string
}): { readonly spawn: SpawnFn; readonly calls: readonly string[]; readonly lines: string[] } {
  const calls: string[] = []
  const spawn: SpawnFn = (file, args) => {
    calls.push(`${file} ${args.join(' ')}`)
    return {
      out: o.out === undefined ? null : from(o.out),
      err: o.err === undefined ? null : from(o.err),
      done: Promise.resolve({ code: o.code === undefined ? 0 : o.code, why: o.why ?? null }),
    }
  }
  return { spawn, calls, lines: [] }
}

test('④ 起一次命令：argv 与手敲同形 · 跑着的时候按不起了第二次 · 一行一行地收 · 起不来也报得出来', async () => {
  assert.deepEqual(goArgvOf({ self: ['node', '/x/fugue.ts'], root: '/tmp/r' }), ['node', '/x/fugue.ts', '--root', '/tmp/r', 'round', 'go'])
  // `selfArgvOf` 给的是绝对路径（子进程的 cwd 与这一趟不一定相同）。
  assert.deepEqual(selfArgvOf(['node', 'src/cli/fugue.ts']), [process.execPath, join(process.cwd(), 'src/cli/fugue.ts')])

  const s = scripted({
    // 一块里切开两处：第 1 行被拆在两个字块之间，第 2 行与第 1 行同块。
    out: [bytes('1\tbase\t放行：1 份'), bytes('契约\n  契约 a\tagent/r1/1\n'), bytes('尾巴没有换行')],
    err: [bytes('一句警告\n')],
    code: 0,
  })
  const lines: string[] = []
  let finished: GoOutcome | null = null
  let settle: () => void = () => {}
  const done = new Promise<void>((r) => {
    settle = r
  })
  const go = openGo({
    root: '/tmp/r',
    self: ['node', '/x/fugue.ts'],
    spawn: s.spawn,
    onLine: (l) => lines.push(l),
    onDone: (r) => {
      finished = r
      settle()
    },
  })
  assert.equal(go.press(), true, '第一次按该起得来')
  assert.equal(go.running, true)
  assert.equal(go.press(), false, '跑着的时候又起了一次（同一条命令叠了第二个进程）')
  await done
  assert.deepEqual(s.calls, ['node /x/fugue.ts --root /tmp/r round go'], `起命令那一头拿到的是 ${s.calls.join(' · ')}`)
  // **两条流之间的先后不承诺**（两个管道没有共同次序）：这里只钉"每一条流自己的次序"。
  assert.deepEqual(lines.filter((l) => l !== '一句警告'), ['1\tbase\t放行：1 份契约', '  契约 a\tagent/r1/1', '尾巴没有换行'])
  assert.ok(lines.includes('一句警告'), `stderr 那一句没收到：${lines.join(' · ')}`)
  assert.deepEqual(finished, { code: 0, why: null })
  assert.equal(go.running, false, '收尾之后还是"跑着"')

  // 起不来那一档：退出码是"没有"，不是 0；那句话传得出来。
  const bad = scripted({ why: 'spawn node ENOENT', code: null })
  let badOutcome: GoOutcome | null = null
  const bad1 = openGo({
    root: '/tmp/r',
    self: ['node', '/x/fugue.ts'],
    spawn: bad.spawn,
    onLine: () => {},
    onDone: (r) => {
      badOutcome = r
    },
  })
  bad1.press()
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(badOutcome, { code: null, why: 'spawn node ENOENT' })
  console.log(`④ 读数：argv「${(go.argv ?? []).join(' ')}」· 跨块切开的 3 条行 + stderr 1 条都接上了 · 第二次按起不动（1 次进程）· 起不来报 ${String(badOutcome?.why ?? '')}`)
})

// ── ⑤ 账逐字节相同（真子进程 · 夹具档）────────────────────────────────────────
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
  const root = tmpDir('fugue-keys-')
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  return root
}

/** 一个停在门口等人点头的靶子：底 + 一份写进视图的草案 → `round plan --judge`（停 · 一条契约不发）。 */
function gatedRoot(): string {
  const root = tmpRoot()
  const outside = tmpDir('fugue-keys-src-')
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

test('⑤ 按了 g 与手敲 round go 落下的账逐字节相同（负对照：界面自己往账上写 → 当场不同）', async () => {
  const gate = gatedRoot()
  // 三个孪生放在一个**登记过**的目录里：`tmpDir` 那张清理表是按目录收的（`test/helpers/tmp.ts`
  // 头上那段说的就是这件事——平铺着建就会攒在 `/tmp` 里，谁也不去看）。
  const box = tmpDir('fugue-keys-twins-')
  const hand = join(box, 'hand')
  const byKey = join(box, 'key')
  const naive = join(box, 'naive')
  for (const t of [hand, byKey, naive]) cpSync(gate, t, { recursive: true })
  assert.deepEqual(accountOf(hand), accountOf(byKey), '拷出来的两半一开始就该是同一份账')

  // 一 · 手敲：`fugue --root <dir> round go`
  const typed = fugue(hand, 'round', 'go')
  assert.equal(typed.code, 0, `手敲那一趟退了 ${typed.code}：${typed.stderr}`)

  // 二 · 按 `g`：真的 `openKeys`（喂一个字节）→ 真的 `openGo`（起真子进程）
  const input = fakeInput()
  const lines: string[] = []
  let settle: () => void = () => {}
  const done = new Promise<void>((r) => {
    settle = r
  })
  const go = openGo({
    root: byKey,
    self: [process.execPath, CLI],
    onLine: (l) => lines.push(l),
    onDone: () => settle(),
  })
  const keys = openKeys({
    input,
    onAction: (a) => {
      if (a === 'go') go.press()
    },
  })
  input.feed('g')
  keys.close()
  await done

  const a = accountOf(hand)
  const b = accountOf(byKey)
  assert.deepEqual(b, a, `按了键与手敲落下的账不同：手敲 ${a.length} 条 · 按键 ${b.length} 条`)
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
  assert.equal(types(c).includes('contract/issue'), false, '自己写一条放行就把契约发出去了？');

  console.log(
    `⑤ 读数：手敲那一趟账 ${a.length} 条（${types(a).join(' ')}）· 按 g 那一趟 ${b.length} 条 · 两串逐字节相同；` +
      `界面自己写一条 round/approve 的那一版 ${c.length} 条、契约 0 条——与手敲那一版不同`,
  )
})
