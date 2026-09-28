// S8 的本地这一条链，**从命令行那一头走一遍**：装配 → 轮次（起头 · 契约 · 合并 · 验收 · 推进）
// → 指标重算。PLAN § 5.8 的 B7.5 与 B4/B5/B7 的命令面 · 架构 § 9.6 的"CLI 是单次进程 + 每次重建"。
//
// **为什么单开一份**：`fugue.test.ts` 那一份量的是 S1 那几条（读写 · 检视 · 提交 · 重放 · 配置），
// 而这一份量的是**接口之间接上了没有**——每一步都是一次独立的进程，下一条命令靠重放回来。
// 单元测试绿而命令是坏的，这一站已经撞过一次（`B7.5` 之前 `fugue round run` 是
// `deps.stub is not a function`，而 294 条单测全绿），所以"能不能跑"要有一条自己的断言。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'
import { openLog } from '../log/log.ts'
import { clearMaterialization, removeTree } from '../materialize/mount.ts'
import { matParts } from '../roots/paths.ts'

const CLI = fileURLToPath(new URL('./fugue.ts', import.meta.url))

interface Run {
  code: number
  stdout: string
  stderr: string
}

/**
 * 起一个 CLI 子进程。
 *
 * **环境是给定了的**（只留 `PATH` 与 `HOME`）：这一份里那几条"凭据不在"的断言原先靠"跑测试的
 * 那个人恰好没设 `DEEPSEEK_API_KEY`、`/home/ubuntu/.fugue/credentials/deepseek.key` 恰好不存在"
 * ——那是环境在断言，不是测试在断言（实测：把那份凭据文件放好之后，一条既有断言从退 1 变成退 0）。
 * 这一份给不了它就不该拿得到：那两条路都要**显式**给（`--credential`）。
 */
function fugue(root: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: '',
    maxBuffer: 1 << 26,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? '/tmp' },
  })
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

function fugueStdin(root: string, input: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 1 << 26,
  })
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

/** 一份在视图**之外**的源文件：`write --from` 读的是宿主路径，不是视图路径。 */
function srcOf(): string {
  const dir = tmpDir('fugue-chain-src-')
  const at = join(dir, 'bottom.txt')
  writeFileSync(at, '底。\n')
  return at
}

function tmpRoot(): string {
  const root = tmpDir('fugue-chain-')
  const init = spawnSync('git', ['init', '-q', '.'], { cwd: root, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  return root
}

test('S8 这一条链从命令行走一遍：write → commit → assemble → config → round run → log', () => {
  const root = tmpRoot()
  // 一份在视图**之外**的文件：`write --from` 读的是宿主路径，不是视图路径。
  const outside = tmpDir('fugue-chain-src-')
  const src = join(outside, 'bottom.txt')
  writeFileSync(src, '底：这一份是链上第一笔。\n')

  const w = fugue(root, 'write', 'README.md', '--from', src)
  assert.equal(w.code, 0, `write 退了 ${w.code}：${w.stderr}`)
  const c = fugue(root, 'commit', '-m', '底')
  assert.equal(c.code, 0, `commit 退了 ${c.code}：${c.stderr}`)
  const r = fugue(root, 'read', 'README.md')
  assert.equal(r.stdout, '底：这一份是链上第一笔。\n')

  // ── 装配那一格：三区各有指纹与字节数，两条协议的第一处分叉印得出来 ──────────────
  const asm = fugue(root, '--json', 'assemble', 'subagent', '--against', 'holder')
  assert.equal(asm.code, 0, `assemble 退了 ${asm.code}：${asm.stderr}`)
  const a = JSON.parse(asm.stdout) as {
    protocol: string
    segments: number
    toolCatalog: number
    zones: Record<'A' | 'B' | 'C', { hash: string; bytes: number }>
    firstDivergence: { against: string; at: number; note: string } | null
    violations: unknown[]
  }
  assert.equal(a.protocol, 'subagent')
  assert.equal(a.segments, 11, '子 agent 那份声明是十一段')
  assert.equal(a.toolCatalog, 12, '工具目录十二条')
  for (const z of ['A', 'B', 'C'] as const) {
    assert.ok(a.zones[z].bytes > 0, `${z} 区是空的——装配没接上段源`)
    assert.match(a.zones[z].hash, /^[0-9a-f]{16}$/, `${z} 区的指纹不是 16 位十六进制`)
  }
  assert.deepEqual(a.violations, [], `四条约束报了 ${a.violations.length} 处`)
  // 与持轮者那份声明比：共同部分之后各有各的地方（A 区全等，差别在 B 区）。
  assert.equal(a.firstDivergence?.against, 'holder')
  assert.ok((a.firstDivergence?.at ?? 0) >= a.zones.A.bytes, `第一处分叉落在 A 区里（${a.firstDivergence?.at} < ${a.zones.A.bytes}）`)

  // ── 配置那几个面：动作 · 断言 · 拆分 ─────────────────────────────────────────
  const okAction = JSON.stringify({ argv: ['/bin/sh', '-c', 'true'], outputs: [] })
  assert.equal(fugue(root, 'config', 'set', 'actions.ok', okAction).code, 0)
  assert.equal(
    fugue(root, 'config', 'set', 'round.assertions', JSON.stringify([{ name: '总是过', action: 'ok', argv: ['/bin/sh', '-c', 'true'] }])).code,
    0,
  )
  assert.equal(
    fugue(
      root,
      'config',
      'set',
      'round.split',
      JSON.stringify([
        { goal: '写一份 a.ts', ownedPaths: ['a.ts'], deliverables: [{ path: 'a.ts', form: '一份文件' }], assertions: [{ name: '总是过', action: 'ok' }] },
      ]),
    ).code,
    0,
  )
  const shown = fugue(root, '--json', 'config', 'get', 'round.split')
  assert.equal(shown.code, 0)
  assert.ok(JSON.parse(shown.stdout) !== undefined, 'config get 吐的不是 JSON')

  // ── 轮次那一整条：起头 → 干一格 → 合并 → 验收 → 推进，外加八元指标 ────────────
  const run = fugue(root, '--json', 'round', 'run', '写一份 a.ts', '--report', '--metrics')
  assert.equal(run.code, 0, `round run 退了 ${run.code}：${run.stderr}`)
  const j = JSON.parse(run.stdout) as {
    round: string
    base: string
    state: string
    contracts: { id: string; agent: string; kind: string }[]
    verify: { pass: number; fail: number; unrunnable: number; ok: boolean }
    advanced: { written: string[]; removed: string[]; skipped: string[] } | null
    metrics: { metric: string; value: number | null; numerator: number | null; denominator: number | null; how: string }[]
    report: { metric: string; value: number | null }[]
  }
  // **通过那一档的终点是 `Rebuilding` 不是 `Committed`**（§ 5.8.a 五：定格之后还有"推进真实
  // 工作树"那一步）。判据按 `verify.ok` 与 `advanced !== null` 读。
  assert.equal(j.verify.ok, true, `验收没过：${JSON.stringify(j.verify)}`)
  assert.equal(j.verify.pass, 1)
  assert.equal(j.verify.fail, 0)
  assert.equal(j.verify.unrunnable, 0)
  assert.equal(j.state, 'Rebuilding', `那一趟的终点是 ${j.state}`)
  assert.ok(j.advanced !== null, '验收过了却没推进')
  assert.ok(j.contracts.length >= 1)
  assert.ok(j.contracts.every((x) => x.agent !== ''), '契约里没有 agent 那一栏')

  // 八元指标：**每个的分子与分母都在**（`B7` 的断言 ②）——`--json` 这一档也一样。
  assert.equal(j.metrics.length, 8, `--metrics 那一档该给八条指标，实际 ${j.metrics.length} 条`)
  for (const m of j.metrics) {
    assert.equal(typeof m.how, 'string')
    assert.ok(m.how.length > 0, `${m.metric} 没说清怎么数出来的`)
    assert.equal(typeof m.numerator === 'number' || m.numerator === null, true)
    assert.equal(typeof m.denominator === 'number' || m.denominator === null, true)
  }


  // **不给 `--metrics` 时那一栏是 `null`**（不是空数组，也不是打回那三个数）。
  const noMetrics = fugue(root, '--json', 'round', 'run', '再跑一遍同一个目标')
  // 同一个目标再跑一遍会撞上已有的分支头（这一站的口径：报出来、照发），所以这一条只看
  // "那一栏的形状"：要么这一趟跑成了而 `metrics` 是 `null`，要么它当场拒了。**不假装跑成了**。
  if (noMetrics.code === 0) {
    const j2 = JSON.parse(noMetrics.stdout) as { metrics: unknown }
    assert.equal(j2.metrics, null, `没给 --metrics 时那一栏该是 null，实际 ${JSON.stringify(j2.metrics)}`)
  } else {
    assert.match(noMetrics.stderr, /\S/, '这一趟没跑成，stderr 却是空的')
  }

  // ── 日志那一格：同一份日志再读一遍，指标重算得出同一组值 ──────────────────────
  const log = fugue(root, '--json', 'log')
  assert.equal(log.code, 0, `log 退了 ${log.code}：${log.stderr}`)
  const lines = log.stdout.trim().split('\n').filter((l) => l !== '')
  assert.ok(lines.length > 0, '日志是空的')
  for (const l of lines) JSON.parse(l)

  console.log(
    `链的读数：assemble 三区 ${a.zones.A.bytes}/${a.zones.B.bytes}/${a.zones.C.bytes} 字节（第一处分叉在 ${a.firstDivergence?.at}）· ` +
      `round ${j.round} 终点 ${j.state} · 验收 ${j.verify.pass}/${j.verify.fail}/${j.verify.unrunnable} · ` +
      `推进写 ${j.advanced?.written.length ?? 0} 删 ${j.advanced?.removed.length ?? 0} · ` +
      `指标 ${j.metrics.length} 条 · 日志 ${lines.length} 条`,
  )
})

test('链上的那一格：轮次跑完，真实工作树上就是合并后的那棵树（推进真的写了盘）', () => {
  const root = tmpRoot()
  const outside = tmpDir('fugue-chain-src-')
  const src = join(outside, 'bottom.txt')
  writeFileSync(src, '底。\n')
  assert.equal(fugue(root, 'write', 'README.md', '--from', src).code, 0)
  assert.equal(fugue(root, 'commit', '-m', '底').code, 0)
  assert.equal(fugue(root, 'config', 'set', 'actions.ok', JSON.stringify({ argv: ['/bin/sh', '-c', 'true'], outputs: [] })).code, 0)
  assert.equal(
    fugue(root, 'config', 'set', 'round.assertions', JSON.stringify([{ name: '总是过', action: 'ok', argv: ['/bin/sh', '-c', 'true'] }])).code,
    0,
  )
  assert.equal(
    fugue(
      root,
      'config',
      'set',
      'round.split',
      JSON.stringify([
        {
          goal: '写一份 a.ts',
          ownedPaths: ['a.ts'],
          deliverables: [{ path: 'a.ts', form: '一份文件' }],
          assertions: [{ name: '总是过', action: 'ok' }],
        },
      ]),
    ).code,
    0,
  )
  const run = fugue(root, '--json', 'round', 'run', '写一份 a.ts')
  assert.equal(run.code, 0, run.stderr)
  // **打桩那一档没有停因可报**：它没有"为什么停"这句话（`stubDriver` 不产出读数）。
  assert.deepEqual((JSON.parse(run.stdout) as { agents?: unknown }).agents, [], '打桩那一档的 agents 该是空数组')
  const j = JSON.parse(run.stdout) as { advanced: { written: string[] } | null }
  assert.ok(j.advanced !== null)
  // 推进之后盘上就有那一份产物——**这是"链的末端真的落地了"那一条**。
  const onDisk = readFileSync(join(root, 'a.ts'), 'utf8')
  assert.ok(onDisk.length > 0, '推进写了盘，但 a.ts 是空的')
  console.log(`落地读数：盘上的 a.ts ${onDisk.length} 字节 · 推进写了 ${j.advanced?.written.length} 条`)
})

test('命令行那一头的负对照：驱动不在的那一档当场报出来（不是静默交一个空提交）', () => {
  const root = tmpRoot()
  mkdirSync(join(root, 'sub'), { recursive: true })
  const outside = tmpDir('fugue-chain-src-')
  const src = join(outside, 'bottom.txt')
  writeFileSync(src, '底。\n')
  assert.equal(fugue(root, 'write', 'README.md', '--from', src).code, 0)
  assert.equal(fugue(root, 'commit', '-m', '底').code, 0)
  // **一个不存在的协议名**：当场拒 · 退出码 1 · 报出有的那几个（不替它挑一个）。
  const bad = fugue(root, 'assemble', '没有这一份')
  assert.equal(bad.code, 1, `退出码该是 1，实际 ${bad.code}`)
  assert.match(bad.stderr, /没有这一份协议|没有这一份/)
  // **用法错**：退出码 2。
  const usage = fugue(root, 'assemble')
  assert.equal(usage.code, 2, `用法错该退 2，实际 ${usage.code}`)
  console.log(`负对照读数：不认识的协议名 → ${bad.code} · 缺参数 → ${usage.code}`)
})

test('零成本：给 --dump-wire 而这一档不接真驱动时，落盘那一层根本不存在（日志逐条相同）', () => {
  // **这一条是"用户不用 debug 就不为它付成本"的判据。** 两趟完整的打桩轮次（各在自己的 root 里，
  // 所以分支名不冲突）：一趟不给 `--dump-wire`，一趟给。两趟的 `round run --json` 除开各自的
  // 路径之外逐字段相同，而那个 dump 目录里**一个文件都没有**——因为那一层只在 `--live` 下拼。
  const setup = (root: string): void => {
    assert.equal(fugue(root, 'write', 'README.md', '--from', srcOf()).code, 0)
    assert.equal(fugue(root, 'commit', '-m', '底').code, 0)
    assert.equal(fugue(root, 'config', 'set', 'actions.ok', JSON.stringify({ argv: ['/bin/sh', '-c', 'true'], outputs: [] })).code, 0)
    assert.equal(
      fugue(root, 'config', 'set', 'round.assertions', JSON.stringify([{ name: '总是过', action: 'ok', argv: ['/bin/sh', '-c', 'true'] }])).code,
      0,
    )
    assert.equal(
      fugue(
        root,
        'config',
        'set',
        'round.split',
        JSON.stringify([
          { goal: '写一份 a.ts', ownedPaths: ['a.ts'], deliverables: [{ path: 'a.ts', form: '一份文件' }], assertions: [{ name: '总是过', action: 'ok' }] },
        ]),
      ).code,
      0,
    )
  }
  const bare = tmpRoot()
  const withDump = tmpRoot()
  setup(bare)
  setup(withDump)
  const dir = tmpDir('fugue-wire-cli-')

  const a = fugue(bare, '--json', 'round', 'run', '写一份 a.ts', '--report', '--metrics')
  assert.equal(a.code, 0, a.stderr)
  const b = fugue(withDump, '--json', 'round', 'run', '写一份 a.ts', '--report', '--metrics', '--dump-wire', dir)
  assert.equal(b.code, 0, b.stderr)

  // 两趟的读数逐字段相同。两处例外都要写明白：
  //   · `base`：各自那个底（两个 root 各是一个仓库），本来就不同；
  //   · `ms`：验收那几条**跑了多久**——它是真实耗时，两次不可能相同（第一版拿整份 JSON 比，
  //     于是在正确的行为上报红：`exit 0, ms: 5` vs `exit 0, ms: 2`）。
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip)
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'ms').map(([k, x]) => [k, strip(x)]))
    }
    return v
  }
  const ja = JSON.parse(a.stdout) as Record<string, unknown>
  const jb = JSON.parse(b.stdout) as Record<string, unknown>
  for (const k of Object.keys(ja)) {
    if (k === 'base') continue
    assert.deepEqual(strip(jb[k]), strip(ja[k]), `加了 --dump-wire 之后 \`${k}\` 变了`)
  }
  assert.deepEqual(readdirSync(dir), [], `那一层不该被拼出来，却落了：${readdirSync(dir).join(' ')}`)
  assert.equal((jb['metrics'] as unknown[]).length, 8, '八元指标该照旧八条')
  console.log(
    `零成本读数：两趟 round run 的读数逐字段相同（除 base）· dump 目录 ${readdirSync(dir).length} 个文件 · ` +
      `指标 ${(jb['metrics'] as unknown[]).length} 条 · 日志 ${(jb['metrics'] as { metric: string }[]).length ? '有' : '无'}读数`,
  )
})

