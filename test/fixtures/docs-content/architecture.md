## 整体形状 {#shape}

Fugue 的一个 agent 是 **环境 + 上下文 + 模型**：环境持有状态，上下文是每一步从状态重建出来的投影，模型只读投影、只经声明式动作改状态。这一版把这三样分开之后，整个系统只有两处真源，其余全是可弃的派生。

```
        真源（唯一、不可变、内容寻址）
        ┌──────────────────────────────────────────────┐
        │  git 对象库        <realRoot>/.git            │
        │  M0 日志           <realRoot>/.fugue/log/     │
        └───────────────────┬──────────────────────────┘
                            │ 重放 / 读
        ┌───────────────────┴──────────────────────────┐
        │  派生（可弃、可重建）                          │
        │  M2 视图 · M4 物化树 · M10 前缀 · M14 指标      │
        │  .fugue/snap · .fugue/mat · .fugue/docs       │
        └──────────────────────────────────────────────┘
```

三条直接结论，判断任何新东西时都用得上：

1. **真源绝不虚拟化**：唯一、不可变、内容寻址。
2. **派生一律虚拟化且可弃**：视图、物化树、前缀，删掉都能重建。
3. **路径是身份，不是位置**：模型看到的是仓库相对路径，与物化到哪里无关。

判据只有一句：**它是真源，还是真源的派生？**

### 三个命名空间，形状相同

| 命名空间 | 真源 | 视图 | 位置 |
|---|---|---|---|
| 文件 | git 对象库 | 每 agent 一份 overlay | 物化目录 |
| 进程 | 系统级配置 | 每 agent 一套 `HOME` / 缓存 / 端口 | 无（模型不按路径寻址） |
| 上下文 | 环境 + 协议 | 每轮装配的前缀 | 无（前缀不是文件） |

进程那一格没有位置，因为模型感受到的不是一份可寻址的清单。它落在 `cacheRoot(a)` / `tempRoot(a)` / `ports.range` 上，问的是“它让什么变得可用”，不是“它在哪”。

## 真源只有一份 {#one-source}

真源是**两样东西合起来**：git 对象库，与 `M0` 日志。日志之所以算真源，不是因为它重要，而是因为有一批内容**没有第二份来源**：交接提示词、轮级意图、凝聚理解、契约正文——模型写的，重启之后只能从日志重放。`src/log/events.ts` 的 `LogEvent` 联合就是这件事的边界：**重放要读得到的内容，必须进日志**。

派生清单与它们的重建方式：

| 派生 | 重建方式 | 代码落点 |
|---|---|---|
| 视图 | `loadView` 重放该 writer 的日志 | `src/view/view.ts` |
| 物化树与清单 | `fork` / `ensure`，清单由 `mat/*` 事件重放 | `src/materialize/*` |
| 视图快照 | 日志前缀的折叠，可选、可弃 | `src/view/snapshot.ts` |
| 前缀 | `M10` 重算 | `src/assemble/assemble.ts` |
| 指标 | `M14` 从日志重算 | `src/probe/metrics.ts` |
| 文档 | 每次重生成，整批替换 | `src/docs/build.ts` |

`src/truth/truth.ts` 的四项硬约束在这里落地：只用 plumbing、完全不落索引；`advance` 带 CAS（`ADVANCE_ATTEMPTS = 4` 只重试“锁撞车”，不是“CAS 会失败”）；`kindOf` 对不认识的 mode 显式失败，不猜；blob 字节缓存按内容寻址，所以不需要失效逻辑，`DEFAULT_BLOB_CACHE_BYTES` 是 8 MiB 的缺省，给 0 就是直通。

`src/view/view.ts` 的头注把另一半说死了：**视图没有 `open` / `close` / `flush`，持久性全部由 `M0` 承担**——先持久，后重建。视图一旦自己持久化，就会出现第二份真源。

::: warn 一条容易走反的路
给视图加 `flush()`、给物化清单单独存一份、给文档建版本历史——都是“多出一个持久化模块”，也就是第二份真源。判据不是“这样更快”，而是“删掉它，还能不能重建”。
:::

