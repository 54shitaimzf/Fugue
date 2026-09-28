// TUI 的第二版第六格：**门口那一批**——底部队列行 · 预览（按类型分派）· 二段确认 · 三档。
//
// 出处：PLAN § 5.19 第二版「五 · 门口那一批怎么批」· 第九节 `T6` 那一行 · 架构 § 9.8（人的每个
// 状态动作都是一条命令）· 架构 § 15.1.a（门由人开 · 放行的是这一批）。
//
// **落三档，不是五档**（人拍的：`a` · `p` · 升权档这一版不落）。两条原因写在这里，免得下一次被
// 当成欠账：
//
//   · 「总是放行」= 同号的批次照上次放行，与架构 § 15.1.a 和 PLAN § 5.10 的 `C4` 正面冲突
//     （"新的一批一律重停"）——那不是没来得及做，是判过不做；
//   · 「给网络 · 给写权」要 S5 的能力闸（架构 § 8.8 的 `Policy`）先落地：今天系统里没有那个东西，
//     写进配置也没有第二个读者（写一条没人读的规则就是第二份真相）。
// 与 `Esc` 第三级（丢排队草稿，`T7`）同一条做法：**级在那儿，够不够得着是另一回事**。
//
// **这一份是纯的**：进去的是门口那一批的一个投影（`GateBatch`）与界面自己那两样（选中第几份 ·
// 举过手没有），出来的是那几行原文与"这一下该做哪一件事"。**界面在这一头没有第二个入口**：行里
// 那几栏逐字来自那一批（`gateFaceOf` 只做投影与排版，一个数都不新算）——于是"队列行印的那批契约
// 与 `round go` 真发出去的是同一批"这句话，界面这一头也没地方能把它弄歪。
//
// 为什么"预览"要按类型分派：三种契约要人点头的**理由不一样**——`implement` 是"它要动这几条路径、
// 跑这几条命令"，`investigate` 是"它要去问这个问题、交这些证据"，`resolve` 是"它要动这几条冲突
// 路径"。同一句话铺三种契约，人就只能靠编号猜。
//
// **diff 不在这儿**（§ 5.19 五说"写路径给 diff"）：diff 要开真源读基线，那是 `T9` 阅读面那一格
// （"面板与 `fugue diff --json` 读同一份数据"）。这一格给的是**写入面与交付物**，逐字来自契约。
import type { Contract } from '../contract/types.ts'
import { GO_LINE } from './run.ts'
import { wrap } from './glyph.ts'

/** 门口那一档的动作。**三个**（`a` / `p` / 升权档见头注）。 */
export type GateOption = 'approve' | 'reject'

/**
 * 门口那一批的一个投影。**逐字来自 `Pending`**（`src/round/dispatch.ts` 的 `pendingOf`）：界面要的
 * 那几栏在这里点一次名，于是"队列行印的是不是放行要发的那一批"在类型上就看得出来。
 */
export interface GateBatch {
  readonly round: string
  readonly fingerprint: string
  /** 账上放过、与这一批同号的那几轮。**一个名字，不是凭证**（架构 § 15.1.a）。 */
  readonly same: readonly string[]
  readonly contracts: readonly Contract[]
}

/** 一份契约的那一张卡：一眼看它是干什么的 + 按类型分派的那几行。 */
export interface GateCard {
  readonly id: string
  readonly agent: string
  readonly kind: Contract['kind']
  /** 预览的第一行（一眼看它是干什么的）。 */
  readonly head: string
  /** 预览的其余几行（**按类型分派**：起进程给命令原文 · 写路径给写入面与交付物 · 调查给证据）。 */
  readonly detail: readonly string[]
}

/** 门口那一批在界面这一头的形状。 */
export interface GateFace {
  readonly round: string
  readonly fingerprint: string
  readonly same: readonly string[]
  readonly cards: readonly GateCard[]
}

/**
 * 一批 → 界面那一份（一份契约一张卡）。`commands` 是**绑好的动作跑什么**（名字 → argv 拼起来，
 * `cli/cmd/round.ts` 的 `actionCommandsOf` 一处读）。**认不出来就说出来**：不猜、不补（§ 5.10 的
 * `C1` ⑦ 同一条——那一条说的是模型给的动作名，这一条说的是配置里有没有它）。
 */
