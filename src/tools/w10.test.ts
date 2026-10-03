// W10 的断言：视野的边界（PLAN § 5.17 的七条判据 · 架构 § 8.11 约束 3）。
// 跑法：cd ~/fugue && node --test src/tools/w10.test.ts
// ⑤ 那一条：事件联合与架构 § 8.1 两样都在本仓库里，所以缺省就真跑（不跳过）；归档 § 5.18 那一半
//   住在文档工作区，够不到时脚本自己印一行说没查。要指过去就：
//   FUGUE_PLAN=/mnt/c/Users/Administrator/Desktop/CodeWish/PLAN-ARCHIVE.md node --test src/tools/w10.test.ts
//
//  ① 超上限的回执：头 4 KiB 与尾 4 KiB 逐字是原文的头尾（切点回退到完整字符，半个汉字都没有）；
//     标记与定死的那句逐字相符，M · N · L 与原文逐个数对得上；回执 ≤ 8 KiB + 标记那一行
//  ② 不到上限的：回执逐字节原样（截断不许误伤小输出）
//  ③ `bash` / `run_action` 的回执里逐字查不到「毫秒」
//  ④ `exit_plan_mode` / `ask_user_question` 的回执里提到的每一个命令，在命令面真实存在
//  ⑤ 事件面双向对账：`tools/check-events.js` 数 `events.ts` 联合的判别名，与归档 § 5.18 那张表相符
//  ⑥ 交接两句去系统内容：分支名 · `coord.id` · 交接步数一个都查不到（事件里那两栏照记）
//  ⑦ **负对照**：把截断上限调成 0 → 判据 ② 当场红
//
// 板子与 `w8.test.ts` 同一套（真 git 仓库 · 真日志 · 真视图 · 真工具面）；模型是脚本化的，不联网。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openLog } from '../log/log.ts'
import type { LogHandle } from '../log/log.ts'
import { openTruth } from '../truth/truth.ts'
import { createRoots } from '../roots/roots.ts'
import { matParts } from '../roots/paths.ts'
import { clearMaterialization, removeTree } from '../materialize/mount.ts'
import { loadView } from '../view/view.ts'
import { lowerAt } from '../view/lower.ts'
import type { View } from '../view/contract.ts'
import { createToolHost } from './host.ts'
import { createToolExecutor } from '../capability/dispatch.ts'
import { capReceipt, MAX_RECEIPT_BYTES, RECEIPT_HEAD_BYTES, RECEIPT_TAIL_BYTES } from './receipt.ts'
import { faceOf, parseArgs } from './execute.ts'
import type { ToolHost } from './execute.ts'
import { refHeadOf } from '../round/head.ts'
import { emptyState } from '../assemble/sources.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { USAGE } from '../cli/fugue.ts'
import type { AgentId, CommitId, RelPath, WriterId } from '../terms.ts'
import type { AgentHandle, ToolCallRequest } from '../runtime/step.ts'

const AGENT = 'agent-1' as AgentId

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fugue',
  GIT_AUTHOR_EMAIL: 'fugue@localhost',
  GIT_COMMITTER_NAME: 'fugue',
  GIT_COMMITTER_EMAIL: 'fugue@localhost',
}

interface Bench {
  readonly root: string
  readonly log: LogHandle
  readonly truth: ReturnType<typeof openTruth>
  readonly base: CommitId
  readonly view: View
  readonly roots: ReturnType<typeof createRoots>
  readonly host: ToolHost
  readonly keep: (l: LogHandle) => void
  readonly close: () => Promise<void>
}

