// Z2 的断言（PLAN § 5.6 的 Z2 行 · 架构 § 8.9「这张表是全函数」· 架构 § 8.10「这张目录是
// `ToolName` 的唯一定义处」）。
//
//   ① **表是全的，也是单值的**：架构 § 8.9 那张目录里每个工具在表里恰好一行、每行落在五层中的
//      某一层；表里的键反过来一个不少地名在那份名字表里；能力标识一格一个，五层各有一格
//      ——「一个都还没有」是这一条今天要否掉的那个状态
//   ② **未声明即拒**：一个不在表里的工具名 → 拒，拒的话里带着那个名字与名字的出处
//   ③ **四条推论逐条与层相符**（架构 § 8.9 那张推论表）：先物化 · 过路径围栏 · 关进 OS 沙箱 ·
//      可回写视图，四条都由层算出来，逐格的布尔与那张表的「成立条件」那一列相等
//   ④ **声明集只挂在执行层**：回写那一条不是「落在执行层」就够——还要该能力声明了产出集，
//      于是 `bash` 与 `run_action` 同在执行层而回写不同（§ 8.7 · D7）
//   ⑤ **载入时的核对真的会炸**：截短那份名字表，少的那一格当场报出来（架构 § 8.9 那句
//      「少了这一层都编译不过」在这个仓库里的样子）
//   ⑥ **红负对照**：把 `bash` 挪到视图层，③ 那一对当场红——「先物化」与「关进沙箱」两条同时
//      不成立。它是 `tools/neg-z2.sh` 里那一档的断言面
//
// **③ 为什么读 `lookup()` 而不读表**：消费方读的是推论（`M4` 的 `ensure` · `M3` 的
// `resolveVirtual` · `M7.confine()` · `M6` 反向通道），所以断言要落在它们读的那条路上。只读表
// 的话，「表改了而推论没跟着改」这一类错量不出来。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Capability, CapabilityRow, Layer } from './table.ts'
import { CAPABILITY_TABLE, checkInvariant, lookup, namesOn } from './table.ts'

/** 架构 § 8.9 那五行，逐字。 */
const LAYERS: readonly Layer[] = ['view', 'execute', 'truth', 'log']

/** 那份名字表：Z0 的协议值里那一栏就是它（`Protocol.toolCatalog`），不在这里抄第二遍。 */
const { TOOL_NAMES } = await import('../assemble/protocol.ts')

function isDenied(v: Capability | { denied: true }): v is { denied: true; tool: string; message: string } {
  return (v as { denied?: true }).denied === true
}

/** 把查表逼成推论：不在表里时当场报出那个名字，而不是让断言里多一层分支。 */
function cap(tool: string): Capability {
  const got = lookup(tool)
  if (isDenied(got)) throw new Error(`表里没有这个工具：${tool}`)
  return got
}

/** 名字的升序。⑧ 量「少了一格」而不是「顺序变了」，所以两边的清单先对齐再比。 */
function sorted(names: readonly string[]): string[] {
  return [...names].sort()
}

test('① 每个工具在表里恰好一行 · 每行落在一层上 · 能力标识一格一个', () => {
  const tools = Object.keys(CAPABILITY_TABLE)

  // 恰好一行：键不许重（重复的键在对象字面量里会被后一个吃掉，于是那一格静默消失）。
  assert.equal(tools.length, new Set(tools).size, '表里有重复的键')
  assert.equal(tools.length, TOOL_NAMES.length, `表里 ${tools.length} 行，名字表 ${TOOL_NAMES.length} 个`)

  // 两个方向都要判：一个都没漏（名字表 → 表），也没有表外的名字（表 → 名字表）。
  assert.deepEqual(sorted(tools), sorted(TOOL_NAMES), '表与工具目录不是同一份名单')
  assert.deepEqual(checkInvariant(CAPABILITY_TABLE, TOOL_NAMES), [], '开发核对对这份表有话说')

  // 每行落在四层中的某一层：四层各至少一格，且没有第五层。
  const byLayer = new Map<Layer, string[]>(LAYERS.map((l) => [l, namesOn(l)]))
  const covered = new Set([...byLayer.values()].flat())
  assert.deepEqual(sorted([...covered]), sorted(TOOL_NAMES), '有工具不落在四层中的任何一层')
  for (const layer of LAYERS) {
    assert.ok((byLayer.get(layer) ?? []).length > 0, `这一层一个工具都没有：${layer}`)
  }
  const layers = new Set(tools.map((t) => CAPABILITY_TABLE[t]?.layer))
  assert.deepEqual(sorted([...layers]), sorted(LAYERS), '层表里出现了 § 8.9 那五行之外的东西')

  // 能力标识一格一个：它是后面那些策略要指的那个东西，合并两个身份就再也分不开它们。
  const ids = tools.map((t) => CAPABILITY_TABLE[t]?.capability)
  assert.equal(new Set(ids).size, ids.length, '两个工具共用了同一个能力标识')
  for (const t of tools) assert.equal(CAPABILITY_TABLE[t]?.capability, t, `这一格的身份不是它自己：${t}`)
})

