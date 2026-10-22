## 它替你做哪一步 {#what-it-does}

你给它一句目标，它先把话聊清楚，再把目标拆成几份能各自做完、各自验收的任务。每份任务在自己的隔离目录里写，写完之后合并、跑你事先定好的验收命令。**只有验收全过，它才生成一个 git 提交、把改动写回你的项目。** 中间任何一步没过，你的工作树保持原样，也不会留下改了一半的分支。

```text
fugue say "…"            ─┐
fugue round plan "…"      │  只读 + 拆任务，停在门口等你
fugue round go            ├─ 你在门口点头
fugue round work --live  ─┘  隔离目录里写 → 合并 → 跑验收
                                全过 → 一个 git 提交写回工作树
                                没过 → 工作树原样，不留多余分支
每一步转移都追加一行到 .fugue/log/（只追加，不改）
```

它只在两样东西上记账：你的 git 仓库本身，和项目里的 `.fugue/log/`。所以进程被杀、机器断电之后重新敲命令，读到的还是同一份状态。机制怎么成立、每一层为什么这样切，在[架构](architecture.html)那一页，这页不重复。

## 装好它 {#install}

前置条件三条，缺一条就卡在第一步：

- **Linux 或 WSL2**，项目要放在 ext4 这类 Linux 原生文件系统上。这一条不是建议：每条命令启动时都会探落点（`src/cli/fugue.ts` 里的 `assertHost`），落在 9p / drvfs 那一类跨内核落点上时**拒绝启动**，退 1。`fugue --help` 与 `fugue --version` 不受影响。
- **Node 22.6 或更高**。`package.json` 的 `engines` 写的就是 `>=22.6`，它直跑 `.ts`，不用编译。
- **git**。README 要求 2.38 或更高；这一版树里只有 Node 那条声明（`engines`），git 的版本没有任何地方声明，按 README 备着。

装法就是把它放到 `PATH` 上。三种都指向同一个壳：

::: tabs
::: tab 软链（README 主推）
```sh
git clone https://github.com/54shitaimzf/Fugue.git ~/fugue && cd ~/fugue
ln -s "$PWD/bin/fugue" ~/.local/bin/fugue
```
`bin/fugue` 是一个 sh 壳，它会顺着软链找自己，所以链到哪都行。它只做一件事：`exec "${FUGUE_NODE:-node}" "$home/src/cli/fugue.ts" "$@"`——**一次 exec，不认识任何命令**，所以 `fugue …` 与 `node <仓库>/src/cli/fugue.ts …` 是同一次调用、同一个退出码。
:::
::: tab npm i -g .
```sh
git clone https://github.com/54shitaimzf/Fugue.git ~/fugue && cd ~/fugue
npm i -g .
```
`package.json` 的 `bin.fugue` 指到 `bin/fugue`，装上去的还是同一个壳。这个包是 `private: true`，装的是本地目录，不是从 npm 下载。
:::
::: tab 不装，直接用 node
```sh
node ~/fugue/src/cli/fugue.ts --help
node ~/fugue/src/cli/fugue.ts round plan "…" --live
```
:::
:::

装完先验两条，都不碰工作区：

```sh
fugue --version
fugue --help
```

`--version` 打印 `fugue 0.5.2`（名字与版本读自安装目录里的 `package.json`，与你在哪个目录无关）。`--help` 印出命令速查表，**退 0**——它是成功的一条命令；什么都不给才是用法错，退 2。

`fugue: command not found` 说明 `~/.local/bin` 不在 `PATH` 上，不是仓库坏了：先用 `node ~/fugue/src/cli/fugue.ts --help` 确认仓库本身好用，再把那个目录加进 `PATH`。

环境合不合适，可以让它自己报一遍：

```sh
fugue doctor
```

纯读、不落盘，一行一项（`ok` 或 `缺`）。**「缺」是读数不是失败**，它照旧退 0；唯一退 1 的情形是连落点都问不出来（`statfs` 失败），那是自检自己跑不了。

## 半分钟跑通一遍 {#first-run}

这一趟喂的是**提前录好的模型回复**（回放档 `--wire-in`），不出网、不读凭据、不花钱：

```sh
git clone https://github.com/54shitaimzf/Fugue.git fugue && cd fugue
sh tools/live-round.sh src/cli/__fixture__/wire-in/scenario.json \
   --wire-in src/cli/__fixture__/wire-in/wire
```

它会现场新建一个 git 仓库（`/tmp/live-w11`）、跑完一轮，然后打印两行：

```text
EXIT=0
读数：/tmp/live-w11-out/before.txt · /tmp/live-w11-out/run.log · /tmp/live-w11-out/after.txt · /tmp/live-w11-out/watch.log · /tmp/live-w11-out/wire/
```

