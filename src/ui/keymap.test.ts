// TUI 的第二版第二格：**键位表**（PLAN § 5.19 第二版「二 · 按键」·「四 · 取消链与退出」· 架构 § 9.8
// 「人的每个状态动作都是一条命令」）。跑法：cd ~/fugue && node --test src/ui/keymap.test.ts
//
// 这一份量的六样：
//
//   ① **表**：每个动作一条键 · 表里不写字节（键名全翻得出来）· **没有两个动作抢同一个字节**
//      （抢了就是"按了这个出来那个"）· 每条都有短提示与一句说明 · `by` 只认得那六格。
//   ② **解码**：字母 · 控制字符 · 一串里好几个动作 · 认不出来的字节安静丢掉；负对照是这一份最
//      容易错的地方：**`ESC` 起头的那一段整段吃掉**（方向键 · 终端报出来的组合键 · 鼠标报告 ·
//      Alt-q），以及**被切开的半截序列要攒着**——`Esc` 现在是一条键，攒与不攒在这里分得开。
//   ③ **raw mode 的开与关**：TTY 上开 · 关的时候归位且摘监听（**负对照：不摘监听的话，关掉之后
//      再喂一个字节还会触发动作**）· `close()` 幂等 · 不是 TTY 就一个字节都不读（`on` 一次都不调）。
//   （起命令那一半与"账逐字节相同"那两条搬到 `run.test.ts` 去了：`ui/go.ts` 那一格泛化成了
//   `ui/run.ts`——按键 → 动作 → 起命令这一条路在那里量。）
//   ④ **两处渲染与表逐字相同、条数也是从表里数出来的**：提示行 · 帮助面板（`Ctrl-P` 那一屏就是
//      它，`T4` 接上的）吐出来的每一个键串都能在表里唯一找到那一条；**负对照**：另写一份手抄的目录
//      （同类里那种漂了 5 条的两张表）与表比，**当场对不上**。
//
//      （`T2` 那会儿这里数的是"三处"：第三处是个叫 `menuRowsOf` 的渲染器，喂的是 `/` 菜单的候选。
//      `T4` 落地时那条路定成了"`/` 菜单列的是**命令**（`cli/flags.ts` 的 `FLAGS_OF`）"，
//      `menuRowsOf` 于是没有第二个消费者——删了。键表这一张的消费者还是一处不少：提示行 ·
//      `Ctrl-P` 那一屏 · 真分发。）
//   ⑤ **覆盖**（`config set ui.keys.<动作> <键串>`）：改了那一条的字节 · 别的动作不动 · 认不出来的
//      键名与抢同一个字节**都报出来**（那一条照缺省走，不静默变成"按不出来"）。
//   ⑥ **提示行与帮助面板的形状**：提示行只印已经落地的（`by` 在 `WIRED` 里）那几条——没接线的动作
//      一个都不许出现 · `limit` 那一档把剩下的写成"还有 N 条"（N 从表里数）· 帮助面板列全部、
//      键那一列**逐行对齐**（列宽是算出来的，不是写死的）。
//   ⑦ **打字与粘贴**（`T4` 把输入行接上线时补的）：表里没吃掉的可打印字符走 `insert`（带着那个
//      字），认不出来的控制字符**一个都不出**；可打印字符的那几条绑定只在**行里没字的地方**算动作
//      （`actsOnEmpty`：`/round go` 里那个 `g` 要是也当动作，这一行会当场被发出去）；bracketed
//      paste 那一对记号之间**一个字节都不解释**（里面的换行不是 `Enter`），记号只到一半就攒着。
import assert from 'node:assert/strict'
import { widthOf } from './frame.ts'
import test from 'node:test'
import type { KeyInput, UiAction } from './keymap.ts'
import { ESC_WAIT_MS, KEYMAP, TABLE, WIRED, actionsOf, actsOnEmpty, bytesOfKey, decodeOf, decoderOf, escapeAt, escapeTruncatedAt, fallsToText, helpRowsOf, hintLimitOf, hintLineOf, keyLabelOf, keymapOf, openKeys, PASTE_OFF, PASTE_ON } from './keymap.ts'

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
    ['h', ['insert']],
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
    ['x\n中 5', ['insert', 'newline', 'insert', 'insert', 'insert']],
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
  assert.deepEqual(dec.feed('[A'), [{ action: 'historyOlder', key: '\u001b[A' }], '凑齐了才出动作')
  assert.equal(dec.pending, '', '凑齐之后不剩半截')
  // 负对照：攒着的那半截不许被当成"按了一下 Esc"——不攒的那一版在这里会多出来一个 cancel。
  const dec2 = decoderOf()
  dec2.feed('\u001b')
  assert.deepEqual(dec2.feed('[A'), [{ action: 'historyOlder', key: '\u001b[A' }], '只有方向键那一个动作，没有多出来的 cancel')
  // 真按了一下 Esc：等够 `ESC_WAIT_MS` 之后 `flush()` 才把它交出来。
  const dec3 = decoderOf()
  assert.deepEqual(dec3.feed('\u001b'), [])
  assert.deepEqual(dec3.flush(), [{ action: 'cancel', key: '\u001b' }], '等够时间才当"按了一下 Esc"')
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

