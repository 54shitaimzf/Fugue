// 黄金帧的**录制器**（0.4.2 站）：把今天两条脸印出来的字节录下来。
//
// 依据：施工单 § 五 ①「先录帧、后外移渲染，一命令一单元渐进迁移」· § 一「先把今天的输出录下来，再挪渲染」。
//
// 一条探针 = 从一个**固定现场的快照**起，跑它自己那串命令（前几条造更细的现场，最后一条是
// **被录的那一条**）。录的是最后那一条的两股输出：不给 `--json` 的人读缺省面 · 给了 `--json`
// 的机器面。录制走**真子进程**（`node src/cli/fugue.ts`）——与壳那一条路同一个进程形状，
// 量的是真的字节。
//
//   · 全量重录：`node test/golden/record.mjs`
//   · 只重录点名的：`node test/golden/record.mjs status-人面 read-人面`
//
// 现场与那一串步骤住在 `fixture.mjs`（`golden.test.ts` 读同一份）；这一份只管**重新录一遍**。
//
// 为什么这不是「产品的一部分」：它是**取证脚本**（AGENTS § 七 那张表的最后一行）。真源是
// `frames/*.json` 那份录制与 `golden.test.ts` 那条断言。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeFace } from './normalize.mjs'
import { FRAMES, cloneSeed, disposePathFarm, pathWithoutBwrap, runStep, seedSnapshot } from './fixture.mjs'

/** 配置里那几条（值全是 ASCII——`config set` 的值按 JSON 解析，非 ASCII 那一档会当场拒）。 */
const SET_ACTION = { argv: ['config', 'set', 'actions.build', '{"argv":["true"]}'] }
const SET_SPLIT = {
  argv: [
    'config',
    'set',
    'round.split',
    '[{"goal":"edit a.txt","ownedPaths":["a.txt"],"assertions":[{"action":"build","name":"build ok"}]}]',
  ],
}
/** 验收断言：轮次那一族跑起来要它（零条会让打回率没有分母）。 */
const SET_ASSERT = {
  argv: ['config', 'set', 'round.assertions', '[{"name":"build ok","argv":["/bin/sh","-c","true"]}]'],
}

/**
 * 一条探针。`steps` 里除最后一条都是造现场的；最后一条是被录的。
 *
 * `stdin`：那一步的 stdin 原文（`write --stdin` 要它）。
 * `timeoutMs`：不返回的命令（`watch --follow`）到点收走——收走之后 stdout 上那一段就是
 * 「到那个点为止读到的东西」，它本身是一条读数。
 * `fresh` / `freshCommand`：被录的那一条落在**另一个刚复制出来的根**上（`round run` 那种把
 * 现场搅乱的命令）；`steps` 只负责把配置与草案摆出来。
 * 探针里的 `{{C1}}` 是**现场那一份的提交号**：录制与重放各自实算一次。
 */
