// B5 的断言：工具面（PLAN § 5.8 的 B5 行 · 架构 § 8.10 的工具目录 · § 8.9 四条推论 ·
// § 14.2 第 4 步 · § 9.6「`checkpoint`（模型侧）与 `fugue commit`（人侧）是同一个操作的两个
// 名字」）。跑法：cd ~/fugue && node --test src/tools/execute.test.ts
//
//   ① 参数那一层：解不开的 JSON 是一次失败的结果（不是抛）· missing required argument 说得出是哪一个
//   ② **写进去的字节读回来逐字节相同**（不是"写成功了"）：真视图 · 真日志 · 真对象库
//   ③ `glob` / `grep` 按 `walk` 给的路径走，`**` 跨 `/`、`*` 不跨
//   ④ **假模型驱动 读 → 写 → 检查点，走到一次真提交**，而**真工作树一个文件都没多**
//   ⑤ 负对照：字节那一栏改成"读回来的 UTF-8 文本相同"→ 一条非法序列就把它变红
//   ⑨ **模型读到的每一个字节都是英文**（口径：谁读谁的语言——人读的走中文 · 见证 § 8.11）
//   格 3 **`grep` 的候选先按一批取回内容**：冷的那一趟请求数不随文件数线性涨，
//   热的那一趟一次都不发；这道缝缺席时退回逐文件读（回执逐字节不变）

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { openTruth } from '../truth/truth.ts'
import type { TruthHandle } from '../truth/truth.ts'
import { logFileOf, openLog } from '../log/log.ts'
import type { LogHandle, LogEvent } from '../log/events.ts'
import { loadView } from '../view/view.ts'
import { lowerAt } from '../view/lower.ts'
import type { View } from '../view/contract.ts'
import { createRoots } from '../roots/roots.ts'
import type { Denied as FenceDenied, Roots } from '../roots/contract.ts'
import { SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import { emptyState } from '../assemble/sources.ts'
import type { AssembleState } from '../assemble/sources.ts'
import { fixtureState } from '../model/fixture-state.ts'
import { BUILTIN_CATALOG, modelDeclOf } from '../model/catalog.ts'
import type { ModelEvent } from '../model/contract.ts'
import { CATALOG_STATES, catalog } from '../tools/catalog.ts'
import type { AgentId, BranchId, CommitId, ContractId, RelPath, WriterId } from '../terms.ts'
import type { AgentHandle } from '../runtime/step.ts'
import { createRuntime, scriptedModel } from '../runtime/step.ts'
import type { ToolCallRequest } from '../runtime/step.ts'
import { createToolExecutor } from '../capability/dispatch.ts'
import { faceOf, noFace, parseArgs } from './execute.ts'
import { capReceipt, lineCount, MAX_RECEIPT_BYTES } from './receipt.ts'
import type { ToolHost } from './execute.ts'
import { createToolHost } from './host.ts'
import { refHeadOf } from '../round/head.ts'
import type { TreeEntry } from '../entries.ts'

const AGENT = 'agent-1' as AgentId
const CATALOG = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])
const DECL = modelDeclOf('deepseek-flash/anthropic', BUILTIN_CATALOG)

/** 测试自己起 git 时用同一套隔离：用户级配置不该决定测试的读数。 */
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
  readonly view: View
  readonly log: LogHandle
  readonly truth: TruthHandle
  readonly host: ToolHost
  readonly roots: Roots
  /** 「先物化」那一条推论（架构 § 8.9 第一条）：这一档里视图上层就是它的物化面，所以是空的。 */
  readonly ensureOf: (tool: string, args: Readonly<Record<string, unknown>>) => Promise<void>
  /** 「过路径围栏」那一条：真的 `M3`（`Roots.resolveVirtual`）。 */
  readonly fenceOf: (raw: string, cwd: string) => { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: FenceDenied }
  readonly close: () => Promise<void>
}

/** 一份真的台子：真对象库（`git init` 过）· 真日志 · 真视图 · 围栏 · 工具面那一份宿主。 */
async function bench(): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-b5-face-'))
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const truth = openTruth(root)
  const log = openLog(root, { write: AGENT as WriterId, sync: 'each' })
  // **新仓库一个提交都没有**：下层就是空的（`base: null`——`lowerAt` 那一栏的注）。
  const view = await loadView(log, AGENT as WriterId, { lower: lowerAt(truth, null) })
  const roots = createRoots(root as never)
  const host = createToolHost(view, roots, {
    // **这一格的 ref 头从日志重放**（新仓库：底是 `null`，日志里也一条 `ckpt/commit` 都没有）。
    actions: { writer: AGENT as WriterId, log, truth, head: await refHeadOf(log, AGENT as WriterId, null) },
  })
  return {
    root,
    view,
    log,
    truth,
    host,
    roots,
    ensureOf: () => Promise.resolve(),
    fenceOf: (raw, cwd) => {
      const got = roots.resolveVirtual(raw, cwd as RelPath)
      return got.ok ? { ok: true as const, value: got.value } : { ok: false as const, error: got.error }
    },
    close: async () => {
      await log.close()
      await truth.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** 根目录里看得见的那些条目（`git` 与 `fugue` 自己的账不算"工作树里的文件"）。 */
function worktreeOf(root: string): string[] {
  return readdirSync(root)
    .filter((n) => n !== '.git' && n !== '.fugue')
    .sort()
}

const asText = (b: Uint8Array): string => Buffer.from(b).toString('utf8')

/** 走一条工具：直接问实现表那一段（与 `dispatch` 走的是同一处），不经过事件与日志。 */
/** `holder`：这一格是不是持轮者（有几条工具只有它调才有意义）。缺省是子 agent 那一格。 */
async function face(name: string, args: unknown, host: ToolHost, cwd = '', holder = false) {
  const fn = faceOf(name)
  assert.ok(fn !== null, `${name} 没有实现`)
  // **参数要解过再给**：`dispatch` 那一层就是这么给的（`parseArgs` 那一步在派发里）。
  const parsed = parseArgs(JSON.stringify(args))
  assert.equal(parsed.ok, true, `${name} 的参数没有解出来：${parsed.ok ? '' : parsed.why}`)
  return fn((parsed as { ok: true; value: Record<string, unknown> }).value, host, { agent: AGENT, step: 0, cwd, holder })
}

// ── ① 参数那一层 ─────────────────────────────────────────────────────────────

test('① 参数不是对象 · 少了必填参数：两条都是"一次失败的结果"，不是抛', async () => {
  const b = await bench()
  try {
    assert.deepEqual(parseArgs('{}'), { ok: true, value: {} })
    assert.equal(parseArgs('[1,2]').ok, false, '数组不是一次调用的参数')
    assert.equal(parseArgs('{oops').ok, false, '解不开的 JSON 不许当成功')

    const noPath = await face('read', {}, b.host)
    assert.equal(noPath.ok, false)
    assert.match(noPath.output, /missing required argument path/)

    const noContent = await face('write', { path: 'a.txt' }, b.host)
    assert.equal(noContent.ok, false)
    assert.match(noContent.output, /missing required argument content/)
  } finally {
    await b.close()
  }
})

// ── ①d 路径形状 ─────────────────────────────────────────────────────────────

test('①d 路径形状不合法：一条失败的结果，不是抛——抛出去那一趟当场就没了', async () => {
  const b = await bench()
  try {
    // **真档那一趟**（`--dump-wire` 实录）：持轮者第 2 步 `read {"path":"."}`——它想"读一下
    // 工作区"——视图那层抛「需要一个路径」→ `tool-threw` → **那一趟两句话就结束**，草案一个
    // 字节都没写，判据 ④ 的"打回三数"与判据 ③ 的"停因是收敛"两处跟着红。
    // 下面这几条都是模型真会发的那种写法（`.` 与 `..` 最常见）。
    const shapes = ['.', '..', '../x', 'a/./b', 'a//b', 'a/..', '/abs.txt']
    for (const p of shapes) {
      const r = await face('read', { path: p }, b.host)
      assert.equal(r.ok, false, `read ${JSON.stringify(p)} 该回一条失败的结果`)
      assert.match(r.output, /path/, `read ${JSON.stringify(p)} 那句没说清路径哪里不对：${r.output}`)
      // **要指得出路**：那几句末尾都点出 glob 是看全貌的那一条（架构 § 8.4 纪律 2）。
      assert.match(r.output, /glob/, `read ${JSON.stringify(p)} 那句没指路：${r.output}`)
    }
    // 走路径的另外三条同一档：它们的 `path` 是同一个模型的输入。
    const wrote = await face('write', { path: '.', content: 'x' }, b.host)
    assert.equal(wrote.ok, false, 'write 一条目录路径该回一条失败的结果')
    const edited = await face('edit', { path: '..', old_string: 'a', new_string: 'b' }, b.host)
    assert.equal(edited.ok, false, 'edit 一条 .. 路径该回一条失败的结果')
    // **负对照：实现自己坏了照旧抛。** 接掉它等于把真 bug 变成一句给模型看的话——`tool-threw`
    // 那一档要留着（真档上它照出过物化树里的 `ENOTDIR`）。
    const broken = new Proxy({} as ToolHost, {
      get: () => async () => {
        throw new Error('实现里坏了')
      },
    })
    await assert.rejects(async () => await face('read', { path: 'a.md' }, broken), /实现里坏了/)
    console.log('①d 读数：7 种坏形状逐条回结果（read）· write/edit 各一条 · 负对照：实现坏了照旧抛')
  } finally {
    await b.close()
  }
})

// ── ② 写进去的字节读回来逐字节相同 ────────────────────────────────────────────

test('② write 之后立刻 read：字节逐字节相同（含非 UTF-8 的字节）', async () => {
  const b = await bench()
  try {
    const text = '第一行\n第二行 你好 🌱\n'
    const wrote = await face('write', { path: 'src/note.txt', content: text }, b.host)
    assert.equal(wrote.ok, true, wrote.output)
    // 返回文案不带 rev：那是架构内部的坐标，模型不需要看（W6 拿掉了它）。
    assert.match(wrote.output, /wrote src\/note\.txt \(\d+ bytes\)\.$/)

    const got = await face('read', { path: 'src/note.txt' }, b.host)
    assert.equal(got.ok, true, got.output)
    assert.ok(got.output.endsWith(text), '读回来的那一段就是写进去的那一段')
    // 视图里那一份也逐字节相同（不是"命令行印出来看着像"）。
    const raw = await b.view.read('src/note.txt' as RelPath)
    assert.deepEqual(raw, new Uint8Array(Buffer.from(text, 'utf8')), '视图里存的就是那几个字节')

    // **非 UTF-8 的字节也走同一条路**：`readBytes`/`writeBytes` 是字节进出，不是字符串进出。
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x1a])
    await b.host.writeBytes('pic.png', binary)
    const back = await b.host.readBytes('pic.png')
    assert.ok(back !== null)
    assert.deepEqual(back.bytes, binary, '二进制那一条不许在中间被"解成文本再写回去"')
    // 而文本那一条读回来时已经**解不出原样**了（非法序列被换成了 U+FFFD）——这正是"给字节
    // 不给字符串"的理由：这一层要是按字符串进出，那份图在写回去的路上就已经变了。
    assert.notEqual(asText(back.bytes), String.fromCharCode(...binary), '字节那一栏看得出来，文本那一栏看不出来')

    const missing = await face('read', { path: '没有这个.txt' }, b.host)
    assert.equal(missing.ok, false, '视图里没有的路径是一次失败的结果')
  } finally {
    await b.close()
  }
})

