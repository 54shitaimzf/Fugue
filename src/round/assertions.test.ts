// tier: real —— bwrap（验收要真的关在挂载层里；没有它这一条会写出哨兵，那是它该红的样子）
//
// B01 + B09 的断言：**验收与 agent 执行走同一条执行路**（架构 § 14.6 的双消费者 ·
// § 8.12「断言只带动作名」· 计划 § 5.1 的 B01/B09 行）。
//
// 这一份量三件事：
//
//   ① 真正包出来的命令行是**沙箱那一份**（`bwrap` / `--unshare-net` / 沙箱坐标），断言声明
//      的 `where` 进了 `--chdir`；
//   ② 验收里那条“往树外写”的动作**写不出真实工作树之外**：树外哨兵一个字节不变，判决是没通过；
//   ③ 动作绑不上 → `unrunnable`（仪器故障），不是把整轮打成崩溃，也不是“没通过”。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { probeLayers } from '../boundary/policy.ts'
import type { ConfigDoc } from '../config.ts'
import { createRoots } from '../roots/roots.ts'
import { verify } from '../merge/accept.ts'
import { assertionSpecsOf, newAssertionPlanMemo } from './assertions.ts'
import type { Contract } from '../contract/types.ts'
import type { AgentId, RelPath } from '../terms.ts'

const AGENT = 'agent/r1/1' as AgentId
const AGENT2 = 'agent/r1/2' as AgentId

function contractOf(action: string, where?: RelPath, agent: AgentId = AGENT): Contract {
  return {
    kind: 'implement',
    id: 'r1.implement.1',
    agent,
    branch: 'refs/heads/agent/r1/1',
    goal: '把这一格做完',
    ownedPaths: ['out.txt'],
    deliverables: [],
    assertions: [{ action, name: action, ...(where === undefined ? {} : { where }) }],
    seed: [],
    actionOutputs: {},
  }
}

