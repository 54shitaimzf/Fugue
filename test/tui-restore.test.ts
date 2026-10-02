// tier: real —— 真终端（util-linux 的 `script` 开 PTY）· 真信号 · 真进程
//
// 0.2.6 ①：**TUI 退出路径的终端还原**（PR15 审查件 § 2 采纳 1 · 路线图 0.2.6 行 ·
// 架构 § 9.8 的可附着 TUI）。在这一份之前，那件事只有**字符串级**的验证：`src/ui/term.ts`
// 里的 `ALT_ON` / `ALT_OFF` 与 `ui/keymap.ts` 里的 `?2004h` / `?2004l` 只被断言过"这些序列
// 该写出来"，没有一条测试真的开一个终端、跑起来、退出、再问一次"参数回来了没有"。
//
// 路径（`cli/cmd/observe.ts` 的 `tuiCmd`，收尾全靠 `close()` 被调到）：
//
//   · `q`（键表里的 `quit`，只在输入行空着时算数）→ 正常退那一趟，走 `finally`；
//   · `Ctrl-C`（raw mode 下 `SIGINT` 不再由终端发出来，所以 `\u0003` 是**键表里的一条**：
//     空闲时按一下只举手、3 秒内再按一次才退）→ 同一处 `finally`；
//   · `SIGTERM`（进程外来的信号）→ `abort` 之后走 `finally`；
//   · **`SIGHUP`**（同上一条接线，但性质不同，见下）→ 同一条路；
//   · **坏日志**（崩点落在进了 raw mode **之后**：`openKeys` 已开、读账才炸）→ 异常那一趟，
//     收尾靠 `finally` 展开时跑的那一次。
//
// 另跑一个 `--full` 变体，多断一条 `?1049l`（出 alt screen——少写它那台终端就停在另一块屏上）。
//
// **每一格共同的四样**，逐条都会红：
//
//   ① 退出码（人喊停的那几条是 0；坏日志非 0）；
//   ② 输出里出现 `?2004h`——**这一条是另外三条的前提**：没进 raw mode 时终端参数必然相同，
//      后面那条比对就是在量空气（实测：把外来信号那一格的 stdin 让 POSIX 塞成 /dev/null，
//      `?2004h` 与 `?2004l` 就一个都不出现，而 stty 那一条照样"通过"）；
//   ③ 输出里出现 `?2004l`（关掉 bracketed paste 那一笔）；
//   ④ **进场与退出的 `stty -g` 逐字节相同**——读它的是 driver 那一侧，不是 TUI 自己说的话。
// 四条**一起报**（不是撞上第一条就停）：一条坏了往往连带另一条，分开看才认得出是哪一种坏法。
//
// **为什么把 `SIGHUP` 单列一格**（0.2.6 加的这一格，理由记在这里）：Node 对 `SIGTERM` 与
// `SIGINT` **自带**一个默认处理器，退出前会复位终端模式（Node 文档 `process` 的「Signal
// events」那一节：这两个信号在非 Windows 平台上有默认处理器，复位终端模式后以 128+信号号退出；
// 一旦我们自己装了监听器，那个默认行为就**被摘掉**）。`SIGHUP` 与 `SIGKILL` **没有**这条默认。
// 于是：`SIGHUP` 那一格上，"人离开之后还回不回得到 shell"**只有我们那两处 `keys.close()`**
// 管得着——它是这一档里唯一真正承重的一格。
//
// **`stty` 那一条的位置，如实记**（实测读数）：只 `setRawMode(true)` 然后正常 `process.exit(0)`，
// 或者被**没人接**的 `SIGTERM`/`SIGINT` 打死，两行 `stty -g` 都相同（Node 兜了底）；被 `SIGKILL`
// 或没人接的 `SIGHUP` 打死则不同。所以"撤掉 `setRawMode(false)` 那一行"在本档**不会红**——
// 它红在 `src/ui/keymap.test.ts` 的 `close()` 那一条（那一份数的是 `raw=false` 调了几次）。
// 本档能红的是**收尾整条没跑**（两处 `keys?.close()` 都撤掉：`?2004l` 与 stty 一起红），
// 以及**信号没接线**（撤掉 `process.on('SIGHUP', onTerm)`：进程被默认动作打死，两样一起红）。
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runTuiInPty } from './helpers/pty.ts'
import type { PtyRun } from './helpers/pty.ts'
import { tmpDir } from './helpers/tmp.ts'

const RAW_ON = '\u001b[?2004h'
const RAW_OFF = '\u001b[?2004l'
const ALT_ON = '\u001b[?1049h'
const ALT_OFF = '\u001b[?1049l'

/** 一个只有 `.fugue` 的空工作区：`tui` 是纯读，不建视图、不取锁、不追加。 */
function workspace(prefix: string, logLine?: string): string {
  const dir = tmpDir(prefix)
  mkdirSync(join(dir, '.fugue', 'log'), { recursive: true })
  if (logLine !== undefined) writeFileSync(join(dir, '.fugue', 'log', 'round.jsonl'), logLine + '\n')
  return dir
}

