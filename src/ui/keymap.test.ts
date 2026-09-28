// TUI 的第二版第二格：**键位表**（PLAN § 5.19 第二版「二 · 按键」·「四 · 取消链与退出」· 架构 § 9.8
// 「人的每个状态动作都是一条命令」）。跑法：cd ~/fugue && node --test src/ui/keymap.test.ts
//
// 这一份量的八样：
//
//   ① **表**：每个动作一条键 · 表里不写字节（键名全翻得出来）· **没有两个动作抢同一个字节**
//      （抢了就是"按了这个出来那个"）· 每条都有短提示与一句说明 · `by` 只认得那六格。
//   ② **解码**：字母 · 控制字符 · 一串里好几个动作 · 认不出来的字节安静丢掉；负对照是这一份最
//      容易错的地方：**`ESC` 起头的那一段整段吃掉**（方向键 · 终端报出来的组合键 · 鼠标报告 ·
//      Alt-q），以及**被切开的半截序列要攒着**——`Esc` 现在是一条键，攒与不攒在这里分得开。
//   ③ **raw mode 的开与关**：TTY 上开 · 关的时候归位且摘监听（**负对照：不摘监听的话，关掉之后
//      再喂一个字节还会触发动作**）· `close()` 幂等 · 不是 TTY 就一个字节都不读（`on` 一次都不调）。
//   ④ **起命令那一半**：argv 与手敲的那一条同形 · 跑着的时候按不起了第二次（同一个口只起一次
//      进程）· 一行一行地收（跨块切开的行也要接起来）· 起不来与退了都报得出来。
//   ⑤ **账逐字节相同**（真子进程 · 夹具档 · 不花钱）：一个停在门口的靶子拷成两半，一半手敲
//      `round go`、一半按 `g`（真 `openKeys` → 真 `openGo` → 真子进程），两份账逐字节相同；
//      **负对照**：界面自己往账上写一条 `round/approve` 的那一版，账与手敲的那一版不同（而且
//      契约一条都没发出去）——这一条就是"界面不写日志、不持写句柄"那把尺的牙。
//   ⑥ **三处渲染与表逐字相同、条数也是从表里数出来的**：提示行 · 帮助面板 · 菜单三个渲染器吐出来
//      的每一个键串都能在表里唯一找到那一条；**负对照**：另写一份手抄的目录（同类里那种漂了 5 条
//      的两张表）与表比，**当场对不上**。
//   ⑦ **覆盖**（`config set ui.keys.<动作> <键串>`）：改了那一条的字节 · 别的动作不动 · 认不出来的
//      键名与抢同一个字节**都报出来**（那一条照缺省走，不静默变成"按不出来"）。
//   ⑧ **提示行与帮助面板的形状**：提示行只印已经接线的（`T2`）那几条——没接线的动作一个都不许
//      出现 · `limit` 那一档把剩下的写成"还有 N 条"（N 从表里数）· 帮助面板列全部、键那一列
//      **逐行对齐**（列宽是算出来的，不是写死的）。
import assert from 'node:assert/strict'
import { widthOf } from './frame.ts'
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
import type { KeyInput, UiAction } from './keymap.ts'
import { ESC_WAIT_MS, KEYMAP, TABLE, actionsOf, bytesOfKey, decodeOf, decoderOf, escapeAt, escapeTruncatedAt, helpRowsOf, hintLineOf, keyLabelOf, keymapOf, menuRowsOf, openKeys } from './keymap.ts'

/** 品牌类型那一栏（`RoundId` 一类）：这一份里那些值是拿来喂接口的，不是账上真发生过的。 */
const brand = (v: string): never => v as never

