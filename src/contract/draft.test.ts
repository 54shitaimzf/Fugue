// 草案读法的断言（PLAN § 5.10 的 `C1` 断言① 与 `C2` 的"缺一个键当场退回"· 架构 § 15.1.a 的
// 四步里的"拆"与"判" · 架构 § 8.12 的"构造器不猜、不补、不尽力解释"）。
//
//   ① **逐 kind 的键域与契约的字段表相等**：草案的键 + 系统那几个键 == `VARIANT_FIELDS`，
//      两栏不相交；而草案那一栏钉在架构 § 15.1.a 写下的那几个键上——加一个契约字段会让这条红，
//      逼一次人判"它归谁给"
//   ② **缺一个键就报出来，且指得出是哪一节哪一个键**：逐 kind 逐个必须键各删一次，每一次都
//      报出那一个名字。**负对照**：把键域核对短路（少收一栏）→ 那一条断言变红
//   ③ **一次报全**：一份草案同时缺键 · 多键 · 类型不对 → 三处都在，不是报第一处就停
//   ④ 指路的话：`resolve` 那一节 · 两个调查型 · 调查型不在第一节 · 没有节 · 不是 JSON ·
//      `seed` 指着别节的证据（样本盘第一趟真档照出来的那一条）
//   ⑤ 块外那段话原样留着，且不进任何一节
//   ⑥ `draftPathOf`：保留下前缀（`.fugue/plan/<轮次>.md`）；轮次号不是一个段 → 当场拒
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DRAFT_FIELDS, DRAFT_KINDS, DraftError, checkDraft, draftOf, draftPathOf, draftRuleTextOf, goalWithDraftRule } from './draft.ts'
import { FIELD_RULES, VARIANT_FIELDS } from './types.ts'

/** 一节变成一份围栏块。**标 `json`**——不标语言的不算节。 */
function text(...sections: unknown[]): string {
  return sections.map((s, i) => `## 第 ${i + 1} 节\n\n\`\`\`json\n${JSON.stringify(s)}\n\`\`\``).join('\n\n')
}

const INVESTIGATE = {
  kind: 'investigate',
  question: 'src/parse.ts 被谁引用？',
  evidenceRequired: [{ note: 'callers' }],
  seed: ['src/parse.ts'],
}

const IMPLEMENT_1 = {
  kind: 'implement',
  goal: '把解析器拆成独立模块',
  ownedPaths: ['src/parse.ts'],
  deliverables: [{ path: 'src/parse.ts', form: '模块' }],
  assertions: [{ action: 'test', name: '单元测试全过', expect: 0 }],
  seed: [],
}

const IMPLEMENT_2 = {
  kind: 'implement',
  goal: '把调用方改到新模块上',
  ownedPaths: ['src/callers'],
  deliverables: [],
  assertions: [{ action: 'test', name: '单元测试全过' }],
  seed: ['src/callers'],
}

