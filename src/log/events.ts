// M0 的语言：日志事件的联合，与 `Log` 的契约。出处：架构 § 8.1。
//
// 这张联合是**消息的模式**，不是 M0 的解释对象。M0 不读 `t`，也不读任何载荷字段；
// 它只做一件事——按 § 9.2 的信封写下去，再原样读回来。因此下面引用的类型即使改了
// 值域（例如两处未决项定下来），M0 的实现一行都不用动。
// （U3，2026-09：`ModelId` · `StopReason` · `ThinkingLevel` 三词改自 `terms.ts`——原先那条
// `from '../model/contract.ts'` 是悬空的（model/contract 从未导出过 `ModelId`，type 级
// 引用在直跑下被整体擦掉，tsc 下必炸）；底座词汇自此自足，不认识 model 那一侧。）
import type {
  AgentId,
  AskTier,
  AssertionResult,
  BlobId,
  BranchId,
  CommitId,
  ContractId,
  Enforcement,
  ForkStrategy,
  LogPos,
  LogSeq,
  ModelId,
  NetMode,
  PolicyLayer,
  PolicyMode,
  RelPath,
  RoundId,
  RoundState,
  SignalId,
  SignalKind,
  StepId,
  StopReason,
  ThinkingLevel,
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
  /**
   * 轮次开始的那一条：**这一轮钉住的底 + 轮级意图**（架构 § 8.14 的 C7 前半 · § 15.1 纪律 2）。
   *
   * 底为什么与意图住同一条：两者是**同一刻**定下来的（钉底之后紧跟着落这一条），而放行那一趟
   * （`fugue round go`）要拿同一个底把同一份草案重算一遍——不记它，重算出来的就是另一批契约，
   * "人批的是哪一批"没有一个对象可比。**钉住的底不是"当时 HEAD 的读数"**：HEAD 后来动了，
   * 这一轮仍然在它上面（A7 的漂移检测读的正是这一件事）。
   */
  | { t: 'round/intent'; round: RoundId; base: CommitId; digest: string; body: string }
  /**
   * 持轮者那一趟写完草案之后，**草案的原文**（视图里那一份，逐字节）。`round` 那一栏是必须的：
   * 同一份日志里住着好几轮的草案，重放时"这一轮的草案是哪一份"要选得出来——按"最后一条"选的话，
   * 第二轮起草之后回头去放行第一轮，拿到的就是错的草案。
   *
   * `against` 是**它从哪一版改出来的**（上一版正文的 `digest`）：一版一条，串成一条链。
   * 第一版没有这一栏（没有上一版）。于是「改了一版」与「又落了一遍同一版」分得开——正文逐
   * 字节相同则 `digest` 相同，而两次的 `against` 各指各的上一版。讨论态（那场对话的凝聚）
   * 与预备态（那份草案）落的是**同一条链**：同一轮里只有一条。
   */
  | { t: 'holder/distill'; round: RoundId; agent: AgentId; digest: string; against?: string; body: string }
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
   * 子 agent 那一份是契约，不是计划，所以它调这一条只得到一句"not your cell's job"。
   */
  | { t: 'holder/plan'; agent: AgentId; digest: string; body: string }
  /**
   * 持轮者问人（`ask_user_question` 那一条的落点）。**问完就停在同一道门口**：答案归人，而门
   * 由人开——所以它落事件、叫停，与 `holder/plan` 共用那一个"停"（不引入"异步等待"这种持久态）。
   */
  | { t: 'holder/ask'; agent: AgentId; digest: string; body: string }
  /**
   * **子 agent 的问题被轮内接住**（架构 § 23 的 U18 · 路线图 0.2.7 行 ② 的甲案）。
   *
   * 出处是那一格原先只得到的一句话：「这不是你这一格的事」（§ 8.4 纪律 2）——它要问人的时候，
   * 问题得先在轮内被接住，再由持轮者拿到人面前。这一条就是"被接住"那一下：`body` 是那一批问题
   * 的原文（`{questions: [...]}`，与 `ask/ruling` · `holder/ask` 同一份正文形状），`digest` 是它的
   * 指纹——判决那一条的 `asked` 指回它。
   *
   * **它由轮次那一层落**（持轮者那一格在轮内收下的就是它），不是子 agent 自己往账上写：那一格
   * 手里没有写句柄。
   */
  | { t: 'ask/raised'; agent: AgentId; contract: ContractId; digest: string; body: string }
  /**
   * **持轮者对那一问的判决**（U18 甲案：不积累上下文的一次性裁断）。
   *
   * **只带结论**：`tier`（三档之一，判不出来时这一栏不在）· `forwarded`（这一问进不进人）·
   * `ruler`（**尺的版本**：这一条判决是按哪把尺量出来的）· `body`（结论的全文：档 · 判词 ·
   * 走退化路时的由头）。**推敲不进这里**——判那一次读到的上下文与原始回复哪儿都不落（红线：
   * 推敲不进任何人 C 区），所以重放读得到的是"判了什么"，读不到"它当时怎么想"。
   *
   * `asked` 指回 `ask/raised` 那一条的 `digest`：同一格可以问好几回，"这一条判决判的是哪一问"
   * 要选得出来。
   */
  | {
      t: 'ask/ruling'
      agent: AgentId
      asked: string
      forwarded: boolean
      tier?: AskTier
      ruler: string
      digest: string
      body: string
    }
  /**
   * **人放行了这一批**（`fugue round go`）：紧接着的那几条 `contract/issue` 就是它的兑现。
   *
   * `fingerprint` 是这一批的**编号**（`fingerprintOf`：拆分的形状——每节的 kind · goal · 写入面 ·
   * 交付物 · 断言 · seed，不含轮次与身份），`contracts` 是这一批发出去的那几份。
   *
   * **它不是一份新状态**：重放时轮次的处境仍然只看 `round/state` 那条链。**编号也不作数**
   * （架构 § 15.1.a）：长得像不算放行过的凭证——新的一批一律重停，哪怕与上一批同一个编号。
   * 它在这里的用处只有一个：读日志的人（与 TUI）一眼看得出"这一批与哪一批同形"。
   */
  | { t: 'round/approve'; round: RoundId; fingerprint: string; contracts: ContractId[] }
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
      /**
       * **这一趟声明了哪一档思考**（`ModelDecl.call.thinking` 原样）。`null` = 声明里没写这一栏。
       *
       * 为什么 `null` 与 `off` 必须分得开：**两条线对"没写"的解释相反**（Chat Completions 那条线
       * 默认是开的、Messages 那条线不写就是不开），所以"没写"是一个真实的、可能出事的状态。
       * 适配器各自把没写翻成"关"（`openai.ts` 发 `disabled` · `anthropic.ts` 一个字段都不发），
       * 而**日志记的是我们声明的那一档**，不是适配器补出来的那一档——两处都记就会漂。
       */
      thinking: ThinkingLevel | null
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
        /**
         * **输出那一个数里的拆解**：思考花掉的那部分（上游的
         * `completion_tokens_details.reasoning_tokens`）。**它不是第五个数**——`outputTokens` 已经含它，
         * 钱只从 `USAGE_COUNTS` 那四样算；这一栏回答的是"想占了多少"。只有 Chat Completions 那条线报它，
         * Anthropic 那条线是 `null`。
         */
        reasoningTokens: number | null
      }
      /** 提供方自己的结束原因（原话）。半截的流是 `null`。 */
      rawStop: string | null
      /** 一次调用的收尾；半截的流是 `null`（**不许当"走完了"**，架构 § 14.2 第 2 步）。 */
      stop: StopReason | null
      /**
       * **试了几次**（P2f）：传输层按提供方的重试档重发**同一份 body** 时，每一次的状态码
       * （`0` = 没拿到状态码那一档：传输错 · 超时）。**恰一次时整栏不出现**——没声明重试的
       * 默认档一个字节都不多，旧日志回放照旧；它出现就说明重试真的发生过，与 `bodyHash`
       * （`--dump-wire` 那份取证物）一起读，"同一串字节发了几次、各回了什么"答得出来。
       */
      attempts?: readonly number[]
      /**
       * **这一趟花了多久**（本站 ④b 新加的一栏：加栏，不是改栏）。单调钟（`performance.now()`）
       * 在 `deps.call` 那一趟的两头各取一次、相减——**区间读数，不是时刻**：账上读得到「花了多久」，
       * 读不到「什么时候」（时刻住在信封上，事件载荷里不带它——§ 9.2 的 `ts` · `boot` · `inc`）。
       *
       * **旧日志里没有这一栏**（回放照旧），于是「没量到」与「量到 0」分得开——每调用成本台账
       * （`probe/ledger.ts`）照这一条读：缺一栏是「未量到」，不是 0。
       */
      ms?: number
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
