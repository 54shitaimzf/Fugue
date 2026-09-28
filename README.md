# 赋格 _(fugue)_

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/fugue-lockup-inv.svg">
    <img src="assets/brand/fugue-lockup.svg" alt="赋格 · fugue" height="96">
  </picture>
</p>

[![test](https://github.com/54shitaimzf/fugue/actions/workflows/test.yml/badge.svg)](https://github.com/54shitaimzf/fugue/actions/workflows/test.yml)

本地优先的编码 agent：真源只有 git 对象库与一份只追加的事件账

**给它一句话，它自己拆活、自己干、自己验；全过才动你的工作树，没过就一个字节都不动。**

## 目录

- [背景](#背景)
- [安装](#安装)
- [用法](#用法)
- [它是怎么做到的](#它是怎么做到的)
- [这一版不做什么](#这一版不做什么)
- [想要更多](#想要更多)
- [维护者](#维护者)
- [贡献](#贡献)
- [许可](#许可)

## 背景

一句话的活，比如：

> 把记账模块补完：金额按分格式化、加一个 `avg`、删掉过时的旧文件。

**它先跟你把话说清楚，再动手。** 一句话进来是五步，**每一步都停在你看得见的地方**：

| 步 | 它做什么 |
|---|---|
| 一 · 说 | **讨论态**：它读你的项目（项目方针 · 代码树 · git 历史），跟你来回问。这一步不碰你的工作树——讨论原文按轮写进 `.fugue/session/`，它这一步的动作照常进账。说清楚了**由你踩那一脚**：`fugue round plan <目标>` 进预备态；或者在讨论里说一句"可以开始了"，它认出来就替你踩 |
| 二 · 拆 | **预备态**：把这句话拆成几份能各自交付的活，**停在门口等你点头**：每份交付什么 · 打算动哪几个文件 · 会跑哪几条断言 · 预估占模型多少上下文。这一步一个契约都不发、一条分支都不起，草案写在 `.fugue/plan/<轮次>.md` |
| 三 · 派 | 你点头（`fugue round go`）之后，每份活开一条分支，各自在自己的物化树里干——**互不打扰，你的工作树在这期间一个字节都不动** |
| 四 · 验 | 把几条分支合起来，在**合起来的那棵树上**跑它当初声明的断言；没过就回一趟重干，还不过就打回 |
| 五 · 落 | 全过才写一个提交、推进你的主线；任何一步没过，你的工作树保持原样——不留半成品、不留垃圾分支 |

每一步都落进工作区里一份**只追加的账**（`.fugue/`）：你随时能看它在干什么，也随时能看它为什么停。

**一条硬边界**：你手上正在改的那份工作树就是它的底。哪条路径上盘上那一份既不是底、也不是这次合并算出来的，它在落地之前**拒**并逐条报出来——不会覆盖你的手改。

## 安装

前置三样：

- **Linux 或 WSL2**：仓库要放在 `ext4` 上（Windows 原生 NTFS 上，文件系统那一档判据过不去）。
- **Node ≥ 22.6**：`.ts` 直跑，没有构建步骤。
- **git ≥ 2.38**：要用 `git merge-tree --write-tree`。

```sh
git clone https://github.com/54shitaimzf/fugue.git ~/fugue && cd ~/fugue
ln -s "$PWD/bin/fugue" ~/.local/bin/fugue      # 或者：npm i -g .
fugue --help                                   # 26 条命令（round 5 条子命令 · config 3 条）
```

没有依赖：`package.json` 里 `dependencies` 是空的，也不需要 `node_modules`。接真模型要一份凭据，按提供方的声明取——环境变量 `DEEPSEEK_API_KEY`，或 `~/.fugue/credentials/deepseek.key`；命令行 `--credential <路径>` 覆盖。

## 用法

### 先看它干一趟真的（不出网 · 不花钱 · 半分钟）

这一趟走的是**录下来的真响应**，一条命令，谁都能跑：

```sh
git clone https://github.com/54shitaimzf/fugue.git fugue && cd fugue
sh tools/live-round.sh src/cli/__fixture__/wire-in/scenario.json \
   --wire-in src/cli/__fixture__/wire-in/wire
```

它当场搭一个真工作区（`git init` + 一个底提交）、起一轮，把读数摊开在 `/tmp/live-w11-out/`（`before.txt` · `run.log` · `after.txt` · `watch.log` · `wire/`）。`run.log` 里这一趟的实测（摘录，末行的价格表略）：

```text
漂移检：HEAD 没动 · 这次合并动到 [notes.md] · 盘上与目标树不同 [] · 会被覆盖的（盘上既不是底也不是目标树）[（没有）]
  契约 1 份：r1.implement.1
  折叠：折了 0 步
  验收：通过 2 · 没通过 0 · 跑不起来 0
  推进：写 1 条 · 删 0 条 · 跳过 2 条
  停因：agent/r1/1 3 步 · 收敛
  合计 调用 3 · input 2907 · cacheRead 4864 · cacheWrite 0 · output 195 · 思考 0（缺 3 条） · 费用 ≈ $0.000568
```

`cacheRead 4864 / input 2907` 是这套结构干活的样子：前缀分三区（A 稳定 · B 每格的任务 · C 每一步的处境），相邻两步只有 C 区变——那一趟的第 2 步只新发了 172 个 token。（底提交的哈希每次都不一样：工作区是当场建的。）

### 先说清楚：讨论态

一句话进去之前，你可以先跟它把话说明白。讨论态里它**不碰你的工作树**——讨论原文按轮写进
`.fugue/session/<轮次>.jsonl`（一行一条，原文照抄）：

```sh
fugue say "记账模块先只做金额格式化，avg 那一条先别动"     # 缺省就走真模型（花钱）
fugue say "旧文件先留着，别删"
```

它回的那段话落成**修正后的理解**（`holder/distill`）——那就是"拆"这一步的输入。**从讨论走到拆的那一脚
由你踩**：`fugue round plan <目标>`（永远可用），或者在讨论里说一句"可以开始了"，它认出来就替你踩。
轮次号缺省 `r1`，`fugue config set round.id <名>` 可以换。

### 第一次用它干真活

在**你自己的项目**里（一个 git 仓库）：

```sh
cd <你的项目>
echo .fugue/ >> .git/info/exclude         # 它的账写在这儿，别让它进你的提交

# 一 · 先告诉它什么叫"过了"——它自己不猜：动作名 → 真命令，它拆的时候从这份表里挑断言
fugue config set actions.test '{"argv":["/bin/sh","-c","npm test"]}'
fugue config set round.id r1              # 这一轮叫什么

# 二 · 把一句话交给它。--live 走真模型（花钱）；第一次联网把上界压到个位数
fugue round plan "把记账模块补完：金额按分格式化 · 加一个 avg · 删掉过时的旧文件" --live --max-steps 8

# 三 · 看它拆出来的那一份（停在门口，一个契约都不发），点头
fugue round go

# 四 · 让它们干完（断言从契约里来，命令行从上面那份 actions 表里来）
fugue round work --live --max-steps 8
```

想自己定拆法（不让它拆）：`fugue config set round.split '[…]'` + `fugue config set round.assertions '[…]'`，然后 `fugue round run "<目标>" --live` 一趟到底。

**花多少钱**：一趟真活按 2 格 × 64 步估，量级是**几毛钱**；不给 `--max-steps` 就是不设上界（上界是你的决策，不是它的兜底）。

### 一边看一边按

`fugue tui`——`g` 放行 · `?` 重印提示 · `q` 退出。它**不接管屏幕**（历史留在终端里，底部一块恒定 12 行的面板）；不是 TTY 时退到"只印永久行"，一个字节的 ANSI 都不写。**`round go` 与 TUI 里按 `g` 是同一条命令**——界面自己不改契约。

### 随时看它在干什么

| 你想 | 一条命令 |
|---|---|
| 这一刻的处境（轮次 · 每格走到哪 · 用量与条数） | `fugue status --once` |
| 再加上八元指标与三个打回数 | `fugue status --once --metrics --report` |
| 账本身（一行一条，不渲染 · 不筛选） | `fugue log` |
| 跟着看（纯读：不取锁 · 不写账） | `fugue watch --follow` |
| 一面看一面按键 | `fugue tui` |
| 收走它铺出来的物化树 | `fugue dispose` |

跑完 `git status` 会瞎红一下：盘上那棵树与它定格的那个提交**逐字节一致**，而 git 的索引留在底那一版——`git reset` 就和上了（它不偷偷改你的索引）。

## 它是怎么做到的

真源只有两处：**git 对象库**与**一份只追加的事件账**（`.fugue/log/`，一行一条，按 `(seq, writer)` 全序）。视图 · 物化树 · 前缀 · 读数都是从这两处派生的，不落第二份真相——所以它停在半路、或者被杀了再来一趟，账上读到的都是同一件事。

## 这一版不做什么

- **模型自己不能派子 agent**（工具目录里没有 `subagent` / `list_agents` / `send_message`）。
- **只有两条模型声明**：`deepseek-flash` 的 anthropic 与 openai 两个端点。
- **不发 npm 包** · **不许有运行时依赖**（TUI 的 ANSI 是手写的）· 除了模型端点不出网。
- 没有整屏 TUI · 没有颜色 · 没有鼠标 · 没有多面板。

## 想要更多

- `fugue --help`：全部 26 条命令，每条都有"它是什么 · 参数 · 退出码"。
- 想改它、想验它：[AGENTS.md](AGENTS.md)（环境 · 验收入口 · 走查 · 送文件进来的路）与 [tools/](tools/)（走查 · 探针 · 基准，**取证用的，不是产品的一部分**）。
- 它为什么长成这样：三份设计文档（架构 · 计划 · 第一版之后的目标）不在这个仓库里。

## 维护者

[54shitaimzf](https://github.com/54shitaimzf)（唯一维护者）。

## 贡献

- 问题与改动走这个仓库的 Issues 与 Pull Request。
- 进门条件只有一条：`node tools/test-entry.js` 全绿——CI 跑的就是它。
- **不许引运行时依赖、不许加构建步骤**：这不是偏好，是它的架构前提（Node 直跑 `.ts`）。
- 动手之前先读 [AGENTS.md](AGENTS.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。© 2026 54shitaimzf
