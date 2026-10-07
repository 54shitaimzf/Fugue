# Fugue —— 架构、复用与演进

> 本文是 **Fugue** 设计与实现的唯一权威，自包含：不依赖任何外部讨论记录或前置文档。
> 阅读顺序：**第一部分（基础）→ 第二部分（分层）→ 第六部分（推进顺序）**；
> 第三部分为模块规格、代码树、持久化与观察、线协议与拟合；
> 第四部分为复用审查，第五部分为演进路径，均按需查阅。
> **本文只写第一版是什么**——§ 20 的八步建成的那一版。第一版之后要做的东西另立一篇：《[Fugue —— 后面的目标](TARGETS.md)》，编号 `T1`–`T19`。
> 术语一律以本文定义为准，章节编号全文连续；步骤编号 `S#` 见 § 20。
> 编号化的依据：决策 `D#` 见 § 22，未决事项 `U#` 见 § 23，纪律见 § 24——正文引用时一并给出编号与所在节。

---

# 第一部分 · 基础

## 1. 主体、规则与不变量

### 1.1 主体

> **Agent = Environment + Context + Model**

模型的状态只取决于参数与上下文；Agent 的状态取决于环境 + 上下文 + 模型。

### 1.2 两条规则

- **规则 1（信源）**：Agent 的状态住在环境里，上下文是从状态重建出来的一份投影，不是装状态的容器。
  **一份内容能否离开上下文，只看一件事：它离开之后还能否从环境重建出来。**
- **规则 2（判断的位置）**：判断只允许落在有判据的地方；**没有判据的地方，一律用核对代替判断。**

### 1.3 四条推论

| # | 内容 | 在本架构中的落点 |
|---|---|---|
| **推论 1** | 保存 Agent 运行状态无需任何与当前上下文无关的内容 | `M0 log` 的事件集只含**重放必需的**内容（§ 9.7） |
| **推论 2** | 环境一致时，给定上下文即可立刻重建一个 Agent 状态 | 主 agent 可替换（§ 15） |
| **推论 3** | 上下文不是 Loop-Then-Compress，而是按轮 **再生成 → 切片 → 合并 → 重载** | 装配（§ 13） |
| **推论 3′** | 环境维持共享、**代码 fork、上下文 build** | `spawn`（§ 14.1） |

### 1.4 唯一不变量

> **同一份状态，可以有 N 个视图与 N 个位置，但必须指向同一个身份。
> 真源唯一且不可变，其余皆可弃。**

它落在三个命名空间里，形状相同：

| 命名空间 | 真源 | 视图 | 位置 |
|---|---|---|---|
| **文件** | git 对象库 | 每 agent 一份 overlay | 物化目录 |
| **进程** | 系统级配置（§ 15.3.a） | 每 agent 一套 HOME / 缓存 / 端口 | 任何位置可用 |
| **上下文** | 环境 + 协议 | 每轮装配的前缀 | — |

**进程这一格没有位置，因为模型不按路径寻址它。** 配置声明的是这台机器上有什么、准跑什么；而模型感受到的不是一份可寻址的清单——`node` 就在那儿。所以这一格问的不是"它在哪"，是"**它让什么变得可用**"。

### 1.5 三个直接结论

1. **真源绝不虚拟化**——唯一、不可变、内容寻址。
2. **派生一律虚拟化且可弃**——overlay、物化目录、前缀，删掉都能重建。
3. **路径是身份，不是位置**——模型看到的是仓库相对路径，与物化到哪里无关。

**判据**：设计任何一样东西，先问一句——**它是真源，还是真源的派生？**

### 1.6 模型进步落在哪里

**这套结构里没有一处是为某一代模型定做的。** 环境、真源与不变量与模型代次无关，换代不使它们过时；模型相关的一切收在**声明的那一层**（§ 10.2 的自由项），换模型改的是那一层的字节。

**于是模型的进步直接落进系统里。** 模型写下来的非机械内容只有四处——交接提示词 · 轮级意图 · 凝聚理解 · 契约（§ 8.1）——而判断集中在持轮者那一层（§ 15.1）。模型越强，这四处越准：前缀更短，每一轮装进来的东西更少也更聚焦。**这里把能力编进环境与声明**——编进脚手架的那一类会随模型变强而失去作用；每一条结构要么是环境的不变量，要么是一个声明出来的值。

**它买的是重装成本与发挥度，不是学习速率**：环境承载知识，模型自身的变化来自训练，这一层不由架构提供，也不由架构阻挡。

## 2. 本架构必须处理的八件复杂事

这八条是分层与分叉的依据。

| # | 复杂度 | 对应结构 |
|---|---|---|
| C1 | 一个虚拟命名空间，对应三套物理实现（内存视图 / agent scratch / 真实工作树） | `M3 roots`：虚拟↔物理映射 + 双空间围栏 |
| C2 | 物化由能力需求驱动，不由提交点驱动 | `M4 materialize` 的幂等 `ensure(revision)` |
| C3 | 子进程会写盘，而视图必须是唯一写入者 | `M6 reclaim`：带声明文件集的反向通道 |
| C4 | 进程内围栏与 OS 沙箱分处两个世界 | `M7 policy`：一份策略，两个强制点，一致性检查 |
| C5 | 前缀分三段，缓存稳定性各不相同 | `M10 assemble` 的 Zone A / B / C |
| C6 | 拆分与合并之间存在显式状态 | `M12 round` 状态机 |
| C7 | 真实工作树是第四个参与者 | 基底钉住 + 漂移检测 |
| C8 | 一切验证都需取证，一切状态都需可重放 | `M0 log` 作为一等模块，并自身承担持久化（§ 9） |

## 3. 两条正交轴

状态与权限是**正交的两条轴**，交叉点是唯一的能力关卡。

```
        轴 B：能力与权限（谁能碰、经哪条路、受什么策略）
        ┌──────────────────────────────────────────────────┐
  轴 A  │  read  write  edit  glob  grep  bash  run_action │
  状态  │   ↓      ↓     ↓     ↓     ↓     ↓       ↓       │
        │        ★ 能力关卡（唯一策略点）★                  │
        └──────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────┴───────────────────────────────┐
│  真源 truth → 视图 view → 物化 materialize → 执行 execute │
└──────────────────────────────────────────────────────────┘
```

**能力不是一列工具，而是每个工具解析到的那一层状态。** 每个能力只声明**一件事**：这次调用落在哪一层状态。要不要先物化、要不要过路径围栏、要不要关进 OS 沙箱、能不能把字节写回视图——**四条都是它的推论**，不另立声明。那张表在 § 8.9，**它是全部行为分叉的集中处**。

## 4. 身份模型

```ts
type WorkspaceId = string   // 一个根 + 一段共享历史（仓库只是其中一种根）
type RoundId     = string   // 一轮：一次并行 + 一次合并
type ContractId  = string   // 一份契约
type AgentId     = Branded<'AgentId'>    // 一个 agent（主或子）
type BranchId    = Branded<'BranchId'>   // 一条分支
type StepId      = string   // 一步：一次模型调用及其工具执行
type CommitId    = Branded<'CommitId'>   // 一次提交
type ViewRev     = number   // 视图单调修订号
type SignalId    = string
```

**只品牌 `AgentId` / `BranchId` / `CommitId`。** 这三者混淆的后果最严重（跨分支误写、提交错位）；其余用 `string` 加命名约定即可——原型期把**修正便宜**排在类型面完备前面。

**从属关系**（每个子项恰属于一个父项）：

```
WorkspaceId
 ├─ CommitId（主干推进点）
 └─ RoundId
     └─ ContractId ── AgentId ── BranchId
                         └─ StepId
```

**ref 命名方案**（可人工检视、无碰撞）：

```
refs/heads/main
refs/heads/agent/<round>/<n>
refs/agents/<round>/<n>/ckpt/<seq>     分支内提交点，不移动分支头
refs/tags/round/<round>/merged
```

**主干只有一条。** 它从工作区建起来那天一直往下接：日志侧的署名是 `round`，git 侧的落点是 `refs/heads/main`。`round` 标的是**持轮者这个位置**（§ 15.4，即主 agent）：第 3 轮与第 7 轮的持轮者可以是两个不同的 agent，位置是同一个，接上的是同一条主干。人敲 `fugue write` 与 `fugue commit` 写的就是这个位置，人与持轮者因此落在同一条主干上。

**子 agent 的线从主干上分出去。** `agent/<round>/<n>` 带着轮次与序号，各有各的日志、各有各的分支头；它们写下的东西经合并（§ 8.14）回到主干。**默认打开的是主干那一份**：不带 `--agent` 时读到的视图，与 git 侧的主干是同一段历史。

**这个名字同时是一条路径。** 它在三处落成文件系统上的坐标，三处都**按段展开**：`mat/<agent>/{upper, merged, tmp, cache}`（§ 8.4）· `log/<writer>.jsonl` 与 `log/<writer>.lock`（§ 9.2）· `snap/<writer>/<seq>.json`（§ 9.4）。所以每一段都得是一个能当目录名的段——空 · `.` · `..` · 以点开头 · 反斜杠 · 空字节一律拒；**这条规矩只有一处实现**，`M0` 与 `M3` 各调它一次（名字的形状不属于任何一个模块：`M0` 只认 writer，`M1` 只认 ref，而两边都要它）。它在两处各写一遍时**已经漂移过一次**：日志那一侧收 `agent/r1/1`，物化那一侧拒它。

**分出去是一个动作：`fugue branch <base>` 把本 agent 的分支头定格在那个提交上。** 幂等——已经指着它就什么都不做；指着别处就拒绝，并说出两条路（先把它定过来，或者拿它现在指着的那个提交当 base）。**它定的是视图的底，而 `fork` 定的是物化的底，两者必须是同一个提交**——**分支头还没有定也算不一致**（那时视图的底是空的，而物化树里躺着整棵真实工作树）：不一致的症状是静默的（物化树里本 agent 没碰过的路径给的是真实工作树的内容，而视图给的是另一个提交的），所以这一步由 `fork` 拦在落地之前并指路（§ 8.5）。**这一处强制点现在在命令面**——`M4` 不 import `M1`，它手里没有一个读 ref 的口；将来收进 `M12`，那一处才是同时握着两个底的地方。**它是一条方便的路，不是一个前提**：`refs/heads/<agent>` 用 git 直接指过去同样成立——S7 起 N 个分支时走的本来就是那一条（`M12` 的转移，不进 CLI），`fugue branch` 只是把它收进操作面。

**`ViewRev` 与 `CommitId` 是两件事。** rev 每次写入 +1（一轮内可达数十次），commit 只在提交点产生。`M4` 跟踪 rev，不跟踪 commit——这是 C2 的直接结论。

---

# 第二部分 · 分层

## 5. 分层总览

```
┌─ 编排 Orchestration ─────────────────────────────────────┐
│  M11 contract   拆分 · 契约 · 写入集预检                 │
│  M12 round      轮次状态机                               │
│  M13 merge      单写者合并 · 验收 · 推进真实工作树       │
└──────────────────────┬───────────────────────────────────┘
                       │ 消费（主 agent 本身也是一个 agent）
┌─ 面 Surface ─────────┴───────────────────────────────────┐
│  M8  capability  能力表：调用落在哪层状态                │
│  M9  tools       模型可见工具（纯适配）                  │
│  M10 assemble   协议 + 状态 → 前缀（确定性）             │
└──────────────────────┬───────────────────────────────────┘
                       │ 唯一关卡
┌─ 边界 Boundary ──────┴───────────────────────────────────┐
│  M7 policy      一份策略，两个强制点                     │
└──────────────────────┬───────────────────────────────────┘
                       │
┌─ 内核 Kernel ────────┴───────────────────────────────────┐
│  M6 reclaim     反向通道：声明集内 scratch → 视图        │
│  M5 execute     隔离执行（收已包装 argv）                │
│  M4 materialize 按需物化（D3）：视图 → 真字节，路径精确  │
│  M3 roots       虚拟↔物理映射 + 双空间围栏               │
│  M2 view        OverlayVFS：身份 = 相对路径              │
│  M1 truth       git 对象库：不可变 · 内容寻址 · 并发安全 │
└──────────────────────────────────────────────────────────┘

  M0 log     底座：持久的事件日志，一切状态的权威来源
  M14 probe  底座：从日志重算指标
```

## 6. 两条分层纪律

> **内核不认识模型。面不认识 git。**

- 内核（M1–M6）是纯机制：对象库、内存视图、字节同步、进程管理。**可完全离线测试**——不需要 API key，不需要模型。
- 面（M8–M10）只认相对路径与协议数据。**约束不进入接口。**

两条纪律各给出一个结构性保证：

1. **约束的隐蔽性不依赖自觉**——模型可见面里没有沙箱、没有虚拟化、没有 git。
2. **内核可独立演进为原生实现**（§ 17），因为它的接口不含模型概念；**面可独立替换为不同协议**（§ 10），因为它的输入是声明式数据。

## 7. 模块清单

| 模块 | 层 | 职责 | 复用级别 | 演进目标 |
|---|---|---|---|---|
| `M0 log` | 底座 | 持久的事件日志 + 重放 | 能力 | TS |
| `M14 probe` | 底座 | 从日志重算指标 | 能力 | TS |
| `M1 truth` | 内核 | git 对象库读写 | 能力 | **Rust** |
| `M2 view` | 内核 | OverlayVFS | **核心** | **Rust** |
| `M3 roots` | 内核 | 虚拟↔物理映射 + 双空间围栏 + 符号索引 | **核心** | **Rust** |
| `M4 materialize` | 内核 | 视图 → 真字节 | **核心** | **TS（不演进）** |
| `M5 execute` | 内核 | 隔离执行 | 能力 | **Rust** |
| `M6 reclaim` | 内核 | 反向通道 | 能力 | TS（不演进） |
| `M7 policy` | 边界 | 策略与强制点 | 能力 | 部分原生 |
| `M8 capability` | 面 | 能力表 | 内部模式 | TS |
| `M9 tools` | 面 | 模型可见工具 | 内部 | TS |
| `M10 assemble` | 面 | 协议 → 前缀 | **核心** | **TS（不演进）** |
| `M11 contract` | 编排 | 拆分与契约 | 内部 | TS |
| `M12 round` | 编排 | 轮次状态机 | 内部 | TS |
| `M13 merge` | 编排 | 合并与验收 | 内部 | TS |
| `spawn` | 跨层 | 子 agent 生产者（推论 3′） | 装配体 | TS |
| `runtime` | 跨层 | 步进执行器 | 装配体 | TS |
| `signalBus` | 跨层 | 信号总线 | 装配体 | TS |
| `envRealize` | 跨层 | 环境实现 | 装配体 | TS |
| `mergeKit` | 跨层 | 合并套件 | 装配体 | TS |
| `verifyGate` | 跨层 | 验收门 | 装配体 | TS |

**装配体跨层接线**，不占独立分层。**复用级别定义见 § 11；装配体目录见 § 14；演进触发条件见 § 17。**

---

# 第三部分 · 模块规格

## 8.1 `M0 log`

**职责**：持久的事件日志。一切派生状态的权威来源。

```ts
type WriterId = AgentId | 'round'

type LogEvent =
  | { t: 'view/write';   agent: AgentId; path: RelPath; rev: ViewRev; blob: BlobId; mode: number }
  | { t: 'view/symlink'; agent: AgentId; path: RelPath; rev: ViewRev; target: string }
  | { t: 'view/remove';  agent: AgentId; path: RelPath; rev: ViewRev }
  | { t: 'view/rename';  agent: AgentId; from: RelPath; to: RelPath; rev: ViewRev }
  | { t: 'view/chmod';   agent: AgentId; path: RelPath; rev: ViewRev; mode: number }
  | { t: 'ckpt/commit';  agent: AgentId; commit: CommitId; rev: ViewRev; msg: string }
  | { t: 'mat/fork';     agent: AgentId; base: CommitId; strategy: ForkStrategy
                         paths: RelPath[]; hashes: string[]; ms: number }
  | { t: 'mat/sync';     agent: AgentId; from: ViewRev; to: ViewRev
                         paths: RelPath[]; hashes: string[]; ms: number }
  | { t: 'mat/reclaim';  agent: AgentId; declared: RelPath[]; changed: RelPath[] }
  | { t: 'run/start';    agent: AgentId; step: StepId; action: string; argv0: string
                         argv?: readonly string[]; cwd?: string }
  | { t: 'run/end';      agent: AgentId; step: StepId; exit: number; ms: number; denied: boolean }
  | { t: 'run/confined'; agent: AgentId; mode: PolicyMode; enforcement: Enforcement
                         net: NetMode; layers: readonly PolicyLayer[]; reach: readonly string[] }
  | { t: 'bound/deny';   agent: AgentId; path: string; space: 'virtual' | 'physical'; rule: string }
  | { t: 'signal';       agent: AgentId; id: SignalId; kind: SignalKind; digest: string }
  | { t: 'agent/stop';   agent: AgentId; steps: number; stopped: string; handoffs: number }
  | { t: 'agent/handoff'; agent: AgentId; successor: AgentId; contract: ContractId
                          digest: string; body: string }
  | { t: 'round/state';  round: RoundId; from: RoundState; to: RoundState }
  | { t: 'round/intent'; round: RoundId; base: CommitId; digest: string; body: string }
  | { t: 'holder/distill'; round: RoundId; agent: AgentId; digest: string; body: string
                          against?: string }
  | { t: 'holder/todos'; agent: AgentId; digest: string; body: string }
  | { t: 'holder/plan';  agent: AgentId; digest: string; body: string }
  | { t: 'holder/ask';   agent: AgentId; digest: string; body: string }
  | { t: 'ask/raised';   agent: AgentId; contract: ContractId; digest: string; body: string }
  | { t: 'ask/ruling';   agent: AgentId; asked: string; forwarded: boolean; tier?: AskTier
                         ruler: string; digest: string; body: string }
  | { t: 'round/approve'; round: RoundId; fingerprint: string; contracts: ContractId[] }
  | { t: 'contract/issue'; round: RoundId; contract: ContractId; owner: AgentId; paths: RelPath[]
                          digest: string; body: string }
  | { t: 'merge/attempt';  round: RoundId; branches: BranchId[]; conflicts: number }
  | { t: 'merge/accept';   round: RoundId; commit: CommitId; assertions: AssertionResult[] }
  | { t: 'prefix/assemble'; agent: AgentId; zoneAHash: string; zoneBHash: string; zoneCHash: string }
  | { t: 'llm/call';     agent: AgentId; step: StepId; model: ModelId; wire: string
                         toolCount: number; invocations: number; thinking: string | null
                         stop: string | null; status: number | null; headers: unknown; usage: TokenUsage
                         attempts?: number[] }                                   // 试了几次（P2f）——恰一次时整栏不出现

interface Log {
  append(w: WriterId, e: LogEvent): Promise<LogSeq>          // 序号由该 writer 自己的计数器发放
  readByWriter(w: WriterId, fromSeq?: LogSeq): AsyncIterable<LogEvent>
  readMerged(fromSeq?: LogSeq): AsyncIterable<{ pos: LogPos; e: LogEvent }>
}

interface LogPos { writer: WriterId; seq: LogSeq }
```

**设计要点**：
- **每个 writer 一份日志，各自持有单调计数器。** 并发写者之间不阻塞、不协调。全序由 `(seq, writer)` 的字典序隐含确定，**不消费任何协调**。
- **`view/*` 事件携带 `blob`**——视图的内容是 `M1` 的对象，日志只记路径到对象的指向。**内容是引用，不是副本。**
- **`mat/*` 事件携带 `paths`**——物化清单由此可重放。清单是派生数据，不单独持久化。**它记的是相对 base 变了的路径，不是"铺过哪些路径"**：底就是真实工作树，`fork` 什么都没铺（`mat/fork` 的 `paths` 为空），本 agent 的改动由 `mat/sync` 逐次带上。清单因此恰好等于差异集，日志也不必为一次 `fork` 写下整棵树（§ 8.5）。
- **Signal 只进日志，不进前缀**；只有合并后的结果进入前缀 Zone C。
- **带正文的那九处：`agent/handoff` · `round/intent` · `holder/distill` · `holder/todos` · `holder/plan` · `holder/ask` · `ask/raised` · `ask/ruling` · `contract/issue`。** 机械部分是状态（目标 · 提交序列 · 热改文件清单），模型写的是交接提示词 · 轮级意图 · 持轮者的凝聚理解 · 契约。**判据只有一条：重放要读得到的内容，都必须进日志**（§ 9.7）——否则进程重启即失去，而它要么没有第二份来源，要么取回来要再花一次模型调用。**`holder/distill` 带的是全文，不是增量**：同一轮里每判一次草案追加一条，于是那一轮的草案历史就是这条链（第 1 条是最初那一版），原版因此不必另存一份（§ 15.1.a）。
- **`readMerged` 是轨迹的地基。** 它是一个可保持打开的流：重放读已写部分，实时观察等待追加部分——轨迹因此不需要第二条管道（§ 9.7）。

**验证性质**：重放一份日志，重建出的视图 / 物化 / 轮次状态与当时完全一致。**上面这个联合与代码里那一个逐条对齐**——`src/log/events.ts` 是它的实现，`node tools/check-events.js` 一份命令盯两张表（这一张与归档 § 5.18 那张三面表）。日志的存储格式、崩溃语义与重放算法见 § 9。

## 8.2 `M1 truth`

**职责**：唯一真源的读写。不碰 HEAD、不碰索引、不碰工作树。

```ts
interface Truth {
  putBlob(bytes: Uint8Array): Promise<BlobId>
  putTree(entries: TreeEntry[]): Promise<TreeId>
  commit(tree: TreeId, parents: CommitId[], msg: string): Promise<CommitId>

  getBlob(id: BlobId): Promise<Uint8Array>
  statAt(commit: CommitId, path: RelPath): Promise<EntryMeta | null>
  readAt(commit: CommitId, path: RelPath): Promise<Uint8Array | null>
  listAt(commit: CommitId, dir: RelPath): Promise<DirEntry[]>

  advance(ref: RefName, to: CommitId, expectedOld: CommitId | null): Promise<void>
  resolve(ref: RefName): Promise<CommitId>
  mergeTree(bases: CommitId[]): Promise<{ tree: TreeId } | { conflicts: Conflict[] }>
}
```

**四项硬约束**：
1. per-agent 索引（`GIT_INDEX_FILE`），或完全不落索引、只用 plumbing。
2. `advance` 必须 CAS（带 `expectedOld`）。
3. **`gc.auto=0`**；gc / repack 只在「`RoundState = Collecting` ∧ 全部 agent 已停」的屏障点执行。
4. `mergeTree` 走 `git merge-tree --write-tree`（git ≥ 2.38），不碰工作树。**它是两路的**：git 只收两个分支，多于两个 base 时由调用方逐路折叠（§ 8.14 的合并循环本就是逐路的）。

**`merge-tree` 的成功判据是退出码，不是"拿到了 tree"。** 冲突时它**照样写出一个 tree**，其中冲突文件是带冲突标记的 blob；stage 1/2/3 三元组与 `CONFLICT` 提示随后也打在 stdout 上，stderr 全程为空，退出码为 1。**"拿到了 tree"与"合并干净"因此是两件事**——把前者当成后者，收下的就是那棵带冲突标记的树。

**实测基线**：ext4 上单次 plumbing 调用 1.0–1.5 ms（`hash-object -w` 1.17 · `cat-file blob` 1.06 · `rev-parse` 0.99 · `merge-tree` 1.11）。按 § 17 的触发条件，预算约 **700–1000 次调用/轮**。同一组调用在 drvfs 上是 24–55 ms/次，在 Windows 原生上是 53–80 ms/次（§ 15.7）。

**`lower` 的懒加载必须批量。** 单次 `cat-file blob` 的代价几乎全是进程创建——`rev-parse` 与 `cat-file blob` 的耗时几乎相同（0.99 ms 对 1.06 ms）即为证。若 `M2` 逐文件懒加载 500 个 blob，仅进程开销就是 **500 ms**，直接把整轮预算吃掉一半。**必须走 `git cat-file --batch`：一次进程处理全部请求。** 这是机制替换，不是语言替换——在 Node 里换成一个进程即可，不必等 `gix`。

**验证性质**：N 个并发写者产出 N 个有效提交，**零协调**；`git fsck` 干净；并发 `advance` 同一 ref 时恰有一个成功。

## 8.3 `M2 view`

**职责**：每 agent 一份的内存视图。虚拟文件的本体。

```ts
type Entry =
  | { kind: 'file';    bytes: Uint8Array; mode: number }
  | { kind: 'symlink'; target: string }
  | { kind: 'dir' }

type UpperEntry = Entry | { kind: 'tombstone' }

type Delta =
  | { kind: 'add';     path: RelPath; bytes: Uint8Array; mode: number }
  | { kind: 'modify';  path: RelPath; bytes: Uint8Array; mode: number }
  | { kind: 'delete';  path: RelPath }
  | { kind: 'rename';  from: RelPath; to: RelPath }
  | { kind: 'chmod';   path: RelPath; mode: number }
  | { kind: 'symlink'; path: RelPath; target: string }

interface View {
  readonly id: AgentId
  readonly base: CommitId | null   // null：还没有提交，视图的上层就是全部
  readonly rev: ViewRev            // = 已重放的最大 rev
  readonly revs: ViewRev[]         // 全部可达修订点；0 是 base 本身

  stat(path: RelPath): Promise<EntryMeta | null>
  read(path: RelPath): Promise<Uint8Array | null>
  list(dir: RelPath): Promise<DirEntry[]>          // upper ∪ lower，减 tombstone

  write(path: RelPath, bytes: Uint8Array, mode?: number): Promise<ViewRev>
  writeSymlink(path: RelPath, target: string): Promise<ViewRev>
  remove(path: RelPath): Promise<ViewRev>
  rename(from: RelPath, to: RelPath): Promise<ViewRev>
  chmod(path: RelPath, mode: number): Promise<ViewRev>

  diff(since?: ViewRev): Delta[]
  applyDelta(deltas: Delta[]): Promise<ViewRev>

  check(d: Delta): Promise<void>       // 这个变更做得成吗；与 applyDelta 共用一段判断
  hasUpper(path: RelPath): boolean     // 视图自己的历史里有没有它；下层不算
  kindOf(path: RelPath): 'add' | 'modify'  // 这次写对**上层**是新增还是改写
  state(): ViewState                   // 上层折叠成可持久的一份：§ 9.4 的快照
}

/** 快照里的一条。**内容存 id 不存字节**：blob 已经在对象库里，而写日志的顺序保证了它在。 */
type SnapEntry =
  | { path: RelPath; kind: 'file'; blob: BlobId; mode: number }
  | { path: RelPath; kind: 'symlink'; target: string }
  | { path: RelPath; kind: 'tombstone' }

/** 快照的内容：**该 writer 的日志前缀折叠出来的上层**。不含下层——与日志同一个参照系。 */
type ViewState = {
  rev: ViewRev
  points: ViewRev[]                    // 到 rev 为止的全部修订点；快照之前的那些也要报得出来
  upper: SnapEntry[]
}

/** 一份**已经找到的**快照：定位是 `M0` 的（序号 · 日志当时的字节数），状态是 `M2` 的。 */
type ViewSnapshot = { seq: LogSeq; logBytes: number; state: ViewState }

/** `M2` 对 `M1` 的全部需要：一个提交处的三样读，加上按 id 取对象。**只要读。** */
interface Lower {
  readonly base: CommitId | null
  readBlob(id: BlobId): Promise<Uint8Array>
  stat(path: RelPath): Promise<EntryMeta | null>
  read(path: RelPath): Promise<Uint8Array | null>
  list(dir: RelPath): Promise<DirEntry[]>
}

// 从日志重建一个视图。纯函数：同样的日志必得同样的视图。只要 `Log` 的读侧。
function loadView(
  log: Log,
  agent: WriterId,
  opts: { lower: Lower; upToRev?: ViewRev; snap?: ViewSnapshot },
): Promise<View>
```

**`lower` 是注入的，不是 import 的。** 视图只认一个只读端口（上），`M1` 由 `lowerAt` 适配进来——于是 `M2` 里没有一处 import `M1` 的契约，换后端（内存假体 · 快照 · 将来的 Rust 侧）只换那个小文件。端口里 `readBlob` 那一句不是路径读：重放时事件带的是 blob，内容得按 id 取回来。

**变更方法因此是异步的，而这是"视图有一半是懒的"的直接后果。** 改一个只在 base 里有的路径（改名 · 改权限）要先把它读上来。同步签名只能靠漏掉这一半来维持，而漏掉这一半的后果比变慢更重——那条路径会在视图里凭空消失。

**`check` 与 `applyDelta` 共用一段判断。** 一条日志行一旦落下就是历史，重放会照它执行；所以"这个变更做不做得成"必须在**追加之前**问出来，否则视图拒绝过的变更会留在日志里，"重放必须一致"从根上不成立。`hasUpper` 是同一个问题的另一半：只有下层才有的内容重放时读不回来（base 随提交前移），要先把内容钉进日志（§ 9.3 的装配体）。

**`kindOf` 是同一个问题的第三面。** 一次写算 `add` 还是 `modify`，只有视图答得对：重放那边按**上层**给它定名（看下层会随 base 前移而变），所以装配体落日志之前必须问同一句话。让调用者自己说，同一份日志在活路径与重放上就会给出两份不同的 `diff()`——而"重放必须一致"是承重性质。

**模式只有两档，「没有变化」不算一次变更。** 文件模式在 `Delta` 里一律是 git 的那两档：有执行位就是 `100755`，否则 `100644`——`chmod 700` 与 `chmod 755` 因此是同一件事。**这个转换收进一处**：只有 `normMode` 做它，命令面递进来的那个八进制数在装配体写日志之前收一次，所以 `diff()` 报出来的模式能与 `stat` 直接对照。**收完之后与现值相同的那一次什么都不落**：不落 `view/chmod`（落下就是一条假变更——`diff` 里报得出来，而那个路径一个字节没变），也不为它把下层的内容拷上来（拷贝只为了让这次改得动它）。命令面把这件事说成一句话：stderr 上一行、退 0，stdout 照旧给视图此刻的 rev。

**`state` 给的是上层的折叠，不是此刻这棵树。** 差别在 base 前移时它还算不算数：含下层的读出会过期，只折上层的不会——§ 9.4 的快照正建在这条性质上。

**`diff` 给的是变更序列，不是净差异。** 净差异里一次改名会退化成"删一条 + 加一条"，而 § 8.5 要求 `applyDelta` 覆盖 `rename` 这一情形。序列是重放的片段——把它交给 `applyDelta`，与交给任何一批 delta 没有区别。

**上层建出来的目录没有对象。** `stat` / `list` 给它们的 `id` 是空树；判据是 `kind`，要内容走 `list`。

**`View` 是纯内存对象，且必须是。** 它没有 `open` / `close` / `flush`，也不知道自己从哪来。持久性全部由 `M0` 承担：**先持久，后重建**。这条分工是"派生不持久化"在视图上的落点——视图一旦自己持久化，就会出现第二份真源。

**重建代价与仓库大小无关。** 重放的是这个 writer 自己写下的那些事件，`lower` 仍按需从 `M1` 懒加载。大仓库下重建一份视图的成本由该 agent 自己的操作次数决定，不由仓库规模决定。

**一个视图对应一份日志。** 视图按 agent 分量，各写各的那一份；**把几份视图合成一个提交点不是视图的操作**——那是 § 8.14 的合并。

**"按 agent 分量"与 `loadView` 收的那个 `WriterId`，说的是同一件事的两侧。** 主线那一份日志的写者是**位置**（`round`，§ 4），视图这一侧的名字是**署名**：日志的 `append` 与 `readByWriter` 认位置（要的是"哪一份日志"），视图的 `id` 与事件的 `agent` 认署名（要的是"谁在做"，§ 8.1）。两者在**建视图这一处**并成一件事——由 `agentFor` 一处给出，别处不再转一次。

**这次对齐住在读侧，写日志的地方都不必知道「现在谁在持轮」。** 装配体落一条事件时，署名取自视图（§ 7），不由调用者递进来。持轮者换人时，因此改的是这一处：`agent/handoff`（§ 8.1）记下这个位置交给了谁，`View.id` 随之是那个人——而 `view/*` · `ckpt/*`，以及 `mat/*` · `run/*` · `merge/*` 的每一条写路径，一个字都不用改。

**四个设计要点**：

- **`lower` 懒加载**：base 提交的 tree 按需从 `M1` 读 blob。这是内存视图能承受大仓库的前提。
- **`tombstone` 是必需的**：`read` 必须区分"删了这个文件"与"从来没有过"。前者在合并时是一个删除意图，后者不是。
- **`Delta` 是共享类型**：`M2.diff()` 产出它，`M4` 与 `M6` 消费它，`M6.collect()` 产出它，`M2.applyDelta()` 消费它。**三个模块只共享这一个类型，互不引用。**
- **`gitlink` 可见 · 不可读 · 不可写**：base 里的一个 submodule 入口列得出来、`read` 给 `null`、往里写（`sub/x` 那种路径）被拒，只有整个删掉是允许的。折叠成目录会让模型往里写文件，而那个路径在父仓库里会变成真实文件——submodule 链接被吸收，且不报错。

**验证性质**：
- 对任意操作序列，`diff()` 应用于 base 后等于视图的全量读出。
- N 个视图并行随机操作，各自终态只由自身操作决定。
- 杀掉进程后 `loadView` 重建出的视图，与崩溃前的视图在 `rev`、全量读出、`diff()` 三项上逐字节一致。

## 8.4 `M3 roots`

**职责**：虚拟命名空间与三套物理实现之间的唯一映射层，虚拟空间的路径围栏，以及符号索引。

一个 `RelPath` 对四个消费者有四套实现：

| 消费者 | 物理实现 | 强制者 |
|---|---|---|
| 文件工具（read / write / edit） | **无物理**，直接读写 View | 虚拟空间围栏 |
| 发现工具（glob / grep） | **无物理**，走 View 的 `list` / `read` | 虚拟空间围栏 |
| 执行（bash / run_action） | `<merged>/<rel>` | OS 沙箱（物理）+ 围栏（虚拟） |
| 合并 | `<realRoot>/<rel>`（§ 8.14 第 7 步的落点） | 单写者 + 验收门 |

**`scratchRoot` 是 overlay 的 `upper`，`mergedRoot` 是它的挂载点，底就是真实工作树。** 执行看到的是 `merged`（§ 8.6）；delta 直接写 `upper`，且必须在卸载态（§ 8.5）。`upper` 与 `merged` 是同一份物化的两个面，不是两个目录；**底不另铺一份**——它就是 `<realRoot>` 那棵基础项目树，`fork` 只把它挂进来，不复制、不搬运。于是 `fork` 的代价与仓库规模无关，磁盘上也不多出一棵树（§ 8.5），而视图里没有、项目又必须有的东西（依赖目录 · 工具链 · 构建产物 · 环境文件）照常在物化树里可见。代价是**手改真实工作树会漏进物化树**：那一步不做检测，检测在**物化之前**（§ 8.14：三方比出来的那条判据，落在折叠之后、物化之前），记在 § 22 D20。

**物化的根住在 `<realRoot>/.fugue/mat/`，每个 agent 一套**：`mat/<agent>/{upper, merged, tmp, cache}`。它跟着工作区走（纪律 12）——连可弃的派生物也不落在工作区之外，于是删掉工作区不会在机器上留下没人收的树。**同盘是一条机制前提**：硬链接那一档要求源与落点在同一个文件系统上（§ 8.5），而它是 `overlayfs` 挂不上时的头一档。**磁盘上不会多出第二棵树**——底就是真实工作树那一份，`upper` 只装本次改动；随 agent 数增长的是每个 agent 自己的 `tmp` 与 `cache`（§ 8.6），它们的去留记在 § 22 D21。

**底里因此看得见它自己。** `mat/<agent>/` 住在 `<realRoot>` 里面，而底就是那棵树，所以从 `merged` 看过去它也在：`.fugue/mat/<agent>/{upper, merged, tmp, cache}` 一览无余。**整树遍历的工具会在那儿撞上 `ELOOP`**（实测内核 6.18 · WSL2：`find` 报 2 条 `Too many levels of symbolic links` 并退 1，`du -sh` 与 `grep -r` 同样报错、退 1 与 2）。挡的理由是防递归——`upper` 与 `work` 正是这一门的两个输入，overlayfs 因此拒绝对它们本身的访问。**这是那个落点的直接代价，不是缺陷**：物化的根必须跟着工作区走（纪律 12），而它同时又必须在底里，才谈得上"底不另铺一份"。**躲开它的写法是剪掉那一支，不是过滤输出**：`find … -not -path '*/.fugue/*'` 照样往里走、照样报错，要 `-path <merged>/.fugue -prune -o … -print`（实测退 0），`du` 那一侧是 `--exclude=.fugue`。**我们自己的遍历器一律按前缀跳过 `.fugue`**（§ 9.6 的 `diff-stat` 与 § 8.5 的差异集同一个口径），所以这道噪声只落在"人拿别的工具扫物化树"那一条路上。