看到这两行就是跑通了。`EXIT=0` 是那一轮的退出码，不是脚本自己的。**每次重跑会先删掉 `/tmp/live-w11` 与 `/tmp/live-w11-out`**；想留着上一次的读数，用 `--work <目录> --out <目录>` 换落点。

四个文件各答一件事：

| 文件 | 看什么 |
|---|---|
| `before.txt` | 起头那一刻的 `status --once`：上下文、场景、主线提交 |
| `run.log` | 那一轮的全部读数：漂移检、验收、推进、停因、用量 |
| `after.txt` | 收尾的 `status --once`、`watch` 跟到几行、以及**工作树与定格提交两棵树的哈希** |
| `watch.log` | 后台 `watch --follow` 跟下来的那份账 |

`after.txt` 里最该看的是这一行：

```text
工作树 <哈希> · 定格提交 <哈希>
一致 ✓
```

`一致 ✓` 意思是：写回之后你工作树里的内容，与它生成的那个提交逐字节相同（`.fugue/` 除外）。这就是"写回"到底做到了什么。

`run.log` 里两行值得对照：

```text
漂移检：… 会被覆盖的（盘上既不是底也不是目标树）[（没有）]
  验收：通过 2 · 没通过 0 · 跑不起来 0
```

第一行是"它会不会盖掉你手改的东西"的判据，第二行是"验收过了几条"。README 里录了同一份场景的一段实际输出（`调用 3 · input 2762 · cacheRead 4992 · 费用 ≈ $0.000513`），可以拿来对照——数字随版本和场景变，形状不变。

::: warn 这份脚本的 `--live` 档不通用
`tools/live-round.sh` 的真档在脚本里写死了作者机器上的密钥路径（`/home/ubuntu/.fugue/credentials/deepseek.key`），换台机器跑不通。它在回放档（`--wire-in`）完全不读凭据，所以上手那一趟不受影响。要在自己的项目里用真模型，走下一节的凭据配法。
:::

## 在自己的项目里跑第一条真命令 {#own-project}

前提：那个目录**已经是 git 仓库**，并且你已经把它放到 Linux 原生文件系统上。

::: steps
1. **把它的工作记录挡在提交之外。** 进到你的项目，把 `.fugue/` 写进 `.git/info/exclude`：
   ```sh
   cd <你的项目>
   echo .fugue/ >> .git/info/exclude
   ```
   没有输出就是对了。这一步不做，`.fugue/` 会进你的提交。

2. **告诉它用什么命令判断「做对了」。** 它不猜。给检查起个名字，绑一条命令：
   ```sh
   fugue config set actions.test '{"argv":["/bin/sh","-c","npm test"]}'
   ```
   看到三列：`actions.test`、旧值 `(没有)`、`→` 后面是刚写进去的 JSON。写的是**值**，不是字符串——`{"argv":[…]}` 会被当成 JSON 解析（`src/config.ts` 的 `parseConfigValue`）。

3. **给这一轮起个名字**（不起就是 `r1`）：
   ```sh
   fugue config set round.id r1
   ```
   同样三列输出。

4. **把目标交给它，让它拆。** `--live` 表示调用真实模型、会产生费用：
   ```sh
   fugue round plan "把记账模块补完：金额按分格式化 · 加一个 avg · 删掉过时的旧文件" --live --max-steps 8
   ```
   第一次用就把 `--max-steps` 设小。它只收正整数；不给这个开关就**没有步数上限**，它不会自动帮你限制。这一步结束它停在门口等你，没改你任何文件。

5. **看清它拆了什么，然后点头。**
   ```sh
   fugue round go
   ```
   这是放行整批任务。在 `fugue tui` 里按 `y` 与敲这条命令**完全等价**。

6. **推到做完。**
   ```sh
   fugue round work --live --max-steps 8
   ```
   合并、跑验收、写回。结束后 `git log --oneline` 应该多一个提交；如果没多，就是验收没过，你的工作树还是原来的样子——`fugue status --once` 与 `fugue recover` 会说停在哪。
:::

跑完之后 `git status` 可能一片红，这是**正常**的：它故意不碰你的暂存区，索引还停在旧版本。运行一次 `git reset` 就对齐了。

想换一种方式定任务，三种路子的差别在这里：

| 怎么定任务 | 命令 | 要模型吗 |
|---|---|---|
| 让它拆 | `fugue round plan "<目标>" --live` 然后 `round go` · `round work` | 要，花钱 |
| 自己拆 | 先 `config set round.split '[…]'` 与 `round.assertions '[…]'`，再 `fugue round new "<目标>"` | 不要——`round new` 的开关表里没有 `--live`，它只读配置 |
| 一条命令跑完 | 配好 `round.split` 与 `round.assertions` 后 `fugue round run "<目标>" --live` | 要，花钱 |