// ── 真驱动那一档真的发了一次请求：不是"参数收下了就算接上了" ────────────────────
//
// 由头（线上实测）：`--live` 那一趟里 `runRound` 拿到的**恒是打桩那一个驱动**——一次调用都没发，
// 盘上落的是"（打桩）…"，命令面照旧退 0。整条链的取证是"日志里一条 `llm/call` 都没有"。
//
// 这一条**不出网**：凭据给一个假的（那边答 401）。判据落在**这一趟留下的证据**上——
//   · 有一条 `llm/call`（打桩那一档一条都不落）
//   · 那一条带着上游的事实：`status: 401`
//   · 用量四个数全是 `null`（没走完就没有账——"半截的流不是一次调用"）
//   · 而这一趟**没静默地成功**：盘上没有 a.ts（打桩那一档会写它）
test('--live 那一档接的是真驱动：日志里有一条带 401 的 llm/call（打桩那一档一条都不落）', () => {
  const root = tmpRoot()
  const outside = tmpDir('fugue-chain-src-')
  const src = join(outside, 'bottom.txt')
  writeFileSync(src, '底。\n')
  assert.equal(fugue(root, 'write', 'README.md', '--from', src).code, 0)
  assert.equal(fugue(root, 'commit', '-m', '底').code, 0)
  assert.equal(fugue(root, 'config', 'set', 'actions.ok', JSON.stringify({ argv: ['/bin/sh', '-c', 'true'], outputs: [] })).code, 0)
  assert.equal(
    fugue(root, 'config', 'set', 'round.assertions', JSON.stringify([{ name: '总是过', action: 'ok', argv: ['/bin/sh', '-c', 'true'] }])).code,
    0,
  )
  assert.equal(
    fugue(
      root,
      'config',
      'set',
      'round.split',
      JSON.stringify([
        { goal: '写一份 a.ts', ownedPaths: ['a.ts'], deliverables: [{ path: 'a.ts', form: '一份文件' }], assertions: [{ name: '总是过', action: 'ok' }] },
      ]),
    ).code,
    0,
  )
  // **凭据要是 ASCII**：头值是一个 ByteString，非 ASCII 的字符在 `fetch` 那一层就抛
  // （"Cannot convert argument to a ByteString…"）——那样这一条量的就不是"那边答 401"。
  const fake = join(outside, 'fake.key')
  writeFileSync(fake, 'sk-not-a-real-key\n')
  const dump = join(outside, 'wire')
  const r = fugue(root, '--json', 'round', 'run', '写一份 a.ts', '--live', '--credential', fake, '--dump-wire', dump)
  // 一 · 打桩那一档退 0；接了真驱动又碰上一次 401 时，轮次**报成功但推进是空的**（那一步不算干完）。
  assert.equal(r.code, 0, `这一条不判退出码（打桩与 401 都是 0），实际 ${r.code}；stderr：${r.stderr.slice(0, 300)}`)
  // 二 · 证据：agent 日志里那一条 `llm/call`
  const logAt = join(root, '.fugue', 'log', 'agent', 'r1', '1.jsonl')
  assert.ok(existsSync(logAt), `agent 日志不在：${logAt}（打桩那一档会落，只是里面没有 llm/call）`)
  const events = readFileSync(logAt, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  const calls = events.filter((e) => e['t'] === 'llm/call')
  assert.equal(calls.length, 1, `该恰好有一条 llm/call，实际 ${calls.length} 条：${events.map((e) => String(e['t'])).join(' · ')}`)
  const one = calls[0] as { status?: number; invocations?: number; usage?: Record<string, number | null>; model?: string }
  assert.equal(one.status, 401, `那一条 llm/call 上的 status 该是 401（假凭据），实际 ${String(one.status)}`)
  assert.equal(one.invocations, 0)
  assert.deepEqual(Object.values(one.usage ?? {}).filter((v) => v !== null), [], '没走完的调用不该有用量读数')
  assert.equal(one.model, 'deepseek-flash/anthropic', '这一格该走默认模型那条声明')
  // 三 · 没静默地成功：盘上没有 a.ts（真驱动那一档没干完就不产出）。
  assert.equal(existsSync(join(root, 'a.ts')), false, '盘上出现了 a.ts——那说明这一趟不是真驱动那一条路')
  // 四 · **每一格为什么停**（第 5 批 · 疑点 2）：`--json` 里那一栏原先不存在；而这一趟的停因
  //     就在 `stopped` 里——"验收：通过 1"那种话读不出"它其实被 401 掐掉了"。
  const j = JSON.parse(r.stdout) as { agents?: readonly { agent: string; steps: number; stopped: string }[] }
  const stops = j.agents ?? []
  assert.equal(stops.length, 1, `该报出一格，实际 ${stops.length} 格：${r.stdout.slice(0, 300)}`)
  assert.match(stops[0]?.agent ?? '', /^agent\/r1\/1$/, `那一格的 agent 名：${String(stops[0]?.agent)}`)
  assert.match(stops[0]?.stopped ?? '', /401|cut-stream|凭据|认证|Authorization/i, `停因该说清是被上游拒的：${String(stops[0]?.stopped)}`)
  // 五 · **同一句话也落进了这一格自己的日志**（`agent/stop`）：日志是一等档的取证物，而这一栏
  //     原先只能从驱动那一层的返回值里看到（`onResult` 那条路只有测试走）。
  const stopEvents = events.filter((e) => e['t'] === 'agent/stop')
  assert.equal(stopEvents.length, 1, `该恰有一条 agent/stop，实际 ${stopEvents.length} 条`)
  assert.equal(stopEvents[0]?.['stopped'], stops[0]?.stopped, '日志里那句话与 --json 里那一栏该是同一句')
  assert.equal(stopEvents[0]?.['steps'], 1, `那一条该记着走了一步：${String(stopEvents[0]?.['steps'])}`)
  console.log(
    `真驱动读数：llm/call ${calls.length} 条 · status ${String(one.status)} · 用量四个数全 null · ` +
      `model ${String(one.model)} · 停因「${String(stops[0]?.stopped).slice(0, 80)}」 · 盘上没有 a.ts（打桩那一档会写它）`,
  )
})

test('--dump-wire 的守卫：落在工作区里当场拒（并给出两条路）', () => {
  const root = tmpRoot()
  const outside = tmpDir('fugue-chain-src-')
  const src = join(outside, 'bottom.txt')
  writeFileSync(src, '底。\n')
  assert.equal(fugue(root, 'write', 'README.md', '--from', src).code, 0)
  assert.equal(fugue(root, 'commit', '-m', '底').code, 0)
  // 拆分草案要先在配置里（**落点那一条守卫排在凭据之前**，所以这一趟要走到守卫那一行）。
  assert.equal(fugue(root, 'config', 'set', 'actions.ok', JSON.stringify({ argv: ['/bin/sh', '-c', 'true'], outputs: [] })).code, 0)
  assert.equal(
    fugue(root, 'config', 'set', 'round.assertions', JSON.stringify([{ name: '总是过', action: 'ok', argv: ['/bin/sh', '-c', 'true'] }])).code,
    0,
  )
  assert.equal(
    fugue(
      root,
      'config',
      'set',
      'round.split',
      JSON.stringify([
        { goal: '写一份 a.ts', ownedPaths: ['a.ts'], deliverables: [{ path: 'a.ts', form: '一份文件' }], assertions: [{ name: '总是过', action: 'ok' }] },
      ]),
    ).code,
    0,
  )
  // 落在 <root> 里面 → 拒，并指出两条路（物化的底就是真实工作树，落进去会被当成漂移）。
  const bad = fugue(root, 'round', 'run', '写一份 a.ts', '--live', '--dump-wire', join(root, 'wire'))
  assert.equal(bad.code, 1, `该退 1，实际 ${bad.code}`)
  assert.match(bad.stderr, /不许落在工作区里/)
  assert.match(bad.stderr, /换个工作区之外的目录/)
  // 而工作区之外的那一份走到"凭据读不到"那一档（**没有真出网**）。
  // 凭据**显式**指一条读不到的路：机器上恰好放了一份真凭据时，这一条原先会真出网（实测退 0）。
  const nowhere = join(outside, '没有这一份.key')
  const ok = fugue(root, 'round', 'run', '写一份 a.ts', '--live', '--credential', nowhere, '--dump-wire', join(outside, 'wire'))
  assert.equal(ok.code, 1, `该退 1（凭据不在），实际 ${ok.code}`)
  assert.match(ok.stderr, /凭据不在/)
  console.log(`守卫读数：工作区里 → "${bad.stderr.split('\n')[0]}" · 工作区外 → "${ok.stderr.split('\n')[0].slice(0, 60)}"`)
})

// ── 序 1 · 回放档（`--wire-in`）：录下来的那一趟喂回去 ────────────────────────────
//
// 由头（架构 § 10.5 的录制夹具 · PLAN § 5.8 的口径一"验收不押在网络上"）：整条链的验收原先只能
// 在真档上量一次（花钱 · 依赖网），而 `--dump-wire` 已经把"发出去与收回来"的字节留在了盘上。
// 回放那一档把那一趟**喂回去**——同一条链于是在套件里跑得出来，而**一次 `fetch` 都没有**：
// 传输换成了读目录（`wireInTransport`），按录下来的请求字节核。
//
// 夹具是**真响应**（`src/cli/__fixture__/wire-in/`·录的那一趟：`写一份 notes.md` · 一格 ·
// `--max-steps 4` · 三份调用 · 停因**收敛**）。`scenario.json` 是录制那个工作区的全部输入——
// 回放要照着搭同一个工作区，工作区不同则前缀不同，而前缀不同就会当场拒（这正是它该有的牙）。
const WIRE_IN_DIR = fileURLToPath(new URL('./__fixture__/wire-in/', import.meta.url))

interface WireScenario {
  goal: string
  maxSteps: number
  assertions: unknown[]
  split: unknown[]
  base: { path: string; text: string }[]
  expected: Record<string, string>
}

function scenarioOf(): WireScenario {
  return JSON.parse(readFileSync(join(WIRE_IN_DIR, 'scenario.json'), 'utf8')) as WireScenario
}

/** 夹具里那几份调用的目录名（`call-0001` …），按发生次序。 */
const WIRE_CALLS = readdirSync(join(WIRE_IN_DIR, 'wire')).sort()

/**
 * 收尾：**用产品那一份**（`clearMaterialization` · `removeTree`），不自己 `rmSync`。
 *
 * 由头（W8 起就立在那儿，`mount.ts` 的注释与 `driver.test.ts` 的 `close()` 都记着）：真驱动
 * 那一档的 `bash` 会把物化树挂起来（overlayfs），卸载之后内核在 `tmp/work/` 里留一个
 * `root:root 000` 的 `work/work`——`fs.rmSync` 会先 `readdir` 每个目录，于是在它上面吃
 * `EACCES`（实测：这一条测试第一版就是这么红的，而且**测试红在收尾上**）。`removeTree` 先
 * `rmdir` 再往下走，绕过这一处。**回放那一档照旧挂树**（它跑的是真驱动，只是传输换了）。
 */
function wireCleanup(root: string): void {
  const p = matParts(root as never, 'agent/r1/1' as never)
  clearMaterialization(p.merged, [p.upper, p.merged, p.temp])
  removeTree(root as never)
}

/**
 * 照录制那一趟搭一份工作区：底那几份文件 + 一个提交 + 那三条配置。
 *
 * **别的键一条都不设**：`系统状态` 那一段照 `EXPOSED` 那几栏投影，多设一条 A 区的字节就变了，
 * 而 A 区一变回放当场拒（那是对的——夹具绑的就是录制那一版的字节）。
 */
function wireRoot(s: WireScenario): string {
  const root = tmpRoot()
  for (const f of s.base) {
    mkdirSync(dirname(join(root, f.path)), { recursive: true })
    writeFileSync(join(root, f.path), f.text)
  }
  const git = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, `git ${args.join(' ')} 退了 ${String(r.status)}：${r.stderr}`)
  }
  git('symbolic-ref', 'HEAD', 'refs/heads/main')
  git('config', 'user.email', 'fugue@localhost')
  git('config', 'user.name', 'fugue')
  git('add', '-A')
  git('commit', '-qm', '底')
  assert.equal(fugue(root, 'config', 'set', 'round.id', 'r1').code, 0)
  assert.equal(fugue(root, 'config', 'set', 'round.assertions', JSON.stringify(s.assertions)).code, 0)
  assert.equal(fugue(root, 'config', 'set', 'round.split', JSON.stringify(s.split)).code, 0)
  return root
}

