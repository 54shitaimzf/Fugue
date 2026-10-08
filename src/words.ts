// **界面词表**（第二幕 ⑥）：主面上那批词只在这里写一遍，两处点名面（`ui/frame.ts` 的面板 ·
// `probe/status.ts` 的命令行那一面）都从它取。出处：PLAN § 5.19 · 交接单 § 五 ⑥ ·
// 决策材料问九（主面改人话 · 主面一律 `验收` · 每个界面词加一列"架构里叫什么"）。
//
// **为什么收成一份**（一处真相那条）：同一批标签原先在 `ui/frame.ts` 与 `probe/status.ts` 两处各写
// 一遍——改一个词要顺着两处找，漏一处两面就说两样的话，而屏幕上不报错。收进来之后：
//
//   · 一个界面词只在这里出现一次（`words.test.ts` ③ 拿"两处源码去注释之后不再出现那几个字面量"
//     量这一条——**它抓得住**：把那几处改回中文字面量，那一条当场红）；
//   · 每个词带一列**架构里叫什么**（同一个概念在架构篇与 `--json` 里叫什么），人查得到来路；
//   · 一面一个词：同一个概念不许两个界面词（`words.test.ts` ① 量"界面词不重名"）。
//
// **改词的判据**（交接单 § 五 ⑥）：新读者一遍懂 · 一事一词。候选起点取自决策材料问九，改动与偏差
// 写在提交信息与停点报告里：
//
//   · `处境` → `进展` · `读数` → `结果与花费`（两栏的名字：左边是"走到哪儿了"，右边是"花了什么"）；
//   · `契约` → `任务`（同一个东西两个词里挑一个：`任务`在界面词里更直白；`契约`仍是架构里的名字，
//     见 `arch` 那一栏）；
//   · `动作 N` → `运行命令 N 次`（那一格数的是起过几条命令，不是"做了几件事"）；
//   · `停：没停` → `还在跑` / `N 步就停（停因）`（零那一条印成一个状态，不印成一个"没有"）；
//   · `折叠尝试` → `合并试了`（`attempts` 的定义本幕没读到构造处，按决策材料先按一个词出；
//     **什么条件下改主意**：核清它到底是什么之后，如果它其实是两件事，再分开命名一次）；
//   · `调` 与 `调用` 是同一个概念的两个词 → 都取 `调用`（一事一词；左边那一格与用量那一行同源）。
//
// **值层不在这一份的管辖里**：`--json` 的字段名（`contracts` · `attempts` · `actions` ·
// `assertions`）与账上的原话（`agent/stop` 那条事件的 `stopped` 值）一个字不动——这一份换的是**人面**
// 上那几个词。`statusOf` 出来的那一份快照该是什么还是什么（`words.test.ts` ④）。
//
// **还没进来的那几面**（偏差写档）：事件流（`ui/stream.ts`）· 阅读面（`ui/read.ts`）· `round` 那几条
// 人面（`cli/cmd/round.ts`）里也印着 `契约` 与 `停：`——那几面是**信息收拢那一格（⑦）**按格清点的地方
// （哪几格留在主面 · 哪些原始编号收掉，都在那一格定），随它一起改，免得同一批字改两遍。

/** 一个界面词：**印出去的那一个** ＋ **架构里叫什么**（追溯用，不进渲染）。 */
export interface Word {
  /** 印在主面上的那一个词。 */
  readonly face: string
  /** 同一个概念在架构篇 / `--json` 字段名里叫什么（人查来路用，**不印出去**）。 */
  readonly arch: string
}

/**
 * 表只有这一张：键是"这一格是什么意思"，值是那一个词与它的来路。**名单从它推**（`WORDS` ·
 * `WORD_KEYS`），不另抄一遍——与 `ui/theme.ts` 的 `SLOT_MEANING` → `SLOTS` 同一手。
 */