test('② 未声明的工具名 → 拒，拒的话里带着那个名字与名字的出处', () => {
  for (const raw of ['no-such-tool', 'rm_rf', 'Bash', '', 'read ']) {
    const got = lookup(raw)
    assert.ok(isDenied(got), `这一串不该查出能力来：${JSON.stringify(raw)}`)
    assert.equal(got.tool, raw, '拒的时候要把原样那一串带回来')
    assert.ok(got.message.includes(raw === '' ? '：' : raw), `拒的话里没有那个名字：${got.message}`)
    // 拒的话要指得出名字从哪来（架构 § 8.4 纪律 2 的同一条纪律）。
    assert.match(got.message, /§ 8\.10/)
  }
  // 正对照：表里那十二个一个都不拒，且拒的那一支不会漏进它们。
  for (const name of TOOL_NAMES) assert.ok(!isDenied(lookup(name)), `表里的工具被拒了：${name}`)
})

test('③ 四条推论逐条与层相符（§ 8.9 那张推论表）', () => {
  const expect = (layer: Layer): Record<string, boolean> => ({
    materialize: layer === 'execute',
    fence: layer === 'view' || layer === 'execute',
    confine: layer === 'execute',
    writeBack: false, // 回写还要声明集，单看层判不出来——④ 专判它
  })

  for (const tool of TOOL_NAMES) {
    const got = cap(tool)
    const want = expect(got.layer)
    assert.equal(got.materialize, want.materialize, `${tool}（${got.layer}）落在执行层吗`)
    assert.equal(got.fence, want.fence, `${tool}（${got.layer}）过不过围栏`)
    assert.equal(got.confine, want.confine, `${tool}（${got.layer}）关不关进沙箱`)
    // 表里的那一行也要与推论同源：表写层，推论由层算出来，不许两处各写一份。
    const row = CAPABILITY_TABLE[tool]
    assert.ok(row !== undefined)
    assert.equal(got.materialize, row.layer === 'execute')
  }

  // 两句话的名字是那张表的第一列：`M4` 的 `ensure` 与 `M7.confine()` 两条今天各有一个消费方。
  assert.deepEqual(namesOn('execute'), ['bash', 'run_action'])
  assert.ok(cap('bash').materialize && cap('bash').confine, '执行类要先物化、要关进沙箱')
  assert.ok(cap('read').fence && !cap('read').confine, '视图类过围栏，但不关沙箱——它不 spawn')
  assert.ok(!cap('checkpoint').materialize, '真源那一格不先物化——它写的是真源，不是工作区')
})

test('④ 声明集只挂在执行层：同在执行层，`bash` 与 `run_action` 的回写不同', () => {
  const exec = namesOn('execute')
  assert.deepEqual(sorted(exec), ['bash', 'run_action'])

  const back = TOOL_NAMES.filter((t) => cap(t).writeBack)
  assert.deepEqual(back, ['run_action'], `能回写视图的应当只有 run_action，实际：${back.join(' · ')}`)
  assert.equal(cap('bash').writeBack, false, 'bash 不声明产出集，因此没有回写通道（§ 8.7 · D7）')

  for (const tool of TOOL_NAMES) {
    const got = cap(tool)
    const row = CAPABILITY_TABLE[tool]
    assert.ok(row !== undefined)
    // 回写 = 落在执行层 **且** 声明了产出集：两条都要，缺一条就是 false。
    assert.equal(got.writeBack, got.layer === 'execute' && row.decl, `${tool} 的回写那一条不是由层与声明集算出来的`)
    if (row.decl) assert.equal(row.layer, 'execute', `只有执行层能有声明集：${tool}`)
  }
})