test('① 逐 kind 的键域：草案的键 + 系统的键 == 契约的字段表，且两栏不相交', () => {
  // 正面：并集恰好是契约那一份、两栏不相交（载入那条核对核的就是这件事，这里正面量一遍）。
  for (const kind of DRAFT_KINDS) {
    const d = new Set(DRAFT_FIELDS[kind])
    const contract = new Set(VARIANT_FIELDS[kind])
    for (const f of d) {
      assert.ok(contract.has(f), `${kind}：草案给的键不在契约的字段表里——${f}`)
    }
    // 契约里有、草案不给的那几个键，逐个指得出谁给（多一个说不出的就是"它没人给"）。
    const system: readonly string[] =
      kind === 'implement'
        ? ['id', 'agent', 'branch', 'actionOutputs']
        : ['id', 'agent', 'branch', 'goal']
    for (const f of contract) {
      if (d.has(f)) continue
      assert.ok(system.includes(f), `${kind}：契约里的 ${f} 既不在草案的键域里、也不是系统的键——它没人给`)
    }
    assert.equal(d.size + system.length, contract.size, `${kind}：两栏加起来不是契约的字段表`)
  }

  // 钉住的那一份（架构 § 15.1.a 写下的"键就是契约的键"）。
  assert.deepEqual([...DRAFT_FIELDS.implement].sort(), ['assertions', 'deliverables', 'goal', 'kind', 'ownedPaths', 'seed'].sort())
  assert.deepEqual([...DRAFT_FIELDS.investigate].sort(), ['evidenceRequired', 'kind', 'question', 'seed'].sort())

  // 读出来的值与草案的次序逐条对上。
  const d = draftOf(text(INVESTIGATE, IMPLEMENT_1, IMPLEMENT_2))
  assert.equal(d.sections.length, 3)
  assert.deepEqual(d.sections.map((s) => s.kind), ['investigate', 'implement', 'implement'])
  assert.equal(d.question, INVESTIGATE.question)
  assert.deepEqual(d.evidenceRequired, [{ note: 'callers' }])
  assert.deepEqual(d.split.map((s) => s.goal), [IMPLEMENT_1.goal, IMPLEMENT_2.goal])
  assert.deepEqual(d.split[0]?.assertions, [{ action: 'test', name: '单元测试全过', expect: 0 }])
  assert.deepEqual(d.seeds, [['src/parse.ts'], [], ['src/callers']])
  console.log(`① 读数：${DRAFT_KINDS.map((k) => `${k} ${DRAFT_FIELDS[k].length} 键`).join(' · ')} · 三节读出来的次序 ${d.sections.map((s) => s.kind).join(' → ')}`)

  // 负对照：给草案一个系统的键——它必须在报出来那一侧，不许静默丢掉。
  const withId = checkDraft(text({ ...IMPLEMENT_1, id: 'r1.implement.1' }, IMPLEMENT_2))
  assert.equal(withId.length, 1, `多一个系统键该报一条，报了 ${withId.length} 条`)
  assert.match(withId[0] ?? '', /第 1 节多了一个键 id：那是系统的键/)
})

test('② 缺一个键就报出来：逐 kind 逐个必须键各问一次', () => {
  let asked = 0
  for (const kind of DRAFT_KINDS) {
    const full = kind === 'implement' ? IMPLEMENT_1 : INVESTIGATE
    for (const field of DRAFT_FIELDS[kind]) {
      if (field === 'kind') continue
      const short: Record<string, unknown> = { ...full }
      delete short[field]
      const problems = checkDraft(text(short))
      asked += 1
      assert.equal(problems.length, 1, `删掉 ${kind} 的 ${field} 该报一条：\n  ${problems.join('\n  ')}`)
      assert.match(problems[0] ?? '', new RegExp(`第 1 节缺一个键：${field}$`), `报出来的话里要指得出是哪个键`)
    }
  }
  assert.equal(asked, 8, `两节一共 ${asked} 个必须键——少问了一个，键域核对就有一处没被测到`)
  console.log(`② 读数：逐个必须键各问一次，共 ${asked} 次，每一次都报出那一个键`)

  // **负对照**：把"缺键"那一条短路掉（这里模拟成"只核多键、不核缺键"），上一条断言当场红。
  const onlyExtra = (secs: unknown[]): string[] => checkDraft(text(...secs)).filter((p) => p.includes('多了一个键'))
  const short = { ...IMPLEMENT_1 } as Record<string, unknown>
  delete short['seed']
  assert.equal(checkDraft(text(short)).length, 1, '缺键那一条本身该报')
  assert.equal(onlyExtra([short]).length, 0, '只核多键时它什么都不报——那正是"短路之后测不出东西"')
})

test('③ 一次报全：缺键 · 多键 · 类型不对，三处都在', () => {
  const problems = checkDraft(
    text({
      kind: 'implement',
      goal: '',
      ownedPaths: 'src/a.ts',
      deliverables: [],
      assertions: [],
      actionOutputs: {},
    }),
  )
  assert.ok(problems.length >= 4, `该报出好几处，报了 ${problems.length} 条：\n  ${problems.join('\n  ')}`)
  const all = problems.join('\n')
  assert.match(all, /多了一个键 actionOutputs：那是系统的键/)
  assert.match(all, /缺一个键：seed/)
  assert.match(all, /goal 要是一句非空的话/)
  assert.match(all, /ownedPaths 要是一个路径数组/)
  console.log(`③ 读数：一份草案同时四处不对 → 报了 ${problems.length} 条（不是报第一处就停）`)
})