// ── ③ 发现类那两个按 walk 给的路径走 ──────────────────────────────────────────

test('③ glob 与 grep：`**` 跨 `/` · `*` 不跨 · grep 报行号', async () => {
  const b = await bench()
  try {
    await b.host.writeBytes('a.ts', new Uint8Array(Buffer.from('const a = 1\n// 记号\n', 'utf8')))
    await b.host.writeBytes('src/b.ts', new Uint8Array(Buffer.from('const b = 2\n', 'utf8')))
    await b.host.writeBytes('src/deep/c.ts', new Uint8Array(Buffer.from('// 记号在深处\n', 'utf8')))
    await b.host.writeBytes('src/b.md', new Uint8Array(Buffer.from('# 不是代码\n', 'utf8')))

    const star = await face('glob', { pattern: '*.ts' }, b.host)
    assert.equal(star.ok, true)
    assert.match(star.output, /a\.ts/)
    assert.ok(!star.output.includes('src/b.ts'), `* 不该跨 /：${star.output}`)

    const deep = await face('glob', { pattern: '**/*.ts' }, b.host)
    assert.match(deep.output, /src\/b\.ts/, '** 要跨 /')
    assert.match(deep.output, /src\/deep\/c\.ts/, '** 要走到更深处')

    const hits = await face('grep', { pattern: '记号' }, b.host)
    assert.equal(hits.ok, true)
    assert.match(hits.output, /a\.ts:2:/)
    assert.match(hits.output, /src\/deep\/c\.ts:1:/)

    const none = await face('glob', { pattern: '没有/*.zzz' }, b.host)
    assert.match(none.output, /no path matches/)
  } finally {
    await b.close()
  }
})

/**
 * ③b 发现类那两条的「范围」那一栏：三处细节各一条断言。
 *
 * 抓住的变异：`scopeOf` 不折尾巴上的斜杠（`src/` 那个范围当场取不到东西）· `inScope` 少了
 * "范围本身"那一项（指着文件时一个候选都没有）· `matchesInScope` 那一面拿掉（模式只写文件名
 * 那一段时退回"没有匹配"）。负对照两条：范围外那一份不许进结果，`grep` 与 `glob` 各一条。
 *
 * 为什么单挑这三处：它们各自都表现为**空结果**——发现类工具取不到东西时报的是"没有匹配"，
 * 看起来只是"那儿真没有"，模型会一直绕（真档上撞到过：四步全是 `find`/`ls`，草案 0 字节）。
 */
test('③b 范围那一栏：尾巴斜杠折掉 · 空范围是整个视图 · 范围指着文件时它自己也算 · 模式在范围里再配一次', async () => {
  const b = await bench()
  try {
    await b.host.writeBytes('a.ts', new Uint8Array(Buffer.from('const a = 1\n', 'utf8')))
    await b.host.writeBytes('src/b.ts', new Uint8Array(Buffer.from('const b = 2\n// 记号在 src\n', 'utf8')))
    await b.host.writeBytes('src/deep/c.ts', new Uint8Array(Buffer.from('const c = 3\n', 'utf8')))

    // 甲 · 尾巴上的斜杠折掉：`src/` 与 `src` 是同一次问法。
    const slash = await face('glob', { pattern: '*.ts', path: 'src/' }, b.host)
    const plain = await face('glob', { pattern: '*.ts', path: 'src' }, b.host)
    assert.equal(slash.ok, true, slash.output)
    assert.equal(slash.output, plain.output, '`src/` 与 `src` 该是同一个范围')
    // 这一条同时量了"模式在范围里再配一次"：`*.ts` 配得上 `src/b.ts`，靠的正是相对范围那一面
    // （`*` 不跨 `/`，所以更深处那一份不在）。
    assert.deepEqual(slash.output.split('\n'), ['1 paths:', 'src/b.ts'], `范围与模式的相对面没生效：${slash.output}`)

    // 乙 · 空范围 = 整个视图：不给 `path` 与给空串是同一次问法。
    const whole = await face('glob', { pattern: '**/*.ts' }, b.host)
    const empty = await face('glob', { pattern: '**/*.ts', path: '' }, b.host)
    assert.equal(whole.ok, true)
    assert.deepEqual(whole.output.split('\n').slice(1).sort(), ['a.ts', 'src/b.ts', 'src/deep/c.ts'])
    assert.equal(empty.output, whole.output, '空串就是整个视图')

    // 丙 · 范围指着一个文件：那个文件自己也在范围里。
    const one = await face('grep', { pattern: '记号', path: 'src/b.ts' }, b.host)
    assert.equal(one.ok, true)
    assert.equal(one.output, '1 lines:\nsrc/b.ts:2:// 记号在 src', `指着文件时取不到它自己：${one.output}`)

    // 负对照（两路）：范围外那一份不许进结果。
    const away = await face('grep', { pattern: '记号', path: 'src/deep' }, b.host)
    assert.match(away.output, /no line matches/, `范围外的内容进了 grep：${away.output}`)
    const awayGlob = await face('glob', { pattern: '**/*.ts', path: 'src/deep' }, b.host)
    assert.equal(awayGlob.output, '1 paths:\nsrc/deep/c.ts', `范围外的路径进了 glob：${awayGlob.output}`)
    console.log(
      `③b 读数：带斜杠的范围 → ${slash.output.replace('\n', '｜')} · 指着文件的范围 → ${one.output.replace('\n', '｜')}`,
    )
  } finally {
    await b.close()
  }
})

