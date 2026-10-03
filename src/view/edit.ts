// 一次视图变更的持久一半：blob（若有内容）→ 日志 → 内存。
//
// **它跨 M0 · M1 · M2，所以它不住在任何一层里**——与 `checkpoint` 同一条理由（§ 7 的
// 装配体）。两张面（`fugue write` 与 § 8.10 的 `write` 工具）共用它，各自只裁剪输出。
//
// 顺序照 § 9.3：先 blob（对象不可变，重写幂等）· 再追加日志（唯一需要保证顺序的一步）·
// 最后改内存。**校验在追加之前**：日志行一旦落下就是历史，重放会照它执行；让一个视图
// 拒绝过的变更进入日志，"重放必须一致"从根上就不成立。
//
// **为什么有的变更要落两条事件。** 改名与改权限先要有内容，而源只有下层才有的时候，内容
// 来自 base 提交——base 不是固定的，它随提交前移，于是"当时那个文件"在重放时可能已经不在
// 原处（改名过 · 删过）。所以上层没有的内容，先把它钉进日志（一条 `view/write`），再执行
// 那次变更。**重放因此不看 base 里有什么，只看日志。**
import { normMode } from '../delta.ts'
import type { Delta } from '../delta.ts'
import type { Log, LogEvent } from '../log/events.ts'
import type { AgentId, RelPath, ViewRev, WriterId } from '../terms.ts'
import type { Truth } from '../truth/contract.ts'
import type { View } from './contract.ts'
import { cloneDelta, copyBytes } from './owned.ts'

export interface EditTarget {
  log: Log
  truth: Truth
  view: View
  writer: WriterId
}

/**
 * 一次变更落下去的结果。
 *
 * `changed: false` 只有一种情形：**改权限归一之后与现值相同**（`chmodNoop`）——那次什么
 * 都不落。`mode` 就是判过的那个现值（归一过的数），好让命令面把话说准，不必自己再问一遍。
 */
export type EditResult =
  | { rev: ViewRev; changed: true }
  | { rev: ViewRev; changed: false; mode: number }

async function eventFor(agent: AgentId, rev: ViewRev, d: Delta, truth: Truth): Promise<LogEvent> {
  switch (d.kind) {
    case 'add':
    case 'modify':
      return {
        t: 'view/write',
        agent,
        path: d.path,
        rev,
        blob: await truth.putBlob(d.bytes),
        mode: d.mode,
      }
    case 'symlink':
      // 符号链接的字节就是它的 target（git 就是这么存的），对象先落盘再记这一行。
      await truth.putBlob(Buffer.from(d.target, 'utf8'))
      return { t: 'view/symlink', agent, path: d.path, rev, target: d.target }
    case 'delete':
      return { t: 'view/remove', agent, path: d.path, rev }
    case 'rename':
      return { t: 'view/rename', agent, from: d.from, to: d.to, rev }
    case 'chmod':
      return { t: 'view/chmod', agent, path: d.path, rev, mode: d.mode }
  }
}

/**
 * 这次写在上层是新增还是改写——**由视图说了算，不由调用者说**。
 *
 * 调用者说错一次，同一份日志在活路径与重放上就会给出两份不同的 `diff()`：重放那边按上层
 * 重新定名（`View.replay` 走 `kindFor`），而活路径记的是调用者递进来的那个名字。§ 8.3 要求
 * `diff()` 在重放前后逐字节一致，所以定名这一步只能有一处，且必须在视图里。
 */
function normalize(view: View, d: Delta): Delta {
  if (d.kind !== 'add' && d.kind !== 'modify') return d
  const kind = view.kindOf(d.path)
  return kind === d.kind ? d : { ...d, kind }
}

/** 只有下层才有的内容，先钉进日志；返回 null 表示这次变更不依赖下层。 */
async function pinDown(t: EditTarget, d: Delta): Promise<Delta | null> {
  if (d.kind !== 'chmod' && d.kind !== 'rename') return null
  const src = d.kind === 'chmod' ? d.path : d.from
  if (t.view.hasUpper(src)) return null
  const found = await t.view.stat(src)
  const meta = found === null ? null : { ...found }
  if (meta === null) return null
  if (meta.kind === 'file') {
    const bytes = copyBytes((await t.view.read(src)) ?? new Uint8Array(0))
    // 一定是 `add`：这条路只在"上层没有它"时才走（上面那句 hasUpper），而重放也是这么算的。
    return { kind: 'add', path: src, bytes, mode: meta.mode }
  }
  if (meta.kind === 'symlink') {
    const bytes = (await t.view.read(src)) ?? new Uint8Array(0)
    return { kind: 'symlink', path: src, target: Buffer.from(bytes).toString('utf8') }
  }
  return null
}

/**
 * 归一之后与现值相同的改权限：**没有变化**，返回那个现值；有变化（或读不出一个文件）时返回
 * null，让调用者照旧走那条会给出理由的路。
 *
 * `mode` 进来时已经收成两档之一（见 `applyEdit` 接缝上那一步），所以这里是直接比。现值从
 * `view.stat` 读：上层与下层两条路都从那里答，`chmod` 那一支的判据也是它。
 */
async function chmodNoop(view: View, path: RelPath, mode: number): Promise<number | null> {
  const m = await view.stat(path)
  if (m === null || m.kind !== 'file') return null
  return m.mode === mode ? m.mode : null
}

/**
 * 落一条变更。返回它的 rev（一次改名/改权限可能是两条事件，返回的是最后一条的）。
 *
 * **"没有变化"的那一次什么都不落**：不落 `view/chmod`（那会是一条假变更——`diff` 里报得
 * 出来，而视图里那个路径一个字节都没变），也不把它从下层拷上来（拷贝只为了让这次改得动
 * 它，而没有东西要改）。日志不动，重放自然也没有它（§ 8.3）。
 */
export async function applyEdit(target: EditTarget, raw: Delta): Promise<EditResult> {
  const named = normalize(target.view, cloneDelta(raw))
  // **模式也在接缝上归一**：`Delta` 里 chmod 的 `mode` 是 git 的那两档，而命令面递进来的是人
  // 敲的那个八进制数（`chmod 700`）。写进日志之前收一次，日志里就只剩 100644 与 100755——
  // `diff()` 报出来的于是能与 `stat` 直接对照。规则只有 `normMode` 一处，两张面都从这里过。
  const d: Delta = named.kind === 'chmod' ? { ...named, mode: normMode(named.mode) } : named
  if (d.kind === 'chmod') {
    const now = await chmodNoop(target.view, d.path, d.mode)
    if (now !== null) return { rev: target.view.rev, changed: false, mode: now }
  }
  const pin = await pinDown(target, d)
  const deltas: Delta[] = pin === null ? [d] : [pin, d]
  const first = target.view.rev + 1

  // 先问全部，再落任何一行。问与做共用同一段判断（`View.check`），所以问得过就做得成。
  for (const x of deltas) await target.view.check(x)

  const events: LogEvent[] = []
  for (let i = 0; i < deltas.length; i++) {
    events.push(await eventFor(target.view.id, first + i, deltas[i], target.truth))
  }
  for (const e of events) await target.log.append(target.writer, e)

  const got = await target.view.applyDelta(deltas)
  const want = first + deltas.length - 1
  if (got !== want) {
    throw new Error(`视图的 rev 与日志对不上：日志写到 ${want}，视图给 ${got}`)
  }
  return { rev: got, changed: true }
}