## 日志记什么、怎么坏 {#log}

`M0` 本身**不读事件类型**：`src/log/log.ts` 只按 `envelope.ts` 的信封写下去、原样读回来。所以事件联合改值域，M0 的实现一行不用动。

记的与不记的，分界线是“重放读不读得到”：

- `view/write` 带 `blob`——**内容是引用，不是副本**。
- `mat/*` 带 `paths`——物化清单由此可重放，不单独持久化。
- 带正文的九处：`agent/handoff` · `round/intent` · `holder/distill` · `holder/todos` · `holder/plan` · `holder/ask` · `ask/raised` · `ask/ruling` · `contract/issue`。
- 模型自己生成的文本**不进日志**：`tool/call` 只留 `argsDigest`，`run/start` 只留 `argv0`。跨进程重启靠交接提示词与机械重组。
- `llm/call` 记 `invocations` · `usage` · `stop` · `thinking`，不记工具参数原文。

崩溃语义两条，`src/log/log.ts` 的 `parseWriterText` 分开处理：**半行在尾部 → 截断继续；中段 `crc` 失败 → 拒绝加载**（`LogCorruptError`，指出行号）。中间丢一行会让重放产生一份与当时不同的视图，而“重放必须一致”是承重性质——宁可显式失败。

写者一侧还有两件：拿锁的写者在第一次追加之前，把未提交的尾段截到完整行边界（`tailState`）；锁是 `log/<writer>.lock`，`LogOptions.write` 与 `hold` 二选一，两个都给是用法错。**读命令不取锁**——“观察不得影响状态”读出来就是“观察不加锁”。

`Log` 契约仍是三个方法；`LogHandle` 另加了 `close()` · `writers()` · `clocks()` 三个只读口，契约本身不动。

::: details 事件族与它们各自承担什么
| 族 | 代表事件 | 重放后得到 |
|---|---|---|
| 视图 | `view/write` · `view/remove` · `view/rename` · `view/chmod` · `view/symlink` | 每 agent 的 overlay |
| 提交点 | `ckpt/commit` | 分支上的提交序列 |
| 物化 | `mat/fork` · `mat/sync` · `mat/reclaim` | 物化清单与回收读数 |
| 执行 | `run/start` · `run/end` · `run/confined` | 执行与拒绝的读数 |
| 边界 | `bound/deny` | 越界率的分母之一 |
| 轮次 | `round/state` · `round/intent` · `round/approve` | 轮次处境与放行过的那一批 |
| 契约与持轮者 | `contract/issue` · `holder/distill` · `holder/plan` · `holder/ask` | 派过什么活、按什么验收 |
| 模型调用 | `llm/call` · `prefix/assemble` | 用量、收尾、三区哈希 |
| 合并 | `merge/attempt` · `merge/publish` · `merge/accept` | 合并、发布、验收三段事实 |
:::

## 前缀是重建的，不进日志 {#prefix}

`M10` 是纯函数：`(状态值, Protocol) → 字节`。`src/assemble/assemble.ts` 只做三件事——排序、渲染、拼接；它不读 `Truth`、不读 `View`、不 `readFile`。缺源不是异常：`emptyFor` 按渲染规则给空值，前缀短一段，装配照跑。

三区 A / B / C 就是**稳定性等级**：A 区跨 N 个 agent 逐字节相同，B 区是同一 agent 的分支增量，C 区每步可变。`prefix/assemble` 事件只记 `zoneAHash` / `zoneBHash` / `zoneCHash` 三个哈希，**不记字节**——字节是重建出来的，`firstDivergence` 按偏移告诉你是哪个区变了。

两份 `Protocol` 值是同一段代码的两个输入：

| | 子 agent | 持轮者 |
|---|---|---|
| A 区 | 逐字节相同 | 逐字节相同 |
| B 区 | 工作总目标 · 文件内容 · 提交序列 · 交接提示词 · 我的任务 | 多两段：凝聚理解 · 凝聚前最近几次原文；少一段：我的任务 |
| C 区 | 机制相同 | 内容含全部契约的上报与讨论 |

