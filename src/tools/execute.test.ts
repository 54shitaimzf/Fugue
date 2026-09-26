// B5 的断言：工具面（PLAN § 5.8 的 B5 行 · 架构 § 8.10 的工具目录 · § 8.9 四条推论 ·
// § 14.2 第 4 步 · § 9.6「`checkpoint`（模型侧）与 `fugue commit`（人侧）是同一个操作的两个
// 名字」）。跑法：cd ~/fugue && node --test src/tools/execute.test.ts
//
//   ① 参数那一层：解不开的 JSON 是一次失败的结果（不是抛）· 少了必填参数说得出是哪一个
//   ② **写进去的字节读回来逐字节相同**（不是"写成功了"）：真视图 · 真日志 · 真对象库
//   ③ `glob` / `grep` 按 `walk` 给的路径走，`**` 跨 `/`、`*` 不跨
//   ④ **假模型驱动 读 → 写 → 检查点，走到一次真提交**，而**真工作树一个文件都没多**
//   ⑤ 负对照：字节那一栏改成"读回来的 UTF-8 文本相同"→ 一条非法序列就把它变红
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
import { modelDeclOf } from '../model/contract.ts'
import type { ModelEvent } from '../model/contract.ts'
import { CATALOG_STATES, catalog } from '../tools/catalog.ts'
import type { AgentId, BranchId, CommitId, ContractId, RelPath, WriterId } from '../terms.ts'
import type { AgentHandle } from '../runtime/step.ts'
import { createRuntime, scriptedModel } from '../runtime/step.ts'
import type { ToolCallRequest } from '../runtime/step.ts'
import { createToolExecutor } from '../capability/dispatch.ts'
import { faceOf, parseArgs } from './execute.ts'
import type { ToolHost } from './execute.ts'
import { createToolHost } from './host.ts'
import { refHeadOf } from '../round/head.ts'

const AGENT = 'agent-1' as AgentId
const CATALOG = catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number])
const DECL = modelDeclOf('deepseek-chat/anthropic')

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
    assert.match(noPath.output, /少了必填参数 path/)

    const noContent = await face('write', { path: 'a.txt' }, b.host)
    assert.equal(noContent.ok, false)
    assert.match(noContent.output, /少了必填参数 content/)
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
    assert.match(wrote.output, /写了 src\/note\.txt（\d+ 字节）\。$/)

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
    assert.match(none.output, /没有匹配/)
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

const USAGE = { inputTokens: 88, cacheReadTokens: 24000, cacheWriteTokens: 0, outputTokens: 64, rawStop: null, model: null }

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
    wireModel: 'deepseek-chat',
    target: {
      providerId: 'fixture',
      host: '',
      wire: { name: 'anthropic-messages' } as AgentHandle['target']['wire'],
      path: '',
      model: 'deepseek-chat',
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
    const got = await fn({}, host, { agent: AGENT, step: 0, cwd: '', holder: false })
    if (need.length === 0) {
      assert.equal(got.output.includes('少了必填参数'), false, `${e.name} 目录里没有必填键，实现却报了缺：${got.output}`)
      continue
    }
    const m = /少了必填参数 (\S+?)——/.exec(got.output)
    assert.ok(m !== null, `${e.name} 什么都不给时报的不是"少了必填参数"：${got.output}`)
    assert.ok(need.includes(m[1]!), `${e.name} 实现读的是 ${m[1]}，而目录的 required 是 ${need.join(' · ')}`)
    asked.push(`${e.name}:${m[1]}`)
  }
  console.log(`⑥ 读数 · 逐条实现读的必填键：${asked.join(' · ')}`)
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
    assert.match(first.output, /记下了 2 条待办/)

    const second = await face('todo_write', { todos: [{ content: '写一遍', status: 'completed' }] }, b.host)
    assert.match(second.output, /记下了 1 条待办/)
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
    assert.match(asSub.output, /这不是你这一格的事/)
    assert.equal(asSub.halt, undefined, '子 agent 那一趟不叫停——它还得接着干活')

    // 持轮者：落事件 + 停在门口。
    const asHolder = await face('exit_plan_mode', { plan: '先拆三格，再各跑一条断言' }, b.host, '', true)
    assert.equal(asHolder.ok, true, asHolder.output)
    assert.equal(asHolder.halt, true, '停在门口：这一格到这儿为止')
    // **回执只说实话**（W10 处三）：今天不存在「人答了接着跑 / round go 放行」那条路，
    // 所以它不指门——只说「这一轮到此为止，人读日志之后开新轮」。
    assert.match(asHolder.output, /这一轮到此为止/)
    assert.ok(!/round go/.test(asHolder.output), '那句不存在的门不许出现在回执里')

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
    assert.match(asSub.output, /这不是你这一格的事/)

    // 问超了：当场拒，话里指得出去处（不是静默截断成前四个）。
    const tooMany = await face(
      'ask_user_question',
      { questions: [1, 2, 3, 4, 5].map((n) => ({ question: `第 ${n} 个问题？` })) },
      b.host,
      '',
      true,
    )
    assert.equal(tooMany.ok, false, tooMany.output)
    assert.match(tooMany.output, /一次最多问 4 个/)

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