test('序 1 · `--wire-in` 把真响应喂回去：验收照过 · 产物逐字节相同 · 每一条调用逐条对上（不出网 · 不读凭据）', async () => {
  const s = scenarioOf()
  const root = wireRoot(s)
  const dump = tmpDir('fugue-wire-in-out-')
  // **环境里没有凭据**（`fugue()` 只留 `PATH` 与 `HOME`），也没有 `--credential`：这一档不取凭据。
  const run = fugue(
    root,
    '--json',
    'round',
    'run',
    s.goal,
    '--wire-in',
    join(WIRE_IN_DIR, 'wire'),
    '--max-steps',
    String(s.maxSteps),
    '--report',
    '--metrics',
    '--dump-wire',
    dump,
  )
  assert.equal(run.code, 0, `回放那一趟退了 ${run.code}：${run.stderr}`)
  const j = JSON.parse(run.stdout) as {
    verify: { pass: number; fail: number; unrunnable: number; ok: boolean }
    advanced: { written: string[]; removed: string[]; skipped: string[] } | null
    agents: { agent: string; steps: number; stopped: string }[]
    metrics: unknown[]
  }
  // 验收照过（录的那一趟是 2 条断言），而且真的推进了。
  assert.equal(j.verify.ok, true, `验收没过：${JSON.stringify(j.verify)}`)
  assert.equal(j.verify.pass, s.assertions.length, `通过 ${j.verify.pass} 条，录的那一趟是 ${s.assertions.length} 条`)
  assert.equal(j.verify.fail, 0)
  assert.ok(j.advanced !== null, '验收过了却没推进')

  // 产物：**逐字节等于录下来的那一趟**（`expected` 那一栏就是录制时盘上那一份）。
  for (const [path, text] of Object.entries(s.expected)) {
    assert.equal(readFileSync(join(root, path), 'utf8'), text, `${path} 与录下来的那一趟不同`)
  }

  // 每一条调用逐条对上：**这一趟真的发出去的请求**与录下来的那一份逐字节相同（`requestHash`），
  // **喂回去的响应**也与录下来的那一份相同（`responseHash`）。
  const again = readdirSync(dump).sort()
  assert.deepEqual(again, WIRE_CALLS, `回放重录的份数与夹具不同：${again.join(' ')} vs ${WIRE_CALLS.join(' ')}`)
  for (const c of WIRE_CALLS) {
    const mine = JSON.parse(readFileSync(join(dump, c, 'meta.json'), 'utf8')) as Record<string, unknown>
    const kept = JSON.parse(readFileSync(join(WIRE_IN_DIR, 'wire', c, 'meta.json'), 'utf8')) as Record<string, unknown>
    assert.equal(mine['requestHash'], kept['requestHash'], `${c}：这一趟发出去的请求与录下来的不是同一份`)
    assert.equal(mine['requestBytes'], kept['requestBytes'], `${c}：请求字节数不同`)
    assert.equal(mine['responseHash'], kept['responseHash'], `${c}：喂回去的响应与录下来的不是同一份`)
    assert.equal(mine['stop'], kept['stop'], `${c}：停因不同`)
  }

  // **写入面那一句真的发出去了**（架构 § 8.12 · 计划 § 5.10 那一格）：它由契约投影进 B 区
  // （`declaredSetOf`），与执行侧 `writeScope` · 回收那一侧读的是同一个集合。这一条只能落在这
  // 一串字节上——把投影拆掉之后**重录也遮不住**（重录出来的请求里没有这一句），而只核指纹的
  // 回放档只会说"这一份不是那一次请求"。
  const sent = readFileSync(join(WIRE_IN_DIR, 'wire', WIRE_CALLS[0] as string, 'request.json'), 'utf8')
  assert.match(sent, /Write surface: notes\.md — these paths are yours/, `发出去的请求里没有写入面那一句：${sent.slice(0, 200)}`)
  assert.match(sent, /Do not change a single byte anywhere else, deleting included/, '写入面那一句少了"删除也算"那半句')

  // **这一趟的围栏落进了日志**（第十五趟样本盘那条缝的封口）：`bash` 是这一格伸出去的那只手，
  // 而"伸出去看得见什么"以前在日志里一个字都没有——账上于是分不开"模型自己解出来的"与
  // "它翻到了我们的账本"。录的那一趟有一次 `bash`，所以这一条同时量着两件事：**它真的起了
  // 子进程**，而那一趟的围栏是 `full`（挂载层在场 · 账本与答案纸在它够不着的地方）。
  const log = openLog(root)
  const rows = await Array.fromAsync(log.readMerged())
  await log.close()
  const fences = rows
    .filter((r) => (r as { e?: { t?: string } }).e?.t === 'run/confined')
    .map((r) => (r as unknown as { e: { mode: string; enforcement: string; layers?: readonly string[]; reach?: readonly string[] } }).e) as {
    mode: string
    enforcement: string
    layers?: readonly string[]
    reach?: readonly string[]
  }[]
  assert.ok(fences.length > 0, '录的那一趟调过一次 bash，日志里该有它那一条围栏')
  assert.equal(fences[0]?.enforcement, 'full', `这一趟的围栏不是 full：${JSON.stringify(fences[0])}`)
  assert.deepEqual([...(fences[0]?.layers ?? [])], ['bwrap', 'landlock'], '两层都在场才是看得见什么那一维关着')
  assert.equal(fences[0]?.mode, 'workspace-write', '这一格点名要的是树可写那一档')
  assert.equal((fences[0]?.reach ?? []).length, 6, '只读根清单就是策略值里那一份（缺省 6 条）')

  // 停因：**收敛**（`end-turn`）——不是"步数到顶"。这一条同时是 § 5.12 序 12 那三句收工口径的读数。
  const one = j.agents[0]
  assert.ok(one !== undefined, `这一趟没落停因：${JSON.stringify(j.agents)}`)
  assert.equal(one.stopped, '收敛', `停因是「${one.stopped}」（录的那一趟是 3 步收敛）`)
  wireCleanup(root)
  console.log(
    `序 1 读数：回放 ${WIRE_CALLS.length} 条调用 · 逐条 requestHash/responseHash 相同 · 验收 ${j.verify.pass}/${j.verify.fail} · ` +
      `停因「${one.stopped}」· 产物 ${Object.keys(s.expected).join(' ')} 逐字节相同 · 一次 fetch 都没有 · ` +
      `围栏 ${fences[0]?.enforcement}（${(fences[0]?.layers ?? []).join('+')}）`,
  )
})

