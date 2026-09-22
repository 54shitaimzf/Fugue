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
import type { Delta } from '../delta.ts'
import type { Log, LogEvent } from '../log/events.ts'
import type { AgentId, ViewRev, WriterId } from '../terms.ts'
import type { Truth } from '../truth/contract.ts'
import type { View } from './contract.ts'

export interface EditTarget {
  log: Log
  truth: Truth
  view: View
  writer: WriterId
}

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
  const meta = await t.view.stat(src)
  if (meta === null) return null
  if (meta.kind === 'file') {
    const bytes = (await t.view.read(src)) ?? new Uint8Array(0)
    // 一定是 `add`：这条路只在"上层没有它"时才走（上面那句 hasUpper），而重放也是这么算的。
    return { kind: 'add', path: src, bytes, mode: meta.mode }
  }
  if (meta.kind === 'symlink') {
    const bytes = (await t.view.read(src)) ?? new Uint8Array(0)
    return { kind: 'symlink', path: src, target: Buffer.from(bytes).toString('utf8') }
  }
  return null
}

/** 落一条变更。返回它的 rev（一次改名/改权限可能是两条事件，返回的是最后一条的）。 */
export async function applyEdit(target: EditTarget, raw: Delta): Promise<ViewRev> {
  const d = normalize(target.view, raw)
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
  return got
}
