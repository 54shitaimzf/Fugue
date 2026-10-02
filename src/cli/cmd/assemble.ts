// fugue 的装配组（`assemble`）与真驱动那一档要的三样（`publishedCatalog` · `modelLimitOf` ·
// `--dump-wire` 的落点守卫 `dumpWireDir`）——U4c 自 `cli/fugue.ts` 抽出，内容逐字未动
// （出处：架构 § 9.6 的装配行 · § 20 S6 的交付物 · PLAN § 5.8 的口径一）。`driverSupport`
// 与 `wireFlagsOf` 还在 `fugue.ts`（轮次那一组，U4d 再动），它们从这一份接这三样。
import { isAbsolute, relative, resolve } from 'node:path'
import { readConfig } from '../../config.ts'
import type { ConfigDoc } from '../../config.ts'
import { refFor } from '../../identity.ts'
import { openTruth } from '../../truth/truth.ts'
import { assemble, firstDivergence, hashOf } from '../../assemble/assemble.ts'
import { PROTOCOLS, protocolNamed } from '../../assemble/protocol.ts'
import { checkConstraints, formatViolation } from '../../assemble/constraints.ts'
import { emptyState, HOLDER, SourceError, sourcesFor } from '../../assemble/sources.ts'
import type { AgentCoord } from '../../assemble/sources.ts'
import { stateWithState } from '../../assemble/sources-state.ts'
import { RoundRunError } from '../../round/execute.ts'
import { modelDeclOf, readCatalog } from '../../model/catalog.ts'
import type { Catalog } from '../../model/catalog.ts'
import { implementedNames, publishedTools } from '../../tools/execute.ts'
import { CATALOG_STATES, TOOL_NAMES, catalog } from '../../tools/catalog.ts'
import { emitJson, emitLine, fail, selectedModelId, usageFail } from '../shared.ts'

/**
 * `fugue assemble <protocol> [--agent <id>] [--against <protocol>] [--json]`（架构 § 9.6 的装配行 ·
 * § 20 S6 的交付物）。
 *
 * **它是结账口**：三区哈希 · 每区的字节数 · 第一处不同（给了 `--against` 时）· 四条约束的检查
 * 结果，一次全印出来。命令行这一层只做三件事——解析参数 · 把结构化结果排成两列 · 决定退出码；
 * 段值从哪来住在 `sources.ts`，装配住在 `assemble.ts`，四条约束住在 `constraints.ts`。
 *
 * **两个面共用一个形状**（架构 § 9.6：「CLI 的输出就是 `M9` 工具的返回形状」）：`zones` 那三栏
 * 就是 `assemble()` 的三个区按同一套哈希口径读出来的——`--json` 那一份与程序里那次装配逐字节
 * 对得上（`constraints.test.ts` 的 ② 量这一条）。
 *
 * **拒的三处**：协议名不认得（`protocolNamed`）· `--agent` 指了一个不存在的 agent（`resolverFor`，
 * 不给就是持轮者那条路）· `--against` 指的协议不认得。三处都是退出码 1，都报出那个名字。
 */
