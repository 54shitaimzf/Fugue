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
  process.exit(bad ? 1 : 0)
} else if (cmd === 'usage') {
  // 门退回那一条路上没有 `work.json`，可是那几步的调用是真花掉的——单开一个读面记它。
  const rows = await Array.fromAsync(openLog(rest[0] ?? casesFile).readMerged())
  const u = statusOf(rows as never).usage
  console.log([String(u.calls), String(u.inputTokens.total), String(u.cacheReadTokens.total), String(u.outputTokens.total)].join('\t'))
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
        (split === '' ? '' : ' · ' + split) + '）',
    )
  }
  console.log('  已知答案：' + v.why)
  for (const line of boardLines(c.name, v).slice(1)) console.log(line)
  process.exit(0)
} else {
  console.error('用法：board-node.ts selftest <cases.json> | judge <cases.json> <工作区> <案名> | row <cases.json> <工作区> <work.json> <案名> <趟> <门退回> <观察>')
  process.exit(2)
}