// ── ④ 假模型驱动 读 → 写 → 检查点，走到一次真提交 ────────────────────────────

/** 一条工具调用（三段：起点 · 分片 · 收尾）。 */
function callOne(index: number, id: string, name: string, args: unknown): ModelEvent[] {
  const text = JSON.stringify(args)
  return [
    { t: 'tool-start', index, id, name },
    { t: 'tool-delta', index, args: text },
    { t: 'tool-call', index, id, name, arguments: text },
  ]
}

const USAGE = { inputTokens: 88, cacheReadTokens: 24000, cacheWriteTokens: 0, outputTokens: 64, reasoningTokens: null, model: null }

function stateOf(): AssembleState {
  return { ...emptyState(), ...fixtureState(0), step: 0, cwd: '' }
}

function handleOf(state: AssembleState): AgentHandle {
  return {
    agent: AGENT,
    coord: { id: AGENT, branch: 'refs/heads/agent-1', outputPaths: [] },
    branch: 'refs/heads/agent-1' as BranchId,
    contract: 'c-1' as ContractId,
    protocol: SUBAGENT_PROTOCOL,
    model: DECL.id,
    wireModel: 'deepseek-flash',
    target: {
      providerId: 'fixture',
      host: '',
      wire: { name: 'anthropic-messages' } as AgentHandle['target']['wire'],
      path: '',
      model: 'deepseek-flash',
      from: 'fixture',
      headers: {},
    },
    adapter: { name: 'anthropic-messages' } as AgentHandle['adapter'],
    state,
  }
}

test('④ 假模型驱动 读 → 写 → 检查点：走到一次真提交，而真工作树一个文件都没多', async () => {
  const b = await bench()
  try {
    const before = worktreeOf(b.root)
    const seen: ToolCallRequest[] = []

    // **三次调用**：读一个不存在的（一次失败的结果）· 写一份 · 提交一次。
    const scripts: readonly (readonly ModelEvent[])[] = [
      [
        { t: 'delta', text: '先看一眼。' },
        ...callOne(0, 'call_1', 'read', { path: 'notes.md' }),
        { t: 'usage', usage: USAGE },
        { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
      ],
      [
        { t: 'delta', text: '写一份，然后提交。' },
        ...callOne(0, 'call_2', 'write', { path: 'notes.md', content: '第一版\n' }),
        ...callOne(1, 'call_3', 'checkpoint', { message: '第一次检查点' }),
        { t: 'usage', usage: USAGE },
        { t: 'stop', reason: 'tool-calls', raw: 'tool_use' },
      ],
      [
        { t: 'delta', text: '提交完了。' },
        { t: 'usage', usage: USAGE },
        { t: 'stop', reason: 'end-turn', raw: 'end_turn' },
      ],
    ]

    // **接上那两条推论**：不接的话视图层那些工具在围栏那一道就被拒了（`dispatch` 里那句
    // "没有围栏就不发这一步"），而 ④ 要量的恰恰是"工具真的动了视图"。
    const executor = createToolExecutor({
      logOf: () => b.log,
      host: b.host,
      fenceOf: b.fenceOf,
      ensureOf: b.ensureOf,
    })
    const rt = createRuntime({
      logOf: () => b.log,
      call: scriptedModel(scripts),
      execute: {
        async execute(call: ToolCallRequest, h: AgentHandle) {
          seen.push(call)
          return executor.execute(call, h)
        },
      },
      tools: CATALOG,
    })

    let h = handleOf(stateOf())
    const outcomes: string[] = []
    const turned: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await rt.step(h, new AbortController().signal)
      outcomes.push(r.outcome.kind)
      turned.push(...(r.next.turns ?? []).slice(turned.length))
      h = { ...h, state: r.next }
    }
    assert.deepEqual(outcomes, ['continue', 'continue', 'done'], `三步的结果：${outcomes.join(' ')}｜工具回了什么：${turned.join(' ¶ ')}`)

    assert.deepEqual(
      seen.map((c) => c.name),
      ['read', 'write', 'checkpoint'],
      '假模型说要调的三条，按顺序都到了执行器',
    )

    // 一次真提交：`ckpt/commit` 那一行在日志里（§ 9.6：模型侧那个 `checkpoint` 与人侧 `fugue commit`
    // 落的是同一条事件、走的是同一份 `checkpoint()`）。
    const rows: LogEvent[] = []
    const reader = openLog(b.root)
    for await (const e of reader.readByWriter(AGENT as WriterId)) rows.push(e)
    const commits = rows.filter((e) => e.t === 'ckpt/commit')
    assert.equal(commits.length, 1, `日志里有 ${commits.length} 条提交`)
    const commit = commits[0]!.commit
    assert.equal(typeof commit, 'string', `提交点那一栏是个 ${typeof commit}`)
    assert.equal((commit as string).length, 40, `提交点是 ${String(commit).length} 位：${String(commit)}`)

    // git 那一侧真的有一个提交、树里真的有那个文件、内容就是那几字节。
    const show = spawnSync('git', ['--git-dir=' + join(b.root, '.git'), 'cat-file', '-p', String(commit)], {
      env: GIT_ENV,
      encoding: 'utf8',
    })
    assert.equal(show.status, 0, show.stderr)
    assert.match(show.stdout, /第一次检查点/, '提交信息就是模型给的那一句')
    const tree = spawnSync('git', ['--git-dir=' + join(b.root, '.git'), 'ls-tree', '-r', '--name-only', String(commit)], {
      env: GIT_ENV,
      encoding: 'utf8',
    })
    assert.deepEqual(
      tree.stdout.trim().split('\n'),
      ['notes.md'],
      `提交里的文件：${JSON.stringify(tree.stdout)}（status=${tree.status} · stderr=${tree.stderr} · commit=${String(commit)}）`,
    )
    const blob = spawnSync('git', ['--git-dir=' + join(b.root, '.git'), 'cat-file', '-p', String(commit) + ':notes.md'], {
      env: GIT_ENV,
      encoding: 'utf8',
    })
    assert.equal(blob.stdout, '第一版\n', '提交里那个文件的字节')

    // **真工作树一个文件都没多**：字节住在对象库与视图上层里，不在 `<root>` 那棵树上。
    assert.deepEqual(worktreeOf(b.root), before, `工作树多了东西：${worktreeOf(b.root).join(' ')}`)
    // 而账都在 `.fugue` 底下（日志里那一行是这一站的凭据）。
    assert.ok(readdirSync(join(b.root, '.fugue', 'log')).length > 0, '日志落在 .fugue/log 下')
    assert.ok(logFileOf(b.root, AGENT as WriterId).endsWith('.fugue/log/agent-1.jsonl'))
  } finally {
    await b.close()
  }
})

// ── ⑤ 负对照：字节那一栏 ──────────────────────────────────────────────────────

