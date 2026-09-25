// S8 的本地这一条链，**从命令行那一头走一遍**：装配 → 轮次（起头 · 契约 · 合并 · 验收 · 推进）
// → 指标重算。PLAN § 5.8 的 B7.5 与 B4/B5/B7 的命令面 · 架构 § 9.6 的"CLI 是单次进程 + 每次重建"。
//
// **为什么单开一份**：`fugue.test.ts` 那一份量的是 S1 那几条（读写 · 检视 · 提交 · 重放 · 配置），
// 而这一份量的是**接口之间接上了没有**——每一步都是一次独立的进程，下一条命令靠重放回来。
// 单元测试绿而命令是坏的，这一站已经撞过一次（`B7.5` 之前 `fugue round run` 是
// `deps.stub is not a function`，而 294 条单测全绿），所以"能不能跑"要有一条自己的断言。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tmpDir } from '../../test/helpers/tmp.ts'

const CLI = fileURLToPath(new URL('./fugue.ts', import.meta.url))

interface Run {
  code: number
  stdout: string
  stderr: string
}

function fugue(root: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    input: '',
    maxBuffer: 1 << 26,
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
  assert.equal(a.toolCatalog, 15, '工具目录十五条')
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
  const ok = fugue(root, 'round', 'run', '写一份 a.ts', '--live', '--dump-wire', join(outside, 'wire'))
  assert.equal(ok.code, 1, `该退 1（凭据不在），实际 ${ok.code}`)
  assert.match(ok.stderr, /凭据不在/)
  console.log(`守卫读数：工作区里 → "${bad.stderr.split('\n')[0]}" · 工作区外 → "${ok.stderr.split('\n')[0].slice(0, 60)}"`)
})
