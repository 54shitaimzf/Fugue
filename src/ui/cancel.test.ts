// TUI 的第二版第五格：**取消链**（PLAN § 5.19 第二版「四 · 取消链与退出」· 第九节 `T5` 那一行 ·
// 架构 § 9.8「人的每个状态动作都是一条命令」）。跑法：cd ~/fugue && node --test src/ui/cancel.test.ts
//
// 这一份量的四样：
//
//   ① **`Esc` 五级各一条**：弹层开着时按它**只关弹层**（在途的那一趟不许被动）· 没弹层而跑着时
//      **只打断**（输入行里那行字不许被清）· 没跑而排着队时只丢草稿 · 都没有才清空输入 · 全空
//      什么都不做。判据是"五档里恰好那一档"，负对照是**上头那一级够得着时，下头那几级的下手对象
//      一个都不许被碰**——"这一次 `Esc` 到底关了什么"是这类界面最常被骂的一处，所以每一级都要有
//      一处反向的钉。
//   ② **`Ctrl-C` 四档**：有在途 → 打断 · 空闲第一次 → 只举手 · 举手还在窗口里 → 退 · 举手过了
//      3 秒 → 又只是举手（不是"举过一次就永远能退"）。
//   ③ **`Ctrl-D`/`q` 那一条**：只在输入行空着的时候退；行里有字时**什么都不做**——而且那一行字
//      不许因为按了 `Ctrl-D` 多出一个看不见的字节（`fallsToText` 的负对照）。
//   ④ **字节 → 动作 → 链**：`Esc` · `Ctrl-C` · `Ctrl-D` 三个字节各解出哪一个动作，与链的三条入口
//      一一对上（键表里那三行的 `keys` 改了，这一条就红）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { CTRL_C_WINDOW_MS, ctrlCStepOf, escStepOf, quitStepOf, stillArmed } from './cancel.ts'
import type { EscStep, Situation } from './cancel.ts'
import { TABLE, WIRED, actionsOf, decoderOf, fallsToText } from './keymap.ts'

/** 一处处境。**缺省是"全空"**，各档只写它要动的那一样（这一份量的是"处境 → 那一个动作"）。 */
function at(over: Partial<Situation> = {}): Situation {
  return { overlays: 0, running: false, queued: 0, line: '', searching: false, ...over }
}

// ── ① `Esc` 五级 ─────────────────────────────────────────────────────────────
test('① `Esc` 五级各一条：上头那一级够得着时，下头那几级的下手对象一个都不许被碰', () => {
  const levels: readonly (readonly [string, Situation, EscStep])[] = [
    ['弹层开着（还跑着 · 排着队 · 行里有字 · 反查也开着）', at({ overlays: 1, running: true, queued: 3, line: 'x', searching: true }), 'overlay'],
    ['没弹层 · 跑着（排着队 · 行里有字）', at({ running: true, queued: 3, line: 'x' }), 'break'],
    ['没跑 · 排着队（行里有字）', at({ queued: 3, line: 'x' }), 'dropQueue'],
    ['都没跑 · 行里有字', at({ line: 'x' }), 'clearLine'],
    ['都没跑 · 行是空的而反查开着', at({ searching: true }), 'clearLine'],
    ['全空', at(), 'none'],
  ]
  for (const [what, s, want] of levels) {
    assert.equal(escStepOf(s), want, `${what} → 该走「${want}」这一级`)
  }
  // 每一级一处反向的钉：**上头够得着的时候，下头那几级的对象一个都不许被动**。
  assert.notEqual(escStepOf(at({ overlays: 1, running: true })), 'break', '弹层开着时 `Esc` 不许去打断在途的那一趟')
  assert.notEqual(escStepOf(at({ running: true, line: 'x' })), 'clearLine', '跑着的时候 `Esc` 不许吃掉输入行里那行字')
  assert.notEqual(escStepOf(at({ queued: 2, line: 'x' })), 'clearLine', '还有排队草稿时先丢草稿，不清输入行')
  assert.notEqual(escStepOf(at({ line: 'x' })), 'none', '行里有字时 `Esc` 不许什么都不做')
  assert.notEqual(escStepOf(at({ searching: true })), 'none', '反查开着时 `Esc` 不许什么都不做')
  // 次序是**写死的**（不是"看情况挑一件"）：把下头几级的东西全堆满，出来的仍是最高那一级。
  assert.equal(
    escStepOf(at({ overlays: 2, running: true, queued: 9, line: 'x', searching: true })),
    'overlay',
    '堆满也是最高那一级说了算',
  )
  // `queued` 只在那一个位置起作用——次序里它既不许越到 `running` 前头，也不许落到 `line` 后头。
  assert.equal(escStepOf(at({ queued: 1, running: true })), 'break', '排队不许越过在途')
  assert.equal(escStepOf(at({ queued: 1, line: 'x' })), 'dropQueue', '排队在输入行前头')
  console.log(
    `① 读数：五级 ${levels.map(([w, , v]) => `${w}→${v}`).join(' · ')} · 反向的钉 6 处（每一级一处 + 排队那两处的位置）`,
  )
})

