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
  | { t: 'run/start'; agent: AgentId; step: StepId; action: string; argv0: string }
  | { t: 'run/end'; agent: AgentId; step: StepId; exit: number; ms: number; denied: boolean }
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
