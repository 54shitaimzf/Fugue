// 第二幕 ⑥ 的断言：**界面词只住词表一处**，而且两个点名面真的照表印。
//
// 一条会失败的断言（不是"看着对"）：③ 把 `ui/frame.ts` 与 `probe/status.ts` **去注释之后**读一遍，
// 那几个旧词一个都不许再出现——把任意一处改回中文字面量，③ 当场红。②量的是**印出来的字**（折一帧 +
// `linesOf` 一遍），所以"表改了但那一面没跟着改"也抓得住（比如 `WORDS.task` 换成"活"而站点漏改）。
//
// 负对照（成对）：把 `frame.ts` 右栏那一句改回 `契约 ${…}` → ②（印出来的字）与 ③（源码）同时红；
// 只改词表那一格（`任务` → `活`）而不动站点 → ② 红而 ③ 照旧绿（正是"表与两面走岔"那一种）。
//
// ④ 量的是**值层没被顺手翻**：`statusOf` 的答案里那几个字段名（`contracts` · `attempts` ·
// `actions` · `assertions`）照旧——这一份换的是人面上的词，不是 `--json` 的字段名。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { STATE_FACE, WORD_KEYS, WORDS, WORD_TABLE, archNameOf, stateFaceOf } from './words.ts'
import type { WordKey } from './words.ts'
import { statusOf } from './probe/status.ts'
import { linesOf } from './probe/status.ts'
import type { StatusRow } from './probe/status.ts'
import { readCatalog } from './model/catalog.ts'
import { frameOf } from './ui/frame.ts'
import { STATES } from './round/machine.ts'
import type { RoundState } from './terms.ts'

/** 一份最小的账：一条轮次链 + 一格 agent（面板与 `status` 两面都印得出来）。 */
const ROWS: readonly StatusRow[] = [
  { pos: { writer: 'round', seq: 1 }, e: { t: 'round/state', round: 'r1' as never, from: 'Idle' as never, to: 'Planning' as never } },
  { pos: { writer: 'agent/r1/1', seq: 1 }, e: { t: 'agent/stop', agent: 'agent/r1/1' as never, why: 'steps' as never, steps: 2 } as never },
]

/** 那几个**从主面上退下去**的词（去注释之后一个都不许再出现在那两个文件里）。 */
const RETIRED: readonly string[] = ['契约', '折叠尝试', '停：', '处境', '读数', '动作 ']

/**
 * 去掉注释（`//` 与 `/* … *​/`），**字符串与模板字面量原样留着**——要查的正是印出去的那些串。
 * 走一遍状态机而不是拿正则切：正则分不清"注释里的 `//`"与"串里的 `//`"。
 */
function codeOf(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i] as string
    if (c === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i)
      i = j < 0 ? src.length : j
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2)
      i = j < 0 ? src.length : j + 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === c) break
        j += 1
      }
      out += src.slice(i, j + 1)
      i = j + 1
      continue
    }
    out += c
    i += 1
  }
  return out
}

const readSrc = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('① 词表：名单从表推 · 一个界面词只配一个概念（一事一词）· 每个词带"架构里叫什么"', () => {
  assert.ok(WORD_KEYS.length >= 18, `表里该有主面那一批词，拿到 ${WORD_KEYS.length} 条`)
  assert.deepEqual([...WORD_KEYS], Object.keys(WORD_TABLE), '名单从表推（不另抄一遍）')
  for (const k of WORD_KEYS) {
    assert.equal(WORDS[k], WORD_TABLE[k].face, `${k} 的词从表推`)
    assert.ok(WORD_TABLE[k].face !== '', `${k} 有一个印出去的词`)
    assert.ok(archNameOf(k) !== '', `${k} 带一列"架构里叫什么"（追溯用）`)
  }
  // 一事一词：同一个界面词不许挂在两个键上（反过来说，两个键可以共用一个词——那是同一个概念）。
  const faces = WORD_KEYS.map((k) => WORDS[k])
  assert.equal(new Set(faces).size, faces.length, `界面词不重名：${faces.join(' · ')}`)
  console.log(
    `① 读数：表里 ${WORD_KEYS.length} 个词（${WORD_KEYS.map((k) => `${WORDS[k]}←${k}`).join(' · ')}）· 界面词重名 0 处`,
  )
})

