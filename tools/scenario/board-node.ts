#!/usr/bin/env node
// 样本盘的三个读面（跑法见 tools/scenario/README.md）。**取证用，不是产品的一部分。**
//
//   node tools/scenario/board-node.ts selftest <cases.json>
//       离线：把每一案的**已知答案**（`answer`）判两棵树——出题人写的 `solved` 该过、
//       底那一棵（`base`）该不过。判据自己有没有牙，先在这一步上量出来（不花钱、不出网）。
//
//   node tools/scenario/board-node.ts judge <cases.json> <工作区> <案名>
//       跑完那一趟之后判**真实工作树**：过了打印 `已知答案全中`，不过把红的那几条连
//       "差在哪"一起印出来，退出码 1。
//
//   node tools/scenario/board-node.ts fence <工作区>
//       这一趟的围栏（日志里那些 `run/confined`）：`full · bwrap+landlock · mode …` —— 它回答
//       "这一趟的读数能不能当证据"。`row` 那一行里与「探路」并排印。
//
//   node tools/scenario/board-node.ts recon <工作区>
//       步子花在哪儿（`run/start` 的 argv）：视图里 vs 视图之外或账本（`.fugue`）。**读数不是
//       判据**——它回答"预算烧在找 harness 上，还是在干活上"。
//
//   node tools/scenario/board-node.ts row <cases.json> <工作区> <work.json> <案名> <趟> <门退回> <观察>
//       把一轮压成账上那一行（制表符分隔）。用量从日志现算（`statusOf`），不看模型报什么。
//       **越界那一栏读 `snap.refusals`**（`bound/deny` 与内核拒相加），不读三数里的 `denied`：
//       视图那一侧的拒不落 `run/end`，三数看不见它。两半与按由头的分组印在下面那一行。
import fs from 'node:fs'
import path from 'node:path'
import { judgeOf, boardLines } from '../../src/probe/board.ts'
import type { Answer, Tree } from '../../src/probe/board.ts'
import { openLog } from '../../src/log/log.ts'
import { statusOf } from '../../src/probe/status.ts'

type CaseDecl = {
  name: string
  covers: string[]
  goal: string
  answer: Answer
  base: { path: string; text: string }[]
  solved: Record<string, string | null>
  observes?: string[]
  split?: unknown[]
}

const readCases = (file: string): CaseDecl[] => JSON.parse(fs.readFileSync(file, 'utf8')).cases as CaseDecl[]
const treeOfBase = (c: CaseDecl): Tree => Object.fromEntries(c.base.map((f) => [f.path, f.text]))
const treeOfSolved = (c: CaseDecl): Tree => c.solved
function treeOfDisk(ws: string, c: CaseDecl): Tree {
  const out: Record<string, string | null> = {}
  for (const one of c.answer) {
    const abs = path.join(ws, one.path)
    out[one.path] = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
  }
  return out
}
/**
 * **这一趟的围栏**（日志里那些 `run/confined`）：一条一格，值是与 `fugue run` 同源的策略值。
 *
 * 它只回答一个问题：**这一趟的读数能不能当证据**。挂载层不在场时子进程读得到账本与答案纸
 * （`$OUT` 就在它够得着的地方），那时"已知答案过"这句话分不开"它自己解出来的"与"它翻到了
 * 我们的账本"。第十五趟样本盘照出来的正是这一条。
 */
function fenceLine(rows: readonly unknown[]): string {
  // **日志读回来的是行**：事件在 `r.e` 那一栏里（与 `row` 那一支同一个读法）。
  // **字段在 `r.e` 里**（与 `r.e.t` 同一个读法）——读在"行"那一层上时每一格都是 `undefined`，
  // 而那一趟恰好一个子进程都没有（b14 那一次），于是这条错路一直没被走到过。
  const fences = rows
    .map((r) => (r as { e?: unknown }).e)
    .filter((e): e is { t?: string } => typeof e === 'object' && e !== null && (e as { t?: string }).t === 'run/confined') as unknown as {
    mode: string
    enforcement: string
    layers?: readonly string[]
    reach?: readonly string[]
  }[]
  if (fences.length === 0) return '—（日志里一条 run/confined 都没有：这一趟没有子进程，或这份账早于那个事件）'
  const shape = (f: { enforcement: string; layers?: readonly string[]; mode: string }): string => {
    const layers = (f.layers ?? []).join('+')
    return f.enforcement + ' · ' + (layers === '' ? '（一层都没有）' : layers) + ' · mode ' + f.mode
  }
  const first = fences[0] as { enforcement: string; layers?: readonly string[]; mode: string; reach?: readonly string[] }
  const distinct = [...new Set(fences.map(shape))]
  return (
    shape(first) +
    ' · 只读根 ' + String((first.reach ?? []).length) + ' 条 · ' + String(fences.length) + ' 格各一条' +
    (distinct.length > 1 ? '（**不一致**：' + distinct.join(' / ') + '）' : '')
  )
}