export function gateFaceOf(batch: GateBatch, commands: Readonly<Record<string, string>> = {}): GateFace {
  return {
    round: batch.round,
    fingerprint: batch.fingerprint,
    same: [...batch.same],
    cards: batch.contracts.map((c) => cardOf(c, commands)),
  }
}

/** 一张卡（**三种契约在这里分派**：预览那几行的措辞与内容都不一样）。 */
function cardOf(c: Contract, commands: Readonly<Record<string, string>>): GateCard {
  const cmdOf = (action: string): string => commands[action] ?? `（配置里没绑这个动作：${action}）`
  const base = { id: c.id, agent: c.agent, kind: c.kind }
  if (c.kind === 'implement') {
    const detail: string[] = []
    // **起进程那一档先给命令原文**：要人点头的首先是"它要跑什么"。
    const cmds = [...new Set(c.assertions.map((a) => cmdOf(a.action)))]
    if (cmds.length > 0) detail.push(`  起进程：${cmds.join(' · ')}`)
    detail.push(`  写路径：${c.ownedPaths.join(' · ') || '（空）'}`)
    if (c.deliverables.length > 0) detail.push(`  交付物：${c.deliverables.map((d) => `${d.path}（${d.form}）`).join(' · ')}`)
    if (c.assertions.length > 0) detail.push(`  验收：${c.assertions.map((a) => `${a.name}（${a.action}）`).join(' · ')}`)
    if (c.seed.length > 0) detail.push(`  种子：${c.seed.join(' · ')}`)
    return { ...base, head: `实现：${c.goal}`, detail }
  }
  if (c.kind === 'investigate') {
    const detail: string[] = []
    if (c.evidenceRequired.length > 0) {
      detail.push(`  要交的证据：${c.evidenceRequired.map((e) => e.artifact).join(' · ')}`)
      detail.push(`  交上来的说明：${c.evidenceRequired.map((e) => e.note).join(' · ')}`)
    } else {
      detail.push('  要交的证据：一条都没写')
    }
    if (c.seed.length > 0) detail.push(`  种子：${c.seed.join(' · ')}`)
    return { ...base, head: `调查：${c.question}`, detail }
  }
  const detail: string[] = []
  const cmds = [...new Set(c.assertions.map((a) => cmdOf(a.action)))]
  if (cmds.length > 0) detail.push(`  起进程：${cmds.join(' · ')}`)
  detail.push(`  要动的冲突路径：${c.conflictPaths.join(' · ') || '（空）'}`)
  if (c.assertions.length > 0) detail.push(`  验收：${c.assertions.map((a) => `${a.name}（${a.action}）`).join(' · ')}`)
  return { ...base, head: `解冲突：${c.conflictPaths.join(' · ')}`, detail }
}

/** 一张卡的预览那几行（第一行 + 按类型分派的那几行）。 */
export function previewLinesOf(card: GateCard): readonly string[] {
  return [card.head, ...card.detail]
}

/** 界面自己在这一块里的那两样。**纯视图状态**（进程一退就没了，也不进账）。 */
export interface GateView {
  /** 现在看的是第几份（从 0 数）。 */
  readonly at: number
  /** 举起手的那一档（`null` = 没举过）。**二段确认就靠它**。 */
  readonly armed: GateOption | null
}

export const GATE_VIEW: GateView = { at: 0, armed: null }

/** 末两行留住：**队列行**（还有几份 · 第几份）与**选项行**（三档 / 举手那一句）。 */
export const GATE_KEEP = 2

/** 第几份那个下标夹回范围里（候选变了 · 批次短了都走它）。 */
export function clampAt(n: number, at: number): number {
  if (n <= 0) return 0
  if (!Number.isInteger(at) || at < 0) return 0
  return at >= n ? n - 1 : at
}

/** 走一份（`delta` = ±1）。**夹住，不环形**：批次是一串有头有尾的契约，"翻到最后一页再按一下回到第一页"会让人以为自己没动。 */
export function stepAt(n: number, at: number, delta: number): number {
  return clampAt(n, clampAt(n, at) + delta)
}