test('② 两个点名面照表印：新词在 · 旧词一个都不在', () => {
  const snap = statusOf(ROWS)
  const cat = readCatalog()
  // 三档视图各印自己那一批词（第二幕 ⑦）：记账与验收在读数视图，处境那一批在处境视图，对话视图
  // 印的是轮次头与在飞那几格——**不拿对话视图去量读数那一批词**（那正是这一站把格分开的结果）。
  const at = { snapshot: snap, permanent: [], width: 100, height: 14 } as const
  const frameSpending = frameOf({ ...at, view: 'spending' }).lines.join('\n')
  const frameProgress = frameOf({ ...at, view: 'progress' }).lines.join('\n')
  const frameChat = frameOf(at).lines.join('\n')
  const cmd = linesOf(snap, { cat }).join('\n')
  for (const [name, text] of [
    ['面板 · 读数视图（ui/frame.ts）', frameSpending],
    ['命令行人面（probe/status.ts）', cmd],
  ] as const) {
    for (const w of RETIRED) {
      assert.ok(!text.includes(w), `${name} 上不该再出现「${w}」这两个字：\n${text}`)
    }
    for (const k of ['task', 'merges', 'conflicts', 'accepts'] as readonly WordKey[]) {
      assert.ok(text.includes(WORDS[k]), `${name} 上该印「${WORDS[k]}」`)
    }
  }
  // 三档视图的框名从词表取（第二幕 ⑦ 之后没有「两栏」这回事了，名字挂在框名那一行）。
  assert.ok(frameProgress.includes(WORDS.progress), `处境视图的框名该叫「${WORDS.progress}」`)
  assert.ok(frameSpending.includes(WORDS.spending), `读数视图的框名该叫「${WORDS.spending}」`)
  assert.ok(frameChat.includes(WORDS.chat), `对话视图的框名该叫「${WORDS.chat}」`)
  // 对话视图也照表印：轮次头与在飞那几格在它上面，旧词一个都不许有。
  for (const w of RETIRED) assert.ok(!frameChat.includes(w), `对话视图上不该出现「${w}」：\n${frameChat}`)
  assert.ok(!frameChat.includes(WORDS.invocations), '调用计数留在进展视图')
  assert.ok(frameProgress.includes(WORDS.agent) && frameProgress.includes(WORDS.invocations), '进展视图保留执行详情')
  // 主面一律 `验收`，不许出现 `断言`（`--json` 的字段名 `assertions` 不在此列——它在 ④ 里）。
  assert.ok(!frameSpending.includes('断言') && !cmd.includes('断言'), '主面上不许出现「断言」')
  console.log(
    `② 读数：读数视图 ${frameSpending.split('\n').length} 行 · 处境视图 ${frameProgress.split('\n').length} 行 · ` +
      `对话视图 ${frameChat.split('\n').length} 行 · 命令行人面 ${cmd.split('\n').length} 行；` +
      `三面上「${RETIRED.join('」「')}」各 0 处 · 「${WORDS.task}」「${WORDS.merges}」「${WORDS.accepts}」都在`,
  )
})

