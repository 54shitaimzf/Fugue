// Z3 的断言（PLAN § 5.6 的 Z3 行 · 架构 § 8.10 的两条硬纪律与它的验证性质 · 架构 § 20 S6 的
// 第四条验证：状态切换前后工具 schema 哈希不变）。
//
//   ① **序列化口径**：同一份目录序列化两次逐字节相同（键序稳定、无空格），而且它就是 Z0 定的
//      那一份口径——这一条不成立，「哈希不变」量的就是一份抖动的字节
//   ② **状态切换前后，整份目录的哈希不变**：三种状态（计划模式关 · 计划模式开 · 有一条待办）
//      各取一次哈希，三行相等；`exit_plan_mode` 在计划模式未激活时仍在目录里，正是这一条
//   ③ **双向对账**：目录里的每个名字在能力表里都有行，表里的每个名字也都在目录里——架构
//      § 8.10「这张目录是工具名的唯一定义处」与 § 8.9「这张表是全函数」是一句话的两面
//   ④ **每条都是一份完整的声明**：名字 · 描述 · 参数面三样齐全，名字不重，参数面是对象
//   ⑤ **红负对照**：把「有一条待办」这件事写进某一条的 `parameters`，哈希当场变——② 那一行
//      相等不是恒等式。它是 `tools/neg-z3.sh` 里那一档的断言面
//
// **② 为什么不是恒等式**：`catalog(_state)` 今天一处都不读那个参数，所以「三次相等」看着像白
// 送的。可它量的不是 `catalog` 的内部，是**目录的字节里没有状态**：⑤ 把状态塞进字节里，
// ② 就红。两条合起来才是「跨状态稳定」这句话的完整读数（与 Z1 的 ② 和 ④ 同一个形状）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CAPABILITY_TABLE, checkInvariant, lookup } from '../capability/table.ts'
import { HOLDER_PROTOCOL, SUBAGENT_PROTOCOL } from '../assemble/protocol.ts'
import type { ToolEntry } from './catalog.ts'
import { CATALOG_STATES, TOOL_ENTRIES, catalog, catalogBytes, catalogHash, catalogNames, toolHash } from './catalog.ts'

/** 名字的升序：这一份量的是「名单一样」，不是「顺序一样」（顺序由能力表那一份名字表排）。 */
function sorted(names: readonly string[]): string[] {
  return [...names].sort()
}

test('① 序列化两次逐字节相同 · 键序稳定 · 无空格', () => {
  const first = catalogBytes(TOOL_ENTRIES)
  const second = catalogBytes(catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number]))
  assert.equal(first, second, '两次序列化的字节不同')
  assert.equal(first, first.trim(), '序列化的两头有空白')
  assert.ok(!first.includes('\n'), '序列化里出现了换行')
  assert.ok(!first.includes(', '), '序列化里出现了「, 」——有空格的序列化不是同一份字节')

  // 键序稳定：同一份对象换一个插入顺序，字节仍然相同（不然哈希会跟着构造顺序动）。
  const a: ToolEntry = { name: 'x', description: 'd', parameters: { type: 'object', b: 1, a: 2 } }
  const b: ToolEntry = { name: 'x', description: 'd', parameters: { a: 2, type: 'object', b: 1 } }
  assert.equal(toolHash(a), toolHash(b), '同一份条目换个插入顺序，指纹就变了——键序不稳定')
  assert.equal(catalogBytes([a]), catalogBytes([b]))
})

test('② 状态切换前后整份目录的哈希不变（第三种状态也含在内）', () => {
  const hashes = CATALOG_STATES.map((s) => catalogHash(catalog(s)))
  assert.equal(new Set(hashes).size, 1, `四种状态里出现了不同的目录哈希：${hashes.join(' · ')}`)
  assert.equal(hashes.length, 3, '三种状态才量得出「跨状态」这三个字')
  assert.deepEqual(CATALOG_STATES.map((s) => s.planMode), [false, true, false])
  assert.deepEqual(CATALOG_STATES.map((s) => s.pendingTodos), [0, 0, 1])

  // 计划模式未激活时 `exit_plan_mode` 仍在目录里（架构 § 8.10 硬纪律 2 点名的那个例子）。
  const off = catalog({ planMode: false, pendingTodos: 0 })
  assert.ok(catalogNames(off).includes('exit_plan_mode'), '计划模式关着，exit_plan_mode 就不在目录里了')
  // 三种状态的字节逐字节相同，不只是哈希相同（哈希前 16 位相同有可能只是前缀相同）。
  const bytes = CATALOG_STATES.map((s) => catalogBytes(catalog(s)))
  assert.equal(new Set(bytes).size, 1, '三种状态的字节不完全相同')
})

