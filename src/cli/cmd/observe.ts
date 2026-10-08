// fugue 的观察组（`log` · `status` · `watch`）——U4c 自 `cli/fugue.ts` 抽出。
// 出处：架构 § 9.6 那张观察表 · PLAN § 5.18 的 W12/W13。
// **全是纯读**：不建视图、不取锁、不追加——所以它们排在建视图那一组之前。
//
// **`tui` 不住在这里了**（0.4.3 第一幕 ①）：它搬进 `ui/console.ts`，读源换成事件通道
// （`serve/source.ts`）。两条理由：界面那一侧从此不 import 账本的直连模块（`log/log.ts` ·
// `probe/watch.ts`），而这一份剩下的三条命令是**命令行自己的读**——它们开账本口是对的。
// 那一条静态断言（`tools/check-ui-direct.ts`）因此有一个干净的根：`ui/console.ts`。
//
// **这一份今天是被遮住的老路**（0.4.3 施工时实测发现，记进疑点清单）：`log` · `status` ·
// `watch` 三条都已在值层登记（`value/registry.ts` 的 `VALUE_LAYER`），`cli/fugue.ts` 在值层
// 那一支就返回了，所以这个模块的三个出口**一条都走不到**——它们是"没迁的命令走老路"那个形状
// 留下来的那一份。**改这里不会有任何效果**（0.4.3 的 `--header` 第一版就打在这儿，跑出来一个
// 字节没变才发现）。处置：0.5.0 收口时随 session 读口一并收掉；在那之前要看两股输出就改
// `value/observe.ts`。
import type { LogEvent } from '../../log/events.ts'
import { openLog } from '../../log/log.ts'
import type { LogPos } from '../../terms.ts'
import { phaseOf } from '../../model/price.ts'
import { readCatalog } from '../../model/catalog.ts'
import { readings, readingsLines } from '../../probe/status.ts'
import type { StatusRow } from '../../probe/status.ts'
import { cursorsOf, follow, readNew, tokenOf } from '../../probe/watch.ts'
import type { Cursors } from '../../probe/watch.ts'
import { intervalOf } from '../flags.ts'
import { readConfig } from '../../config.ts'
import { actionCommandsOf } from '../../round/actions.ts'
import { emitJson, emitLine, usageFail } from '../shared.ts'
import { PHRASES } from '../../phrases.ts'

export function emit(pos: LogPos, e: LogEvent, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ pos, e }) + '\n')
    return
  }
  const { t, ...payload } = e as { t: string } & Record<string, unknown>
  const keys = Object.keys(payload)
  const brief = keys.map((k) => `${k}=${JSON.stringify(payload[k])}`).join(' ')
  process.stdout.write(`${pos.writer}\t${pos.seq}\t${t}\t${brief}\n`)
}

// 观察组的四张开关表（LOG/WATCH/TUI/STATUS_FLAGS）与 `unknownFlagsOf` 自 U8 起收进
// `fugue.ts` 的 FLAGS_OF（全命令族一张张声明过的表，分发处统一过）——这一组不再各查各的。

/**
 * `status --once`：**把账重放一次，给人看这一刻的处境**（PLAN § 5.18 的第 12 格）。
 *
 * 纯读两头都占了：开日志口**不带 `write`**（不取锁、不追加）、不建视图、不碰真源。`--once` 是
 * 今天唯一的一档——跟随是另一条命令（`watch --follow`），两条各自只说一件事，不在这里合流。
 *
 * **序 32 给它加了两个开关**：`--metrics`（八元指标）与 `--report`（打回三数），与 `round run` /
 * `round work` 上同名同义——同一个来源（`probe/metrics.ts` · `probe/round.ts` 那两处折法）、
 * 同一个渲染（`readingsLines`）。于是 `--json` 那一份对象去掉 `width` / `height` 就是 TUI 的输入
 * 契约（`ui/frame.ts` 的 `FrameInput`）：命令面与第一个渲染器读的是同一份，不许有两份。
 */
/**
 * **这一台机器上已绑定动作的命令行**（账上「走法」那一栏的第二半用它）。
 *
 * 从配置里读（`actions` 那一节），解析只有一处（`boundary/binding.ts` 的 `readBinding`，`round.ts`
 * 的 `actionCommandsOf` 包了一圈）。**读不出来就是空的那一份**：这一栏说的是「读账的人手里有什么」，
 * 配置坏了不该让整条 `status` 读不出来——而少了这一半这件事账自己会说（`Ledger.boundCommands === 0`
 * 那一行）。
 */