// ── ① 表：动作与键两头都要对上 ────────────────────────────────────────────────
test('① 表：每个动作一条键 · 表里不写字节 · 没有两个动作抢同一个字节 · 每条都有提示与说明', () => {
  assert.ok(TABLE.length >= 25, `表太短了：${TABLE.length} 条`)
  const actions = TABLE.map((b) => b.action)
  assert.equal(new Set(actions).size, actions.length, `表里有重复的动作：${actions.join(' ')}`)
  const all: string[] = []
  for (const b of TABLE) {
    assert.ok(b.keys.length > 0, `动作 ${b.action} 一条键都没有——它按不出来`)
    assert.ok(b.hint !== '' && b.note !== '', `动作 ${b.action} 缺短提示或缺说明`)
    assert.ok(b.note.length >= 4, `动作 ${b.action} 的说明太短（帮助面板里会是一句空话）`)
    for (const k of b.keys) assert.ok(bytesOfKey(k).length > 0, `键名翻不出来：${b.action} 的 ${k}`)
    assert.ok(!keyLabelOf(b).includes(' '), `键串里不许有空格（三处渲染靠它拆）：${keyLabelOf(b)}`)
    all.push(...b.keys.flatMap((k) => [...bytesOfKey(k)]))
  }
  assert.equal(new Set(all).size, all.length, `两个动作抢了同一个字节：${all.length} 个字节里只有 ${new Set(all).size} 个不同`)
  assert.deepEqual(KEYMAP.problems, [], `缺省那一份就有问题：${JSON.stringify(KEYMAP.problems)}`)
  for (const b of TABLE) assert.ok(['T2', 'T3', 'T4', 'T5', 'T6', 'T8'].includes(b.by), `不认识的 by：${b.by}`)
  const ready = TABLE.filter((b) => b.by === 'T2')
  console.log(
    `① 读数：动作 ${TABLE.length} 个 · 键名 ${TABLE.reduce((n, b) => n + b.keys.length, 0)} 个 · ` +
      `字节 ${all.length} 个不重 · 已接线 ${ready.length} 条（${ready.map((b) => keyLabelOf(b)).join(' ')}）`,
  )
})
// ── ② 解码：序列整段吃掉 · 半截序列攒着（`Esc` 是一条键了）────────────────────
test('② 解码：字母 · 控制字符 · 一串好几个 · 序列整段吃掉 · 半截攒着（Esc 是一条键了）', () => {
  const cases: readonly (readonly [string, readonly UiAction[]])[] = [
    ['g', ['go']],
    ['G', ['go']],
    ['q', ['quit']],
    ['Q', ['quit']],
    ['\u0003', ['interrupt']],
    ['\u0004', ['quit']],
    ['?', ['help']],
    ['h', []],
    ['\r', ['submit']],
    ['\n', ['newline']],
    ['\t', ['complete']],
    ['/', ['menu']],
    ['@', ['mention']],
    ['\u000b', ['killToEnd']],
    ['\u001bz', ['redo']],
    ['\u001b[A', ['historyOlder']],
    ['\u001b[B', ['historyNewer']],
    ['\u001b[D', ['left']],
    ['\u001b[C', ['right']],
    ['\u001b[3~', ['delete']],
    ['\u001b[H', ['home']],
    ['\u007f', ['backspace']],
    ['\u001b1', ['focus']],
    ['\u001b7', ['focus']],
    ['gq', ['go', 'quit']],
    ['gg', ['go', 'go']],
    ['x\n中 5', ['newline']],
    ['\u001b[1;5A', []],
    ['\u001b[27;5;103~', []],
    ['\u001b[<0;12;3M', []],
    ['\u001bq', []],
    ['\u001b', []],
    ['\u001b[', []],
    // `ESC g` 是 Alt-g（整两个字符吃掉，而 Alt-g 没配），后面那个 `q` 照旧是按键——"吃掉一段"不是
    // "吃掉后面那些"。
    ['\u001bgq', ['quit']],
  ]
  for (const [chunk, want] of cases) {
    assert.deepEqual(actionsOf(chunk), [...want], `${JSON.stringify(chunk)} 解出来不对`)
  }
  assert.equal(escapeAt('g', 0), 0)
  assert.equal(escapeAt('\u001b', 0), 1)
  assert.equal(escapeAt('\u001b[A', 0), 3)
  assert.equal(escapeAt('\u001b[27;5;103~', 0), 11)
  assert.equal(decodeOf('\u001b7')[0]?.n, 7, '`Alt-7` 带着第 7 个')
  assert.equal(decodeOf('\u001b9')[0]?.n, 9, '`Alt-9` 带着第 9 个')
  // 哪一段是"被切开的"：`ESC` 单独来 · `ESC [` 还没到终字节 —— 这两档要攒着，不许当成 Esc。
  assert.equal(escapeTruncatedAt('\u001b', 0), true, '单个 ESC 是被切开的')
  assert.equal(escapeTruncatedAt('\u001b[', 0), true, '`ESC [` 还没到终字节')
  assert.equal(escapeTruncatedAt('\u001b[A', 0), false, '方向键是完整的一条')
  assert.equal(escapeTruncatedAt('\u001bq', 0), false, 'Alt-q 是完整的一条')
  // **攒着**：终端把 `ESC [ A` 切成两块是常事。
  const dec = decoderOf()
  assert.deepEqual(dec.feed('\u001b'), [], '半截先不出动作')
  assert.equal(dec.pending, '\u001b', '半截攒着')
  assert.deepEqual(dec.feed('[A'), [{ action: 'historyOlder' }], '凑齐了才出动作')
  assert.equal(dec.pending, '', '凑齐之后不剩半截')
  // 负对照：攒着的那半截不许被当成"按了一下 Esc"——不攒的那一版在这里会多出来一个 cancel。
  const dec2 = decoderOf()
  dec2.feed('\u001b')
  assert.deepEqual(dec2.feed('[A'), [{ action: 'historyOlder' }], '只有方向键那一个动作，没有多出来的 cancel')
  // 真按了一下 Esc：等够 `ESC_WAIT_MS` 之后 `flush()` 才把它交出来。
  const dec3 = decoderOf()
  assert.deepEqual(dec3.feed('\u001b'), [])
  assert.deepEqual(dec3.flush(), [{ action: 'cancel' }], '等够时间才当"按了一下 Esc"')
  assert.deepEqual(dec3.flush(), [], 'flush 幂等')
  // `Alt-1…9` 那一条键名翻出九个字节（表里写的是人能读的那一个范围）。
  assert.equal(bytesOfKey('Alt-1…9').length, 9, '范围键名翻出九个')
  console.log(
    `② 读数：${cases.length} 条解码逐条对上（含 7 条序列负对照）· 半截序列攒着凑齐（ESC + [A）· ` +
      `等 ${ESC_WAIT_MS}ms 才算 Esc · Alt-1…9 翻出 9 个字节`,
  )
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
  const got: UiAction[] = []
  const input = fakeInput()
  const keys = openKeys({ input, onAction: (d) => got.push(d.action) })
  assert.equal(keys.raw, true, 'TTY 上该进 raw mode')
  assert.deepEqual(input.calls, ['raw=true', 'on'], `开的时候调了这些：${input.calls.join(' ')}`)
  input.feed('g')
  input.feed('\u0003')
  assert.deepEqual(got, ['go', 'interrupt'])
  keys.close()
  assert.deepEqual(input.calls, ['raw=true', 'on', 'off', 'raw=false'], `关的时候调了这些：${input.calls.join(' ')}`)
  // 负对照：摘掉监听之后再喂一个字节，**一个动作都不该出来**（不摘的话这里会多一个 'go'）。
  input.feed('g')
  assert.deepEqual(got, ['go', 'interrupt'], '关掉之后还认得出按键——监听没摘干净')
  keys.close()
  assert.equal(input.calls.filter((c) => c === 'raw=false').length, 1, '`close()` 不幂等（raw mode 被归位两次）')
  // 地板：不是 TTY → 一个字节都不读。
  const piped = fakeInput({ tty: false })
  const quiet = openKeys({ input: piped, onAction: (d) => got.push(d.action) })
  assert.equal(quiet.raw, false)
  assert.deepEqual(piped.calls, [], `不是 TTY 却动了输入：${piped.calls.join(' ')}`)
  piped.feed('g')
  quiet.close()
  assert.deepEqual(got, ['go', 'interrupt'], '不是 TTY 的那一档认了按键')
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
    onAction: (d) => {
      if (d.action === 'go') go.press()
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

// ── ⑥ 三处渲染：与表逐字相同，条数也是从表里数出来的 ─────────────────────────
test('⑥ 三处渲染：键串逐字来自表 · 条数是数出来的 · 负对照是手抄一份目录', () => {
  const labels = new Set(TABLE.map((b) => keyLabelOf(b)))
  const ready = TABLE.filter((b) => b.by === 'T2')
  // 提示行：`按键 ` 之后一节一节，每节的第一个字之前就是键串（表里那条断言保证键串里没有空格）。
  const hint = hintLineOf()
  const hintKeys = hint.replace(/^按键 /, '').split(' · ').map((one) => one.slice(0, one.indexOf(' ')))
  for (const k of hintKeys) assert.ok(labels.has(k), `提示行里这个键串表里没有：${k}`)
  assert.equal(hintKeys.length, ready.length, `提示行印的条数 = 表里已接线的条数（${ready.length}）`)
  // 帮助面板：一行一条，行首那个键串与表逐字相同、次序也相同。
  const help = helpRowsOf()
  assert.equal(help.length, TABLE.length, '帮助面板的行数 = 表的条数')
  assert.deepEqual(
    help.map((r) => r.slice(0, r.indexOf('  '))),
    TABLE.map((b) => keyLabelOf(b)),
    '帮助面板每一行开头那一串与表逐字相同、次序也相同',
  )
  // 菜单候选：同一张表推出来的。
  const menu = menuRowsOf()
  assert.equal(menu.length, TABLE.length, '菜单候选的条数 = 表的条数')
  assert.deepEqual(
    menu.map((r) => r.slice(0, r.indexOf('  '))),
    TABLE.map((b) => keyLabelOf(b)),
    '菜单每一行的键串与表逐字相同',
  )
  // **负对照**：手抄一份目录（同类里那家"帮助目录与真分发两张互不相干的表"，实测漂了 5 条：
  // `?` · `l` · `v` · `g` · `G` 早就换了前缀）。它与表对不上——这就是这条断言那把尺的牙。
  const handWritten = ['g', 'q', '?', 'l', 'v', 'G']
  const drifted = handWritten.filter((k) => !labels.has(k))
  assert.ok(drifted.length >= 3, `手抄那一份与表只差 ${drifted.length} 条，这把尺太钝：${handWritten.join(' ')}`)
  console.log(
    `⑥ 读数：提示行 ${hintKeys.length} 条 · 帮助面板 ${help.length} 行 · 菜单 ${menu.length} 条，` +
      `三处的键串与表逐字相同；手抄那一份漂了 ${drifted.length} 条（${drifted.join(' ')}）`,
  )
})

// ── ⑦ 覆盖：`config set ui.keys.<动作> <键串>` ───────────────────────────────
test('⑦ 覆盖：改一条不动别人 · 认不出来的与抢字节的都报出来（照缺省走）', () => {
  const km = keymapOf({ submit: 'Ctrl-S' })
  const submit = km.rows.find((b) => b.action === 'submit')
  assert.deepEqual([...(submit?.keys ?? [])], ['Ctrl-S'], '那一条换成新键名')
  assert.deepEqual(actionsOf('\u0013', km), ['submit'], '`Ctrl-S` 是 0x13')
  assert.deepEqual(actionsOf('\r', km), [], '覆盖是整条换掉：旧的 `Enter` 不再触发 submit')
  assert.deepEqual(actionsOf('g', km), ['go'], '别的动作一个都没动')
  assert.deepEqual(km.problems, [], `这一份覆盖没有毛病：${JSON.stringify(km.problems)}`)
  // 抢同一个字节：`Ctrl-O` 已经是 `toggleFold` 的。
  const clash = keymapOf({ submit: 'Ctrl-O' })
  assert.ok(
    clash.problems.some((p) => p.why.includes('抢同一个字节')),
    `两个动作抢同一个字节要报出来：${JSON.stringify(clash.problems)}`,
  )
  // 认不出来的键名：整条**照缺省走**（不静默变成"按不出来"）。
  const bad = keymapOf({ submit: 'Ctrl-Nope' })
  assert.ok(
    bad.problems.some((p) => p.why.includes('认不出来')),
    `认不出来的键名要报出来：${JSON.stringify(bad.problems)}`,
  )
  assert.deepEqual(actionsOf('\r', bad), ['submit'], '认不出来时照缺省走：`Enter` 还是 submit')
  // 表里没有的动作 id。
  const ghost = keymapOf({ nope: 'x' })
  assert.ok(
    ghost.problems.some((p) => p.why.includes('表里没有这个动作')),
    `表里没有的动作 id 要报出来：${JSON.stringify(ghost.problems)}`,
  )
  assert.equal(ghost.rows.length, TABLE.length, '那一份表本身还是完整的')
  console.log(`⑦ 读数：覆盖一条 → 0x13 触发 submit、Enter 让位 · 抢字节与认不出来各报一条（共 ${clash.problems.length + bad.problems.length + ghost.problems.length} 条问题）`)
})

// ── ⑧ 形状：提示行与帮助面板 ─────────────────────────────────────────────────
test('⑧ 形状：提示行只印接上线的 · limit 那一档 · 帮助面板键列逐行对齐', () => {
  const ready = TABLE.filter((b) => b.by === 'T2')
  const hint = hintLineOf()
  assert.ok(hint.startsWith('按键 '), hint)
  assert.equal(hint.split(' · ').length, ready.length, '一节一条，正好是已接线的那些')
  const hintLabels = hint.replace(/^按键 /, '').split(' · ').map((one) => one.slice(0, one.indexOf(' ')))
  assert.deepEqual(
    [...hintLabels].sort(),
    ready.map((b) => keyLabelOf(b)).sort(),
    `提示行里该正好是已接线的那几条（多一条就是空头许诺）：${hint}`,
  )
  const cut = hintLineOf(KEYMAP, 2)
  assert.ok(cut.includes(`还有 ${ready.length - 2} 条`), `limit 那一档要说清还剩几条（N 从表里数）：${cut}`)
  assert.equal(cut.split(' · ').length, 3, '头两条 + "还有 N 条"那一句')
  // 帮助面板：键那一列逐行对齐，列宽 = 表里最长那个键串 + 2。
  const rows = helpRowsOf()
  const w = TABLE.reduce((n, b) => Math.max(n, widthOf(keyLabelOf(b))), 0)
  // 说明那一列从第几列起（把键串后面的空白都吃过去）——逐行相同才算对齐。
  const colOf = (r: string): number => {
    let i = r.indexOf('  ')
    while (r[i] === ' ') i += 1
    return widthOf(r.slice(0, i))
  }
  const cols = rows.map(colOf)
  assert.equal(new Set(cols).size, 1, `键那一列没对齐（说明那一列得从同一列起）：${[...new Set(cols)].join(' ')}`)
  assert.equal(cols[0], w + 2, `键列宽该是表里最长那个 + 2：${cols[0]} vs ${w + 2}`)
  assert.deepEqual(rows.map((r) => r.slice(0, r.indexOf('  '))), TABLE.map((b) => keyLabelOf(b)), '行首那一串还是表里那个键串')
  const later = rows.filter((r) => r.includes('那一格接上'))
  assert.equal(later.length, TABLE.length - ready.length, '没接线的那些后面都缀了"哪一格接上"')
  console.log(
    `⑧ 读数：提示行 ${ready.length} 条（${widthOf(hint)} 列）· limit=2（${widthOf(cut)} 列）· ` +
      `帮助面板 ${rows.length} 行、键列 ${w + 2} 列、逐行对齐 · 没接线 ${later.length} 条缀了出处`,
  )
})