/** 每一格共同的四样（见文件头）。**攒齐了再报**——坏法不同，四条里红的那几条也不同。 */
function common(r: PtyRun, what: string): void {
  const bad: string[] = []
  if (r.timedOut) bad.push('到时限还没退出（还是它根本没退出？）')
  if (!r.out.includes(RAW_ON)) {
    bad.push(
      `没进 raw mode（PTY 里没有 ${JSON.stringify(RAW_ON)}）——` +
        '后面那条 stty 比对会变成空断言（这一档要的是"进了 raw mode 之后还还原得回来"）',
    )
  }
  if (!r.out.includes(RAW_OFF)) {
    bad.push(`退出时没关掉 bracketed paste（没有 ${JSON.stringify(RAW_OFF)}）`)
  }
  if (r.entry === '') {
    bad.push('进场那一行 stty -g 没读到——PTY（util-linux 的 script · stty）是这一档的系统工具，不在就红')
  } else if (r.entry !== r.exit) {
    bad.push(`终端参数没还原——人离开 TUI 之后 shell 是坏的\n    进场 ${r.entry}\n    退出 ${r.exit}`)
  }
  assert.equal(bad.length, 0, `${what}：\n  - ${bad.join('\n  - ')}`)
}

test('0.2.6 ① · q 退出：终端逐字节还原 · 退出码 0', async () => {
  const root = workspace('fugue-pty-q-')
  const r = await runTuiInPty({ root, dir: tmpDir('fugue-pty-q-out-'), keys: 'q' })
  common(r, 'q')
  assert.equal(r.code, 0, `人喊停不是失败，退出码该是 0（实得 ${r.code}）：${r.err}`)
})

test('0.2.6 ① · Ctrl-C（raw 下是键表里的一条：空闲两下退）：终端逐字节还原 · 退出码 0', async () => {
  const root = workspace('fugue-pty-c-')
  const r = await runTuiInPty({ root, dir: tmpDir('fugue-pty-c-out-'), keys: '\u0003\u0003' })
  common(r, 'Ctrl-C')
  assert.equal(r.code, 0, `人喊停不是失败，退出码该是 0（实得 ${r.code}）：${r.err}`)
})

test('0.2.6 ① · SIGTERM（进程外来的信号）：终端逐字节还原 · 退出码 0', async () => {
  const root = workspace('fugue-pty-t-')
  const r = await runTuiInPty({
    root,
    dir: tmpDir('fugue-pty-t-out-'),
    killAfterMs: 1500,
    killSignal: 'TERM',
  })
  common(r, 'SIGTERM')
  assert.equal(r.code, 0, `信号那一趟是"收尾再退"，不是被信号打死（实得 ${r.code}）：${r.err}`)
})

test('0.2.6 ① · SIGHUP（Node 没有默认处理器的那一条：复位只有我们的收尾管得着）', async () => {
  const root = workspace('fugue-pty-h-')
  const r = await runTuiInPty({
    root,
    dir: tmpDir('fugue-pty-h-out-'),
    killAfterMs: 1500,
    killSignal: 'HUP',
  })
  common(r, 'SIGHUP')
  assert.equal(
    r.code,
    0,
    `SIGHUP 与 SIGTERM 同一条接线（abort 之后走 finally），退出码该是 0（实得 ${r.code}）：${r.err}`,
  )
})

test('0.2.6 ① · 坏日志（崩点落在进了 raw mode 之后）：终端逐字节还原 · 退出码非 0', async () => {
  // 一行完整的（有行终止符的）损坏行 → 中段损坏 → 拒绝加载（§ 9.3）。崩点在 `openKeys` 之后。
  const root = workspace(
    'fugue-pty-b-',
    '{"seq":1,"writer":"round","crc":"deadbeef","t":"view/write"}',
  )
  const r = await runTuiInPty({ root, dir: tmpDir('fugue-pty-b-out-') })
  common(r, '坏日志')
  assert.notEqual(r.code, 0, '日志损坏是一条做不成的命令，退出码不该是 0')
  assert.ok(
    r.out.includes('日志损坏') || r.err.includes('日志损坏'),
    `这一趟该是"日志损坏，拒绝加载"那一支（不是别的什么崩法）：${r.out.slice(-400)}${r.err}`,
  )
})

test('0.2.6 ① · --full 变体：多断一条 ?1049l（出来那一笔）', async () => {
  const root = workspace('fugue-pty-f-')
  const r = await runTuiInPty({ root, dir: tmpDir('fugue-pty-f-out-'), keys: 'q', extra: ['--full'] })
  common(r, '--full')
  assert.equal(r.code, 0, `--full 那一档也是人喊停（实得 ${r.code}）：${r.err}`)
  assert.ok(r.out.includes(ALT_ON), `进了 alt screen（没有 ${JSON.stringify(ALT_ON)}）`)
  assert.ok(
    r.out.includes(ALT_OFF),
    `出 alt screen 那一笔没写——少写它那台终端就停在另一块屏上（没有 ${JSON.stringify(ALT_OFF)}）`,
  )
})