test('③ 六处源码去注释之后不再出现那几个词（这就是"主面上中文字面量即红"）', () => {
  // 六处＝用词表的词那几面：面板（`ui/frame.ts`）· 命令行那一张人读脸（`probe/status.ts`）·
  // **对话流那一栏**（`ui/stream.ts`，第二幕 ⑦ 收进来的）· **视图表**（`ui/views.ts`，
  // 三档视图的名字）· **门口那一批**（`ui/gate.ts`，第二幕 ⑧ 的结论行与那几张卡的标签）·
  // **`round` 那几条人面**（`cli/cmd/round.ts`，这一封炉收进来的）。
  // 阅读面与诊断消息不在这条断言里，口径写在 `words.ts` 头注那一段（各带什么条件下改主意）。
  for (const rel of [
    './ui/frame.ts',
    './probe/status.ts',
    './ui/stream.ts',
    './ui/views.ts',
    './ui/gate.ts',
    './cli/cmd/round.ts',
  ] as const) {
    const code = codeOf(readSrc(rel))
    for (const w of RETIRED) {
      assert.ok(!code.includes(w), `${rel} 的代码里还留着「${w}」——那一批词只许住 src/words.ts 一处`)
    }
    // 反面：这一份确实读到了（不然上面那几条量的是空气）。
    assert.ok(code.includes('WORDS.'), `${rel} 该从词表取词（读到的是 ${code.length} 字节）`)
  }
  console.log(`③ 读数：六份源码去注释后各 ${RETIRED.length} 个旧词 0 处命中 · 六份都从 WORDS 取词`)
})

test('④ 值层没被顺手翻：--json 那几个字段名照旧（换的只是人面那几个词）', () => {
  const s = statusOf(ROWS)
  assert.equal(typeof s.contracts, 'number', '`contracts`（架构里的"契约"）照旧')
  assert.equal(typeof s.attempts, 'number', '`attempts`（架构里的"折叠尝试"）照旧')
  assert.equal(typeof s.accepts.accepts, 'number', '`accepts.accepts`（架构里的"断言"那个数）照旧')
  assert.equal(typeof s.usage.calls, 'number', '`usage.calls` 照旧')
  assert.ok(s.agents.every((a) => typeof a.actions === 'number'), '`actions` 照旧（人面上叫"运行命令"）')
  assert.ok(s.agents.every((a) => 'stopped' in a), '`stopped` 照旧（人面上叫"还在跑"）')
  console.log(
    `④ 读数：contracts=${s.contracts} · attempts=${s.attempts} · accepts.accepts=${s.accepts.accepts} · ` +
      `usage.calls=${s.usage.calls} · agents=${s.agents.length} 格（字段名一个没动）`,
  )
})

test('⑤ 状态那一栏印的是词表里那个词：名单从 STATES 推 · 十个取值各一个中文词 · 三档视图里没有裸英文状态名', () => {
  // 名单**从状态机那一份推**（`round/machine.ts` 的 `STATES`，架构 § 8.13 那十个取值）——不在这一份
  // 另抄一遍：新状态落地时，`STATE_FACE` 少一格这一条就红（`stateFaceOf` 会照原样印英文）。
  assert.deepEqual(
    [...Object.keys(STATE_FACE)].sort(),
    [...STATES].sort(),
    `STATE_FACE 的名单该是 STATES 那十个取值，拿到 ${Object.keys(STATE_FACE).join(' · ')}`,
  )
  const at = (state: RoundState) => ({
    snapshot: statusOf([
      { pos: { writer: 'round', seq: 1 }, e: { t: 'round/state', round: 'r1' as never, from: 'Idle' as never, to: state as never } },
    ]),
    permanent: [],
    width: 100,
    height: 14,
  })
  const seen: string[] = []
  for (const state of STATES) {
    const face = stateFaceOf(state)
    assert.equal(face, STATE_FACE[state], `${state} 那一格从表取词`)
    assert.doesNotMatch(face, /[A-Za-z]/, `${state} 的词该是中文（拿到 ${face}）`)
    for (const view of ['chat', 'progress', 'spending'] as const) {
      const text = frameOf({ ...at(state), view }).lines.join('\n')
      assert.ok(!text.includes(state), `${state} 那一档的 ${view} 视图里印出了裸英文状态名：\n${text}`)
      if (text.includes(face)) seen.push(`${state}→${face}`)
    }
    // 三档视图里至少有一处把这一格印出来（状态那一栏在轮次头那一行，它不一定三档都在）。
    assert.ok(
      seen.some((one) => one.startsWith(`${state}→`)),
      `${state} 那一格在三档视图里一处都没印出来——那这一条量的是空气`,
    )
  }
  console.log(`⑤ 读数：${STATES.length} 个取值各一个中文词 · 三档视图里裸英文状态名 0 处 · 印出来过 ${seen.length} 处`)
})