// ── ④ 三处渲染：与表逐字相同，条数也是从表里数出来的 ─────────────────────────
test('④ 三处渲染：键串逐字来自表 · 条数是数出来的 · 负对照是手抄一份目录', () => {
  const labels = new Set(TABLE.map((b) => keyLabelOf(b)))
  const ready = TABLE.filter((b) => WIRED.includes(b.by))
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
  // **负对照**：手抄一份目录（同类里那家"帮助目录与真分发两张互不相干的表"，实测漂了 5 条：
  // `?` · `l` · `v` · `g` · `G` 早就换了前缀）。它与表对不上——这就是这条断言那把尺的牙。
  const handWritten = ['g', 'q', '?', 'l', 'v', 'G']
  const drifted = handWritten.filter((k) => !labels.has(k))
  assert.ok(drifted.length >= 3, `手抄那一份与表只差 ${drifted.length} 条，这把尺太钝：${handWritten.join(' ')}`)
  console.log(
    `④ 读数：提示行 ${hintKeys.length} 条 · 帮助面板 ${help.length} 行（Ctrl-P 那一屏就是它），` +
      `两处的键串与表逐字相同；手抄那一份漂了 ${drifted.length} 条（${drifted.join(' ')}）`,
  )
})

// ── ⑤ 覆盖：`config set ui.keys.<动作> <键串>` ───────────────────────────────
test('⑤ 覆盖：改一条不动别人 · 认不出来的与抢字节的都报出来（照缺省走）', () => {
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
  console.log(`⑤ 读数：覆盖一条 → 0x13 触发 submit、Enter 让位 · 抢字节与认不出来各报一条（共 ${clash.problems.length + bad.problems.length + ghost.problems.length} 条问题）`)
})

// ── ⑥ 形状：提示行与帮助面板 ─────────────────────────────────────────────────
test('⑥ 形状：提示行只印接上线的 · limit 那一档 · 帮助面板键列逐行对齐', () => {
  const ready = TABLE.filter((b) => WIRED.includes(b.by))
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
  // **宽度是入参**（提示行是给屏幕看的）：宽到装得下就全印，窄了就少印几条 + 说清还剩多少。
  assert.equal(hintLimitOf(1000), ready.length, '够宽就把接线的都印上')
  assert.ok(hintLimitOf(80) < ready.length, '80 列装不下 28 条（实测整行 438 列）')
  for (const columns of [80, 100, 140]) {
    const line = hintLineOf(KEYMAP, hintLimitOf(columns))
    assert.ok(widthOf(line) <= columns, `${columns} 列那一档印出来是 ${widthOf(line)} 列`)
  }
  assert.equal(hintLimitOf(20), 1, '窄到一条都放不下也要留一条（不然那一行是空的）')
  assert.ok(hintLimitOf(80) >= 1)
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
    `⑥ 读数：提示行 ${ready.length} 条（整行 ${widthOf(hint)} 列）· 按宽度取前几条：80 列 → ${hintLimitOf(80)} 条（${widthOf(hintLineOf(KEYMAP, hintLimitOf(80)))} 列）· ` +
      `140 列 → ${hintLimitOf(140)} 条 · limit=2（${widthOf(cut)} 列）· 帮助面板 ${rows.length} 行、键列 ${w + 2} 列、逐行对齐 · 没接线 ${later.length} 条缀了出处`,
  )
})