export const WORD_TABLE = {
  chat: { face: '对话', arch: '对话主面（第二幕 ⑦ 的缺省视图；架构 § 9.8 说的「可附着 TUI」那一张脸）' },
  progress: { face: '进展', arch: '处境（第二幕 ⑦ 之后是 `Tab` 轮换出去的那一档视图）' },
  spending: { face: '结果与花费', arch: '读数（同上，另一档视图）' },
  round: { face: '轮次', arch: 'round（`round/state` 的 round 栏）' },
  state: { face: '状态', arch: 'state' },
  transitions: { face: '转移', arch: 'transitions' },
  rejects: { face: '打回', arch: 'rejects' },
  agent: { face: '格', arch: 'writer（每个 writer 一格）' },
  calls: { face: '调用', arch: 'calls（agent 那一格与 usage.calls 同源——一事一词）' },
  steps: { face: '步', arch: 'steps' },
  invocations: { face: '工具调用', arch: 'invocations' },
  commands: { face: '运行命令', arch: 'actions' },
  moving: { face: '还在跑', arch: 'agent/stop 的 stopped === null' },
  halted: { face: '就停', arch: 'agent/stop 的 stopped（`N 步就停（停因）`）' },
  task: { face: '任务', arch: 'contracts（架构里叫"契约"）' },
  merges: { face: '合并试了', arch: 'attempts（架构里叫"折叠尝试"；定义待核）' },
  conflicts: { face: '冲突', arch: 'conflicts' },
  accepts: { face: '验收', arch: 'assertions（架构里叫"断言"；--json 的字段名不动）' },
  paths: { face: '路径', arch: 'paths（`contract/issue` 的写入面 · `resolve` 的冲突路径）' },
  gate: { face: '门口', arch: '门（架构 § 15.1.a：由人开 · 放行的是这一批；账上就是 `round/state` 停在 `Planning`）' },
  usage: { face: '用量', arch: 'usage' },
  events: { face: '事件', arch: 'events' },
  last: { face: '最近', arch: 'last' },
  denies: { face: '内核拒', arch: 'denies（`run/end` 那条的 `denied`）' },
  bounds: { face: '边界挡', arch: 'bounds（`bound/deny` 的条数）' },
} as const satisfies Readonly<Record<string, Word>>

/** 表里那些键（**从表推**，与 `ui/theme.ts` 的 `SLOTS` 同一手）。 */
export type WordKey = keyof typeof WORD_TABLE

/** 表里那些键的名单（次序就是表里的次序）。 */
export const WORD_KEYS: readonly WordKey[] = Object.keys(WORD_TABLE) as readonly WordKey[]

/** 键 → 印出去的那一个词（**从表推**，不手抄）。 */
export const WORDS: Readonly<Record<WordKey, string>> = Object.fromEntries(
  WORD_KEYS.map((k) => [k, WORD_TABLE[k].face]),
) as Readonly<Record<WordKey, string>>

/** 键 → 架构里叫什么（追溯用；`--json` 与架构篇那一侧的名字）。 */
export function archNameOf(k: WordKey): string {
  return WORD_TABLE[k].arch
}

/**
 * **状态那一栏印出去的名字**：`RoundState`（架构 § 8.13）那十个取值 → 主面上的词。
 *
 * 为什么单独一张：`WORDS.state` 是"这一栏叫什么"（`状态`），这一张是"这一栏里的那个值，人话怎么
 * 说"。`--json` 那一面照旧吐 `"state":"Rebuilding"`——**裸值一个字不动**，换的只是渲染。
 *
 * 表里没有的取值**照原样印**（新状态落地时先让人看见英文，好过印一个猜出来的词）。
 */
export const STATE_FACE: Readonly<Record<string, string>> = {
  Idle: '准备就绪',
  Planning: '准备计划',
  Delegated: '准备执行',
  Working: '正在执行',
  Collecting: '收集结果',
  Merging: '合并结果',
  Verifying: '验收',
  Committed: '已完成',
  Rebuilding: '修改中',
  Aborted: '已中止',
}

/** 状态那一个值人话怎么说（表里没有就照原样——不猜）。 */
export function stateFaceOf(state: string): string {
  return STATE_FACE[state] ?? state
}