async function bench(): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-w10-'))
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const truth = openTruth(root)
  const log = openLog(root, { write: AGENT as WriterId, sync: 'each' })
  writeFileSync(join(root, 'README.md'), '底\n')
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV, encoding: 'utf8' }).status, 0)
  const made = spawnSync('git', ['commit', '-qm', '底'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(made.status, 0, made.stderr)
  const base = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout ?? '').trim() as CommitId
  const view = await loadView(log, AGENT as WriterId, { lower: lowerAt(truth, base) })
  const roots = createRoots(root as never)
  const host = createToolHost(view, roots, {
    actions: { writer: AGENT as WriterId, log, truth, head: await refHeadOf(log, AGENT as WriterId, base) },
    // P3b1 起 run_action 不再当 shell 命令跑：台子给一个最小的解析（③量的是回执的形状，不是
    // 绑定解析——那一条在 round/driver.test.ts 的 P3b1 里钉）。
    actionFor: () => ({ argv: ['/bin/sh', '-c', 'echo hi'], cwd: '' }),
  })
  const extra: LogHandle[] = []
  return {
    root,
    log,
    truth,
    base,
    view,
    roots,
    host,
    keep: (l) => extra.push(l),
    close: async () => {
      await log.close()
      for (const l of extra) await l.close().catch(() => undefined)
      await truth.close()
      clearMaterialization(
        matParts(root as never, AGENT).merged,
        ([AGENT] as AgentId[]).flatMap((a) => {
          const p = matParts(root as never, a)
          return [p.upper, p.merged, p.temp]
        }),
      )
      removeTree(root as never)
    },
  }
}

/** 这一格的句柄（走执行器时要的那一份；只读字段，值取这一格的坐标）。 */
function handleOf(): AgentHandle {
  return {
    agent: AGENT,
    coord: { id: AGENT, branch: `refs/heads/${AGENT}`, outputPaths: [] },
    branch: `refs/heads/${AGENT}` as never,
    contract: 'r1' as never,
    protocol: SUBAGENT_PROTOCOL,
    model: 'deepseek-flash/anthropic',
    wireModel: 'deepseek-flash',
    target: { providerId: 'fixture', host: '', wire: { name: 'anthropic-messages' }, path: '', model: 'deepseek-flash', from: 'fixture', headers: {} },
    adapter: { name: 'anthropic-messages' },
    state: { ...emptyState(), step: 0 },
  }
}

/** 一个执行器：接的是台子那一份真的工具面（截断就在它的出口上）。 */
function executorOf(b: Bench) {
  return createToolExecutor({
    logOf: () => b.log,
    host: b.host,
    fenceOf: (raw, cwd) => {
      const got = b.roots.resolveVirtual(raw, cwd as RelPath)
      return got.ok ? { ok: true as const, value: got.value } : { ok: false as const, error: got.error }
    },
    ensureOf: () => Promise.resolve(),
  })
}

const callOf = (name: string, args: unknown, id = 'c1'): ToolCallRequest => ({ id, name, arguments: JSON.stringify(args) })

/** 一段"够长"的正文：ASCII 与汉字交杂——切点落在汉字中间是最要防的那一档。 */
function bigText(lines: number): string {
  const out: string[] = []
  for (let i = 1; i <= lines; i++) {
    out.push(`${String(i).padStart(5, '0')}｜第 ${i} 行：这一段汉字要长到能把切点压在它中间，另有 ASCII 混着。`)
  }
  return out.join('\n') + '\n'
}

const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf8')

/** 把一个回执按定死的标记切成三段（解析不出来就是标记没按那句话说）。 */
function splitCapped(out: string): {
  readonly head: string
  readonly mark: string
  readonly tail: string
  readonly M: number
  readonly N: number
  readonly L: number
} {
  const m = out.match(/\n…\((\d+) bytes omitted · (\d+) bytes and (\d+) lines in all\)…\n/)
  assert.ok(m !== null, `回执里没有那一句定死的标记：${out.slice(0, 300)}`)
  const at = out.indexOf(m![0]!)
  return {
    head: out.slice(0, at),
    mark: m![0]!,
    tail: out.slice(at + m![0]!.length),
    M: Number(m![1]),
    N: Number(m![2]),
    L: Number(m![3]),
  }
}