export const PROBES = [
  { id: 'status-人面', steps: [{ argv: ['status'] }] },
  { id: 'status-json面', steps: [{ argv: ['--json', 'status'] }] },
  { id: 'status-metrics-report', steps: [{ argv: ['--json', 'status', '--metrics', '--report'] }] },
  { id: 'status-ledger', steps: [{ argv: ['--json', 'status', '--ledger'] }] },
  { id: 'status-agent', steps: [{ argv: ['status', '--agent', 'round'] }] },
  { id: 'read-人面', steps: [{ argv: ['read', 'a.txt'] }] },
  { id: 'read-json面', steps: [{ argv: ['--json', 'read', 'a.txt'] }] },
  { id: 'list-人面', steps: [{ argv: ['list'] }] },
  { id: 'list-json面', steps: [{ argv: ['--json', 'list'] }] },
  { id: 'stat-人面', steps: [{ argv: ['stat', 'a.txt'] }] },
  { id: 'stat-json面', steps: [{ argv: ['--json', 'stat', 'a.txt'] }] },
  { id: 'revs-人面', steps: [{ argv: ['revs'] }] },
  { id: 'revs-json面', steps: [{ argv: ['--json', 'revs'] }] },
  { id: 'diff-人面', steps: [{ argv: ['diff'] }] },
  { id: 'diff-json面', steps: [{ argv: ['--json', 'diff', '--since', '0'] }] },
  { id: 'write-人面', steps: [{ argv: ['write', 'c.txt', '--stdin'], stdin: 'gamma\n' }] },
  { id: 'write-json面', steps: [{ argv: ['--json', 'write', 'c.txt', '--stdin'], stdin: 'gamma\n' }] },
  { id: 'rename-人面', steps: [{ argv: ['rename', 'b.txt', 'b2.txt'] }] },
  { id: 'rename-json面', steps: [{ argv: ['--json', 'rename', 'b.txt', 'b2.txt'] }] },
  { id: 'chmod-人面', steps: [{ argv: ['chmod', 'a.txt', '755'] }] },
  { id: 'chmod-json面', steps: [{ argv: ['--json', 'chmod', 'b.txt', '755'] }] },
  { id: 'remove-人面', steps: [{ argv: ['remove', 'b.txt'] }] },
  { id: 'remove-json面', steps: [{ argv: ['--json', 'remove', 'b.txt'] }] },
  { id: 'commit-人面', steps: [{ argv: ['commit', '-m', '第二版'] }] },
  { id: 'commit-json面', steps: [{ argv: ['--json', 'commit', '-m', '第二版'] }] },
  { id: 'log-人面', steps: [{ argv: ['log'] }] },
  { id: 'log-json面', steps: [{ argv: ['--json', 'log'] }] },
  { id: 'log-无钟', steps: [{ argv: ['write', 'c.txt', '--no-clock', '--stdin'], stdin: 'gamma\n' }, { argv: ['log'] }] },
  { id: 'watch-一遍', steps: [{ argv: ['watch'] }] },
  { id: 'watch-json面', steps: [{ argv: ['--json', 'watch'] }] },
  { id: 'watch-follow', steps: [{ argv: ['watch', '--follow', '--interval', '50'], timeoutMs: 700 }] },
  { id: 'watch-resume', steps: [{ argv: ['watch', '--resume', 'round:1'] }] },
  { id: 'tui-once', steps: [{ argv: ['tui', '--once'] }] },
  { id: 'config-ls-人面', steps: [{ argv: ['config', 'ls'] }] },
  { id: 'config-ls-json面', steps: [{ argv: ['--json', 'config', 'ls'] }] },
  { id: 'config-set', steps: [SET_ACTION] },
  { id: 'config-get', steps: [SET_ACTION, { argv: ['config', 'get', 'actions.build'] }] },
  { id: 'config-show-json面', steps: [SET_ACTION, { argv: ['--json', 'config', 'show'] }] },
  { id: 'config-bad-key', note: '拒绝那一档', steps: [{ argv: ['config', 'get', 'nope.nope'] }] },
  { id: 'policy-人面', pinLayers: true, steps: [{ argv: ['policy'] }] },
  { id: 'policy-json面', pinLayers: true, steps: [{ argv: ['--json', 'policy'] }] },
  { id: 'doctor-人面', pinLayers: true, steps: [{ argv: ['doctor'] }] },
  { id: 'doctor-json面', pinLayers: true, steps: [{ argv: ['--json', 'doctor'] }] },
  { id: 'assemble-人面', steps: [{ argv: ['assemble', 'subagent'] }] },
  { id: 'assemble-json面', steps: [{ argv: ['--json', 'assemble', 'subagent'] }] },
  { id: 'branch-人面', steps: [{ argv: ['branch', '{{C1}}'] }] },
  { id: 'branch-json面', steps: [{ argv: ['--json', 'branch', '{{C1}}'] }] },
  { id: 'branch-成功人面', steps: [{ argv: ['--agent', 'worker1', 'branch', '{{C1}}'] }] },
  { id: 'branch-成功json面', steps: [{ argv: ['--agent', 'worker1', '--json', 'branch', '{{C1}}'] }] },
  { id: 'replay-人面', steps: [{ argv: ['replay'] }] },
  { id: 'replay-json面', steps: [{ argv: ['--json', 'replay'] }] },
  { id: 'replay-verify', steps: [{ argv: ['replay', '--verify'] }] },
  {
    id: 'diff-stat-人面',
    steps: [{ argv: ['fork', '{{C1}}', '--strategy', 'copy'] }, { argv: ['diff-stat'] }],
  },
  {
    id: 'diff-stat-json面',
    steps: [{ argv: ['fork', '{{C1}}', '--strategy', 'copy'] }, { argv: ['--json', 'diff-stat'] }],
  },
  { id: 'fork-人面', steps: [{ argv: ['fork', '{{C1}}', '--strategy', 'copy'] }] },
  { id: 'fork-json面', steps: [{ argv: ['--json', 'fork', '{{C1}}', '--strategy', 'copy'] }] },
  { id: 'ensure-人面', steps: [{ argv: ['fork', '{{C1}}', '--strategy', 'copy'] }, { argv: ['ensure'] }] },
  {
    id: 'ensure-json面',
    steps: [{ argv: ['fork', '{{C1}}', '--strategy', 'copy'] }, { argv: ['--json', 'ensure'] }],
  },
  {
    id: 'verify-mat-人面',
    steps: [
      { argv: ['fork', '{{C1}}', '--strategy', 'copy'] },
      { argv: ['ensure'] },
      { argv: ['verify-mat'] },
    ],
  },
  {
    id: 'dispose-人面',
    steps: [
      { argv: ['fork', '{{C1}}', '--strategy', 'copy'] },
      { argv: ['ensure'] },
      { argv: ['dispose'] },
    ],
  },
  { id: 'run-人面', pinLayers: true, steps: [SET_ACTION, { argv: ['fork', '{{C1}}', '--strategy', 'copy'] }, { argv: ['run', 'build'] }] },
  {
    id: 'run-json面',
    pinLayers: true,
    steps: [SET_ACTION, { argv: ['fork', '{{C1}}', '--strategy', 'copy'] }, { argv: ['--json', 'run', 'build'] }],
  },
  { id: 'say-人面', steps: [{ argv: ['say', '把目标记下来'] }] },
  { id: 'say-json面', steps: [{ argv: ['--json', 'say', '把目标记下来'] }] },
  { id: 'round-plan-judge', steps: [SET_SPLIT, SET_ASSERT, { argv: ['round', 'plan', 'edit a.txt', '--judge'] }] },
  { id: 'round-new-人面', steps: [SET_SPLIT, { argv: ['round', 'new', 'edit a.txt'] }] },
  { id: 'round-new-json面', steps: [SET_SPLIT, { argv: ['--json', 'round', 'new', 'edit a.txt'] }] },
  {
    id: 'round-run-人面',
    note: '跑到头的轮次：拆 → 干 → 验 → 合并（打桩那一档），另给一个工作区跑',
    fresh: true,
    freshCommand: ['round', 'run', 'edit a.txt'],
    steps: [SET_SPLIT, SET_ASSERT],
  },
  {
    id: 'round-run-json面',
    note: '同上一档，`--json` 那一面',
    fresh: true,
    freshCommand: ['--json', 'round', 'run', 'edit a.txt'],
    steps: [SET_SPLIT, SET_ASSERT],
  },
  {
    id: 'round-work-人面',
    note: '放行之后接着跑：另给一个工作区，先 `round go` 再 `round work`',
    fresh: true,
    freshCommand: ['round', 'work'],
    steps: [
      SET_SPLIT,
      SET_ASSERT,
      SET_ACTION,
      { argv: ['round', 'new', 'edit a.txt'] },
      { argv: ['round', 'go'] },
    ],
  },
  { id: 'version-人面', steps: [{ argv: ['--version'] }] },
  { id: 'version-json面', steps: [{ argv: ['--json', '--version'] }] },
  { id: 'help', steps: [{ argv: ['--help'] }] },
]

