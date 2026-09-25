// M0 的语言：日志事件的联合，与 `Log` 的契约。出处：架构 § 8.1。
//
// 这张联合是**消息的模式**，不是 M0 的解释对象。M0 不读 `t`，也不读任何载荷字段；
// 它只做一件事——按 § 9.2 的信封写下去，再原样读回来。因此下面引用的类型即使改了
// 值域（例如两处未决项定下来），M0 的实现一行都不用动。
import type { ModelId, StopReason } from '../model/contract.ts'
import type {
  AgentId,
  AssertionResult,
  BlobId,
  BranchId,
  CommitId,
  ContractId,
  Enforcement,
  ForkStrategy,
  LogPos,
  LogSeq,
  NetMode,
  PolicyLayer,
  PolicyMode,
  RelPath,
  RoundId,
  RoundState,
  SignalId,
  SignalKind,
  StepId,
  ViewRev,
  WriterId,
} from '../terms.ts'

export type LogEvent =
  | { t: 'view/write'; agent: AgentId; path: RelPath; rev: ViewRev; blob: BlobId; mode: number }
  | { t: 'view/symlink'; agent: AgentId; path: RelPath; rev: ViewRev; target: string }
  | { t: 'view/remove'; agent: AgentId; path: RelPath; rev: ViewRev }
  | { t: 'view/rename'; agent: AgentId; from: RelPath; to: RelPath; rev: ViewRev }
  | { t: 'view/chmod'; agent: AgentId; path: RelPath; rev: ViewRev; mode: number }
  | { t: 'ckpt/commit'; agent: AgentId; commit: CommitId; rev: ViewRev; msg: string }
  | {
      t: 'mat/fork'
      agent: AgentId
      base: CommitId
      strategy: ForkStrategy
      paths: RelPath[]
      hashes: string[]
      ms: number
    }
  | {
      t: 'mat/sync'
      agent: AgentId
      from: ViewRev
      to: ViewRev
      paths: RelPath[]
      hashes: string[]
      ms: number
    }
  | { t: 'mat/reclaim'; agent: AgentId; declared: RelPath[]; changed: RelPath[] }
  /**
   * 起一个进程的凭据。
   *
   * `argv` 与 `cwd` **是可以缺的**：工具面那一侧（`B5`）两样都填，而命令行那一侧
   * （`fugue run <action>`）今天只填 `argv0`。**绕行率读的是 `argv`**（`METRIC_HOW` 里那张
   * 模式表），所以这一栏缺了那条读数就没有源——缺了照旧能算，只是分母之外的那一半看不见。
   */
  | { t: 'run/start'; agent: AgentId; step: StepId; action: string; argv0: string; argv?: readonly string[]; cwd?: string }
  | { t: 'run/end'; agent: AgentId; step: StepId; exit: number; ms: number; denied: boolean }
  /**
   * **这一格干完了 / 为什么停**（一个 agent 一条：这一格只干一次活）。
   *
   * 与 `round/state` 那一族的区别：那一条是**轮级**的（`Working → Verifying → …`），而"这一格
   * 是被步数掐掉的、被预算拦下的、还是自己说完的"只有每一格自己知道。`stopped` 就是
   * `DriverResult.stopped` 那句话原样（`收敛` · `步数到顶（n）` · `cut-stream：…` · 预算那句话）。
   *
   * **它是旁证，不是判据**：一轮成不成仍然看验收（`report.ok`）。收它是因为"验收通过"与
   * "这一格到底干完没有"是两件事——第一次联网验证那两趟，正是这两件事差出来的。
   */
  | {
      t: 'agent/stop'
      agent: AgentId
      /** 走了几步（每一次 `llm/call` 一步）。 */
      steps: number
      /** 停下来的那句话（`DriverResult.stopped` 原样）。 */
      stopped: string
      /** 交了几次接（`B6` 的停机纪律：先停再交接）。 */
      handoffs: number
    }

  | {
      t: 'run/confined'
      agent: AgentId
      mode: PolicyMode
      enforcement: Enforcement
      /** 网络那一档（架构 § 8.8 的 `Policy.net`）：缺省 `none`，动作点名才是 `host`。 */
      net: NetMode
      /** 这一趟在场的层（探出来的）：空数组 = § 15.7 的 E4 那一档。 */
      layers: readonly PolicyLayer[]
      /** 这一趟的只读根清单（`Policy.reach.roRoots`）：事件记的是**要求**，供给看 `enforcement`。 */
      reach: readonly string[]
    }
  | { t: 'bound/deny'; agent: AgentId; path: string; space: 'virtual' | 'physical'; rule: string }
  | { t: 'signal'; agent: AgentId; id: SignalId; kind: SignalKind; digest: string }
  | {
      t: 'agent/handoff'
      agent: AgentId
      successor: AgentId
      contract: ContractId
      digest: string
      body: string
    }
  | { t: 'round/state'; round: RoundId; from: RoundState; to: RoundState }
  | { t: 'round/intent'; round: RoundId; digest: string; body: string }
  | { t: 'holder/distill'; agent: AgentId; digest: string; body: string }
  /**
   * 待办清单（`todo_write` 那一条的落点）。**它是覆盖式的**：后一份整体替掉前一份，重放时
   * 这一格手里那份就是最后一条。
   *
   * 为什么住日志里：待办是**跨步**的上下文。落视图会污染工作树（验收要逐字节一致），落内存
   * 则重启即失（架构 § 9.7 的 `turns`）——它是唯一既跨步又重建得出的落点。形状与
   * `round/intent` · `holder/distill` 同一路（`digest` + 正文）。
   */
  | { t: 'holder/todos'; agent: AgentId; digest: string; body: string }
  /**
   * 持轮者说"预备态做完了"（`exit_plan_mode` 那一条的落点）。**门仍由人开**：这一条只落事件，
   * 契约一个都不发——发契约是 `round go` 那一档的事（架构 § 15.1.a）。
   *
   * 形状与 `holder/todos` · `round/intent` 同一路（`digest` + 正文）。**只有持轮者落它**：
   * 子 agent 那一份是契约，不是计划，所以它调这一条只得到一句"这不是你这一格的事"。
   */
  | { t: 'holder/plan'; agent: AgentId; digest: string; body: string }
  /**
   * 持轮者问人（`ask_user_question` 那一条的落点）。**问完就停在同一道门口**：答案归人，而门
   * 由人开——所以它落事件、叫停，与 `holder/plan` 共用那一个"停"（不引入"异步等待"这种持久态）。
   */
  | { t: 'holder/ask'; agent: AgentId; digest: string; body: string }
  | {
      t: 'contract/issue'
      round: RoundId
      contract: ContractId
      owner: AgentId
      paths: RelPath[]
      /**
       * 契约正文（JSON）。**契约住日志里**（架构 § 8.12）：重启之后"这一轮派过什么活、按什么
       * 验收"重放得出。形状与 `round/intent` · `holder/distill` 同一路（`digest` + 正文），
       * 而这一条多给一份 `paths`：读日志的人先看"这份契约要写哪儿"，要看全文再看正文。
       */
      body: string
    }
  | { t: 'merge/attempt'; round: RoundId; branches: BranchId[]; conflicts: number }
  | { t: 'merge/accept'; round: RoundId; commit: CommitId; assertions: AssertionResult[] }
  | {
      t: 'prefix/assemble'
      agent: AgentId
      zoneAHash: string
      zoneBHash: string
      zoneCHash: string
    }
  | {
      t: 'llm/call'
      agent: AgentId
      step: StepId
      /** 我们这边的键（`ModelId`）。**另一个名字是 `request.model`**：提供方那边叫什么，在夹具里。 */
      model: ModelId
      /** 走哪条线协议（`WireName`）。两条线跑同一份状态时，这一栏是那两组读数的分组键。 */
      wire: string
      /** 这一次请求公布了几条工具（**条数**进日志，schema 本身不进：`B7` 的哈希从这几样算得出）。 */
      toolCount: number
      /**
       * **模型这一次伸了几次手**（这一趟响应里拼出来的工具调用条数）。
       *
       * 它与 `toolCount` 是两件事：那一栏是"我们公布了几条"，这一栏是"它调了几条"。
       * `zero-tool-call-rate` 的分子问的是后者（架构 § 8.15：本架构最危险的失败模式是
       * **约束导致模型不伸手**）——公布几条与它伸不伸手无关，所以那一栏顶不了这一栏。
       */
      invocations: number
      /**
       * 上游在拒绝时给的状态码。**只有失败那一路有**，成功是 `null`——它与 `stop: null` 一起读：
       * 「这一趟没走完」与「上游为什么没让它走完」是两件事。
       *
       * **算指标时一个都不看它**：八元指标的分子分母不认这一栏，所以加它不动任何读数。
       */
      status: number | null
      /**
       * 排障要的那几个响应头（请求号 · 限流那几条；**白名单在 `http.ts` 的 `KEPT_HEADERS`**）。
       * 成功那一路是 `null`。
       */
      headers: Readonly<Record<string, string | number>> | null
      /**
       * 用量的四个数（架构 § 8.15）。**四个都可缺**，缺了是 `null`——提供方没报就是没报，
       * **不拿 0 顶**（`B1` 的 `Usage` 那一条）；指标重算时"没量到"与"量到 0"分得开。
       */
      usage: {
        inputTokens: number | null
        cacheReadTokens: number | null
        cacheWriteTokens: number | null
        outputTokens: number | null
      }
      /** 提供方自己的结束原因（原话）。半截的流是 `null`。 */
      rawStop: string | null
      /** 一次调用的收尾；半截的流是 `null`（**不许当"走完了"**，架构 § 14.2 第 2 步）。 */
      stop: StopReason | null
    }

/**
 * `M0` 的契约。**三个方法，与架构 § 8.1 逐字一致。**
 *
 * `fromSeq` 是排他下界：只产出 `seq > fromSeq` 的事件。这与 § 9.4「无快照则从
 * seq=0 起」一致——序号从 1 起，故 0 表示"全部"。
 */
export interface Log {
  append(w: WriterId, e: LogEvent): Promise<LogSeq>
  readByWriter(w: WriterId, fromSeq?: LogSeq): AsyncIterable<LogEvent>
  readMerged(fromSeq?: LogSeq): AsyncIterable<{ pos: LogPos; e: LogEvent }>
}

/**
 * `Log` 的读侧。**重放只需要这一半**——`loadView` 收的是它，不是整个 `Log`。
 *
 * 这不是为了好看：写路径与重放路径分开之后，"重放会不会改日志"这个问题在签名上就答完了。
 */
export type LogReader = Pick<Log, 'readByWriter'>