要连真实模型，先配凭据的**引用**（不是密钥本身）：配置里存的是"密钥放在哪里"，密钥不会写进配置、日志或它生成的任何文件。整台机器配一次：

```sh
fugue config set --system credentials.deepseek \
  '[{"from":"env","name":"DEEPSEEK_API_KEY"},{"from":"file","path":"<密钥文件的路径>"}]'
```

`--system` 写的是系统级那一级（`~/.fugue/config`，`config.ts` 的 `defaultSystemDir`）；不带它写工作区级。读的时候合并：工作区覆盖系统级，写永远只落一级。什么都没配而这一趟要出网时，它当场退 1，并把上面这条配法原样告诉你。

::: note 关于费用
一次真实任务按 2 个子任务、每个最多 64 步估算，大概是几毛钱（README 的口径）。真正的上界由 `--max-steps` 给，只收正整数，`--max-steps abc` 或 `0` 当场退 2。
:::

## 结果落在哪里 {#where}

**项目的 `.fugue/` 是它的全部记录**，都在你的工作树里（所以第 1 步要把它排掉）：

| 里面是什么 | 位置 | 谁写 |
|---|---|---|
| 这个项目那一级配置 | `.fugue/config` | 只有 `fugue config set` |
| 只追加的账（每次转移一行） | `.fugue/log/` | 各命令自己 |
| `fugue say` 的对话原文 | `.fugue/session/` | `say` |
| 生成的文档产物 | `.fugue/docs/`（`index.html` 是入口） | `fugue docs build` |

人这一侧看账，按你想知道的选一条：

| 你想知道 | 运行这条命令 |
|---|---|
| 现在哪一轮、每个任务到哪、花了多少 | `fugue status --once` |
| 上面这些，再加质量指标与打回统计 | `fugue status --once --metrics --report` |
| 每一笔调用的耗时与费用（从日志重算） | `fugue status --ledger` |
| 原始记录，一行一条，不做处理 | `fugue log` |
| 实时跟（只读，不影响正在跑的那一轮） | `fugue watch --follow` |
| 一边看一边用快捷键 | `fugue tui` |
| 上一次写回有没有收尾、现在该做什么 | `fugue recover` |
| 清掉它建的临时工作目录 | `fugue dispose` |

脚本里要等一个状态，用等待档：

```sh
fugue status --wait Working --timeout 60
```

每半秒看一次；等到了就印那一刻的状态、退 0，到点没等到就如实说一句、退 1——**超时不会被当成成功**。`--timeout` 不给是 30 秒。等的状态名以 `fugue status --once` 实际印出来的为准（README 给的那一族是 `Idle` · `Planning` · `Delegated` · `Working` · `Collecting` · `Merging` · `Verifying` · `Committed` · `Rebuilding` · `Aborted`）。

`fugue tui` 那块终端底部的操作区**自己不改任何东西**：界面里的每一个动作都是一条 `fugue` 命令，由它起的子进程去执行——按 `y` 与在命令行里敲 `fugue round go` 落下的账逐字节相同（`src/ui/run.ts`）。输出不是终端时（管道、CI）它自动改成逐行打印事件，不留控制字符，退出后屏幕上不留旧框。界面细节与按键表在[架构](architecture.html)§ 9 那一带，这里不铺。

::: details 它还写了一些可弃的派生文件
V8 的编译缓存落在 `$XDG_CACHE_HOME/fugue/compile-cache`（没设就是 `~/.cache/fugue/compile-cache`，`src/cli/boot.ts`）。这是**可弃派生体**：删掉重来，同一条命令读出来的字节逐字节相同；目录建不出来只是慢一点，进程照跑。不想留它就给 `FUGUE_COMPILE_CACHE=off`。
:::

## 卡在哪一步：退出码与常见拒绝 {#stuck}

退出码只有三种，这条界线是给脚本用的：**0 做成了 · 1 命令成立但这件事没做成 · 2 命令行本身不成立**（`src/cli/fugue.ts` 的 `main`）。