test('③ 目录与能力表双向对账（§ 8.10 的唯一定义处 · § 8.9 的全函数）', () => {
  const names = catalogNames(TOOL_ENTRIES)
  assert.equal(names.length, 15, `目录里 ${names.length} 条`)
  assert.deepEqual(checkInvariant(CAPABILITY_TABLE, names), [], '能力表对这份目录有话说')

  // 目录 → 表：每一个名字都查得出推论，一个都不许走「未声明即拒」那条路。
  for (const name of names) {
    const got = lookup(name)
    assert.ok(!('denied' in got), `目录里有这个名字，能力表却没有行：${name}`)
  }
  // 表 → 目录：表里的每一个名字都在目录里（反过来那半）。
  for (const tool of Object.keys(CAPABILITY_TABLE)) {
    assert.ok(names.includes(tool), `能力表里有这一格，目录里却没有这个名字：${tool}`)
  }
  assert.deepEqual(sorted(names), sorted(Object.keys(CAPABILITY_TABLE)))
})

test('③b 协议值里那一栏就是这份目录的名字（§ 8.11 的 `Protocol.toolCatalog`）', () => {
  const names = catalogNames(TOOL_ENTRIES)
  assert.deepEqual([...SUBAGENT_PROTOCOL.toolCatalog], names, '子 agent 那份协议的工具目录不是这份目录')
  assert.deepEqual([...HOLDER_PROTOCOL.toolCatalog], names, '持轮者那份协议的工具目录不是这份目录')
})

test('④ 每条都是一份完整的声明：名字 · 描述 · 参数面三样齐全 · 名字不重', () => {
  const names = catalogNames(TOOL_ENTRIES)
  assert.equal(new Set(names).size, names.length, '目录里有重名')
  for (const t of TOOL_ENTRIES) {
    assert.ok(t.name.length > 0, '有一条没有名字')
    assert.ok(t.description.length > 0, `这一条没有描述：${t.name}`)
    assert.equal(typeof t.parameters, 'object')
    assert.equal(t.parameters['type'], 'object', `参数面不是一个对象：${t.name}`)
    assert.ok(Object.keys(t.parameters).length > 0, `这一条没有参数面：${t.name}`)
    assert.equal(toolHash(t).length, 16, `指纹不是 sha256 前 16 位：${t.name}`)
    assert.match(toolHash(t), /^[0-9a-f]{16}$/)
  }
  assert.equal(catalogHash(TOOL_ENTRIES).length, 16)
})

test('⑤ 红负对照：把「有一条待办」写进某一条的参数面，② 那一行当场不等', () => {
  /** 替身目录：`todo_write` 的参数面里多一句随状态变的话——正是硬纪律 2 要拦下的那种写法。 */
  const leaky = (pending: number): ToolEntry[] =>
    TOOL_ENTRIES.map((t) =>
      // tools/neg-z3.sh 的甲把下一行换成一个恒等映射，量的是这条反事实真的在做那件事。
      t.name === 'todo_write'
        ? { ...t, parameters: { ...t.parameters, note: `现在有 ${pending} 条待办` } }
        : { ...t },
    )

  const withTodo = catalogHash(leaky(1))
  const without = catalogHash(leaky(0))
  assert.notEqual(withTodo, without, '状态塞进了参数面，哈希却没变——② 那一行相等是恒等式')
  // 变化确实落在 `todo_write` 那一条上，不是别处被顺手改了。
  const a = leaky(0).find((t) => t.name === 'todo_write')
  const b = leaky(1).find((t) => t.name === 'todo_write')
  assert.ok(a !== undefined && b !== undefined)
  assert.notEqual(toolHash(a), toolHash(b), 'todo_write 那一条的指纹没变')
  // 其余十四条一个字节都没动：差只差在那一条上。
  const others = TOOL_ENTRIES.filter((t) => t.name !== 'todo_write')
  assert.deepEqual(
    others.map((t) => toolHash(t)),
    leaky(1).filter((t) => t.name !== 'todo_write').map((t) => toolHash(t)),
  )

  // 正对照：真目录在同样两个状态下相等，所以上面那对不等不是「哈希本来就会动」。
  assert.equal(catalogHash(catalog({ planMode: false, pendingTodos: 0 })), catalogHash(catalog({ planMode: false, pendingTodos: 1 })))
})