```ts
interface Roots {
  readonly realRoot: AbsPath
  readonly scratchRoot: (a: AgentId) => AbsPath
  readonly tempRoot:    (a: AgentId) => AbsPath
  readonly cacheRoot:   (a: AgentId) => AbsPath
  readonly mergedRoot:  (a: AgentId) => AbsPath   // overlay 挂载点；执行只见它

  toScratch(a: AgentId, rel: RelPath): AbsPath    // 卸载态写 delta
  toMerged(a: AgentId, rel: RelPath): AbsPath     // 执行与挂载
  fromScratch(a: AgentId, abs: AbsPath): RelPath | Outside
  toReal(rel: RelPath): AbsPath

  resolveVirtual(path: string, cwd: RelPath): Result<RelPath, Denied>
}

interface SymbolIndex {
  rebuild(commit: CommitId): Promise<IndexHandle>    // 轮边界一次；同一提交必得同一索引
  structure(h: IndexHandle, budget: number): string  // 结构：全仓骨架 + 依赖关系 → Zone A
  query(h: IndexHandle, question: string): string    // 查询：按当前问题重排 → Zone C
}
```

**索引是派生体，与物化目录同档**：同一提交必得同一索引，损坏即重建；`IndexHandle` 是这份派生体的坐标（提交 + 预算），不是服务句柄。**它轮内不动**——重建只在轮边界发生（§ 8.16.a），正因为不动，它才进得了共享头。三段的分工与落点见 § 8.16.a，实现在现成解析器之上（SCIP，§ 8.16.b），落盘与增量维护是未决项（§ 23 U2）。

**两条硬纪律**：
1. **`resolveVirtual` 是虚拟空间的唯一入口**，且必须用 `lstat` 而非 `stat`——边界检查要在解析 symlink **之前**完成。
2. **拒绝文案指路，不筑墙**：
   ```
   $ cat /etc/passwd
   [boundary: path is outside the workspace]  /etc/passwd — it climbs above the view root. Use read inside the workspace; reaching outside the workspace goes through an application (architecture § 15.3.b).
   ```

**验证性质**：**虚拟空间可达集 == 物理空间可达集**。逃逸用例集：`..` 穿越、单/链式/悬空 symlink、硬链接别名（**七条里只有它不是一条路**，见下）、绝对路径、shell 内 `cd`、子进程继承 cwd、TOCTOU。**平台专属的路径形状不进这一份**——UNC · `\\?\` 前缀 · 盘符 · 大小写不敏感认的是另一套路径语义，而视图里的身份是仓库相对路径，认它们等于在核里开一套平台分支；它们随 Windows 作为执行目标那一步补进来（T6）。

**射程要写明白：它管的是"够得着工作区之外的那些路"——硬链接别名在物理侧不是这样一条路。** 实测两半——**读**它读到的内容就在树里（走的每一步都在工作区内），**写**它时 `overlayfs` 的 copy-up 把 inode 断开、工作区外那份一个字节没变。于是它既拿不出"该拒"的读数（拒它的是物化那一层，不是边界），也写不出一句指路（纪律 2 要求拒绝必须指路），**所以它不进"该拒"那一半**——**内容**共享归 § 8.5 的 `copy` 一档与 § 8.14 的合并口，不归 `M7`。

## 8.5 `M4 materialize`

**职责**：把视图变成真实可编译的文件树。派生、可弃。

```ts
type ForkStrategy = 'reflink' | 'overlayfs' | 'hardlink-ro' | 'copy'

interface MaterializeOptions {
  preserveMtime: boolean          // 默认 true
  changeDetector: 'content-hash' | 'mtime-size'   // 仅 copy / hardlink 需要；overlayfs 靠枚举 upper
  detectRenames: boolean          // 默认 false
  pruneEmptyDirs: boolean         // 默认 true
  preferredStrategy?: ForkStrategy
}

interface Materializer {
  fork(a: AgentId, base: CommitId, opt?: MaterializeOptions): Promise<AbsPath>
  ensure(a: AgentId, upTo: ViewRev): Promise<AbsPath>   // 幂等；已最新则空操作
  manifest(a: AgentId): MatManifest                     // 已物化的路径与哈希（派生）
  dispose(a: AgentId): Promise<void>
}

interface MatManifest { rev: ViewRev; paths: RelPath[]; hashes: string[] }
```

**`manifest` 是派生数据，不持久化。** 它由 `M0` 中该 agent 的 `mat/*` 事件重放得到（事件表见 § 8.1，重放算法见 § 9.4）。物化目录损坏即删除重建（下"失败处理"），清单随之重算。**核对物化正确性用的就是这份清单**：把 `manifest.paths` 与全树快照的差异集对齐，两者必须相等——`materialize-precision` 指标即由此定义。

**差异集与清单两边都按内容算，而且在视图的路径空间里算。** 差异集是"base 与视图之间内容不同的路径"（比内容哈希与 mode，符号链接比目标）；物化树里那些视图不认识的路径（依赖目录 · 工具链 · 生成物）既不是变更也不是触碰，不进这个集合。按账本算则相反——物化器碰过哪些就报哪些，比值恒等于 1，于是抓不住"重写整棵树"这一类失效（§ 8.15）。另一条尺子是物化树自己的两次快照（§ 9.6 的 `diff-stat`，按 `(mtime, size, hash)` 比），它判的是"恰好 3 条变化"那一句。

**"base"是那个提交，不是真实工作树。** § 8.4 允许工作树被人手改过而这一层不做检测；清单若拿工作树当基准，"视图写回了 base 的原内容"那一条会被记成变化，而差异集那一侧不认它——`verify-mat` 于是永久报不等。两个问题要分开问：**相对 base 变了吗**（清单与差异集那一侧，读提交）与**合并树里已经有了吗**（落地那一侧，读工作树）。

**写回原内容的路径不碰盘。** 视图里一次 `write` 可以写回与 base 一模一样的内容（模型整份重写、formatter 跑一遍没改动），账本上是一次写而内容上没有变化；照写会让这条路径的 mtime 变，按修改时间判定新旧的工具链于是重新编译它——一次纯粹的假失效。代价是落地之前要读一次 base 侧的那份字节做比较，而读的正是它本来就要覆盖的那份。

**承重性质**：
> `ensure(a, rev)` 之后，**未变文件的 mtime / inode / 内容逐字节不变**。

这条决定持久缓存是否存活。破了它，每个提交点都退化为全量重编译。

**三项各自对谁重要**（3000 模块实测，两次独立运行比值一致；判别字段是总耗时）：

| 用例 | 总耗时 | 相对冷启动 |
|---|---|---|
| 冷启动 | 0.44 s | 1.00 |
| 无改动重建 | 0.14 s | 0.31 |
| 内容变 3 个文件 | 0.15 s | 0.34 |
| **仅 mtime 变** | 0.12 s | **0.28** |
| **仅 inode 变** | 0.13 s | **0.29** |
| 删掉 `.tsbuildinfo`（负对照） | 0.49 s | **1.10** |

负对照给出这条性质的量级：删掉构建缓存后耗时精确回到冷启动（比值 1.10），即缓存收益约 **3.3 倍**。**它说明的是"缓存一旦失效，代价就回到冷启动"，本身不区分失效由什么触发**——把这份收益归到 mtime 与 inode 名下的是下面两张表。

**但 `tsc` 的增量缓存按内容哈希判定，mtime 与 inode 都不参与。** 仅改 mtime 的耗时是"无改动"的 0.90，仅换 inode 是 0.93——两者与不动它并无区别。所以这条断言不能读成"`tsc` 要求 mtime 不变"；它取的是三项之并，覆盖面是**按修改时间判定新旧**的那一类工具链，而这一类确实存在：

| 工具 | 依据 |
|---|---|
| `make` | 以目标与依赖的 mtime 先后决定是否重建。`ccache` 手册在解释硬链接风险时直接写"依赖修改时间的程序（如 make）" |
| Cargo | 官方文档：修改时间比较是"判定一个单元是脏还是新鲜**最常用**的方式"；替代它的内容校验 `checksum-freshness` 至今是 **unstable**，只有 nightly 才产出所需元数据 |
| `ccache` | `sloppiness` 里的 `include_file_mtime` 选项，适用场景原文写的是"**频繁改写文件时间戳的构建系统**"，效果是忽略 mtime——**即默认计算 mtime** |

**第三条正对本架构的情形**：物化器就是那个"频繁改写时间戳的构建系统"。所以它的分量就落在这一条上：**不照做，就会命中一个已被写进文档的坏情况**。

内容哈希侧重的是另一头：`tsc` 那组实测（仅改 mtime 是"无改动"的 0.90）证明**按内容判定的工具不受影响**，两条并不冲突——它们分别覆盖两类工具。

**`ensure` 的调用点**：执行前（隐式）、合并验收物化、冲突解决物化。

**delta 应用必须覆盖的全部情形**：`add` / `modify` / `delete`（含空目录清理）/ `rename` / `chmod` / `symlink`——**六种各在上面那个类型里有一个变体**。**大小写不敏感碰撞由 `applyDelta` 处理**：同一路径的两种大小写拼写视作**同一处**（`delete` + `add`）。

**六个变体说的是路径，而路径上的东西有形状。** 一条 `delete` 指向一个目录时，它说的不是"删掉那一条"，而是"这个路径下面的整棵子树都没有了"——落地在 `upper` 里是**一条** whiteout 打在目录那一条上（"`M2` 的 tombstone 与 whiteout 一一对应"说的就是这件事），另两档是把那棵子树真删掉。由此三条：**目录不是条目**（清单与差异集里没有 `dir` 这种东西——它没有内容哈希，落地根的枚举也只看叶子）；一条路径在视图里"不是目录"，它下面的一切就都不在视图的路径空间里，清单里那些跟着一起消失的后代条目要划掉；落地根里那一条要与视图**同形状**——文件与目录互换时，上层的一个真目录正好把下层的同名文件整个遮住（不需要 whiteout，也不需要先把下层那一条删掉）。

**fork 策略**（探针 + 缓存，非 if-else 链）。下表为 21343 个文件 / 209 MB 语料上的实测：

| 策略 | `fork` 全树 | delta 落地 | 磁盘增量 | 前提 |
|---|---|---|---|---|
| `overlayfs` | **3–5 ms**，与仓库规模无关 | **1.67 ms/文件** | ≈0（lower 只读共享） | Linux，非特权 userns 内可挂载 |
| `hardlink-ro` | 272 ms | 16 ms/文件（须先断链） | ≈0（仅目录项） | 只用于无人可写的路径 |
| `copy` | 0.6–3.0 s | 1.0 ms/文件 | N × 全树 | 处处可用 |
| `reflink` | — | — | — | 需 XFS / Btrfs / APFS，本平台不可用 |

**为什么 `overlayfs` 是首选**：`fork` 与仓库规模无关；`upper` 目录恰好是本次的全部改动——普通文件对应 `add` / `modify`，字符设备 `0:0`（whiteout）对应 `delete`，实测 29 个普通文件 + 1 个 whiteout 正好等于 30 个变更路径。于是 `manifest` 与变更集都是**枚举而非 diff**，`M6.collect()` 就是 `find upper`。`M2` 的 tombstone 与 whiteout 一一对应。

**两条机制约束**：

> **一、`ensure` 与挂载互斥。** 挂载期间不得从外部修改 `upper`。

这是 overlayfs 自身的契约，不是纪律。实测：挂载状态下直接写 `upper`，**改过的路径**在 `merged` 中 **0/30** 可见（dcache 陈旧）；卸载重挂后 **30/30** 可见；而**新加的路径当场就看得见（3/3）**。后一条不影响约束本身：delta 有六种情形（下"delta 应用必须覆盖的全部情形"），量过的只有"改"这一类，`delete` 的 whiteout 与 `rename` 都没有逐条量过——**照"哪一类恰好可见"来放宽规则，就是拿 dcache 的内部行为当契约**。因此 delta 落地一律在卸载态进行，挂载只包围执行。

**挂载的生命周期由物化这几条命令自己管。** 命令表里没有"挂载"与"卸载"两个动词（§ 9.6），所以是：`fork` 铺好底并挂上，它返回的就是 `merged`；`ensure` 先卸（若挂着）→ 落 delta → 挂回；`dispose` 卸载并删除。`diff-stat` 与 `verify-mat` 只读，不动挂载态。**"挂载只包围执行"要读成：卸只发生在 delta 落地那一刻**——`fugue run` 就是那一次执行：它先兑现一次物化（卸 → 落 delta → 挂回），再在挂着的树里起子进程；人自己站在 `merged` 里敲构建命令也一样。

**挂在哪一门命名空间里，是这条生命周期成不成立的前提。** 挂载要能被**别的进程**看见——人进 `merged` 跑构建、下一条 `fugue` 命令接着物化——就只能挂在**调用者自己那一门**挂载命名空间里。一个进程自己 `unshare` 出一门再挂，挂得上，但随它退出一起消失：下一条命令、站在目录里的人，谁都看不到那棵树，等于没挂。于是门路只有两档：**`direct`**（调用者本就在这一门里有 `CAP_SYS_ADMIN`——以 root 跑，或者整个会话在一个非特权 userns 里，§ 15.7 的 E3）与 **`sudo -n`**（借它把挂载挂进当前这一门；`-n` 的判据是"要密码就当场失败"，绝不吊在半路等人敲）。**两档都不通就落到下一档策略并如实报出**（下段），这也是 `overlayfs` 那两档门路要作为平台事实落进配置的原因之一。

**清单记的是变化，不是铺设。** 底就是真实工作树（§ 8.4），`fork` 不铺任何东西——所以 `mat/fork` 的 `paths` 为空，本 agent 的改动由 `mat/sync` 逐次带上（§ 8.1）。`fork` 铺的是 base，也就是视图的 `rev 0`（§ 8.3）：`mat/fork` 因此不需要 `rev`，`manifest.rev` 由 `mat/sync.to` 推进。

**某一档探下来不可用，就退到下一档并如实报出用了哪一档**，不静默换档。探测报出的事实——`overlayfs` 能不能挂 · `reflink` 在不在 · `realRoot` 落在哪个文件系统上——按平台事实落进工作区配置（§ 15.7 · § 15.3.a），`fork` 读它选档，这就是上面那句"探针 + 缓存"的落点；`hardlink-ro` 只对无人可写的路径开放（下"硬链接纪律"）。

> **二、delta 不穿过 `merged`。**

穿过 `merged` 写一个已在 lower 中的文件会触发 copy-up，本平台约 **50 ms/文件**（§ 15.7）；直接写 `upper` 是 **1.67 ms/文件**。视图本就持有新内容的全部字节，而 copy-up 搬运的正是这份数据——**它是一次纯粹的重复劳动**。

由此得到一条对 `M5` 的约束：子进程若在合并树内大量写出产物，每一次写出都付一次 copy-up。**构建产物与持久缓存必须在文件系统层面位于树外**，而不只是在环境变量上按 agent 分开（§ 8.6）。

**硬链接纪律**：

> 硬链接只在"无人可写"时安全，并且只在同一个文件系统内成立。

`src/` 与 `test/` **不使用硬链接**——codegen、formatter、`lint --fix` 会就地写源文件。`hardlink-ro` 仅用于沙箱保证只读的路径（工具链、vendored 依赖）。

这条纪律有一个直接的负对照：对 `cp -al` 出的树就地追加一个源文件，`base` 中该路径的 `(size, mtime, inode)` 随之改变——**共享 inode 被穿透，真源被污染**。正确做法是先断链再写（临时文件 + `mv`）。**它另有一条物理前提**：链接的源与落点必须同盘；物化的根住在真实工作树里（§ 8.4），这一条由构造满足。

**它还有元数据那一半。** 内容那一侧走"临时名 + `rename`"就断了链，而**就地 `chmod` 改的正是 inode**：落地根里那一条与底里那一条是同一条 inode 时，即便内容一模一样也要重写一遍（`rename` 顺带断链）。不这么做，"视图里改个模式"会穿透到真源——实测（`--ro vendor` · `chmod vendor/lib.txt` 644→755）：真实工作树里那一条的模式跟着变了。

**失败处理**：物化目录损坏 → 删除重建。它是派生且可弃的，**不尝试修复**。

**一条 whiteout 打不开的那一支。** 视图先删掉一个目录、之后又在同名路径下建东西——两条 delta 都在日志里，重放得出来。落地时它没有合法的物理形态：一条 whiteout 遮住的是下层的一整棵目录，而要在它下面建东西就得有一个真目录，真目录一建，下层那些没被删掉的孩子就漏回来了。**`overlayfs` 档因此在动手之前拒绝并指路**——出路是换一档重铺（`copy` 与 `hardlink-ro` 的落地根就是我们自己那棵树，对完账就没有可漏的）；重铺同一档绕不过去，那两条 delta 一直在。要它在这一档上也成立只有两条路，都还没批：**逐叶遮回去**（清单与差异集跟着变成逐叶；实测一条 whiteout 0.82 ms）与 **opaque 目录**（`trusted.overlay.opaque`，overlayfs 自己的做法，O(1)，但实测非特权 `EPERM`——要 `sudo`，而只在 userns 里跑的主机上还要留一条回退）。

**验证性质**：
- 改 3 个文件后，全树 `(mtime, size, hash)` 快照必须**恰好 3 条**变化。
- 重放该 agent 的 `mat/*` 事件得到的 `manifest`，与全树快照的差异集**相等**。

**两条性质的边界要写下来，否则它们会被读成比实际更强的东西。** 另两档的"落地集"是从清单推的（只有 `overlayfs` 档是"从盘上枚举"）："落地根里多出来一条"这件事在那两档上看不见。**工作树漂移时三个集合不可能同时相等**——上层里那一条既不在清单里、又不能不留（它是为了盖住被手改过的底才写下的）：S7 的那一步要把它分成两栏，与底逐字节相同 = 陈条（真问题），与底不同 = 漂移补偿条（§ 8.4 的事）。

## 8.6 `M5 execute`

**职责**：在 agent 自己的物化环境里执行，并隔离全部外部状态。

```ts
interface RunSpec {
  action: ActionName
  confined: ConfinedArgv          // 已由能力层经 M7 包装
  cwd: RelPath                    // M3 翻译为物理路径
  env: Record<string, string>     // 已由调用方重写 HOME / TMPDIR / XDG_*
}

interface Executor {
  run(a: AgentId, spec: RunSpec, signal: AbortSignal): Promise<RunResult>
}

/**
 * 一个已经包好的命令行。**S4 里由命令面构造**——`M7` 是 S5，届时"怎么包"整体收进策略，
 * 所以这一份形状是暂居的：先收在一处，落地时整体搬走，不在命令面另立一层。
 */
interface ConfinedArgv {
  argv: readonly string[]              // 真正 spawn 的那个命令行：第一段是沙箱自己
  mechanism: 'bwrap' | 'none'          // 用哪一层关的；`none` 是 § 15.7 的 E4 退化档
  mode: PolicyMode                     // read-only（默认档）· workspace-write（E4 那一档）
  enforcement: Enforcement             // 如实报告，绝不夸大
}

interface RunResult {
  exit: number
  ms: number
  /**
   * 这一趟里出现了沙箱的拒绝签名。**它是读出来的，不是内核给的**：子进程 `open()` 拿 errno
   * 30，而父进程手里只剩退出码与 stderr 那一句——判据因此是那几句文案，不是 errno。
   */
  denied: boolean
  enforcement: Enforcement
  stdout: string
  stderr: string
}
```

**边界纪律**：`M5` **不认识策略**。策略由能力层解析并经 `M7.confine()` 包装成 `ConfinedArgv` 后传入；`M5` 只负责 spawn 与流。

**每 agent 一套环境的七项，五项隔离、两项共享**：

| 项 | 做法 |
|---|---|
| `HOME` / `TMPDIR` / `XDG_CACHE_HOME` | 重写进**沙箱里的坐标** `/cache` / `/tmp`（绑定源是本 agent 的 `cacheRoot(a)` / `tempRoot(a)`） |
| 编译器持久缓存（tsbuildinfo / webpack / vite） | **per-agent**；共享会产生错误的增量构建 |
| 端口 | 池分配，注入环境变量 |
| 数据库 / 服务 | 每 agent 一实例或一 schema |
| 锁文件 / socket / PID | 落 per-agent 目录 |
| 工具链 | **只读共享** |
| 包存储 | **共享**——pnpm store 即为并发访问设计 |

**"编译器缓存在 per-agent 目录"如何物理成立。** 这些工具把输出路径硬编码在工程里（`dist/`、`target/`、`obj/`、`.cache/`），改不掉。做法是三步：

1. `M4.ensure` 在**卸载态**于 `upper` 中预建这些声明过的目录——它们同时充当 bwrap 的挂载点（`--bind` 要求挂载点已存在）。**这一步是必需的，不是可选**：目标不在树里时 bwrap 当场失败（实测 `Can't chdir to --bind`）；
2. 执行时以 `--ro-bind <merged> /work` 让整棵树只读，再对每个声明目录 `--bind <cacheRoot(a)/dist> /work/dist`。**树的挂载点是固定的 `/work`，不是它在宿主上的路径**：子进程的坐标里因此没有一条宿主路径（连 `-g` 编出来的 `DW_AT_comp_dir` 都是 `/work`，跨 agent 比字节才可比）；家与缓存挂 `/cache`、temp 挂 `/tmp`（上表那一行）。**同一次挂载里另需两样，缺了就构建不起来**：`--dev /dev`（只 `--ro-bind / /` 时 `/dev/null` 写不动，`Permission denied`）与**按 agent 的 temp 目录的 `--bind`**（只重写 `TMPDIR` 不够——实测 `Cannot create temporary file in ./`，rc=2）；
3. 子进程看到的是"只读的 `/work` + 若干可写子目录"，而那些子目录的字节全部落在 per-agent 缓存里。

实测结果：`dist/`、`target/`、`.cache/` 可写且可读，源文件仍只读、树内其他位置仍不可新建、删除仍被拒，而**物化树的 `upper` 里文件数为 0**——产出一个字节都没进树，也没有发生任何 copy-up。

> 这条同时解释了 § 8.5 的 copy-up 代价为何在正常执行中不出现：**它只在违反 D1 时发生。** 负对照可以验证这点——把物化树换成可写绑定，同样的写入立即产生 1 次 copy-up。

**`cacheRoot(a)` 里那三块，与端口那一池。** 子进程的 `HOME` 是**沙箱里的 `/cache`**（绑定源就是 `cacheRoot(a)`），`XDG_CACHE_HOME` 是它底下的 `xdg-cache`，`TMPDIR` 是 `/tmp`（绑定源 `tempRoot(a)`）；一个声明目录 `<rel>` 绑进来的**源**是 `cacheRoot(a)/<rel>`，落到 `/work/<rel>`（第 2 步那一条逐字），于是产物落在缓存里，而树里只看得见一个空的挂载点。**端口不靠命名空间**：工作区配置的 `ports.range`（缺省 `31000-31099`）按 4 个号一片切开，第 i 个 agent 拿第 i 片，`PORT` 是那一片的第一个号、`PORTS` 是整片——同一个工作区里几个 agent 的端口因此两两不同（那两个键见 § 15.3.a）。

**这几样不许被盖掉。** `HOME` · `TMPDIR` · `XDG_CACHE_HOME` · `PATH` · `PORT` · `PORTS` 是本 agent 的坐标：动作自己的 `env` 与命令行上 `-- k=v` 的注入都不许出现它们，撞上就**拒绝并指路**——盖掉它们，隔离就成了一句空话，而"跑起来了"看起来一模一样。**宿主环境不再整份递进去**：凭据那一类的清洗由 `Policy` 的 `env` 基线兑现（§ 8.8 的 `env` 栏——缺省 `core` 档，宿主的凭据键不进沙箱；要谁进去在 `boundary.env.set` 里点名），这一层的清单只管上面这六样。

**验证性质**：N 路并发执行的结果与串行逐个执行**逐字节一致**；无残留进程、无端口占用、无跨 agent 缓存污染。

## 8.7 `M6 reclaim`

**职责**：`scratch → 视图` 的受控反向通道，使"视图是唯一写入者"与"子进程会写盘"得以共存。

```ts
interface Reclaim {
  declare(a: AgentId, paths: RelPath[]): DeclaredSet
  collect(a: AgentId, declared: DeclaredSet): Promise<Delta[]>
}
```

**机制**：
- 运行前声明预期产出集；运行后**只回收声明集内**的改动。
- 未声明却被改动的路径 → 拒绝并记 `mat/reclaim` 事件，**绝不静默收下**。**这道闸门只在树可写的那一档上被触发**：默认档里子进程根本写不进未声明的位置（实测 `open()` 拿 errno 30，父进程手里只剩退出码与 stderr 那一句），于是"被拒"分两半——默认档由内核拒，**记事件由这一档**（§ 15.7 的 E4 退化档）兑现。**这条读数每次都取**（代价是一次 `find upper`，与改动数成正比）：默认档里它照例读到空集——那是"树一个字节没变"的读数，不是一句"应该不会"；真读到东西时它照样报出来。
- 产出 `Delta[]`，与 `M2.diff()` 同构，`M2.applyDelta()` 直接消费。

**变更集来自枚举，不来自 diff。** 采用 `overlayfs` 时，子进程的一切改动都落在 agent 自己的 `upper` 目录里：普通文件对应 `add` / `modify`，字符设备 `0:0`（whiteout）对应 `delete`。`collect()` 因此是一次 `find upper`，**代价与改动数成正比，与仓库规模无关**，也不需要任何内容比对。实测 `upper` 的枚举集与全树变化集完全相等。

**声明集内的产出不走 `upper`。** § 8.6 第 2 步把声明目录整个绑到 per-agent 缓存上，子进程写进去的字节落在缓存那一侧（实测 `upper` 里文件数为 0）。所以 `collect()` 对**声明过**的路径读的是那份绑定的落点，`find upper` 覆盖的是"树里那些本该为空的改动"——**两处相加才是这次运行的完整变更集**；少了前一半，声明过的产出会被静默丢掉，而 `upper` 那一侧"干净"反倒成了假象。收的时候一律读那份落点（`cacheRoot(a)/<rel>`）：是文件就一条 delta，是目录就走一遍——**与"这条声明是不是自己被绑的"无关**。

**退化档里没有绑定，落点因此随档变。** 沙箱不在的那一档（§ 15.7 的 E4）没有挂载就没有 `--bind`，子进程写下的字节落在**树自己那一侧**——`overlayfs` 档落在 `upper`，另两档落在 `merged`。所以上一段那句"收的时候读那份绑定的落点"是**默认档**的读法：`collect()` 的落点按这一趟走的是哪一档分两处，两处由**同一份 `collect()`** 读（`cacheRoot(a)/<rel>` 那一侧是绑定的产物，树那一侧是子进程写下的字节），读出来的也是同一样东西。声明目录在这一档里照样在卸载态预建——`cc -o dist/app` 要那个目录先在（§ 8.6 第 1 步）。

**"声明集外的改动"与"声明集内的产出"是两件事，退化档里也一样。** 前者照旧是 `upper` 的叶子 − **那一刻**的清单 − 声明过的那几条（见下面"枚举出来的那个集合要减掉清单"那一段），与落点在哪一侧无关；后者按上面那句话读。两件事各是各的读数，合起来才是这一趟的完整变更集。**一条白障要是某条声明路径的祖先目录，不在这条判据里**：它是那次声明的删除在上一层的影子（声明 `legacy/old-format.js` 的那一格把空掉的 `legacy` 也 `rmdir` 掉，内核为那个目录留下一条白障），而"集外的改动"要的是子进程改了什么，不是它父亲那一层被留下了什么。**只跳白障**（父亲那一层落的要是别的形状——把 `legacy` 换成一个普通文件——照报）· **只跳祖先**（那棵目录下面别的没声明的路径被删，那些白障各自照报）。

**树可写而没有 `upper` 可枚举 → 当场拒绝，不退化成一句空话。** 那道闸门靠枚举 `upper` 兑现，而 `hardlink-ro` 与 `copy` 两档的落地集是从清单推的（§ 8.5 末段）："落地根里多出来一条"在那两档上看不见。两件事叠在一起（树可写 + 没有 `upper`）时 `collect()` 给出的是**有由头的拒绝**，而不是"查过了，没有"——要跑退化档，就得让 `fork` 走 `overlayfs`。

**一条声明在树里是一条目录，除非它已经被另一条声明盖住。** 挂载点是 `--bind` 的前提（§ 8.6 第 1 步），而一条目录绑定挂不到一个文件上；反过来，为一个已经落在绑定里的文件再挂一条，那条的挂载点得先在树里是一个**空文件**——而空文件是叶子，它进清单、进差异集，`verify-mat` 当场就不等了。所以粒度是：`outputs` 与 `cache` 里没被别的声明盖住的那些，**自己是一条目录**（不在树里就在卸载态预建）；被盖住的那些，是**落在那份缓存里的一条路径**。`{"cache":["dist"],"outputs":["dist/app"]}` 因此读作"`dist` 整条绑进树、回收 `dist/app` 这一个文件"，而单写 `{"outputs":["gen"]}` 是"`gen` 整条目录的产出都要"。

**枚举出来的那个集合要减掉清单。** `upper` 里本来就有东西：`ensure` 把视图的 delta 落在那儿（§ 8.5），而 `fugue run` 起进程之前先兑现一次物化——**那一下刚好把视图里还没落地的 delta 写进 `upper`**。所以"这一趟子进程在树里改了什么" = `upper` 的叶子 − **那一刻**的清单，不是运行前从日志里读的那一份；少了这一减，一次 `fugue write` 之后紧接着的那次运行就会把物化自己落下去的东西报成"越了声明"（S4 落地时实测撞到过）。清单是派生数据、不进 `M6` 的契约（§ 8.3：`M2` · `M4` · `M6` 只共享 `Delta`），由调用点递进来。

**回收在卸载后进行。** 枚举 `upper` 必须在 overlay 卸载之后——挂载期间从外部读 `upper` 看到的是写者视角的原始目录，而 `merged` 的 dcache 又不会反映外部改动（§ 8.5）。

**三个使用场景**：

| 场景 | 声明集来源 |
|---|---|
| `run_action` 带 `apply: true` | 工作区的动作绑定（§ 15.3.a） |
| 冲突解决 | 合并报告的冲突路径 |
| 构建产物 | **不回收**（应落 temp / dist，不进视图） |

**默认策略**：执行时工作区对子进程只读，仅 temp / cache 可写。这是"视图是唯一写入者"这一不变量成立的前提，也是"构造上无 N² 冲突"成立的前提。

**验证性质**：未声明路径的写入被拒并记事件；声明路径的改动被精确回收，`diff()` 只含这些路径。

## 8.8 `M7 policy`

**职责**：一份策略值，两个强制点，并保证二者一致。

```ts
interface Policy {
  mode: 'read-only' | 'workspace-write'
  writableRoots: readonly AbsPath[]
  enforcement: 'full' | 'partial'
  reach: ReachSpec                              // 物理可达集：只读根 · 软链 · 设备与进程 · 树里挖掉的
  coords: Coords                                // 子进程那一侧的坐标：树 · 家与缓存 · temp
  net: 'none' | 'host'                          // 网络那一档：缺省 none，动作点名才 host
  layers: readonly ('bwrap' | 'landlock')[]     // 这一趟在场的层——**探出来的，不是人写的**
  env: EnvSpec                                  // 环境基线：宿主环境递进去多少（§ 14.4）
}

interface EnvSpec {
  inherit: 'core' | 'all' | 'none'              // 基线档：core=定位那几样（缺省）· all=宿主整份（退化档）· none=空
  set: Record<string, string>                   // 静态注入（过坐标六键的保留清单，撞上拒绝）
  exclude: readonly string[]                    // 从基线里剔除
  includeOnly: readonly string[]                // 窄化基线：只递这份白名单里的
}

interface ReachSpec {
  roRoots: readonly string[]                  // 只读挂进来的宿主路径（文件或目录）
  symlinks: readonly { at: string; to: string }[]   // 只读根之外还必须存在的软链
  devices: readonly string[]                  // 设备与进程（/dev · /proc）
  mask: readonly string[]                     // 树里要挖掉的（相对树根）：`.fugue`
}

interface Coords {
  tree: string                                // 树在子进程眼里的挂载点：`/work`
  home: string                                // 家与缓存（`HOME` · `XDG_CACHE_HOME`）：`/cache`
  tmp: string                                 // `TMPDIR`：`/tmp`
}

interface Boundary {
  resolve(path: string, cwd: RelPath): Result<RelPath, Denied>   // 虚拟空间
  confine(argv: string[], p: Policy): Promise<ConfinedArgv>      // 物理空间
  checkReach(roots: Roots, p: Policy, binds: RelPath[]): Result<RelPath[], ReachDenied>   // 启动前：两侧对得上吗
}
```

| 强制点 | 空间 | 机制 | 覆盖 |
|---|---|---|---|
| 虚拟空间围栏 | 虚拟 | `Roots.resolveVirtual` | 文件工具、发现工具 |
| OS 沙箱 | 物理 | bwrap（清单那几条 `--ro-bind` + 四条软链 + `--dev` / `--proc` + 树里挖掉 `.fugue`（空且只读）+ 根 remount 成只读 + `--unshare-net` / `--unshare-pid`）/ Landlock / Seatbelt / 受限令牌 | 执行、反向通道 |

**`reach` 是"工作区即宇宙"那句话的落地。** 一份**只读根清单**：树（挂 `/work`：`read-only` 档只读 · `workspace-write` 档可写——档只决定这一个字）+ 四条软链（`/bin` `/sbin` `/lib` `/lib64`）+ 只读工具链（`/usr` · `/opt` · `/etc` 的三条 + `/etc/resolv.conf`）+ `/proc` 与 `/dev`；**树里的 `.fugue/` 在沙箱那一侧挖掉**——`config` · `log/` · `mat/` 都住在树里，而它们不该进子进程的可达集。**清单可声明**：工作区配置的 `boundary.reach`（§ 15.3.a），不给就是探针量出来的缺省值——**清单是量出来的**，与 § 8.5 那套"探针 + 缓存"同一个口径。**沙箱里的坐标固定成三条**（`Policy.coords`——`confine()` 的 argv 与子进程那几个环境变量读的是同一份）：树 `/work` · 家与缓存 `/cache` · temp `/tmp`；**退化档里它们如实写宿主那三条**（那一档没有挂载，子进程就在宿主上跑）。**根自己也要只读**：新根是 `bwrap` 建的一份 tmpfs，没挂进来的顶层路径都住在它上面，不 remount 成只读的话它们是**写得进去的**（实测：`/etc/x` 写成功，落在沙箱自己那份 tmpfs 上、宿主上不留痕）——"没点名的一律不在"就多出一个静默的例外，所以那一步排在所有挂载之后。漏了清单会**当场起不来**（实测：缺 `/lib64` → `landlock: 起不来：/usr/bin/echo（errno=2 No such file or directory）`；缺 `/etc/alternatives` → `landlock: 起不来：cc（errno=2 No such file or directory）`——所以清单的维护面是这一栏的代价，不是缺口。

**`net` 是要求，`layers` 是供给，两个都不许夸大。** `net` 记这一趟要哪一档（缺省 `none` = `--unshare-net`；动作在配置里点 `"net": "host"` 才开）；`layers` 记这一趟在场的是哪几层（§ 15.7 的 E4 · E5，现探）。**供给跟不上要求时如实降，一档一档地降**：主层（`bwrap`）不在 → 第二层（Landlock）接过"写得动什么"那一维，`mode` 记 `read-only`（树确实不可写——未声明的写入由内核当场拒）、`enforcement` 记 `partial`、`net` 记 `host`（Landlock 没有网络那几条规则，没有哪一层能把它拿走）；第二层也不在 → `mode` 记 `workspace-write`（树可写是那一档的事实）、`enforcement` 记 `partial`、`net` 记 `host`。**`mode` 报的是这一趟写入维的事实**（它在引擎里只决定树可不可写），所以"只有第二层"那一档报 `read-only`（未声明的写入当场拒），而 `--mode workspace-write` 在那一档仍算数——有人点名要树可写，第二层就把整棵树开出来。**`enforcement: full` 要两层都在场**（§ 15.7 的 E5：少一层纵深，如实降一档）——**`full` 读作"这台机器上在场的层都在管"**，不是一条达标线：主层在场只说明"这一趟有沙箱"，"这一趟有没有少一层"只有把两层都算进来才看得见。

