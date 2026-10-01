#!/usr/bin/env node
// 事件面校验：`src/log/events.ts` 里那一个联合，对着**两张散文表**逐条数。
//
//   一 · **无条件查**：本仓库 `design/ARCHITECTURE.md` § 8.1 那一段 `type LogEvent = ...`
//   二 · 够得到才查：归档 § 5.18 那张三面表里「事件面」那一格（归档住在文档工作区，不在本仓库）
//
// **为什么要有这一份**：那张表漏过 7 条，而"漏了 7 条"这件事在那几个月里没有任何一处会报错——
// 表是散文，联合是代码，两者之间没有人对着数。§ 8.1 那一份后来也漂了同样的量（少 6 条 ·
// `round/intent` 少一栏），是同一件事的第二次。这一份就是那个数。
//
// **为什么必然那一半钉在架构篇上**：它两样都在本仓库里，所以这一条在任何一台机器上、在 CI 上
// 都真跑。2026-10-01 之前两张表都住文档工作区，够不到就整条跳过——**静默通过**。现在归档那一
// 半改成"够不到就印一行说出来"，地板只升不降。
//
// 用法：node tools/check-events.js [归档路径]
//   不给就按候选表找；给了但不在场，照样印出那一行，不抛。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const EVENTS = join(REPO, 'src', 'log', 'events.ts')
const ARCH = join(REPO, 'design', 'ARCHITECTURE.md')

const PLAN_CANDIDATES = [
  process.argv[2] ?? '',
  'PLAN-ARCHIVE.md',
  '/mnt/c/Users/Administrator/Desktop/CodeWish/PLAN-ARCHIVE.md',
  join(homedir(), 'Desktop', 'CodeWish', 'PLAN-ARCHIVE.md'),
].filter((p) => p !== '')
const planPath = PLAN_CANDIDATES.find((p) => existsSync(p)) ?? null

const fail = []
const ok = (m) => console.log('  ok   ' + m)
const bad = (m) => { fail.push(m); console.log('  FAIL ' + m) }

if (!existsSync(EVENTS)) { console.log(`  FAIL 找不到 ${EVENTS}`); process.exit(1) }
const eventsSrc = readFileSync(EVENTS, 'utf8')
const codeNames = []
for (const m of eventsSrc.matchAll(/t:\s*'([a-zA-Z]+\/[a-zA-Z]+)'/g)) if (!codeNames.includes(m[1])) codeNames.push(m[1])
if (/t:\s*'signal'/.test(eventsSrc) && !codeNames.includes('signal')) codeNames.push('signal')
codeNames.sort()

// ── 必然那一半：架构 § 8.1 的 `type LogEvent = ...` 那一段 ──────────────────────
if (!existsSync(ARCH)) {
  console.log(`  FAIL 找不到 ${ARCH}——架构篇住在本仓库 design/，它不在就是仓库坏了`)
  process.exit(1)
}
const archLines = readFileSync(ARCH, 'utf8').split('\n')
const head = archLines.findIndex((l) => /^type LogEvent =/.test(l))
if (head < 0) { console.log('  FAIL 架构篇里找不到 `type LogEvent =`（§ 8.1）'); process.exit(1) }
let tail = head + 1
while (tail < archLines.length && !/^(\}|```|interface )/.test(archLines[tail])) tail++
if (archLines.slice(head, tail).join('').trim() === '') { console.log('  FAIL § 8.1 那一段是空的'); process.exit(1) }
const archNames = []
for (const l of archLines.slice(head, tail)) for (const m of l.matchAll(/t:\s*'([a-zA-Z]+\/[a-zA-Z]+|signal)'/g)) if (!archNames.includes(m[1])) archNames.push(m[1])
archNames.sort()

console.log('事件面（本仓库）')
ok(`代码里 ${codeNames.length} 条`)
ok(`架构里 ${archNames.length} 条`)
const inCodeNotArch = codeNames.filter((n) => !archNames.includes(n))
const inArchNotCode = archNames.filter((n) => !codeNames.includes(n))
if (inCodeNotArch.length === 0) ok('代码里每一条都在架构那一段里')
else bad('代码里有、架构 § 8.1 里没有：' + inCodeNotArch.join(' · '))
if (inArchNotCode.length === 0) ok('架构那一段里每一条都在代码里')
else bad('架构 § 8.1 里有、代码里没有：' + inArchNotCode.join(' · '))

// ── 够得到才查的那一半：归档 § 5.18 那张三面表里「事件面」那一格 ──────────────────
if (planPath === null) {
  console.log('事件面（归档 § 5.18 那张三面表）')
  console.log(`  info 归档那张表不在场（找过 ${PLAN_CANDIDATES.join(' · ')}）——那一半没查；架构那一半照查`)
} else {
  const planSrc = readFileSync(planPath, 'utf8')
  const at = planSrc.indexOf('| 事件面 |')
  if (at < 0) {
    bad('归档里找不到「事件面」那一格（三面表，§ 5.18）')
  } else {
    const lineEnd = planSrc.indexOf('\n', at)
    const cell = planSrc.slice(at, lineEnd < 0 ? undefined : lineEnd)
    const planNames = []
    for (const m of cell.matchAll(/`([a-zA-Z]+\/[a-zA-Z]+|signal)`/g)) if (!planNames.includes(m[1])) planNames.push(m[1])
    planNames.sort()
    console.log('事件面（归档 § 5.18 那张三面表）')
    ok(`计划里 ${planNames.length} 条`)
    const inCodeNotPlan = codeNames.filter((n) => !planNames.includes(n))
    const inPlanNotCode = planNames.filter((n) => !codeNames.includes(n))
    if (inCodeNotPlan.length === 0) ok('代码里每一条都在计划那张表里')
    else bad('代码里有、计划那张表里没有：' + inCodeNotPlan.join(' · '))
    if (inPlanNotCode.length === 0) ok('计划那张表里每一条都在代码里')
    else bad('计划那张表里有、代码里没有：' + inPlanNotCode.join(' · '))
    const declared = cell.match(/\*\*(\d+)\s*条事件族\*\*/)
    if (declared === null) bad('那一格里没有写「N 条事件族」——口头那个数也要有，不然逐条列出来多少都自洽')
    else if (Number(declared[1]) !== planNames.length) bad(`那一格说 ${declared[1]} 条，逐条列出来的是 ${planNames.length} 条`)
    else ok(`那一格那个数（${declared[1]}）与逐条列出来的条数相符`)
  }
}

console.log(fail.length ? `\n${fail.length} 项未通过` : '\n全部通过')
process.exit(fail.length ? 1 : 0)
