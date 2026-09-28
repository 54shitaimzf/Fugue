# Fugue

> **真源只有两处**：git 对象库，与一份只追加的事件账。视图 · 物化树 · 前缀 · 读数全是这两处的派生，随时可以重算。

一座**编码 agent 的骨架**：一轮任务由持轮者拆成契约，子 agent 各自在自己的物化树里干活，合并 · 验收 · 推进——每一步都落在账上。

这是**第一版实现**。架构 · 计划 · 第一版之后的目标三份设计文档不在这个仓库里：它们记的是"为什么这样切"，随设计工作区维护。

## 形状

- **真源两处**（git 对象库 + 每个写者一份只追加的日志）。全序由 `(seq, writer)` 隐含——并发写者之间不阻塞、不协调，崩溃后重放得出同一份视图。
- **前缀分三区**：A（项目方针 · 系统状态 · 代码树——跨 agent 稳定）· B（每格自己的任务）· C（每一步的处境）。相邻两步只有 C 区变，缓存命中是这么来的。装配是纯函数，三区哈希可复算。
- **执行面是真实工作树的一份拷贝**：`fork` 出物化树（overlayfs → 硬链接只读 → 拷贝，探着退档），进程跑在 `bwrap` 里；声明集外的写入由内核拒。`bwrap` 不在时降一档并如实报 `partial`——那个机制死掉时系统是**变慢**，不是跑不起来。
- **人的每个状态动作都是一条命令**（放行就是 `fugue round go`）。TUI 是同一份账的第二种渲染，它自己不写账、不持写句柄。
- **无运行时依赖 · 无构建步骤**：`package.json` 里没有 `dependencies`，Node 直跑 `.ts`（strip-only TypeScript）。

## 跑起来

要 **Node ≥ 22.6** · **git ≥ 2.38**（`merge-tree --write-tree`）· Linux 或 WSL2（仓库放 `ext4` 上）。`bwrap` 可选。

```sh
git clone <这个仓库> fugue && cd fugue
node tools/test-entry.js        # 唯一验收入口（0.1.0 那一版：510 个断言）
node src/cli/fugue.ts --help    # 全部命令（0.1.0 那一版：27 条）
```

装成 PATH 上的一条命令（一次就好）：

```sh
ln -s "$PWD/bin/fugue" ~/.local/bin/fugue      # 或者：npm i -g .
fugue --help                                   # 与上面那次调用逐字节相同
```

走查——每个站在一条命令里走一遍它的可用性，都不出网、不花钱：

```sh
sh tools/walkthrough.sh         # S1：起一个真仓库——写 · 提交 · 杀进程 · 重放 · 看变更
sh tools/walkthrough-s8.sh      # S8：装配 · 真档三档 · 判据卡
sh tools/walkthrough-s9.sh      # S9：持轮者拆分 · 门 · 放行（最长的一份）
```

跑一整轮：一条命令把工作区从一份**声明式的场景文件**搭出来，把读数摊开。

```sh
sh tools/live-round.sh tools/live-w11.json                   # 打桩档：不出网 · 不花钱
sh tools/live-round.sh tools/live-w11.json --wire-in <目录>   # 回放档：把录下来的响应喂回去
sh tools/live-round.sh tools/live-w11.json --live             # 真档：接真模型（要凭据 · 花钱）
```

真档要一份凭据，按提供方的声明取（`src/model/contract.ts`）：环境变量 `DEEPSEEK_API_KEY`，或 `~/.fugue/credentials/deepseek.key`；命令行用 `--credential <路径>` 覆盖。**第一次联网把上界压到个位数**——`--max-steps 4`。不给 `--max-steps` 就是不设上界（上界是你的决策，不是它的兜底）。

盯着它跑（另一台终端，或者接在管道里）：

```sh
fugue status --once --root <工作区> --metrics --report   # 这一刻的处境 + 八元指标 + 打回三个数
fugue watch --follow --root <工作区>                     # 顺着账跟随读（纯读：不取锁 · 不写账）
fugue tui --root <工作区>                                # 底部一块恒定 K 行的面板；门槛上按 g 放行
```

`fugue tui` **不接管屏幕**：永久行按到达序追加进终端历史，底部那 K 行擦掉重画。不是 TTY（管道 · CI）或 `$TERM=dumb` 时退到"只印永久行"，一个字节的 ANSI 都不写。按键只在真终端那一档生效：`g` 放行 · `?` 重印提示 · `q` 退出。

## 这一版不是什么

- **没有 subagent 工具**：模型自己不能派子 agent、也不能给别的 agent 发消息（`subagent` / `list_agents` / `send_message` 都不在工具目录里）。
- **只有两条模型声明**，都是 `deepseek-flash`（anthropic 与 openai 两个端点），都是子 agent 协议。
- **不发 npm 包**（`private` 留着）· **不许有运行时依赖**——手写的 ANSI 是 TUI 唯一那一档。

## 仓库里有什么

| 目录 | 是什么 |
|---|---|
| `src/cli/` | 命令行 |
| `src/round/` | 一轮：拆分 · 门 · 派发 · 驱动 · 合并 |
| `src/assemble/` | 前缀装配：三区 · 段源 · 协议值 · 约束 |
| `src/log/` | 事件账：追加 · 索引 · 交错读 |
| `src/view/` · `src/materialize/` · `src/execute/` | 视图 · 物化树 · 隔离执行 |
| `src/model/` | 模型声明 · 线协议 · 三档传输（真网络 / 回放 / 夹具） |
| `src/probe/` | 读数：快照 · 八元指标 · 打回三数 |
| `src/ui/` | TUI：排版（纯函数）· 终端 · 跟随 · 按键 |
| `tools/` | **取证用的，不是产品的一部分**：走查 · 探针 · 基准，随时可重跑 |

## 验收

```sh
node tools/test-entry.js
```

唯一入口。它在**一个测试文件都没发现**时非零退出——`node --test` 自己在那种情况下是笑着退出的（`tests 0 / pass 0 / fail 0`，退出码 0）。

**断言在位，不断言快慢。** 一个单元三条：一条能跑的命令 · 一条会失败的断言 · 它兑现的架构条款——`git log -1 --format=%B` 看得到全文。

## 许可

MIT，见 `LICENSE`。
