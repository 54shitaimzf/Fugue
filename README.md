# 赋格 _(fugue)_

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/fugue-lockup-inv.svg">
    <img src="assets/brand/fugue-lockup.svg" alt="赋格 · fugue" height="96">
  </picture>
</p>

[![test](https://github.com/54shitaimzf/Fugue/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/54shitaimzf/Fugue/actions/workflows/test.yml?query=branch%3Amain)

住在终端里的编码 agent：你说一句想要什么，它先跟你把话说明白，然后自己拆活 · 自己干 · 自己验——**全部通过才动你的文件**。

**说清再动手，全过才落地。没过，你的文件一个字节都不动。**

## 它怎么干活

一句目标，比如：

> 把记账模块补完：金额按分格式化、加一个 `avg`、删掉过时的旧文件。

它分五步走，**每一步都停在你看得见的地方**：

| 步 | 做什么 |
|---|---|
| 一 · 说 | 先跟你聊清楚。它读你的项目（方针 · 代码 · 历史），来回问你；这一步不碰你的文件。聊够了由你说「开始」：`fugue round plan <目标>`，或者直接在对话里说「可以开始了」，它认得出来 |
| 二 · 拆 | 把目标拆成几份能各自交付的活，**停下来等你点头**：每份交什么 · 会动哪几个文件 · 怎么才算过 |
| 三 · 干 | 你点头（`fugue round go`）之后，每份活在自己的独立工作区里干，互不打扰——这期间你的文件一个字节都不动 |
| 四 · 验 | 把几份活合起来，跑它自己声明过的检查；没过就回炉重干，再不过就打回 |
| 五 · 落 | 全过才写一个提交、推进你的主线；任何一步没过，你的文件保持原样——不留半成品、不留垃圾分支 |

它做的每件事都记在工作区里一份**只追加的账**（`.fugue/`）：你随时能看它在干什么，也随时能看它为什么停。

一条硬边界：你手上正在改的文件就是底线。哪一份盘上的改动既不是你改的、也不是它这次算出来的，它在落地前会逐条报出来——**不会盖掉你的手改**。

## 安装

前置三样：

- **Linux 或 WSL2**：仓库要放在 ext4 这类原生文件系统上（Windows 原生 NTFS 不行）。
- **Node ≥ 22.6**：`.ts` 直接跑，没有构建步骤。
- **git ≥ 2.38**。

```sh
git clone https://github.com/54shitaimzf/Fugue.git ~/fugue && cd ~/fugue
ln -s "$PWD/bin/fugue" ~/.local/bin/fugue      # 或者：npm i -g .
fugue --help                                   # 27 条命令（round 5 条子命令 · config 3 条）
```

没有依赖要装：`package.json` 里 `dependencies` 是空的。接真模型要一份凭据，按提供方的声明取——环境变量 `DEEPSEEK_API_KEY`，或 `~/.fugue/credentials/deepseek.key`；命令行 `--credential <路径>` 覆盖。模型目录与价目住系统级那一份（`~/.fugue/`）：`~/.fugue/models.json` 在场时整份替换内置目录，工作区配置只覆盖自己的键。

## 先看它干一趟真的（不出网 · 不花钱 · 半分钟）

这一趟走的是**录下来的真响应**，一条命令，谁都能跑：

```sh
git clone https://github.com/54shitaimzf/Fugue.git fugue && cd fugue
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
  合计 调用 3 · input 2762 · cacheRead 4992 · cacheWrite 0 · output 140 · 思考 0（缺 3 条） · 费用 ≈ $0.000513
```

`cacheRead 4992 / input 2762` 是这套结构省钱的样子：给模型的上下文分三区（稳定的项目背景 · 每份活自己的任务 · 每一步的处境），相邻两步只有第三区在变——那一趟的第 2 步只新发了 150 个 token。（底提交的哈希每次都不一样：工作区是当场建的。）

## 上手

### 先把话说明白

动工之前，你可以先跟它聊。聊的内容它记下来（`.fugue/session/`，原文照抄），拆活的时候照着来：

```sh
fugue say "记账模块先只做金额格式化，avg 那一条先别动"     # 默认走真模型（花钱）
fugue say "旧文件先留着，别删"
```

从聊到拆的那一脚由你踩：`fugue round plan <目标>`，或者在对话里说一句「可以开始了」。轮次号缺省 `r1`，`fugue config set round.id <名>` 可以换。

### 第一次让它干真活

在**你自己的项目**里（一个 git 仓库）：

```sh
cd <你的项目>
echo .fugue/ >> .git/info/exclude         # 它的账写在这儿，别让它进你的提交

# 一 · 先告诉它什么叫「过了」——它自己不猜：起一个动作名，绑一条真命令
fugue config set actions.test '{"argv":["/bin/sh","-c","npm test"]}'
fugue config set round.id r1              # 这一轮叫什么

# 二 · 把一句话交给它（--live 走真模型，花钱；第一次联网把步数上界压到个位数）
fugue round plan "把记账模块补完：金额按分格式化 · 加一个 avg · 删掉过时的旧文件" --live --max-steps 8

# 三 · 看它拆出来的那一份（停在那儿等你，一个文件都没动），点头
fugue round go

# 四 · 让它们干完（检查从计划里来，命令从上面那条 actions 绑定来）
fugue round work --live --max-steps 8
```

想自己定拆法（不让它拆）：`fugue config set round.split '[…]'` + `fugue config set round.assertions '[…]'`，然后 `fugue round run "<目标>" --live` 一趟到底。

**花多少钱**：一趟真活按 2 份活 × 64 步估，量级是几毛钱；不给 `--max-steps` 就是不设上界（上界是你的决策，不是它的兜底）。

### 一边看一边按

`fugue tui`——底部一块面板显示情况，输出照常往上滚，翻历史 · 搜索 · 复制都还是终端自己的；面板高度跟着终端走（大约占五分之二，弹层打开时高一些），永远给输出留着大头。`g` 放行 · `?` 重印按键提示 · `q` 退出。它**只看不写**：界面里按 `g` 和在命令行敲 `round go` 是同一条命令。不是终端的场合（管道 · CI）它自动退成「只把事件印一遍」，一个转义序列都不写。

### 随时看它在干什么

| 你想 | 一条命令 |
|---|---|
| 这一刻的情况（轮次 · 每份活走到哪 · 花了多少） | `fugue status --once` |
| 再加上质量指标与打回统计 | `fugue status --once --metrics --report` |
| 账本身（一行一条，不加工） | `fugue log` |
| 跟着看（纯读：不取锁 · 不写账） | `fugue watch --follow` |
| 一面看一面按键 | `fugue tui` |
| 收走它铺出来的工作区 | `fugue dispose` |

跑完 `git status` 会瞎红一下：盘上那棵树与它定格的那个提交**逐字节一致**，而 git 的索引留在底那一版——`git reset` 就和上了（它不偷偷改你的索引）。

## 它是怎么做到的

真源只有两处：**git 对象库**与**一份只追加的事件账**（`.fugue/log/`，一行一条）。它眼里的文件、它铺出来的工作区、给模型的上下文、所有读数——都是从这两处算出来的，不落第二份真相。所以它停在半路、或者被杀了再来一趟，账上读到的都是同一件事。

## 这一版不做什么

- **模型自己不能派子 agent**。
- **只有两条模型声明**：`deepseek-flash` 的 anthropic 与 openai 两个端点。
- **不发 npm 包** · **不许有运行时依赖**（TUI 的 ANSI 是手写的）· 除了模型端点不出网。
- 样式只有黑白两档属性（边框暗一档 · 弹层加粗）；没有配色方案 · 没有鼠标 · 没有多面板。

## 想要更多

- `fugue --help`：全部 27 条命令，每条一两句说清它是干什么的。
- 每一版变了什么：[CHANGELOG.md](CHANGELOG.md)。
- 想改它、想验它：[AGENTS.md](AGENTS.md)（环境 · 验收入口 · 走查）与 [tools/](tools/)（走查 · 探针 · 基准，**取证用的，不是产品的一部分**）。
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