test('⑤ 负对照：把判据换成"读回来的 UTF-8 文本相同"，一条非法序列就把它变红', async () => {
  const b = await bench()
  try {
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0b])
    await b.host.writeBytes('pic.bin', binary)
    const back = await b.host.readBytes('pic.bin')
    assert.ok(back !== null)

    // 真的判据：字节相同 → 绿。
    assert.deepEqual(back.bytes, binary)

    // 换成"文本相同"：`Buffer.from(bytes).toString()` 把非法字节换成 U+FFFD ——
    // 两串不同的字节解出**同一串文本**，于是这个判据给一次读错投了赞成票，而它证不了那句话。
    const loose = (x: Uint8Array): string => Buffer.from(x).toString('utf8')
    const other = new Uint8Array([...binary.slice(0, 5), 0xff, 0xff, binary[7]!])
    assert.notDeepEqual(other, binary, '先确认这两串字节真的不同')
    assert.equal(loose(other), loose(binary), '换成文本比对时它说"相同"——判据错了，而它不报错')
    assert.notDeepEqual(back.bytes, other, '字节那一栏看得出来')
  } finally {
    await b.close()
  }
})

// ── ①c `glob` 里那个 `**` 要匹配"零层目录" ─────────────────────────────────────
//
// 由头（第 5 批 · 联网验证第二次量到的）：模型先 `find` 看见根下的 `./count.ts`，再用惯常那条
// "两个星号、斜杠、文件名模式"问 `glob`，得到的是**"没有匹配"**——于是它一直绕、一个字都不写
// （`--max-steps 4` 那四步全是 `find`/`ls`，`写 0 条`）。原因在编译那一步：`**` 编译成 `.*`，
// 而 `.*` **至少要吃一个字符**，于是 `**` 后面那个 `/` 逼着路径里必须有一层目录——根下的文件
// 一个都匹配不上。**它不报错**：一个返回空列表的发现类工具看起来只是"真没有"。
test('①c glob 的 `**` 匹配零层目录：根下的文件与子目录里的文件都要能发现', async () => {
  const b = await bench()
  try {
    await face('write', { path: 'count.ts', content: 'export const one = 1\n' }, b.host)
    await face('write', { path: 'src/deep.ts', content: 'export const two = 2\n' }, b.host)
    await face('write', { path: 'src/notes.md', content: '# 不是 .ts\n' }, b.host)

    // 一 · 惯常那条模式：**根下那一个也要在**（修之前它只给 `src/deep.ts` 一条）。
    const all = await face('glob', { pattern: '**/*.ts' }, b.host)
    assert.equal(all.ok, true, all.output)
    assert.match(all.output, /count\.ts/, `根下的 count.ts 没被发现：${all.output}`)
    assert.match(all.output, /src\/deep\.ts/, `子目录里那个没被发现：${all.output}`)
    assert.equal(all.output.includes('notes.md'), false, '.md 不该被 *.ts 匹配上')

    // 二 · `**` 在中间也是"零层或多层"：`src/**/*.ts` 要匹配 `src/` 自己那一层里的 `.ts`。
    const nested = await face('glob', { pattern: 'src/**/*.ts' }, b.host)
    assert.match(nested.output, /src\/deep\.ts/, `中间那个 ** 也要能匹配零层：${nested.output}`)

    // 三 · 单独一个 `**`（在结尾）照旧是"任意多字符"：`src/**` 匹配 `src/` 里的一切。
    const tree = await face('glob', { pattern: 'src/**' }, b.host)
    assert.match(tree.output, /src\/deep\.ts/)
    assert.match(tree.output, /src\/notes\.md/)

    // 四 · 负对照：`*` 不跨 `/`。`*.ts` 只该给根下那一个（它是"不跨"那一档的判据）。
    const shallow = await face('glob', { pattern: '*.ts' }, b.host)
    assert.match(shallow.output, /count\.ts/)
    assert.equal(shallow.output.includes('src/deep.ts'), false, `* 不该跨 /：${shallow.output}`)
    console.log(
      `①c 读数：**/*.ts → ${all.output.split('\n').length - 1} 条（含根下的 count.ts）· ` +
        `src/**/*.ts → ${nested.output.split('\n').length - 1} 条 · *.ts → ${shallow.output.split('\n').length - 1} 条`,
    )
  } finally {
    await b.close()
  }
})

// ── ⑥ 目录说必填的键，实现读的名字与它逐字相等 ──────────────────────────────────
//
// 由头就是 `checkpoint` 那一处：目录里那一栏叫 `message`，实现读的是 `msg`，而一句兜底把这件
// 事盖住了——**每一次提交都叫同一个名字，且不报错**。所以这一条不许有兜底：什么都不给时报缺，
// 而报缺的那一栏必须是目录里声明过的键。它盯的是与架构 § 8.10 硬纪律 1 同一条病的轻症：
// 公布了却读不到。
test('⑥ 目录里 required 的键，实现读的名字与它逐字相等（不留兜底）', async () => {
  // 一个会喊的宿主：实现要是**在问必填参数之前**先碰了它，这一条就该红（那说明它没先问）。
  const host = new Proxy({} as ToolHost, {
    get: (_t, k) => () => {
      throw new Error(`实现在问必填参数之前就碰了宿主的 ${String(k)}——那说明它没先问。`)
    },
  })
  const asked: string[] = []
  for (const e of CATALOG) {
    const fn = faceOf(e.name)
    if (fn === null) continue // 没接上实现的那几条不在这一条范围内（W1 之后为 0）
    const need = (e.parameters as unknown as { readonly required?: readonly string[] }).required ?? []
    if (need.length === 0) {
      const got = await fn({}, host, { agent: AGENT, step: 0, cwd: '', holder: false })
      assert.equal(got.output.includes('missing required argument'), false, `${e.name} 目录里没有必填键，实现却报了缺：${got.output}`)
      continue
    }
    // **逐个问下去，不是只问第一个。** 原先只看第一次报出来的那个名字，于是"第一个键对得上、
    // 后面那几个键是另一套名字"这种漂移一路绿——实测就漏掉了 `edit`（required 是 path ·
    // old_string · new_string，而实现读的是 find · replace），那一趟真档白烧了一格。
    // 每一趟只给**前面已经报缺的那些**键：给完最后一个就会真的去碰宿主，而那件事由上面那个
    // 会喊的 Proxy 管——这一条只量"问名字"这一段。
    const given: Record<string, unknown> = {}
    const got: string[] = []
    for (let i = 0; i < need.length; i++) {
      const r = await fn(given, host, { agent: AGENT, step: 0, cwd: '', holder: false })
      const m = /missing required argument (\S+?) —/.exec(r.output)
      assert.ok(
        m !== null,
        `${e.name} 给了 ${Object.keys(given).join(' · ') || '(空)'} 之后，实现报的不是"missing required argument"：${r.output}`,
      )
      got.push(m[1]!)
      given[m[1]!] = 'x'
    }
    assert.deepEqual(
      [...new Set(got)].sort(),
      [...new Set(need)].sort(),
      `${e.name} 实现读的必填键是 ${got.join(' · ')}，而目录的 required 是 ${need.join(' · ')}`,
    )
    asked.push(`${e.name}:${got.join(',')}`)
  }
  console.log(`⑥ 读数 · 逐条实现读的必填键：${asked.join(' · ')}`)
})