**挂载层与档正交：它管的是"子进程看得见什么"，而档管的是树可不可写。** 所以 `workspace-write` 那一档照样上主层（树那一条换成 `--bind`，**树以外照旧一条都不在**）——两件事各是一维，谁都不替谁开口子。缺了"看得见什么"那一维的后果是一次真实泄漏：real 组那一趟的 `bash` 在宿主上跑，读到了这一趟的**验收结果**与**请求实录**（样本盘第十五趟 · 案一：`/tmp/scenario-*/run/…/work.json` 与 `wire-plan/` 那一串 `request.json`）——"它自己解出来的"于是不再是一条证据。**这件事在日志里读得出来**：`run/confined` 不只 `fugue run` 那一趟写，`round work` 的**每一格第一次起子进程时**也写一条（同一个 `Policy`、同一处解析），样本盘逐趟核它是不是 `full`——不是就当场红，那一趟的数字不进账。


**`net: host` 给"出网"，缺省清单里的 `/etc/resolv.conf` 给"出名字"。** 那一档拿到的是宿主那门网络命名空间：**同一个宿主服务端、同一个端口**上，缺省档是 `ECONNREFUSED`（那是孩子自己那份回环）、要网那一档是 `ok`（那是宿主的回环）——这一对读数才说得上"那一刀真切在命名空间上"，而不是碰巧没网。**名字那一半是清单给的**（网与可达集正交，这一条是它的落地）：缺省清单的第六项就是解析器配置那一条，要网的动作因此按域名也通（实测 `dns=ok:104.20.23.154` · `https://registry.npmjs.org/` → `ok:200`，连跑五遍五通），而缺省档（`net: none`）一个字节没变（`err:EAI_AGAIN`——那一门命名空间里没有出去的路）。**为什么只挂一条**：分档量过（`tools/probe-net-s5.sh`），`/etc/hosts` 与 `/etc/nsswitch.conf` 不必要——名字解析走 glibc 的 `dns` 那一支。


**承重不变量**：
> 文件工具可达的路径集 == 子进程可达的路径集。

**启动时一致性检查**：枚举虚拟可达集与物理可达集（后者反映射回虚拟），不一致则**拒绝启动**（fail-closed）。三条落不到策略里的情形在这一步拒，且**指出是哪一条**：声明的目录落不到视图里（`cache` / `outputs` 带 `..` 或绝对路径——过的是 § 8.4 那道围栏，与 `M6` 的 `declare()` 同一个内核）· 清单里一条在宿主上不成立（`boundary.reach` 写错了）· 软链指不到清单里去。**层不在场时不查清单那两条**：清单只被 `confine()` 读，一层都没有时查它就是把地板调低。不在这儿拦的话，报出来的是别人的话（实测：`bwrap: Can't find source path /opt/没有这个: No such file or directory`——说的是"源找不到"，而真正要改的是工作区配置那一栏）。

**`enforcement` 如实报告**，绝不夸大。工作区即宇宙这一设计使得 `full` 成为可达目标。**这句话里的"宇宙"要写准**：宇宙 = 树（挂在 `/work`，只读）+ `reach` 清单里的只读工具链 + 沙箱自己那份临时空间（`/tmp` 是沙箱里的一份 `tmpfs`，写下去的东西在宿主上看不见），可写的那部分是 § 8.6 那张表里的几项。

**人还能声明期望档**：工作区配置的 `boundary.enforcement`（`"full"` | `"partial"`，缺省不声明）。声明 `full` 而实测层不齐 → **起跑前拒**（`resolvePolicy` 一处解析，`fugue run` 与 round 两路同拒），文案指两条出路——把层补齐，或把声明改 `partial` 如实跑降档；不声明 = 照跑照实报。**降档静默这件事因此有了口子可关**：写下来"我知道我在降档"，或者干脆让它起不来——第三种状态（声明了却悄悄降）不存在。

**两层机制，实测均可用**（Linux / WSL2）：bwrap 的 mount 围栏是主层——树那一条按档选（`read-only` 档 `--ro-bind` 只读 · `workspace-write` 档 `--bind` 可写），声明目录另绑一条可写的；Landlock 是第二层，内核 ABI 7——**它管"写得动什么"**（未声明的写入内核当场拒，不是事后记一笔），与主层管的"看得见什么"正交。**主层不在时它是地板**：同一趟里未声明的写入当场拒、声明目录照写、产物照回收；两层都不在时同一趟真写得进树里（`undeclared` 那一栏报出来）。

**第二层是一份自己编的小程序**（住 `<realRoot>/.fugue/bin/`，§ 9.2）。Node 里没有直接发这个系统调用的路，而这一层必须在 `exec` 之前把自己关进去——所以它就是"先 `landlock_restrict_self`、再 `execvp`"的一段 C，`cc` 编一次（源码变了才重编）。**静态链**：它自己不该依赖清单里那条动态链接器——清单少一条时它要是起不来，报出来的是"包装器找不到"，指向的是错的地方；编不出来（`cc` 不在、没有 `libc.a`、或这一门内核里没有 Landlock）时这一层如实缺、`enforcement` 降一档，不静默。**可写集是主层真的挂成可写的那几处**（temp · 家与缓存 · 每个声明目录）外加 `/dev/null` 那一类设备（不含它们任何一次重定向都翻车）——**两份各数各的会让两层错位，而错位的那一半是静默的**。叠在一起时 argv 是 `bwrap … -- <包装器> --rw <可写落点>… -- <原命令行>`；包装器在主层那一侧挂在沙箱根的**点名字** `/.fugue/landlock-exec` 上（`ls /` 那份读数不变，`ls -a /` 多出它）。

> **Landlock 的可用性必须用系统调用探测，不能读 `/sys/kernel/security/lsm`。** WSL 中 `securityfs` 未挂载，该文件不可读，但 `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)` 返回 ABI 7。按文件探测会得到假阴性，让能力探测误报缺失。

**第三条正交的道由 seccomp 封，不进 `layers`。** 挂载层管看得见、Landlock 管写得动，而**系统调用那一维**有自己的道——vsock（AF_VSOCK 不属于网络命名空间，`--unshare-net` 挡不住它，`socket(40)` 也不需要 `/dev/vsock` 节点；实测 2026-09-29 宿主与沙箱内**都通**）。它由一份与 Landlock 包装器同形制的 seccomp 包装器封成 EPERM（BPF 只封一条：`socket(AF_VSOCK)`；`no_new_privs` + `SECCOMP_SET_MODE_FILTER`，`execvp` 原 argv）。**它不在 `Policy.layers` 里、不参与 `enforcement` 口径**——那两栏数的是"看得见"与"写得动"的层，这一维自己一栏；编不出来或不在时它如实缺，逃逸表丁组那条「vsock 那条道」常驻盯着：红着就是没封住（读数该是 stdout 无 leak 字样、stderr 落 `vsock-sealed 1`）。叠进链里时 argv 是 `bwrap … -- <seccomp 包装器> <landlock 包装器> --rw … -- <原命令行>`（seccomp 在最外）。

**验证性质**：逃逸用例集全部被拒；拒绝文案指向正确的替代能力。实测基线——只读绑定下，原地改源文件、在树内新建、删除、**写工作区外**四项全部被拒，而声明路径可写。

## 8.9 `M8 capability` —— 能力表

**职责**：声明每个工具落在哪一层状态。**全部行为分叉的集中处。**

| 落在哪层状态 | 工具 |
|---|---|
| 视图 | `read` `write` `edit` `read_image` `glob` `grep` |
| 执行（物化后） | `bash` `run_action` |
| 真源（提交） | `checkpoint` |
| 日志 | `todo_write` `ask_user_question` `exit_plan_mode` |

**除表之外只剩一句要单独说的：** 执行类的产出一律经声明集回视图（`M6` 反向通道）：`run_action` 自带那份声明集（绑定的 `outputs`，门上跨字段检查保证 ⊆ 契约写入面），`bash` 没有——格内两者同走宿主接的那份契约面（W8 起）。**其余每一格都是这一层的推论**——四条推论各有一个消费方：

| 推论 | 成立条件 | 谁据此分叉 |
|---|---|---|
| 先物化 | 落在执行层 | `M4` 的 `ensure(rev)` |
| 过路径围栏 | 落在视图层或执行层 | `M3` 的 `Roots.resolveVirtual`（§ 8.8 强制点一） |
| 关进 OS 沙箱 | 落在执行层 | `M7.confine()` 包装出 `ConfinedArgv` 再交 `M5`（强制点二） |
| 可回写视图 | 落在执行层，且该能力声明了声明集 | `M6` 反向通道 |

**这张表是全函数。** `ToolName` 只有一处定义（§ 8.10 的工具目录），能力表以它为键，因此**任何一个工具少了这一层都编译不过**——错误在编译期报出，不是等到它被调到。

**两条设计决策与其理由**：

**发现类走视图侧。** `glob` / `grep` 直接在 View 上求值，不 spawn 外部进程。理由：若走物化侧，`write` 之后立刻 `grep` 会看到旧内容，模型将陷入"我明明写了"的循环。一致性的优先级高于单次性能，性能由视图内的路径索引解决。

**执行有两副形状，守同一条不变量。** `fugue run` 默认 `read-only`：树按 `--ro-bind` 挂，声明的目录另绑一条可写的（§ 8.6 那三步）；格内（W8 起）取 `workspace-write`：树那条换成 `--bind`、**不绑声明目录**——`--bind` 的挂载点必须在树里先存在，而"声明一条产出**文件**"是最常见的形状，bwrap 在只读树上建不出它（实测 `Can't mkdir /work/a.ts: Read-only file system`）。可写面换了个地方封：**声明集**——集内的差异回视图、进提交，集外的改动 `mat/reclaim` 如实报、进不了提交。**这就是 § 8.7 的默认策略**在执行侧的样子：产出去不去视图，由声明集说了算，不由挂载方式说了算。

## 8.10 `M9 tools`

**职责**：模型可见工具。纯适配层，**零策略**。

```ts
interface Tool {
  name: string
  description: string
  parameters: JSONSchema
  execute(args: unknown, ctx: CapabilityCtx): Promise<ToolResult>
}
```

**命名原则：采用训练分布的公共子集。**

| 类别 | 工具名 |
|---|---|
| 文件 | `read` `write` `edit` `read_image` |
| 执行 | `bash` |
| 发现 | `glob` `grep` |
| 待办 | `todo_write` |
| 交互 | `ask_user_question` |
| 计划 | `exit_plan_mode` |
| 本架构新增 | `checkpoint` `run_action` |

**这张目录是 `ToolName` 的唯一定义处。** 能力表（§ 8.9）以它为键，因此目录里每一个工具必定落在某一层状态上。

新增能力**追加**到公共子集，不替换其中任何一项。内部实现（虚拟化、沙箱、git）不体现在名称与参数上。

**两条硬纪律**：
1. **只公布能兑现的选项。** 某档环境无法兑现的工具或字段，不出现在该档 schema 中。
2. **工具目录跨状态逐字节稳定。** 工具 schema 属于前缀；schema 随状态变化即前缀字节变化。`exit_plan_mode` 在计划模式未激活时仍保留在 schema 中，正是此故。

**实现纪律**：**工具内不含策略。** 策略全部在能力层（§ 8.9）与 `M7`；工具只调用能力层，不直连内核。

**验证性质**：状态切换前后，工具 schema 的哈希不变。

## 8.11 `M10 assemble`

**职责**：从环境状态与协议装配出本轮前缀。**确定性纯函数。**

**模型读到的那一份字节是英文**（这一版的口径：切法是**谁读**）：模型的思考面只有一种语言——装配出来的段文本（「我的任务」那几行 · C 区那条尾巴的 `Model:` / `Tool <名字> (call N):`）· 工具目录（`§ 8.10` 十二条的描述与逐参数说明）· 持轮者那一份的收工口径与拒的话 · 草案那一段（键与形状）· 写入面那两条拒的话 · **工具回执与拒的话**（`tools/execute.ts` 十二条的成功与失败两路 · `tools/receipt.ts` 那句截断标记 · `roots/fence.ts` 四句 · `roots/paths.ts` 的 `detail` · `view/view.ts` 的 `PathShapeError` 五句 · `capability/dispatch.ts` 四条推论那四句），逐条都是短句英文——记法照 DeepSeek Harness：系统提示词通篇英文（`snapshots/web/*/system-prompt.expected.md` 39 行，没有一句随用户的语言变），给模型看的诊断另立一处（`fs/tool-fs/src/error.ts` 的模块注释写着 "the stable message shown to the model"），而**唯一一句语言指令落在"系统要模型产出给人看的文字"的地方**——会话标题那一路写着 `Use the language of the messages.`（`session/session-title-llm/src/index.ts`）；人那一面它另有一套本地化（`client/locale`）。**中文留给另一批读者**：命令行 · 日志 · 报告 · 停因 · 案例内容与目标（人写的）· 注释 · 两篇文档；**印记**（断言失败 · 载入时抛出 · 配置错——它们走日志与报告，模型读不到）同样是中文。两边各自一处来源，谁也不抄谁；而**进前缀的仍是值**（§ 13.4 的 P2），换成哪种语言不改变形状。落地时撞出来的那条分界是"读者"而不是"这是提示词还是结果"：同一句话（围栏那四句 · 写入面那两条 · 命令行印出来的那一份）模型与人都读得到，按**模型那一侧**的读者定成英文；守卫是 `src/tools/execute.test.ts` 的 ⑨（模型读得到的每一条过一遍，一个汉字都不许有）。

```ts
interface Prefix {
  zoneA: Uint8Array   // 共享头
  zoneB: Uint8Array   // 分支增量
  zoneC: Uint8Array   // 每步尾部
}

interface Assembler {
  assemble(i: {
    protocol: Protocol
    model: ModelId
    segments: Record<SegmentId, SegmentValue>   // 值，非句柄；键域 = segmentOrder 的域
  }): Prefix
}

interface Protocol {           // 声明式数据
  version: string
  segmentOrder: SegmentId[]
  toolCatalog: ToolName[]
  renderers: Record<SegmentId, RendererId>
}
```

**组装器的输入是一个字典，不是一个具名字段的结构。** 段是**值**，容器是 `Protocol` 声明的顺序——**加一种段就是加一个键，类型不动**（§ 24 纪律 8）。字典的键域与 `segmentOrder` 同域，因此"有一个段没被渲染"和"渲染了一个没人排过序的段"都不成立。

**十二个段，三个区，各有其拥有者**（§ 13.4 **P1**：组装器不生产状态）。下面这一份是子 agent 的形状；**持轮者是另一份声明**（再下一张表）。**区就是稳定性等级**——它决定什么样的值放得进来，也决定这段字节在多长的一段前缀里被复用。**`segmentOrder` 管的是其中十一段**：工具目录的位置由提供方定（下），不在我们排的序里。

**共享头内部再按"跨轮是否变"排一遍。** 前缀命中只看**从头到第一个变化的字节**，所以先稳后变才拿得到跨轮复用：跨轮稳定的在前（项目方针 · 系统状态，加提供方定的工具目录），**每轮重建**的在后（代码树）——它一变，只作废后半段。

| 区 | 段 | 拥有者 | 源 | 稳定性 → 缓存角色 |
|---|---|---|---|---|
| **A** 共享头 | 项目方针 | 人 | `<realRoot>/AGENTS.md`——**人编辑，不在视图里**（§ 9.9） | 跨轮稳定 · N 个分支与**持轮者**（round holder，即**正在持轮的那个**主 agent，可替换；§ 15.4）逐字节相同 → **可命中的主体** |
| | 工具目录 | 宿主 | 常量源 · `M8` 的能力表（§ 8.10）。**位置由提供方定**——它是 `tools` 字段，不是我们排的段 | 同（跨轮稳定） |
| | 系统状态 | 系统级 | **暴露给这个工作区的全部能力** = 配置对本工作区的投影（§ 15.3.a）。配置变一次它就变。投影终形（`P3b2` 拍平）：五栏 + `actions`/`toolchain` 两串 name 排序清单，绑定的 `env` 值不进 | 同（跨轮稳定；配置改动落在轮边界） |
| | 代码树 | 宿主（产出者是 `M3`） | 索引的**结构**部分（§ 8.16.a） | **轮内冻结**：全部并入、轮边界重建 → 跨 agent 逐字节相同，**轮内命中** |
| **B** 分支增量 | 工作总目标 | 持轮者 | 轮级意图（§ 15.1） | 同一 agent 跨步稳定 → 命中 |
| | 文件内容 | `M2` | 视图，**按剩下的余量裁剪**——放几份是算出来的（上限 − 固定段 − 交接余量 − 这一刻其他段已经占的），不是一个条数 | 同 |
| | 提交序列 | `M1` | `ckpt/commit` | 同 |
| | 交接提示词 | 前任模型 | `agent/handoff`（首任为空） | 同 |
| | 我的任务 | `M11` | 契约值：`goal` · `question` · `deliverables` · `evidenceRequired` · `assertions` · `seed`，末尾机械追加产物路径（§ 8.12）。**判据是"模型据此做事的那几项"**——`id` · `agent` · `branch` 是系统的键，模型不据此做任何事，因此不进前缀；三种契约各自有哪几个键，由 `kind` 决定（§ 8.12） | 同 |
| **C** 每步尾部 | 运行时上下文 | `runtime` | **积累段**：这一趟里那条自然增长的流——**人说的那一句**（这一趟的输入，只属于这一趟，§ 15.1.a）· 模型自己的输出 · 工具结果。**只追加、不进日志、跨进程即失**（§ 9.7） | 每步可变 → 不命中（设计如此） |
| | 信号摘要 | `signalBus` | **合并后**的信号 | 同 |
| | 上一步结果 | `runtime` | 上一步的工具结果与输出 | 同 |

**A 区的四段都是声明，不随步变。**

**段的集合由角色决定。** 上表是**子 agent** 的形状；持轮者是另一份声明：

| 区 | 持轮者与子 agent 的差别 |
|---|---|
| **A** 共享头 | **逐字节相同**——两个角色只在这里相交 |
| **B** 分支增量 | 多两段：**凝聚理解**（源：`holder/distill` 的**最后一条**——即当下这一版；同一轮的历史留在日志里按坐标取回，§ 15.1.a）· **凝聚前最近几次原文**（源：会话记录，按坐标取回）（§ 15.1.a）；少一段：**我的任务**——它手里是全部契约，不是一份 |
| **C** 每步尾部 | 机制同子 agent；内容含**全部契约的上报**与讨论（§ 15.1） |

**两个角色在 A 区逐字节相同，在 B 区与 C 区各自成立。** A 区管的是"N 个分支共用那一段"，B 区是"这一个 agent 分支的增量"，C 区是"这一步的尾部"——后两者天然属于各自的 agent。**若 B 区也要求逐字节相同，那么共享头与分支增量这条划分就没有存在的理由了。**

**两份声明都是值。** 组装器的输入是（状态, `Protocol`），而 `Protocol` 是段序与每段渲染规则的声明（§ 13.5）——**持轮者用的是另一份 `Protocol` 值**，组装器的代码一行不改。这正是纪律 8：扩展只加在值上，不加在顺序与形状上。

**顺序是承重的。** `Protocol.segmentOrder` 给出段的顺序，`renderers` 给出每段如何渲染。段的内容来自多个来源，**但没有任何来源定义段的容器，它们只贡献段**。

> 段的**有无**可以随步变化（追加即可）；段的**顺序**必须由 `Protocol` 声明式固定。

顺序直接决定前缀字节序，而字节序是缓存命中的唯一杠杆：任何运行时可变的顺序都会让相邻两步在前缀中分叉。同理，段的**形状**决定消费方的完备性，也必须声明式固定。**扩展性只加在值上，不加在顺序与形状上**——这与"契约内容可贡献、契约值不可变"是同一条纪律的两个面。

**B 区的段序按"缓存共享段最长"固定**：

```
工作总目标 → 文件内容 → 提交序列 → 交接提示词 → 我的任务
```

工作总目标与文件内容排在最前，因为**接任者与前任在这两段上逐字节相同**，共享的字节段因此尽可能长；**"我的任务"排在最后**，它是**稳定部分的最后一句**（C 区每步可变的内容排在其后）。

**契约要求的产物路径机械追加在最后一段的末尾。** 它逐 agent 不同、逐 agent 稳定，因此它属于 B 区；而放在"我的任务"尾部同时满足三件事——**稳定性同级**（同一 agent 跨步不变，B 区的命中不受影响）· **缓存不吃亏**（放进 C 区，这个每步都不变的值就要每步重付一遍）· **近因最好**（它落在会逐字节复用的那一段的末尾，模型读到这里就动手，而这里正是它要写进去的那个位置）。**"机械"指的是这里没有判断**：目录名怎么定是 § 8.12 的事，渲染规则只是把它拼进那一段，构造器不为它做任何选择。

**契约的写入面先说在这一段里。** "我的任务"除了契约那几项与产物路径，还带一句**这一格的写入面**（`declaredSetOf(contract)`：实现型是 `ownedPaths` · 解决型是冲突路径集 · 调查型是它那几份证据的路径）：哪几条归它（含它们下面）——模型读到的那一串是：`Write surface: <声明的那几条> — these paths are yours, including everything under them. Do not change a single byte anywhere else, deleting included: if you find something stale, say so in your conclusion instead of clearing it away.`。它逐 agent 稳定，所以进 B 区（不是每步重付一遍的 C 区）。**它是"伸手之前"那一面**：`write` / `edit` 落在声明集外当场拒（§ 8.9 的声明集回写那一栏），而 `bash` 那一条按 § 8.7 **只报不拒**——于是"别动别人的地界"这件事原先在输入侧一句都没有。real 组照出来的症状：声明 `src/format.ts` 的那一格看见 `legacy/old-format.js` 那份过时的死代码就删，删的是**别的格**的地界（第八 · 九 · 十趟各 3–9 条，那些删除不进视图、不进合并，因此一直没代价）。它与持轮者那一格的收工口径同一族——**先说 · 拒时再说 · 快用完时说**（§ 15.1.a 末那一段）。

**四条约束**：
1. **Zone C 只追加，绝不修改中部。** 修改中部会使 B 与 C 全部失效。
2. **物化路径不进入任何区。** 模型看到的是相对路径。
3. **环境标识不进入 A 区。**（轮次编号 · scratch 路径 · 主机名 · 逐 agent 各不相同的产物目录）它只出现在**已经天然分叉的地方**——每个 agent 自己的段里。
4. **Signal 不进入前缀**，只进日志；仅合并后的结果进入 Zone C。

**约束 3 是区表的直接读法：一个值的稳定性必须与它所在区的稳定性同级。** A 区要求"N 个 agent 逐字节相同"，所以任何逐 agent 或逐步变化的值都不行；B 区只要求"同一 agent 跨步相同"，所以**逐 agent 稳定、且与这个 agent 的任务有关的值，是 B 区的事实**；C 区每步可变，什么都放得下，但每步都要重付一遍 token。**这条判据取代枚举**——判断一个新值该放哪，看它的寿命，不看它的名字。

**C 区是唯一积累的部分。** A 与 B 每步重建，C 是一串只追加的尾巴；因此"按当前问题重排的符号列表"（§ 8.16.a）也只能在末尾追加一份新的排序、末次生效，不能改旧的。

**它的长度靠重组来管，不靠压缩——这是原则，不是取舍。** 压缩的前提是"对话即状态"：上下文中断了，状态就中断了，所以只能把它摘要成一段塞回去。本架构的枝干不承重：**进度活在分支上**（§ 24 纪律 10），上下文是每步重建的投影。因此长到上界时的动作只有一个：**换一个 agent 接着做**（§ 8.13），或者**重建一个持轮者**（§ 15.5）。

**取重组而不是压缩，理由是给模型的东西不同**：重组给的是一份**干净的状态**，压缩给的是一份**已经被解释过一次的叙述**——那一次解释里的偏差，后面无从核对。而且这是极端情形：**任务拆分之后，单个 agent 触及上界本来就少见。**

**分区的兑现机制：模型声明一句，决定 C 如何增长。**

前缀缓存要求**逐字节相同的完整前缀单元**。因此当 Zone C 的内容变化时，只有两种合法增长方式，取决于目标模型读系统提示词的方式：

| 模型的声明 | 机制 | C 的新内容落在哪 |
|---|---|---|
| **`systemPromptUpdate: 'in-history'`** | 模型把历史中**任意位置最新的** `system` 消息读作有效系统提示词 | **在已缓存历史之后追加一条 `system` 消息**——前缀直到历史末尾全部复用 |
| **未声明**（默认） | 模型只读**开头**的 `system` 消息 | 只能**改写第 0 条**（或把变化并入下一条 user 消息）——从该 token 起全部失效 |

**这是模型的声明式能力，不是适配器的 if-else。** 它是模型目录里声明的一个字段——**上表那两行是它的取值**，而落到处理上是三种：空文本清除 · 序列中断时归并回头部 · 具备能力时追加。**共享头就是"永不重写的第 0 条"，每步尾部就是"仅追加的尾部"**——三区划分在协议层正是这样落地的。

**表外还有一项，它不是段：调用配置。** 模型 · 推理强度 · 上限**不是 token，是请求的字段**——提供方把它读成参数而不是文本，所以它**没有位置**，对它只有一条要求：**轮内固定**（§ 10.2）。工具目录与它不同：**它有位置，只是位置由提供方定**（提供方把 `tools` 序列化进提示词开头），因此我们对它只有稳定性要求，没有位置要求。调用配置属于**请求的形状**，不属于**流的形状**。

**工具 schema 与 Zone A 同级。** schema 变化从第一个改变的请求 token 起使复用失效，因此工具目录的稳定性与 Zone A 同要求（§ 8.10 的验证性质）。

**验证性质**：
- 跨 N 个 agent：`hash(zoneA)` 全等。
- 同一 agent 相邻两步：`hash(zoneA + zoneB)` 不变，仅 C 变化。
- 前缀中不存在绝对路径与 Signal 原文；环境标识只出现在每个 agent 自己的段里——**A 区中不存在**，因此 A 区的全等性不取决于谁碰巧起了什么名字。

**`Protocol` 就是这份前缀的全部自由度**——段序、每段的渲染规则、段的键域都在它里面，`M10` 只做排序 · 渲染 · 拼接（§ 13.4 **P1**）。

> **任何自由度最终都必须能表达成数据**，否则它会在适配器里变成分支。

## 8.12 `M11 contract`

**职责**：把轮级意图化为每分支的契约，并保证契约之间可静态预检。`M11` 是**契约的构造过程**。

```ts
// 持轮者说要哪些证据，构造器说放哪。目录名是契约在集合中位置的纯函数——
// 逐 agent 不同、逐 agent 稳定，因此它随最后一段进 B 区（§ 8.11）。
// 核对：产物在分支增量中存在且非空。
type Evidence = { artifact: RelPath; note: string }

type Contract =
  | { kind: 'implement'
      id: ContractId; agent: AgentId; branch: BranchId; goal: string
      ownedPaths: RelPath[]                    // 写入集上界，派发时冻结
      deliverables: Deliverable[]
      assertions: Assertion[]
      seed: RelPath[]
      actionOutputs: Record<ActionName, RelPath[]> }
  | { kind: 'investigate'
      id: ContractId; agent: AgentId; branch: BranchId; goal: string
      question: string
      evidenceRequired: Evidence[]
      seed: RelPath[] }
  | { kind: 'resolve'
      id: ContractId; agent: AgentId; branch: BranchId; goal: string
      base: CommitId
      conflictPaths: RelPath[]                 // 写入集 = 冲突路径集
      assertions: Assertion[] }
```

**三种契约的差别是真实的，不是字段缺省。** 三种的**写入面来源**各不相同，而每一种都有写入面：`implement` 由持轮者给的 `ownedPaths` 声明；`resolve` 等于它的冲突路径集；**`investigate` 的产物落在构造器按位置定名的专属目录里**（见上面的 `Evidence` 注释）——因此它的写入面**不可能与任何契约相交**，不需要相交预检。把三者压成一个"字段全带、多数为空"的记录，会让每个消费方处理对它无意义的字段：合并判据不该过问只读契约的 `ownedPaths`。

**而"不可能相交"这件事今天进一步兑现为：它的产物根本不进折叠。** 折叠那一圈（§ 8.14）只收写入型契约的提交，调查型那一格的产物留在它自己那条分支与日志里——它是**侦察**，不是这一轮要落的字节；人或者下一趟要看它，按那条 branch 去读（命令面那一档 `--agent`）。这样主树与下一轮的「文件内容」段里不会多出侦察产物，而"调查型不会与谁相交"这条性质也不再只是预检那一句话（口径 · 人拍的 · 样本盘第十二趟之后；**改主意的条件**：real 组里出现"下一轮非读那份证据不可、而按 branch 去读够不着"的情形，那时改成把**结论那一段**折进来、证据文件仍不折）。

**契约是不可变值；可变的是构造它的过程。**

**它住日志里。** 契约以 `contract/issue` 发布，与交接提示词 · 凝聚理解同一形状（`digest` + 正文，§ 8.1）：重启之后，"这一轮派过什么活、按什么验收"重放得出。正文各字段的形状见 § 22 D19。

各处向**构造过程**贡献字段，构造完成即产出定值。**每一格的合法值域另有唯一持有者，而它不等于填写者**：

| 字段 | 来源 | 值域持有者 |
|---|---|---|
| `kind` | 持轮者（拆分方式） | 契约本体（三个变体） |
| `id` | 构造器 | `M11`（唯一生成者） |
| `agent` · `branch` | 构造器 | 身份分配器（§ 14.1）；`branch` 的存在性由 `M1` 判定 |
| `goal` · `question` | 持轮者 | `round/intent`（轮级意图是它们的上界） |
| `ownedPaths` · `seed` | 持轮者 | `M3` |
| `deliverables` | 工作区配置 | 工作区配置 |
| `assertions` | 工作区配置 | 工作区配置（候选）· 验证门（可执行性） |
| `evidenceRequired` | 持轮者（要哪些证据）· 构造器（产物目录 · 按位置定名） | `M3`（路径合法性）· `M13`（增量核对） |
| `actionOutputs` | 工作区的动作绑定（§ 15.3.a） | 系统级动作白名单（`ActionName`）· 构造器（⊆ `ownedPaths`） |
| `base` | `M13` 冲突报告 | `M1` |
| `conflictPaths` | `M13` 冲突报告 | `M13`（即报告的冲突路径集） |

这与"日志 append-only / 视图是它的投影"是同一个形状：**契约之于派发，正如视图之于日志。**

**可验性在字段类型上，不在契约本体上。** 三级分工不重叠：

| 层级 | 负责 | 例 |
|---|---|---|
| 本体（判别联合） | **哪些字段存在** | `kind` |
| 字段类型 | **值是否合法** | `RelPath` · `CommitId` · `ActionName` · `Evidence` |
| 构造器 | **跨字段与跨契约的关系** | 写入集相交（D6） |

加一个字段的代价由此恒定为三处：变体里加一笔 · 指名值域持有者 · 消费方调用那一个检查。**扩展性来自这里，不来自往本体上加判断。**

**值域持有者定义"什么算一个合法的 X"，不判断"这个 X 现在能不能用"。** 后者是**关系**——路径 × 视图 × 策略——属于第三级。这条分界不成立，"每字段一个持有者"就退化成到处查表。

**预检因此是一个动作，不是一层。** 构造完成后按声明式清单逐项调用各持有者自己的检查，全部不落地。持有者是既有模块，检查是既有代码路径——**不引入新的接口类型**。为它建一层 `FieldValidator`，就是把唯一实现变成两份。

**跨字段的关系也归构造器。** `actionOutputs` 声明的输出目录必须落在 `ownedPaths` 内——否则动作会在执行中途被拒，而它本该在派发前就报错。这是第 3 级"跨字段关系"除写入集相交之外的第二个实例。**第三个实例在同一张表的 `assertions` 那一格**：它的候选表就是配置里绑好的那几个动作（§ 15.3.a），所以一条断言指名了一个没绑的动作时，报出来的话要带那个名字与现成的有哪几个——**不猜、不补、不替它挑**。三条都在构造完成之前跑完，每条报出来的话各自带得出位置（哪一份契约 · 哪一条动作 · 哪一条产出）。

**`seed` 是唯一一个"内容量由判断决定、且直接进前缀"的字段，因此它有两条准则。**

| 场合 | 来源 | 上界 |
|---|---|---|
| 初次派发 | 预备态列出的**该阶段所需文件的指针** | 总量（token 估账）≤ 模型上限 − Zone A − 交接余量；**Zone A 那一项按当前上限的 8% 估** |
| 自重启 | **该分支最近的几个改动文件**（机械来自分支增量） | 同 |

**两套来源都是指针，不是内容复述**——内容按内容寻址存放，组装时才取。

**Zone A 那一项是一个比例，不是一个常数。** 它按当前上限的 8% 估（上游报的上限 1 048 576 那一档就是 83 887）——固定段（项目方针 · 系统状态 · 工具目录 · 代码树）的大小随工作区走，而写死一个数会在窗口换一档的时候静默配错。8% 是暂定值：真读数（§ 23 U6）之后按固定段的实际占用量收窄。**这条式子还有一块地板**：算出来为负就取 0，并把这件事报出来——负值说明这份声明自己配错了，不是"没有种子可用"。

**量的是"这些指针取出来多少"**：指针清单与它在某一棵树上取到的内容接成一段，过同一把尺（从哪棵树取由调用方定——初次派发是轮次钉住的那个底，预备态是持轮者那份视图，自重启是那条分支）。只量清单那一侧的话，那个上界对着几行路径永远不响——而超限与否，只在这里判得出来。

**超限要拒绝派发，不是裁剪后照发。** 带着超限的种子派发，等于派发一次立刻触发的接续。

**写入集只可收窄，不可扩宽。** 收窄不破坏 D6——相交只会变少。但它仍使 Zone B 失效，所以是**安全但有代价**，不是自由。更常见的情形走另一条路：契约的 `ownedPaths` 是**上界**，实际写出的东西由动作声明集表达（D3 · D7），那是每次动作的事，比重发契约便宜得多。

**上界在视图这一侧的写入口上拦得住。** `write` 与 `edit` 落在声明的那几条**或它们下面**之外的，**当场拒**并落一条 `bound/deny`（由头那一栏是 `contract-scope`），拒的话里列出声明的那几条，并指出两条出路：交给别格，或让持轮者重发契约。视图一个字节不改。界取"那几条或它们下面"是 `ownedPaths` 那句话本身（`['src']` 说的是"`src` 这一棵归你"），不是"恰好这几条"。它与 `M3` 的路径围栏并列而不是它的特例：围栏判"这条路径在不在工作区里"，这一道判"这条路径归不归这一格"，两道都过才写得下去。这一道与 `M6` 那一道读的是**同一个集合**（`declaredSetOf` 那一处）——回收只收声明集内的产出，写也只许写声明集内，同一条界两个面，一边宽一边窄就有一条缝。**执行面那两条（`bash` · `run_action`）不走这一道**：它们的越界是树里的事实，由 `M6` 的 `undeclared()` 如实报出来（§ 8.7）；视图这一侧拦得住，是因为改视图只有 `write` · `edit` · 回收那三道口。声明集为空的那一格（只读型一条证据都不要）**写任何路径都被拒**，不是不设闸门——空集说的是"这一格一个字节也不写"。

**写入集相交只覆盖一种失败模式。** 它判的是"两个契约会不会写同一处"。**拆得太粗**（等于没拆）与**拆得太细**（几个契约互相等待）都没有事前判据。它们有事后判据：越界率、零进展率、打回次数与失败断言的类型（§ 8.13.a）。**事前不造伪判据，事后用读数改下一轮的拆分。**

**两重作用**：
1. **合并的判据**——使合并由判断转为核对。
2. **能力调用的触发器**——"要不要调用"由核对清单给出，而非由判断给出。