`src/assemble/protocol.ts` 的 `SUBAGENT_PROTOCOL` 与 `HOLDER_PROTOCOL` 版本号都是 `s6-1`——**差别是角色，不是协议版本**。`protocolFor` 是唯一一处把声明翻成协议值的地方；调用点只知“按这个声明装配”，不知道有哪两份协议。

`RENDERERS` 有 13 条，不是 12：子 agent 的 11 段（工具目录的位置由提供方定，不在 `segmentOrder` 里）加持轮者 B 区多出的两段。两份值共用同一张渲染表。

::: note 前缀与日志的关系，一句话
日志记的是**发生过什么**，前缀记的是**此刻该读什么**。前者持久，后者每步重建。所以 `prefix/assemble` 只留哈希——留字节就是给投影建第二份真源。
:::

## 轮次是位置，契约是值 {#round}

主干只有一条：日志侧署名 `round`，git 侧 `refs/heads/main`。**持轮者是可替换的位置**，不是更强的 agent——它比子 agent 多的只有“持有轮级状态机句柄”这一件事，而这件事不能体现为额外的工具，否则 A 区就不再逐字节相同。权限差别只能落在输入与作用域上。

子 agent 从主干分出去，各有各的日志与分支头，写下的东西经合并回到主干。

契约是**不可变值，可变的是构造它的过程**。三个变体不是字段缺省，是三种真实的写入面来源：

| 变体 | 写入面来源 | 不可相交的理由 |
|---|---|---|
| `implement` | 持轮者给的 `ownedPaths` | 相交预检管这一种 |
| `resolve` | 冲突路径集 | 等于 `M13` 报告的集合 |
| `investigate` | 构造器按位置定名（`evidence/<agent 各段>/<note>`） | 结构上不可能与任何契约相交 |

`src/contract/types.ts` 的 `declaredSetOf` 是**一处**给写入面的函数：`write` / `edit` 按它拒，`M6` 回收按它收。同一条界两个面，一边宽一边窄就有一条缝。`FIELD_RULES` 一格一个值域持有者；跨字段关系（`actionOutputs ⊆ ownedPaths` · 写入集相交 · 断言指名的动作在不在配置里）归构造器，在派发前跑完。

状态机只做转移：`src/round/machine.ts` 的 `step` 收一个状态与一个事件、给一个状态，**签名里没有 deps、没有句柄、没有异步形状**。`EDGES` 是那张图的可读副本，图上没有的边当场拒；`abortEdges()` 是“`Aborted` 从任意状态可达”。`RETRY_DEFAULT = 1` 只有一处定义。

## 隔离与边界的接缝 {#boundary}

`M7` 是**一份策略值，两个强制点**：虚拟空间的 `Roots.resolveVirtual` 与物理空间的 `confine()`。`src/boundary/policy.ts` 的 `resolvePolicy` 一处解析，`fugue policy` 与 `run/confined` 读的是同一份——不是两处各算一遍再对答案。

三件事要分开读：

- **`net` 是要求，`layers` 是供给。** 动作在配置里点 `"net": "host"` 才开网；`layers` 是这一趟现探出来的。供给跟不上要求时一档一档地降，`enforcement` 如实报。
- **`mode` 报的是事实，不是要求。** 挂载层在场时它给命令行要的那一档；挂载层不在、第二层在时，由第二层说了算；两层都不在才是 `workspace-write` 那一档。
- **`enforcement: full` 要两层都在场**（`bwrap` + `landlock`）。少一层就是少一维纵深，如实降一档。

执行时树只读是默认档（D1），产出经**声明集**回收。`fugue run` 默认 `read-only`；格内取 `workspace-write` 时，可写面换了个地方封——**声明集**：集内的差异回视图、进提交，集外的改动 `mat/reclaim` 如实报、进不了提交。

## 文档是投影，不进决策 {#docs}

方向单向：**状态 → 文档**。文档不进任何区，任何 agent 都不读它做决定；它住在 `<realRoot>/.fugue/docs/`，与日志、快照、配置并列，不在视图里。