// ── ⑥b `edit`：按公布面按下去真的改到文件 ────────────────────────────────────
//
// ⑥ 量的是"名字对得上"，这一条量的是"按公布的名字按下去，文件真的变了"——外加一条负对照：
// **目录里没有的名字不算替换**（绑定面比公布面宽的那一次漂移就是这么来的）。
test('⑥b edit：按公布面（old_string/new_string/replace_all）改得到文件；目录外的名字一个都不认', async () => {
  const b = await bench()
  try {
    const wrote = await face('write', { path: 'src/a.ts', content: 'export const a = 1\nexport const b = 2\n' }, b.host)
    assert.equal(wrote.ok, true, wrote.output)
    const now = async (): Promise<string> => asText((await b.view.read('src/a.ts' as RelPath))!)
    // **两种形状都当拒**：工具面自己拒是 `{ok:false}`，而宿主那一层今天会**抛**（`host.edit`
    // 的"没找到 / 不止一处"两支）——`step.ts` 把抛收成 `tool-threw`（那一格当场停）。这一条
    // 只量"按公布面按下去会发生什么"，抛与不抛的差别记在疑点里，不在这里盖章。
    const tryEdit = async (args: unknown): Promise<{ readonly ok: boolean; readonly output: string }> => {
      try {
        const r = await face('edit', args, b.host)
        return { ok: r.ok, output: r.output }
      } catch (err) {
        return { ok: false, output: (err as Error).message }
      }
    }

    // ① 一处替换：只用公布的三个键。
    const one = await tryEdit({ path: 'src/a.ts', old_string: 'a = 1', new_string: 'a = 42' })
    assert.equal(one.ok, true, one.output)
    assert.equal(await now(), 'export const a = 42\nexport const b = 2\n')

    // ② 两处出现、没给 replace_all → 拒，而拒的话指得出 replace_all（不是只报"出现了不止一次"）。
    const two = await tryEdit({ path: 'src/a.ts', old_string: 'export const', new_string: 'const' })
    assert.equal(two.ok, false)
    assert.match(two.output, /replace_all/)
    assert.equal(await now(), 'export const a = 42\nexport const b = 2\n', '被拒的那一次不许动文件')

    // ③ 给了 replace_all → 每一处都换掉。
    const all = await tryEdit({
      path: 'src/a.ts',
      old_string: 'export const',
      new_string: 'const',
      replace_all: true,
    })
    assert.equal(all.ok, true, all.output)
    assert.equal(await now(), 'const a = 42\nconst b = 2\n')

    // ④ 负对照：目录里没有 `find`/`replace`（也没有 `to`/`mode`）——按旧名字给，缺的是公布的键。
    const legacy = await tryEdit({ path: 'src/a.ts', find: 'const a', replace: 'let a' })
    assert.equal(legacy.ok, false)
    assert.match(legacy.output, /missing required argument old_string/)
    assert.equal(await now(), 'const a = 42\nconst b = 2\n', '按未公布的名字给，一个字节都不许变')
  } finally {
    await b.close()
  }
})

// ── ⑦ 待办：覆盖 · 重建 · 工作树不动 ──────────────────────────────────────────
//
// `todo_write` 是 `log` 层那一条：只落日志，不碰视图、不起进程。三条性质各盯一样——
// 覆盖（后一份替掉前一份）· 重建（重放得出最后那一份）· 不污染（工作树一个文件都不多）。
test('⑦ 待办：后一份整体覆盖前一份 · 重放得出同一份 · 真实工作树一个文件都没多', async () => {
  const b = await bench()
  try {
    const before = worktreeOf(b.root)
    const first = await face(
      'todo_write',
      { todos: [{ content: '读一遍', status: 'in_progress' }, { content: '写一遍', status: 'pending' }] },
      b.host,
    )
    assert.equal(first.ok, true, first.output)
    assert.match(first.output, /todos recorded: 2/)

    const second = await face('todo_write', { todos: [{ content: '写一遍', status: 'completed' }] }, b.host)
    assert.match(second.output, /todos recorded: 1/)
    assert.equal(second.output.includes('读一遍'), false, '后一份整体覆盖前一份——前一份那一条不该还在回执里')

    // 落的是两条 `holder/todos`，而重放时这一格手里那份是最后一条。
    const rows: LogEvent[] = []
    for await (const e of b.log.readByWriter(AGENT as WriterId)) rows.push(e)
    const todos = rows.filter((e) => e.t === 'holder/todos')
    assert.equal(todos.length, 2, `holder/todos 有 ${todos.length} 条`)
    const last = todos[1] as Extract<LogEvent, { t: 'holder/todos' }>
    assert.deepEqual(JSON.parse(last.body).todos, [{ content: '写一遍', status: 'completed' }], '重放得出的是最后那一份')
    assert.equal(last.digest.length, 16, 'digest 与 round/intent 同一个口径（16 字符）')

    // 待办不是工作树里的东西：写它会污染验收（验收要逐字节一致）。
    assert.deepEqual(worktreeOf(b.root), before, `工作树多了东西：${worktreeOf(b.root).join(' ')}`)
  } finally {
    await b.close()
  }
})