| 你看到的 | 卡在哪 | 怎么办 |
|---|---|---|
| `需要一个命令` | 只敲了 `fugue` | `fugue --help` 看那 31 条 |
| `未知命令：xxx` | 命令名写错 | round 的子命令只有 `new` · `plan` · `go` · `run` · `work`；`docs` 只有 `build` · `status` · `prompt` |
| `xxx 不认这几个开关：--yyy——这一条命令认的是 …` | 把别条命令的开关安到这条上（例如给 `round go` 加 `--live`：它的表里只有 `--root` · `--agent` · `--json` · `--help` · `--materialize` · `--no-clock`） | 报错句里就列着这条命令认的那几个（表在 `src/cli/flags.ts`） |
| `--root 需要一个目录：--root <dir>` | 开关排在命令后面又没取值 | 开关排在命令**前**，或写成 `--root=<dir>` |
| `--max-steps 要一个正整数` | 给了 `0`、负数或非数 | 给 `8` 这样的小整数 |
| `--wire-in 与 --live 是两档，一次只给一个` | 回放与真档一起给 | 一次只给一个；要边回放边重录用 `--wire-in <旧目录> --dump-wire <新目录>` |
| 落点那条拒绝（E1） | 工作区在 9p / drvfs / NTFS 这类落点上 | 挪到 ext4 这类原生文件系统；先 `fugue doctor` 看落点那一行 |
| `配置不是一份完整的 JSON：<路径>` / `不认识的顶层键 …` | 手改了 `.fugue/config`，或写了表外的顶层键 | 按报错里的路径改回来。**`fugue config ls` 不读配置**，配置坏了它照样列得出合法顶层键 |
| `config set：顶层键只认 …` | 顶层键拼错 | 合法的那几个：`actions` · `ports` · `boundary` · `platform` · `round` · `config` · `docs` · `workspace` · `credentials` · `toolchain` · `ui`（`src/config.ts` 的 `TOP_LEVEL_KEYS`） |
| `日志损坏，拒绝加载 —— … 日志目录：…` | `.fugue/log/` 坏了 | 报错句里给了目录。**不要手改账**——它是只追加的 |
| 「另一个写者正写着」这一类话（退 1） | 同一个项目里有另一条写命令在跑 | 等它结束。`status` · `log` · `watch` 是纯读，不受影响 |
| 凭据那条报错（退 1） | 这一趟要出网，但没配 `credentials` 表 | 按报错里给的那条 `config set --system credentials.deepseek '[…]'` 配 |

还有两条容易混的：

- **`--` 之后的东西只有 `run` 收**（`fugue run <action> -- k=v…` 那种注入）。给别的命令带 `--`，退 2，而不是把后面那几段悄悄咽下去。
- **`--version` 单独用**，不接命令、不接别的参数；接了退 2。

## 它不做的事 {#not-does}

- **验收没过就不碰你的工作树。** 失败了你的项目还是原来的样子，也不会留下多余的分支。
- **不覆盖你手改的文件。** 写回之前它会比一次：盘上既不是你原来的版本、也不是它这次生成的改动，那些文件会被一条条列出来而不是直接盖掉。上面 `run.log` 的「漂移检」那一行就是这个判据的读数。
- **不碰你的暂存区。** 所以写回之后 `git status` 可能一片红，`git reset` 对齐即可。
- **模型那一侧看不到 `fugue` 这条命令。** `bin/fugue` 住在人这一侧；沙箱里没有它，模型的动作面是声明过的工具目录，不是 `PATH`。
- **界面不直接改真源。** `fugue tui` 能起任意一条 `fugue` 命令，但每个动作都由子进程按那条命令自己的权限与账去做；界面自己不改契约、不写日志。
- **不发布到 npm，也没有任何运行时依赖**（`package.json` 里连 `dependencies` 这一栏都没有）。除了调模型接口，它不访问网络。
- **只内置了一个模型 `deepseek-flash`**，提供 Anthropic 与 OpenAI 两种接口格式。模型不能自己再派子助手。
- **不做终端主题、不接管鼠标、不能分屏。** 颜色只有四档：16 色 / 256 色 / 黑白属性 / 不上色（`--no-style` 或非空的 `NO_COLOR` 全关）。
- **`fugue serve` 不是给日常用的。** 它是另一种进程角色：在标准输入输出上一行一次调用（JSON-RPC 2.0），给写客户端的人用；一个工作区一个 serve，标准输入一断它就收尾。
- **`fugue docs` 不参与 agent 的任何决策。** 它只把这一版代码写成一套能直接打开的 HTML，产物在 `.fugue/docs/`，不会写回任何真源。

## 接着读 {#next}

- 这个版本**是**什么、各层怎么切、命令全表： [架构](architecture.html)
- 为什么这么设计、那些看起来别扭的地方从哪来：[为什么这样设计](rationale.html)
- 每个版本改了什么、对你有什么影响：[版本变化与影响](changelog.html)
- 每一版做了什么、怎么验收：[版本与验收读数](roadmap.html)
- 第一版之后要做什么：[第一版之后要做什么](targets.html)
- 要改 Fugue 本身（开发环境、跑测试、演示脚本）：[改 Fugue 本身](develop.html)