test('B01 验收走同一条执行路：真沙箱 · 树外哨兵不变 · where 生效', async () => {
  const base = mkdtempSync(join(tmpdir(), 'fugue-b01-'))
  const root = join(base, 'root')
  const mat = join(base, 'mat')
  const outside = join(base, 'outside')
  mkdirSync(join(root, '.fugue'), { recursive: true })
  mkdirSync(mat, { recursive: true })
  mkdirSync(outside, { recursive: true })
  mkdirSync(join(mat, 'sub'), { recursive: true })
  writeFileSync(join(mat, 'sub', 'marker.txt'), '在子目录里\n')
  const sentinel = join(outside, 'sentinel.txt')
  writeFileSync(sentinel, '树外哨兵：验收一个字节都不能写它\n')
  const doc: ConfigDoc = {
    actions: {
      attack: { argv: ['/bin/sh', '-c', `echo hacked > '${sentinel}'`] },
      pass: { argv: ['/bin/sh', '-c', 'test -f marker.txt && test -f ../sub/marker.txt'] },
    },
  }
  const roots = createRoots(root)
  const probed = probeLayers(roots)
  try {
    // ── ① 包出来的命令行就是沙箱那一份。
    const specs = assertionSpecsOf([contractOf('attack', 'sub')], {
      roots,
      doc,
      probed,
      tree: mat,
      portIndexOf: () => 0,
    })
    assert.equal(specs.length, 1)
    const one = specs[0] as (typeof specs)[number]
    assert.equal(one.notRun, undefined, `准备阶段不该判跑不起来：${one.notRun}`)
    if (!probed.layers.includes('bwrap')) {
      assert.fail(`这一条要 bwrap 在场才量得动（实测层：${probed.layers.join('+') || '一层都不在'}）`)
    }
    assert.equal(one.mechanism, 'bwrap')
    assert.equal(one.argv[0], 'bwrap')
    assert.ok(one.argv.includes('--unshare-net'), '动作没点名 net: host，验收也该把网切掉')
    assert.equal(one.cwd, 'sub', '断言声明的 where 进了这一趟的 cwd')
    assert.ok(one.argv.includes('--chdir'), '沙箱的当前目录由 --chdir 落')
    assert.equal(one.env['HOME'], '/cache', '环境是本 agent 的沙箱坐标，不是宿主 HOME')

    // ── ② 树外哨兵不变；这条动作在沙箱里写不到树外，判决是“没通过”。
    const report = await verify(mat, specs)
    assert.equal(report.ok, false)
    assert.equal(report.fail, 1)
    assert.equal(report.unrunnable, 0, '跑起来了（只是被边界拦住），不是仪器故障')
    assert.equal(readFileSync(sentinel, 'utf8'), '树外哨兵：验收一个字节都不能写它\n')

    // ── 正对照：同一条路、合法动作照常过。
    const ok = await verify(mat, assertionSpecsOf([contractOf('pass', 'sub')], { roots, doc, probed, tree: mat, portIndexOf: () => 0 }))
    assert.equal(ok.ok, true, `合法断言该过：${JSON.stringify(ok.results)}`)

    // ── ③ 动作绑不上：unrunnable，不抛、不算“没通过”。
    const missing = await verify(mat, assertionSpecsOf([contractOf('nosuch')], { roots, doc, probed, tree: mat, portIndexOf: () => 0 }))
    assert.equal(missing.ok, false)
    assert.equal(missing.unrunnable, 1)
    assert.equal(missing.fail, 0)
    assert.match(String(missing.results[0]?.note), /没有这个动作/)
    assert.equal(existsSync(join(root, 'hacked')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// A ①：**检查在宿主写之前**。声明落到视图外的那一条，缓存目录与声明目录一个都不该建，
// 验收进程一次都不该起。改前三处 `mkdirSync` 排在 `checkReach` 之前，树外那一段会先被建出来。
test('A ① · 声明落到树外：树外一个目录都不建 · 验收一次都不起', async () => {
  const base = mkdtempSync(join(tmpdir(), 'fugue-a1-'))
  const root = join(base, 'root')
  const mat = join(base, 'mat')
  const outside = join(base, 'outside')
  mkdirSync(join(root, '.fugue'), { recursive: true })
  mkdirSync(mat, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const sentinel = join(outside, 'ran.txt')
  const doc: ConfigDoc = {
    actions: {
      escape: { argv: ['/bin/sh', '-c', `echo ran > '${sentinel}'`], cache: ['../outside/created'] },
    },
  }
  const roots = createRoots(root)
  try {
    const specs = assertionSpecsOf([contractOf('escape')], {
      roots,
      doc,
      probed: probeLayers(roots),
      tree: mat,
      portIndexOf: () => 0,
    })
    assert.equal(specs.length, 1)
    assert.match(String(specs[0]?.notRun), /落不到视图里/)
    assert.equal(existsSync(join(outside, 'created')), false, '树外目录一个都不该建')
    const report = await verify(mat, specs)
    assert.equal(report.unrunnable, 1)
    assert.equal(report.fail, 0)
    assert.equal(existsSync(sentinel), false, '验收进程一次都不该起')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// A ②：**声明目录的创建排在检查之后**。树里同名的已经是文件时，该报 not-a-mount-point；
// 改前 `mkdirSync(dist, {recursive:true})` 先撞 EEXIST，报出来的是 mkdir 的话。
test('A ② · 树里同名的是文件：报 not-a-mount-point，不是 EEXIST', () => {
  const base = mkdtempSync(join(tmpdir(), 'fugue-a2-'))
  const root = join(base, 'root')
  const mat = join(base, 'mat')
  mkdirSync(join(root, '.fugue'), { recursive: true })
  mkdirSync(mat, { recursive: true })
  writeFileSync(join(mat, 'dist'), '不是目录\n')
  const doc: ConfigDoc = { actions: { build: { argv: ['/bin/true'], cache: ['dist'] } } }
  const roots = createRoots(root)
  try {
    const specs = assertionSpecsOf([contractOf('build')], {
      roots,
      doc,
      probed: probeLayers(roots),
      tree: mat,
      portIndexOf: () => 0,
    })
    assert.equal(specs.length, 1)
    const why = String(specs[0]?.notRun)
    assert.match(why, /不是一个目录/)
    assert.doesNotMatch(why, /EEXIST/)
    assert.equal(readFileSync(join(mat, 'dist'), 'utf8'), '不是目录\n')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// B（并进 A）：memo 的键是 `(action, agent)`。同一批里用同一份 memo 分两次算出来的 specs，
// 要与不用 memo 一次算出来的**逐字段相等**；两个 agent 共用一个动作时，端口片不串味。
test('B · (action, agent) memo：有 memo 与没 memo 的 specs 逐字段相等', () => {
  const base = mkdtempSync(join(tmpdir(), 'fugue-b-'))
  const root = join(base, 'root')
  const mat = join(base, 'mat')
  mkdirSync(join(root, '.fugue'), { recursive: true })
  mkdirSync(mat, { recursive: true })
  const doc: ConfigDoc = { actions: { build: { argv: ['/bin/true'], cache: ['dist'] } } }
  const roots = createRoots(root)
  const probed = probeLayers(roots)
  const portIndexOf = (a: AgentId): number => (a === AGENT ? 0 : 1)
  try {
    const c1 = contractOf('build')
    const c2 = contractOf('build', undefined, AGENT2)
    const deps = { roots, doc, probed, tree: mat, portIndexOf }
    const without = assertionSpecsOf([c1, c2], deps)
    const memo = newAssertionPlanMemo()
    const withMemo = [
      ...assertionSpecsOf([c1], { ...deps, memo }),
      ...assertionSpecsOf([c2], { ...deps, memo }),
    ]
    assert.deepEqual(withMemo, without)
    assert.equal(withMemo.length, 2)
    assert.notEqual(withMemo[0]?.env.PORT, withMemo[1]?.env.PORT, '不同 agent 的端口片不该被 memo 串成一片')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