模型够不到文档，靠的是三条既有性质，不是一条新禁令：文件工具只认视图内的相对路径，而文档不在视图里；改状态只经声明式动作，而动作名取自系统级白名单，没有“写文档”这个动作；渲染不是 agent 的一个动作——路径取自文档定义（一份配置），写入由宿主完成。

`src/docs/build.ts` 的次序与这件事一致：核定义 → 取事实 → 逐页取证（模型点名要读的文件）→ 逐页写作 → 宿主校验与呈现 → 整批替换。**两趟调用，材料不同**：第一趟只要“要读哪几份文件”的 JSON，第二趟带上原文写正文。

它是**重生成，不是修补**：修补的代价是锚定在旧结构上。`checkContent` 机械拒两件事——只写了 H1（页标题由宿主加，正文要从 `##` 起）、一个章节标题都没有。`aliasPlan` 在标题改了而主题未变时，把旧深链接按相似度落到新标题上。

## 最容易越过的四条线 {#lines}

| 线 | 判据 | 越过的症状 |
|---|---|---|
| **视图是唯一写入者** | 子进程写盘只经声明集反向通道 | 冲突来源不可枚举；`mat/reclaim` 的 `changed` 里出现没声明的路径 |
| **内核不认识模型，面不认识 git** | 内核（M1–M6）可完全离线测试；面只认相对路径与协议数据 | 内核里出现 `ModelId`，或面里出现 `Truth` |
| **配置与文档不在模型的命名空间里** | 模型手里只有视图内相对路径与声明过的动作名 | 配置进了视图，或文档成了一个段的来源 |
| **扩展只加在值上，不加在顺序与形状上** | 段序由 `Protocol` 声明；新段 = 加一个键 | 在适配器里出现 `if (model === 'x')` |

前两条是结构性的：它们不是“约定不要做”，而是“签名上没有地方做”。第三条的判据是“有没有一条路径指得到它”。第四条决定缓存命中——顺序一变，前缀字节序就变，共享头失效。

## 拿什么核对这一版 {#check}

- `src/view/replay.test.ts` 的四条：写 → 进程退出 → 新进程读回逐字节一致；写完一批强杀后重建 == 已落盘的完整事件前缀；快照删掉 / 写坏 / 比日志新 / 信封不符都不改变重建结果；四个 writer 交错重建 == 各自重建再合并。
- `fugue replay --verify`：逐 agent 比对 `rev`、全量读出、`diff()`，从快照起与从 0 起两条独立路径互校。
- `node tools/check-events.js`：一份命令盯事件联合与归档那张表。
- `test/check-invariants.test.ts`：两份协议值与区表对不对得上、能力表与工具目录那道跨文件缝。
- `node tools/bench-replay.mjs`：重放的复现命令（一条 `view/write` 约 274 字节，重放约 0.01 ms/事件）。

## 来源与实现差在哪 {#drift}

这一页的来源是 `design/ARCHITECTURE.md`，以提交 `b60c8405ddd7` 的代码与测试为准。有实质差异的几处：

- **`llm/call` 多了一栏 `ms`。** 来源的事件联合里没有它；`src/log/events.ts` 有 `ms?: number`，记的是这一趟调用的区间读数，旧日志回放照旧。
- **协议不变量的核对从载入时搬到了检查器。** 来源说“载入时的核对”；`src/assemble/protocol.ts` 里那道载入闸已撤，判据还在 `checkProtocolInvariant` 里，读它的是 `tools/check-invariants.ts` 第二节。生产路径不再为“两份声明对不对得上”付一次载入时的核对。
- **段的数目要按两份协议读。** 来源说“十二个段”，`RENDERERS` 是 13 条：子 agent 的 11 段（工具目录不在 `segmentOrder` 里）加持轮者 B 区多出的凝聚理解与凝聚前最近几次原文。
- **`Log` 契约三方法没变，句柄多了三个只读口。** `close()` · `writers()` · `clocks()` 不在 § 8.1 的三个方法里，是 `LogHandle` 自己的口。
- **状态机的状态数以 `EDGES` 为准。** `src/round/machine.ts` 的 `STATES` 数组是 10 个；那张图与 `EDGES` 表是机器可读的副本，加一条图外的边会被 `step` 当场拒。