test('④ 指路的话：五种形状各有各的一句', () => {
  const cases: readonly { readonly why: string; readonly body: string; readonly want: RegExp }[] = [
    { why: 'resolve 那一节', body: text({ kind: 'resolve', goal: 'x', assertions: [] }), want: /解决型契约由冲突报告给，不在草案里/ },
    { why: '两个调查型', body: text(INVESTIGATE, INVESTIGATE), want: /最多一节/ },
    { why: '调查型不在第一节', body: text(IMPLEMENT_1, INVESTIGATE, IMPLEMENT_2), want: /要排在第一节/ },
    { why: '一个节都没有', body: '## 草案\n\n我先想了想，还没写。\n', want: /一个任务节都没有/ },
    { why: '围栏块不是 JSON', body: text(IMPLEMENT_1).replace('{"kind"', '{kind"'), want: /不是合法的 JSON/ },
    { why: '另一个变体的键', body: text({ ...IMPLEMENT_1, question: '凭什么' }), want: /它是 investigate 那一节的键/ },
    // 样本盘第一趟真档：第二格的 `goal` 指了「第 1 节的结论」，而它跑的时候看不见第一节的产物。
    // 那一格伸手去拿那条路的**唯一形态**就是这个——`seed` 里写一条 `evidence/...`。
    {
      why: 'seed 指着别节的证据',
      body: text({ ...IMPLEMENT_1, seed: ['evidence/agent-1/现状'] }),
      want: /看不见别节的产物/,
    },
  ]
  for (const c of cases) {
    const problems = checkDraft(c.body)
    assert.ok(problems.length > 0, `${c.why}：该报出来，一条都没报`)
    assert.match(problems.join('\n'), c.want, `${c.why}：报出的话指不出路——\n  ${problems.join('\n  ')}`)
    console.log(`④ 读数：${c.why} → 「${problems[0]}」`)
  }
})

test('⑤ 块外那段话原样留着，且不进任何一节', () => {
  const body = `为什么这么拆：解析器与调用方可以并行。\n\n${text(IMPLEMENT_1)}\n\n末尾再说一句。\n`
  const d = draftOf(body)
  assert.ok(d.prose.startsWith('为什么这么拆：解析器与调用方可以并行。'), `散文的开头没留住：${JSON.stringify(d.prose.slice(0, 40))}`)
  assert.ok(d.prose.endsWith('末尾再说一句。'), '散文的结尾没留住')
  assert.equal(d.prose.includes('ownedPaths'), false, '散文里混进了节的内容')
  assert.equal(d.prose.includes('## 第 1 节'), false, '标题行是骨架，不该算进那段话里')
  assert.equal(d.sections.length, 1)
  assert.equal(d.sections[0]?.goal, IMPLEMENT_1.goal, '节的内容与散文混了')
  console.log(`⑤ 读数：散文 ${d.prose.length} 字符 · 节 ${d.sections.length} 个`)
})

test('⑥ draftPathOf：保留前缀那一条路径；轮次号不是一个段就当场拒', () => {
  assert.equal(draftPathOf('r1'), '.fugue/plan/r1.md')
  assert.throws(() => draftPathOf('a/b'), DraftError, '轮次号里带斜杠该拒')
  console.log('⑥ 读数：r1 → .fugue/plan/r1.md · a/b → 拒')
})


// ── ⑦ 那一句产物说明：键从 `DRAFT_FIELDS` 念、形状从 `FIELD_RULES` 念 ──────────────────
//
// 由头：真档取证量出来"持轮者拿到的前缀里没有一处说草案写哪儿 · 什么形状"，补上之后那一趟真模型
// 把草案写出来了，而**值写错了形状**（`seed` 给了字符串，`deliverables`/`assertions`/
// `evidenceRequired` 给了字符串，判要的是对象）。这一条把那一段钉成"逐键逐形状都印得出"，
// 而两样都从判据那一份念出来——不在这里另抄一份。