// ── ② `Ctrl-C` 四档 ──────────────────────────────────────────────────────────
test('② `Ctrl-C` 四档：有在途就打断 · 空闲第一次只举手 · 窗口里再按才退 · 过了窗口又只是举手', () => {
  assert.equal(ctrlCStepOf({ running: true, armed: false }), 'break', '有在途 → 打断')
  assert.equal(
    ctrlCStepOf({ running: true, armed: true }),
    'break',
    '**打断那一下不举手**：在途的时候按它说的是"把这一趟停下来"，不是"我要走了"',
  )
  assert.equal(ctrlCStepOf({ running: false, armed: false }), 'arm', '空闲第一次 → 只举手')
  assert.equal(ctrlCStepOf({ running: false, armed: true }), 'quit', '空闲 · 举过手（还在窗口里）→ 退')
  // 3 秒那个窗口：**边界算在窗口里**（`<=`），过 1 毫秒就不再算举手。`stillArmed(now, at)` 收的是
  // "现在几点"与"那一刻举的手"，所以下面这一档是"举手之后过了多久"。
  assert.equal(stillArmed(1000 + CTRL_C_WINDOW_MS, 1000), true, `正好 ${CTRL_C_WINDOW_MS} 毫秒还算举手`)
  assert.equal(stillArmed(1000 + CTRL_C_WINDOW_MS + 1, 1000), false, '过 1 毫秒就不算')
  assert.equal(stillArmed(1000, null), false, '没举过手')
  // 差是负的（记的那个时刻在后头：钟被拨回去了）**不算过期**——宁可多问一句"真要退吗"，也不要
  // 因为一次 NTP 校时把人举手那一下当成过期。
  assert.equal(stillArmed(1000, 2000), true, '时刻在后头（钟被拨回去了）也算还在窗口里')
  assert.equal(
    ctrlCStepOf({ running: false, armed: stillArmed(9000, 1000) }),
    'arm',
    '过了窗口再按 → 又只是举手（不是"举过一次就永远能退"）',
  )
  assert.equal(CTRL_C_WINDOW_MS, 3000, '窗口就是 3 秒——这一条读数本身也钉住')
  console.log('② 读数：有在途→break（举没举过手都一样）· 空闲第一次→arm · 窗口里→quit · 过了 3000 毫秒→又 arm')
})