export async function assembleCmd(
  root: string,
  flags: Map<string, string | true>,
  args: string[],
  json: boolean,
): Promise<number> {
  const abs = resolve(root)
  const name = args[0]
  if (name === undefined || name === '') {
    return usageFail(`assemble 需要 <protocol>：${Object.keys(PROTOCOLS).join(' 或 ')}`, json)
  }
  const who = flags.get('agent')
  const against = flags.get('against')
  try {
    const doc = await readConfig(abs)
    // **目录按这一台来**（P2d）：`~/.fugue/models.json` 在就是它，不在就是内置档——装配与轮次
    // 读的是同一份（`round.model` 的解析 · 三处种子上限，都在这份目录上查）。
    const cat = readCatalog()
    // **装配跟着配置走**（P2b：`round.model`；装配不收旗标——它是视图，前缀要与轮次用的一致）。
    // **过一遍查表**：未知即拒并列出目录（与轮次那两处同一条口径），不把一个没核对过的名字递下去。
    const modelId = modelDeclOf(selectedModelId(undefined, doc), cat).id
    const protocol = protocolNamed(name)
    const coord = await agentCoord(abs, typeof who === 'string' ? who : null, doc)
    const segments = sourcesFor(protocol, coord.state, coord.who)
    const prefix = assemble({ protocol, model: modelId, segments })
    const violations = checkConstraints(protocol, segments, null, '这一步', undefined, prefix)

    const zoneLine = (z: 'A' | 'B' | 'C'): { hash: string; bytes: number } => {
      const bytes = z === 'A' ? prefix.zoneA : z === 'B' ? prefix.zoneB : prefix.zoneC
      return { hash: hashOf(bytes), bytes: bytes.length }
    }
    const zones = { A: zoneLine('A'), B: zoneLine('B'), C: zoneLine('C') }

    let divergence: { against: string; at: number; note: string } | null = null
    if (typeof against === 'string' && against !== '') {
      const other = protocolNamed(against)
      const otherCoord = await agentCoord(abs, typeof who === 'string' ? who : null, doc)
      const otherSegments = sourcesFor(other, otherCoord.state, otherCoord.who)
      const otherPrefix = assemble({ protocol: other, model: modelId, segments: otherSegments })
      const a = firstDivergence(prefix.zoneA, otherPrefix.zoneA)
      const at = a >= 0 ? a : prefix.zoneA.length + firstDivergenceOrEnd(prefix.zoneB, otherPrefix.zoneB)
      divergence = {
        against,
        at,
        note:
          a >= 0
            ? `A 区第 ${a} 个字节起不同`
            : `共同部分（A + B 相同的 ${at} 个字节）之后是这两份声明各自的地方`,
      }
    }

    if (json) {
      emitJson({
        protocol: name,
        version: protocol.version,
        agent: typeof who === 'string' ? who : null,
        segments: protocol.segmentOrder.length,
        toolCatalog: protocol.toolCatalog.length,
        zones,
        firstDivergence: divergence,
        violations,
      })
    } else {
      emitLine(`协议 ${name} · 版本 ${protocol.version} · ${typeof who === 'string' ? `agent ${who}` : '持轮者那条路'}`)
      emitLine(`段 ${protocol.segmentOrder.length} 段 · 工具目录 ${protocol.toolCatalog.length} 个`)
      for (const z of ['A', 'B', 'C'] as const) {
        emitLine(`${z} 区 ${zones[z].bytes} 字节 · ${zones[z].hash}`)
      }
      if (divergence !== null) emitLine(`与 ${divergence.against} 的第一处不同：第 ${divergence.at} 个字节（${divergence.note}）`)
      emitLine(
        violations.length === 0
          ? '四条约束：一处都不报'
          : `四条约束：报了 ${violations.length} 处\n  ${violations.map(formatViolation).join('\n  ')}`,
      )
    }
    return violations.length === 0 ? 0 : 1
  } catch (err) {
    // **三个析取项里前两项是恒真的**（清障批 ③）：`SourceError` 与 `ConfigError` 都是
    // `class … extends Error {}`（`assemble/sources.ts:155` · `config.ts:39`），所以
    // `err instanceof Error` 早就把前两项包住了——留着它们的唯一效果是让人以为这里分了三种。
    // 收敛成一项，行为一个字节不变：`cli/chain.test.ts` 的坏协议名那条 · `assemble/constraints.test.ts` ⑥
    // 的三档拒绝，都是它的读数。
    if (err instanceof Error) {
      return fail(err.message, json)
    }
    throw err
  }
}

/** 两个字节串从头起相同的长度（`firstDivergence` 在 A 区相同时给 -1，这里要的是那个位置）。 */
function firstDivergenceOrEnd(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i += 1
  return i
}

/**
 * 这一次装配用的是谁：不给 `--agent` 就是持轮者那条路（`HOLDER`），给了就去日志里查它的分支头
 * ——查不到当场拒（退出码 1，报出那个名字），**不给主线当默认**（PLAN § 5.6 的 Z4 行那句）。
 *
 * 坐标那两栏的当下取值：`branch` 是日志里那条 ref，`outputPaths` 是契约要求的产物路径（架构
 * § 8.12）——契约值的读取与逐 `kind` 的裁剪落在 S7，所以这一份今天给的是"这个 agent 的产物
 * 目录"这一条机械的取值。
 */