// ── ⑦ 打字与粘贴：可打印字符走 `insert` · 可打印的那几条绑定只在行里没字时是动作 ─────────
test('⑦ 打字与粘贴：`insert` 带着那个字 · 控制字符一个都不出 · 记号之间不解释 · `actsOnEmpty`', () => {
  // 打字：表里没吃掉的字走 `insert`（带着那个字与那个字节）——**加一条键不会让某个字打不进去**。
  assert.deepEqual(decodeOf('a'), [{ action: 'insert', text: 'a', key: 'a' }])
  assert.deepEqual(decodeOf('中文'), [
    { action: 'insert', text: '中', key: '中' },
    { action: 'insert', text: '文', key: '文' },
  ])
  // 表里吃掉的那些还是动作（`g` 是 `go`）；负对照是**控制字符**：认不出来就一个都不出。
  assert.deepEqual(actionsOf('g'), ['go'])
  assert.deepEqual(decodeOf('\u0000\u001c'), [], '认不出来的控制字符不许变成 insert')
  assert.deepEqual(actionsOf('q'), ['quit'])
  // bracketed paste：记号之间那一整段是原文，里面的换行不是 `Enter`。
  const dec = decoderOf()
  assert.deepEqual(
    dec.feed(`${PASTE_ON}第一行\n第二行${PASTE_OFF}`),
    [{ action: 'insert', text: '第一行\n第二行' }],
    '粘进来的原文一个字节都没动（换行留着）',
  )
  assert.equal(dec.pending, '', '记号吃干净')
  // 记号只到一半 → 攒着；下一块到了再一起交出去。
  const dec2 = decoderOf()
  assert.deepEqual(dec2.feed(`${PASTE_ON}一半`), [], '记号还没闭合就攒着')
  assert.deepEqual(dec2.feed(`那一半${PASTE_OFF}`), [{ action: 'insert', text: '一半那一半' }], '两块拼起来还是原文')
  // 记号前后各解析各的：粘完了接着按的键照旧是动作。
  const dec3 = decoderOf()
  assert.deepEqual(dec3.feed(`a${PASTE_ON}b${PASTE_OFF}G`), [
    { action: 'insert', text: 'a', key: 'a' },
    { action: 'insert', text: 'b' },
    { action: 'go', key: 'G' },
  ])
  // `actsOnEmpty`：可打印字符的那几条绑定只在行里没字的地方算动作（不然 `/round go` 打不完）。
  assert.equal(actsOnEmpty('go', '', 0), true, '行空 → `g` 是放行')
  assert.equal(actsOnEmpty('go', 'x', 1), false, '行里有字 → `g` 就是那个字')
  assert.equal(actsOnEmpty('quit', 'q', 1), false, '`q` 同上')
  assert.equal(actsOnEmpty('help', '?', 1), false, '`?` 同上')
  assert.equal(actsOnEmpty('menu', '', 0), true, '行空 → `/` 开菜单')
  assert.equal(actsOnEmpty('menu', '/x', 2), false, '行里已经有字 → `/` 就是那个斜杠')
  assert.equal(actsOnEmpty('mention', '', 0), true, '行首 → `@` 开面板')
  assert.equal(actsOnEmpty('mention', '看 一眼 ', 5), true, '词首（前一个字是空格）→ `@` 开面板')
  assert.equal(actsOnEmpty('mention', 'a@b', 3), false, '夹在词中间 → `@` 就是那个 `@`')
  assert.equal(actsOnEmpty('submit', '', 0), true, '别的动作不看行里有没有字')
  // `fallsToText`（`T5`）：行里有字的时候，上面那几条绑定的去处**分两种**——可打印的让位成那个
  // 字，控制字符丢掉。**负对照就是 `Ctrl-D`**：它要是也让位，输入行里会多出一个看不见的字节，而
  // "行里没字"这个前提恰好被它自己毁掉（`ui/cancel.ts` 的 `quitStepOf` 于是永远够不着）。
  assert.equal(fallsToText('go', 'g', 'x', 1), true, '行里有字 · `g` 让位成那个字')
  assert.equal(fallsToText('go', 'g', '', 0), false, '行空 → 这一下是动作，不让位')
  assert.equal(fallsToText('quit', 'q', 'x', 1), true, '`q` 同上')
  assert.equal(fallsToText('menu', '/', '/x', 2), true, '`/` 同上')
  assert.equal(fallsToText('mention', '@', 'a@b', 3), true, '`@` 同上')
  assert.equal(fallsToText('quit', '\u0004', 'x', 1), false, '**负对照**：`Ctrl-D`（0x04）不许进输入行')
  assert.equal(fallsToText('cancel', '\u001b', 'x', 1), false, '`Esc`（0x1b）同上')
  assert.equal(fallsToText('quit', 'q', '', 0), false, '行空 → `q` 是动作（退出那一下）')
  assert.equal(fallsToText('insert', 'a', 'x', 1), false, '`insert` 不是绑定，谈不上让位')
  assert.equal(fallsToText('home', undefined, 'x', 1), false, '没有那个字节：没得让位')
  console.log(
    '⑦ 读数：打字 2 条进 insert（`a` · `中文` 各一个字）· 控制字符 0x00/0x1c 出 0 个动作 · ' +
      `粘贴「第一行\\n第二行」是 1 条 insert（换行留着、没被当成 Enter）· 记号切成两块也拼得回来 · ` +
      `actsOnEmpty 10 档（行空 4 档是动作 · 行里有字 4 档让位成那个字 · 别的动作 2 档不看）· ` +
      `fallsToText 10 档（可打印的让位 4 档 · 控制字符丢掉 2 档 · 行空不算让位 2 档 · 别的 2 档）`,
  )
})