// ── ③ `Ctrl-D`/`q` 那一条 ────────────────────────────────────────────────────
test('③ `Ctrl-D`/`q` 只在输入行空着的时候退；行里有字时不许往行里塞看不见的字节', () => {
  assert.equal(quitStepOf({ line: '' }), 'quit', '行空着 → 退')
  assert.equal(quitStepOf({ line: 'x' }), 'none', '行里有字 → 什么都不做')
  // 行里有字时那两条键的去处是 `fallsToText`（`observe.ts` 分发处那一条闸读它）：
  //   · `q`（可打印）→ 让位成那个字；
  //   · `Ctrl-D`（控制字符 0x04）→ **丢掉**。
  // **这一条就是负对照**：要是让位，输入行里会多出一个看不见的字节，而"行里没字"这个前提恰好被它
  // 自己毁掉——`quitStepOf` 于是永远够不着，人越按 `Ctrl-D` 越退不出去。
  assert.equal(fallsToText('quit', '\u0004', 'x', 1), false, '行里有字 · `Ctrl-D` 让位出来的 0x04 不许进输入行')
  assert.equal(fallsToText('quit', '\u0004', '', 0), false, '行空着时 `Ctrl-D` 是动作（退出那一下），不是字')
  assert.equal(fallsToText('quit', 'q', 'x', 1), true, '行里有字 · `q` 就是那个字')
  assert.equal(fallsToText('quit', 'q', '', 0), false, '行空着时 `q` 是动作')
  assert.equal(fallsToText('cancel', '\u001b', 'x', 1), false, '`Esc` 同理（0x1b 不许进输入行）')
  assert.equal(fallsToText('go', 'g', 'x', 1), true, '`g` 让位')
  assert.equal(fallsToText('menu', '/', 'x', 1), true, '`/` 让位')
  assert.equal(fallsToText('insert', 'a', 'x', 1), false, '`insert` 本来就不是绑定，谈不上让位')
  assert.equal(fallsToText('quit', undefined, 'x', 1), false, '没有那个字节：没得让位')
  console.log('③ 读数：`Ctrl-D` 两种处境都是 0（动作或丢掉，绝不当字）· `q`/`g`/`/` 行里有字时让位 · `Esc` 0')
})

// ── ④ 字节 → 动作 → 链 ───────────────────────────────────────────────────────
test('④ 三个字节解出来的动作与链的三条入口一一对上（键表里那三行的 `keys` 改了，这条就红）', () => {
  const acts = (chunk: string): readonly string[] => actionsOf(chunk).map((a) => a)
  assert.deepEqual(acts('\u0003'), ['interrupt'], '`Ctrl-C`（0x03）→ `Ctrl-C` 那一链')
  assert.deepEqual(acts('\u0004'), ['quit'], '`Ctrl-D`（0x04）→ 退出那一条')
  // `Esc` 自己那一个字节是**半截序列**（可能后面还跟着 `[A` 那样的尾巴）：要 `decoderOf` 攒到
  // "没有下文"才落成一个动作——攒不成键了才当"人真按了一下 `Esc`"。
  const dec = decoderOf()
  assert.deepEqual(dec.feed('\u001b'), [], '半截 `Esc` 先攒着（不许当场当成按了一下）')
  assert.deepEqual(dec.flush().map((d) => d.action), ['cancel'], '攒不成键了 → 落成取消链第一级')
  assert.equal(dec.pending, '', '攒的那半截交出去之后手里是干净的')
  // 表里那三行都记着"哪一格接上的"= `T5`，而 `T5` 在 `WIRED` 里——提示行与帮助面板因此印得出来。
  const by = new Map(TABLE.map((b) => [b.action, b.by]))
  for (const a of ['cancel', 'interrupt', 'quit']) {
    assert.equal(by.get(a), 'T5', `${a} 那一行该记着是 T5 接上的`)
  }
  assert.ok(WIRED.includes('T5'), '`T5` 该在 `WIRED` 里（不然提示行不印这三条）')
  // 这三条的键名本身也钉住：改一个键名，上面那三条 `actionsOf` 就会红。
  const keys = new Map(TABLE.map((b) => [b.action, b.keys.join('·')]))
  assert.equal(keys.get('cancel'), 'Esc')
  assert.equal(keys.get('interrupt'), 'Ctrl-C')
  assert.equal(keys.get('quit'), 'Ctrl-D·q·Q')
  console.log('④ 读数：0x03→interrupt · 0x04→quit · 半截 Esc 攒着→flush 落一个 cancel · 三行的 by 都是 T5')
})