test('序 1 负对照：夹具里第一份 `request.json` 改一个字节 → 当场拒（这一份不是那一次请求）', () => {
  const s = scenarioOf()
  const bad = tmpDir('fugue-wire-in-bad-')
  cpSync(join(WIRE_IN_DIR, 'wire'), join(bad, 'wire'), { recursive: true })
  const at = join(bad, 'wire', WIRE_CALLS[0] as string, 'request.json')
  const bytes = readFileSync(at)
  // 改**一个字节**（不是整份换掉）：`meta.json` 里那 16 个字符与它对不上。
  bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b
  writeFileSync(at, bytes)

  const root = wireRoot(s)
  const dump = tmpDir('fugue-wire-in-bad-out-')
  const run = fugue(
    root,
    '--json',
    'round',
    'run',
    s.goal,
    '--wire-in',
    join(bad, 'wire'),
    '--max-steps',
    String(s.maxSteps),
    '--dump-wire',
    dump,
  )
  const j = JSON.parse(run.stdout) as {
    verify: { pass: number; fail: number; ok: boolean }
    agents: { agent: string; steps: number; stopped: string }[]
  }
  // 一 · **当场拒**：那句话落在这一格的停因上（`cut-stream：回放档：… 被改过`）。
  const one = j.agents[0]
  assert.ok(one !== undefined, `这一趟没落停因：${JSON.stringify(j.agents)}`)
  assert.match(one.stopped, /回放档：.*被改过/, `停因里没有拒的那句话：「${one.stopped}」`)
  assert.match(one.stopped, /这一份取证物被改过|不是那一次请求/, `拒的话没指得出路：「${one.stopped}」`)
  assert.equal(one.steps, 1, `拒在第 1 次调用上，而这一格走了 ${one.steps} 步`)
  // 二 · **拒在发出去之前**：夹具里后面那几份一次都没被读（这一趟只有第 1 次调用落了取证物）。
  //     那一份照旧落下来（`--dump-wire` 的纪律：**失败那一路也落**），而它是 `failed` 档。
  assert.deepEqual(readdirSync(dump), [WIRE_CALLS[0]], `落下来的份数不对：${readdirSync(dump).join(' ')}`)
  const bad1 = JSON.parse(readFileSync(join(dump, WIRE_CALLS[0] as string, 'meta.json'), 'utf8')) as Record<string, unknown>
  assert.equal(bad1['outcome'], 'failed', `那一份的 outcome 是 ${String(bad1['outcome'])}`)
  assert.match(String(bad1['failure']), /回放档：/, `那一份的 failure 没写清为什么：${String(bad1['failure'])}`)
  assert.equal(existsSync(join(root, 'notes.md')), false, '那一趟被拒了，盘上却落了产物')
  // 三 · **验收因此不过**，而退出码由验收定（`round run` 的口径：验收是唯一的判据）。
  assert.equal(j.verify.ok, false, `被拒了验收却是过的：${JSON.stringify(j.verify)}`)
  assert.equal(j.verify.pass, 0)
  assert.notEqual(run.code, 0, '验收没过，退出码却是 0')
  wireCleanup(root)
  console.log(
    `序 1 负对照读数：${String(WIRE_CALLS[0])}/request.json 改一个字节 → 退 ${run.code} · 验收 ${j.verify.pass} · ` +
      `这一格走了 ${one.steps} 步就停 · 落下来的那一份是 ${String(bad1['outcome'])} 档`,
  )
})