// ── ⑧ exit_plan_mode：持轮者落事件并停在门口；子 agent 落不了、也停不下来 ──────
//
// 三条各盯一样：角色（子 agent 调它得到一句指得出出路的话，不是静默成功）· 落点（持轮者调它
// 落一条 `holder/plan`，而契约一个都不发）· 停（这一格到这儿为止，运行时读成一次 `done`）。
test('⑧ exit_plan_mode：持轮者落 holder/plan 并停在门口；子 agent 调它不落事件、也不停', async () => {
  const b = await bench()
  try {
    const before = worktreeOf(b.root)

    // 子 agent：不是错误，是角色不对——回一句指得出出路的话，不落事件、也不叫停。
    const asSub = await face('exit_plan_mode', { plan: '我要先拆三格' }, b.host, '', false)
    assert.equal(asSub.ok, false, asSub.output)
    assert.match(asSub.output, /not your cell's job/)
    assert.equal(asSub.halt, undefined, '子 agent 那一趟不叫停——它还得接着干活')

    // 持轮者：落事件 + 停在门口。
    const asHolder = await face('exit_plan_mode', { plan: '先拆三格，再各跑一条断言' }, b.host, '', true)
    assert.equal(asHolder.ok, true, asHolder.output)
    assert.equal(asHolder.halt, true, '停在门口：这一格到这儿为止')
    // **回执只说实话**（W10 处三 → C4 落地时那一句改回来）：门真的存在了（`fugue round go`）
    // ——这一趟只把计划落进日志，发契约是放行那一下的事（架构 § 15.1.a）。
    assert.match(asHolder.output, /This round stops at the door/)
    assert.match(asHolder.output, /fugue round go/, '门由人开这句话该指得出放行那条命令')

    const rows: LogEvent[] = []
    for await (const e of b.log.readByWriter(AGENT as WriterId)) rows.push(e)
    const plans = rows.filter((e) => e.t === 'holder/plan')
    assert.equal(plans.length, 1, `holder/plan 有 ${plans.length} 条——子 agent 那一趟不该落`)
    const one = plans[0] as Extract<LogEvent, { t: 'holder/plan' }>
    assert.deepEqual(JSON.parse(one.body), { plan: '先拆三格，再各跑一条断言' }, '重放得出持轮者交的那一份')
    assert.equal(one.digest.length, 16, 'digest 与 round/intent 同一个口径（16 字符）')

    // 门没开：一个契约都没发（发契约是 round go 那一档的事）。
    assert.equal(rows.some((e) => e.t === 'contract/issue'), false, '停在门口的时候不许发契约')
    assert.deepEqual(worktreeOf(b.root), before, `工作树多了东西：${worktreeOf(b.root).join(' ')}`)
  } finally {
    await b.close()
  }
})

// ── ⑨ ask_user_question：问完停在同一道门口；问多了当场拒 ──────────────────────
//
// 三条各盯一样：落点（落 `holder/ask`，而契约一个都不发）· 停（与 `exit_plan_mode` 共用同一个
// "停"，不引入异步等待那种持久态）· 上限（问多了不是更周全，是让人没法答——当场拒并给去路）。
test('⑨ ask_user_question：持轮者落 holder/ask 并停在同一道门口；问超了当场拒', async () => {
  const b = await bench()
  try {
    const before = worktreeOf(b.root)

    // 子 agent：角色不对，回一句指得出出路的话。
    const asSub = await face('ask_user_question', { questions: [{ question: '要不要删掉它？' }] }, b.host, '', false)
    assert.equal(asSub.ok, false, asSub.output)
    assert.match(asSub.output, /not your cell's job/)

    // 问超了：当场拒，话里指得出去处（不是静默截断成前四个）。
    const tooMany = await face(
      'ask_user_question',
      { questions: [1, 2, 3, 4, 5].map((n) => ({ question: `第 ${n} 个问题？` })) },
      b.host,
      '',
      true,
    )
    assert.equal(tooMany.ok, false, tooMany.output)
    assert.match(tooMany.output, /at most 4 questions per call/)

    // 持轮者：落事件 + 停在门口。
    const asked = await face(
      'ask_user_question',
      { questions: [{ question: '要不要删掉它？', header: '删除', options: [{ label: '删', description: '不可回退' }] }] },
      b.host,
      '',
      true,
    )
    assert.equal(asked.ok, true, asked.output)
    assert.equal(asked.halt, true, '问完停在同一道门口（与 exit_plan_mode 共用那一个"停"）')

    const rows: LogEvent[] = []
    for await (const e of b.log.readByWriter(AGENT as WriterId)) rows.push(e)
    const asks = rows.filter((e) => e.t === 'holder/ask')
    assert.equal(asks.length, 1, `holder/ask 有 ${asks.length} 条——子 agent 与问超了那两趟都不该落`)
    const one = asks[0] as Extract<LogEvent, { t: 'holder/ask' }>
    assert.equal(JSON.parse(one.body).questions[0].question, '要不要删掉它？', '重放得出问的那一句')
    assert.equal(one.digest.length, 16, 'digest 与 round/intent 同一个口径（16 字符）')
    assert.equal(rows.some((e) => e.t === 'contract/issue'), false, '停在门口的时候不许发契约')
    assert.deepEqual(worktreeOf(b.root), before, `工作树多了东西：${worktreeOf(b.root).join(' ')}`)
  } finally {
    await b.close()
  }
})

// ── ⑨ 模型面那一份的语言 ────────────────────────────────────────────────────────
//
// **口径：谁读谁的语言。** 模型读到的每一个字节——装配出来的提示词 · 工具回执 · 拒的话 ·
// 回执被截断时那句标记——走英文；人读的走中文（命令行 · 日志 · 报告 · 停因）；印记（断言 ·
// 载入时抛出 · 配置错）也归人。`deepseek-harness` 的先例就是这么分的：系统提示词通篇英文
// （`snapshots/web/*/system-prompt.expected.md`），工具面给模型看的诊断也是英文
// （`tool-fs/src/error.ts` 的模块注释写着 "the stable message shown to the model"），
// 而唯一一句语言指令出现在"系统要模型产出给人看的文字"的地方——会话标题那一路写着
// `Use the language of the messages.`。人的那一面它另有一套本地化（`client/locale`）。
//
// **这一条量的是回执那一格**：正文里带着文件内容的（`read` · `grep`）只看**头一行**——
// 案例内容是中文，那是人写的，不归这一条管；而**案例内容之外的每一个字节**都由这一条判。
// 输入一律用 ASCII：回执里出现汉字，就只能是 harness 自己写的。
test('⑨ 模型读到的回执里没有一个汉字（正文那几格只看头一行）', async () => {
  const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/
  const b = await bench()
  try {
    await b.host.writeBytes('note.txt' as RelPath, new Uint8Array(Buffer.from('这是一份中文内容\n', 'utf8')))
    const judge = (what: string, text: string, headOnly = false): void => {
      const part = headOnly ? (text.split('\n')[0] ?? '') : text
      assert.ok(!CJK.test(part), `${what} 那一份里有汉字：${JSON.stringify(part.slice(0, 200))}`)
    }
    // **负对照：这一条自己抓得住**——换成一份中文的回执，当场就该红。
    assert.throws(() => judge('负对照', '视图里没有这个文件：x'), /那一份里有汉字/)
    // 一 · 十二条工具各自那一种回执（成功与失败两路都走一遍）
    const calls: readonly (readonly [string, unknown, boolean])[] = [
      ['read', { path: 'note.txt' }, true],
      ['read', { path: 'nope.txt' }, false],
      ['write', { path: 'made.txt', content: 'made\n' }, false],
      // `edit` 那一格的失败路是**抛**（`host.ts` 的 find 没找到 → `tool-threw` → 那一趟就此收场），
      // 那不是回执，所以这一条量的是它成功那一路。
      ['edit', { path: 'made.txt', old_string: 'made', new_string: 'made it' }, false],
      ['read_image', { path: 'nope.png' }, false],
      ['glob', { pattern: 'nothing/*.zzz' }, false],
      ['grep', { pattern: 'made', path: '' }, true],
      ['bash', { command: '/bin/sh -c "echo hi"' }, false],
      ['todo_write', { todos: [{ content: 'one thing', status: 'pending' }] }, false],
      ['todo_write', { todos: 'not an array' }, false],
      ['exit_plan_mode', { plan: 'write made.txt' }, false],
      ['exit_plan_mode', { plan: 'write made.txt', planFilePath: 'notes.md' }, false],
      ['ask_user_question', { questions: [{ question: 'which one?' }] }, false],
      ['ask_user_question', { questions: [] }, false],
      ['checkpoint', { message: 'step one' }, false],
      ['read', {}, false],
      ['bash', {}, false],
      ['grep', { pattern: '(' }, false],
      ['glob', { pattern: '' }, false],
      ['todo_write', {}, false],
      ['checkpoint', {}, false],
    ]
    for (const [name, args, headOnly] of calls) {
      const r = await face(name, args, b.host, '', true)
      judge(`${name} ${JSON.stringify(args)}`, r.output, headOnly)
    }
    // 二 · 路径形状不合法那一路（`PathShapeError` 接成一条失败的结果）
    for (const raw of ['.', '/etc/passwd', 'a//b', 'a/./b', 'a/../b', 'a\\b']) {
      const r = await face('read', { path: raw }, b.host)
      assert.equal(r.ok, false, `${JSON.stringify(raw)} 该拒`)
      judge(`read ${JSON.stringify(raw)}`, r.output)
    }
    // 三 · 围栏那四句（拒的话与"接不上实现"那一条都在这一格里）
    for (const raw of ['/etc/passwd', '../../escape', 'a\\b']) {
      const got = b.roots.resolveVirtual(raw as never, '' as never)
      assert.equal(got.ok, false, `${raw} 该被围栏拒`)
      if (!got.ok) {
        judge(`围栏 ${raw}`, got.error.message)
        judge(`noFace ${raw}`, noFace('bash', got.error).output)
      }
    }
    // 四 · 回执被截断时那句标记（上限那一处是常数，不给模型选）
    judge('截断标记', capReceipt(`${'x'.repeat(9000)}\n`, 100))
    console.log('⑨ 读数：回执 21 条（含失败路）· 路径形状 6 条 · 围栏 3 条 · 截断标记 1 条——一个汉字都没有')
  } finally {
    await b.close()
  }
})
// ── 格 3 · 预取：缓存与批量取在工具这一层的落点 ──────────────────────────────────

/**
 * 一份**从提交起**的台子：内容在下层（对象库里），所以 `grep` 的每一次读都要经真源。
 *
 * 与 `bench()` 的差别有两处：那台的字节在视图上层（本格写过的），读起来是内存直给，量不到
 * 预取；这一台先把文件提交下去，再按那个提交开视图，于是"逐文件读"真的落到 M1。
 *
 * **建语料那个句柄用完就关**：`putBlob` 会顺手把字节回填进它自己的缓存，留着它当测量句柄，
 * 缓存一开始就是热的，什么都量不到。回来这一份句柄从零起。
 */
interface LowerBench {
  readonly truth: TruthHandle
  readonly host: ToolHost
  readonly close: () => Promise<void>
}

async function lowerBench(
  files: Record<string, string>,
  opts: { readonly cache?: number; readonly read?: 'batch' | 'oneshot' } = {},
): Promise<LowerBench> {
  const root = mkdtempSync(join(tmpdir(), 'fugue-b5-lower-'))
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const build = openTruth(root)
  const entries: TreeEntry[] = []
  for (const [name, body] of Object.entries(files)) {
    entries.push({ name, mode: 0o100644, id: await build.putBlob(new Uint8Array(Buffer.from(body, 'utf8'))) })
  }
  const base = await build.commit(await build.putTree(entries), [], '底')
  await build.close()

  const log = openLog(root, { write: AGENT as WriterId, sync: 'each' })
  const measure = openTruth(root, {
    ...(opts.cache === undefined ? {} : { blobCacheBytes: opts.cache }),
    ...(opts.read === undefined ? {} : { read: opts.read }),
  })
  const view = await loadView(log, AGENT as WriterId, { lower: lowerAt(measure, base) })
  const host = createToolHost(view, createRoots(root as never), {
    actions: { writer: AGENT as WriterId, log, truth: measure, head: await refHeadOf(log, AGENT as WriterId, base) },
  })
  return {
    truth: measure,
    host,
    close: async () => {
      await log.close()
      await measure.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** 30 个文件散在 6 个目录下（连根共 7 个目录）：逐文件读与批量取的差别在这里看得出来。 */
function lowerCorpus(): Record<string, string> {
  const files: Record<string, string> = {}
  for (let i = 0; i < 30; i++) {
    files[`d${i % 6}/f${String(i).padStart(2, '0')}.txt`] = `第 ${i} 行\n这一行带个记号\n`
  }
  return files
}

test('格 3 · 地板：容量 0 + 预取缺席 + oneshot 三者同开，回执与缺省档逐字节相同', async () => {
  // **这三样是本站在两个方向上留的退化档**：容量 0（缓存关）· 预取缺席（没有那道缝）·
  // `oneshot`（批量子进程那一档不要）。它们任意组合都必须**跑得起来**——判据是回执不变。
  const floor = await lowerBench(lowerCorpus(), { cache: 0, read: 'oneshot' })
  const floorHost = (({ prefetch, ...rest }) => rest)(floor.host)
  assert.equal(floor.host.prefetch === undefined, false)
  try {
    const before = floor.truth.stats().gitRequests
    const out = await face('grep', { pattern: '记号' }, floorHost as ToolHost)
    const cost = floor.truth.stats().gitRequests - before
    assert.equal(out.ok, true)
    assert.equal(out.output.split('\n').length - 1, 30, `三样同开也要搜到 30 行：${out.output.slice(0, 120)}`)
    assert.equal(floor.truth.stats().readTier, 'oneshot', '显式选了退化档，就该在退化档上')
    assert.equal(floor.truth.stats().blobEntries, 0, '容量 0 一条都不存')
    assert.ok(cost >= 30, `三样同开就是逐文件读：实际 ${cost}`)
    assert.ok(cost <= 45, `但也不该炸开：实际 ${cost}（每个文件一趟 + 走树那几趟）`)

    // 与缺省档（缓存开着 · 预取在位 · 批量档）的回执**逐字节相同**。
    const full = await lowerBench(lowerCorpus())
    try {
      const ref = await face('grep', { pattern: '记号' }, full.host)
      assert.equal(out.output, ref.output, '三样同开与缺省档的回执必须逐字节相同')
      assert.ok(full.truth.stats().readTier !== 'oneshot')
    } finally {
      await full.close()
    }
    console.log(`格 3 地板读数：三者同开（容量 0 · 无预取 · oneshot）30 个文件 ${cost} 次请求，回执与缺省档逐字节相同`)
  } finally {
    await floor.close()
  }
})

test('格 3 · 预取：一批把候选的内容取回来，此后逐文件读全命中', async () => {

  // **无预取那一档**：从产品宿主上摘掉那一栏，就是今天的逐文件读。
  const b = await lowerBench(lowerCorpus())
  let bareCost = 0
  let bareOut: { ok: boolean; output: string }
  try {
    const { prefetch, ...bare } = b.host
    assert.equal(typeof prefetch, 'function', '产品那一份宿主该有这道缝')
    const before = b.truth.stats().gitRequests
    bareOut = await face('grep', { pattern: '记号' }, bare as ToolHost)
    bareCost = b.truth.stats().gitRequests - before
    assert.equal(bareOut.ok, true)
    assert.equal(bareOut.output.split('\n').length - 1, 30, `缺席那一档也要搜到 30 行：${bareOut.output.slice(0, 120)}`)
    assert.ok(bareCost >= 40, `没有预取那一档该是每个文件各走一趟 contents，实际 ${bareCost}`)
  } finally {
    await b.close()
  }

  // **有预取那一档**：另起一台（新句柄、缓存从零起），同一份语料、同一个模式。
  const c = await lowerBench(lowerCorpus())
  try {
    const before = c.truth.stats().gitRequests
    const out = await face('grep', { pattern: '记号' }, c.host)
    const coldCost = c.truth.stats().gitRequests - before
    assert.equal(out.ok, true)
    assert.equal(out.output, bareOut.output, '预取不许改变回执——逐字节相同')
    // **判据**：30 个文件的内容是被**一批**取回来的，不是一条一条。差的那 29 趟就是这一条。
    assert.ok(coldCost <= bareCost - 24, `有预取那一档的冷读该少掉那一批的 29 趟：无预取 ${bareCost} → 有预取 ${coldCost}`)
    assert.ok(c.truth.stats().blobEntries >= 30, `那一批该把 30 条内容装进缓存，实际 ${c.truth.stats().blobEntries}`)

    // **热的那一趟一个请求都不发**：内容已经在缓存里了。
    const hotBefore = c.truth.stats().gitRequests
    const hot = await face('grep', { pattern: '记号' }, c.host)
    assert.equal(hot.output, out.output, '热的那一趟回执也逐字节相同')
    assert.equal(c.truth.stats().gitRequests, hotBefore, `热 grep 不该再问 git，实际 ${c.truth.stats().gitRequests - hotBefore}`)
    console.log(
      `格 3 读数：30 个文件 / 7 个目录 · 冷 grep 的请求数 无预取 ${bareCost} → 有预取 ${coldCost}（热的那趟 0）`,
    )
  } finally {
    await c.close()
  }
})

/**
 * 格 3 · 预取只取范围内那几份：范围外的路径不进那一批，而**回执逐字节不变**。
 *
 * 抓住的变异：预取那一行回到"整棵树都先取回来"（范围外那 25 份又占上那一批）。同一条里还有
 * 另一半：**收窄不许动结果**——结果那一路的判据在 grep 的循环里，预取只是提示。
 */
test('格 3 · 预取只取范围内那几份：范围外的路径不进那一批，回执逐字节不变', async () => {
  const c = await lowerBench(lowerCorpus())
  try {
    const batches: string[][] = []
    const raw = c.host.prefetch
    assert.equal(typeof raw, 'function', '产品那一份宿主该有这道缝')
    const host = {
      ...c.host,
      prefetch: async (paths: readonly string[]) => {
        batches.push([...paths])
        await raw(paths)
      },
    } as ToolHost

    // 范围 `d0`：那一批里只许有 `d0/` 下面那 5 份（整棵树 30 份）。
    const before = c.truth.stats().gitRequests
    const scoped = await face('grep', { pattern: '记号', path: 'd0' }, host)
    const scopedCost = c.truth.stats().gitRequests - before
    assert.equal(scoped.ok, true, scoped.output)
    assert.equal(scoped.output.split('\n').length - 1, 5, `范围里的行数不对：${scoped.output.slice(0, 160)}`)
    assert.equal(batches.length, 1, `一趟 grep 该只发一批预取：发了 ${batches.length}`)
    const batch = batches[0] ?? []
    const away = batch.filter((p) => !p.startsWith('d0/'))
    assert.deepEqual(away, [], `范围外的路径进了预取批：${away.slice(0, 5).join(' · ')}`)
    assert.equal(batch.length, 5, `这一批该是范围内那 5 份：${batch.join(' · ')}`)

    // 回执不变：同一份台上再问一次整个视图，把那 5 行挑出来，逐字节相同。
    const whole = await face('grep', { pattern: '记号' }, host)
    assert.deepEqual(
      scoped.output.split('\n').slice(1).sort(),
      whole.output
        .split('\n')
        .slice(1)
        .filter((l) => l.startsWith('d0/'))
        .sort(),
      '收了范围之后的回执与整个视图里那几行不一致',
    )
    console.log(
      `格 3 读数：范围 d0 的预取批 ${batch.length} 份（整棵树 30 份）· 那一趟 ${scopedCost} 次请求 · 回执 5 行与整个视图里那 5 行逐字节相同`,
    )
  } finally {
    await c.close()
  }
})
// ── ⑩ `read` 的窗口档：offset/limit 下推（T16 ① 的第二半）──────────────────────
//
//   · 两档格式：**不给窗口** = 与从前逐字节相同（头 + 原样正文，一个行号都不带）；**给了任意一项**
//     = 头在原句尾上带一句窗口标注，正文每行 `${原文件行号}\t${原文行}`。
//   · 语法坏拒 · 语义空如实：坏参数在**伸手之前**拒（下面那个"一碰就喊"的宿主是量具），
//     而 `limit: 0` / 越过末尾 / 空文件都是 ok 的"空窗口"。
//   · 大窗口被 `capReceipt` 截了之后，头里那句标注还在（它在前 4 KiB 里），而标记里那两个数是
//     **这一条回执**的——两套数各有所指，别混。
test('⑩ read 的窗口档：整档逐字节照旧 · 切片带原文件行号 · 坏参数拒在伸手之前 · 空窗口如实', async () => {
  const b = await bench()
  try {
    const text = 'a\nb\nc\nd\n'
    const size = Buffer.byteLength(text, 'utf8')
    await b.host.writeBytes('w.txt' as RelPath, new Uint8Array(Buffer.from(text, 'utf8')))
    const head = `w.txt (${size} bytes · 4 lines · mode 100644`

    // 一 · 整档：与从前逐字节相同——头 + 原样正文，一个行号都不带。
    const whole = await face('read', { path: 'w.txt' }, b.host)
    assert.equal(whole.ok, true, whole.output)
    assert.equal(whole.output, `${head})\n${text}`, '整档还是那一串（这一条是"输出逐字节不变"的落点）')

    // 二 · 切片：行号是**原文件行号**；头上多一句窗口标注。
    const slice = await face('read', { path: 'w.txt', offset: 3, limit: 2 }, b.host)
    assert.equal(slice.output, `${head} · lines 3–4 shown)\n3\tc\n4\td`)
    // 只给 offset：读到末尾。只给 limit：从第一行起（一行那一档用单数）。
    assert.equal((await face('read', { path: 'w.txt', offset: 3 }, b.host)).output, `${head} · lines 3–4 shown)\n3\tc\n4\td`)
    assert.equal((await face('read', { path: 'w.txt', limit: 1 }, b.host)).output, `${head} · line 1 shown)\n1\ta`)
    // 同一份文件的整读与切片：正文那一半是同一串字节（切片只是加了 `N\t` 前缀与拆行）。
    assert.equal(slice.output.split('\n').slice(1).map((l) => l.slice(2)).join('\n'), text.split('\n').slice(2, 4).join('\n'))

    // 三 · 语义空如实：三档都是 ok 的空窗口（不是错误）。
    for (const args of [{ limit: 0 }, { offset: 9 }, { offset: 5, limit: 3 }]) {
      const empty = await face('read', { path: 'w.txt', ...args }, b.host)
      assert.equal(empty.ok, true, `${JSON.stringify(args)} 该是一次 ok 的空窗口：${empty.output}`)
      assert.equal(empty.output, `${head} · no lines shown)\n`)
    }
    // 空文件：整档照旧给头 + 空正文；给了窗口就是空窗口。
    await b.host.writeBytes('empty.txt' as RelPath, new Uint8Array(0))
    assert.equal((await face('read', { path: 'empty.txt' }, b.host)).output, 'empty.txt (0 bytes · 0 lines · mode 100644)\n')
    assert.equal((await face('read', { path: 'empty.txt', offset: 1 }, b.host)).output, 'empty.txt (0 bytes · 0 lines · mode 100644 · no lines shown)\n')

    // 四 · **坏参数拒在伸手之前**：这个宿主一碰就喊（读到了它，这一条就红在那句喊上）。
    const yell = new Proxy({} as ToolHost, {
      get: (_t, k) => () => {
        throw new Error(`实现在问清窗口之前就碰了宿主的 ${String(k)}——它没先问。`)
      },
    })
    const bads: readonly Record<string, unknown>[] = [
      { offset: 0 },
      { offset: -1 },
      { offset: 1.5 },
      { offset: '2' },
      { offset: null },
      { offset: Number.MAX_SAFE_INTEGER + 2 },
      { limit: -1 },
      { limit: 2.5 },
      { limit: '1' },
      { limit: Number.MAX_SAFE_INTEGER + 2 },
    ]
    for (const bad of bads) {
      const r = await face('read', { path: 'w.txt', ...bad }, yell)
      assert.equal(r.ok, false, `${JSON.stringify(bad)} 该当场拒：${r.output}`)
      const which = 'offset' in bad ? 'offset' : 'limit'
      assert.match(r.output, new RegExp(`^${which} has to be `), `拒的话要点出是哪一个参数：${r.output}`)
    }
    // 而**能兑现**的那一档照旧伸手（同一个宿主上，参数对了就该碰它——拒的是参数，不是窗口）。
    await assert.rejects(async () => await face('read', { path: 'w.txt', offset: 1, limit: 1 }, yell), /就碰了宿主的/)
    console.log(
      `⑩ 读数：整档 ${whole.output.split('\n')[0]}｜切片 ${JSON.stringify(slice.output.split('\n')[0])}｜空窗口 3 档 + 空文件｜坏参数 ${bads.length} 条拒在伸手之前`,
    )
  } finally {
    await b.close()
  }
})

test('⑩ 大窗口被截：头里那句窗口标注还在，而标记里那两个数是这一条回执的', async () => {
  const b = await bench()
  try {
    const lines = 400
    const text =
      Array.from({ length: lines }, (_, i) => `第 ${i + 1} 行：这一段汉字要长到能把窗口这一条回执顶过上限。`).join('\n') + '\n'
    await b.host.writeBytes('big.txt' as RelPath, new Uint8Array(Buffer.from(text, 'utf8')))

    // **走执行器**：回执的上界那一刀在它的出口上（`capReceipt`），直接调实现量不到那一刀。
    const executor = createToolExecutor({ logOf: () => b.log, host: b.host, fenceOf: b.fenceOf, ensureOf: b.ensureOf })
    const got = await executor.execute(
      { id: 'c1', name: 'read', arguments: JSON.stringify({ path: 'big.txt', offset: 5, limit: 200 }) },
      handleOf(stateOf()),
    )
    assert.equal(got.ok, true, `这一条该成：${got.output.slice(0, 200)}`)

    // 一 · 头那一句窗口标注在**前 4 KiB** 里，所以被截之后它还在。
    assert.match(got.output.slice(0, 4096), /big\.txt \(\d+ bytes · 400 lines · mode 100644 · lines 5–204 shown\)/)

    // 二 · 标记里那两个数是**这一条回执**的（头 + 那 200 行），不是整个文件的——两套数各有所指。
    const all = text.split('\n')
    all.pop()
    const body = all.slice(4, 204).map((s, k) => `${5 + k}\t${s}`).join('\n')
    const receipt = `big.txt (${Buffer.byteLength(text, 'utf8')} bytes · 400 lines · mode 100644 · lines 5–204 shown)\n${body}`
    assert.ok(
      Buffer.byteLength(receipt, 'utf8') > MAX_RECEIPT_BYTES,
      `这一条要真的超上限：${Buffer.byteLength(receipt, 'utf8')} 字节`,
    )
    const m = /\n…\((\d+) bytes omitted · (\d+) bytes and (\d+) lines in all\)…\n/.exec(got.output)
    assert.ok(m !== null, `这一条该被截：${got.output.slice(-200)}`)
    assert.equal(Number(m[2]), Buffer.byteLength(receipt, 'utf8'), '标记里的字节数是这一条回执的')
    assert.equal(Number(m[3]), lineCount(receipt), '标记里的行数是这一条回执的')
    assert.notEqual(Number(m[2]), Buffer.byteLength(text, 'utf8'), '标记里的字节数不该是整个文件的')
    assert.ok(got.output.endsWith(receipt.slice(-12)), '尾就是这一条回执的尾')
    console.log(
      `⑩ 截断读数：这一条回执 ${Buffer.byteLength(receipt, 'utf8')} 字节 / ${lineCount(receipt)} 行 → 略去 ${m[1]} 字节` +
        `（整个文件是 ${Buffer.byteLength(text, 'utf8')} 字节 / 400 行 · 头上的窗口标注在被截之后还在）`,
    )
  } finally {
    await b.close()
  }
})
