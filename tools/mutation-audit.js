#!/usr/bin/env node
// 变异审计：把源码里的一处算子改掉，看那一档**红不红**——不红的那一处就是"这个变异存活了"。
//
// 它在**审档**（nightly / 手动 dispatch）里跑，**只报不挡**：survivor 是发现，不是失败；只有
// 工具自己跑不动（树脏 · 没有靶子 · 收尾发现 src/ 有残留）才非零退出。
//
// **为什么自写、不现取现用**：硬边界第 4 条是"CI 永不真出网"，而 `npx` 一个变异器就等于出网；
// 而且作用范围要跟着本仓的形状走（真档一趟一分钟，快档才是判据）。自写的这个零依赖 · 纯文本 ·
// 本地一条命令跑得动，读数进提交序列。
//
// 用法：
//   node tools/mutation-audit.js [--root <仓库根>] [--out <报告>] [--budget-ms N]
//                                [--max-mutants N] [--lane fast|real|all] [--seed N]
//                                [--per-file N] [--target <路径>]…
//
// 口径（写死在这里，也写进报告）：
//   · **靶子**＝`src/**/*.ts`（不含 `*.test.ts`）里**有快档测试覆盖**的那些；覆盖＝快档测试文件
//     经 **import 链**够得到它（直接 import · 经帮手文件转手 · 经别的源文件转手都算）。按链算
//     不只是多几处靶子——**两段式判决**的预筛那一趟跑的就是"够得到它的测试"，链断一节预筛就瞎。
//     没有覆盖的源文件不进候选——报告里如实给"没覆盖"的个数。
//   · **判决分两段**：第一段只跑覆盖到靶子的那几个测试文件（同一个入口的点名子集那一趟），
//     **红了就地判被杀**——覆盖集是整档的子集，子集红整档必红，判决与跑整档一字不差；
//     **绿了（或挂住）才升格跑整档**，存活 · 被杀 · 挂住由整档定。绝大多数变异第一段几秒出
//     结果，整档那一趟只留给预筛说不准的那部分——同一条预算里跑得完的变异多出几倍。
//   · **算子**＝带空格的算子字面替换（` === ` → ` !== ` · ` >= ` → ` > ` · ` && ` → ` || ` ·
//     整词的 `true` → `false` 那一类）。要求两边有空白是为了**不制造语法错**：要问的是"断言
//     抓不抓得住"，不是"编译器过不过"。抓字面、零仪式；抓不到的形状（经变量的间接调用那一类）
//     记口径，不打补丁。每一处仍过一遍 `node --check`，语法先不过的另记一档（`skippedSyntax`）
//     ——但这条过滤器**每次先在没改过的靶子上校准**：`node --check` 认不认 TS 看它附近的
//     package.json（实测），判不了就如实记进报告并干脆不用它，而不是交一份"跑了 0 处"的报告。
//   · **终判的路**＝`node tools/test-entry.js <档>`（缺省快档），与 CI 同一条，不另立第二条
//     测试路；预筛走的是**同一个入口**的点名子集。跑完**恢复原字节**，收尾再核一遍 `src/` 在
//     git 里一条没变。
//   · **时限**＝`--budget-ms`（缺省 15 分钟）：到点就停，报告里如实写"跑了几个 · 还剩几个没跑"。
//   · **排队**＝上次发版（最近的 tag）以来动过的源文件**排头**——夜审第一趟先盯新代码；其余
//     候选按路径排序，起点 = `--seed`（缺省当天日期）对余下候选数取模轮转——一夜跑不完的部分
//     下一夜从别处开始，长期把整条清单盖完。没有 tag（浅克隆 · 初仓）就纯轮转，不红。
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discover, splitLanes } from './test-entry.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 报告的形状版本（没进冻结面，但它自己带号：形状变了读报告的人看得出来）。 */
export const SCHEMA = 2

export const LANES = ['fast', 'real', 'all']

/** 算子表。带空格的写法是**故意**的：不制造语法错，也不咬 `=>` / `>>` 那一类。 */
export const OPERATORS = [
  { operator: '===', from: ' === ', to: ' !== ' },
  { operator: '!==', from: ' !== ', to: ' === ' },
  { operator: '>=', from: ' >= ', to: ' > ' },
  { operator: '<=', from: ' <= ', to: ' < ' },
  { operator: '&&', from: ' && ', to: ' || ' },
  { operator: '||', from: ' || ', to: ' && ' },
  { operator: 'true', from: 'true', to: 'false', word: true },
  { operator: 'false', from: 'false', to: 'true', word: true },
]