/** 现在看的那一份（一份都没有时 `null`）。 */
export function cardAt(face: GateFace, at: number): GateCard | null {
  return face.cards[clampAt(face.cards.length, at)] ?? null
}

/** 那一下按键在门口这一块里该做的那一件事。 */
export type GatePress =
  | { readonly t: 'arm'; readonly option: GateOption; readonly view: GateView }
  | { readonly t: 'do'; readonly option: GateOption; readonly view: GateView }
  | { readonly t: 'cancel'; readonly view: GateView }
  | { readonly t: 'none' }

/**
 * **二段确认**的判据只有这一处：
 *
 *   · 按 `y`/`n`：没举过手 → 举手（`arm`，什么都不做）；举的就是它 → **生效**（`do`）；
 *     举的是别的一档 → **换成那一档**（重新举手，仍然什么都不做）；
 *   · `Enter`：举过手才生效（`do`），**没举过手什么都不做**——那一条是负对照：不举手绝不放行；
 *   · `Esc`：收起这一块（`cancel`），举手那一栏一并清掉。
 */
export function pressGate(view: GateView, what: GateOption | 'confirm' | 'cancel'): GatePress {
  if (what === 'cancel') return { t: 'cancel', view: { ...view, armed: null } }
  if (what === 'confirm') {
    if (view.armed === null) return { t: 'none' }
    return { t: 'do', option: view.armed, view: { ...view, armed: null } }
  }
  if (view.armed === what) return { t: 'do', option: what, view: { ...view, armed: null } }
  return { t: 'arm', option: what, view: { ...view, armed: what } }
}

/**
 * 那一档要跑的那一条命令（`approve` 就是放行门口那一批：`round go`——**与 `g` 那一键同一条**）。
 * `reject` 不跑命令：拒了就是**一个字节都不落**（门照旧停着，处境一点没动）。
 */
export function lineOf(option: GateOption): string {
  return option === 'approve' ? GO_LINE : ''
}

/** 队列行：**还有几份 · 第几份 · 这一份是谁**（`index/total` 就是 § 5.19 那一条）。 */
export function gateQueueRowOf(face: GateFace, at: number): string {
  const n = face.cards.length
  if (n === 0) return '门口这一批一份契约都没有（门不会停在这样一批上——报出来）'
  const i = clampAt(n, at)
  const c = face.cards[i] as GateCard
  return `还有 ${n} 份等你点头 · 第 ${i + 1}/${n} 份 · ${c.id} · ${c.agent} · ${c.kind}（↑↓ 翻）`
}

/** 选项行：**三档**；举过手就把那一句"再按一次"说出来（二段确认要对人可见）。 */
export function optionRowOf(view: GateView): string {
  if (view.armed === 'approve') return '再按一次 y（或 Enter）就放行这一批 · 别的键换一档 · Esc 中止'
  if (view.armed === 'reject') return '再按一次 n（或 Enter）就拒这一批 · 别的键换一档 · Esc 中止'
  return '放行一次(y) · 拒(n) · 中止(Esc)'
}

/**
 * 门口那一块的那几行（**末两行是队列行与选项行**，见 `GATE_KEEP`）。`columns` 是入参：超宽的那几行
 * 在这一份里折——`frame.ts` 那一层对"横贯整栏"的行只截不折，而这里的一句话被截掉尾巴就没用了。
 *
 * **次序是从下往上定的**：末两行是人要按的那两样（队列行 · 选项行），预览排在它们上面——装不下的
 * 时候先让位的是预览（`frame.ts` 那一头按 `GATE_KEEP` 留行）。
 */
export function gateRowsOf(o: { readonly face: GateFace; readonly view: GateView; readonly columns: number }): readonly string[] {
  const card = cardAt(o.face, o.view.at)
  const head =
    card === null ? [] : previewLinesOf(card).flatMap((one) => (o.columns > 0 ? [...wrap(one, o.columns)] : [one]))
  return [...head, gateQueueRowOf(o.face, o.view.at), optionRowOf(o.view)]
}
