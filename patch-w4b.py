# W4 续：补 faceOf 导入 + 问人那一条的断言
import io, sys

FAIL = []

def rw(path, fn):
    s = io.open(path, encoding='utf-8').read()
    out = fn(s)
    if out == s:
        FAIL.append('NO_CHANGE ' + path); return
    io.open(path, 'w', encoding='utf-8').write(out)
    print('OK', path)

def sub(s, old, new, path):
    if old not in s:
        FAIL.append('MISS in %s :: %s' % (path, old[:70])); return s
    return s.replace(old, new, 1)

def p_import(s):
    return sub(s, "import type { DenyAsk, PlanAsk, RunAsk, TodoItem, ToolHost } from '../tools/execute.ts'",
               "import type { AskItem, DenyAsk, PlanAsk, RunAsk, TodoItem, ToolHost } from '../tools/execute.ts'\nimport { faceOf } from '../tools/execute.ts'", 'dispatch.test.ts')

rw('src/capability/dispatch.test.ts', p_import)

TEST9 = """
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
"""

def p_add(s):
    if '⑨ ask_user_question' in s:
        FAIL.append('ALREADY'); return s
    if not s.endswith('\n'):
        s += '\n'
    return s + TEST9

rw('src/tools/execute.test.ts', p_add)

if FAIL:
    print('\n'.join(FAIL)); sys.exit(1)