// ── C4 · 放行（`round go`）：门停着时不发契约 · 放行逐条发 · 同号的新一批照样重停 ──────────
//
// 由头（架构 § 15.1.a 的"判 / 停 / 派"）：`round plan` 把草案判成一批契约值**停在门口**，一个字节
// 都不发；`round go` 才逐条 `contract/issue`、起分支、把处境推到 `Working`。
//
// **口径**：放行只兑现**这一批**——下一个轮次拆出来的那一批哪怕与这一批同一个批号（编号算的是
// 拆分的形状），也照样停在门口等人再点一次头。编号是给人看的一个名字，不是放行过的凭证。
const DRAFT_SECTION = {
  kind: 'implement',
  goal: '写一份 a.ts',
  ownedPaths: ['a.ts'],
  deliverables: [{ path: 'a.ts', form: '一份文件' }],
  assertions: [{ name: '总是过', action: 'ok' }],
  seed: [],
}

/** 一份草案的正文：一个任务一节（标 `json` 的围栏块）——与持轮者写的是同一个形状。 */
function draftMd(over: Partial<typeof DRAFT_SECTION> = {}): string {
  return ['## 一 · 写 a.ts', '', '```json', JSON.stringify({ ...DRAFT_SECTION, ...over }, null, 2), '```'].join('\n')
}