/** 今天的日期当轮转起点（`--seed` 覆盖它，本地复现用）。 */
export function daySeed(d = new Date()) {
  return Number(d.toISOString().slice(0, 10).replaceAll('-', ''))
}

function walkRel(abs, out = []) {
  // 目录不在（比如没有 test/ 的仓）就当它空——与入口 discover 同一种容忍。
  let entries
  try {
    entries = readdirSync(abs, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(abs, e.name)
    if (e.isDirectory()) walkRel(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** 一棵目录下的全部 `.ts`，仓库相对的 posix 路径。 */
function relTs(root, dir) {
  return walkRel(join(root, dir))
    .map((p) => relative(root, p).split('\\').join('/'))
    .sort()
}

function occurrences(text, from, word) {
  const out = []
  if (word === true) {
    const re = new RegExp('\\b' + from + '\\b', 'g')
    let m
    while ((m = re.exec(text)) !== null) out.push(m.index)
  } else {
    let i = text.indexOf(from)
    while (i !== -1) {
      out.push(i)
      i = text.indexOf(from, i + 1)
    }
  }
  return out
}

function lineAt(text, at) {
  return text.slice(0, at).split('\n').length
}

/** 一个测试文件里的 import 说明符（单引号与双引号两种写法都认：判据是说明符，不是引号风格）。 */
export function specifiers(text) {
  return [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
}

/** `src/materialize/ensure.test.ts` 里的 `../delta.ts` → `src/delta.ts`（非相对说明符给 null）。
 *  **不改后缀**：说明符说什么就是什么（改不改由 `resolveSource` 去试）。 */
export function resolveSpecifier(testRel, spec) {
  if (!spec.startsWith('.')) return null
  return posix.normalize(posix.join(posix.dirname(testRel), spec))
}

/** 说明符指向的**仓内文件**：仓里的源码是 `.ts`，所以 `.js` 后缀也试一次同名 `.ts`。
 *  名单给什么范围就解析到什么范围（候选只给 `src/` 的源文件，import 图给全部仓内 `.ts`）。 */
export function resolveSource(testRel, spec, sources) {
  const p = resolveSpecifier(testRel, spec)
  if (p === null) return null
  if (sources.includes(p)) return p
  if (p.endsWith('.js') && sources.includes(p.slice(0, -3) + '.ts')) return p.slice(0, -3) + '.ts'
  return null
}

/** `src/` 与 `test/` 下每个 `.ts` 各自 import 了哪些**源文件**（候选范围里的）。帮手文件与
 *  测试文件都在图上：链 `测试 → 帮手 → 源` 与 `测试 → 源 → 源` 都要走得通。 */
function importGraph(root, sources) {
  const files = [...new Set([...relTs(root, 'src'), ...relTs(root, 'test')])]
  const deps = new Map()
  for (const f of files) {
    let text
    try {
      text = readFileSync(join(root, f), 'utf8')
    } catch {
      continue
    }
    const out = []
    for (const spec of specifiers(text)) {
      const t = resolveSource(f, spec, sources)
      if (t !== null) out.push(t)
    }
    deps.set(f, out)
  }
  return deps
}

/** import 链可达的覆盖：从源文件沿"谁 import 我"往回走，走到的是**所选档的测试**就收。
 *  间接够得到也算——预筛那一趟要跑的正是这份名单（少了它，深处模块的变异全得升格跑整档）。 */
function coveringOf(source, deps, testSet) {
  const importers = new Map()
  for (const [f, ds] of deps) {
    for (const d of ds) {
      if (!importers.has(d)) importers.set(d, [])
      importers.get(d).push(f)
    }
  }
  const seen = new Set([source])
  const found = new Set()
  const stack = [source]
  while (stack.length > 0) {
    const cur = stack.pop()
    for (const imp of importers.get(cur) ?? []) {
      if (seen.has(imp)) continue
      seen.add(imp)
      if (testSet.has(imp)) found.add(imp)
      stack.push(imp)
    }
  }
  return [...found].sort()
}

/** 上次发版（最近的 tag）以来 `src/` 下动过的源文件（不含测试）。没有 tag（浅克隆 · 初仓）
 *  或 git 读不动就给空——排队退回纯轮转，不红。 */
export function changedSinceLastTag(root) {
  const t = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: root, encoding: 'utf8' })
  if (t.status !== 0 || (t.stdout ?? '').trim() === '') return { tag: null, files: [] }
  const tag = t.stdout.trim()
  const d = spawnSync('git', ['diff', '--name-only', tag, 'HEAD', '--', 'src'], { cwd: root, encoding: 'utf8' })
  if (d.status !== 0) return { tag: null, files: [] }
  const files = (d.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s.endsWith('.ts') && !s.endsWith('.test.ts'))
    .map((s) => s.split('\\').join('/'))
  return { tag, files }
}

/** 候选清单：谁有覆盖 · 每一处算子在哪一行 · 先跑谁。轮转起点由 seed 定，发版以来动过的排头。 */
export function plan({ root = ROOT, lane = 'fast', seed = daySeed(), perFile = 2, targets = null, changed = undefined } = {}) {
  const sources = relTs(root, 'src').filter((p) => !p.endsWith('.test.ts'))
  // 分档用入口自己那套判据（`splitLanes`），不在审计里另立一份。
  const { fast, real } = splitLanes(discover(root))
  const laneFiles = lane === 'fast' ? fast : lane === 'real' ? real : [...fast, ...real]
  const tests = laneFiles.map((p) => relative(root, p).split('\\').join('/')).sort()
  const testSet = new Set(tests)
  const deps = importGraph(root, sources)
  const covering = new Map()
  for (const src of sources) {
    const ts = coveringOf(src, deps, testSet)
    if (ts.length > 0) covering.set(src, ts)
  }
  const list = []
  for (const src of [...covering.keys()].sort()) {
    if (targets !== null && !targets.some((t) => src === t || src.endsWith('/' + t) || src.endsWith(t))) continue
    const text = readFileSync(join(root, src), 'utf8')
    let n = 0
    for (const op of OPERATORS) {
      for (const at of occurrences(text, op.from, op.word === true)) {
        if (n >= perFile) break
        list.push({ file: src, line: lineAt(text, at), operator: op.operator, from: op.from, to: op.to, at })
        n++
      }
      if (n >= perFile) break
    }
  }
  const picked = changed !== undefined ? changed : changedSinceLastTag(root).files
  const changedSet = new Set(picked)
  const priority = list.filter((m) => changedSet.has(m.file))
  const rest = list.filter((m) => !changedSet.has(m.file))
  const start = rest.length === 0 ? 0 : ((seed % rest.length) + rest.length) % rest.length
  return {
    scope: {
      lane,
      sourceFiles: sources.length,
      covered: covering.size,
      uncovered: sources.length - covering.size,
      candidates: list.length,
      priority: priority.length,
      sinceTag: changed !== undefined ? null : changedSinceLastTag(root).tag,
      startAt: start,
      targets,
      covering: Object.fromEntries([...covering.entries()].sort()),
    },
    covering,
    queue: [...priority, ...rest.slice(start), ...rest.slice(0, start)],
  }
}

/** `src/` 在 git 里的样子：跑前必须是干净的，跑后必须还原。 */
export function gitStatus(root, paths = ['src']) {
  const r = spawnSync('git', ['status', '--porcelain', '--', ...paths], { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) {
    return { out: '', error: (r.stderr || r.error?.message || 'git status 非零退出').trim() }
  }
  return { out: r.stdout.trim(), error: null }
}

/** 语法先不过的变异不进判决（判的是断言，不是编译器）。
 *
 *  实测：`node --check x.ts` 认不认 TS 看它**附近的 package.json**——同一个文件放在
 *  `/tmp/exp1/`（没有 package.json）报 `SyntaxError: Unexpected token ':'`（类型标注没被剥），
 *  放一份 `package.json`（`"type"` 是 module 还是 commonjs 都一样）就 OK。本仓库有 package.json，
 *  所以真仓这条过滤器可用；但它**不是**天经地义的，所以 `audit()` 每次先在没改过的靶子上校准一次。 */
export function syntaxOk(abs) {
  return spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' }).status === 0
}

/** 跑一整档（或点名的那几个文件）——与 CI 同一条路（入口那一条命令），不另立第二条。
 *  `files` 给了就只跑点名的那些；入口自己会核它们属于这一档。 */
export function runLane(root, lane, timeoutMs = 300000, files = undefined) {
  const env = { ...process.env }
  // 同 `tools/ci-timing.js`：`NODE_TEST_CONTEXT` 一在场，`node --test` 会静默跳过所有文件并退 0
  // ——那会让每一个变异都"活下来"（假"存活"）。CI 上不存在这个变量，只有嵌套夹具会撞上。
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, [join(root, 'tools', 'test-entry.js'), lane, ...(files ?? [])], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1 << 26,
    env,
  })
}

function tail(s, n) {
  const t = s.replace(/\s+$/, '')
  return t.length <= n ? t : '…' + t.slice(-n)
}

const timedOutRun = (r) => r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT'

/**
 * 跑一趟审计。判据全在参数里，副作用只有"改一个文件再还原"。
 * 返回 `{ report, code, message }`：`report === null` 时 `message` 是拒绝的理由。
 */
export function audit(o = {}) {
  const root = o.root ?? ROOT
  const lane = o.lane ?? 'fast'
  const budgetMs = o.budgetMs ?? 900000
  const maxMutants = o.maxMutants ?? Number.POSITIVE_INFINITY
  const perFile = o.perFile ?? 2
  const seed = o.seed ?? daySeed()
  const targets = o.targets ?? null
  const timeoutMs = o.timeoutMs ?? 300000
  const now = o.now ?? Date.now
  const run = o.run ?? runLane
  const check = o.check ?? syntaxOk
  const say = o.say ?? ((s) => process.stdout.write(s + '\n'))

  const before = gitStatus(root, ['src'])
  if (before.error !== null) return { report: null, code: 2, message: '读不到 git 状态：' + before.error }
  if (before.out !== '') {
    return {
      report: null,
      code: 2,
      message: 'src/ 不干净，拒绝在它上面跑审计（免得把没提交的改动算成读数，也免得覆盖它）：\n' + before.out,
    }
  }

  const { scope, queue, covering } = plan({ root, lane, seed, perFile, targets })
  if (queue.length === 0) {
    return { report: null, code: 1, message: '这个范围内没有靶子（没有快档覆盖的源文件，或 --target 没匹配上）' }
  }

  const t0 = now()
  const results = []
  let ran = 0
  let skippedSyntax = 0
  let timedOut = 0
  let laneRuns = 0
  let prefilterKilled = 0
  // 过滤器自校准：先在**没改过**的靶子上试一次。连原样都判不过，说明这个仓里 `node --check`
  // 判不了 TS——如实记进报告，并**不用它**（判据退回那一档的红绿），而不是把每一处都记成
  // "语法先不过"然后交一份跑了 0 处的报告。
  const syntaxFilter = check(join(root, queue[0].file)) === true
  for (const m of queue) {
    if (ran >= maxMutants) break
    if (ran > 0 && now() - t0 >= budgetMs) break
    const abs = join(root, m.file)
    const original = readFileSync(abs, 'utf8')
    const mutated = original.slice(0, m.at) + m.to + original.slice(m.at + m.from.length)
    if (mutated === original) continue
    writeFileSync(abs, mutated)
    try {
      if (syntaxFilter && !check(abs)) {
        skippedSyntax++
        results.push({ file: m.file, line: m.line, operator: m.operator, verdict: 'skipped-syntax', wallMs: 0, exitCode: null, outputTail: '', killedBy: null })
        continue
      }
      say('  ' + m.file + ':' + m.line + '  ' + m.from.trim() + ' → ' + m.to.trim())
      const t1 = now()
      // 第一段（预筛）：只跑够得到这一处的测试。子集红 ⇒ 整档红——就地判被杀，整档不用跑；
      // 挂住说明不了红绿，不算数。
      const cover = covering.get(m.file) ?? []
      let verdict = null
      let killedBy = null
      let exitCode = null
      let outputTail = ''
      if (cover.length > 0) {
        const ra = run(root, lane, timeoutMs, cover)
        if (!timedOutRun(ra) && (ra.status ?? 0) !== 0) {
          verdict = 'killed'
          killedBy = 'prefilter'
          exitCode = ra.status ?? null
          outputTail = tail((ra.stdout ?? '') + (ra.stderr ?? ''), 600)
        }
      }
      // 第二段（升格）：整档定终身——与 CI 同一条路。
      if (verdict === null) {
        const rb = run(root, lane, timeoutMs)
        laneRuns++
        const timeout = timedOutRun(rb)
        exitCode = rb.status ?? null
        verdict = timeout ? 'timeout' : exitCode === 0 ? 'survived' : 'killed'
        if (verdict === 'killed') killedBy = 'lane'
        if (timeout) timedOut++
        outputTail = tail((rb.stdout ?? '') + (rb.stderr ?? ''), 600)
      }
      ran++
      if (killedBy === 'prefilter') prefilterKilled++
      if (verdict === 'survived') say('    存活：这一处改了，' + lane + ' 档照旧全绿')
      results.push({
        file: m.file,
        line: m.line,
        operator: m.operator,
        verdict,
        killedBy,
        coveringFiles: cover.length,
        wallMs: now() - t1,
        exitCode,
        outputTail,
      })
    } finally {
      writeFileSync(abs, original)
    }
  }

  const usedMs = now() - t0
  const after = gitStatus(root, ['src'])
  const clean = after.error === null && after.out === ''
  const count = (v) => results.filter((r) => r.verdict === v).length
  const report = {
    schema: SCHEMA,
    generatedAt: new Date(now()).toISOString(),
    root,
    lane,
    budgetMs,
    usedMs,
    seed,
    syntaxFilter,
    scope,
    counts: {
      candidates: queue.length,
      ran,
      killed: count('killed'),
      survived: count('survived'),
      timeout: timedOut,
      skippedSyntax,
      skippedBudget: queue.length - ran - skippedSyntax,
      prefilterKilled,
      laneRuns,
    },
    clean,
    results,
  }
  return { report, code: clean ? 0 : 1, message: clean ? '' : '跑完 src/ 有残留（没还原干净）：\n' + after.out }
}

/** 给人看的那几行。 */
export function reportToText(r) {
  const sec = (ms) => Math.round(ms / 1000) + 's'
  const out = []
  out.push('变异审计 · 档 ' + r.lane + ' · 预算 ' + sec(r.budgetMs) + ' · 用时 ' + sec(r.usedMs) + ' · seed ' + r.seed)
  out.push(
    '靶子：有' + r.lane + '档覆盖的源文件 ' + r.scope.covered + ' / ' + r.scope.sourceFiles +
      '（没覆盖的 ' + r.scope.uncovered + ' 不进候选）· 候选 ' + r.scope.candidates + ' 处 · 优先 ' +
      r.scope.priority + ' 处（自 ' + (r.scope.sinceTag ?? '无 tag') + '）· 其余起点 ' + r.scope.startAt,
  )
  out.push(
    '跑了 ' + r.counts.ran + ' 处：被杀 ' + r.counts.killed + '（预筛 ' + r.counts.prefilterKilled +
      '）· 存活 ' + r.counts.survived +
      ' · 挂住 ' + r.counts.timeout + ' · 语法先不过 ' + r.counts.skippedSyntax +
      ' · 时限外没跑 ' + r.counts.skippedBudget + ' · 整档跑了 ' + r.counts.laneRuns + ' 趟',
  )
  if (r.syntaxFilter !== true) {
    out.push('语法过滤器：这个仓里 `node --check` 判不了 `.ts`（附近没有 package.json）——没用它，判据退回那一档的红绿')
  }
  for (const x of r.results) {
    if (x.verdict === 'survived') out.push('  存活：' + x.file + ':' + x.line + '（' + x.operator + '）')
  }
  out.push('树：跑前干净 · 跑后 ' + (r.clean ? 'src/ 一条没变' : '**有残留**'))
  return out.join('\n')
}

const USAGE =
  '用法：node tools/mutation-audit.js [--root <仓库根>] [--out <报告>] [--budget-ms N] [--max-mutants N]\n' +
  '                                [--lane fast|real|all] [--seed N] [--per-file N] [--target <路径>]…'

function usage(why) {
  process.stderr.write(USAGE + '\n' + why + '\n')
}

/** 参数读进 opts；读不动就给出理由（不猜、不取缺省）。 */
function parseArgs(argv, opts) {
  const need = {
    '--root': 'root',
    '--out': 'out',
    '--lane': 'lane',
    '--seed': 'seed',
    '--per-file': 'perFile',
    '--budget-ms': 'budgetMs',
    '--max-mutants': 'maxMutants',
    '--target': 'targets',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const key = need[a]
    if (key === undefined) return '不认识的参数：' + a
    const v = argv[++i]
    if (v === undefined) return a + ' 后面缺值'
    if (key === 'targets') opts.targets = (opts.targets ?? []).concat([v])
    else if (key === 'lane') {
      if (!LANES.includes(v)) return '档只有 ' + LANES.join(' · ')
      opts.lane = v
    } else if (key === 'root' || key === 'out') opts[key] = resolve(v)
    else {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) return a + ' 要一个非负数'
      opts[key] = n
    }
  }
  return null
}

export function main(argv) {
  const opts = {
    root: ROOT,
    out: null,
    budgetMs: 900000,
    maxMutants: Number.POSITIVE_INFINITY,
    lane: 'fast',
    seed: daySeed(),
    perFile: 2,
    targets: null,
  }
  const bad = parseArgs(argv, opts)
  if (bad !== null) {
    usage(bad)
    return 2
  }
  const { report, code, message } = audit(opts)
  if (report === null) {
    process.stderr.write(message + '\n')
    return code
  }
  process.stdout.write(reportToText(report) + '\n')
  if (opts.out !== null) {
    writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n')
    process.stdout.write('报告：' + opts.out + '\n')
  }
  return code
}

// 直接运行时才执行；被测试 import 时不执行。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