test('⑤ 开发核对检测两侧名表差异与声明集，不替代外部输入拒绝', () => {
  const short = TOOL_NAMES.slice(0, TOOL_NAMES.length - 1)
  const gone = TOOL_NAMES[TOOL_NAMES.length - 1]
  assert.ok(gone !== undefined)
  const bad = checkInvariant(CAPABILITY_TABLE, short)
  assert.equal(bad.length, 1, `应当恰好一处：${bad.join(' · ')}`)
  assert.ok(bad[0]?.includes(gone), `报出来的应当是少了的那一格：${bad[0]}`)

  // 表里多出一格，同样报（另一头）。
  const withExtra: Record<string, CapabilityRow> = { ...CAPABILITY_TABLE, invented: { layer: 'view', capability: 'invented', decl: false } }
  const bad2 = checkInvariant(withExtra, TOOL_NAMES)
  assert.equal(bad2.length, 1, `应当恰好一处：${bad2.join(' · ')}`)
  assert.ok(bad2[0]?.includes('invented'), `报出来的应当是多的那一格：${bad2[0]}`)

  // 声明集挂在非执行层上，也报：那是「可回写视图」的前提被放错了地方。
  const wrongDecl: Record<string, CapabilityRow> = {
    ...CAPABILITY_TABLE,
    read: { layer: 'view', capability: 'read', decl: true },
  }
  const bad3 = checkInvariant(wrongDecl, TOOL_NAMES)
  assert.equal(bad3.length, 1, `应当恰好一处：${bad3.join(' · ')}`)
  assert.ok(bad3[0]?.includes('read'), `报出来的应当是那一格：${bad3[0]}`)

  // 正对照：这份表本身一处都不报。
  assert.deepEqual(checkInvariant(CAPABILITY_TABLE, TOOL_NAMES), [])
})

test('⑥ 红负对照：把 bash 挪到视图层，③ 那一对当场红', () => {
  /** 替身表：只改 `bash` 那一格的层，别的一格不动。 */
  const WRONG_LAYER: Readonly<Record<string, CapabilityRow>> = {
    ...CAPABILITY_TABLE,
    bash: { layer: 'view', capability: 'bash', decl: false },
  }
  const wrong = (tool: string): Capability => {
    const row = WRONG_LAYER[tool]
    assert.ok(row !== undefined)
    return { tool, layer: row.layer, capability: row.capability, ...INFERENCES_OF(row.layer, row.decl) }
  }

  const laid = namesOn('execute')
  const stillExec = laid.filter((t) => wrong(t).confine)
  assert.notDeepEqual(stillExec, laid, '把 bash 挪到视图层之后，执行层那一份名单必须变——它没变')
  assert.equal(wrong('bash').materialize, false, '视图层不该先物化')
  assert.equal(wrong('bash').confine, false, '视图层不关沙箱')
  // 两条推论同时不成立，而这一格的层从执行变成视图：③ 里那两条断言因此各红一处。
  assert.notEqual(wrong('bash').layer, cap('bash').layer, '替身表的层与表里的层是同一个——负对照是恒等式')
  assert.notDeepEqual([wrong('bash').materialize, wrong('bash').confine], [cap('bash').materialize, cap('bash').confine])

  // 正对照：真表里 bash 两条都成立，所以上面那对不相等不是「两条恒为 false」。
  assert.deepEqual([cap('bash').materialize, cap('bash').confine], [true, true])
})

/** 替身表那一格的四条推论：与产品同一条算法（`table.ts` 的 `inferences()` 一层，只差输入）。 */
function INFERENCES_OF(layer: Layer, decl: boolean): Omit<Capability, 'tool' | 'layer' | 'capability'> {
  return {
    materialize: layer === 'execute',
    fence: layer === 'view' || layer === 'execute',
    confine: layer === 'execute',
    writeBack: layer === 'execute' && decl,
  }
}