/** 轮级日志（`.fugue/log/round.jsonl`）里全部事件，按写入次序。 */
function logEvents(root: string): Record<string, unknown>[] {
  const at = join(root, '.fugue', 'log', 'round.jsonl')
  if (!existsSync(at)) return []
  return readFileSync(at, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** 盘上那几条分支（`for-each-ref`：分支头是 git 那一侧的事实，不是我们记的账）。 */
function refsOf(root: string): string[] {
  const r = spawnSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.split('\n').filter((l) => l !== '').sort()
}

test('C4 · round go：不放行一个契约都不发 · 放行逐条发 · 同一个批号的新一批照样重停', () => {
  const root = tmpRoot()
  const outside = tmpDir('fugue-go-src-')
  const bottom = join(outside, 'bottom.txt')
  writeFileSync(bottom, '底。\n')
  assert.equal(fugue(root, 'write', 'README.md', '--from', bottom).code, 0)
  assert.equal(fugue(root, 'commit', '-m', '底').code, 0)
  // 动作绑定：草案里那条断言要从这张表里选（门核这一条：没绑的名字当场退回）。
  assert.equal(fugue(root, 'config', 'set', 'actions.ok', JSON.stringify({ argv: ['/bin/sh', '-c', 'true'], outputs: [] })).code, 0)
  const draftAt = join(outside, 'r1.md')
  writeFileSync(draftAt, draftMd())
  // **草案写进持轮者的视图**（人写那一档）：`round plan --judge` 拿视图里那一份直接判，不跑模型。
  const wrote = fugue(root, 'write', '.fugue/plan/r1.md', '--from', draftAt)
  assert.equal(wrote.code, 0, `把草案写进视图那一趟退了 ${wrote.code}：${wrote.stderr}`)

  // ── 判：停在门口 ────────────────────────────────────────────────────────────
  const plan = fugue(root, '--json', 'round', 'plan', '写一份 a.ts', '--judge')
  assert.equal(plan.code, 0, `round plan 退了 ${plan.code}：${plan.stderr}`)
  const pj = JSON.parse(plan.stdout) as { held: boolean; contracts: unknown[]; fingerprint: string | null; sameAs: string | null }
  assert.equal(pj.held, true, `草案该停在门口：${plan.stdout.slice(0, 300)}`)
  assert.equal(pj.contracts.length, 1)
  assert.match(pj.fingerprint ?? '', /^[0-9a-f]{16}$/, `判那一趟该给出这一批的编号：${plan.stdout.slice(0, 300)}`)
  assert.equal(pj.sameAs, null, '第一次放行之前没有"同号的那一批"')

  const stopped = logEvents(root)
  assert.equal(stopped.some((e) => e['t'] === 'contract/issue'), false, '还没放行就发了契约')
  assert.equal(stopped.some((e) => e['t'] === 'round/approve'), false, '还没放行就有放行那一笔')
  assert.deepEqual(refsOf(root).filter((r) => r.includes('agent/')), [], '还没放行就起了分支')

  // ── 放行 ────────────────────────────────────────────────────────────────────
  const go = fugue(root, '--json', 'round', 'go')
  assert.equal(go.code, 0, `round go 退了 ${go.code}：${go.stderr}`)
  const gj = JSON.parse(go.stdout) as {
    round: string
    base: string
    fingerprint: string
    contracts: unknown[]
    trail: { from: string; on: string; to: string }[]
  }
  // **轮次那一栏**：人面那一行的第一栏就是它（`--json` 漏了它的时候那一栏印的是 `undefined`）。
  assert.equal(gj.round, 'r1', `round go --json 没给出轮次号：${go.stdout.slice(0, 200)}`)
  assert.equal(gj.fingerprint, pj.fingerprint, '放行那一趟算出来的批号与判那一趟不同——那不是同一批')
  assert.deepEqual(
    gj.trail.map((t) => `${t.from} ──${t.on}──> ${t.to}`),
    ['Planning ──contracts-issued──> Delegated', 'Delegated ──branches-started──> Working'],
    '放行那一趟走过的边与图上对不上',
  )
  const after = logEvents(root)
  assert.equal(after.filter((e) => e['t'] === 'contract/issue').length, gj.contracts.length, '契约没有逐条落')
  assert.equal(after.filter((e) => e['t'] === 'round/approve').length, 1, '放行那一笔该恰好一条')
  assert.equal(
    after.filter((e) => e['t'] === 'round/state' && e['from'] === 'Planning' && e['to'] === 'Delegated').length,
    1,
    'Planning → Delegated 该恰好一条',
  )
  assert.deepEqual(refsOf(root).filter((r) => r.includes('agent/')), ['refs/heads/agent/r1/1'], '分支没起、或者起的不对')

  // ── 再跑一次：不重复触发（当场拒 · 日志一条不增）────────────────────────────────
  const again = fugue(root, 'round', 'go')
  assert.equal(again.code, 1, `第二次放行该退 1，实际 ${again.code}`)
  assert.match(again.stderr, /这一轮的处境是 Working/)
  assert.match(again.stderr, /已经发过了/)
  assert.equal(logEvents(root).length, after.length, '第二次放行落了事件')

  // ── 第二轮：同一份草案 → 同一个批号 → **照样停在门口** ──────────────────────────
  assert.equal(fugue(root, 'config', 'set', 'round.id', 'r2').code, 0)
  const draft2At = join(outside, 'r2.md')
  writeFileSync(draft2At, draftMd())
  assert.equal(fugue(root, 'write', '.fugue/plan/r2.md', '--from', draft2At).code, 0)
  const plan2 = fugue(root, 'round', 'plan', '写一份 a.ts', '--judge')
  assert.equal(plan2.code, 0, `第二轮 round plan 退了 ${plan2.code}：${plan2.stderr}`)
  const m = /批号：([0-9a-f]{16})/.exec(plan2.stdout)
  assert.ok(m !== null, `判那一趟没印批号：${plan2.stdout.slice(0, 400)}`)
  assert.equal(m[1], pj.fingerprint, '同一份草案该给同一个批号')
  assert.match(plan2.stdout, /与你在 r1 放过的那一批同号/, '同号那一档该说出来（而它不作数）')
  const round2 = logEvents(root).filter((e) => e['round'] === 'r2')
  assert.equal(round2.filter((e) => e['t'] === 'contract/issue').length, 0, '同号就照上次放行了——那是要禁止的那一件事')
  assert.equal(round2.filter((e) => e['t'] === 'round/approve').length, 0, '同号就有放行那一笔了')
  console.log(
    `C4 读数：判那一趟停着时 contract/issue 0 条 · 放行后 ${gj.contracts.length} 条 + round/approve 1 条 · ` +
      `分支 ${refsOf(root).filter((r) => r.includes('agent/')).join(' ')} · 第二次放行退 ${again.code}（日志一条不增）· ` +
      `第二轮同一批号 ${m[1]} 照样停在门口`,
  )
})

// ── 序 15 · 打回缺省回一次：不给 `--retry` 走 1（回边）· `--retry 0` 才"一遍都不重来" ──────────
//
// 出处：架构 § 8.13（「重试上界的缺省是 1」）· 计划 § 5.12 的序 15。两条路都让验收不过
// （`--fail` 把那条断言换成 `exit 1`），差别只有 `--retry`。
//
// **读数落在 `round/state` 那一条链上**（就是 `probe/round.ts` 数打回次数的那一处）：
// `Verifying → Working` 是回边那一笔，`Verifying → Aborted` 是超界那一笔。判的是"哪一条 · 几条"。
// 今天这一条命令**不真的重跑失败的那几支**（重跑要重新派发，归 A4 起头那一段），所以"第二遍才
// `Aborted`"这一半量在状态机那一处（`machine.test.ts` 的 `RETRY_DEFAULT` 那三条）。
test('序 15 · 打回：不给 --retry 回一次（Verifying → Working）· --retry 0 直接 Aborted', () => {
  const stateEdges = (root: string): string[] =>
    logEvents(root)
      .filter((e) => e['t'] === 'round/state')
      .map((e) => `${String(e['from'])} → ${String(e['to'])}`)

  const setup = (root: string): void => {
    assert.equal(fugue(root, 'write', 'README.md', '--from', srcOf()).code, 0)
    assert.equal(fugue(root, 'commit', '-m', '底').code, 0)
    assert.equal(fugue(root, 'config', 'set', 'actions.ok', JSON.stringify({ argv: ['/bin/sh', '-c', 'true'], outputs: [] })).code, 0)
    assert.equal(
      fugue(root, 'config', 'set', 'round.assertions', JSON.stringify([{ name: '总是过', action: 'ok', argv: ['/bin/sh', '-c', 'true'] }])).code,
      0,
    )
    assert.equal(
      fugue(
        root,
        'config',
        'set',
        'round.split',
        JSON.stringify([
          { goal: '写一份 a.ts', ownedPaths: ['a.ts'], deliverables: [{ path: 'a.ts', form: '一份文件' }], assertions: [{ name: '总是过', action: 'ok' }] },
        ]),
      ).code,
      0,
    )
  }

  // 一 · 不给 `--retry`：验收不过 → **回边一笔**，没有超界那一笔。
  const bare = tmpRoot()
  setup(bare)
  const a = fugue(bare, '--json', 'round', 'run', '写一份 a.ts', '--fail', '总是过')
  assert.equal(a.code, 1, `验收没过该退 1，实际 ${a.code}：${a.stderr.slice(0, 200)}`)
  const ja = JSON.parse(a.stdout) as { state: string; verify: { ok: boolean; fail: number } }
  assert.equal(ja.verify.ok, false, `这一条要的是一趟不过的验收：${JSON.stringify(ja.verify)}`)
  assert.equal(ja.verify.fail, 1)
  const edgesBare = stateEdges(bare)
  assert.equal(
    edgesBare.filter((e) => e === 'Verifying → Working').length,
    1,
    `缺省那一档该恰好走一次回边，实际：${edgesBare.join(' · ')}`,
  )
  assert.equal(edgesBare.filter((e) => e.endsWith('Aborted')).length, 0, `缺省那一档不该中止：${edgesBare.join(' · ')}`)
  assert.equal(ja.state, 'Working', `那一趟的终点该是 Working（等着再干一遍），实际 ${ja.state}`)

  // 二 · `--retry 0`：一次都不回，直接 `Aborted`。
  const zero = tmpRoot()
  setup(zero)
  const b = fugue(zero, '--json', 'round', 'run', '写一份 a.ts', '--fail', '总是过', '--retry', '0')
  assert.equal(b.code, 1, `验收没过该退 1，实际 ${b.code}：${b.stderr.slice(0, 200)}`)
  const jb = JSON.parse(b.stdout) as { state: string; verify: { ok: boolean } }
  assert.equal(jb.verify.ok, false)
  const edgesZero = stateEdges(zero)
  assert.equal(
    edgesZero.filter((e) => e === 'Verifying → Aborted').length,
    1,
    `--retry 0 该直接中止，实际：${edgesZero.join(' · ')}`,
  )
  assert.equal(edgesZero.filter((e) => e === 'Verifying → Working').length, 0, `--retry 0 却走了回边：${edgesZero.join(' · ')}`)
  assert.equal(jb.state, 'Aborted', `--retry 0 那一趟的终点该是 Aborted，实际 ${jb.state}`)

  console.log(
    `序 15 读数：不给 --retry → ${edgesBare.join(' · ')}（终点 ${ja.state}）· ` +
      `--retry 0 → ${edgesZero.join(' · ')}（终点 ${jb.state}）`,
  )
})

/** `--dump-wire` 落下来的那一份是**发出去的字节**（线协议那一层），不是内部的 `ModelRequest`。 */
function messagesOf(request: string): readonly { role: string; content: string }[] {
  const body = JSON.parse(request) as { messages?: readonly { role: string; content: string }[] }
  return body.messages ?? []
}

// ── C5 · 讨论态那一句话（`fugue say`）：从命令行走一遍 ─────────────────────────────
//
// 由头（B7.5 那一课：294 条单测全绿而命令是坏的）：这一条量的是**接口之间接上了没有**——人那
// 一句话从命令行进来，**当场**记进这一轮的会话记录，并且**发出去的请求字节里就有它**。
//
// **不出网**：传输换成空回放目录（当场拒），而拒之前那一份请求已经落盘（`--dump-wire` 落的
// 就是真发出去的那一份）——C5 的第一条断言（"每一步都读得到它"）于是在命令行这一头也量得到。
// 「讨论不落地」量在 `round/state` 那一条链上：讨论态走完照旧是 `Idle`，一条都没有。
test('C5 · `fugue say` 讨论态：那句话进记录 · 进请求字节 · 讨论不落地', () => {
  const root = tmpRoot()
  assert.equal(fugue(root, 'write', 'README.md', '--from', srcOf()).code, 0)
  assert.equal(fugue(root, 'commit', '-m', '底').code, 0)
  const outside = tmpDir('fugue-say-')
  const empty = join(outside, '空夹具')
  mkdirSync(empty, { recursive: true })
  const dump = join(outside, 'wire')

  // 空话当场拒（**用法错退 2**：这条命令行本身就不成立——那句话是这一趟的输入）。
  // 日志里原先那几条是 `write` 与 `commit` 落的，所以这里量的是**这一趟一条都没增**。
  const zero = logEvents(root).length
  const blank = fugue(root, 'say', '   ')
  assert.equal(blank.code, 2, `空话该退 2，实际 ${blank.code}：${blank.stderr.slice(0, 200)}`)
  assert.match(blank.stderr, /say 需要 <一句话>/)
  assert.equal(logEvents(root).length, zero, '空话那一趟往日志里写了东西')

  const sentence = '第二节也要拆'
  const r = fugue(root, 'say', sentence, '--wire-in', empty, '--dump-wire', dump)
  assert.equal(r.code, 1, `这一趟没有凝聚理解该退 1，实际 ${r.code}：${r.stderr.slice(0, 300)}`)
  assert.match(r.stdout, /讨论态/, `这一趟该报讨论态：${r.stdout.slice(0, 300)}`)
  assert.match(r.stdout, /它进的是这一趟的尾端（C 区第一条）/, r.stdout.slice(0, 400))
  assert.match(r.stdout, /凝聚：这一趟没落下新的那一段/, r.stdout.slice(0, 400))

  // 一 · **记录**：那一句话当场进这一轮的会话记录（读回来是视图里那一份，真实工作树里没有它）。
  const back = fugue(root, 'read', '.fugue/session/r1.jsonl')
  assert.equal(back.code, 0, `会话记录读不回来：${back.stderr.slice(0, 200)}`)
  assert.equal(back.stdout, `{"who":"人","text":"${sentence}"}\n`, `记录里那一条不对：${JSON.stringify(back.stdout)}`)
  assert.equal(existsSync(join(root, '.fugue', 'session')), false, '会话记录落进了真实工作树')

  // 二 · **发出去的字节**：`--dump-wire` 落下来的那一份请求里有它。
  const request = readFileSync(join(dump, 'call-0001', 'request.json'), 'utf8')
  assert.ok(request.includes(sentence), `落下来那一份请求里没有那句话：${request.slice(0, 300)}`)
  // 而**那一句单独成一条消息**（C 区那一段的头就是它）：只判"字节里有那句话"钉不住这一处——
  // 讨论态里 B 区那一段投影（最近几次原文）也带着那句话。负对照实测：把 `cZoneHeadOf` 抹空，
  // 只判字节那一条照旧绿，加上这一条才红。
  assert.ok(
    messagesOf(request).some((m) => m.content === sentence),
    `落下来那一份请求里没有"那一句单独成一条消息"（C 区那一段头）：${request.slice(0, 400)}`,
  )

  // 三 · **讨论不落地**：处境没动（一条 `round/state` 都没有），也没有凝聚理解。
  const events = logEvents(root)
  assert.equal(events.filter((e) => e['t'] === 'round/state').length, 0, '讨论那一趟落了 round/state')
  assert.equal(events.filter((e) => e['t'] === 'holder/distill').length, 0, '一步就失败那一档却落了凝聚理解')
  // 四 · **原话不进日志正文**（日志是一等档的取证物；原话走视图那条路）。
  assert.equal(
    readFileSync(join(root, '.fugue', 'log', 'round.jsonl'), 'utf8').includes(sentence),
    false,
    '那句话进了日志正文',
  )
  console.log(
    `C5 讨论态读数：退 ${r.code} · 记录 1 条 · 落下来那一份请求里有那句话 · ` +
      `round/state 0 条 · holder/distill 0 条 · 日志正文里 0 次`,
  )
})

// ── C5 · 预备态那一句话（`fugue say`）：改的是那份草案 · 原话不另存 ─────────────────
//
// 两态的差别（架构 § 15.1.a）：讨论态的产物是**那场对话的凝聚**，预备态的产物是**那份草案
// 文件**。所以这一条判的是"原话不另存"：预备态里**没有**会话记录这一份东西，而那句话照旧
// 在发出去的请求字节里（C 区第一条）。
test('C5 · `fugue say` 预备态：那句话进请求字节 · 原话不另存 · 处境照旧 Planning', () => {
  const root = tmpRoot()
  assert.equal(fugue(root, 'write', 'README.md', '--from', srcOf()).code, 0)
  assert.equal(fugue(root, 'commit', '-m', '底').code, 0)
  assert.equal(fugue(root, 'config', 'set', 'actions.ok', JSON.stringify({ argv: ['/bin/sh', '-c', 'true'], outputs: [] })).code, 0)
  const outside = tmpDir('fugue-say-pre-')
  const draftAt = join(outside, 'r1.md')
  writeFileSync(draftAt, draftMd())
  // **草案写进持轮者的视图**（人写那一档）：`round plan --judge` 拿视图里那一份直接判。
  assert.equal(fugue(root, 'write', '.fugue/plan/r1.md', '--from', draftAt).code, 0)
  const plan = fugue(root, 'round', 'plan', '写一份 a.ts', '--judge')
  assert.equal(plan.code, 0, `round plan 退了 ${plan.code}：${plan.stderr.slice(0, 300)}`)
  const before = logEvents(root)

  const empty = join(outside, '空夹具')
  mkdirSync(empty, { recursive: true })
  const dump = join(outside, 'wire')
  const sentence = '第二节也要拆，别只动第一节'
  const r = fugue(root, 'say', sentence, '--wire-in', empty, '--dump-wire', dump)
  // 半截流那一趟**没改出新的草案**，视图里那一份仍旧是 v1，于是门照旧停着——**退 0**（放行是
  // `round go` 那一趟的事）。
  assert.equal(r.code, 0, `门停着那一档该退 0，实际 ${r.code}：${r.stderr.slice(0, 300)}`)
  assert.match(r.stdout, /预备态/, `这一趟该报预备态：${r.stdout.slice(0, 300)}`)
  assert.match(r.stdout, /判：仍然停在门口/, r.stdout.slice(0, 400))
  assert.match(r.stdout, /这一趟改的是它（原话不另存：工作区里找不到第二份）/, r.stdout.slice(0, 400))

  // 四 · **人面印第几版与差异**（C5.b · PLAN § 5.12 那一行）：这一趟落的是与上一趟**逐字节相同**
  // 的那一版——号是内容的号（重落同一版不涨号），落地次数照数（判那一趟第 1 次，这一趟第 2 次）。
  assert.match(
    r.stdout,
    /版本：第 1 版（这一轮第 2 次落地）\t与上一趟逐字节相同/,
    r.stdout.slice(0, 500),
  )

  // 一 · 那句话**在发出去的请求字节里**，而且是**单独成一条消息**的那一段头（C 区第一条：
  // 这一步之后的每一步都读得到它）。预备态里 B 区那一段投影是空的，所以这一条也能钉住它。
  const request = readFileSync(join(dump, 'call-0001', 'request.json'), 'utf8')
  assert.ok(request.includes(sentence), '落下来那一份请求里没有那句话')
  assert.ok(
    messagesOf(request).some((m) => m.content === sentence),
    `落下来那一份请求里没有"那一句单独成一条消息"（C 区那一段头）：${request.slice(0, 400)}`,
  )

  // 二 · **原话不另存**：预备态里没有会话记录这一份东西。
  assert.equal(fugue(root, 'read', '.fugue/session/r1.jsonl').code, 1, '预备态里落了一份会话记录')

  // 三 · 处境照旧：只走过那一条 `Idle → Planning`，一个契约都没发，也没有新的那一版。
  const after = logEvents(root)
  assert.deepEqual(
    after.filter((e) => e['t'] === 'round/state').map((e) => `${String(e['from'])} → ${String(e['to'])}`),
    ['Idle → Planning'],
    '预备态那一趟动了处境',
  )
  assert.equal(after.filter((e) => e['t'] === 'contract/issue').length, 0, '门停着却发了契约')
  // 「它改出了新的一版」的证据是**正文不同**，不是"日志里多了一条"：预备态每一趟都把草案正文
  // 落进 `holder/distill`（C1 的口径 · 正文跟着事件进日志），所以半截流那一趟照旧落一条，
  // 而它与上一条**指纹相同**。
  const one = before.filter((e) => e['t'] === 'holder/distill')
  const two = after.filter((e) => e['t'] === 'holder/distill')
  assert.equal(one.length, 1, `判那一趟该落一条草案正文，实际 ${one.length} 条`)
  assert.equal(new Set(two.map((e) => String(e['digest']))).size, 1, `这一趟改出了新的一版：${two.map((e) => String(e['digest'])).join(' · ')}`)
  assert.equal(two.at(-1)?.['digest'], one[0]?.['digest'], '最后那一条草案的指纹变了')
  console.log(
    `C5 预备态读数：退 ${r.code} · 请求里有那句话 · 会话记录 0 份（原话不另存）· ` +
      `round/state 1 条（Idle → Planning）· contract/issue 0 条 · holder/distill 指纹未变`,
  )
})

// ── C5.b · `--json` 那一栏与人面印的是同一张读数（PLAN § 5.12 的 C5.b「与 `--json` 那两栏同源」）──
//
// C5.b 落地时只做了人面（三处打印），`--json` 那两栏一直空着——这一条量的是"同源"：**同一份处境
// 下，两个渲染器给出的号 · 落地次数 · 同否 · 差异逐字对得上**。
//
// **两个靶子**：`--json` 与不带它在同一份日志上会各自多落一版，所以两个靶子各读一面，读的是同一
// 份处境。板子与上面那两条 C5.b 同一条路（人写草案进视图 → `round plan --judge` 不跑模型）。
// 第二版只改第一节的 `goal`：逐节差异恰好一处（`~ 第 1 节：goal 变了`）——**这一条是手写的期望**，
// 所以把差异口径退化成"整篇不同"也会让它变红（同一个 `sectionDiffOf` 供两个渲染器）。
test('C5.b · `--json` 那一栏与人面印的是同一张读数：号 · 落地次数 · 同否 · 差异逐字对上', () => {
  /** 把一份靶子搭到「预备态 · 草案第 2 版刚写进视图」：底 → 动作绑定 → 草案 v1 判一遍 → 草案 v2。 */
  const preset = (): string => {
    const root = tmpRoot()
    const outside = tmpDir('fugue-chain-ver-')
    const bottom = join(outside, 'bottom.txt')
    writeFileSync(bottom, '底。\n')
    assert.equal(fugue(root, 'write', 'README.md', '--from', bottom).code, 0)
    assert.equal(fugue(root, 'commit', '-m', '底').code, 0)
    assert.equal(fugue(root, 'config', 'set', 'actions.ok', JSON.stringify({ argv: ['/bin/sh', '-c', 'true'], outputs: [] })).code, 0)
    // 第一版：判一遍（第 1 次落地）——两个靶子都要走过这一步，不然下面读到的号不是同一个。
    const v1 = join(outside, 'r1.md')
    writeFileSync(v1, draftMd())
    assert.equal(fugue(root, 'write', '.fugue/plan/r1.md', '--from', v1).code, 0)
    const first = fugue(root, 'round', 'plan', '写一份 a.ts', '--judge')
    assert.equal(first.code, 0, `第一版那一趟退了 ${first.code}：${first.stderr.slice(0, 300)}`)
    // 第二版：只改第一节的 `goal`（逐节差异恰好一处）。
    const v2 = join(outside, 'r1.v2.md')
    writeFileSync(v2, draftMd({ goal: `${DRAFT_SECTION.goal}（第二版）` }))
    assert.equal(fugue(root, 'write', '.fugue/plan/r1.md', '--from', v2).code, 0)
    return root
  }
  const humanRoot = preset()
  const jsonRoot = preset()

  // 人面那两栏：第 2 版 · 第 2 次落地 · 与第 1 版比 1 处 + 那一条逐字。
  const human = fugue(humanRoot, 'round', 'plan', '写一份 a.ts', '--judge')
  assert.equal(human.code, 0, human.stderr)
  const face = /版本：第 (\d+) 版（这一轮第 (\d+) 次落地）\t与第 (\d+) 版比：(\d+) 处/.exec(human.stdout)
  assert.ok(face !== null, `人面没印出第几版与差异：${human.stdout.slice(0, 500)}`)
  assert.match(human.stdout, /    ~ 第 1 节：goal 变了/, human.stdout.slice(0, 500))

  // 机器面那几栏：同一份处境。
  const asJson = fugue(jsonRoot, '--json', 'round', 'plan', '写一份 a.ts', '--judge')
  assert.equal(asJson.code, 0, asJson.stderr)
  const j = JSON.parse(asJson.stdout) as {
    version: {
      version: number
      landing: number
      same: boolean
      againstVersion: number | null
      lines: string[]
      why: string | null
    } | null
  }
  assert.ok(j.version !== null, `--json 里没有版本那一栏：${asJson.stdout.slice(0, 400)}`)
  assert.equal(j.version.version, Number(face[1]), '--json 里的号与人面印的不是同一个')
  assert.equal(j.version.landing, Number(face[2]), '--json 里的落地次数与人面印的不是同一个')
  assert.equal(face[3], String(Number(face[1]) - 1), '人面比的那一版不是上一版')
  assert.equal(j.version.same, false, '改过的那一版不该报"逐字节相同"')
  assert.equal(j.version.why, null, '草案读得成，不该报"读不成逐节"')
  assert.equal(j.version.againstVersion, Number(face[3]), '--json 里"与第几版比"那一栏与人面印的不是同一个')
  assert.equal(j.version.lines.length, Number(face[4]), '--json 里的差异条数与人面印的"几处"对不上')
  for (const line of j.version.lines) assert.ok(human.stdout.includes(`    ${line}`), `这一条差异人面没印：${line}`)
  assert.deepEqual(j.version.lines, ['~ 第 1 节：goal 变了'], '差异那一栏不是手写的那一条')

  // 再落一遍**同一份正文**：两个渲染器都该说"与上一趟逐字节相同"（号不涨 · 次数照数）。
  const humanSame = fugue(humanRoot, 'round', 'plan', '写一份 a.ts', '--judge')
  assert.match(humanSame.stdout, /版本：第 2 版（这一轮第 3 次落地）\t与上一趟逐字节相同/, humanSame.stdout.slice(0, 500))
  const jsonSame = fugue(jsonRoot, '--json', 'round', 'plan', '写一份 a.ts', '--judge')
  const j2 = JSON.parse(jsonSame.stdout) as {
    version: { version: number; landing: number; same: boolean; againstVersion: number | null; lines: string[] }
  }
  assert.equal(j2.version.version, 2, '重落同一版不该涨号')
  assert.equal(j2.version.landing, 3, '落地次数该照数')
  assert.equal(j2.version.same, true)
  assert.deepEqual(j2.version.lines, [], '重落那一档不该有差异那一栏')
  assert.equal(j2.version.againstVersion, null, '重落那一档没有差异，也就没有"比的是哪一版"')
  console.log(
    `C5.b 同源读数：人面「第 ${face[1]} 版（这一轮第 ${face[2]} 次落地）· 与第 ${face[3]} 版比：${face[4]} 处」` +
      ` ↔ --json version=${j.version.version} landing=${j.version.landing} same=${String(j.version.same)}` +
      ` againstVersion=${String(j.version.againstVersion)} lines=${j.version.lines.length}` +
      ` · 重落那一档两边都是第 ${j2.version.version} 版 / 第 ${j2.version.landing} 次落地 / 逐字节相同`,
  )
})

test('一趟命令读一遍：命令行那一层只有三处 `roundFactsOf`（`round plan` · `say` · `round go` 各一处）', () => {
  // **为什么量这一条结构**：轮次那一层的三个入口收了 `facts` 就不再读日志（`plan.test.ts` ⑩ ·
  // `say.test.ts` ⑥ · `dispatch.test.ts` ⑤ 量的是它），而"命令行读了几遍"这一头**没有注入缝**
  // ——每条命令一个真进程、一次真加载。所以量它的来源：三处读，一处一条命令，每一处都是
  // 「读一次、递下去」。**多出来的那一处就是又一趟读**：那时要么把读数递下去，要么把这一条改掉。
  // U4d 起 round 那一组住在 `./cmd/round.ts`（fugue.ts 只剩分发），扫描对象跟着搬。
  const source = readFileSync(fileURLToPath(new URL('./cmd/round.ts', import.meta.url)), 'utf8')
  const sites = source
    .split('\n')
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => line.includes('roundFactsOf('))
  assert.equal(sites.length, 3, `命令行那一层读了 ${sites.length} 遍轮次日志（该是三处：round plan · say · round go）`)
  for (const [at, line] of sites) {
    assert.match(
      line,
      /const facts = await roundFactsOf\(ctx\.log, round\)/,
      `第 ${at} 行那一处不是「读一次、递下去」的形状：${line.trim()}`,
    )
  }
  console.log(`读数：命令行那一层 roundFactsOf( 共 ${sites.length} 处（第 ${sites.map(([at]) => at).join(' · ')} 行），一处一条命令`)
})


// ── S9 那条缺口的封口：持轮者拿到的**请求字节**里说得出草案写哪儿 · 什么形状 ──────────────
//
// 由头：`tools/probe-live-s9.sh` 三次真档，`--dump-wire` 的实录里 `system` 只有项目方针那一份，
// 两条 user 消息就只有目标那一句——**一个字节都没说草案写哪儿**，于是真模型三次都写不出草案
// （空仓库那两次去问人了，靶子里有内容那次把交付物 `notes.md` 写进了自己的视图），判按
// 「构造器不猜」退回。这一条把那一句钉在**发出去的字节**上，顺带钉住它的位置与两态之差。
//
// **不出网**：传输换成空回放目录（当场拒），而拒之前那一份请求已经落盘（`--dump-wire` 落的
// 就是真发出去的那一份）——与 C5 那两条同一个手法。
test('S9 · 持轮者的前缀里说得出草案写哪儿 · 什么形状（在「工作总目标」的末尾）', () => {
  const root = tmpRoot()
  assert.equal(fugue(root, 'write', 'README.md', '--from', srcOf()).code, 0)
  assert.equal(fugue(root, 'commit', '-m', '底').code, 0)
  const outside = tmpDir('fugue-goal-')
  const empty = join(outside, '空夹具')
  mkdirSync(empty, { recursive: true })
  const dump = join(outside, 'wire')

  const r = fugue(root, 'round', 'plan', '写一份 notes.md', '--wire-in', empty, '--dump-wire', dump)
  assert.equal(r.code, 1, `写不出草案该退 1，实际 ${r.code}：${r.stderr.slice(0, 300)}`)

  const request = readFileSync(join(dump, 'call-0001', 'request.json'), 'utf8')
  // 一 · 写哪儿（`.fugue/plan/r1.md` 那一条就是 `round plan` 读回来的那一条）· 什么形状 ·
  //     键那几笔（与判键域那一份同源）。
  assert.ok(request.includes('.fugue/plan/r1.md'), `请求字节里没有草案那条路径：${request.slice(0, 400)}`)
  assert.ok(request.includes('one task per section'), '请求字节里没说形状')
  assert.ok(request.includes('ownedPaths'), '请求字节里没念草案的键')
  // 二 · **位置**：它在「工作总目标」那一段的末尾（那一列里模型读到的最后一处；`round plan`
  //     那一趟 C 区是空的）。只判"字节里有那一句"钉不住位置——这一条才是近因那一句话。
  const goal = messagesOf(request)[0]?.content ?? ''
  assert.ok(goal.startsWith('写一份 notes.md'), `第一条消息不是目标那一句：${goal.slice(0, 80)}`)
  assert.ok(goal.trimEnd().endsWith("Another path does not count as this pass's deliverable."), `目标那一段的末尾不是那一句：${goal.slice(-200)}`)

  // 三 · **负对照：讨论态那一趟不带它**——那一趟的产物是"修正后的理解"（不落文件 · 处境不动），
  //     说一句"往 `.fugue/plan/` 里写"是错的（架构 § 15.1.a 那张表的两行）。换一份干净靶子。
  const root2 = tmpRoot()
  assert.equal(fugue(root2, 'write', 'README.md', '--from', srcOf()).code, 0)
  assert.equal(fugue(root2, 'commit', '-m', '底').code, 0)
  const dump2 = join(outside, 'wire2')
  const talk = fugue(root2, 'say', '第二节也要拆', '--wire-in', empty, '--dump-wire', dump2)
  assert.equal(talk.code, 1, `这一趟没有凝聚理解该退 1，实际 ${talk.code}：${talk.stderr.slice(0, 200)}`)
  const request2 = readFileSync(join(dump2, 'call-0001', 'request.json'), 'utf8')
  assert.equal(request2.includes('.fugue/plan/'), false, '讨论态那一趟居然说了往草案那个路径里写')

  // 四 · **子 agent 那一侧不带它**（这一趟的产物那一句只对持轮者那一格说）：录下来的那份子
  //     agent 请求（`round run` 那一趟 · 契约给的产物路径）里一个 `.fugue/plan/` 都没有。
  //     那一份夹具**绑的就是当时的请求字节**（`--wire-in` 逐字节对账），所以接线一旦把它漏进
  //     子 agent 的前缀，那条回放当场拒——这一条量与那一条是同一件事的两面。
  const subRequest = readFileSync(join(WIRE_IN_DIR, 'wire', 'call-0001', 'request.json'), 'utf8')
  assert.equal(subRequest.includes('.fugue/plan/'), false, '子 agent 那条请求里居然有草案路径')

  console.log(
    `S9 读数：预备态那条请求里 ${request.length} 字节（目标那一段 ${goal.length} 字节，末尾是那一句）· ` +
      `讨论态那条请求里一个 \`.fugue/plan/\` 都没有 · 子 agent 那条请求里也没有`,
  )
})

test('命令面那一段链描述与缺省行为说的是同一件事：合并前预检只报不拒（严档是 `--strict-merge-gate`）', () => {
  // **两处写法说的是同一件事**：`round run` 那一段链描述，与 `RunDeps.strictMergeGate` 的缺省值。
  // 对不上时，照着敲的人会以为合并前会被拒——而它缺省只报（判决进 `预检：Planning N 对 · 合并前 M
  // 对` 那一行，PLAN § 5.10 那个判决）。行为那一半在 `src/round/work.test.ts` 的 ⑤（缺省放行 ·
  // 严档 fail-closed）；这一条断的是**印给人看的那一段文字**，两半合起来才是"命令面与行为一致"。
  const root = tmpRoot()
  const r = fugue(root, 'round', 'run')
  assert.equal(r.code, 2, `不带目标那一趟该退 2（用法错），实际 ${r.code}：${r.stderr.slice(0, 200)}`)
  const run = r.stderr.slice(r.stderr.indexOf('round run <目标>'), r.stderr.indexOf('round work'))
  // **摊平空白再比**：那一段是按行折的，断的是"说得对不对"，不是"折在哪一列"。
  const flat = run.replace(/\s+/g, '')
  assert.equal(flat.includes('合并前兜底预检（缺省只报不拒'), true, `链描述里没写缺省只报不拒：${run.slice(0, 240)}`)
  assert.equal(flat.includes('合并前兜底预检（报出即拒）'), false, '链描述还在说合并前报出即拒')
  assert.equal(flat.includes('--strict-merge-gate'), true, '那一档里没写严档那个开关')
})
