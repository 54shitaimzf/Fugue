// M0 的语言：日志事件的联合，与 `Log` 的契约。出处：架构 § 8.1。
//
// 这张联合是**消息的模式**，不是 M0 的解释对象。M0 不读 `t`，也不读任何载荷字段；
// 它只做一件事——按 § 9.2 的信封写下去，再原样读回来。因此下面引用的类型即使改了
// 值域（例如两处未决项定下来），M0 的实现一行都不用动。
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
  | { t: 'contract/issue'; round: RoundId; contract: ContractId; owner: AgentId; paths: RelPath[] }
  | { t: 'merge/attempt'; round: RoundId; branches: BranchId[]; conflicts: number }
  | { t: 'merge/accept'; round: RoundId; commit: CommitId; assertions: AssertionResult[] }
  | {
      t: 'prefix/assemble'
      agent: AgentId
      zoneAHash: string
      zoneBHash: string
      zoneCHash: string
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