**写入集预检跑两次，同一份检查，而两处都只报不拒。** 第一次在 `Planning`（放行那一步），第二次在合并前（折叠之前那一刻）——**判决一样，读数的位置不一样**：相交那几对印在门那一趟与报告那一行（`预检：Planning N 对 · 合并前 M 对`），人可以在门口不批。**相交不是"坏合并"的判据**：`ownedPaths` 是上界，申报有重叠而实际没撞车是常态（两个格各改一个文件、而声明里都带上同一个目录）。真正的把关在两头，都对着"真的发生了"：折叠当场报出真撞车并走冲突环（§ 8.14），验收在**推进之前**拦住"折得干净而合起来是坏的"（`commitThenAdvance` 不过就不动真实工作树，还能回一次）。**合并前那一档原先报出即拒，今天不再拒**：它站在最坏的位置——格子全跑完了才拒，那一轮的钱已经花掉，而它防住的只是"申报有重叠"；要 fail-closed 那一档留着（`--strict-merge-gate`），改主意的条件写在那一段。两处跑的是同一个函数，因此不会给出不同答案。

**验证性质**：构造相交契约，必须在委派时（而非合并时）报出。只读型契约的产物落在构造器按位置定名的专属目录里，因此**不可能**与任何契约相交。

**一次验收有三种结果，不是两种。** `AssertionResult` 是**通过 · 没通过 · 跑不起来**：前两样关于契约（活干得对不对），第三样关于仪器（这条断言根本执行不了——命令不在 · 工作树里没有那个脚本 · 退出码 127 那一类）。**分开的理由是打回率这个读数**：验收门服务两个消费者（§ 14.6），验收结果又是拆分质量唯一的**事后**判据（§ 8.12 末尾），把仪器故障并进"没通过"，一次环境问题就会让读数飙高，而读数一脏，下一轮拿它改拆分就改错了方向。第三档不进打回计数，报的时候与"没通过"分栏，并指出是哪一条断言的哪一步跑不起来。

## 8.13 `M12 round`

**职责**：轮次与分支的状态机。只做转移，不做动作。

```
                    ┌──────────────────────────────────────┐
                    ▼                                      │
  Idle ──用户指示落地──> Planning ──issue N contracts──> Delegated
                    │                                │     │
                    │                          启动 N 个分支│
                    ▼                                ▼     │
                 Aborted <──abort──────────────  Working    │
                                                    │      │
                              ┌─────────────────────┤      │
                              │ 全部 Done/Failed/超时 │      │
                              ▼                            │
                          Collecting ──gc/repack 屏障──┐    │
                              │                        │    │
                        写入集预检                      │    │
                              ▼                        │    │
                           Merging <──── 冲突? ────────┘    │
                              │              │              │
                              │        冲突解决（物化+回收） │
                              ▼                             │
                          Verifying ──没通过 ∧ 超界──> Aborted    │
                              │                                 │
                              ├──没通过 ∧ 未超界──> Working ──────┤
                              ▼                                 │
                          Committed ──> Rebuilding ─────────────┘
```

**分支子状态**：`Forked → Working → (Done | Failed | Preempted) → Merged | Discarded`

**`Idle` 不只是"没在跑轮次"，它是持轮者与用户的讨论态。** 小任务在 `Idle` 里由持轮者直接完成——不开轮、不建分支、没有契约与合并。**只有需要拆分的大任务才建 `Round`。**

**五个关键点**：
- `Idle → Planning` 的**触发**是用户的显式落地指示，**守卫**是意图快照已建立。这一条把"讨论"与"拆分"分开。
- `Planning` 是**预备态**，且 `Planning → Delegated` 上有一道**默认为停的门**——预备态的定义、回退为何免费、门的触发与三条出路，全部见 § 15.1.a。
- gc 屏障位于 `Collecting`，且在全部 agent 停止之后。
- 事务边界是 `Committed`：只有到达该状态，真实工作树才被推进。
- `Aborted` 从任意状态可达，并保留可诊断的物化目录。

**结构纪律（防 god module）**：状态机**只做转移，不做动作**。动作由各模块注册为转移的副作用。

> **只有 `Round` 存在时才有"轮次持有者"。** `Idle` 中的持轮者是同一个 entity，但它不在轮内——因此没有轮级意图，只有与用户的对话。

**验证性质**：
- 重放 `round/state` 事件序列得到的 `RoundState` 与当时一致，且每一次转移都能指到触发它的那一条事件。
- `Aborted` 从任意状态可达；`Collecting` 的 gc 屏障只在全部 agent 停止之后打开。
- 重试上界与接续上界各自独立计数：构造一个既不重试超界、又持续接续的契约，状态机不得进入 `Aborted`（§ 8.13.a）。

### 8.13.a 循环重启

**子 agent 不在上限处停止。** 接近上限时，它被机械地要求写下一段交接提示词（`agent/handoff`），随后由同一 branch 上的新 agent 接续。**重组是循环的**——一个契约可以被接续任意多次，轮级状态不变。

```
接近上限（早于上限，留出写交接的余量）
  └─ 机械要求：写出交接提示词 → agent/handoff 进日志
       └─ 机械组装：Zone A（共享，逐字节不变）+ Zone B（工作总目标 ·
            文件内容 · 提交序列 · 交接提示词 · 我的任务——契约原样重发，
            因此这一段与上一届逐字节相同）+ Zone C（空）
            └─ 新 AgentId，同 branch，重发契约
                 └─ 分支仍在 Working —— 轮级状态不变，循环下去
```

**触发点必须早于上限**，中间那段余量就是写交接提示词的预算。上限、触发点与余量三者都是模型相关的量（§ 23 U6）；**比例这一版定成上限的 35%**（`triggerAt`）——交接要早：触发点越贴上限，交接那一次调用就越贴着上限走，"写得下"这件事就越靠运气。

**机械部分与模型部分的分界**：

| | 来源 |
|---|---|
| 原始目标 · 该分支的 `ckpt/commit` 序列 · 热改文件清单 | **机械**，全部来自日志 |
| 交接提示词 | **模型**，因此含"为什么" |
| **人给的判词**（验收打回时） | **人**，同样只能由人给出 |

**重组里有两样东西机械恢复不了：模型写的交接提示词，与人给的判词。** 前者在子 agent 那条路上出现，后者只在打回那条路上出现。

**在机械可恢复的部分里，只有提交序列携带"为什么"**，所以到达有意义的节点即 `ckpt/commit`，`msg` 就是进度叙事。

**按谁发起，接续分两类。**

**一、自重启 —— 子 agent 发起，持轮者无感**

| 情形 | 判据 | `base` | 种子 |
|---|---|---|---|
| **有进展** | 有 `view/write` 或 `ckpt/commit` | 自己的最后提交 | 契约原样重发 + 工作总目标 + 该分支最近的改动文件 + 提交序列 + 交接提示词 |
| **无进展** | 连续 K 步无写入、无提交 | 同一基点 | 同一集合 + 上一届交接提示词里被换掉的策略约束 |

**无进展是机械重组唯一处理不了的情形**：它会原样再造一个卡住的 agent。因此它按**核对而非判断**触发——`M14` 的 `zero-tool-call-rate`、`detour-rate` 与写入计数共同给出判据。

**自重启不改持轮者侧的任何一个字。** 同一个契约、同一条分支、同一个验收目标；持轮者只看到"还没结束"。

**二、被委派 —— 持轮者发起**

| 情形 | 判据 | `base` | 种子 |
|---|---|---|---|
| **验收打回** | 断言失败，或人给的判词 | 该分支最后提交 | 契约 + 失败断言或判词 + 该分支的提交序列 + 上一届交接提示词 |

**重新委派是换一个 agent，不是让原来那个重做。** 它的种子**尽可能从日志机械拼**：失败断言（或人给的判词）来自验收门，提交序列来自 `ckpt/commit`，上一届的交接提示词来自 `agent/handoff`。**持轮者不搬运任何细节**——它只在核对清单上签名。

**打回的上下文不在持轮者里累积。** 持轮者停在验收态，反复验收同一个目标。由此得到一条干净的上界：

> **持轮者的上下文随契约数量增长，不随尝试次数增长；而契约数量的增长有凝聚兜底。**

十个契约就是十份验收结果，打回一百次仍然是十份。这是"打回不累计"这条约束唯一的效果，也是它值得成为约束的原因。**长的那一项是 Zone C 里的上报，而凝聚在轮边界把它压回去**（§ 15.1）——所以这里随契约数增长，不随尝试次数增长。

**两条共同的机制。**

**其一，起点定格成提交。** 接续触发的那一刻，若自上次提交以后有过写入，**先定格一次 `ckpt/commit`**。**进度活在分支上，不活在物化目录里**——物化目录按设计是一次性的（执行时只读、产出经声明集回收、agent 结束即回收）。没有这一步，接任者的起点会退回上一次提交，中间那段进度就看不见了。重启点本来就是一个有意义的节点，这不新增机制。

**其二，缓存不被破坏。** 新 agent 的 Zone A 与其他 agent 逐字节相同，只有 B 与 C 是新的。这是循环重启在成本上可行的原因。**接力前缀按"共享字节段最长"排段序**（§ 8.11）：工作总目标与文件内容排在交接提示词之前，前任与接任者在这两段上逐字节相同。

**重组与契约重发同价**：新 agent、新 Zone B、Zone A 保住。契约不可变没有引入新的代价类别。

**两个上界，不是同一个计数。** 轮级状态机只在"验收打回"这一路上有回边——`Verifying ──断言失败 ∧ 未超重试上界──> Working`，`Aborted` 只在超界时到达，因此**每个契约有重试上界**。**自重启走另一条路**：它由 `M14` 的核对触发，需要**每契约的接续上界**。两者独立——一个契约可以既不重试超界、又永远接续下去。**重试上界的缺省是 1**（`fugue round run --retry <n>`）：验收没过就自动回 `Working` 再干一遍，第二遍还不过才判这一轮失败；`--retry 0` 表达"一遍都不重来"。

**打回的严格程度与拆分的优秀程度是替代关系。** 划分得好，打回可以宽；划分得差，只能靠打回兜底，而每次打回都要重启一个子 agent。这个权衡不该由人调，它有读数：

| 读数 | 划分得差 | 打回得太严 |
|---|---|---|
| **越界率** | 高——子 agent 想写契约没声明的地方 | 低 |
| **零进展率** | 高——起来了却一步没写 | 低 |
| **打回次数 + 失败断言的类型** | 断言指向越界或目标不自足 | 次数**顶到上界**而断言始终同类 |

**越界率那一栏从哪来。** 它读的是"想写到声明集之外"，三处来源，都在 `probe/status.ts` 一处算齐。**被挡的两处**（`refusals`）：**视图与围栏那一侧**是 `bound/deny`（按由头分组——`contract-scope` 这一档就是"想写契约没声明的地方"，`plan-scope` · `plan-path` · `fence:*` 各自成档），**执行那一侧**是 `run/end` 里 `denied` 为真的那些（内核把未声明的写入当场拒）。**报了没挡的那一处**（`outside`）：`mat/reclaim` 里 `changed` 非空的那几条——树可写那一档里内核不拦未声明的写入，回收如实报出来、也不收它（§ 8.7），于是它既没被挡，也不进前两处；`changed` 为空的那几条是"照例读到空集"那个读数，不是越界。**视图那一侧的拒一条都不落 `run/end`**（那几条工具不起进程），所以打回那三个数里的 `denied` 看不见它——两栏分开读，一个说拆分切得干不干净，一个说这一轮过没过。

**失败断言说"越界"或"目标不自足"，动的是拆分；说实现不对，打回是对的。** 这套读数是**事后**判据，用来改下一轮的拆分——事前判据只有写入集相交一条（§ 8.12）。

## 8.14 `M13 merge`

**职责**：单写者合并 · 验收 · 推进真实工作树。

```
1. 预检       M11 写入集相交（Planning 与合并前各报一次；两处都只报不拒，§ 8.12）
2. 内存合并   M1.mergeTree(branches)
3. 冲突?      → M4 物化冲突树 → M6 回收解决结果 → 回到 2
4. 物化一次   把合并结果落成一棵能跑的树——唯一产生真字节的一步
5. 跑验收     装配体 verifyGate（§ 14.6），跑在第 4 步那棵树上
6. 通过 →    M1.commit(tree, parents, msg) → 提交点（`merge/accept` 记下它）
7. 推进       M1.advance(main, commit) → 写真实工作树（跳过保留前缀，§ 9.10）
```

**承重不变量**：
> 真实工作树只被推进到**已通过验收**的状态。

**顺序就是这条不变量的形态**：验收跑在第 4 步物化出来的那棵树上，第 6 步才定格提交点，第 7 步才写真实工作树——**断言失败时，真实工作树一个字节都没动**（§ 20 的 S7 验证条款）。

**真实工作树的处理（C7）**：
- 轮次开始时**钉住** `realRoot` 的 commit 作为 base，**并且把它记下来**（`round/intent` 的 `base` 那一栏）：钉住的底不是"当时 HEAD 的读数"——HEAD 后来动了，这一轮仍然在它上面，而放行那一趟（`round go`）要拿同一个底把同一份草案重算一遍，算出来的才是人批的那一批。
- 轮次进行中**声明冻结**并告知用户。
- 合并前**检测漂移**。这一档不是"脏了就拒"，拒的判据是**会被覆盖**：两个集合相交才拒，话里报出是哪几条。
  - 一边是**第 7 步会摊平掉的路径**：这次合并会写出不同内容的那些，加上目标树里没有、工作树里在的那些——**删也算覆盖**。
  - 另一边是**工作树相对 `base` 已经不同的那些**，**含轮次开始之前就存在的手改**：用户把改到一半的东西留着再开一轮是常态，只看得见"轮次开始那一刻起新增的脏"的话，拒的话根本说不出来。
  - HEAD 指到了别处 → 同样拒。
- **判据是核对而不是检测**，比的是**"目标树 vs 盘上"**——与 D6 的写入集相交同一把尺子，一个在虚拟空间、一个在真实工作树。理由是不这么定就只剩"脏了就拒"：轮次一开就等于把工作区冻结给系统，而一轮可能很长（§ 22 D20）。
- **判据是三方比出来的**（S7 的 A10 落地）：同一趟跑三份读数——`touched` 这次合并**动到**哪些路径（目标树相对 `base` 不同）· `divergent` 盘上与**目标树**不同的那些 · `handTouched` 盘上与 `base` 不同的那些。**判据落在两条线上**：盘上那一份**既不是 `base`、也不是目标树**（三方两两都不同）→ 拒；**目标树里没有、而盘上不是 `base`** → 拒（用户手改过的那一份会被推进会静默删掉）。两条都不成立的照常：盘上就是 `base` 那一份（用户没碰过——推进该写就写、该删就删，**"目标树里没有、而盘上就是 `base`"这一支因此是放行的**）· 盘上与目标树逐字节相同（用户那份恰好就是合并算出来的结果，推进不覆盖任何人的字节）。
- **检测落在物化之前**（不在"折叠之前"）：判据的另一边是**目标树**，而它是折出来的那个提交。折叠只往对象库里落中间提交，盘上一个字节都不动，所以"不可逆的那一步之前判"这条承重性质不受影响（§ 8.4 那一句按这一档改了措辞）。
- 第 7 步是**两件事**：把真实工作树摊平到那棵树（跳过保留前缀）· 把 `main` 挪到那个提交点（CAS 钉在轮次开始时钉住的底上）。顺序是**验收 → 摊平工作树 → 挪主线**：前两步任何一步没过，主线仍指着轮次开始时的底。

**保留前缀不进真实工作树。** 它活在视图与提交里，但不进用户的交付物：`M13` 推进时跳过它。前缀清单是宿主的常量源之一（§ 15.3）。

**验证性质**：注入必然失败的断言后，真实工作树**一个字节都没被碰过**；合并成功后真实工作树内容与该 commit 的 tree **在保留前缀之外**逐字节一致；轮次中改动 `realRoot` 时——盘上那一份**既不是底、也不是这次合并算出来的**（含"目标树里没有、而盘上有"的那些）则合并被拒，盘上就是底那一份、或与目标树逐字节相同则合并照常（§ 22 D20 那一档 · S7 的 A10 把判据做成三方比法）。

**三方比法是这样量出来的**（S7 的演示脚本量到，留在这里当取证）：换判据之前，判据比的是"盘上 vs 盘上"（轮次开始那一刻的基线与现在比），而且"会被覆盖"只算了写。三条路**全部静默退回 `base` 那一版**——退出码 0、日志里不留事件、手改在任何提交里都不存在（`git log --all -S` 数到 0 条）：

| 情形 | 换判据之前的读数 | 换判据之后 |
|---|---|---|
| 轮次开始**之前**就存在的手改 | `脏路径 [] · 这次合并要写 [src/a.ts] · 相交 []` | 拒：报出 `src/a.ts`（三方两两都不同） |
| 写得出不同内容的那条路径上的轮次中手改 | `脏路径 [src/a.ts] · 这次合并要写 [] · 相交 []` | 拒：同上（"要写"那一栏不再是判据） |
| 一条**只被删**的路径上的轮次中手改 | `脏路径 [src/z.ts] · 这次合并要写 [src/a.ts] · 相交 []` | 拒：报出它"推进时会被删掉" |

三行的根同一个：判据的两边都回答不了"推进之后盘上会变成什么"。做成三方比法之后三条一起落地。演示脚本里那几条断言与红负对照落在 `六之一 · 六之二` 那两段（归档那一篇 `A10`）。

## 8.15 `M14 probe`

**职责**：从 `M0` 的日志重算指标。**不采集，只重算**——因此任何指标都能被复核，任何历史日志都能被重新分析。

```ts
interface Probe {
  // merged 是一**个函数**而不是一条流：交错读侧是一次性的迭代器，而八个指标各要自己那一遍。
  // range 不给轮次就是整份账（`probe/metrics.ts` 的 `MetricsRange`，那一份就是这条签名的实现）。
  compute(
    merged: () => AsyncIterable<{ pos: { writer: string; seq: number }; e: LogEvent }>,
    range: { round?: RoundId },
    metric: MetricId,
  ): Promise<MetricValue>
}

type MetricId =
  | 'zero-tool-call-rate'      // 零工具调用轮次比例
  | 'detour-rate'              // 绕行率
  | 'prefix-hit-rate'          // 前缀命中率
  | 'prefix-versions'          // 前缀版本数
  | 'materialize-precision'    // 物化触碰文件数 / 实际变更文件数
  | 'ensure-latency'           // ensure 单次耗时分布
  | 'git-calls-per-round'      // 每轮 git 调用次数
  | 'handoff-yield'            // 接续后到首次有效写入所需的步数
```

**三个一线指标**：

| 指标 | 为什么关键 |
|---|---|
| **`zero-tool-call-rate`** | 本架构最危险的失败模式：约束导致模型不伸手。该指标一升，说明协议或拒绝文案出了问题 |
| **`detour-rate`** | 从 `bash` 命令内容反推"模型想要什么"，对比它实际调了什么。**它是接口不兼容的唯一直接证据** |
| **`materialize-precision`** | 承重性质的度量化：触碰文件数应恒等于变更文件数。一旦不等，`tsc --incremental` 正在失效 |

**`handoff-yield` 是循环重启的质量指标**（§ 8.13.a）：一个契约被接续后，新 agent 到产生首次有效 `view/write` 或 `ckpt/commit` 所需的步数。接续的收益全部押在"交接提示词写得有用"之上，而它的失败是**静默的**——不报错，只是重做已完成的工作。该指标把这件事从感觉变成读数。

**设计要点**：
- **重算而非采集。** 同一份日志重放必须得到同一组指标值——这使指标本身可证伪。
- **`zero-tool-call-rate` 与 `detour-rate` 是协议 A/B 的判据**（§ 13.3），也是 S8 的验收内容。
- **`ensure-latency` 与 `git-calls-per-round` 是内核原生迁移那类判断的输入**（§ 17）——它们把"该不该上原生"从猜测变成读取一个数。

**验证性质**：重放同一份日志，得到同一组指标值。

## 8.16 代码树

**代码树是 `M3` 索引的消费形态**，给模型的是这个工作区的结构——全仓符号骨架与依赖关系。它**轮内冻结、轮边界重建**，住在共享头（§ 8.11）。

### 8.16.a 三分：结构 / 工作集 / 查询

这份划分决定了它们各自落进哪个前缀分区（§ 8.11）：

| 部分 | 轮内是否变化 | 前缀分区 |
|---|---|---|
| **结构**：全仓符号骨架 + 依赖关系 | 否（**轮内冻结**；全部并入、轮边界重建） | **Zone A**（跨 agent 逐字节相同） |
| **工作集**：本 agent 的改动、写入型契约的 `ownedPaths`、当前焦点 | 是，agent 特有 | **Zone B** |
| **查询**：按当前问题重排的符号列表 | 每步都变 | **Zone C**（只追加） |

**结构必须共享，不能逐 agent 各建一份。** 那有三个后果：一、重建成本 ×N；二、结构与 agent 耦合，每个 agent 各建一份，谁也不知道别人的结构是什么；三、**跨 agent 的 Zone A 不再逐字节相同，前缀共享头失效，缓存命中崩溃**。第三条是决定性的——它与组装器的共享前提直接冲突。

因此：

| 项 | 归属 | 唯一性来源 |
|---|---|---|
| 代码树索引 | **宿主**（常量源，§ 15.3） | 派生自真源的函数（同一提交 → 同一结果） |
| 工作集 | agent | 其视图与契约 |
| 查询重排结果 | agent | 其当步上下文 |

**"归属"与"产出者"是两件事。** 索引由 `M3` 产出（§ 7 的职责、§ 8.16.b），产出物是工作区级常量，因而**驻留在宿主**——一个是计算它的模块，一个是它的唯一性来源，两处不矛盾。

索引是**派生体**，损坏即重建，与物化目录同档。

### 8.16.b 代码树：成熟实现与证据

