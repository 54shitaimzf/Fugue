# 赋格 _(fugue)_

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/fugue-lockup-inv.svg">
    <img src="assets/brand/fugue-lockup.svg" alt="赋格 · fugue" height="96">
  </picture>
</p>

[![test](https://github.com/54shitaimzf/Fugue/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/54shitaimzf/Fugue/actions/workflows/test.yml?query=branch%3Amain)

赋格是一个在终端里用的编程助手。你告诉它想做什么，它会先和你把需求聊清楚，然后自己拆分任务、写代码、跑测试。

它最重要的一个特点是：**测试没全部通过之前，它不会碰你的文件。** 中途失败了，你的项目还是原来的样子，不会留下改了一半的代码。

## 它怎么工作

假设你对它说：

> 把记账模块补完：金额按分格式化、加一个 `avg`、删掉过时的旧文件。

它会按下面五步来做。每一步结束时你都能看到它做了什么。

1. **聊需求。** 它会读你的项目（代码、提交历史、项目里写的规范），有不清楚的地方就问你。这一步只读不写。聊得差不多了，你可以运行 `fugue round plan <目标>`，或者直接在对话里说「可以开始了」，它能听懂。
2. **拆任务。** 它把目标拆成几个能独立完成的小任务，每个都写明要交付什么、会改哪些文件、怎样算做完。拆完后它会停下来，等你确认。
3. **写代码。** 你确认之后（运行 `fugue round go`），每个小任务在各自的隔离目录里进行，互不影响。这段时间你的项目文件完全不会被改动。
4. **跑检查。** 所有小任务做完后，它把结果合并起来，运行事先定好的检查。没通过就让对应的任务重做；重做还不过，就放弃这一轮。
5. **写回项目。** 检查全部通过后，它才生成一个 git 提交，并把改动写回你的项目。只要中间任何一步失败，你的文件就保持原样，也不会留下多余的分支。

它做的每一件事都会记在项目的 `.fugue/` 目录里。这份记录只会往后追加，不会被修改，所以你随时可以查它现在在干什么、上一次为什么停下。

还有一点：**它不会覆盖你自己手动改过的文件。** 写回之前，它会检查项目里有没有既不是你原来的版本、也不是它这次生成的改动。如果有，它会一条条列出来，而不是直接覆盖。

## 安装

你需要准备：

- **Linux 或 WSL2。** 项目要放在 ext4 这类 Linux 原生文件系统上，Windows 的 NTFS 分区不行。
- **Node 22.6 或更高版本。** 它直接运行 `.ts` 文件，不需要编译。
- **git 2.38 或更高版本。**

```sh
git clone https://github.com/54shitaimzf/Fugue.git ~/fugue && cd ~/fugue
ln -s "$PWD/bin/fugue" ~/.local/bin/fugue      # 或者用 npm i -g .
fugue --help                                   # 命令速查表：每条命令带一两句说明
```

它没有任何第三方依赖，`package.json` 里的 `dependencies` 是空的，所以不用 `npm install`。

要连接真实的大模型，你需要一个 API 密钥。配置里保存的是「密钥放在哪里」（环境变量名或密钥文件路径），密钥本身不会写进配置、日志或它生成的任何文件。在系统级配置里配一张查找表，整台机器配一次：

```sh
fugue config set --system credentials.deepseek \
  '[{"from":"env","name":"DEEPSEEK_API_KEY"},{"from":"file","path":"<密钥文件的路径>"}]'
```

用的时候它按这张表逐条找：先看环境变量 `DEEPSEEK_API_KEY`，没有再读那份文件。临时换一份密钥文件，运行时给 `--credential <文件路径>`：没配过表的，这一条自己就是一条路；配过表的，它换掉表里的文件那一栏（环境变量那一栏仍排在前面）。什么都没配时它会当场报错，并把上面这条配法原样告诉你。

模型列表和价格放在全局配置目录 `~/.fugue/` 里。如果你创建了 `~/.fugue/models.json`，它会完全替换掉内置的模型列表。每个项目自己的配置只会覆盖它写了的那几项，其他的沿用全局设置。

## 先试一下（不联网、不花钱，半分钟跑完）

下面这条命令用的是**提前录好的真实模型回复**，不需要 API 密钥，任何人都能直接跑：

```sh
git clone https://github.com/54shitaimzf/Fugue.git fugue && cd fugue
sh tools/live-round.sh src/cli/__fixture__/wire-in/scenario.json \
   --wire-in src/cli/__fixture__/wire-in/wire
```

它会现场新建一个 git 仓库，完整跑一遍流程，然后把结果放在 `/tmp/live-w11-out/` 目录下，包括 `before.txt`、`run.log`、`after.txt`、`watch.log` 和 `wire/`。

下面是 `run.log` 里的一段实际输出（省略了最后的价格表）：

```text
漂移检：HEAD 没动 · 这次合并动到 [notes.md] · 盘上与目标树不同 [] · 会被覆盖的（盘上既不是底也不是目标树）[（没有）]
  契约 1 份：r1.implement.1
  预检：Planning 0 对 · 合并前 0 对
  折叠：折了 0 步
  验收：通过 2 · 没通过 0 · 跑不起来 0
  推进：写 1 条 · 删 0 条 · 跳过 2 条
  停因：agent/r1/1 3 步 · 收敛
  合计 调用 3 · input 2762 · cacheRead 4992 · cacheWrite 0 · output 140 · 思考 0（缺 3 条） · 费用 ≈ $0.000513
```

注意 `cacheRead 4992` 比 `input 2762` 还多，说明大部分内容都命中了缓存，这就是它省钱的原因。它发给模型的内容分成三段：项目背景、当前任务说明、当前这一步的进展。前两段在每一步之间基本不变，只有第三段在增长。所以在这次运行里，第 2 步只需要多发 150 个 token。

（每次运行生成的提交哈希都不一样，因为仓库是现场新建的。）

## 使用方法

### 先聊清楚需求

开始干活之前，你可以先和它聊几句。聊天内容会原样保存到 `.fugue/session/`，之后拆任务时它会参考这些内容：

```sh
fugue say "记账模块先只做金额格式化，avg 那一条先别动"     # 默认调用真实模型，会产生费用
fugue say "旧文件先留着，别删"
```

什么时候从聊天进入拆任务，由你决定：运行 `fugue round plan <目标>`，或者在对话里说「可以开始了」。每一轮任务默认叫 `r1`，想改名可以用 `fugue config set round.id <名字>`。

### 在自己的项目里用

在**你自己的项目**里（必须是 git 仓库）运行：

```sh
cd <你的项目>
echo .fugue/ >> .git/info/exclude         # 它的工作记录放在 .fugue/ 里，别让这个目录进入你的提交

# 第一步：告诉它用什么命令判断「做对了」。它不会自己猜，你要给检查起个名字，再绑定一条命令
fugue config set actions.test '{"argv":["/bin/sh","-c","npm test"]}'
fugue config set round.id r1              # 给这一轮任务起个名字

# 第二步：把目标交给它。--live 表示调用真实模型，会产生费用。第一次用建议把步数上限设小一点
fugue round plan "把记账模块补完：金额按分格式化 · 加一个 avg · 删掉过时的旧文件" --live --max-steps 8

# 第三步：看它拆出来的任务列表（这时它在等你，还没改任何文件），没问题就确认
fugue round go

# 第四步：让它把任务做完（要跑哪些检查写在任务列表里，具体命令就是第一步绑定的那条）
fugue round work --live --max-steps 8
```

如果你想自己决定怎么拆任务，而不是让它来拆：先用 `fugue config set round.split '[…]'` 和 `fugue config set round.assertions '[…]'` 写好任务和检查，再运行 `fugue round run "<目标>" --live`，一条命令从头跑到尾。

想知道配置认得的顶层键有哪些，用 `fugue config ls`：一行一个键，`--json` 那一面是数组。它不读你的配置，所以配置有毛病的时候它照样答得出；要看当下配了什么，用 `fugue config show`。

**费用参考：** 一次真实任务按 2 个子任务、每个最多 64 步来估算，大概花几毛钱。如果不加 `--max-steps`，就没有步数限制。要不要设上限、设多少，由你自己决定，它不会自动帮你限制。

### 边看边操作

运行 `fugue tui` 会在终端底部显示一个状态面板，普通输出照常往上滚动，翻页、搜索、复制都和平时用终端一样。面板大约占终端高度的五分之二（弹出窗口时会高一些），大部分空间还是留给输出。

快捷键：`g` 确认执行，`?` 显示按键说明，`q` 退出。

这个界面**只是用来看的**，本身不修改任何东西。在界面里按 `g`，和在命令行里运行 `fugue round go` 效果完全一样。如果输出不是终端（比如通过管道传给别的程序，或者在 CI 里运行），它会自动改成逐行打印事件，不会输出任何终端控制字符。

### 查看进度

| 你想知道 | 运行这条命令 |
|---|---|
| 现在的状态：在跑哪一轮、每个子任务到哪一步了、花了多少钱 | `fugue status --once` |
| 上面的信息，再加上质量指标和打回次数统计 | `fugue status --once --metrics --report` |
| 原始的工作记录（每行一条，不做任何处理） | `fugue log` |
| 实时跟踪进度（只读，不会影响正在运行的任务） | `fugue watch --follow` |
| 一边看一边用快捷键操作 | `fugue tui` |
| 清理它创建的临时工作目录 | `fugue dispose` |

任务完成后，`git status` 可能会显示很多文件有改动，这是正常的。你项目里的文件已经和它生成的提交完全一致了，只是 git 的暂存区（index）还停在旧版本。运行一次 `git reset` 就好了。它故意不去动你的暂存区。

## 它为什么可靠

它只以两样东西为准：**git 仓库本身**，和 **`.fugue/log/` 里的工作记录**（只追加、不修改，每行一条）。

它看到的文件内容、创建的临时目录、发给模型的内容、显示给你的各种统计，全都是从这两样东西推算出来的，不会另外保存一份。所以就算它中途停下，或者进程被杀掉后重新运行，读到的状态也是一致的。

## 目前还不支持的

- 模型不能自己再创建新的子助手。
- 只内置了一个模型 `deepseek-flash`，提供 Anthropic 和 OpenAI 两种接口格式。
- 不发布到 npm，也不允许任何运行时依赖（终端界面的显示效果都是手写的）。除了调用模型接口，它不会访问网络。
- 界面样式很简单：只有普通、变暗（用于边框）、加粗（用于弹出窗口）三种效果，没有配色方案，不支持鼠标，也不能分屏。

## 更多资料

- `fugue --help`：命令速查表，每条都有一两句话说明。命令面一共 28 条（`round` 有 5 条子命令、`config` 有 4 条）；命令全表在架构 § 9.6。
- 每个版本的改动：[CHANGELOG.md](CHANGELOG.md)。
- 想修改或测试赋格本身：先看 [AGENTS.md](AGENTS.md)（开发环境、怎么跑测试、演示脚本），再看 [tools/](tools/)（演示脚本、测量工具和性能测试，它们只用于开发，不属于产品）。
- 设计文档在 [design/](design/)：架构（这一版**是**什么）· 路线图（按什么次序收口）· 目标（第一版之后做什么）· 随笔（为什么这么设计）。落地计划（正在做的那一站）与归档（已经落地的那一份）随施工走，不在这个仓库里。

## 维护者

[54shitaimzf](https://github.com/54shitaimzf)（目前唯一的维护者）。

## 贡献者

- [StevenLi-phoenix](https://github.com/StevenLi-phoenix)：修复了文件权限比较的问题。以前在 `umask 002` 的机器上，没改过的文件会被误认为改过，导致任务被拒绝；软链接则在所有机器上都会被误判。这次修复还附带了四个回归测试（[#1](https://github.com/54shitaimzf/Fugue/issues/1)、[#3](https://github.com/54shitaimzf/Fugue/pull/3)）。

## 参与贡献

- 报告问题或提交修改，请使用本仓库的 Issues 和 Pull Request。
- 合并的唯一条件：`node tools/test-entry.js` 全部通过。CI 跑的也是这条命令。
- **不能添加运行时依赖，也不能增加构建步骤。** 这不是个人喜好，而是整个设计的前提：Node 要能直接运行 `.ts` 源文件。
- 动手之前，请先读 [AGENTS.md](AGENTS.md)。

## 许可证

MIT，详见 [LICENSE](LICENSE)。© 2026 54shitaimzf