/**
 * **这一格的步子花在哪儿**（`run/start` 那些 `argv`）：视图里 vs 视图之外。
 *
 * 它回答的是第十四趟之后留下的那个问题——"两格烧光预算"到底是因为**看见了别格的核对脚本**，
 * 还是因为**在找 harness 本身**。逐条读那一趟的 `run/start`：`r1/2` 收工之后的七步在
 * `/tmp/scenario-b14/…` · `.fugue/config` · `work.json` 里翻（那是**漏出去的那一面**——
 * `$OUT` 就在它够得着的地方，`9b85430` 的挂载层把它关了）；`r1/4` 那几步在试"那三份核对
 * 怎么跑"（真仓库里也有的代价，与地界无关）；`r1/3` 读了另外两份核对脚本，6 步收敛。
 * 三格的读数各不一样，所以"看得见别格的核对"这一条解释不了那两格的预算。
 *
 * **它是读数不是判据**：`/tmp` 对模型是一个正常的临时目录，走过去本身不算错——这一栏只把
 * "坐标在视图之外的步子"摆出来，与「围栏」那一行一起读（围栏那一行说这一趟的读数能不能
 * 当证据，这一行说它的步子在不在自家地界里）。
 */
function reconLine(rows: readonly unknown[]): string {
  // 视图之外的坐标：宿主上的绝对路径 · 往上走 · harness 自己那本账（`.fugue`）。
  // `/bin/sh` 那一类不出现在这里——只看 `argv` 的**最后一项**（那就是命令正文）。
  const OUTSIDE = /(^|[\s"'`=;|(])(\/tmp|\/home|\/root|\/etc|\/proc|\/var|\/opt|\/usr\/local)(\/|\s|$)|(^|[\s"'`=;|(])\.\.(\/|\s|$)|(^|[\s"'`=;|(])\.fugue(\/|\s|$)|(^|[\s;&|])cd\s+\/(\s|$|&&)/
  const runs = rows
    .map((r) => (r as { e?: unknown }).e)
    .filter((e): e is { t?: string } => typeof e === 'object' && e !== null && (e as { t?: string }).t === 'run/start') as unknown as {
    agent?: string
    argv?: readonly string[]
  }[]
  if (runs.length === 0) return '—（这一趟没有子进程）'
  const per = new Map<string, { out: number; all: number }>()
  for (const r of runs) {
    const argv = r.argv ?? []
    const cmd = argv.length === 0 ? '' : String(argv[argv.length - 1])
    const who = r.agent ?? '?'
    const cell = per.get(who) ?? { out: 0, all: 0 }
    cell.all += 1
    if (OUTSIDE.test(cmd)) cell.out += 1
    per.set(who, cell)
  }
  const cells = [...per.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const out = cells.reduce((n, [, c]) => n + c.out, 0)
  const all = cells.reduce((n, [, c]) => n + c.all, 0)
  return (
    String(out) + '/' + String(all) + ' 步在视图之外或账本里（' +
    cells.map(([who, c]) => who.replace('agent/', '') + ' ' + String(c.out) + '/' + String(c.all)).join(' · ') +
    '）· 读数，不当判据'
  )
}

/**
 * **两个读面自己有没有牙**（离线 · 不花钱）：拿两把假日志喂进去，读数得逐字对上。
 *
 * 由头是实打实的一条错路：`run/confined` 与 `run/start` 的字段住在 `r.e` 里，而这两处原先
 * 读在"行"那一层上——每一格都是 `undefined`，只是那一趟恰好一个子进程都没有，于是它一路
 * 绿着（`—（这一趟没有子进程）`）。**读数读错一个字段与读数读对是同一张脸**，所以要有一条
 * 拿得到红的自检。
 */
function readingsSelfTest(): number {
  let bad = 0
  const complain = (what: string, got: string, want: string): void => {
    bad++
    console.log('  FAIL 读面自检 · ' + what + '：实得「' + got + '」，要的是「' + want + '」')
  }
  // 一 · 围栏那一行：一条 `run/confined`，四个字段各自落位
  const fenceRows = [
    { seq: 1, e: { t: 'run/start', agent: 'agent/r1/1', argv: ['/bin/sh', '-c', 'ls'] } },
    { seq: 2, e: { t: 'run/confined', agent: 'agent/r1/1', mode: 'workspace-write', enforcement: 'full', layers: ['bwrap', 'landlock'], reach: ['/usr', '/bin', '/lib', '/etc/ssl', '/etc/alternatives', '/etc/ld.so.cache'] } },
  ]
  const got = fenceLine(fenceRows)
  if (!got.includes('full · bwrap+landlock · mode workspace-write')) complain('围栏 · 档与层', got, 'full · bwrap+landlock · mode workspace-write')
  if (!got.includes('只读根 6 条')) complain('围栏 · 只读根', got, '只读根 6 条')
  if (!fenceLine([]).startsWith('—（日志里一条 run/confined 都没有')) complain('围栏 · 空那一档', fenceLine([]), '—（日志里一条 run/confined 都没有…）')
  console.log('  ok   读面自检 · 围栏：' + got)
  // 二 · 探路那一行：两格三条命令，只有一条的坐标在视图之外
  const reconRows = [
    { seq: 1, e: { t: 'run/start', agent: 'agent/r1/1', argv: ['/bin/sh', '-c', 'cat a.ts'] } },
    { seq: 2, e: { t: 'run/start', agent: 'agent/r1/1', argv: ['/bin/sh', '-c', 'ls /tmp/probe && cat .fugue/config'] } },
    { seq: 3, e: { t: 'run/start', agent: 'agent/r1/2', argv: ['/bin/sh', '-c', 'grep -rn x src'] } },
  ]
  const recon = reconLine(reconRows)
  if (!recon.startsWith('1/3 步')) complain('探路 · 计数', recon, '1/3 步…')
  if (!recon.includes('r1/1 1/2') || !recon.includes('r1/2 0/1')) complain('探路 · 按格', recon, 'r1/1 1/2 · r1/2 0/1')
  if (reconLine([]) !== '—（这一趟没有子进程）') complain('探路 · 空那一档', reconLine([]), '—（这一趟没有子进程）')
  console.log('  ok   读面自检 · 探路：' + recon)
  return bad
}

const byName = (all: CaseDecl[], name: string): CaseDecl => {
  const one = all.find((c) => c.name === name)
  if (one === undefined) { console.error('不认这个案名：' + name); process.exit(2) }
  return one
}

const [cmd, casesFile, ...rest] = process.argv.slice(2)
if (cmd === 'selftest') {
  const all = readCases(casesFile)
  let bad = 0
  for (const c of all) {
    const yes = judgeOf(c.answer, treeOfSolved(c))
    const no = judgeOf(c.answer, treeOfBase(c))
    const problems: string[] = []
    if (!yes.ok) problems.push('出题人写的 `solved` 判不过：' + yes.why)
    if (no.ok) problems.push('底那一棵居然判过了（这一案量不出"改对了没有"）')
    if (c.answer.length === 0) problems.push('一条判据都没有')
    if (!c.covers || c.covers.length === 0) problems.push('没写它覆盖哪些环节')
    if ((c.observes ?? []).length === 0) problems.push('没有一条能自己跑的观察（`observes`）')
    if (problems.length) { bad++; for (const p of problems) console.log('  FAIL ' + c.name + '：' + p) }
    else console.log('  ok   ' + c.name + '：底不过 · 答案过 · 覆盖 ' + c.covers.join('/') + ' · 观察 ' + String((c.observes ?? []).length) + ' 条')
  }
  console.log(bad ? '\n' + String(bad) + ' 案没过' : '\n' + String(all.length) + ' 案都过（判据有牙：底那一棵每一种都判不过）')
  bad += readingsSelfTest()
  process.exit(bad ? 1 : 0)
} else if (cmd === 'usage') {
  // 门退回那一条路上没有 `work.json`，可是那几步的调用是真花掉的——单开一个读面记它。
  const rows = await Array.fromAsync(openLog(rest[0] ?? casesFile).readMerged())
  const u = statusOf(rows as never).usage
  console.log([String(u.calls), String(u.inputTokens.total), String(u.cacheReadTokens.total), String(u.outputTokens.total)].join('\t'))
  process.exit(0)
} else if (cmd === 'fence') {
  // 这一趟的围栏：`round work` 每一格第一次起子进程时记一条（见 `driver.ts`）。
  const rows = await Array.fromAsync(openLog(rest[0] ?? casesFile).readMerged())
  console.log(fenceLine(rows as never))
  process.exit(0)
} else if (cmd === 'recon') {
  const rows = await Array.fromAsync(openLog(rest[0] ?? casesFile).readMerged())
  console.log(reconLine(rows as never))
  process.exit(0)
} else if (cmd === 'judge') {
  const c = byName(readCases(casesFile), rest[1])
  const v = judgeOf(c.answer, treeOfDisk(rest[0], c))
  for (const line of boardLines(c.name, v)) console.log(line)
  process.exit(v.ok ? 0 : 1)
} else if (cmd === 'row') {
  const [ws, workFile, name, run, gate, observe] = rest
  const c = byName(readCases(casesFile), name)
  const work = JSON.parse(fs.readFileSync(workFile, 'utf8'))
  const v = judgeOf(c.answer, treeOfDisk(ws, c))
  const rows = await Array.fromAsync(openLog(ws).readMerged())
  const snap = statusOf(rows as never)
  const v2 = work.verify ?? {}
  const cells: string[] = work.agents ?? []
  const settled = cells.filter((a: { stopped?: string }) => String(a.stopped).includes('收敛')).length
  const stop = cells.length === 0 ? '没有读数' : String(settled) + '/' + String(cells.length)
  const three = (work.report ?? []) as { metric: string; count: number }[]
  const countOf = (n: string) => String(three.find((r) => r.metric === n)?.count ?? '—')
  const advance = work.advanced
  const adv = advance === null || advance === undefined
    ? '没有'
    : '写 ' + String((advance.written ?? []).length) + ' 删 ' + String((advance.removed ?? []).length) + ' 跳 ' + String((advance.skipped ?? []).length)
  const u = snap.usage
  console.log([
    name, run, gate, stop,
    '过 ' + String(v2.pass ?? 0) + '/' + String((v2.pass ?? 0) + (v2.fail ?? 0) + (v2.unrunnable ?? 0)),
    v.ok ? '过' : '不过（' + v.failed.join('·') + '）',
    // **越界那一栏读 `refusals`，不读 `denied`**：视图那一侧的拒（`contract-scope` 那一族）
    // 不落 `run/end`，所以三数里的 `denied` 看不见它——而这一栏的名字是越界。两半的和写在
    // 下面那一行（`内核 n` 就是 `denied` 那个数，`byRule` 是按由头分的那几档）。
    observe, countOf('conflicts'), countOf('rejects'), String(snap.refusals.total),
    String(u.calls), String(u.inputTokens.total), String(u.cacheReadTokens.total), String(u.outputTokens.total),
    adv,
  ].join('\t'))
  console.log('  停因：' + (cells.length === 0 ? '（没有读数）' : cells.map((a: { agent: string; steps: number; stopped: string }) => a.agent + ' ' + String(a.steps) + ' 步 · ' + a.stopped).join(' ｜ ')))
  {
    // **恒印这一行**（零也印）：与状态那一面同一把尺——少了它，"没量到"与"量到 0"就分不开。
    const split = snap.refusals.byRule.map((r) => `${r.rule} ${r.count}`).join(' · ')
    console.log(
      '  越界：被挡 ' + String(snap.refusals.total) + ' 次（内核 ' + String(snap.refusals.kernel) +
        (split === '' ? '' : ' · ' + split) + '）· 树上报了没挡的 ' + String(snap.outside.rows) + ' 条' +
        (snap.outside.paths.length === 0 ? '' : '（' + snap.outside.paths.join(' · ') + '）'),
    )
  }
  console.log('  探路：' + reconLine(rows as never))
  console.log('  围栏：' + fenceLine(rows as never))
  console.log('  已知答案：' + v.why)
  for (const line of boardLines(c.name, v).slice(1)) console.log(line)
  process.exit(0)
} else {
  console.error('用法：board-node.ts selftest <cases.json> | judge <cases.json> <工作区> <案名> | fence <工作区> | recon <工作区> | row <cases.json> <工作区> <work.json> <案名> <趟> <门退回> <观察>')
  process.exit(2)
}