/** 一个字符都不许被切坏：切出来的每一段都必须是合法的 UTF-8（不含替身字符 U+FFFD）。 */
function assertNoHalfChar(s: string, say: string): void {
  assert.ok(!s.includes('\uFFFD'), `${say}：切点落在多字节序列中间了（出现了替身字符）`)
  assert.equal(Buffer.from(s, 'utf8').toString('utf8'), s, `${say}：不是一段合法的 UTF-8`)
}

// ── ① 超上限：头尾逐字 · 标记逐字 · 三个数对得上 ────────────────────────────────

test('① 超上限的回执：头尾逐字是原文的头尾，标记与 M · N · L 逐字对得上', async () => {
  const text = bigText(400)
  assert.ok(bytesOf(text) > MAX_RECEIPT_BYTES, `样本要超过上限：${bytesOf(text)} 字节`)
  // 这一条走 `capReceipt` 本身（截断那一层）：`read` / `grep` / `bash` 的正文形状各不相同，
  // 而**截断只认一段文本**——判据 ① 判的就是那一层。
  const out = capReceipt(text)
  const { head, mark, tail, M, N, L } = splitCapped(out)

  // **头恰好是 4096**（切点只在「那个字符放不进去」时才回退，而 4096 这个位置恰好落在边界上）；
  // 尾是「至多 4096、且回退到完整字符」——回退只可能少一个多字节字符的字节数，绝不多。
  assert.equal(bytesOf(head), RECEIPT_HEAD_BYTES, `头该是 ${RECEIPT_HEAD_BYTES} 字节`)
  assert.ok(
    bytesOf(tail) <= RECEIPT_TAIL_BYTES && bytesOf(tail) > RECEIPT_TAIL_BYTES - 4,
    `尾该是至多 ${RECEIPT_TAIL_BYTES} 字节（回退到完整字符）：${bytesOf(tail)}`,
  )
  assert.ok(text.startsWith(head), '头必须是原文的头（逐字节）')
  assert.ok(text.endsWith(tail), '尾必须是原文的尾（逐字节）')
  assertNoHalfChar(head, '头')
  assertNoHalfChar(tail, '尾')

  assert.equal(mark, `\n…(${M} bytes omitted · ${N} bytes and ${L} lines in all)…\n`, '标记逐字')
  assert.equal(N, bytesOf(text), `N 该是原文的字节数 ${bytesOf(text)}`)
  assert.equal(L, text.split('\n').length - 1, 'L 该是原文的行数')
  assert.equal(M, N - bytesOf(head) - bytesOf(tail), 'M 该是「全文 − 头 − 尾」')

  assert.equal(bytesOf(out), bytesOf(head) + bytesOf(mark) + bytesOf(tail), '回执就是三段拼起来的')
  assert.ok(bytesOf(out) <= MAX_RECEIPT_BYTES + bytesOf(mark), `回执 ${bytesOf(out)} 字节，超了上限 + 标记`)
  console.log(
    `① 读数：原文 ${N} 字节 / ${L} 行 → 回执 ${bytesOf(out)} 字节（头 ${bytesOf(head)} + 标记 ${bytesOf(mark)} + 尾 ${bytesOf(tail)}，略去 ${M}）`,
  )
})