/** 把一帧要的那一份抄下来（`steps` 里那几步 + 被录的那一条的两股输出）。 */
export function frameOf(probe, face, norm) {
  return {
    id: probe.id,
    note: probe.note ?? '',
    ...(probe.pinLayers === true ? { pinLayers: true } : {}),
    ...(probe.fresh === true ? { fresh: true, freshCommand: probe.freshCommand } : {}),
    steps: probe.steps.map((s) => ({
      argv: s.argv,
      ...(s.stdin === undefined ? {} : { stdin: s.stdin }),
      ...(s.timeoutMs === undefined ? {} : { timeoutMs: s.timeoutMs }),
      ...(s.env === undefined ? {} : { env: s.env }),
    })),
    face: norm,
  }
}

/**
 * 录一条探针。**两条脸的那一条命令是最后一步**；`fresh` 那一档另起一个刚复制出来的根。
 * 返回 `{ face, paths }`——`paths` 是这一趟里出现过的那几条路径（规范化要用它）。
 */
export function recordProbe(probe, seed) {
  const { root, sys } = cloneSeed(seed)
  const vars = { C1: seed.c1 }
  // 钉层：带 `pinLayers` 的探针，它的每一步（含另起那一档的 `freshCommand`）都走无 bwrap 的 PATH。
  const pin = probe.pinLayers === true ? { PATH: pathWithoutBwrap() } : undefined
  const steps = pin === undefined ? probe.steps : probe.steps.map((s) => ({ ...s, env: { ...pin, ...(s.env ?? {}) } }))
  let face = null
  try {
    for (const [i, step] of steps.entries()) {
      const r = runStep(root, sys, step, vars)
      if (probe.fresh !== true && i === probe.steps.length - 1) face = r
    }
    if (probe.fresh === true) {
      const fresh = cloneSeed({ root, sys }, 'fugue-golden-fresh-')
      try {
        face = runStep(fresh.root, fresh.sys, { argv: probe.freshCommand, timeoutMs: 180_000, ...(pin === undefined ? {} : { env: { ...pin } }) }, vars)
      } finally {
        rmSync(fresh.root, { recursive: true, force: true })
      }
    }
    return { face, paths: [root, sys, seed.root, seed.sys] }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function main() {
  const wanted = process.argv.slice(2)
  mkdirSync(FRAMES, { recursive: true })
  const picked = wanted.length === 0 ? PROBES : PROBES.filter((p) => wanted.includes(p.id))
  const missing = wanted.filter((w) => !PROBES.some((p) => p.id === w))
  if (missing.length > 0) {
    process.stderr.write(`没有这些探针：${missing.join(' · ')}\n`)
    process.exit(2)
  }
  const seed = seedSnapshot()
  const report = []
  try {
    for (const probe of picked) {
      const { face, paths } = recordProbe(probe, seed)
      if (face === null) continue
      const norm = normalizeFace(face, paths)
      writeFileSync(join(FRAMES, `${probe.id}.json`), JSON.stringify(frameOf(probe, face, norm), null, 2) + '\n')
      report.push(`${probe.id}\t退出码 ${norm.code}\tstdout ${norm.stdout.length}\tstderr ${norm.stderr.length}`)
    }
  } finally {
    rmSync(seed.root, { recursive: true, force: true })
    disposePathFarm()
  }
  process.stdout.write(report.join('\n') + `\n（帧目录：${FRAMES}；共 ${picked.length} 条）\n`)
}

// **只有直接运行才执行**（`golden.test.ts` 要 import 这一份的探针表与录制那一步）。
const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