async function boundCommandsOf(root: string): Promise<readonly string[]> {
  try {
    return Object.values(actionCommandsOf(await readConfig(root)))
  } catch {
    return []
  }
}

export async function statusCmd(
  root: string,
  flags: Map<string, string | true>,
  json: boolean,
): Promise<number> {
  const log = openLog(root)
  try {
    // 钱那一栏要一个档：**读的时候按当时的钟算**（官方价目分峰谷两档）。
    const phase = phaseOf(new Date())
    // 价目与模型目录按这一台算（P2d：`~/.fugue/models.json` 在就是它）。
    const cat = readCatalog()
    const only = flags.get('agent')
    const r = await readings(log, {
      // 钟那三栏（架构 § 9.2）：**看一眼账上的回拨**——它是读得出来的事实，不是账的错。
      clocks: await log.clocks(),
      metrics: flags.has('metrics'),
      report: flags.has('report'),
      // **每调用成本台账**（本站 ④）：钱要价目与峰谷档，走法那一栏要这一台已绑定动作的命令行。
      ...(flags.has('ledger') ? { ledger: { cat, phase, bindings: await boundCommandsOf(root) } } : {}),
      ...(typeof only === 'string' ? { agent: only } : {}),
    })
    if (json) {
      // **没要的那一栏不出现**（不是空数组）：`JSON.stringify` 丢掉没定义的键，于是这一份对象
      // 去掉 `width` / `height` 就是 `FrameInput`。
      emitJson(r)
      return 0
    }
    for (const line of readingsLines(r, { phase, cat })) emitLine(line)
    return 0
  } finally {
    await log.close()
  }
}


/**
 * `--tail N`（U15）：**首趟**永久行只写尾部 N 条——旧账几百行时不用翻半天才到活的那些；之后的
 * 新行照常增量。不给 = 全印（与从前逐字节相同）。要一个正整数，别的都是用法错（退出码 2，
 * 与 `--interval` 同一道门）。跳过的前几条**不折了也不印**：旧账想全看有 `fugue log` /
 * `fugue watch`，这一档是"接着看"的入口。
 */

/**
 * `watch`：**顺着 NDJSON 账读**（PLAN § 5.18 的第 13 格）。
 *
 * 两档只有一件事不同：不给 `--follow` 就把账上有的念一遍就停；给了就一直跟着，直到人按 Ctrl-C
 * （`SIGINT` → 拨信号 → 生成器收尾 → **退出码 0**：人喊停不是失败）。
 */
export async function watchCmd(
  root: string,
  flags: Map<string, string | true>,
  json: boolean,
): Promise<number> {
  const interval = intervalOf(flags)
  if (typeof interval === 'string') return usageFail(interval, json)
  const intervalMs = interval
  const from = resumeFrom(flags)
  if (typeof from === 'string') return usageFail(from, json)
  const only = flags.get('agent')
  const log = openLog(root)
  const ac = new AbortController()
  const onSig = (): void => ac.abort()
  process.on('SIGINT', onSig)
  const print = (row: StatusRow): void => {
    if (typeof only === 'string' && row.pos.writer !== only) return
    emit(row.pos, row.e, json)
  }
  // **游标自己记**（每个 writer 一个）：记的是"读到哪了"，不是"印了哪几条"——`--agent` 只筛印出去
  // 的那些，而游标串要能接着读整份账。
  const cursors: Record<string, number> = { ...(from ?? {}) }
  const keep = (row: StatusRow): void => {
    if (row.pos.seq > (cursors[row.pos.writer] ?? 0)) cursors[row.pos.writer] = row.pos.seq
  }
  try {
    if (!flags.has('follow')) {
      const p = await readNew(log, from ?? {})
      for (const row of p.rows) {
        keep(row)
        print(row)
      }
      return 0
    }
    // 一趟一批（U4）：印出去的字节与逐条那一档逐字相同——变的是跟随器吐的形状，不是印的内容。
    const opts = { intervalMs, signal: ac.signal, ...(from === undefined ? {} : { from }) }
    for await (const batch of follow(log, opts)) {
      for (const row of batch) {
        keep(row)
        print(row)
      }
    }
    return 0
  } finally {
    process.removeListener('SIGINT', onSig)
    await log.close()
    // **退出时印游标串**（只在跟随那一档）：接着读的入口。走 stderr——stdout 只放事件流（§ 9.8）。
    if (flags.has('follow')) {
      process.stderr.write(PHRASES.resumeHead + '：--resume ' + tokenOf(cursors) + '\n')
    }
  }
}