test('① 真实链路：read 仍截全文，grep 早停并如实报搜索不完整', async () => {
  const b = await bench()
  try {
    const text = bigText(400)
    await b.host.writeBytes('big.txt' as RelPath, new TextEncoder().encode(text))
    const exec = executorOf(b)
    const h = handleOf()

    const read = await exec.execute(callOf('read', { path: 'big.txt' }), h)
    assert.equal(read.ok, true, `read 该成：${read.output.slice(0, 200)}`)
    const r1 = splitCapped(read.output)
    // 标记里那两个数是**那条回执原文**的数（头那一行 + 正文），不是台子上那份 `text` 的数
    // ——`read` 的回执头本身也占字节与行。拿 `lineCount` 对原文核一遍（同一处口径）。
    const { lineCount } = await import('./receipt.ts')
    const receiptText = `big.txt (${bytesOf(text)} bytes · ${lineCount(text)} lines · mode 100644)\n${text}`
    assert.equal(r1.N, bytesOf(receiptText), 'N 是那条回执原文的字节数')
    assert.equal(r1.L, lineCount(receiptText), 'L 是那条回执原文的行数')
    assert.ok(read.output.endsWith(text.slice(-12)), '尾就是原文的尾')

    // `grep`：所有行都命中 → 命中那一串同样超上限。
    const grep = await exec.execute(callOf('grep', { pattern: '第' }, 'c2'), h)
    assert.equal(grep.ok, true, `grep 该成：${grep.output.slice(0, 200)}`)
    assert.match(grep.output, /Search stopped at the receipt budget/)
    assert.match(grep.output, /results are incomplete/)
    assert.doesNotMatch(grep.output, /bytes omitted/, '未扫全文，不冒充知道遗漏字节数')
    assert.ok(bytesOf(grep.output) <= MAX_RECEIPT_BYTES, '搜索本身留说明与步预算的余量')
    assertNoHalfChar(grep.output, 'grep 早停回执')
    assert.ok(r1.M > 0, 'read 仍从统一出口截全文')
    console.log(`① 链路读数：read 略去 ${r1.M}；grep 回执 ${bytesOf(grep.output)} 字节，明确早停与不完整`)
  } finally {
    await b.close()
  }
})

// ── ② 不到上限的：逐字节原样 ───────────────────────────────────────────────────

test('② 不到上限的回执逐字节原样（截断不许误伤小输出）', async () => {
  const b = await bench()
  try {
    const small = 'a.ts 这一份很短。\n第二行。\n'
    assert.ok(bytesOf(small) < MAX_RECEIPT_BYTES)
    assert.equal(capReceipt(small), small, '纯函数那一层：不到上限就逐字节原样')

    await b.host.writeBytes('small.txt' as RelPath, new TextEncoder().encode(small))
    const got = await face('read', { path: 'small.txt' }, b.host)
    assert.equal(got.ok, true)
    assert.ok(!got.output.includes('bytes omitted'), `小输出的回执里不该有标记：${got.output}`)
    assert.ok(got.output.endsWith(small), '正文逐字节原样跟在头那一行后面')

    // 恰好在边界上的那一档也不许动（`<= limit` 不进截断）。
    const onEdge = 'x'.repeat(MAX_RECEIPT_BYTES)
    assert.equal(capReceipt(onEdge), onEdge, '恰好等于上限也不截')
    console.log(`② 读数：小输出 ${bytesOf(small)} 字节 → 回执 ${bytesOf(got.output)} 字节（一条标记都没有）`)
  } finally {
    await b.close()
  }
})

// ── ⑦ 负对照：把上限调成 0，判据 ② 当场红 ────────────────────────────────────────

test('⑦ 负对照：把截断上限调成 0 → 判据 ② 当场红（小输出也带上了标记）', async () => {
  const small = 'a.ts 这一份很短。\n'
  const capped = capReceipt(small, 0)
  assert.notEqual(capped, small, '上限调成 0 之后，小输出必须被截——这正是判据 ② 会红的样子')
  assert.match(capped, /bytes omitted · \d+ bytes and \d+ lines in all/, '标记照旧按那句话给')
  // 上限 0 时头尾都留不下东西（`headWant = 0`）——回执就只剩标记那一句，而 M = N。
  assert.ok(!capped.includes(small), '上限 0 时原文一个字节都留不下')
  assert.match(capped, new RegExp(`${bytesOf(small)} bytes omitted · ${bytesOf(small)} bytes and`), 'M = N（一个字节都没留）')
  console.log(`⑦ 负对照读数：上限 0 → 那小段回执变成 ${bytesOf(capped)} 字节且带标记（判据 ② 会红）`)
})

// ── ③ 回执里没有毫秒 ───────────────────────────────────────────────────────────