| 实现 | 机制 | 证据强度 |
|---|---|---|
| [Aider repo map](https://aider.chat/docs/repomap.html) | tree-sitter 抽符号 → 引用图 → PageRank 排序 → token 预算裁切 | **生产验证 + 明确的性能修正**。社区 PR [#5556](https://github.com/Aider-AI/aider/pull/5556) 修掉"把 prompt 提及计入 repo-map 缓存键导致超大仓库反复全扫"，issue [#5529](https://github.com/Aider-AI/aider/issues/5529) 记录了该全扫 |
| [SCIP](https://sourcegraph.com/docs/code-navigation/writing-an-indexer) | 语言无关的符号索引格式（LSIF 的后继） | **格式成熟 + 多语言实现现成**，只需调子进程 |

**Aider 那条缓存键修正就是本架构分区的直接实证。** 结构属共享头（轮内不动），排序属每步尾部（每步可变）。Aider 把两者混进一个缓存键，代价是大仓库每步全扫；§ 8.11 已经把两者分开，这里只是把代码树按同一规则落位。

**SCIP 解决了索引的实现成本**：符号索引不必自己按语言写解析器，且它是语言无关格式，多个语言的 indexer 已现成。代价是需要一个子进程，这正好落在 § 17 的取数口径上。

**代码树属于工作区级常量源**（§ 15.3）：它是派生体，同一提交 → 同一结果，无人写它。**因此它落在 Zone A**（§ 8.11）。

**"轮内冻结"是一条要求，由轮边界兑现。** 代码树索引的更新触发是**轮边界**——**全部并入、轮边界重建一次**。轮内即便有改动并入、代码确实变了，索引**不动**；子 agent 各自的提交与检查点同样不触发它。若挂到交互上，就会得到 [issue #5529](https://github.com/Aider-AI/aider/issues/5529) 那种大仓库每次交互全扫。本架构能承受"只在轮边界更新"这条约束——轮边界本来就是屏障点，且 `M2.diff()` 直接给出变更文件集。

**索引与图是两层。** `M3` 承担符号索引；`M11` 的写入集预检用静态路径级判据（D6）。代码图加在这层索引之上（T1）。

---

## 9. 持久化、重放与观察

### 9.1 没有持久化模块

**日志就是持久化层。** 这条不是省略，是分工的结论：

| 状态 | 落在哪 | 性质 |
|---|---|---|
| git 对象库 | `<realRoot>/.git` | **真源**，不可变、内容寻址、自己持久 |
| 真实工作树 | `realRoot` | **派生**，单写者推进——它的真源是对象库（§ 1.4） |
| 事件日志 | `M0`，append-only 文件 | **可重放历史**，唯一的编排级持久状态 |
| 契约 | 事件日志里（`contract/issue` 带正文） | **不可变值**：模型写的、没有第二份来源，随日志重放（§ 8.12） |
| 视图 | 内存 | 派生，`loadView` 重建 |
| 视图快照 | `<realRoot>/.fugue/snap/` | **派生**：日志前缀的折叠；可选、可弃，从不阻塞写入（§ 9.4） |
| 物化目录 | `mat/<agent>/`，与日志同一层（§ 8.4） | 派生，`fork` / `ensure` 重建 |
| 边界第二层的包装器 | `<realRoot>/.fugue/bin/`（§ 8.8） | **派生**：`cc` 编一次，源码与产物都可重生成；`dispose` 不管它 |
| 物化清单 | 无 | 派生，`mat/*` 事件重放 |
| 轮次状态 | 无 | 派生，`round/state` 事件重放 |
| 前缀 | 无 | 派生，`M10` 重算 |

**多出一个持久化模块，就多出第二份真源。** 表里每一行的持久化方式都是它自己的性质决定的，没有一行需要一个中间层代管。§ 24 纪律 1「派生不持久化」在这里兑现，纪律 12「工作区是自足的」在另一头兑现：**这份表里没有一行住在工作区外面**——对象库在 `<realRoot>/.git`，日志在 `<realRoot>/.fugue/`。**把工作区整个搬走，真源跟着走。**

### 9.2 日志存储格式

```
<realRoot>/.fugue/
  log/<writer>.jsonl      # 每 writer 一份；writer ∈ { agent/<round>/<n>, round }
  log/<writer>.lock       # 写者栅栏：一份日志一个写者进程，只在会碰日志或物化的命令上取
  snap/<writer>/<seq>.json # 视图快照，可选且可弃
  config                  # 工作区配置：人写，模型不可达
  docs/                   # 文档产物：每次重生成，可弃（§ 9.9）
  mat/<agent>/            # 物化：upper · merged · tmp · cache，派生且可弃（§ 8.4）
  bin/                    # 边界第二层的包装器：源码与编译产物，派生（§ 8.8）
```

**这一层里有三样东西，外加一道锁。** `log/` 是**真源的一部分**——它与对象库合起来才是那份唯一真源（§ 1.4）；`config` 是这份真源的**输入**（人写，§ 15.3.a）；`snap/` · `docs/` · `mat/` 都是**派生**：可选 · 可弃 · 损坏即重建（§ 9.4 · § 9.9 · § 8.5）。**物化也住在这里**，正因为它同样是派生物——没有任何数据只存在于物化目录里，`dispose` 删掉它就等于它没发生过。

**那道锁不装数据**：`log/<writer>.lock` 只做一件事——**一份日志一个写者进程**。序号是从文件尾读一次得来的（§ 9.3 的三步顺序里，只有"追加日志"这一步需要这个保证），两个进程各读一次尾就会领到同一个号——于是同一份日志里出现两条 `seq` 相同的事件，而从快照起的那一次重放会把其中一条整条丢掉（§ 9.4）。它是真源上的静默损坏，不是一次读写失败，所以由一道栅栏挡在写入之前。**只改 ref 的命令不在这一道栅栏里**：`fugue branch` 改的是 `refs/heads/<writer>`，而 ref 的每一次改都是 CAS——多个进程同时改，恰一个成功。

三条边界：**按 writer 分文件**，所以不同 agent 之间仍然是零协调（D11 一个字没动）——它挡的是"同一个 writer 的两个进程"，不是并发本身；**只在会碰日志或物化的命令上取，读命令一律不取**（§ 9.7 那句"观察不得影响状态"读出来就是"观察不加锁"）；**持者不在了就自己拿回来**——判据是 pid 与进程起始时刻，加上 boot id（`kill -9` 不清理任何东西，而 pid 会被复用）。锁文件自己可弃——删掉它不丢任何数据；但**读不动时是拒绝，不是重建**：判不出持者就不放行，并把删它的那条路给出来。它守的那条性质不是派生物。

**这一层在真实工作树里，但不在视图里。** 模型的工具只认视图内的相对路径，`bash` 跑在物化树的沙箱里——两者都到不了 `<realRoot>/.fugue/`。**同一个形态也用在项目方针上**：`<realRoot>/AGENTS.md` 同样在真实树里、不在视图里，模型因此**没有一条路**写得进去，而它的内容照常进前缀（§ 9.9）。**"模型不可代替配置"因此是结构性的**（§ 24 纪律 13）。

**里外由"指得到"决定，这一层在外面。** 模型手里有两种指法：视图内的相对路径，与一个声明过的动作名。这两种指法到得了的就在里面——视图里的文件 · 声明过的动作 · 沙箱里那棵物化树；到不了的在外面——日志 · 快照 · 配置 · 文档 · 对象库 · 项目方针 · 凭据。**路径是唯一裁判**：往系统里添一样东西，先回答"模型用哪条路径、哪个动作名碰得到它"，答案就落在它的位置上（§ 24 纪律 13）。

每行一条事件，行首是自描述信封：

```json
{"seq":17,"writer":"agent/r1/2","crc":"8f3a…","t":"view/write","agent":"…","path":"src/a.ts","rev":17,"blob":"…","mode":420}
```

| 字段 | 作用 |
|---|---|
| `seq` | 该 writer 的单调序号，由它自己的计数器发放 |
| `writer` | 重放时用于交错排序，可与文件名互校 |
| `crc` | 该行内容校验；**校验失败即拒绝加载该行及之后的部分** |
| `ts` | 墙钟时刻，epoch 毫秒整数；**只在写者一侧给钟时出现** |
| `boot` | 机器这一次启动的标识；`boot` 不同的两条 `inc` **不可比** |
| `inc` | 同一启动内的单调计数，微秒；跨进程可比，跨启动由 `boot` 隔开 |

**钟那三栏是可选件，口径只有一条：栏不在就是「未量到」。** 给钟的判据在**写者一侧**（`LogOptions` 一类），不给钟的那一档**一个字节都不多**——与这三栏之前逐字节相同，所以老日志零迁移照读，新旧两种行在同一份账里共存，解码侧两种都给 `ok`。**读不出启动标识的宿主（没有 `/proc`）那一档一栏都不写**——不写 `0`，不写空串（与 `llm/call` 的 `ms` 同一条：缺一栏是「未量到」，不是 0）。**校验形状 = `{seq, writer, t, …载荷}` 加「本行出现的钟栏」**：`crc` 盖的正是它，于是"没出现的栏"两侧都丢掉即可对上。**钟不参与任何排序**，全序仍是 `(seq, writer)`；三栏一起记的理由是**回拨读得出来**——`inc` 不回头而 `ts` 回头时，那是账上读得到的**事实**，不是错误。取钟只有一处（`src/clock.ts`），信封与那道锁记录读的是同一处。

给钟那一档多三栏（键的书写次序随意：`crc` 只看规范形式）：

```json
{"seq":17,"writer":"agent/r1/1","crc":"8f3a…","t":"view/write","ts":1780000000123,"boot":"…","inc":912345678,"agent":"…","path":"src/a.ts","rev":17,"blob":"…","mode":420}
```

**自描述信封的意义**：日志可被外部分析、可被 `M14` 重算、可跨版本读取，不依赖任何运行时类型信息。

### 9.3 提交协议（写者一侧）

```
1. 先把 blob 写入 M1          ← 对象是不可变的，重复写幂等
2. 再追加日志一行             ← 唯一需要保证顺序的一步
3. 最后改内存视图
```

**崩溃落在任意一步，语义都有定义**：

| 崩溃点 | 后果 | 是否可修 |
|---|---|---|
| 1 与 2 之间 | 孤儿 blob | 可修：`gc.auto=0` 屏障点回收，**不影响正确性** |
| 2 中途（半行） | 尾行残缺 | 可修：重放读到畸形尾行即截断 |
| 2 之后 | 无 | — |

**顺序不可颠倒。** 先写日志后写 blob，重放就会指向不存在的对象。

**校验与截断是两回事**：半行在尾部 → 截断继续；**中段 `crc` 失败 → 拒绝加载**，不静默跳过。中间丢一行会让重放产生一个与当时不同的视图，而"重放必须一致"是承重性质——宁可显式失败并指向备份点，也不给出一份悄悄失真的历史。

### 9.4 重放算法

```
loadView(log, agent, upToRev?):
  1. 找 snap/<agent>/ 中 ≤ upToRev 的最大快照，从它的 seq 之后接着读；无则从 seq=0 起
  2. 按 seq 升序读该 writer 的日志
  3. 每条事件重算：blob → 内容，path → 指向；tombstone 由 remove 事件产生
  4. rev = 最后一条事件的 rev
```

**快照存的是"这个 writer 的日志前缀折叠成了什么"**（`path → (blob, mode)`，墓碑也在里面），而不是"这棵树当时长什么样"。后者含下层，base 一前移就过期；前者与日志同一个参照系，所以它只按 `(writer, seq)` 存放，不必记下当时铺在哪个提交上。

**它换掉的是历史，不是状态。** 状态里不含有过哪些变更，所以从快照起的视图给不出更早的变更序列——`diff(since < 快照的 rev)` 明说答不了，要历史就全量重放。这条限制是结构性的，不是实现取舍。

**快照是纯加速项。** 损坏 · 缺失 · 形状不对 · 信封里的序号与文件名不符 · **比日志新**（写它时日志有 N 字节，现在不足 N——日志丢了尾而它留下了），五种情形一律当没有，退化到从 0 全量重放。**没有任何数据只存在于快照里**，因此快照从不需要备份，也从不阻塞写入：它的写点在提交点（§ 9.5 把提交点与检查点列在同一档），写不成就当没写，读不动就当没有。

**tombstone 不需要持久化**。它是重放的中间产物：读到过 `view/remove` 而其后没有同名 `view/write`，删除意图即成立。判据仍是"能否从环境重建"。

**重建代价上界 = 该 writer 自己写下的事件数**，与仓库规模无关：代价由**事件数**决定，不由内容的字节数决定。大仓库下唯一的重成本在 `lower` 的按需读取上，而那恰好是访问到才付。

**快照省的是折叠，不是取内容。** 它按 id 存内容，所以从它起仍要把每条内容取回来一次。它作为加速项的分量因此取决于负载：**反复改写同一路径时省得多**（快照只留最后状态，日志留每一次），每条路径只写一次时几乎不省（两边都要取一遍内容）。日志自身的增长上界是未决项（§ 23 U1）。

**实测基线**（ext4 · 一等档主机）：日志约 **190 字节/事件**（路径约 25 字符；另有 40 个字符是那份内容的指纹）· 重建约 **0.08 ms/事件** 加约 75 ms 的进程启动 · 2 万事件的一份日志：重建 1.5 s · 提交 0.5 s · 一条命令端到端 1.6 s。

### 9.5 fsync 的位置

日志的**正确性不依赖 fsync**。blob 已经在 `M1` 里真实落盘；日志丢尾的后果是最近若干次路径指向消失，而不是产生错误视图。因此 fsync 是一个**耐久性档位**，不是正确性开关：

| 档位 | 语义 | 适用 |
|---|---|---|
| `sync: 'each'` | 每条事件 fsync | 提交点、检查点、崩溃一致性实验 |
| `sync: 'batch'` | 定时批量刷（默认） | 常规操作 |
| `sync: 'never'` | 交给 OS | 压测与性能测量 |

**`sync` 是 `LogOptions` 的一个字段，不是散落的调用点。** 改档位 = 改一个参数（§ 4「修正便宜」的直接兑现）。

### 9.6 CLI

**CLI 是单次进程 + 每次重建。** 这条同时解决三件事：不需要守护进程、不需要常驻状态、崩溃恢复即"下一条命令照常加载"。

**命令本身是一份值层，CLI 是它的第一个壳。** 每条命令收一份**参数**、出一份**值**——值就是 § 9.8 契约表里 `--json` 印出来的那一份。CLI 这一层只做三件事：把 argv 解析成参数 · 把值排成人读或 `--json` · 决定退出码。**同一个值层还有第二个壳**：serve（§ 9.11）把同一批动词摆到 JSON-RPC 的报文上，出的还是同一个值。两个壳各自独立可用——serve 不在，CLI 照旧跑完全部命令。

```
fugue [--root <dir>] [--agent <id>] [--json] <command> [args]
```

| 组 | 命令 | 对应模块 | 步骤 |
|---|---|---|---|
| 读 | `fugue read <path>` / `list [dir]` / `stat <path>` | `M2` | S1 |
| 写 | `fugue write <path> [--from <file>\|--stdin]` / `remove` / `rename` / `chmod` | `M2` `M0` | S1 |
| 检视 | `fugue diff [--since <rev>]` / `log [--agent <id>] [--json]` / `revs` | `M2` `M0` | S1 |
| 提交 | `fugue commit -m <msg>` → `CommitId` | `M1` `M0` | S1 |
| 提交 | `fugue branch <base>` | `M1` | S3 |
| 重放 | `fugue replay [--to <rev>]` / `fugue replay --verify` | `M0` `M2` | S1 |
| 物化 | `fugue fork <base>` / `ensure [--to <rev>]` / `verify-mat` / `diff-stat` / `dispose` | `M3` `M4` `M14` | S2 |
| 执行 | `fugue run <action> [--mode <档>] [-- k=v…]` | `M5` `M6` | S4 |
| 边界 | `fugue policy [<action>]` | `M7` | S5 |
| 装配 | `fugue assemble <protocol>` | `M8` `M10` | S6 |
| 编排 | `fugue round new\|plan\|go\|run\|merge` | `M11` `M12` `M13` | S7 |
| 说话 | `fugue say <一句话>` | `M12` `M0` | S9（归档 § 5.10） |
| 观察 | `fugue status [--once] [--metrics] [--report]` / `watch [--follow]` / `tui [--root <dir>]` | `M0` `M14` | S8 尾（归档 § 5.18）· `tui` 在归档 § 5.19 第五段 |
| 自检 | `fugue doctor` | § 15.7 的落点与围栏探针（`probeHost` · `probeBwrap` · `probeLandlock`）+ engines · crc32 | 纯读：读得出就退 0——「缺」是读数不是失败（§ 8.15 不造伪判据） |
| 配置 | `fugue config show\|set\|get\|ls` | 工作区配置（§ 15.3.a）；ls 只列顶层键域、连配置都不读——配置读不动时它照样给得出这张清单 | S1 |
| 入口 | `fugue serve [--idle-ms <毫秒>]` | § 9.11（同一份值层的第二个壳；方法面从本表派生，入口不出方法名） | S8 尾 |

**一条命令凭什么在表里，分两类看。写与动作类，判据是它改变的状态没有别的路**——重复一条已有的路不新增能力，只新增一处要维护的写路径。**呈现与核对类，判据是它给出的东西在系统里有归属**：`M14` 重算的指标 · `M12` 折叠出的当前轮次状态 · `M10` 装配出的三区哈希 · `View.revs` 这样的字段 · § 8.5 的"清单 == 差异集"这样的验证性质。**判据是值，理由是论证**——判据住在声明里（`Policy` · `Protocol` · fork 策略表），读一次就有；"为什么"住在本文里，读不出来（§ 9.8）。两类合起来使每一条都恰好声明一个对它的输出负责的模块。

**这张表是环境的操作面**：状态住在对象库与日志里，这里列出到达它的每一条路——**它不持有状态**，真源仍是对象库与日志（§ 1.4）。它同时是 § 20 的结账口：每一步的"可用"都要能说出"现在多了哪几条能跑的命令"，说不出就退回"模块写完了"这种不可证伪的说法。

**两个面共用实现与返回形状，条目各自裁剪。** 全部命令返回结构化 JSON，而 CLI 的输出就是 `M9` 工具的返回形状——CLI 随手一敲就是一次模型工具调用的仿真，这使它成为模型行为的离线复现器。同一个操作在两边各有一个名字（`checkpoint` 与 `fugue commit` · `run_action` 与 `fugue run` · `write` 与 `fugue write`），但两张清单**不一一对应**：物化与重建类只在人的这一面直接出现，模型侧由 `M4.ensure` 在执行前隐式兑现（D3）；交互类只在模型那一面出现（§ 8.10）。`ToolName` 的唯一定义处仍是 § 8.10 的目录，这张表不构成第二份。

**人的入口在人这一侧。** `fugue` 装在真实机器上，读 `--root` 指的那个工作区；模型那一侧的动作是 `M9` 的工具目录（§ 8.10），由宿主进程直接调用。**入口在沙箱之外**，模型的动作面因此仍是那份声明过的目录（§ 24 纪律 13）。

**壳是一次 `exec`，不是第二个面。** `fugue …` 与 `node <仓库>/src/cli/fugue.ts …` 是同一次调用——同一个进程 · 同一个 argv · 同一份退出码，所以两边不可能各自长出一套语义：这里根本没有第二套。壳只做一件事：把 PATH 上的名字接到那份实现上。**它在哪台机器上，用它的那个人就在哪台机器上**——装法是一条软链，`FUGUE_NODE` 换解释器。

**换一个宿主，多出来的是转发那一段。** 跨宿主的那一份（从 Windows 的 shell 敲进去的那种）要转发一次，于是三样东西在边上过：stdin（`write --stdin` 的字节）· 退出码（四档，§ 9.8）· 以及**两种坐标**——`--root` 是宿主上的路径，要翻成真源那一侧的写法；视图里的路径是工作区内的坐标，一个字符都不动。**分辨"哪个参数是路径"这一步，就是壳开始认识命令的地方**；"同一次调用"这条性质，只有在壳不认识命令时才守得住。它另有一条落点上的要求：真源要在一等档文件系统上（§ 15.7 的 E1），所以那一份壳在把人领进去之前先看落点。这一份是 T10。

**配置命令是唯一一条模型没有对应工具的写操作。** 它不构成 § 9.8 意义上的旁路——**配置是边界的来源**：模型没有到达"改配置"这个效果的路径，所以不存在"有路不许走"（§ 24 纪律 13）。

**`replay` 只读。** 它重建并报出视图，不改任何状态。**这张表里因此没有"回退"**——把视图挪回某个修订点再往下写不是一条路；要看某个修订点，`--to` 给的就是那个。

**`fugue replay --verify` 是重放性质的验收命令**：逐 agent 重建视图，比对 `rev`、全量读出、`diff()`，任一 diverge 即非零退出。**比的是两条独立的重建路径**——从快照起与从 0 起（验"快照是加速项"），交错读与按 writer 读（验"重建结果只由自己的操作决定"）。它同时也是 S1 的验收脚本，也是崩溃恢复实验的探针（杀掉进程后运行它）。

**`--agent` 决定操作哪个视图**，等价于选择一份日志。未指定时取 `mainRef` 对应的主 agent。这一条让"多视图并发"在 CLI 上表现为同一条命令换一个参数——无需新概念。

### 9.7 轨迹

**这份投影叫轨迹。** 它与 DSH 的 `ui-trajectory` 视图是同一件事——**DSH 是一套既有的 agent harness 实现，本文在若干处与它对照（此处 · § 9.9 · § 10.1），对照不构成依赖**：DSH 在浏览器里把一份会话事件流渲染成 agent 活动视图，本架构把同一份日志渲染成命令行事件流与界面（§ 9.8）。**两边都不为它单独记录什么**——"轨迹"是这份投影的名字，不是第二个存储。

**日志是唯一的观察对象。** 观察不走独立的遥测管道：

```ts
type ProgressEvent =
  | { k: 'round/state';  from: RoundState; to: RoundState }
  | { k: 'round/intent'; digest: string }
  | { k: 'agent/spawn';  agent: AgentId; contract: ContractId }
  | { k: 'step/begin';   agent: AgentId; step: StepId }
  | { k: 'model/chunk';  agent: AgentId; step: StepId; text: string }
  | { k: 'msg/complete'; agent: AgentId; step: StepId; tokens: number }
  | { k: 'tool/call';    agent: AgentId; name: ToolName; argsDigest: string }
  | { k: 'view/write';   agent: AgentId; path: RelPath; bytes: number }
  | { k: 'mat/sync';     agent: AgentId; to: ViewRev; touched: number; ms: number }
  | { k: 'run/end';      agent: AgentId; action: string; exit: number; ms: number }
  | { k: 'bound/deny';   agent: AgentId; rule: string }
  | { k: 'signal';       agent: AgentId; kind: SignalKind }
  | { k: 'agent/end';    agent: AgentId; commit: CommitId | null }

interface Observer { observe(filter?: ObserverFilter): AsyncIterable<ProgressEvent> }
```

**`ProgressEvent` 是把 `LogEvent` 整理成统一形状的读侧，不是第二份日志。**

| | 内容 | 持久性 | 进程重启后 |
|---|---|---|---|
| `LogEvent` | 只记**重放必需的**：状态转移、写入、物化、拒绝、信号 | 持久 | **完全重建** |
| `ProgressEvent` · 状态类（九） | `round/state` · `round/intent` · `agent/spawn` · `agent/end` · `view/write` · `mat/sync` · `run/end` · `bound/deny` · `signal`——其中 `agent/spawn` 由 `contract/issue` 与 `agent/handoff` 推出，`agent/end` 由该 agent 的 `ckpt/commit` 与轮次状态推出 | 不单独存 | 由日志重建，**不丢** |
| `ProgressEvent` · 模型类（四） | `step/begin` · `model/chunk` · `msg/complete` · `tool/call` | **不持久** | **丢失**——不在日志里，也无法从日志推导 |
| 指标 | 由 `M14` **按需重算**，不预存 | 不存 | 重算 |

**"可在日志上重建"只对状态类成立。** 模型生成的文本、消息完成、逐 chunk 与工具调用的参数摘要都不在日志里：`tool/call` 只留 `argsDigest`，`run/start` 只留 `argv0`。

**会话内与会话外是两件事。** 活着的会话里，模型上一步的输出当然进入下一步的请求——串行工作本来就是这样，它不进日志，也不需要进。**跨进程时它不存活**：重启靠交接提示词与机械部分（§ 8.13.a）。所以**子 agent 的具体输出内容不必留档**——它是执行态，用户在意的是持轮者那一层。

准确的界线是：**效果保留，调用丢失。**

| 事实 | 在日志里吗 |
|---|---|
| 「文件 P 被写成 B」 | **在** — `view/write { path, rev, blob, mode }` |
| 「模型调用了 `edit`，参数是 X」 | 不在 — 只有 `argsDigest` |
| 「构建跑了，退出码 1」 | **在** — `run/end { exit, ms, denied }` |
| 「构建的错误原文」 | 不在 |

**由此得到一条纪律**：

> **要让一个结果活过进程重启，就把它写成状态，不要指望它留在上下文里。**

这是规则 1 在模型反馈上的直接应用。重载后重建的前缀会知道"上一次构建失败了"，但不知道错误是什么——模型会重跑一次，代价是一步，不是错误。

**不存在独立的遥测管道。** 观察、指标、前缀同出一源——它们都从状态算出，而状态由日志重放（§ 9.1）。据此，`M14` 不需要采集器，轨迹不需要埋点，界面不需要后端。

**观察不得影响状态。** 若观察会改变行为（预取、加锁、提前物化），观察就变成了第二个写入者，与"视图是唯一写入者"直接冲突。观察是纯消费者。

### 9.8 人机界面

**界面是轨迹的一个渲染器。** 四种形态，消费同一份流：

| 形态 | 场景 | 实现成本 | 成熟参照 |
|---|---|---|---|
| 一次性命令 | 脚本、CI、模型工具调用的仿真 | 极低，即 § 9.6 | `kubectl` / `gh` |
| 流式观察 | 看一整轮在发生什么 | 低：`--json` 事件流 + `--follow` | [lnav](https://lnav.org/) 式的过滤与追加 |
| 可附着 TUI | 长任务旁观与介入 | 中 | [lazygit](https://github.com/jesseduffield/lazygit) 式面板——本版本落的是"永久行 + 底部常数行"那一档（下） |
| 逐步调试 | 断点、单步、检视 | 中 | [gdb](https://sourceware.org/gdb/) 的断点模型 |

```
fugue status [--once]                 一次快照：轮次阶段 · 各 agent 视图与契约 · 阻塞项；加 --metrics /
                                      --report 另印八元指标与打回三数（§ 8.15 那两份读数在命令面上的出口）
fugue watch [--agent <id>] [--follow]  订阅 ProgressEvent：不给 --follow 就把账上有的念一遍就停
fugue tui [--once] [--follow] [--full] [--metrics] [--report] [--interval <ms>] [--tail <n>] [--no-style]
                                      可附着的一块面板：同一份流的第二档渲染（快照 + 跟随）——永久行追加
                                      进本终端的历史 · 处境与读数画在底下常数行里 · 不新增事件 · 不写状态。
                                      TTY 那一档不给 --follow 也是跟着；--once 印一遍永久行就退，
                                      不是 TTY · `$TERM` 认不出来 · `dumb` 也是那一档（一个字节的 ANSI
                                      都不写）；管道里要一直跟着得明说 --follow
                                      --tail <n>：首趟只写尾部 n 条永久行（旧账很长时的「接着看」入口；
                                      跳过的前几条按已写出去记，之后的新行照常增量；不给就全印）
                                      --no-style：退回全无样式那一档（与 NO_COLOR 非空同一道门）。缺省带
                                      一档简约样式——框线与脚注暗一档 · 弹层加粗，只用黑白两个属性不用
                                      颜色，只动面板那几行（永久行与输入行不上样式：历史与 `| tee`
                                      仍干净，光标算术不掺 SGR）
                                      按键（只在 TTY 那一档 · 一处声明在 src/ui/keymap.ts）：一行字 = 一条
                                      命令（`/` 起头是命令 · 裸文字落进 say）· g 放行——起一次 `fugue round
                                      go`（账由那个子进程写） · Esc / Ctrl-C 是两条取消链 · 门口那一批三档
                                      y / n / Esc · ? 重印提示那一行 · q / Ctrl-D 退出
fugue log [--agent <id>]              按 (seq, writer) 全序列出日志事件：**抄本——不渲染、不筛选**
fugue diff-stat                       全树 (mtime,size,hash) 快照对比：核对增量物化的正确性
fugue doctor                          环境自检（纯读，不落盘）：node · zlib.crc32 · bwrap · landlock ·
                                      git 在场 · 落点档位。**读得出就退 0——「缺」是读数不是失败**；
                                      statfs 问不出落点（自检跑不了）才退 1
```

**`status` 与 `watch` 在 S8 的尾巴上落地**（归档 § 5.18 的收口站）：两条都是纯读者——`status` 把 `round/state` 链重放一遍，`watch` 顺着已有的 NDJSON 账读；不新增事件、不动前缀，所以它们是 TUI 的前置（TUI 读的东西先在这里被 real 组用过一次）。**打回那三行各自带范围标签**：`[本轮]` 是"只数这一轮"（跑完那一档递轮次时）· `[整账]` 是"账上各轮之和"——三支里 `conflicts` 与 `rejects` 按轮次筛，而 `denied` 落在 `run/end` 上、那条事件没有轮次那一栏，所以它哪一处都是 `[整账]`（归档 § 5.9 的 A8 那一条）。**`top` 这一版不做**（§ 22 D22）。

**TUI 落地在归档 § 5.19 第五段**（命令是 `fugue tui`：一个前置 + 四格——序 32 是读面在命令上的出口，`UI1`–`UI4` 是永久行分级 · 接终端 · 跟随接上 · 门那儿按一下）。形态就是上表第三行，五条定死：**可附着**（自己不起轮次，读某个 `--root` 的账；读者不取锁，所以一轮正在跑时照样读）· **不接管屏幕**（**缺省那一档**不进 alt screen：该留下的永久行按到达序**追加**进本终端的历史，翻回去看 · 搜索 · 复制 · `| tee` 归终端管；`--full` 是**可选**的另一档，只多两个 escape，见下）· **底部一块恒定 K 行**（处境与读数画在那里，每次更新擦掉重画；"临时"用"擦掉"表达，不用"变暗"——真渐变要帧率；**K 是期望且按终端行数分账**——缺省至多 2/5 · 弹层开着至多 3/5，**输入那块不得与显示区等高**（2026-09-29 的口径），判据在 `ui/stage.ts` 的 `panelWantOf`）· **重画只由 `--follow` 那一趟驱动**（不另设定时器）· **排版是纯函数**（`src/ui/frame.ts` 那一份，同一份输入渲染两次逐字节相同；因为 `width` / `height` 是入参，"底部 K 行"与"整屏"是同一个渲染器，整屏那一档只是终端层多两个 escape——**第二版就是这么落的**：`--full` 只在 `src/ui/term.ts` 里多 `ALT_ON` / `ALT_OFF` 那两笔，渲染那一份一行没动，`T10` 的断言拿"两档的字节流只差那两笔"钉住）。**跟随那一档的接线在 `src/ui/follow.ts`**（`follow()` 读进来的行累成一档会话，面板与历史都是它的纯函数；第一趟把账上已经有的读齐、只画一次，之后一条一帧；`--tail <n>` 让首趟只写尾部 n 条——被跳过的前几条按「已写出去」记，`fresh()` 那道前缀检查从预置点起照走对账；四条地板收成一张表，`src/cli/fugue.ts` 只剩接线）。**哪一族配得上一行历史是一张表**（`src/ui/stream.ts`：30 条事件族一族一格，一族没被分到一类就是红的）——渲染里不再出现"这一族要不要印"的判断，分法只有一处。**底部那一块是 K 行恒定、每行恰好终端列数**（`src/ui/term.ts`：所以"上移 K 行"永远落回面板顶；退出时那 K 行由 `\x1b[KM` 收走，历史里只剩永久行；`--full` 那一档在最后再补一条 `\x1b[?1049l`——**四条退出路径都写到它**，而那两处"不删面板"的早退不许把它一起吞掉，`close()` 因此是幂等的：崩那一档走 `exit` 那一钩）；**宽度变过就不猜重排**（重排之后那几行占几个物理行这一层量不到）：上一块留在历史里，新宽度从下面另起一块——面板擦错一格可以重画，历史擦掉一格找不回来（归档 § 5.19 第五段）。**地板四档**：真终端 · `--once`（印一帧永久行就退）· 不是 TTY（管道 · CI · 测试里**只印永久行，一行 ANSI 都不写**）· 测试（拿那几行当答案，不碰终端）。这一版**不许引运行时依赖**（约定 § 六）：手写 ANSI 丢掉的唯一一样是 `terminfo`，补偿是读一次 `$TERM`，`dumb` 或认不出的值退到"只印永久行"那一档。**第二版把它从「观察窗」做成「控制台」**（取舍的出处是归档 § 5.19 第二版那一段；一格一次提交，读数在 `~/fugue` 的提交序列里）：按键**一处声明**（`src/ui/keymap.ts`：动作 id + 缺省键串 + 说明，提示行 · 帮助面板 · 菜单候选三处都从它推；**还没接线的动作不许出现在提示行里**）· **输入行**是可编辑的一行（`src/ui/input.ts`：历史 · 反查 · 大段粘贴折叠 · 撤销栈，光标列与折行按簇算）· **菜单与面板**三个入口开同一套候选（`src/ui/menu.ts`：`/` 是命令、从 `src/cli/flags.ts` 的 `FLAGS_OF` 推；`Ctrl-P` 是键表；`@` 是工作区里的路径）· **起命令**泛化成任意一条（`src/ui/run.ts`：一行字 → argv → 子进程，`spawn` 的 argv 与手敲的逐字相同，界面手里仍然**没有写句柄**——这一条在签名上就成立）· **取消链**判据一处（`src/ui/cancel.ts`：`Esc` 六级 · `Ctrl-C` 三层带 3 秒窗口 · `Ctrl-D`/`q`/`Q` 只在输入行空时退；**钟由调用方给**，所以"3 秒"那一档不用真等）· **门口那一批**（`src/ui/gate.ts`：底部队列行 + 按类型分派的预览 + 二段确认 + 三档；那一批**从账上重算**，与 `round go` 是同一个函数——"队列行印的那批契约与真发出去的逐字节相同"因此是查得出来的）· **打断与排队**（`src/ui/queue.ts` 与 `run.ts`：打断打的是**整棵子树**（子进程自己一个进程组）且有界升级 `SIGKILL`；忙的时候打的那一条入队，可见 · 可撤 · 一趟跑一条）· **导航**（`src/ui/nav.ts`：树**从账上推**——主线为根 · agent 缩进一级，界面这一头没有"有哪几格"的清单；`Alt-1…9` 直选 · `Tab` 环形循环；"切过去"就是**在折之前**换一个筛行的 writer，于是它与 `status --agent <x> --once` 读的是同一批行）· **阅读面**（`src/ui/read.ts`：diff · 契约正文 · 事件流；工具输出折成一行并只计数，**只重折尾部**——前缀不许改，`deltaFaceOf` 那张表把 `add`/`modify` 折成同一个 `写`，"面板与 `fugue diff --json` 读同一份数据"是数据级的口径）· **整屏 `--full`**（`src/ui/term.ts` 多那两个 escape，排版那一层一行不动；**缺省关**，进了 alt screen 就没有本终端的历史可翻）· **舞台**（`src/ui/stage.ts`：`tuiCmd` 的纯视图状态与 ⓪–⑩ 键分派整个住在里面——deps 全是晚绑定的函数，句柄建起来之前舞台先立着，于是分派逻辑**不起进程 · 不开终端就能驱动**；`cli/cmd/observe.ts` 缩回读配置 · 组 deps · 起进程 · 接信号）。**界面仍然不留第二份真相**：授权 · 排队 · 处境都落在账上（或工作区配置里），界面只持纯视图状态（焦点 · 输入模式 · 排队那几条草稿），进程一退就没了。**第二版这十一格全落了**（行与断言在归档 § 5.19 第九节那张表里，口径在第十节，逐格的断言输出与实测读数在 `~/fugue` 的提交序列里）。**样式分两层落**：地基（U20）是 `frameOf` 每行报一个角色（`roles` 与 `lines` 平行：框线 · 正文 · 账尾 · 弹层 · 阅读面五档），终端层拿一张**可选**的主题表（角色 → SGR 序列）在补宽之后逐行包裹——**不给那张表，字节流一个不变**，行级 diff 与退出删行的算术不用知道主题存在；默认主题（U22）只用黑白两个属性（`src/ui/theme.ts`：框线与脚注暗一档 · 弹层加粗），`--no-style` 与 `NO_COLOR` 非空是两道退回门，退回那一档与没有主题逐字节相同。**定义里不做**：界面自己写账或改契约（**放行不是这两样**：`g`/`y` 起的都是那条命令，账由子进程写）。**不在这一版里**：`!` 任意 shell · 任何运行时依赖。

**余下几样按条件降级开**：**颜色**分三档——全关（`--no-style` 或 `NO_COLOR` 非空：一个字节的 ANSI 都不写）· 黑白属性（今天这一档）· 256 色（`COLORTERM` 或 `TERM` 声明认得了才上；认不得就退回黑白属性，不半上色），角色到颜色只住 `src/ui/theme.ts` 一处；**truecolor 与配色方案 · 主题文件不开**（要更花的那天单独开口）；**多面板不做，多视图做**（同一块显示区里轮换，K 行恒定的预算一个字不动）；**鼠标不做**——它要在终端里捕获，而捕获会接管滚轮与翻历史/复制（缺省不接管屏幕那条纪律），它的自然住处是图形客户端那一档。

**认得的开关才收。** 每条命令有一张**声明过的**开关表（`--root` · `--json` 加上它自己那几个；`round` 按子命令各一张）：表外的开关不当场收下——退 2，并把这一条命令认的那几个印出来。理由是读数：写错的开关被咽下去之后，人看到的是"命令跑了、什么都没变"，而那与"这个开关今天没用"是同一张脸（`log --grep x` 找不到东西，与"日志里没有匹配"也分不开）。表只有一处（`src/cli/fugue.ts` 的 `FLAGS_OF`，分发那里统一过表）——原先"其余命令静默忽略"的那一档已经收进同一张表，全命令族一个口径。

**命令模型：每条命令 = 一次状态转移 + 一个选择器 + 一个断言。** 不引入独立的人机协议。

**人通过和模型同一条路径介入。** 若人能用 CLI 做模型做不到的事，就存在一条不被策略与日志覆盖的旁路，`M7` 的边界随之失真。因此人的判断（批准、拒绝、改契约、接管冲突）都表达为同一组动作。

**可审计性来自三处各就各位。** **判据在值里**——`Policy` · fork 策略表 · `segmentOrder` 都是声明过的值，各有归属；**输入在日志里**——`bound/deny { rule }` · `mat/fork { strategy }` · `prefix/assemble` 的三区哈希；**结果可重算**——`M10` 是纯函数，给定快照与 `Protocol` 必得同一份字节。要问"为什么是这条规则""为什么选这个策略"，读一次就有答案。

**段序的"为什么"在另一处**：它是 `Protocol` 的设计论证，住在 § 8.11——**判据是值，论证是文本**，各有各的地方。

**四种形态共用同一份流，下面这份契约是 JSONL 那一档**（T9 是同一份流上的另两档渲染）：

| 决定 | 内容 |
|---|---|
| 输出 | 默认给人读；`--json` 给机器读（§ 9.6 的规范形） |
| 坐标 | 工作区里的坐标一律相对（就是视图内的那条路径）；宿主上的坐标一律绝对（`--root` 那一份落在哪） |
| 值 | `--json` 放值本身——`mode` 就是那个数（`0o100755` 是 `33261`；§ 9.2 的信封里 `420` 是 `0o644`） |
| 排版 | 人读那一面才排版（模式一律八进制，`100755`）；**真源的抄本不排版**——`fugue log` 印的是事件本身，字段照原样 |
| 单次命令 | 一个 JSON 对象；失败时带非零退出码 |
| 流式 | NDJSON，每行一个 `ProgressEvent`，带全序坐标 `(seq, writer)` |
| 交互 | `--follow` 附着；`--once` 非交互；脚本不需要会话状态 |
| 错误 | `{ code, message, hint, subject }`，`hint` 指向正确的替代能力（§ 24 纪律 5） |
| stdout 纪律 | **stdout 只放机器可读输出，进度与错误一律走 stderr** |
| 退出码 | `0` 成功 · `1` 失败 · `2` 用法错误 · `3` 被拒绝（§ 8.8 的边界） |

**理由：流格式是产品，渲染器是配件。** 同一份 NDJSON 同时服务脚本、测试夹具、模型工具调用的仿真，以及 TUI 那一档——TUI 只是同一份流的另一种渲染。反之若渲染器在先，它会反过来塑造事件模型，这就是锁定。**由此得到一条分工：检索与接着读都在读者那一侧。** `fugue log` 印的是全序列的抄本（`--agent` 只按 writer 选一份），`--grep` 一类的筛选不是它的事——第一个这样的读者就是 TUI；而"从 `seq` N 接着读"这个写法本身会漏：每个 writer 一个游标，晚出现的那个 agent 第一条就是 `seq=1`，按裸 `seq` 筛会把它整段永久漏掉（§ 9.2 的栅栏按 writer 分文件）。**"渲染器随意换"的价码在出口上，不在第一个渲染器写在哪。** 换一个渲染器（另一个宿主 · 另一门语言 · 那个宿主上要的原生窗口）要的是**读数的命令面出口**：八元指标与打回三数今天只挂在 `round run` / `round work` 的 `--report --metrics` 上（**跑完才有**），第二个渲染器没有一条独立的读命令可拿，就只得把那三份折叠重写一遍。参照系是 `k9s` 靠 apiserver · `lazygit` 靠 `git` · `lnav` 靠自描述的日志格式——**计算在产出那一侧，渲染器才是配件**。所以出口单独成一格（归档 § 5.19 第五段的序 32：给 `status` 加 `--metrics` / `--report` 两个开关，`--json` 那一份就是 TUI 入参里那三样数据——快照 · 八元指标 · 打回三数），而第一个渲染器可以就在进程内。

**坐标与值，判据都只有一条。** 指向工作区的坐标一律相对，指向宿主的坐标一律绝对——拿到一段输出，先能说得出它在哪一边（§ 9.2）。`--json` 那一面给值本身，八进制只是人读那一面的排版；而**排版只发生在渲染上，真源的抄本不渲染**——`fugue log` 印的是事件本身，字段照原样（§ 9.7）。**真源与派生那条线，落在人读这一面上就是这一句。**

**人的每个状态动作都是一条命令，都会追加日志**；讨论走另一条路——它是接口，落在会话记录里（§ 9.10），照样经过视图与日志。**交互式 REPL 因此没有位置**：它会开出第二条入口，一条不被日志覆盖的旁路，代价不对等。

**进度不进模型上下文。** 轨迹是给人的，不是给模型的。这是规则 1 的推论：上下文是状态的投影，而进度已经从状态重算得出。

**讨论是"跟谁说话"的问题，不是状态问题。** `Idle` 里持轮者与用户的往返**属于接口**——原文归档为工作区的会话记录文件（走同一套视图与日志）：**人说的那一句由接口写进去（`fugue say <一句话>`），并且立刻带着它跑一趟持轮者**——停下来的那一处没有"等在那儿"的状态（§ 15.1.a 的"问与答"）；持轮者那一侧的输出由它自己写成状态（§ 9.7 那条纪律的正用法）。**进持轮者前缀的是这场讨论的投影**（凝聚理解 · 凝聚前最近几次原文），原文按坐标取回（§ 15.1 · § 15.1.a）；子 agent 的前缀里两者都没有。因此 `fugue` 不需要"会话"概念：讨论的延续靠的是**同一个持轮者**（可替换），不是一份被 `fugue` 管理的会话状态。

### 9.9 文档：给人看的投影

**文档不参与任何 agent 决策。** 它与轨迹同类——都是状态的渲染，方向单向。**与它相反的是项目方针**：那一份正是给模型做决定用的，因此它进前缀，而且只有人改得动。

| | 项目方针（`<realRoot>/AGENTS.md`） | **文档** |
|---|---|---|
| 读者 | 模型 | **人** |
| 进前缀 | 是——共享头的一个段 | **否，任何区都不进** |
| 位置 | 真实工作树里，**不在视图里** | `<realRoot>/.fugue/docs/`，宿主私有 |
| 变更来源 | 人编辑 | **每次重生成** |

**方针的格式取既有约定**：分层 Markdown——`AGENTS.md` / `CLAUDE.md` 已经是事实标准。因此**同一份文件在别的 harness 里也生效**，项目的方针不锁死在本架构里。

**方向是单向的：状态 → 文档。** 一旦某个 agent 读了文档做决定，文档立刻成为决策来源，也就成为第二份真源。**这与会话记录不进子 agent 的前缀是同一条纪律——模型的决定只能来自它的前缀，凡不进前缀的东西都不在决策链上。**

**生成方式是"两个输入 → 一个产物"**：

```
文档 = f(状态源, 每个文档的定义提示词)
```

**状态源是参数**——工作区的文件状态是其中一个，系统级配置是另一个（§ 15.3.a）。

**它与上下文组装器同形，不同质，因此是两个东西。** 同形指的是"声明式固定形状 + 状态填充内容"，两者也各有一个落点——给模型的前缀、给人的文档。不同质在**执行**：装配是可复现的纯函数（给定快照与协议，输出同一个字节哈希，§ 13.4 P3），**渲染要过模型**；复用判据里的"接口纯"要求输出只由输入决定，渲染器过不了这一条。**可复现的那一半能进核，过模型的那一半不能。**

**过模型不是它欠的债，正是它的用处：只有模型能准确反映变化。** 机器填表能告诉你状态**是什么**，不能告诉你**两次渲染之间发生了什么、那意味着什么**；模型能。

**它的前提在接上模型那一站**（§ 20 的 S8）：渲染要过模型，这一层因此与模型同期；T4 的界面个性化建在它之上。

**加一份文档 = 加一份提示词，不加机制**（§ 24 纪律 8）。因此**任何"给人看的状态"都表达成一份定义提示词，不新造渲染器**——轨迹看的是**事件**（正在发生什么），文档看的是**状态**（现在是什么），两者分工不重叠。

**文档定义本身是一份配置**：文档清单 · 每份的路径（它决定**文档目录的形状**）· 每份的定义提示词。它归**工作区级**，住 `<realRoot>/.fugue/config`（§ 9.2）。

**这份定义就是 DSH 的 `docs/AGENTS.md` 所做的事**——声明这棵树里有什么、每份归谁、每份不该写什么。**DSH 把这份声明放在文档树里，而它的 agent 够得到文档树**，那是它"agent 自己维护文档"的选择；**本架构两样都不给**：定义住配置，文档住宿主私有路径。**凡在配置文件里的，模型都不可写**——这条不需要逐条论证，**位置就是规则**（§ 24 纪律 13）。模型要加一份文档，走申请（§ 15.3.b）。

**文档住在 `<realRoot>/.fugue/docs/`**——与日志 · 快照 · 配置并列（§ 9.2）：**不在视图里 · 不在任何分支上 · 不进版本控制 · 默认不进前缀 · 可弃、可重生成**。

**这个位置由纪律 1 定：派生的东西不提交。** 视图里的每一份文件都会被定格成提交，于是这份渲染产物就有了第二条命——它能被人从历史里读回来，而它描述的是它被渲染那一刻的状态。**文档渲染的是"现在"，而"现在"只有一份**，所以它跟日志住在一起。**文档不可手改也不需要一条禁令**：宿主私有加上整体重渲染，改了也留不到下一次。

**模型够不到文档，靠的是三条既有性质，不是一条新禁令。** 三条各自独立，任一条成立就已足够：模型的文件工具只认视图内的相对路径（§ 1.5 结论 3），而文档不在视图里，**没有哪条路径指得到它**；模型改状态只经声明式动作（§ 8.6），而动作名取自系统级白名单（§ 15.3.a），**没有"写文档"这个动作**；渲染**不是 agent 的一个动作**——它没有动作名、没有路径参数、不进轮次状态机：持轮者只产出文本，**路径取自文档定义（一份配置），写入由宿主完成**（下）。所以"只在那一步够得到"是低估了：**模型手里根本没有那一步。**

**反向也成立：文档读不进任何段。** 段的值来自声明过的那几个源（§ 8.11），而段的容器是 `Protocol`——它住在常量源里（§ 15.3），模型够不到。**要让文档成为一个段的来源，得先改 `Protocol`**，那是一次显式改动，不会悄悄发生。

定义提示词声明这份文档的**形状**，文件状态填充**内容**。**校验的对象因此不是文档，是它的状态指纹**：文档不要求逐字节复现，**可读性优先于可 diff**——文档只被读、不被改，所以优化的目标是读。

**每份文档的头一行记下渲染它的状态指纹。** 这与 DSH 的生成物在文件头声明自己的生成来源是同一件事，记的东西不同：DSH 记"谁生成的"，本架构记"从哪一版状态生成的"。于是**"过期"是比出来的**——指纹与当前状态不一致即过期，不需要任何人做判断。

**重生成，不修补。** 修补的坏处不是"改动小"，是**锚定在既有结构上**：模型看到一份现成文本就会保留它的结构，文档于是逐次变成不反映当前状态的历史沉积层。**重生成把锚点拿掉——每次都从状态出发，不从上次的文本出发。** 这与"上下文是重建的、视图是重放的、契约是重构的"是同一句话。

**渲染成 HTML，并可互动。** 纯文本服务编辑，HTML 服务阅读——文档只被读，所以它取可读的那一形态：依赖图可点、字段可展开、决策按状态筛选。**可互动性不许引入只在文档里存在的信息**：不能有文档内的笔记，不能有手工补充的说明——**一份可以手补的投影，就是一份真源**。同理，**写路径不经过文档**：界面上任何可点的东西产生的是一次**动作**，动作改变状态，文档随后重生成——**文档不持有状态**。

**"为什么"不进文档。** 决策理由与失败尝试由**提交历史**承载——到达有意义的节点即 `ckpt/commit`，提交信息就是进度叙事，它也是机械可恢复部分中携带"为什么"的那一项（§ 8.13.a）。**agent 的"为什么"来自提交历史，文档只承载给人看的整体形状。**

**两类内容的寿命不同。**

| 内容 | 寿命 | 处理 |
|---|---|---|
| 决策登记 · 未决事项 · 步骤计划 | **施工期**——落进代码即失效，解决即消失 | **被消费掉，然后删掉**。持续维护它们正是修补倾向本身 |
| 模块边界 · 两条分层纪律 · 全局纪律 | 长期 | 重生成覆盖 |

**触发是"大变更之后"。** 可机械判的判据：模块边界变化 · 公开接口变化 · 顶层目录增删 · 依赖图变化。**判据未成立时由人发令**——没有判据的地方不做判断。

**写文档的是归并完的那个持轮者，落盘的是宿主。** 模型是内容的作者；**路径与写入的主语是宿主**——路径写在文档定义里，而持轮者够不到它，也无从选择。归并之后它手里同时握着两样东西：**归并后的状态**（B 区的文件内容在归并后重建）与**这一轮的变化**（C 区那段只追加的积累，含全部契约的上报与讨论）。缓存论证是算术——在它的下一步追加一条定义提示词，**A + B + C 全命中**，边际成本就是文档本身的输出 token；换一个独立调用者，要付一整份 B 区的装配与输入。

**写完即重启，所以没有回流。** 持轮者挂在 `Round` 之下（§ 15.6），**重启是常规动作而不是代价**——§ 15.1.a 设计的正是"重启之后能接上话茬"（凝聚理解 · 凝聚前最近几次原文 · 会话记录的可读坐标）。写下文档的那一个持轮者就此结束，**这份产物没有任何一步会回到谁的上下文里**；人要在轮后另要一份，动作就是起一个持轮者，与每轮开头的那个是同一个动作。

**它是轮次收尾唯一的额外产物。** 收尾产出的这一份只有一个人读：**人**。

### 9.10 保留前缀

**有一类文件既不属于用户的交付物，也不该只活在某个 agent 的上下文里**：讨论原文、设计稿、拆分草案、读过的文件清单。它们是环境侧的**准备状态**——后三样由 § 15.1.a 给出同一条理由：**"否则回退时它只能凭记忆取舍，而记忆就是上下文——重启即失。"** 讨论原文的理由在 § 15.1 纪律 1——**累积在环境里，只有投影进前缀**。

**它们住在一个保留前缀下**，前缀是虚拟命名空间里的一段，取值是宿主的常量源之一（§ 15.3）：

```
.fugue/session/   讨论原文归档，按轮分文件
.fugue/design/    设计稿
.fugue/plan/      拆分草案——派发门的输入（§ 15.1.a）
.fugue/read/      读过的文件清单
```

**`.fugue/` 这个名字出现在三处，指的是三个目录。** 机器自己的在 `~/.fugue/`——系统级配置住那里（§ 15.3.a）；工作区的是 `<realRoot>/.fugue/`，放日志 · 快照 · 配置 · 文档（§ 9.2），它在真实工作树里、宿主私有、不进版本控制；而本节这个 `.fugue/` 在**视图**里，可提交，且被 `M13` 跳过。**三者不是同一个目录，规则却只有一条：系统自己的地方都叫 `.fugue/`。**

**三处各用各的名字。** 视图里那一个底下是保留前缀的四个取值（`session` · `design` · `plan` · `read`），宿主私有那一个是 `log` · `snap` · `config` · `docs`，机器那一个是配置与它的改动记录：`.fugue/` 后面跟的那一段，说明它是哪一处。

**五条性质，每条都由一条既有纪律推出**：

| 性质 | 由什么推出 |
|---|---|
| **在视图里** | 模型只有 `read` `write` `edit` `read_image` `glob` `grep` `bash` 碰得到文件，而它们只认相对路径（§ 1.5 结论 3）。空间在视图之外，就得为它加一个工具 |
| **在分支上** | 纪律 10：要让进度活过 agent 的更替，就先把它定格成提交 |
| **不进真实工作树** | `M13` 推进真实工作树时**跳过保留前缀**（§ 8.14）。`<realRoot>` 与用户拿到的交付物里，它都不出现 |
| **进物化树** | 它在视图里（第一行），而物化是视图的投影（§ 8.5）。模型的工具与沙箱里的 `bash` 因此看到同一批路径，不必为它开第二个面 |
| **默认不进前缀** | 与讨论原文同一条纪律（§ 9.8）：**能查到，默认不花字数** |

**文档不在这个空间里。** 表里五条性质各有各的推出理由，而文档一条都不适用：它不被模型读写（§ 9.9），所以不需要在视图里；它渲染的是"现在"，不是某个分支的进度，所以不需要在分支上；它由渲染器直接写出、不经过 `M13`，所以没有"跳过保留前缀"这回事；剩下"默认不进前缀"一条，对一份宿主私有的产物自动成立。**它因此住在 `<realRoot>/.fugue/docs/`**（§ 9.2），与日志 · 快照 · 配置并列。

**这个空间的"系统管理"落在三件具体的事上**：前缀是宿主常量，不在各处硬编码字符串；写入走**同一套视图与日志**（`view/write` 事件与提交协议），**不新增持久化模块**（§ 9.1）；**提交信息同样守"环境标识不进入前缀"**（§ 8.11 约束 3）——提交序列是 Zone B 的段，系统自己的提交也进那个序列，所以那里只写"把验收拆成两条"，不写轮次编号与 scratch 路径。

**保留前缀不是第二份真源。** 它没有自己的提交记录，也没有自己的分支：它就是**视图里的文件**，因此它的真源仍是 git 对象库（§ 1.4）。与普通文件的唯一差别是它在真实工作树里不可见——那是 `M13` 的一条跳过规则，不是一个新模块。

### 9.11 serve 协议

**这一节冻的是语义与故障那一刻的形状，不是今天的实现。** serve 的命令行骨架（stdio · 生命周期 · 闲时自退）已按本节落地（0.4.2）；本节冻的是它的语义，此后改它是一次显式的改动，不会悄悄发生。**进程角色与传输解耦**：进程角色（谁读账 · 谁写账）与传输（在哪条线上说话）是两件事——传输从 stdio 起步，换传输不改本节任何一句。

**三条不许**：**不加动词**——要加就是改 § 9.6 那张表，那是一次显式的改动 · **不让渲染器塑造事件模型**——流格式是产品，渲染器是配件（§ 9.8）· **不让读法出现第二份**——一张真源、多张脸：serve 不定义自己的事件族，也不自己记一份"它以为的世界"。

**方法面。** 传输是 stdio 上的 JSON-RPC 2.0 报文，**一次调用一行**。JSON-RPC 2.0 与传输无关、不定分帧，"一行一调用"是本站的传输约定——换到网络档时换的是这条约定，报文形状不动。

**方法名是既有 CLI 动词的外部别名**：方法名 ⇄ § 9.6 那张表里的一条命令，段与段之间用 `.`，命令与子命令各占一段（`status` · `watch` · `round.run`）。**本节不抄第二张对应表**——对应关系从 § 9.6 派生，那张表是唯一一处；一条命令不在 § 9.6 里，它就没有方法名。**一个方法三样必须声明**：对应的 CLI 动词 · 它是读还是写 · 输出由哪个模块负责（与 § 9.6 那条"每条命令恰好声明一个对它的输出负责的模块"同一把尺子）。

**表里两类行分得开。** 一类是**动词**——收参数、出值、成或不成，每条都有方法名（`status` · `watch` · `round.run`）。另一类是**入口**——`tui` 是一张脸的入口，同一份读面的另一种渲染；将来 `serve` 是同一个可执行文件的另一种进程角色。入口说的是这份东西怎么跑，不出方法名。

**字节走带外。** `read` 与 `write` 是动词，载荷是字节；「一次调用一行 JSON」这条形状装的是文本，所以 v1 的方法面只到**元数据那一条边**——`stat` · `list` · `diff` 把路径、大小、模式说清楚，字节本身仍走它今天走的那条路（CLI 上是 `read` 写 stdout、`write` 从 `--from` 或 `--stdin` 收，§ 9.6）。将来把它摆到协议上时，取的形状是**内容寻址的引用**：字节先进对象库拿一个 id（`putBlob` 今天就是这个形状），方法收发的就是这个 id。同一个 id 就是同一份内容——重试天然安全，续传天然可分片，服务端不必为此记住任何东西。

**协议版本住在每一次调用上，不住在会话上**（serve 没有会话状态——CLI 是单次进程 + 每次重建，§ 9.6）。它是 `params` 里的一栏保留名 **`_protocol`**——下划线是「这不是任何一条命令的参数」那个记号（`assemble` 那一条自己的 `protocol` 参数因此不与它撞名）；**报文顶层不放私有栏**：基范让给实现的位置只有两处——方法自己的空间（`params` 的成员名）与错误的扩展位（`error.data`），顶层那四栏不是这种位置。版本是点分十进制串，从 `0.1` 起：产品版本每一版都跳，协议版本只在报文形状与语义变时跳。不认得的版本**明确拒**——错误码 `-32602`，`data.supported` 报出服务端支持的版本列表；服务端那一代不在常规回执里（回执是命令的输出形状），客户端拿一个版本问一次就够。**降级映射**（旧客户端撞上新版本时退到哪一档）在出现第二个协议版本之前不立：单版本世界里"退"验不出来。

**错误形状是 `{ code, message, hint, subject }`**（§ 9.8 那张表已经写了这一行），装进 JSON-RPC 的 `error` 成员：`code` 与 `message` 是基范标准化的两栏，`hint` 与 `subject` 住基范留给实现的 `data`（`{"code":…,"message":…,"data":{"hint":…,"subject":…}}`）——基范对 `data` 的原话是「值由服务端定义」。**码分两段**：传输与请求本身的错用标准段，本站自己的失败与拒绝用实现段 `-32000…-32099`；三段与 § 9.8 的四档退出码一一对上，不新造第五档。

| 码 | 什么时候 | 退出码 |
|---|---|---|
| `-32700` 解析错 · `-32600` 非法请求 · `-32601` 方法不存在 · `-32602` 参数或版本非法 | 这条调用本身不成立 | `2` 用法错误 |
| `-32000` 命令失败 | 调用成立，事情没成 | `1` 失败 |
| `-32001` 被边界拒绝 | § 8.8 的边界挡下 | `3` 被拒绝 |
| 无错 | — | `0` 成功 |

**读命令不取栅栏**（§ 9.7「观察不得影响状态」读出来就是"观察不加锁"）。**写句柄整寿命持有该 writer 的栅栏**：一次变更请求 = 一条 CLI 命令的寿命——取锁在开写句柄那一步，放锁在收尾那一步（§ 9.2 三条边界）。**只改 ref 的命令不开写句柄**（`branch` 那一类），因此不在这道栅栏里——它们靠 ref 的 CAS（§ 9.2 已经写了那一句）。**serve 不持有跨越命令的写句柄**：它按请求开、按请求关，与 CLI 一模一样。

**要 N 把栅栏的请求先拿全再开口。** 中途撞上任何一把，已拿到的**全部放掉**，请求以明确的 busy 结束——不领重复序号，不留半份日志（§ 9.2：那道锁守的是"一份日志一个写者进程"）。

**客户端的三种死法各有形状**：干净断开走收尾（先关句柄、再放锁）· 超时只停止接受新请求，已经接受的写到它能写的边界——**不许把超时伪装成成功** · 被 `kill -9` 什么都不清理，锁留在盘上，下一条命令按 § 9.2 的既有判据（pid · 进程起始时刻 · boot id）接管，**不另造第二套判据**。

**回执按原调用序归位**，执行完成的次序只作瞬时进度。**这一句说的是给模型的那一份回执**——线上报文按 `id` 配对，本节不要求服务端排队（基范：批量响应可以任意次序回，客户端按 `id` 自行配对）。

**事件通道。** 通道的来源是**账本尾随**——`fugue watch --follow` 那条读法（一趟一趟地看，按每个 writer 的游标筛掉看过的），**不是第二条管道**：serve 不自己记一份事件流，也不重排它（§ 9.1 没有持久化模块 · § 9.7 日志是唯一的观察对象）。**一趟调用回一趟事**：每一趟尾随是**一次调用**（「一次请求 = 一条 CLI 命令的寿命」那条已批语义就落在这一档上），响应里带这一趟读到的事件与下一趟要用的游标——客户端拿着游标接着问下一趟。**v1 不在 stdio 上开第二条流**：stdout 上跑的是 JSON-RPC 报文，一行一条；事件在那一条回执里面，不是另一种行。

**一条事件一个信封，带全序坐标 `(seq, writer)`**（CLI 那一面按 NDJSON 一行一个，§ 9.8 那张表已有一行）。**事件的载荷一个字段都不许改**：透出的就是账上那条事件本身。

**游标是每个 writer 一个**（`{writer: seq, …}`），语义是**排他下界**——只保证该 writer 的 `seq` 之后。裸 `seq` 会**永久漏掉晚出现的 writer**（它的第一条就是 `seq = 1`，§ 9.8 已经写了这个坑）。游标要能被外部**构造**：`watch --follow` 退出时印出来的那一串就是它，`--resume` 原样吃回去。

**钟栏随事件原样透出**（`ts` · `boot` · `inc`，§ 9.2 的信封），但**不是游标的一部分**——它不参与任何排序。

**缺进度就说缺**：模型类那四族不持久（§ 9.7），尾随读不到的就是读不到——**不许把瞬时进度冒充可重放的账**。

**服务端可以记住派生物。** 跨调用留得下的只有**能从账重算的东西**：一次只读批次固定在一个代上（期间有写入就整批作废，两代不拼接）· 一份按 writer 的尾部索引（追加即推进，重建只花时间）。它们的共同性质是**可弃**——重启 · 换一个进程 · 删掉重算，读出来的东西逐字节不变。游标与附着者集合住在客户端那一侧，每一端带着自己的游标来问；账上照旧只记发生过的事。

**附着 / 暂停 / 单步。** 三个表达位在本节**冻住语义、留空实现**（`attach` · `pause` · `step` 的落地晚于本节）。**表达位留白：本节不定义事件**——要冻它们的状态就得先有事件形状，而给事件联合加族是一次显式的改动（§ 8.1）。

**附着是纯读者**：不取栅栏 · 不起轮次 · 不新增事件（§ 9.7「观察不得影响状态」）。附着者之间互不打扰：各自从自己的游标读**同一份**合并全序，服务端不替它们对齐，账上也不记"谁附着过"。

**附着不设硬上限**：每一端的成本是一个文件描述符加一份游标集，自然上限就是服务端的文件描述符与内存——一个魔法数挡不住真实的灾，只会把「慢」变成「不许」。**什么条件下改主意**：每一端的成本开始跟着账的长度长（而不是跟着 writer 数与端数）——那时才立闸。

**暂停停的是下一批的批边界**，不是某一条命令的中途。**写到一半停住，账上就出现一条没有结尾的写**——那是账的形状问题，不是交互问题。**单步是粒度，不是新机制**：它只对"一格一步"那一档有意义（`llm/call` 一步一条，§ 8.13.a），与暂停的差别只在粒度。**门的动作（放行 / 拒绝）不是 serve 的新能力**：它是既有动词，账由子进程写（§ 9.8：`g`/`y` 起的都是那条命令）。

**多端附着的会话模型**（换传输之后多端共用一个 serve 的那一面）：附着者集合**不落账**（落账就是观察影响状态）· serve 活到**最后一个附着离开**之后再加闲时自退（stdio 底下一进程对一个客户端，这一句在那儿自然成立）· 事件交错就是各附着者各自的到达序，服务端不替它们对齐。

**本节收口**：上面每一格都定了形，改本节是一次显式的改动（首段那句），不会悄悄发生。

## 10. 线协议与模型拟合

### 10.1 四层，各自的自由度

**与提供方打交道的地方只有四处，各自的自由度不同。** 分开之后，**哪一层被约束、哪一层自由，一目了然**：

| 层 | 是什么 | 约束 |
|---|---|---|
| **内容** | 状态、视图、代码树、意图 | **完全自由**。API 管不到内容 |
| **承载** | 什么进前缀、什么留在环境里按需读 | **完全自由**（§ 8.11） |
| **传输** | 请求的序列化格式 | 每个线协议一个适配器 |
| **约束面** | 模型可见工具与能力的形状 | **必须拟合训练分布** |

**同一件事的另一种切法——请求由三部分构成，对话只占其一**：

```
请求 = 调用配置（模型 · 推理强度 · 上限）
     + 派生消息（从状态推导，不是存下来的）
     + 工具 schema
```

**推论**：只要三者中任何一个能变，请求就能变。**"对话式 API"没有收走任何东西**——它收走的是"把推理放在哪里"，而本架构本来就不把推理放在消息里。

原则一句话：**逻辑约定与提供方无关，适配器拥有协议。**

内部 `Protocol` 保持规范形状不变，每个提供方适配器只做一件事——**把自己的协议翻译进这套词汇**。**API 不被拟合；被拟合的是 API 的约束，而它被拟合进数据。**

> **判据**：如果一个适配器里出现 `if (model === 'x')`，说明该差异没有被建模为一个声明式能力字段。DSH 把这件事做对的方式是 `systemPromptUpdate`（§ 8.11）——一个模型声明的值，检查后驱动三种处理，而不是散落的分支。

### 10.2 什么必须固定，什么自由

**必须固定的四条**——每一条都由本架构自身的性质决定：

| 约束 | 来源 |
|---|---|
| 请求形状在轮内固定 | 缓存契约（前缀单元要求逐字节相同） |
| 工具 schema 跨状态转移不变 | 同上；DSH 为此让 `exit_plan_mode` 在非激活时也保持注册 |
| 工具名与形状取自训练分布公共集 | 换名会在模型侧变成需要重新学习的差异 |
| 每模型一个 token 预算 | 物理 |

**重试也受这四条管**（`P2f`）：值得再来的错（提供方声明的那几个状态码，或开了超时档的传输错误）按声明的次数重发，而重发的是**同一份 body**——它在传输循环外拼一次，所以"重试的 `bodyHash` 与首次逐字节相同"不是又一条纪律，是第一行那条约束的直接推论；线中掐断（字节流已开始解析）与人喊停不在重发之列，账上 `llm/call` 的 `attempts` 记每一次的状态码（**恰一次时整栏不出现**）。

**自由的五项**：

| 自由 | 本架构的使用方式 |
|---|---|
| 段的内容与顺序 | `Protocol.segmentOrder`，声明式数据（§ 8.11） |
| 渲染规则 | 每个 `SegmentId` 一个 `RendererId` |
| 再生成 / 切片 / 合并 / 重载的分界 | 推论 3，全部由轮次结构决定 |
| 什么进上下文、什么按需读 | 引用与摘要进前缀，内容按内容寻址（§ 8.11） |
| 几个 agent、什么形状的观察面 | 与线协议无关 |

**自由度的分界就是状态与投影的分界：当对话是状态时，消息列表是唯一真源，每轮只能在它后面追加，自由度归零。本架构的状态住在环境里、对话是重建出来的投影，删掉都能重建（规则 1），因此消息格式收不走任何东西。**

**我们与 API 的关系**：模型决定记忆的形状，环境决定推理的形状，两者靠组装器相接，不互相塑造。这是 § 1 两条规则在协议层的同一条结论。

### 10.3 选型

| 线协议 | 与本架构的契合 | 代价 |
|---|---|---|
| **Anthropic Messages** | **最契合**。`cache_control` 断点是显式数据，与 Zone A/B/C 一一对应；`tool_use` / `thinking` 块形状稳定 | 仅部分网关支持 |
| **OpenAI Chat Completions** | 缓存是隐式的（仅前缀自动命中），无断点可声明。但它是**事实上的最大公约数** | 缓存控制精度低 |
| **OpenAI Responses** | 有状态会话与 `item` 概念——**与"状态住在环境里"直接冲突** | 需要额外一层状态映射 |
| **裸 completion** | 前缀可控到极致，缓存最精确 | 没有工具调用原生形状，模型先验最差 |

Messages 把缓存区域**显式化为数据**——这正是 Zone A/B/C 需要的表达能力，因此它是**起点**；Chat Completions 是绝大多数提供方与自建网关的**事实标准**，因此它是**覆盖面**。两者共用同一套规范词汇，所以**多一个线协议 = 多一个适配器，不改内核、不改面**。

**结论：Messages 优先，Chat Completions 兜底。** 这不是路线选择，是**分层已经给出的结论**：线协议住在适配器里，所以它可以有多个。

**思考那一栏是两条线上缺省意思相反的一处，而它带一条硬契约。** 请求带 `tools` 时，上游要求把历史每一步的思考**逐字回传给下一次请求**（不回传就 400）——所以思考在本架构里既不是日志、也不是给人看的读数，它是**请求的一部分**：它随 `Turn` 活到下一步（`Turn.thinking`，与 `text` 并列）。两条线的字段名不同（Chat Completions 是助理消息上平级的 `reasoning_content`；Messages 是助理消息里第一块 `thinking` + `signature`），而**开关的缺省相反**（Chat Completions 不写就是开，Messages 不写就是不开），所以**档位必须由声明写出来、不由缺省说**：`ModelDecl.call.thinking`（`off` / `low` / `high` / `max`）。**日志记的是我们声明的那一档**（`llm/call` 的 `thinking`，`null` = 声明里没写），不是适配器补出来的那一档——两处都记就会漂。

**"上游说它没走完"是第六种收尾，而不是一次解析错误。** 官方那两张表里各有这样的档（Chat Completions 的 `insufficient_system_resource` 与 `aborted`、Messages 的 `pause_turn`）；把它们当解析错误抛出去，代价是**那一趟的用量永远算不回来**（账上只剩一句"没走完"，钱那一栏成了下界）。所以它们是 `StopReason` 的第六档 `incomplete`——**值域按动作分、不按上游的措辞分**（我们这一档做的事是同一件：这一趟不算数），而上游那个原话进 `rawStop`，所以"它到底说的是哪一个"分得开这件事没有丢。

**钱那一栏只从上游报的 token 算，价目是数据不是代码。** 用量那四个数（§ 8.15 的 `prefix-hit-rate` 读
它们）是上游报的；钱是**那四个数 × 官方价目**，所以算法是一处纯函数（`src/model/price.ts` 的
`costOf`）而价目随模型目录走（`P2d`：内置档里它是 `PRICE_BOOK`，`~/.fugue/models.json` 在场时是各家
内嵌的 `prices`——三个档 × 峰谷两档，单位照官方那一页是美元 / 百万 token）——换价 · 加模型 · 接节假日
都只动那份目录或一个参数，碰不到算法；读侧**不缺省回内置**（文件档在场时钱按内置算是漂移）。**思考 token 是 `outputTokens`
的明细**（上游给 `completion_tokens_details.reasoning_tokens`），所以它进读数（`USAGE_FIELDS`）不进
钱：`USAGE_COUNTS` 仍是那四样，两句说法各自指得出来。**峰谷那一档由读的人给**：官方那两个窗
（UTC 周一至周五 01:00–04:00 与 06:00–10:00）算得出来，而"中国法定节假日"那一份数据不在这份代码里
（`phaseOf` 收一个日期表参数，缺省是"一个都不知道"），所以回执那一行把档印出来——算错档看得见。
**没有价目不是 0 元**：名字不在表里时那一行说"算不出来"。

### 10.4 两条纪律

1. **模型可见 ⟺ 已记录。** 请求里的**状态类内容**必须能从 `M0` 的日志重建——这使前缀可被重放、被 A/B、被归因。**模型自己生成的文本不在其中**：它在活着的会话里回到下一步请求，但不进日志（§ 9.7 的会话内与会话外）。跨进程重启靠交接提示词与机械重组（§ 8.13.a）。
2. **只在声明式能力允许处做拟合。** 拟合的成本落在适配器，不落在内核与面。**内核不认识模型**（§ 6）——它也不认识线协议。

### 10.5 验证方式：录制夹具

拟合正确与否，用**录制的会话夹具**验证，无需 API 密钥：

- 从一份已录制的会话日志回放模型流，即可对真实 agent 跑确定性快照测试。
- 夹具中 `request/header` 的内容可**令牌化为占位符**（系统文本 / 工具 schema），回放时物化。这使得"Zone A 跨 N 个 agent 逐字节相同"这条验证性质（§ 8.11）**成为一条可执行的快照断言**。
- 只基于内容的目录校验 + 逐事件比较，可以钉住"插入的系统消息"这类协议细节。

**这意味着 S6 的缓存核算不需要等到有真实模型才能测。** 先录一份，之后每次改动都对着它跑。

---

# 第四部分 · 复用性审查

## 11. 复用性的三档：核 / 装配体 / 宿主

复用不是一个二值属性，而是**三档**。分清三档是让"复用"这件事可操作的前提。

| 档 | 定义 | 判据 | 跨项目复用 | 例子 |
|---|---|---|---|---|
| **核 Core** | 纯机制，零领域耦合 | **J1 多消费者 · J2 接口纯 · J3 零领域耦合** | ✅ 可 | `M2` `M3` `M4` `M10` |
| **装配体 Kit** | 由核组合而成的一个领域动作 | **K1 多消费者 · K2 只接线不引入新机制 · K3 契约冻结（实现可变）** | ⚠️ 作为**模式**可 | `spawn` `runtime` `signalBus` `envRealize` `mergeKit` `verifyGate` |
| **宿主 Host** | 工作区范围内的单例，承载真源 | **H1 唯一性由物理事实决定 · H2 生命周期 = 工作区** | ❌ 不可 | `mainRef` `realRoot` 常量源 `Round` |

**判据只有三套，主体却有四档。** 系统级用的是同一套 H 判据——H1 问"唯一性由物理事实决定吗"，H2 问"寿命多长"，它两条都满足，只是范围从工作区扩到机器（§ 15.3.a）。因此**复用性审查按判据分**（本节与 § 12），**生命周期图景按主体分**——那四档见 § 15.6。

**模块表（§ 7 · § 12）另用三个标签**——能力 · 内部 · 内部模式——它们**不在复用三档之内**：**「核心」对应核 ·「装配体」对应 Kit**。接口冻结另有一条线：**核与能力的接口都冻结，内部与内部模式不冻结**（§ 12 的最后一列）。

**核的三条判据**（同前）：

| # | 判据 | 含义 |
|---|---|---|
| **J1** | **多消费者** | 系统内已有 ≥ 3 个调用方，或有明确的未来调用方 |
| **J2** | **接口纯** | 输入输出皆为值，无服务句柄，无环境查询 |
| **J3** | **零领域耦合** | 不知道"契约""分支""轮次"是什么 |

三条判据的直接后果：**核必须冻结接口**。而接口冻结又是内核原生迁移的前提（§ 17）——**迁移名单包含核之外的能力模块**（`M1` `M5`），它们的接口同样冻结，理由是同一条：接口不冻，换实现就要动调用方。

**装配体的判据**：

| # | 判据 | 含义 |
|---|---|---|
| **K1** | **多消费者** | ≥ 2 个真实的产生方或消费方 |
| **K2** | **只接线，不引入新机制** | 装配体是新机制的禁入区；任何新机制必须下沉为核 |
| **K3** | **契约冻结，实现可变** | 冻结的是"一个子 agent 是什么"，不是它怎么造出来 |

**K2 是防止装配体膨胀为 god module 的关键纪律。** 它给定了一条清晰的判据：*如果一个东西既不是核（纯、零耦合），也不是宿主（单例、真源），那它就是装配体——它必须只做接线。*

## 12. 复用性审查表

**复用价值 ≈（消费者数 × 接口稳定性）÷ 领域耦合**——这张表的每一列都是它的一个因子：

| 模块 | 级别 | 消费者 | 领域耦合 | 接口冻结 |
|---|---|---|---|---|
| `M10 assemble` | **核心** | 主 agent、每个子 agent、合并 agent、冲突解决 agent | **零** | ✅ |
| `M2 view` | **核心** | 文件工具、发现工具、`M4`、`M6`、`M13` · `M10`（文件内容段） | 低 | ✅ |
| `M3 roots` | **核心** | `M4` `M5` `M6` `M7` · `M11`（路径合法性）· 代码树（§ 8.16.a） | 低 | ✅ |
| `M4 materialize` | **核心** | `M5`（间接）、`M13`、冲突解决、`spawn` | 低 | ✅ |
| `M7 policy` | 能力 | `M5` `M8` `M13` | 中 | ✅ |
| `M5 execute` | 能力 | `M9`（`run_action`）· `verifyGate` | 低 | ✅ |
| `M1 truth` | 能力 | `M2` `M4` `M13` | 低 | ✅ |
| `M0 log` | 能力 | 全部 | 零 | ✅ |
| `M14 probe` | 能力 | `M12` · 诊断与演进判据（§ 9.8 · § 17） | 零 | ✅ |
| `M6 reclaim` | 能力 | `M8` · `M13`（冲突解决回收） | 低 | ✅ |
| `M11 contract` | 内部 | `spawn`（发契约）· `verifyGate`（断言）· `M12`（预备态） | 高 | — |
| `M12 round` | 内部 | 持轮者 · `M13`（`Committed` 才推进） | 高 | — |
| `M13 merge` | 内部 | `M12`（合并动作的触发）· CLI（§ 9.6） | 高 | — |
| `M8 capability` | 内部模式 | `M9` · CLI（§ 9.6） | 中 | — |
| `M9 tools` | 内部 | 模型 | 高 | — |

**复用核心 ≠ Rust 候选**。`M10 assemble` 是复用核心，但它是冷路径（字符串拼接），**不演进**。复用性判据管接口稳定性，语言选择管热路径（§ 17）。

## 13. 上下文组装器作为复用核心

### 13.1 复用价值的来源

按 § 11 的三条判据逐条对照：

| 判据 | `M10 assemble` |
|---|---|
| **J1 多消费者** | 主 agent、每个子 agent、合并 agent、冲突解决 agent、未来任何 agent 类型——**系统内消费者最多** |
| **J2 接口纯** | `(状态值, 协议数据) → 字节`。**纯函数，无句柄，无环境查询** |
| **J3 零领域耦合** | 它不知道契约、分支、轮次、沙箱为何物——收到的是状态 |

分母为零，分子最大。**它是全架构中复用价值最高的模块。**

### 13.2 它是核心论点的技术前提

"协议即数据"这一主张能否成立，取决于组装器能否与引擎分离：

```
组装器可分离  →  协议可以是数据
协议是数据    →  形状可版本化、可 A/B、可跨模型替换
形状可替换    →  跨模型可移植性成立
```

**组装器是整个架构主张的承载点。** 它一旦不可分离，协议就只能以代码形式散落在各处，跨模型适配无从谈起。

### 13.3 它的另一条复用轴：协议成为可分发物

组装器的复用不止于系统内部。**它使协议从代码变为可发布的产物**：

- 协议可被独立版本化、diff、回滚
- 协议可被 A/B 对照（同一模型，两个协议）
- 协议可被第三方采用，成为跨 harness 的交换物

这是从"一个 harness"演进到"一个协议生态"的路径。

### 13.4 保持复用性的三项约束

组装器是天然的引力井——运行时上下文注入、信号摘要、工具 schema 渲染、历史格式化都会被想塞进来。三项约束保其复用性：

| # | 约束 | 检验方式 |
|---|---|---|
| **P1** | **只做三件事：排序、渲染、拼接。** 不生产状态 | 若某函数需要查询环境，它不属于这里 |
| **P2** | **全部输入是值，无服务句柄** | 接口签名中不出现 `ctx` / `Truth` / `View` / `Materializer` |
| **P3** | **纯函数，可离线测试** | 给定状态快照 + 协议 → 输出字节哈希；不需要模型、git、磁盘 |

**状态的产生在日志、契约、配置三处，组装器只按协议把它们排成字节。** 这条纪律一旦破，复用性归零。

### 13.5 组装器接口

```ts
// 组装器的全部依赖，都是值
interface AssembleInput {
  protocol: Protocol                        // 数据
  model: ModelId
  segments: Record<SegmentId, SegmentValue>  // 键域 = protocol.segmentOrder 的域
}
```

每个段由各自的拥有者生产，组装器只按 `protocol.segmentOrder` 排序并拼接。**新增一种段 = 加一个键，接口不动**（§ 24 纪律 8）。

## 14. 装配体目录

核是纯机制，不表达任何领域动作。**领域动作由装配体表达**——它们把核接在一起，暴露一个动作。

| 装配体 | 组合了 | 消费者 | 复用价值 |
|---|---|---|---|
| **`spawn`** 子 agent 生产者 | `M2.fork` + `M4.fork` + `M11.issue` + `M10.assemble` + `runtime.start` | 轮次（N 个）、合并 agent、冲突解决 agent、**小任务里的帮手**（§ 15.2）、**主 agent 重建** | ⭐⭐⭐ |
| **`runtime`** 步进执行器 | `M10.assemble` + LLM 调用 + `M9.tools` + `M8.capability` + `M0.log` | **每一个 agent** | ⭐⭐⭐ |
| **`signalBus`** 信号总线 | `M0.log` + 订阅 | 全部产生方 → 轮次 / 主 agent | ⭐⭐ |
| **`envRealize`** 环境实现 | 系统级配置（根路径 · 端口池）→ env 重写 + 端口池 + 缓存目录 + `M5` | 全部执行、`M4`（temp/cache 根） | ⭐⭐ |
| **`mergeKit`** 合并套件 | `M1.mergeTree` + `M4` + `M6` + `M13` | 轮次收尾、冲突解决 | ⭐⭐ |
| **`verifyGate`** 验收门 | `M11.assertions` + `M5` 执行 | **合并时 · 单 agent 自检时** | ⭐⭐ |

### 14.1 `spawn` —— 子 agent 生产者

**它是推论 3′ 的直接实现**：*环境维持共享、代码 fork、上下文 build*。

```ts
interface SpawnKit {
  spawn(contract: Contract, base: CommitId, opt?: SpawnOptions): Promise<AgentHandle>
}

interface SpawnOptions {
  deferMaterialize: boolean   // 默认 true —— 走 D3（按需物化）
  model?: ModelId             // 默认继承持轮者
  protocol?: ProtocolRef      // 默认继承持轮者
}
```

**内部步骤**（全部是接线，无新机制）：

```
1. identity.allocate()  → AgentId, BranchId
2. M2.fork(base)        → 视图（纯内存）
3. M4.fork(...)         → 物化（默认延迟到首次执行需求）
4. M11.issue(contract)  → 契约入库
5. M10.assemble(...)    → 种子前缀（Zone A 共享 + Zone B 分支）
6. runtime.start(agent)
7. signalBus.subscribe(agent)
→ AgentHandle
```

**分类依据**：它知晓契约、分支、轮次（**J3 不满足**），且它有副作用（**J2 不满足**）。它的复用保证是 **K3：冻结"一个子 agent 是什么"，不冻结"怎么造出来"**。

**K1 满足**：五类消费者——轮次的 N 个分支 · 合并 agent · 冲突解决 agent · 小任务里的帮手（§ 15.2）· 主 agent 重建。**这是它值得成为独立模块的全部理由。**

### 14.2 `runtime` —— 步进执行器

**它是全系统执行最频繁的操作**——每一个 agent 的每一步都经过它。

```ts
interface Runtime {
  step(h: AgentHandle, signal: AbortSignal): Promise<StepOutcome>
  run(h: AgentHandle): Promise<AgentOutcome>     // step 至收敛
}

type StepOutcome =
  | { kind: 'continue'; usage: Usage }
  | { kind: 'done'; usage: Usage }
  | { kind: 'failed'; error: HarnessError }
```

**一步的内容**：

```
1. prefix  = M10.assemble(protocol, state)
2. resp    = llm.call(prefix, tools = M9.schema())
3. calls   = parseToolCalls(resp)
4. results = calls.map(c => M8.capability.dispatch(c))
5. M0.log.append(...)
6. → 下一状态
```

**两条设计要点**：

- **`runtime` 是零工具调用率的观测点。** 指标钩子挂在这里（§ 8.15）。
- **`runtime` 不认识沙箱、不认识虚拟化。** 它只调 `M8.capability` 与 `M9.tools`；策略与虚拟化在其下方。

### 14.3 `signalBus` —— 信号总线

**它的载体就是日志**：一次 `emit` 就是 `M0.append` 一条 `signal` 事件（§ 8.1），一次订阅就是 `M0.readMerged` 上的一个过滤器。观察、指标、前缀、信号四样因此同出一源（§ 9.7）。

```ts
interface SignalBus {
  emit(a: AgentId, kind: SignalKind, digest: string): Promise<LogSeq>
  subscribe(kinds: SignalKind[]): AsyncIterable<{ agent: AgentId; kind: SignalKind; digest: string }>
}
```

**合并发生在读侧。** 同一 `kind` 的多次上报在这里汇总为一条、末次生效（§ 8.11 约束 4）——产生方各写各的，谁都不需要知道别人写过什么，`M0` 的每 writer 一份日志因此不必为它让步。

**两个消费者，两类作用**：轮次用它判断"全部完成与超时"，持轮者用它把摘要读成 Zone C 的一段（§ 8.11）。子 agent 只上报，不订阅。`SignalKind` 的类型系统与触发判据是未决项（§ 23 U4），而 § 8.13.a 的两类接续不依赖它。

### 14.4 `envRealize` —— 环境实现

**它的行为是固定的**：重写 `HOME` / `TMPDIR` / `XDG_*`，从端口池分配端口，建立 per-agent 缓存目录。配置只给**根路径与端口池范围**——"每 agent 一套"这件事本身不是配置项（§ 1.4）。它有两个消费者，**两者都向它索取路径**：

- `M5` 执行 —— 需要环境变量与端口
- `M4` 物化 —— 需要 `tempRoot` 与 `cacheRoot`

**宿主环境不再整份递进去**：子进程的环境按 `Policy.env` 那份基线装配（§ 8.8）。缺省 `core` 档只递**定位那几样**（`PATH` · `HOME` · `TMPDIR` · `LANG` · `LC_*` 前缀 · `TERM` · `SHELL` · `TZ`——缺了哪样影响子进程正常跑就往这份里加，改主意条件记在配置面）；`all` 是退化档（宿主整份，与旧行为逐字节相同）、`none` 空。`set` 静态注入（过坐标六键的保留清单）、`exclude` 剔除、`include_only` 窄化。合并次序：**基线 → 坐标 → `set` → 动作自己的 `env` → 命令行注入**——`fugue run` 与 round 两路走同一个 `envFor`。

**这份清单是闭的。** 沙箱里能打印出来的环境就是上面那几项——配置 · 凭据 · `<realRoot>` 的位置都不经环境变量传递。`bash` 看得见的只有这份清单，所以这条边界由它兑现（§ 24 纪律 13）：逃逸表丁组有一条专门问「宿主的环境变量」（`test -n "$DEEPSEEK_API_KEY"`），core 档下它读不到。

### 14.5 `mergeKit` —— 合并套件

**它把 § 8.14 那张清单里的第二到第四步接成一个动作**：`M1.mergeTree` 内存合并 → 冲突则 `M4` 物化冲突树 → `M6` 回收解决结果 → 回到合并 → 物化一次。轮次收尾与冲突解决是它的两个消费者，**走的是同一条路径**——冲突解决多绕一圈，用的还是这套合并。

**边界在它身上划清**：`mergeKit` 只到"合并结果落成真实字节"为止，**验收与推进真实工作树归 `M13`**（第 5、7 步）。因此"合并成功"与"这一轮通过"是两件事，中间隔着 `verifyGate`——这个划分让冲突解决拿到的是一份可验收的候选，而不是一个已经生效的结论。

### 14.6 `verifyGate` —— 双消费者

验收门有两个消费者：

| 消费者 | 用途 |
|---|---|
| `M13` 合并 | 合并结果落地后、提交前的验收 |
| **单个 agent 自检** | agent 在提交前自己跑一遍断言 |

同一份 `Contract.assertions`，同一个执行机制。**把"跑断言"做成独立装配体**，即可同时服务两者——且 agent 自检与合并验收使用完全相同的判据，消除"本地过了合并挂了"这一整类问题。

## 15. 宿主与单例边界

### 15.1 意图的两种来源

**任务由用户发出，意图由持轮者产生。** 二者不是同一样东西，生命周期也不同：

| | 任务 | 意图 |
|---|---|---|
| 谁产生 | 用户 | 持轮者 |
| 何时 | 对话中随时 | `Idle → Planning` 那一刻 |
| 寿命 | 对话 | 一个 `Round` |
| 是否持久 | **否**——它没有需要重放的状态 | **是**，`round/intent` 事件 |
| 谁读 | 持轮者 | 持轮者 + 全部子 agent |

**轮级意图是"用户要求的 agent 理解版"。** 用户给出的是他的目的，持轮者产出的是**一份可执行的理解**：它由**讨论态的持轮者在收到落地指令后总结产生**（§ 15.1.a），随后用于**预备态组装**——契约、分支、物化都从它出发。

**意图就是 `Contract.goal` 的上一层。** 契约里已经有 `goal: string`（每个子 agent 一个）；意图是**轮级的那一句**，全部契约的 `goal` 都是它的切片。因此意图不需要新形态，它就是：

```
round.goal      用户要什么（一句话）
```

**意图是一句，切分是另一份东西。** "拆成几个角色、各写哪些路径"由预备态那份草案承载（§ 15.1.a）——它比意图晚一步产生，键就是契约的键，住在保留前缀里。**把理解写出来这件事本身是承重的**：不写出来，切分就无据可依。**组织方式比篇幅重要**——落成一份可核对的东西，比让它散在上下文里可靠，而它同时是回退与放行的输入。

```
用户 ──对话──> 持轮者 ──┬─ 小任务：当场完成，不建 Round
                        └─ 大任务：定下轮级 goal 与拆分草案 ──> 子 agent
```

**意图不背着讨论。** 子 agent 拿到的前缀里没有用户对话——**对话不在它们的前缀里，意图在**。

**这是构造性的，不是取舍。** 若子 agent 从对话重建任务理解：N 个 agent 各自重建一遍（token ×N）、重建出的理解还会彼此不同（**同一任务有 N 种理解**）。这与"构造上无 N² 冲突"是同一个理由——**共享一份权威快照，而不是让 N 个消费者各自推导**。**持轮者不在这条约束之内**，它只有一个，而且它就是讨论的当事方。

**三条纪律**：

1. **讨论累积在环境里，只有投影进前缀。** 对话原文写进工作区的会话记录（走同一套视图与日志）；进持轮者前缀的只有**凝聚理解**与**凝聚前最近几次原文**。累积的是环境，可重写的是投影。
2. **意图持久化且只读。** 写入一次，进日志；此后任何人不得改写。
3. **`Planning` 之后意图冻结。** 变更意图 = 开新轮，不改在飞的轮。

**第 3 条是承重的。** 若意图在轮内可变，则 `Zone B` 在轮内不再稳定、N 个 agent 的前缀不再同步、缓存复用全部失效。**冻结 / 开新轮是唯一自洽的选择。**

**会话记录进环境，但不进任何前缀。** 它作为工作区的文件存放（§ 9.8），持轮者用普通读工具按"路径 + 第几轮"取回更早的讨论。**能查到，默认不花字数。**

**进持轮者前缀的是讨论的投影；子 agent 的前缀里一个都没有。**

> **一个在飞的轮，不需要、也不持有用户的讨论。**

**由此，上下文复杂度的界分成两种。** 对子 agent，复杂度只随轮增长，不随讨论长度增长；对持轮者，**进前缀的量由凝聚维持在一个常数级**（凝聚理解 + 凝聚前最近几次原文）——两次凝聚之间尾部只增，凝聚那一刻压回去，累积的部分在环境里。**累积不等于线性增长**——这正是"状态住在环境、上下文是投影"这条规则在讨论上的落点。

需要关于某个在飞轮的说明时，依据是轮级意图与轮次日志——两者都是派生的、可重放的。**对话与上下文由此分开两处**：对话是人机接口（§ 9.8），上下文是状态的投影。

### 15.1.a 讨论态、落地与预备态

**讨论态的接续靠三样东西**：凝聚理解 · **凝聚前最近几次原文** · 会话记录的可读坐标。**前两样进持轮者的 B 区，第三样不进前缀**——它只在需要时按坐标取回。它们保证的是**重启之后能接上话茬**——是同一个在继续这场讨论，不是新来的一个。

**问与答：人的话是这一趟的输入，答完接着走。** 两个状态都可能停在一句话上——讨论态里它要问清一件事，预备态里它要问清一处拆分（`ask_user_question`，§ 8.9 的日志那一格）。停下来之后**没有"等在那儿"的状态**：机器停 · 人说话 · 下一趟立刻带着这句话跑起来（§ 9.10 的 `fugue say`）；那句话进的是**这一趟的尾端**（C 区第一条，§ 8.11），不是某一段常驻的字节。**区别只在产物**：

| | 这一态常驻的是什么 | 那句话落哪儿 | 那一趟的产物 |
|---|---|---|---|
| **讨论态**（还没落地） | **这场对话** | 落进对话里（累积——进前缀的是它的投影，§ 15.1 纪律 1） | **修正后的凝聚理解** |
| **预备态**（在拆） | **那一份草案文件** | 落进那份草案里（改的是它） | 草案的新版本 → 重判 → **停在门口**——下一版仍然是一份可核对的清单，由人开 |

**预备态里人的话不留第二份。** 它改的就是那份草案（保留前缀 `.fugue/plan/`，§ 9.10）；原话不另存——文件里已经写着"按这句话改成了什么"，再留一份，就是第二份要与文件对齐的东西。**讨论态那份对话不是留档**：它**就是**这一态的状态，原文留在环境里按坐标取回，进前缀的是投影。

**每次重新计划是一条版本链，原版留在日志里，而进前缀的只有当下这一版。** 同一轮里每判一次草案就追加一条 `holder/distill`（**正文是全文，不是增量**），所以那一轮的草案历史就是这条链——**第 1 条是最初那一版**。它带来三件事，一件事一处：

- **原版不必另存一份。** 真源仍然只有两处（git 对象库 + `M0` 日志）；保留前缀里那一份是**当下这一版**（人那句话改的就是它），要看最初那一版就按坐标从日志取回——"能查到，默认不花字数"（§ 9.8 那一档）。
- **原版不进前缀。** 它一旦常驻，就会与凝聚理解（= 当下这一版全文）在 B 区里重复一份，而 B 区要的是**此刻成立**的值（§ 8.11 约束 3）：把已作废的版本常态化，等于让模型每步都读一遍自己改掉的方案，而且每步多付一份全文。
- **"那句话是对着哪一版说的"有据可查。** 每一条 `holder/distill` 带着**它是从哪一版改来的**（那个版本的正文指纹 `against`，§ 8.1）——于是参照物是一个**坐标**，不是第二份正文；**原话照旧不落在日志里**（上面那条"预备态里人的话不留第二份"）。

**每次重新计划都是一次独立的趟**：新进程 · 步数从 0 起 · 出口还是那道门。所以没有"增量补丁"要维护——这也是"每次重新计划"这个选择最省的地方：改的动作只发生在一份文件上，而它的历史由日志免费记着。

**子 agent 不问人。** 它手里是一份契约，问人的门在持轮者那一格——子 agent 调它只得到一句指得出出路的话（§ 8.4 纪律 2）。把子 agent 的问题转交给持轮者，排在 § 23 的 U18。

**凝聚由持轮者自己写**，进日志的形态是 `holder/distill`（§ 8.1）——它与交接提示词同类：模型写的、没有第二份来源，**所以必须在日志里**，否则重启接不上话茬。**它的触发点只有四个**：开新轮、接续、持轮者或用户显式要求整理、以及**人在讨论里说了一句话**（那一趟的产物就是修正后的理解，见上面那一段）。**其余时候凝聚不动**——前缀的字节序是缓存命中的唯一杠杆，每重写一次凝聚就作废一次缓存。显式整理因此是一次**代价明码的有意作废**。

**它有多大，两处各有一个数。** 凝聚理解那一栏的上限是 **50 000 token**：越过它是**异常**（模型把"这段理解"写成了另一篇文档），报出来、**不裁剪**——它是模型的产物，没有"拒"的对象；投影的另一半「凝聚前最近几次原文」取**最近 3 条**（§ 23 U10）。

**落地那一刻。**

| | |
|---|---|
| 触发 | 用户的显式指示（"可以开始落地了"）——**指示是人的，两条路进得来，按优先级**：① 人直接下指令（今天 `fugue round plan <目标>`，后续是界面上的指令）——**第一优先级**，它永远可用、不依赖模型认不认得出；② 人在讨论里用自然语言说了，模型**认出这句话**并调 `exit_plan_mode` 把轮次推进预备态——省一次动作，而机器不靠它 |
| 守卫 | 意图快照已建立 |
| 动作 | **总结出轮级意图**，并把凝聚理解追加到前缀尾部，重启 |
| 不保留 | 对话原文与尾端——落地之后它们不再进前缀 |
| 进入 | **预备态**：自己读文件、自己设计、自己拆分 |
| 产出 | 多个子 agent 的任务流程：**每个阶段所需文件的指针**，不是模型复述的内容 |

**追加而非重写**：前缀的字节序保持不变，缓存继续命中。

**这一脚由人踩，模型只负责认出来——门那一步为什么不这样，下面说。** 讨论 → 计划这一脚**是人的决定**：他直接下指令（第一优先级 · 永远可用），或者在讨论里说出来——后一种要模型**认出来**。而计划 → 派发那一段**步步由人决策**：门默认为停，**每一次派发都由人开**——上一批批过什么不影响这一批；模型在那儿说一百句也改变不了门。至于"人是不是准备进入下一阶段了"——那是一个意图判断，这台机器上**只有模型好判**：没有可核对的字节、退出码或状态能替它答（聊着的那几步与干着的那几步在日志里长得一模一样：都是 `prefix/assemble` + `llm/call`）。模型对这个动作的熟悉（它在计划模式末尾调它）正好用在这唯一一处只有它好判的转化上。

**"拆完了"不借工具调用表达。** 一份草案写完了没有，机器侧有另一个答案：**它停手了**（一轮工具调用之后没有后续 · `end-turn`）。于是收工那一侧不押在模型的自觉上——与这台机器别处同一条规矩：`Working → Collecting` 由 `all-stopped` 触发，`Verifying → Committed` 由退出码触发。

**落地不是不可逆的一刻，派发才是。** 预备态没有契约、没有分支、没有物化，因此**回退不需要撤销任何东西**。用户在这时说"等等，那个接口改成 X"，持轮者**就着当前进度判断哪些仍然成立**——判据是用户那句话本身，不是模型的猜测。机械回滚会把仍然成立的工作一起丢掉，所以这里要的是判断，而且它有判据。

> **这条判断推出一条硬要求：预备态的进度必须是持轮者读得到的，不能只在它脑子里。** 设计稿、拆分草案、读过的文件清单都以文件形式落在工作区里。否则回退时它只能凭记忆取舍，而记忆就是上下文——重启即失。

**草案住在保留前缀里（§ 9.10）。它变成契约集合走四步，每一步都是既有机制：**

| 步 | 动作 | 谁 |
|---|---|---|
| **拆** | 把拆分写成一个任务一节的草案文件，键就是契约的键（`kind` · `goal` · `ownedPaths` · `seed` · `deliverables` · `assertions`） | 持轮者，用普通写工具 |
| **判** | 读草案，逐字段调用值域持有者；`kind` 决定这一节该有哪几个键——**跨字段那三条与一次写入集预检也在这里跑完** | `M11` 的构造器（§ 8.12） |
| **停** | 从**判出来的那一批**渲染"要开几个任务 · 每个任务写哪些路径 · 验收标准各是什么" | 纯函数，不花模型调用 |
| **派** | 逐条授契约；契约在 `spawn` 内入库 | `M11.issue`（§ 8.12）· § 14.1 |

**判与停是同一次纯读，出口是一批契约值——还没发的那些。** 草案与身份分配器进去，一批契约值（`id` · `agent` · `branch` 都已经发下去了）加一次写入集预检出来，一次都不花模型调用。**这批值是那两个输入的纯函数**，于是"这道门只认契约集合"有一个可核对的对象：放行那一下把同一份草案重算一遍，得到的是同一批——下面那句"不重复触发"比的就是它。判不成器就停在门外：报出哪一节哪一个键，一份都不造。**配置里那一份人自己写好的拆分走的是同一段判据**（这一站的退化档，见归档 § 5.11），差别只在第一段要不要读草案：同一个函数，因此不会给出两个答案。

**草案阶段没有契约。** 契约的出生在派发那一刻（§ 14.1 第 4 步 `M11.issue`），三条路因此都是零成本的：**走** → 逐条 `M11.issue`；**把这两个任务合成一个** → 就地改那份草案；**退回讨论态** → 没有东西要撤销。

**构造器不猜、不补、不"尽力解释"。** 草案缺键或类型不对就报错退回——一旦允许补全，"哪些字段存在"就从类型退化成了构造器的善意（§ 8.12）。

**拆分不需要新工具。** 结构化调用保证的是语法；而写入集相交（D6）、`actionOutputs` 落在 `ownedPaths` 之内、`seed` 超限拒绝派发——这三条都不是语法，它们本来就在构造器里。多一个工具的代价却是永久的：工具 schema 属于前缀，而拆分每轮只发生一次。

**"写哪儿 · 什么形状"是输入的一部分，不是模型要猜的。** 持轮者那一趟的「工作总目标」那一段**末尾**拼着这一趟的产物，五样都说清：**写哪儿**（`.fugue/plan/<轮次>.md`，§ 9.10 的保留前缀）· **什么形状**（一个任务一节 · 每节一个标 `json` 的围栏块 · 每一节按它的 `kind` 给哪几个键、每个键的值写成什么样）· **跨节的次序**（最多一节调查型，而且它排在第一节）· **跨节的独立性**（每一节都是独立的一格：N 条分支都定在同一个底上，跑的时候**看不见别节的产物**——调查型那一节交的证据也不进这一轮的工作树；所以一节要用的东西只能来自底上**就已经有的**那几条 `seed`，或者由持轮者把结论直接写进那一节的 `goal` / `deliverables`）· **`assertions` 里那个 `action` 只能从工作区绑好的动作里挑**（§ 8.12 那条跨字段关系）。五样里有三样是**机器知道、模型无从得知**的事实，而且是从别的判据那一份**念**出来的：键从草案的键域那一份念（`DRAFT_FIELDS`）· 形状从值域持有者那一份念（`FIELD_RULES`）· 绑好的动作名从工作区配置念——于是提示词与判据漂移不了。位置在末尾是有意的：那是这一趟里模型读到的最后一处（预备态那一趟 C 区是空的），而"要什么产物"本来就是意图的一部分。**讨论态那一趟不给它**——那一趟的产物是那场对话的凝聚，不落文件。

**这一格的收工口径也拼在这一处**：这一格最多几步（`--max-steps` 给的那个数）· 这一格有没有可执行的树（预备态不物化，`bash` 与 `run_action` 试也不会通）。它与"写哪儿 · 什么形状"是同一档——**模型无从得知、而这一趟非知道不可**；位置同理：近因那一处仍然留给产物说明，收工口径排在它之前。持轮者的 B 区里没有「我的任务」那一段（§ 8.11），子 agent 那一份靠那一段带的两样（"这一格最多几步" · "断言由 harness 跑"）因此在这一趟要另找落点：同一个末尾，同一档稳定性。**"这一格没有可执行的树"与"断言由 harness 跑"是同一件事的两面**——区别只在那一格伸不伸得出手，而拒绝那一句是伸手之后才到的、一步一句：它必须事先在。缺了它的症状不是报错，是那一趟把预算花在同一条拒绝上（归档 § 5.10 的 `C1.d`）。**而拒的那一句本身也要指得出两截路**：换成哪几条工具，以及**这一趟欠着什么**（那一份产物的路径）。它落在**工具结果**上而不是别处——C 区那条尾巴只追加，所以这一句加在自己那一步的尾巴上，前缀一个字节都不动；real 组量到过一次"伸手被拒之后就再没回到产物上"的走法（连着两次撞 `bash`，接着四步全在 `glob` / `read` 里找方向，草案一个字节都没写）。

**收工口径有三面，三面读的是同一个数。** 先说在前面（这一格最多几步 · 这一趟欠着什么，每趟一次）· 伸手被拒时再说（一步一句）· **快用完时说**——剩三步以内，每一步的回执末尾多一句"还剩几步 · 先把那份草案写出来"，同样落在工具结果上，同样不动前缀一个字节。第三面挂在**持轮者那一格自己的壳**上（`holderFace`），读的就是运行时停下来用的那个数；**不许照 `AssembleState.maxSteps` 读**：那一栏是"写进「我的任务」的那个数"，而持轮者的 B 区里没有那一段（§ 8.11），照它读这一句在 real 组里永远是空话（量到过：八步那一趟的请求里一个"还剩"都没有，而手搭句柄的单测是绿的——"断言在位上"不等于"接线在位上"）。

**错路走不通，而且被指着说出来。** 持轮者那一趟的**写入面**只有保留前缀那一棵（§ 15.4"权限差别只能落在输入与作用域上"）：`write` · `edit` 写到别处**在派发那一层当场拒**，拒的话就是最短的那句指示（准确路径 + 形状 + 这一串为什么不算），并落一条 `bound/deny`。`exit_plan_mode` 自报的那条路径必须**就是**这一趟那一份——路径只有一个来源，那一栏是核对，不是第二个真源；草案成不成仍然只由键域与值域判（§ 8.12）。

**预备态的出口是一道默认为停的门。**

| | |
|---|---|
| 何时 | **契约集合发生变化后的首次派发** |
| 呈现 | 按模板渲染的清单：要开几个任务 · 每个任务写哪些路径 · 验收标准各是什么。渲染是纯函数，不花模型调用；只有"为什么这么拆"那一句由模型写 |
| 默认 | **停** |
| 放行 | **人点一次头，派发一批。** 一次点头只兑现这一次派发的那一批——它后面的各次执行（打回 · 重新委派 · 自重启）都还在这一批之内，不再问；而**新的一批一律重停**，哪怕与上一批同一个编号 |

**默认停之所以合理，是因为它只在需要拆分的任务上触发。** 小任务在讨论态当场做完，根本不经过这道门。**门槛设在少发的事情上，才是免费的。**

**停下来之后有三条路：**

| 用户说 | 走哪条 |
|---|---|
| 走 | 派发 |
| 把这两个任务合成一个 | **就地改拆分**（`fugue say <一句话>`，§ 9.10），留在预备态，门再停一次 |
| 等等，我要的是 X | **退回讨论态**——需求变了 |

> **需求变了才退回讨论；只是拆法变了，就地改。**

**放行与退回都发生在讨论里。** 门是给人看的，放行是人说的一句话；持轮者据此发出契约，转移照常进日志（`round/state`）。**门这一步没有模型侧的动作**：开与不开都在人——`exit_plan_mode` 是"落地那一刻"那一段的事（它把人那句指示认下来，把轮次推进预备态），而"拆完了"由它停手（`end-turn`）表达。退回同理：需求变了，人说出来，持轮者把轮次放回讨论态（§ 8.13 的 `Idle`）。**人的判断落在讨论里，讨论落在会话记录里（§ 9.8），状态落在日志里。**

**这道门只认这一批契约。** 重新委派与自重启都发生在同一个契约集合之内，因此**不重复触发**——用户批准的是这一批活，不是它后面的每一次执行。而**新的一批一律重停**：下一个轮次、退回讨论态之后再拆、就地改拆分之后再改回来，**哪怕与上一批逐字相同**，也照样停在门口等人点头。**长得像不算放行过的凭证**：一批活放行过没有，记在"这一批"身上（`round/approve` 那一笔带着这一批的编号与那几份契约），不是记在"它长什么样"上——编号相同也不是，因为编号只是给人看的一个名字。

**预备态就是 `Planning`。** 它在状态机里不是新状态：落地是 `Idle → Planning` 的转移，回退是它的逆边。

### 15.2 小任务的通路

**不建 `Round` 不等于不进环境。** 持轮者当场完成的小任务，通路是完整的，缺的只是编排：

| 环节 | 小任务 | 大任务 |
|---|---|---|
| 视图 | 持轮者自己的视图 | 每个 agent 一份 |
| 执行 | 走 `M5` + `M6`，与子 agent 同一机制 | 同 |
| 落盘 | **写进视图并提交** | 同 |
| 日志 | `view/*` · `ckpt/commit` | 同 |
| 契约与合并 | **没有** | 有 |

**小任务不进组装，但它照样落盘。** 视图与日志是一切写入的必经之路，无论有没有契约。缺少的只是"把 N 个分支合并起来"这一步——而单写者根本不需要合并。

因此**没有绕过环境的路径**：两种粒度走同一套视图、日志、提交，只是小任务不进入 `M11`/`M13`。**规则 1 在两种粒度下都成立。**

**持轮者也可以派子 agent 做小任务**，那只是提前使用了 `spawn`（§ 14.1）。判据不是"任务大小"，是**是否需要并行与合并**：要，就开轮；不要，当场做完或派一个帮手。

### 15.3 宿主：工作区级的不变共享值

**宿主只装工作区级的东西**——它的判据是 H2：寿命 = 工作区。

| 宿主 | 唯一性来源 | 寿命 |
|---|---|---|
| `mainRef` | git | 工作区 |
| `realRoot` | 文件系统 | 工作区 |
| `<realRoot>/.fugue/` | 文件系统 | 工作区 |
| 常量源（工具目录 · 代码树 · 保留前缀） | 派生自真源的函数 | 工作区 |
| **项目方针**（`<realRoot>/AGENTS.md`） | **人所写**，不在视图里（§ 9.9） | 工作区 |
| `Round` | 合并是单写者 + 真实树冻结 | 工作区（同时至多一个） |

**配置不在这张表里，因为 H2 把它挡在外面：它的寿命是机器，不是工作区。** 它住在宿主之上的一层（§ 15.3.a），而它同时是"模型不可代替配置"这条纪律的落点——模型看不到配置本身，只看到它的投影，所以**那件事是结构性的，不是策略性的**（§ 24 纪律 13）。

**轮级意图不属于宿主，因为它的寿命是一个 `Round`，不是工作区。** 把轮级的东西放进工作区级，就是让一份状态活过它的有效期——规则 1 要防的正是这件事。

### 15.3.a 系统级：宿主之上的一层

**判据是同一个 H2 换了范围（§ 11）：寿命 = 机器。** 宿主装工作区自己的一切；系统级装**全部工作区共用**的那一份。

| 系统级 | 内容 | 谁写 |
|---|---|---|
| **配置** | 能跑什么（工具链 · 已装的包）· **动作名与白名单** · 凭据 · 平台事实 · 网络与搜索的边界 | 人 |
| **系统根** | 机器自己的 `.fugue/`——系统级配置与它的改动记录住在这里，三个入口都写它（下） | 系统 |
| **系统内置体** | 小助手（§ 15.3.b） | 系统 |

**配置按寿命分两级。**

| | 系统级 | 工作区级 |
|---|---|---|
| 装什么 | 装了什么 · 凭据 · 平台事实 · **动作名与白名单** · 暴露面 | **动作绑定与每个动作的 `outputs`** · `deliverables` · `assertions` · 文档定义（§ 9.9） |
| 寿命 | 机器 | 工作区 |

**工作区级那一份里，动作绑定的形状**（S4 定的，§ 8.6 那三步读它）：

```json
{
  "actions": {
    "build": { "argv": ["make", "-C", "src"], "doc": "构建整个应用", "cwd": "src", "outputs": ["dist/app"], "cache": ["dist"], "env": { "CC": "cc" } },
    "test":  { "argv": ["node", "--test"] },
    "fetch": { "argv": ["npm", "ci"], "net": "host" }
  },
  "ports": { "range": "31000-31099" },
  "boundary": {
    "reach": ["/usr", "/opt", "/etc/ld.so.cache", "/etc/ssl", "/etc/alternatives", "/etc/resolv.conf"],
    "env": { "inherit": "core" },
    "enforcement": "full"
  }
}
```

- `argv` 是那个动作要跑的命令行（非空）；`cwd` 是视图内的相对路径，缺省是视图的根。
- `net` 是**这个动作要不要网**（缺省 `"none"`）：沙箱缺省把网络切掉（§ 8.8），要出网的动作在这里点名；点名之后 `fugue policy <动作>` 与那一趟的 `run/confined` 都如实报 `host`。
- `boundary.reach` 是这一份工作区的**只读根清单**（绝对路径数组，人写）：子进程够得着的宿主路径就这几条加 `/work` 那棵树（`/proc` 与 `/dev` 是设备与进程那一份，不必写）；不给就是探针量出来的缺省值（§ 8.8 的 `reach`）。
- `boundary.env` 是**环境基线**（缺省 `{ "inherit": "core" }`，§ 14.4）：`core` 只递定位那几样 · `all` 宿主整份（退化档）· `none` 空；`set` 静态注入（坐标那六样不许出现在这里，撞上拒绝并指路）· `exclude` 剔除 · `include_only` 窄化。
- `boundary.enforcement` 是**期望档**（`"full"` | `"partial"`，缺省不声明）：声明 `full` 而实测层不齐 → 起跑前拒并指两条出路；不声明 = 照跑照实报（§ 8.8）。
- **`outputs` 与 `cache` 是两件事。** `outputs` 要回写视图（§ 8.7 的回收读它）；`cache` 绑到本 agent 的缓存、**不回写**——构建产物落这里。这一处分开是设计预期里唯一要紧的取舍：架构 § 8.7 明说构建产物不回收，而 `run_action` 的产出要回收，两者靠"声明在哪个键里"分开，比在运行模式里加开关干净。一条声明在树里是一条目录、还是落在缓存里的一个文件，由"有没有被另一条声明盖住"决定（§ 8.7 那一段）。
- `env` 是那个动作自己的环境变量；**`HOME` · `TMPDIR` · `XDG_CACHE_HOME` · `PATH` · `PORT` · `PORTS` 不许出现在这里**（它们是本 agent 的坐标，§ 8.6）。
- `ports.range` 是这台工作区的端口池；一个 agent 拿 4 个号，`PORT` 与 `PORTS` 就是那一片。

**两级都落了（`P2a`）**：系统级 `~/.fugue/config` 打底，工作区级（`<realRoot>/.fugue/config`，§ 9.2）覆盖——叠放次序 CLI > 工作区 > 系统 > 内置。合并只在**读**（深合并：对象递归，数组与标量整份覆盖，工作区赢）；**写永远落目标那一级**（`config set` 写工作区 · `config set --system` 写系统），写方走**单级读**——不然一次工作区写会把系统级的键抄底固化进工作区文件。**顶层键域是闭的**（`actions · ports · boundary · platform · round · config · docs · workspace · credentials · toolchain · ui`）：拼错的顶层键会被静默读成"没配"，那比报错危险——所以未知顶层键在**读面拒绝加载并指路、写面先拦**，两级各自核；新的顶层键先进这张表再进代码（`P3a` 的 `toolchain` 就是这么进的）。**`credentials` 是凭据的引用表（`P2c`）**：`credentials.<provider>` 的值是引用（环境变量名 · 文件路径，顺序承重），不是凭据本身——取值只在真出网那一步，哪级都没配就拒并指路（去处就是 `config set --system`）；`--credential` 旗标是临时覆盖，只换"文件在哪"那一条。**`toolchain` 是工具链的声明与探测读数（`P3a`）**：`toolchain.<名字> = { probe, doc? }`——`probe` 是探测命令的 argv，声明可两级；读数 `toolchain.<名字>.reading = { probe, value }` **只写工作区级**（写方单级读，防抄底），在物化两入口（`ensure`/`fork`）补——`probe` 与声明逐项相同且 `value` 非 null 才算命中，失败写 null 且**永不命中**（失败重探，前缀那一边如实缺席）。`fork` 那一档是惰性的（格内首次起进程才挂），而 A 区的系统状态在轮起头就拍了值，于是 `round run` 直跑的第一轮，读数进不了本轮 A 区——下一轮的轮边界才进（P3c real 组两趟都量到；`ensure` 入口要先有物化树才跑得到探测）。缓存的第一理由是**前缀稳定**：读数要进系统状态的投影（§ 8.11，`P3b`），不缓存则前缀字节随探针输出漂；探测命令只可能出自人写的配置（模型没有写它的路），执行走 `mount` 那一层共用的跑手。**不进 doctor**。

**`models.json` 是模型目录（`P2d`）——接一个模型从此是数据改动，不是代码改动。** 它住系统根（与 config 同一个家，`FUGUE_SYSTEM_DIR` 同一条换法），顶层是提供方映射直接铺：每家 `{ host, wireOverrides, retries, models, prices }`，模型与价目内嵌在提供方那一层（**一张表，不是三张**；`wireOverrides` 与 `retries` 两栏在 d 已冻结，e/f 只是消费端）。**文件不在 → 内置档顶上（`contract.ts` 的两份常量与 `price.ts` 的 `PRICE_BOOK`，同一个对象）；文件在 → 它就是整份目录，不与内置合并**——合并出来的"半内置半文件"没有一处说得清自己。模型条目不写 `provider`（嵌套即声明）也不写 `id`（键就是）；`budget.handoffMargin` 没有缺省（缺了载入那一行就响），`trigger` 是唯一缺省（由 `triggerAt(contextLimit)` 算，人不该手抄派生数）；`call` 不写就是"不设温度与上限参数"那一档（与 `DEFAULT_CALL` 同形——anthropic 线有 4096 兜底常数、openai 线省字段）。载入核对只做五条——线协议已知 · 提供方存在 · 协议名存在 · 更新方式两档 · 价目命中（核的是**发出去的名字**：我们的键先折到 `model` 那一栏再查价目）——逐条报完再拒；明确不加版本字段 · auth 槽（凭据只住 `credentials` 键，P2c 定的界）· 迁移逻辑。**读旧账的钱**：目录收窄之后，旧日志里那个键不在目录里 → 价目查不到 → 钱那一行说"算不出来"（不拿 0 顶）；要让旧账算得出钱，价目那一行的 `aliases` 收它的名字。

**三个入口，一份真源。**

| 入口 | 管什么 |
|---|---|
| **配置文件** | 直接可编辑。除"装外部编译器"之外的一切 |
| **界面** | 大部分配置——它是**文档系统的一份产物**（§ 9.9），不是新子系统 |
| **系统内置体** | **文件改不了的那部分**：装 · 搜 · 改这台机器的系统设置（§ 15.3.b） |

三者写的是**同一份状态**，因此真源只有一份，回滚对三个入口一致。**原值记录已落**（`P2a`）：`config-history`——每次改动一行 JSONL `{at, key, old, new}`，与目标级 config 同目录，两级各记各的；`old` 只在键原本存在时出现。可查，也能手工回；自动生成逆操作是 T5。

**两级配置都住在模型够不到的地方**：系统级的在机器上（`~/.fugue/`），工作区级的在 `<realRoot>/.fugue/config`（§ 9.2）——后者在真实工作树里，但**不在视图里**，模型的文件工具与沙箱都到不了。**这就是纪律 13 的"没有路"在实现上的形态。**

**配置对本工作区的投影就是 Zone A 的「系统状态」段**（§ 8.11）。配置变一次，那一段就变，本轮全部缓存作废——这是"配置改动只落在轮边界、且要一次重启"的机制来源。投影的形状（`P3b2` 拍平）：`{ platform?, workspace?, net?, ports?, docs?, actions?, toolchain? }`，在场才出现；`actions` 与 `toolchain` 是两串**按 name 排序**的清单（稳定序列化只排对象的键，数组的次序得自己排）——动作每行 `{ name, argv, doc?, outputs? }`，**绑定的 `env` 值不投影**（凭据与配置值走引用不走来，进了这一栏就同时进夹具与日志）；工具链每行 `{ name, probe, doc?, reading? }`，`reading` 只在缓存那条 probe 与声明逐项相同时带上。**动作清单只此一份**：模型读的就是系统状态这一份（`run_action` 的描述与草案那一句都指到这里），不在提示词里另注一份。

**纪律 12 因此要读准**：工作区自足，指的是**工作区自己的状态全在工作区里**。配置与常量源不是工作区的状态，它们是它的**输入**——搬到另一台机器，带的是那台机器的配置，不是工作区的历史。

### 15.3.b 系统内置体

**它不属于任何工作区**：没有工作区身份 · 没有分支 · 没有契约 · 不进任何工作区的日志 · 不由持轮者派。§ 15.6 那张图里它不在任何一档之下——它是**系统级**的。

**它由一条系统级命令拉起**——与工作区无关，所以不在 § 9.6 那张分组表里：`fugue system <请求>`。不开视图、不建分支、不读任何工作区的日志；它拿到的是写死的提示词与配置的投影。

**它是写死的**：提示词写死，工具与能力范围写死。因此它的 **Zone A 恒定**——写死的提示词与工具目录永不变，前缀里最贵的那一段永远逐字节相同，**这是全系统唯一一个共享头恒定的 agent**。写死也让它**不需要契约**：契约管的是"这一次写到哪儿"，而它的写入面是预先写死的常量。这跟其余 agent 是同一个问题的两种答案——**动态声明 vs 静态写死**；任务形态固定时，静态那份省掉构造契约 · 写入集相交预检 · 分支 · 合并 · 验收门这一整串。

**它是权限最大的那一个。** 必须允许它**装**、**搜**、**改这台机器的系统设置**，所以"别把系统改挂"不能靠把面做小来保证——**写死的是面，不是把面缩小**。它靠三样兜：**写死的提示词**（要求它优先可逆动作）· **每次改动记原值**（可查可回）· **醒目的风险提示**。

**风险提示是形状，不是文案。** 它是配置界面那份文档的定义提示词的一部分——每次改动都渲染出"这一改让验收更严还是更松 · 原值是什么 · 怎么回"。**写成形状就漏不掉，写成文案就会忘。**

**用完即丢。** 它的产物是它自己的回复，而模型自己生成的文本不进日志（§ 10.4 纪律 1）。所以它不留档：**申请是给人看的一句话，人应用了才算数；真正需要审计的是配置改动本身，而那本来就有记录。**

**它的根是机器，不是仓库。** 写入面由人给的策略值决定（§ 8.8 的 `writableRoots`；`Policy` 是传进强制点的值，不是宿主全局）。它改的是**这台机器的系统设置**（PATH · 环境 · 装了什么），**不是 Fugue 的配置**——后者只从人那里来（§ 15.3.a）。它看到的是配置的**投影**，看不到配置本身——这正是纪律 13 在它身上最硬的形态：**一个专门来碰这台机器的 agent，恰恰是够不到配置的那一个。**

**系统内置体是一个 agent，所以要等模型接上**（§ 20 的 S8）：提示词与工具面写死，模型进来它就跑得起来；T8 是它面向非技术用户的那一版。

### 15.4 单例的是宿主，不是主 agent

依据推论 2：

> **推论 2**：在同一个 Harness 框架下、且环境一致时，给定上下文就能立刻重建一个 Agent 状态。

主 agent 的状态同样住在环境里、同样是一份投影。**把它设成单例等于在它身上藏状态，违反规则 1。**

> **主 agent 是"轮次的持有者"（round holder），可替换。**

**持轮者与子 agent 是同一种东西。** 两者都是 `环境 + 上下文 + 模型`，都接受组装器给的输入。差别只有三处，且都是输入：

| | 持轮者 | 子 agent |
|---|---|---|
| Zone B 的内容 | **凝聚理解 + 凝聚前最近几次原文**（§ 8.11） | **工作总目标 + 文件内容 + 提交序列 + 交接提示词 + 我的任务**（§ 8.11） |
| 轮级状态机的句柄 | **有** | 无 |
| 生命周期 | 跨轮（`Idle` 也在） | 轮内 |

> **持轮者不是"更强的 agent"，是"持有轮级状态机句柄的 agent"。**

**这条不能体现为额外的工具。** § 8.11 要求 Zone A（含工具目录）在**N 个分支与持轮者之间逐字节相同**；持轮者多一个工具，共享头就没了，每次重组都要付全额。所以权限的差别只能落在**输入**上：同一个工具在不同作用域下行为不同。

**拆分是持轮者的特权，判据不是"强弱"，是句柄**：只有它持有轮级状态机的句柄，因此只有它能产出契约、推动 `Planning → Delegated`。子 agent 是执行态——做完一件事就上报，不新增契约，也不改变契约集合。

### 15.5 三条结论

1. **主 agent 可被 fork。** 上下文过长 → 由同一份环境状态重建一个新的持轮者。
2. **一个工作区可以有多个主 agent 会话**，串行持轮——`Round` 的单例性提供串行保证，而不需要主 agent 单例。
3. **主 agent 的会话连续性属于 UX 层，不属于架构约束。** 用户与某个会话的关系需要延续，这是产品需求，不是唯一性需求。

### 15.6 四档的完整图景

```
系统级 System（单例，生命周期 = 机器）—— 跨全部工作区
  ├─ 配置（能跑什么 · 装了什么 · 凭据 · 平台事实 · 动作白名单）
  ├─ 系统根：机器自己的 .fugue/（配置）
  └─ 系统内置体（提示词与工具写死 · Zone A 恒定 · 用完即丢）

宿主 Host（单例，生命周期 = 工作区）
  ├─ mainRef · realRoot · 常量源（工具目录 · 代码树 · 保留前缀）· 项目方针
  └─ Round（同一时刻至多一个）
       ├─ 轮级意图（建立后冻结，随轮生死）
       └─ RoundHolder = 持轮者（可替换）
            └─ SubAgent × N（每轮生死）

装配体 Kit（无状态，只接线，不引入新机制）
  spawn · runtime · signalBus · envRealize · mergeKit · verifyGate

核 Core（纯，零领域耦合，接口冻结）
  M2 view · M3 roots · M4 materialize · M10 assemble
```

**这张图本身就是一条设计判据**：拿到任何一个新东西，先问它属于哪一档。**四档都不是，说明它还没有被想清楚。**

### 15.7 运行环境契约

宿主不是抽象平台，是一台具体机器。架构对它有六项要求，每项都有可观测的违反代价。

| # | 要求 | 违反的可观测代价 |
|---|---|---|
| **E1** | 原生 Linux 文件系统承载 `realRoot` | git 预算从 700–1000 次/轮掉到 13–40；文件操作慢 22–282×（下表四行的极差） |
| **E2** | `overlayfs` 可挂载 | `M4` 的 fork 从 O(1) 退回 O(文件数)；变更集从枚举退回 diff |
| **E3** | 非特权用户命名空间 | E2 的前提；`M7` 失去强制点 |
| **E4** | `bwrap` | D1 从结构性成立退回策略性成立 |
| **E5** | `Landlock` | 少一层纵深，`enforcement` 如实降级 |
| **E6** | git ≥ 2.38 | `merge-tree --write-tree` 不可用，`M1.mergeTree` 无实现 |

**E1 的证据。** 四个位置的同一份基准（同一运行时、同一份代码、2000 个小文件）：

| 配置 | create | hardlink | replace | git plumbing |
|---|---|---|---|---|
| **ext4**（Linux / WSL 原生） | **0.011 ms/文件** | ✅ | 0.038 ms/文件 | **1.0–1.5 ms/次** |
| Windows 原生（NTFS） | 0.36 ms/文件 | ✅ | 0.83 ms/文件 | **53–80 ms/次** |
| 正向 9p（WSL → `/mnt/c`） | 3.10 ms/文件 | ✅ | 8.72 ms/文件 | 24–55 ms/次 |
| 反向 9p（Windows → `\\wsl.localhost`） | 1.31 ms/文件 | **❌ 不支持** | 3.96 ms/文件 | — |

差距是**两段叠加**的（看 `create` 与 `replace` 两列）：Windows 原生比 ext4 慢 22–33×，从 Windows 原生再跨一道 9p 边界慢 8.6–10.5×。**git plumbing 那一列的账要另算**：正向 9p 的 24–55 ms 快过 Windows 原生的 53–80 ms，因为那一列的代价几乎全在进程创建，而进程创建发生在 WSL 一侧。三项可观测后果：

- **git 调用的预算**（§ 17 的触发条件）。ext4 约 **700–1000 次/轮**；drvfs 约 20–40；**Windows 原生只有 13–19**——因为 `git.exe` 的进程创建在 Windows 上是 50 ms 量级，而 `rev-parse`（几乎不做任何工作）与 `hash-object -w` 的耗时几乎相同，说明代价全在启动。
- **硬链接**。反向 9p 完全不支持，pnpm 的硬链接存储在那里退化为逐文件拷贝。
- **mtime 分辨率**。NTFS 上连续两次写可以拿到**完全相同**的 mtime，使 `mtime-size` 这类变更检测在那里不安全（§ 8.5）。

> 这不是速度问题，是机制问题：跨越 9p 边界不是访问文件系统，是一次跨内核的 RPC。

**推论：分裂配置最差。** Windows 侧跑前端、工作区放 WSL，落在上表的第三、四行；把工作区放 `C:\` 而工具链在 WSL 里，落在第三行。**两侧都必须在同一边。**

**E2、E3 的证据。** `overlayfs` 在非特权用户命名空间内可挂载。它是 `M4` 的 fork 机制，并把变更集变成免费项（§ 8.5）——`upper` 目录恰好是本次的全部改动。

`reflink` 在 ext4 与 drvfs 上都不存在（FICLONE 需要 XFS、Btrfs 或 APFS），所以 fork 的 O(1) 落在 `overlayfs` 上，不落在 `reflink` 上。

**overlayfs 的 copy-up 约 50 ms/文件，且与存储介质无关：**

| lower / upper | 每文件 copy-up |
|---|---|
| ext4 / ext4 | 52.8 ms |
| ext4 / tmpfs | 56.0 ms |
| tmpfs / tmpfs | 48.3 ms |
| tmpfs / ext4 | 49.3 ms |

全内存组合同样慢，故与虚拟磁盘存储栈无关。时间全部落在一次 `openat(O_WRONLY\|O_CREAT\|O_APPEND)` 内，且 100 次累计 `real 5.918 s / user 0.000 s / sys 0.036 s`——**99.4% 是阻塞等待**。10 MB 文件单次 copy-up 为 146 ms，即约 56 ms 固定 + 9 ms/MB。同一文件 copy-up 完成后再写，降到 0.01 ms。`O_TRUNC` 打开则只要 0.07 ms，因为截断路径无需搬运数据。

对照：**不经 overlay 的普通 ext4 与 tmpfs 目录写入均为约 1.5 ms/文件**——这是**写入一个带内容的文件**的口径，与 § 15.7 表中 `create` 列（建一个空文件，0.011 ms/文件）不是同一个口径，两者不可直接相减。

**E4、E5 的证据。** `bwrap` 的 mount 围栏是主层：树那一条按档选（`read-only` 档 `--ro-bind` · `workspace-write` 档 `--bind`），声明目录另绑一条可写的。实测——原地改源文件、树内新建、删除、**写工作区外**四项全部被拒，而声明路径可写；**树可写那一档同一张表照样量**：树以内可写（甲四条 + 乙三条通），树以外十二条（丙六 + 丁六）一条都够不着。`Landlock` 是第二层，内核 ABI 7：**主层不在时它仍然把"写得动什么"那一维关上**——同一趟里未声明的写入当场拒（`cannot create junk.txt: Permission denied`）、声明目录照写、产物照回收；两层都不在时同一趟真写得进树里（`undeclared: ['junk.txt']`，X4 的读数原样）。

**对接点是既有的。** 环境的实际能力经两处落地：**探针报出的平台事实落在配置里**（§ 15.3.a），`Policy.enforcement`（`full` / `partial`）报的是**供给**；而能力表报的是**要求**（落在执行层就要关沙箱，§ 8.9）。**要求与供给分居两处，对上才算数。**两处都已存在，因此**不新增环境抽象层**——在只有一个实现的地方先造接口，是一次修正要付两次钱。

**探针是一个纯函数。** 它读环境、返回能力报告，不改变状态、不写日志。两条实现要求：

- **`Landlock` 用系统调用探测**：`landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)` 给出 ABI 版本。WSL 中 `securityfs` 未挂载，`/sys/kernel/security/lsm` 不可读，按文件探测会得到假阴性，使能力报告误报缺失。
- **`realRoot` 的文件系统类型必须探**：落在 `9p` / `drvfs` 上时拒绝启动，而不是降级运行——因为失败模式是静默的。

**结论分两档，不是一律 fail-closed。**

| 类别 | 项 | 策略 |
|---|---|---|
| **硬要求** | E1 · E3 · E6 | 不满足即**拒绝启动** |
| **降级项** | E2 · E4 · E5 | 不满足则降级运行并如实报告：E2 使 fork 退回 O(文件数)、变更集退回 diff（§ 15.8 的部分档）；E4 · E5 报 `enforcement: 'partial'` |

硬要求之所以硬，是因为它们的降级不是变慢，而是**某条不变量不再成立**：E1 破坏 `M1` 的调用预算，E6 使 `M1.mergeTree` 没有实现。**E2 与 E3 是同一件事的两端**——没有非特权用户命名空间，`overlayfs` 挂不上，于是 fork 与变更集双双退化；同一个缺失也让 `M7` 失去强制点。前者的代价是常数因子，后者是不变量，两者因此分居两档。降级项失去的是纵深与常数因子，不是不变量。

**分档与探针的策略必须一致**，否则会误拒（把本可降级运行的拒掉）或误放（把静默退化的放进来）。

### 15.8 平台分档

**分档是能力分档，不是性能分档。**

| 档 | 宿主 | E1–E6 | 结果 |
|---|---|---|---|
| **一等** | Linux 原生 / WSL2，工作区在 ext4 | 全满足 | 全部机制 |
| **部分** | macOS / APFS | E2 不满足（无 overlayfs） | fork 走 `copy` / `hardlink-ro`，`clonefile` 补上 fork 的 O(1)；变更集退回 diff；`enforcement: 'partial'` |
| **不成立** | Windows 原生 | E1 E2 E3 E4 不满足 | 13–19 次 git 调用/轮 |

**分档判的是不变量，不是机制名。** 表里的能力名是 Linux 一侧的兑现方式：真源要落在一块原生的本地文件系统上（不是 9p / drvfs 那种跨内核的 RPC）· 边界要有强制点 · 合并要有一份能用的实现。macOS 一侧用系统沙箱（`Seatbelt`）与克隆文件（`clonefile`）兑现同样这几条，因此它落在部分档——能跑，代价是纵深与常数因子。

**服务面是一等档。** 六项在那里全部实测通过，平台分支消失，没有第二套实现；其余档各要 `M4` 与 `M6` 的一套第二实现——不是配置开关。

#### 以 Linux / WSL 原生为模板

三条理由，按分量排序：

1. **E1–E6 在该平台上全部实测通过**，没有未知行为。
2. **平台分支消失。** `M7` 只有 `enforcement: 'full'` 一条路；`M3` 的逃逸用例集不含 UNC、`\\?\`、盘符与大小写不敏感；`M4` 在这一档上走 `overlayfs` 与 `copy` 两条路径。
3. **`M1` 的预算 700–1000 次/轮由 TS + git CLI 兑现**；`gix` 路径属于内核原生迁移（T7）。

**Windows 只以 `M4` 的一种物化落点出现**（T6）：它不进宿主，也不进其余任何内核模块。

#### WSL 上的一条宿主事实

实测：发行版在**最后一个进程退出后 30 秒内**即被自行关闭（t=0 启动，t=30 s 已不在运行列表，t=75 s 仍未起），重新拉起需 **1,974 ms**。

因此"进程环境被拆掉重建"在一等档的宿主上是**默认路径**，不是边界情况——两次用户交互之间它就是关着的。两个后果：

1. **安装脚本钉住发行版。** 否则停顿超过 30 秒后的每条交互命令都付 2 秒冷启动。
2. **这印证了"每条命令重建状态"是正确默认。** 冷启动只加 2 秒，不丢任何东西——因为状态本来就在日志里，而不在进程里。

进程重启因此是**正常操作**，与 § 15.5 的"持轮者可替换"是同一件事：上下文过长时由同一份环境状态重建一个新的持轮者，与宿主把进程拆掉再拉起，走的是**同一条路径**。

---

# 第五部分 · 演进

## 16. 语言分配原则

三条原则，按优先级：

| # | 原则 | 含义 |
|---|---|---|
| **L1** | **先换机制，再换语言** | 数量级差别来自算法与机制；常数因子差别才来自语言。顺序不可反 |
| **L2** | **语言边界 = 分层边界** | 内核可原生，面与编排留 TS。因为「内核不认识模型，面不认识 git」 |
| **L3** | **触发条件是测量出来的** | 不预设热点。先测，再迁 |

**L1 的三个具体表现**（都不靠语言解决）：
- delta 若不精确 → 每次 `ensure` 都是 O(工作区)。**这是算法，不是速度。**
- N 份物化若靠复制 → 磁盘与时间都按 N 倍增长。换 `overlayfs` 即消除，不需要更快的语言。**这是机制，不是速度。**
- 执行隔离若靠约定而非强制 → 跨 agent 污染。**这是设计，不是速度。**

## 17. Rust 演进路径

| 模块 | 当前 | **演进触发条件（可观测）** | 演进方式 | 前提 |
|---|---|---|---|---|
| `M1 truth` | TS + git CLI | 每轮 git 调用次数 × 单次开销超过 1 s——**实测基线 1.0–1.5 ms/次，故约 700–1000 次/轮** | `gix`（gitoxide）经 napi-rs | `RefName` / `BlobId` / `TreeId` 冻结 |
| `M4 materialize` | TS `fs` + overlayfs | **不演进**：fork 已 O(1)（3–5 ms），delta 落地 1.67 ms/文件，两项都已低于可见延迟 | — | — |
| `M2 view` | TS Map | `grep` 走视图侧的单次耗时进入可见延迟 | Rust + `ignore` crate | `Delta` 冻结 |
| `M3 roots` | TS 路径运算 | fs 调用次数 × 单次耗时可见 | Rust（纯函数，迁移最轻） | `Roots` 冻结 |
| `M5 execute` | `node:child_process` | 进程管理开销进入可见延迟 | Rust + tokio | `ConfinedArgv` 冻结 |
| `M6 reclaim` | 枚举 `upper` | **不演进**：枚举而非 diff，代价与改动数成正比 | — | — |
| `M7 policy` | TS + 原生 runner | 沙箱部分已原生 | — | — |
| `M10 assemble` | **TS** | **不演进**（冷路径） | — | — |

**演进顺序**：`M1 → M2 → M3 → M5`。**`M1` 排第一**——它的收益最确定，也不依赖其他模块。

实测：ext4 上单次 plumbing 调用 **1.0–1.5 ms**（§ 8.2 的同一组基线），其中绝大部分是进程创建——**`rev-parse` 与 `cat-file blob` 的耗时几乎相同（0.99 ms 对 1.06 ms）**：前者只解析一个 ref，后者要把一个对象真正读出来，工作量差得远，耗时却一致。代价因此不在做的工作上，而在**启动一个进程**。一个 agent 一轮写数百个文件，纯 spawn 开销即达秒级，正好压在触发条件上。**这不是 CPU 问题，是进程创建问题**——在 Node 内只能靠批量化绕开（§ 8.2），在 `gix` 中是函数调用。

`M4` 与 `M6` 不在演进名单上。这是机制选择的结果，符合 L1：`overlayfs` 把 `fork` 变成一次挂载、把变更集变成一次目录枚举，两者的常数因子都不再是瓶颈。`reflink` 需要 XFS、Btrfs 或 APFS，在本平台不存在（§ 15.7）。

**共同前提**：**全部演进的前提是接口先冻结**（§ 11 给出核的判据，§ 12 的最后一列给出逐模块的冻结状态）；逐个模块对应的类型见上表"前提"列。

## 18. 演进的操作纪律

1. **一次一个模块。** 因为内核模块之间只共享 `Delta` 等少数类型，可逐个替换而 TS 侧接口不变。
2. **迁移前先固定基线。** 保存未优化 workload 的命令、版本、原始测量与判定。
3. **要求负对照。** 收紧后的断言必须在原实现上失败，否则该断言不构成保护。
4. **端到端复核。** 局部变快而端到端未变，则回退。
5. **不为了测量而添加生产导出。**

---

# 第六部分 · 推进：逐步可用与验证

## 19. 顺序设计原则

1. **每一步结束都产出可用的东西**，不是半成品。
2. **每一步不依赖后续任何一步。**
3. **风险最高的假设最早证伪。**
4. **每一步的验证都是可证伪的断言**，不是功能清单。

## 20. 八个步骤

### S1 · 视图可用
**范围**：`M0`（含存储格式与重放）· `M1` · `M2`
**交付物**：CLI `fugue read / list / stat / write / remove / rename / chmod / diff / log / revs / commit / replay / config`
**可用性**：手工操作一个虚拟视图并提交，全程不触碰磁盘工作树；**每次命令是独立进程，靠重放重建视图**（§ 9.6）
**验证**：
- 任意操作序列后，`diff()` 应用于 base == 视图全量读出
- **写 → 进程退出 → 新进程读回**，内容与 `rev` 逐字节一致
- 并发 N=4 提交后 `git fsck` 干净；并发 `advance` 同一 ref 恰有一个成功
- 4 个 writer 并发写日志，`readMerged` 的 `(seq, writer)` 序稳定且唯一
- 写完一批文件后 `kill -9`，`loadView` 重建结果等于已落盘的完整事件前缀
- `fugue replay --verify` 通过
**不依赖**：S2–S8

### S2 · 增量物化可用 —— **go / no-go**
**范围**：`M3`（`Roots` 与 `resolveVirtual`；符号索引不在内）· `M4`
**交付物**：`fugue fork <base>` → 真实目录；`fugue ensure` → delta 落地；`fugue diff-stat` → 全树 `(mtime,size,hash)` 快照对比；`fugue verify-mat` → 物化清单与差异集对齐
**可用性**：**在一个真实项目上跑增量构建**
**验证**：
1. `fork` 后立刻 `ensure` → 跑 `tsc --incremental`；改 3 个无关文件 → `ensure`
2. **第二次构建是增量的**；全树快照**恰好 3 条**变化
3. 未变文件的 `(mtime, size, inode)` 与内容哈希逐字节不变——**这是承重性质：它决定按修改时间判定新旧的工具链缓存不产生假失效**（§ 8.5）
4. 挂载期间从外部写 `upper` 后，`merged` 应不可见；卸载重挂后应可见（证明"`ensure` 与挂载互斥"这条约束被真正遵守，而非碰巧没触发）
5. `find upper` 的枚举集 == 全树变化集，且 whiteout 数与删除数相等——**一条 `delete <目录>` 算一条**（它对应一条打在目录上的 whiteout），"变化集"按同一口径读；每一步之后 `verify-mat` 都必须报相等
**判据**：此步失败则成本模型不成立，需重新设计——**它是全篇风险最高的假设，因此最早证伪**。
**不依赖**：S3–S8

### S3 · 并发视图可用
**范围**：`M1`（分支头）· `M3`（全部映射）· N=4 假 agent
**交付物**：`fugue branch <base>`（N 条分支头）· `fugue fork <base>` 与 `fugue ensure`（各带 `--agent`，N 路并发）
**可用性**：N 个分支并行独立工作，互不可见
**验证**：无交叉污染；各物化树全量哈希正确；N 路 `ensure` 并发无竞态
**不依赖**：S4–S8

### S4 · 隔离执行可用
**范围**：`M5` · `M6`
**交付物**：`fugue run <action> --agent <id>`
**可用性**：每个分支真正能跑构建与测试
**验证**：N=4 并行结果与串行**逐字节一致**；HOME / temp / 端口 / 缓存无串扰；未声明路径写入被拒并记事件
**不依赖**：S5–S8

### S5 · 边界可用
**范围**：`M7` 全部
**交付物**：逃逸用例集测试套件
**可用性**：**可安全交给模型执行**
**验证**：逃逸用例集里**够得着工作区之外的那些路**全拒（射程见 § 8.4）；虚拟可达集 == 物理可达集；拒绝文案指向正确的替代能力；`enforcement` 如实报告
**不依赖**：S6–S8

### S6 · 装配可用
**范围**：`M8` · `M9` · `M10`
**交付物**：`fugue assemble <protocol>` → 前缀字节 + 三区哈希
**可用性**：可核算缓存命中，可做协议 A/B
**验证**：
- 跨 N 个 agent `hash(zoneA)` 全等
- 同 agent 相邻两步仅 Zone C 变化
- 前缀中不存在绝对路径、环境标识、Signal 原文
- 状态切换前后工具 schema 哈希不变
**不依赖**：S7–S8

### S7 · 编排可用
**范围**：`M11` · `M12` · `M13`
**交付物**：`fugue round run <goal>` 端到端（模型仍可打桩）
**可用性**：完成"拆分 → 并行 → 合并 → 验收"一个完整轮次；**打回率有读数**——冲突数 · `Verifying → Working` 的次数 · 动作被拒的次数，三个数从日志重算，不采集（§ 8.15）
**验证**：相交契约在 `Planning` 报出；注入失败断言后真实工作树未被修改；漂移检测生效；合并后真实工作树与该 commit 的 tree 在保留前缀之外逐字节一致
**不依赖**：S8

### S8 · 接模型可用
**范围**：全链路 + 度量
**交付物**：完整可用的 harness
**可用性**：真实任务端到端
**验证**：零工具调用率与绕行率基线建立；同一模型两个协议的指标可比；端到端任务完成

## 21. 步骤与模块对照

| 步骤 | 模块 | 交付物 | 可用性 |
|---|---|---|---|
| S1 | M0 M1 M2 | 虚拟视图 + 持久日志 + 重放 | CLI 操作视图；进程重启后状态不丢 |
| S2 | M3 M4 | 增量物化（overlayfs fork + upper 落地） | **跑真实增量构建** |
| S3 | M1 M3 | 多视图 | 并行分支 |
| S4 | M5 M6 | 隔离执行 | 分支跑测试 |
| S5 | M7 | 边界强制 | **可交给模型** |
| S6 | M8 M9 M10 | 装配 | 缓存核算 + 协议 A/B |
| S7 | M11 M12 M13 | 编排 | 完整轮次 |
| S8 | 全链路 + M14 | 端到端 + 度量 | 真实任务 |

---

# 第七部分 · 决策、未决与纪律

## 22. 关键决策登记

**这一张是"已经定下来的"。** 最后一栏写的是推翻它的代价——代价大的那几条是承重墙，动它们等于动架构。**U 号是登记号，不重排**：§ 23 里每定下来一条，就移进这张表，`#` 那一栏保留它原来的 U 号；所以 § 23 的号不连续。

| # | 决策 | 理由 | 被推翻的代价 |
|---|---|---|---|
| D1 | 执行时工作区只读，产出经声明集回收 | 使"视图是唯一写入者"成立，进而使"构造上无 N² 冲突"成立 | `M6` 重设计 + 合并冲突模型变更 + 核心卖点丧失 |
| D2 | 发现类能力走视图侧 | 保证 `write` 后立即可见，避免模型陷入重试循环 | `M2` 失去 `list` + 一致性模型变更 |
| D3 | 物化由能力需求驱动，幂等 | 使"写完即可执行"成立 | 执行前需显式提交，与模型先验不符 |
| D4 | 前缀分三区，稳定性各异 | 缓存契约的唯一表达方式 | `M10` + `M12` 变更 + 缓存论证重推 |
| D5 | tombstone 区分"已删除"与"从未存在" | 删除意图须参与合并 | 合并语义错误，静默丢改动 |
| D6 | 写入型契约声明路径所有权 | 使写入集相交可静态预检 | 冲突退化为合并时才发现 |
| D7 | 反向通道限声明集 | D1 的必要配套 | 子进程的隐性改动进入视图，冲突来源不可枚举 |
| D8 | 状态机只做转移不做动作 | 防止 `M12` 成为 god module | 状态机膨胀为逻辑落脚点 |
| D9 | `AgentId` 不跨轮复用 | 简化 ref 命名与日志键 | 身份模型变更 + 日志键变更 |
| D10 | 日志即持久化层，不设独立持久化模块 | 任何中间持久层都是第二份真源 | 视图获得 `open`/`flush`，`M2` 接口变更 + 崩溃语义变更 |
| D11 | 每 writer 一份日志，全序由 `(seq, writer)` 隐含 | 并发写者零协调；`round` 是唯一 writer，状态机单写者由物理保真 | 需要全局单调序号 → 重新引入协调 |
| D12 | 可验性落在字段类型上，契约本体只做判别 | 加字段的代价恒定；每个值域只有一个实现 | 每个字段的验证必须落回契约本体——字段一多，判断就聚到本体上，加字段的代价不再恒定 |
| D13 | 讨论累积在环境，只有投影进前缀 | 讨论可以无限累积而前缀上界为常数 | 会话记录成为工作区的一部分，需要坐标与归档约定 |
| D14 | 进度活在分支上，不活在物化目录里 | 接续只依赖分支的提交点，物化目录保持一次性 | 接续触发时须定格一次提交 |
| D15 | 只读型契约的产物由构造器按位置定名，落进专属目录 | 产物命名冲突**不可能发生**，而不是"检测出来再改" | 产物路径不由持轮者命名 |
| D16 | 配置住在模型够不到的地方，人写 | "模型是被配置者"成为**结构性质**而非策略性质 | 要给 `Policy` 加"按行为者区分"一维，或让配置进视图 |
| D17 | 文档渲染进宿主私有的 `<realRoot>/.fugue/docs/`，不进视图、不提交 | "派生不持久化"成为**结构性质**——产物没有第二条命 | 文档自身的演变不可回溯，要回溯只能看状态与提交历史 |
| D18（U7） | 首个真实协议 = 十一个段 + 提供方那一项，两份值（子 agent 一份 · 持轮者一份），载入时的不变量与那三条断言 | 前缀的形状只有一个来源；两份值各自固定，缓存契约才有可比的对象 | 段数 · 段位或值一变：三区指纹 · 缓存基线 · `meta.json` · 回放夹具整组重取 |
| D19（U9） | 契约里那三个类型的形状：`Assertion` 是一条可执行的验收项 · `Deliverable` 是交付物路径与形态 · `AssertionResult` 三档（通过 · 没通过 · 跑不起来） | 未定形状即未定可验性；三者的值域持有者已各自指名（§ 8.12） | 形状一变，契约本体与每个字段的值域持有者都要跟着改，加字段的代价不再恒定 |
| D20（U12） | 真实工作树的漂移只钉住、不比对：检测落在**物化之前**，三方比（底 · 目标树 · 盘上）——盘上既不是底也不是目标树 → 拒；盘上就是底、或与目标树逐字节相同 → 照常。`fork` 时不判 | 在 `fork` 时比对等于要求每轮开工时工作树干净，那是"跑不起来"，不是变慢（§ 8.14） | 两头都是错的：拒得过多，"目标树里没有、而盘上有"的删除跑不到；拒得过少，用户自己新加的文件被静默删掉 |
| D21（U14） | `dispose` 的删除范围 = 四个坐标一起删（`upper` · `merged` · `tmp` · `cache`），容器 `mat/<agent>/` 跟着走，父目录不收 | "这些坐标下不留东西"是它的后置条件；缓存与临时目录都是这一格的派生物（§ 8.4） | 留下半个：坐标不可回收，`tmp` 底下那个内核草稿本变成取不掉的垃圾 |
| D22（U17） | `top` 这一版不做 | 它要的是 ensure 延迟 · git 调用 · 触碰文件数**跨轮可比**的读数，而这一版只有单轮，没有可比对象 | 人要看跨轮趋势时没有现成的第二档渲染——`M14` 的重算读面在，缺的是第二轮的基线 |
| D23（U19） | 命令不设时限：`bash` 那条调用不吃超时，卡住的命令不被砍 | 要给时限得同时改公布面与绑定面，而"公布面 = 绑定面"是硬纪律（§ 8.10） | 卡住的命令只能靠人杀——`--max-steps` 管的是步数，不是墙钟 |

## 23. 未决事项

**这一张是"还没定下来的"。** 号是登记号：定下来的一条移进 § 22（`#` 那一栏留着它的号），所以这里的号不连续。`影响面` 那一栏写的是它卡住谁——**改了它，谁要跟着重取读数或重写判据**。

| # | 未决 | 影响面 |
|---|---|---|
| U1 | 日志的增长上界：要不要把旧日志折叠或封存。**这一版不做**（计划 § 7）——一旦允许，"可重放"就从"永远能回到任何一步"变成"从某个基线起能回去"，这是审计语义，不是磁盘管理。快照的写出时机已定在提交点（§ 9.4） | `M0` |
| U2 | 符号索引的落盘与增量维护。索引挂在**轮边界**更新；「哪些文件变了」由 `M2.diff()` 直接给出，因此不需要重扫全仓 | D2 的性能兑现处 |
| U3 | 冲突解决的执行者（子 agent 或持轮者）与其视图/物化选择 | `M6` 声明集来源 |
| U4 | 接续与抢占的调度策略：`SignalKind` 的类型系统，以及两者的触发判据。接续按发起者分两类的结构、各自的种子与代价已定（§ 8.13.a） | `M12` · `M14` |
| U5 | 跨轮的前缀复用：Zone A 如何随轮演进（结构部分见 § 8.16.a） | 成本模型核心 |
| U6 | 上限与交接余量的实测。**上限已实测**：`GET /models` 的 `context_window` = 1 048 576（官方文档那一页写"1M"是取整；复核命令 `node tools/probe-models.ts`，它同时核输出上限 393 216 与 `effort.supported_levels`）。这一版声明的三个数是 1 048 576 · 367 001 · 16 000（`src/model/contract.ts` 的两条声明），触发点取上限的 35%（§ 8.13.a），固定段那一项按上限的 8% 估（§ 8.12 的 `seed` 准则）——**待实测的是交接余量本身**（它要 `handoff-yield` 的读数） | 需实验 |
| U8 | **按 mtime 判定的工具在本架构工作负载下的假失效量级**。事实部分已确证——`make` · Cargo · `ccache` 均按 mtime 判定（§ 8.5），未测的是"一次假失效要付多少时间"，它决定 `preserveMtime` 与 `changeDetector` 的默认值 | `M4` 的 `MaterializeOptions` |
| U10 | 凝聚理解的质量读数。**凝聚前最近几次原文 = 3 条**、**凝聚理解的上限 = 50 000 token** 两条已定（越过上限是异常：报出来、不裁剪——它是模型的产物，没有"拒"的对象）；待实测的是"凝聚写得够不够短" | 需实验 |
| U11 | 每契约的接续上界取值，以及失败断言如何分类（越界 · 目标不自足 · 实现不对）以支撑拆分的事后判据 | `M12` · `M14` |
| U13 | 沙箱的物理可达集靠什么强制点收窄。实测的答案是"整个宿主读得到"（含 `<realRoot>/.fugue/config`），比"在不在"更糟——围栏要拦的不是一条路，是"宿主"这个概念本身 | `M7`（S5） |
| U15 | 编译器持久缓存的跨轮复用：agent 不跨轮复用（D9），于是这份缓存只在轮内有消费者。不复用 = 每轮第一次构建是全量；复用 = 要造一份跨轮的东西 | `M4` · 成本模型 |
| U16 | 名字与 git ref 的边界：同一个命名空间里一个 ref 不能既是文件又是目录（实测 `cannot lock ref … exists`），所以一个 agent 正好叫 `agent`（或 `agent/r1`）时，`refs/heads/agent` 建不出来——已有的 `refs/heads/agent/r1/1` 挡着它。要定的是：名字那一处就拒掉**与已有分支头互为前缀**的名字，还是让 ref 那一层去拒（今天名字由分配器给，撞不上） | `M1` · § 14.1 的分配器 · S7 的分支命名 |
| U18 | **子 agent 的问题转交给持轮者**。今天子 agent 调 `ask_user_question` 只得到一句"这不是你这一格的事"（§ 8.4 纪律 2）——它要问人的时候，问题得先在轮内被接住，再由持轮者拿到人面前。要定的是"谁替它接"（持轮者轮内收下 / 走编排那一族）与它落在日志里的形状 | `M12` · 尚未立的委派那一族（§ 8.9 今天只有四层：视图 · 执行 · 真源 · 日志） |

## 24. 全局纪律

1. **真源不虚拟化，派生不持久化。**
2. **约束体现在边界上，不体现在接口上。** 虚拟化在接口之下，不在接口之上。
3. **视图是唯一写入者。** 子进程写盘一律经声明式反向通道。
4. **每个"必须发生"的动作写成断言，不写成建议。**
5. **失败要指路，不要筑墙。** 每一次"你该用别的工具"都是负反馈，累积即为软锁死。
6. **只有一个实现、却先造了接口的地方，是一次修正要付两次钱的地方。**
7. **复用核心冻结接口，接口冻结是演进的前提。**
8. **扩展性只加在值上，不加在顺序与形状上。** 顺序决定缓存命中，形状决定消费方的完备性，两者都必须声明式固定。可变的是构造它的过程，不是它本身。
9. **要让一个结果活过进程重启，就把它写成状态，不要指望它留在上下文里。**
10. **进度活在分支上，不活在物化目录里。** 物化目录按设计是一次性的；要让进度活过 agent 的更替，就先把它定格成提交。
11. **文档是投影，不是信源。** 重生成，不修补——修补的代价是锚定在旧结构上。方向单向：状态 → 文档。
12. **工作区是自足的。** 把 `<realRoot>` 整个搬走、改个名，删掉工作区之外的一切**工作区自己的状态**，它仍能打开并接着做——宿主常量与机器级配置不是工作区的状态，它们是它的输入。判据是：任何新东西先问一句——**它能不能放进工作区**。
13. **模型是被配置者，不是配置者。** 定义它运行条件的东西——配置 · 项目方针 · 策略 · 工具目录——它只能受其约束，或者**申请**修改。**不是"有路不许走"，是"没有路"**：它们不在它的命名空间里。
14. **状态的呈现只有一处。** 任何"给人看的状态"都表达成一份定义提示词（§ 9.9），**不新造渲染器**；事件流不在此列——它看的是正在发生什么。