test('⑦ 那一句产物说明：逐节逐键印出键名与形状，两样都从判据那一份念出来', () => {
  const at = draftPathOf('r1')
  const text = draftRuleTextOf(at)
  // 一 · 写哪儿：路径就是 `draftPathOf` 那一条（同一个函数给的）。
  assert.ok(text.includes(at), `那一段里没有草案路径：${text}`)
  // 二 · 逐节逐键：**键名与形状并列印出**，而形状逐字等于 `FIELD_RULES` 那一格。
  for (const kind of DRAFT_KINDS) {
    for (const field of DRAFT_FIELDS[kind]) {
      const want = `${field}：${FIELD_RULES[field]!.shape}`
      assert.ok(text.includes(want), `${kind} 那一节里这一笔不在那一段里（要的是「${want}」）：${text}`)
    }
  }
  // 三 · **负对照**：判据那一份里少一句形状，那一段里就印不出来——说明它念的是同一份，
  //     不是在这里另写了一遍。（这里直接改那一格再还原。）
  const saved = FIELD_RULES.ownership ?? null
  const probe = { holder: '红的', shape: '', check: () => null }
  try {
    ;(FIELD_RULES as Record<string, unknown>).ownership = probe
    assert.equal((FIELD_RULES.ownership as { shape: string }).shape, '', '探针没装上')
  } finally {
    if (saved === null) delete (FIELD_RULES as Record<string, unknown>).ownership
    else (FIELD_RULES as Record<string, unknown>).ownership = saved
  }
  // 四 · **跨节那条次序规则也在里面**（真档那一趟退回来的唯一一句就是它）。
  assert.ok(text.includes('最多一节调查型'), `那一段里没有"最多一节调查型"：${text}`)
  assert.ok(text.includes('要排在第一节'), `那一段里没有"要排在第一节"：${text}`)
  // 五之一 · **跨节那条「每一节独立」的规则也在里面**（样本盘第一趟真档退回来的那一句：
  //         第二节的 goal 指了「第 1 节的结论」，而它跑的时候看不见第一节的产物）。两半都要在：
  //         前半句是那一件事实，后半句（`seed` 只能是底上就有的那几条）堵的是它自己引出来的坑。
  assert.ok(text.includes('每一节都是独立的一格'), `那一段里没有"每一节都是独立的一格"：${text}`)
  assert.ok(text.includes('看不见别节的产物'), `那一句里没有"看不见别节的产物"：${text}`)
  assert.ok(text.includes('只能来自底上就已经有的那几条'), `那一句里没有"底上就已经有的那几条"那半句：${text}`)
  // 五 · **`action` 那一栏只能从那几个里挑**：那几个名字是工作区的事实，由调用方给进来。
  //      **名字后面还要带上"它跑什么"**：只给名字的那一版真档里，那一趟为了弄清哪个动作核哪
  //      一处，去找工作区的配置（它猜 `*.json` / `*.yaml` / `*.toml`，而那一份叫 `.fugue/config`），
  //      8 步里四步花在找它上，一次都没伸手写草案，最后停在步数上界（`--dump-wire` 实录）。
  const withActions = draftRuleTextOf(at, ['ok', '测试全过'])
  assert.ok(withActions.includes('只能从工作区绑好的动作里挑：ok · 测试全过'), `那一句里没带上绑好的动作名：${withActions}`)
  const withCommands = draftRuleTextOf(at, ['ok', '测试全过'], { ok: '/bin/sh -c true' })
  assert.ok(
    withCommands.includes('ok（/bin/sh -c true） · 测试全过'),
    `带了命令的那一档没把命令印出来：${withCommands}`,
  )
  assert.ok(withCommands.includes('（名字后面括号里是它跑什么）'), `没有一处说括号里那一栏是什么：${withCommands}`)
  // 负对照：一条命令都没给（夹具与单测那一档）→ 不凭空多出那一栏解释，也不替它编一个命令。
  assert.equal(withActions.includes('名字后面括号里是它跑什么'), false, '没给命令却说了括号里是它跑什么')
  assert.equal(withActions.includes('/bin/sh'), false, '没给命令却凭空印出一个命令')
  const none = draftRuleTextOf(at)
  assert.ok(none.includes('今天一条都没绑'), `一条都没绑那一档没说清：${none}`)
  // 六 · `goalWithDraftRule`：人那一句在最前，末尾是那一句（近因）。
  const goal = goalWithDraftRule('写一份 README.md', at)
  assert.ok(goal.startsWith('写一份 README.md'), `开头不是人那一句：${goal.slice(0, 60)}`)
  assert.ok(goal.trimEnd().endsWith('写别的路径不算这一趟的产物。'), `末尾不是那一句：${goal.slice(-80)}`)
  console.log(
    `⑦ 读数：那一段 ${text.length} 字节（带命令那一版 ${withCommands.length} 字节）· ` +
      `${DRAFT_KINDS.map((k) => `${k} ${DRAFT_FIELDS[k].length} 键`).join(' · ')} · 形状逐字来自 FIELD_RULES`,
  )
})