test('③ `bash` / `run_action` 的回执里逐字查不到「毫秒」', async () => {
  const b = await bench()
  try {
    const exec = executorOf(b)
    const h = handleOf()
    const ran = await exec.execute(callOf('bash', { command: '/bin/sh -c "echo hi"' }, 'c1'), h)
    assert.equal(ran.ok, true, `bash 该成：${ran.output}`)
    assert.ok(!ran.output.includes('毫秒'), `回执里还有毫秒：${ran.output}`)
    assert.match(ran.output, /^exit code 0/, '回执头仍是「exit code N」（截断之前拼上，永远在）')

    const act = await exec.execute(callOf('run_action', { action: '/bin/sh -c "echo hi"' }, 'c2'), h)
    assert.equal(act.ok, true, `run_action 该成：${act.output}`)
    assert.ok(!act.output.includes('毫秒'), `回执里还有毫秒：${act.output}`)
    assert.match(act.output, /^action \/bin\/sh -c "echo hi" exit code 0/, '回执头照旧')
    console.log(`③ 读数：bash「${ran.output.trim()}」· run_action「${act.output.trim()}」——都没有毫秒`)
  } finally {
    await b.close()
  }
})

// ── ④ 回执里指的路必须真实存在 ─────────────────────────────────────────────────