async function agentCoord(
  root: string,
  who: string | null,
  doc: ConfigDoc,
): Promise<{ state: ReturnType<typeof stateWithState>; who: AgentCoord | null }> {
  const state = stateWithState(emptyState(), doc, root)
  if (who === null) return { state, who: HOLDER }
  const truth = openTruth(root)
  try {
    // --agent 收的那一串就是日志里那条 ref 的名字（与 writerOf 同一条口径）。
    const ref = refFor(who)
    const head = await truth.resolve(ref).catch(() => null)
    if (head === null) {
      throw new SourceError(
        `没有这个 agent：${who}——日志里没有 ${ref}。不给 --agent 走的是持轮者那条路，两者不是一回事（架构 § 8.11）。`,
      )
    }
    // **这一条路（`--agent` 的临时装配）不知道契约是哪一种**：它按只读型那一档给（与 D15
    // 同一条口径），因为这条路是「拿一份状态来量前缀」用的，不是让谁照它写文件的。
    return { state, who: { id: who, branch: ref, outputPaths: [`deliver/${who}/`] } }
  } finally {
    truth.close()
  }
}

/** 公布给模型的那一份目录：**目录 ∩ 实现表**（`B5` 的纪律：只公布能兑现的）。 */
export function publishedCatalog(): ReturnType<typeof catalog> {
  return publishedTools(implementedNames(TOOL_NAMES), catalog(CATALOG_STATES[0] as (typeof CATALOG_STATES)[number]))
}

/**
 * 声明里那一份**模型上限**（`ModelDecl.contextLimit`）。
 *
 * **`seed` 那一条的算式要它**：`contract/` 不认识模型目录，所以由命令面这一层取一次递下去。
 * 三处（`round new` · `round run` · `round go`）递的是同一个数——三处各自读一次声明的话，
 * "发给模型的那个上限"与"判种子的那个上限"会静默分家。
 *
 * **这一处从序 29 起可证伪了**：目录第一条的 `contextLimit` 是上游报的 1 048 576，而
 * `contract/types.ts` 的 `DEFAULT_MODEL_LIMIT` 是**这一份的缺省**（1 000 000，"不是任何一个模型的
 * 声明"）——两个数不再相等，所以三处**漏递一处，读数就变**（`model/contract.test.ts` 里那一条
 * `assert.notEqual` 钉的就是它：递与不递的种子上限不同）。在这之前两个数一样，漏递不可见。
 *   · **算式那一层抓得住**：`round/start.test.ts` ⑥（`modelLimit: 8 000` → 上限 0 · 不递 → 904 000）。
 *   · **接线那一层的判据随 `P2b` 落了**：上限跟着 `round.model` 走（`selectedModelId` 一处解析）——
 *     换一条上限不同的声明，三处的读数都跟着动。P2d 起查的是**这一台的目录**（`cat`，调用方递）。
 */
export function modelLimitOf(doc: ConfigDoc, cat: Catalog): number {
  return modelDeclOf(selectedModelId(undefined, doc), cat).contextLimit
}

/**
 * `--dump-wire` 那个目录的守卫：**必须在工作区之外**。
 *
 * 为什么不是"随便落"：物化的底是**真实工作树**（§ 8.4），落进 `<root>` 里的字节会被下一轮的
 * `fork` 当成漂移（`A10` 那三方比法的第一条线），于是一趟排障会把轮次本身弄脏——而那时候人正
 * 在查别的问题。所以这一条按"失败要指路"给两条出路（约定 § 四 · 架构 § 24 纪律 5）。
 */
export function dumpWireDir(root: string, dir: string): string {
  const inRoot = relative(resolve(root), dir)
  const inside = inRoot === '' || (!inRoot.startsWith('..') && !isAbsolute(inRoot))
  if (inside) {
    throw new RoundRunError(
      '--dump-wire',
      `不许落在工作区里：${dir}\n` +
        `  这一份落在 <root>（${resolve(root)}）里面，而物化的底就是真实工作树——` +
        `下一轮的 fork 会把它当成漂移。\n` +
        `  两条路：换个工作区之外的目录（例如 /tmp/fugue-wire），或者这一趟不给 --dump-wire。`,
    )
  }
  return dir
}