test('④ `exit_plan_mode` / `ask_user_question` 的回执里指的命令在命令面真有的', async () => {
  const b = await bench()
  try {
    // 这两条要持轮者那一格（子 agent 调它们只得到一句回绝）。
    const plan = await face('exit_plan_mode', { plan: '先写 a.ts，再跑断言。' }, b.host, '', true)
    assert.equal(plan.ok, true, `exit_plan_mode 该成：${plan.output}`)
    const ask = await face('ask_user_question', { questions: [{ question: '留哪一份？', header: '选一个' }] }, b.host, '', true)
    assert.equal(ask.ok, true, `ask_user_question 该成：${ask.output}`)

    for (const [name, out] of [
      ['exit_plan_mode', plan.output],
      ['ask_user_question', ask.output],
    ] as const) {
      // **门由人开**（C4 落地）：回执要指得出放行那一条命令，而它真的存在。
      assert.match(out, /fugue round go/, `${name} 的回执该指得出放行那条命令（round go）：${out}`)
      // 回执里提到的每一条 `fugue ...` 命令，都要在命令面那份用法里找得到（**不另抄一份名单**）。
      for (const m of out.matchAll(/`(fugue [^`]+)`/g)) {
        // 尖括号里是占位符（回执那一句是英文，用法那一份是中文），要查的是**子命令真的存在**。
        const words = m[1]!.split(/\s+/).slice(1).filter((w) => !w.includes('<') && !w.includes('>'))
        assert.ok(
          words.every((w) => !w.startsWith('-') && USAGE.includes(w)),
          `${name} 指的命令「${m[1]}」在命令面那份用法里找不到：${words.join(' · ')}`,
        )
      }
      console.log(`④ ${name} 回执：${out}`)
    }
  } finally {
    await b.close()
  }
})

// ── ⑤ 事件面双向对账 ──────────────────────────────────────────────────────────

test('⑤ 事件联合的判别名与架构 § 8.1 那一段逐条相符（`tools/check-events.js`）', async () => {
  const plan = process.env['FUGUE_PLAN'] ?? '/mnt/c/Users/Administrator/Desktop/CodeWish/PLAN-ARCHIVE.md'
  const got = spawnSync('node', ['tools/check-events.js', plan], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(got.status, 0, `check-events.js 没通过：\n${got.stdout}\n${got.stderr}`)
  // **30 条**：C4 那一格加了 `round/approve`（放行那一笔）；0.2.7 的 U18 甲案又加了两条
  // （`ask/raised` · `ask/ruling`：子 agent 的问题被轮内接住 · 持轮者对它的判决）。事件面到
  // 这里冻住（TUI 的读面）。
  // 架构那一半**无条件**：事件联合与架构篇两样都在本仓库里（`src/log/events.ts` ·
  // `design/ARCHITECTURE.md`），所以这一条在任何一台机器上、在 CI 上都真跑。2026-10-01 之前
  // 两张表都住文档工作区，够不到就整条跳过——那是"静默通过"，不是地板。
  assert.match(got.stdout, /代码里 30 条/, '代码那一侧该是 30 条')
  assert.match(got.stdout, /架构里 30 条/, '架构 § 8.1 那一侧也该是 30 条')
  assert.match(got.stdout, /代码里每一条都在架构那一段里/, '两向都要相符')
  assert.match(got.stdout, /架构那一段里每一条都在代码里/, '两向都要相符')
  // 归档那一半（§ 5.18 那张三面表，同一个联合的**第二张**散文表——它漂过一次，漏 7 条）住在
  // 文档工作区：够得到就查，够不到**印一行说出来**。两条路都断言，不留"什么都不说也通过"的路。
  assert.match(got.stdout, /(计划里 30 条|归档那张表不在场)/, '归档那一半要么查了，要么说清没查')
  console.log(`⑤ 读数：${got.stdout.split('\n').filter((l) => l.includes('条') || l.includes('不在场')).map((l) => l.trim()).join(' · ')}`)
})

// ── ⑥ 交接两句去系统内容 ───────────────────────────────────────────────────────

test('⑥ 交接那一句与接手那一句里：分支名 · coord.id · 步数一个都查不到', async () => {
  const { handoffOf, promptOf, successorOf } = await import('../runtime/restart.ts')
  const branch = 'agent/round/7' as never
  const coord = { id: 'agent-7-3', branch, outputPaths: [] } as never
  const h = {
    goal: '写一份 a.ts',
    from: AGENT,
    branch,
    step: 42,
    done: '已经写了 a.ts。',
    files: [],
    commands: [],
    next: ['接着写断言。'],
    why: '预算到了',
  }
  const prompt = promptOf(h as never)
  const next = successorOf({ ...emptyState(), step: 42 }, prompt)
  const first = (next.turns ?? [])[0]?.text ?? ''

  assert.ok(!prompt.includes('agent/round/7'), `【交接】句里带了分支名：${prompt}`)
  assert.ok(!prompt.includes('42'), `【交接】句里带了步数：${prompt}`)
  assert.equal(prompt.split('\n')[0], '【交接】从 agent-1 手里接过这一格。', `【交接】首句该只说交接这件事实`)
  assert.ok(!first.includes('agent-7-3'), `【接手】句里带了 coord.id：${first}`)
  assert.ok(first.startsWith('【接手】'), '接手那一句还在')

  // **账是账**：`agent/handoff` 事件里那两栏照记。
  const ev = handoffOf({
    contract: 'r1.implement.1' as never,
    goal: '写一份 a.ts',
    from: AGENT,
    branch,
    state: { ...emptyState(), step: 42, lastStep: '已经写了 a.ts。' },
    plan: { kind: 'restart', why: '预算到了' } as never,
    commands: [],
  })
  assert.equal(ev.branch, branch, '事件里分支那一栏照记')
  assert.equal(ev.step, 42, '事件里步数那一栏照记')
  assert.ok(!promptOf(ev).includes(String(ev.branch)), '事件里的分支名不许回流进提示词')
  console.log(`⑥ 读数：【交接】首句「${prompt.split('\n')[0]}」·【接手】句「${first}」· 事件 branch=${String(ev.branch)} step=${ev.step}`)
})

/** 走一条工具：直接问实现表那一段（与 `dispatch` 走的是同一处），不经过日志与事件。 */
async function face(name: string, args: unknown, host: ToolHost, cwd = '', holder = false) {
  const fn = faceOf(name)
  assert.ok(fn !== null, `${name} 没有实现`)
  const parsed = parseArgs(JSON.stringify(args))
  assert.equal(parsed.ok, true, `${name} 的参数没有解出来`)
  return fn((parsed as { ok: true; value: Record<string, unknown> }).value, host, { agent: AGENT, step: 0, cwd, holder })
}
