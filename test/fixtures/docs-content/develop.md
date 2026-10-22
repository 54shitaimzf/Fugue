## 一处改动的闭环 {#loop}

这一页只解决一件事：把一处改动落到能跑通验收。顺序固定为「找位置 → 改 → 跑哪条命令 → 看什么读数」，约定与禁忌在后半页。

::: steps
1. **找位置。** 从 `src/` 的一级目录进（见[代码地图](#map)）。测试文件与源文件同名是常态（`src/config.ts` ↔ `src/config.test.ts`），但不是条条如此——`src/delta.ts` 就没有同名测试，先 `grep -rn "gitModeOf" src` 找出谁在用它。
2. **改这一处。** 改动碰到配置键域、事件形状、命令开关表时，另有三条跨文档校验会拦（见下）。
3. **跑点名子集。** `node tools/test-entry.js fast src/config.test.ts`——点名的文件必须落在所选档里，点错当场退出 2，不静默跳过。
4. **跑整档。** `node tools/test-entry.js fast`。
5. **推送前跑全量。** `node tools/test-entry.js`。
:::

**看什么读数。** 入口先在 stderr 印一行分档统计，再交给 `node --test`：

```
档 fast：N 个文件（快 a · 真 b · 全量 c）
```

判据是退出码 0 **且** 那一趟里 `fail 0`。分档统计里 `快 + 真` 必须等于 `全量`——不等就是入口自己退出 1，说明有测试文件被漏掉了。

### 例：加一个配置顶层键

配置的顶层键域是闭的（`src/config.ts` 的 `TOP_LEVEL_KEYS`），拼错的键会被读成「没配」，比报错危险——所以未知顶层键**拒绝加载并指路**。加一个新键要走完这条链：

1. 把键加进 `src/config.ts` 的 `TOP_LEVEL_KEYS`（现在 11 个：`actions` · `ports` · `boundary` · `platform` · `round` · `config` · `docs` · `workspace` · `credentials` · `toolchain` · `ui`）。
2. 这个键有形状约束的，再在 `assertUiShape` 那一类校验函数里补一条——`ui.glyphs` / `ui.icons` / `ui.images` / `ui.keys` 都是这么核的，只挡「根本不是这个形状」的坏值，语义留给读写两面各自把关。
3. 跑跨文档校验：`node tools/check-config-keys.js`（README 与 AGENTS 里教过的配置键 ↔ `src/config.ts` 的键域）。
4. 跑点名子集：`node tools/test-entry.js fast src/config.test.ts src/config-own-keys.test.ts`。

这条链是可复制的模板：**任何「闭集合」都先改那张表，再改行为，最后跑盯那张表的校验。**

## 验收入口 {#entry}

所有测试只走一个入口，不要直接用 `node --test`：它在发现 0 个测试文件时输出 `tests 0 / pass 0 / fail 0` 并以退出码 0 结束——测试文件丢了也不会有人发现。`tools/test-entry.js` 把「发现数」变成一条会失败的断言。

| 用法 | 跑什么 | 什么时候用 |
|---|---|---|
| `node tools/test-entry.js` | 全量（等于 `all`） | 推送之前 |
| `node tools/test-entry.js fast` | 快档 | 边改边跑 |
| `node tools/test-entry.js real` | 真档 | 碰了沙箱、执行、物化、真实端口 |
| `node tools/test-entry.js fast src/a.test.ts …` | 点名的那些 | 改一处，先把半径缩小 |

`all` 也可以显式写。档名拼错退出 2；所选档 0 个文件退出 1。

::: figure 入口怎么分档，以及它拦什么
```
src/**/*.test.ts   test/**/*.test.ts
        │
        └─ tools/test-entry.js  discover()
                 │
                 ├─ 首行 // tier: real  →  real 档（bwrap · cc · 真端口 · 真挂载）
                 └─ 其余                →  fast 档
                 │
                 ├─ 快 + 真 ≠ 发现集            → 退出 1（不许静默丢）
                 ├─ 快档里出现真依赖调用形状    → 退出 1（该改断言，或该加声明）
                 └─ node --test -- <chosen>
```
:::

**怎么标真档。** 在文件第一行写 `// tier: real —— …`，破折号后面点出依赖种类。`src/execute/degraded.test.ts` 的第一行就是：

```ts
// tier: real —— bwrap · cc（这台机器 bwrap 在是硬断言）
```

分档判据是**依赖性质**，不是文件位置：声明随文件走，没有集中维护的清单。一个文件里只要有一处用到真实环境，整个文件就算真档。

::: warn 快档不许碰真依赖
入口对快档做一次纯文本审计，命中下面任一**字面**形状就退出 1：

- `spawnSync('bwrap'` · `spawn('bwrap'` · `['bwrap'`
- `spawnSync('unshare'` · `spawn('unshare'`
- `execFileSync('cc'` · `spawnSync('cc'` · `['cc'`
- `.listen(` · `mountOverlay(` · `unmountOverlay(`

这是绊线不是分析：经变量的间接调用、帮助模块里的调用、整串 shell 里的 `bwrap`/`cc`，它都看不见。
:::

::: tabs
::: tab 加声明，把它挪进真档
确认这个文件真的需要真环境（`bwrap` · `cc` · 真端口 · 真挂载）时，在首行加 `// tier: real —— <依赖种类>`。副作用是它不再进 CI 的 `fast` job，只在 `full` 与 `audit` 里跑。
:::
::: tab 改断言，让它留在快档
只是「顺手起了个子进程」时，把断言换成不依赖真环境的形状（读日志、读返回值、比字节），文件留在快档。CI 的 `fast` job **不装 `bwrap`**，就是为了让档判据破了当场红，而不是被安装步骤盖过去。
:::
:::

::: details 为什么快档审计查不全
口径写在 `tools/test-entry.js` 的注释里：「抓字面、零仪式」——没有白名单、没有豁免注释；哪个形状抓不到的，记口径，不打补丁。要确认快档真的不依赖外部环境，可靠的办法是把 `bwrap`、`cc` 从 `PATH` 上拿掉再跑一遍快档；`src/execute/degraded.test.ts` 的 ④ 就是这么做的（用符号链接镜像 `/usr/bin` 与 `/usr/local/bin`，只去掉 `bwrap`），这类验证的结果记在对应的提交信息里。
:::

### CI 三档

流水线只有一个文件 `.github/workflows/test.yml`，`ubuntu-latest` + Node 24，三个 job：

| job | 何时跑 | 跑什么 | 挡不挡 |
|---|---|---|---|
| `fast` | push 与 PR | `node tools/test-entry.js fast`，**不装 `bwrap`** | 挡 |
| `full` | PR | `node tools/ci-timing.js fast --out ci-timing-fast.json` 与 `… real --out ci-timing-real.json`，两趟墙钟存成 artifact `ci-timing` | 挡 |
| `audit` | 定时（UTC 18:00）与手动 | `node tools/test-entry.js all`，再 `node tools/mutation-audit.js --budget-ms 900000 --out mutation-audit.json` | 只报不挡 |

触发规则里有一处**不能删的行**：`branches: ['**']` 与 `tags-ignore: ['**']` 必须同时写。只写 `tags-ignore` 时，分支上的 push 也不再触发，而且不会有任何提示。

::: note full 那一档的计时包装
`full` 跑的是 `node tools/ci-timing.js fast|real`：它包的是同一个 `tools/test-entry.js <lane>`（`tools/ci-timing.js` 的 `spawnLane`），只是多记一份墙钟 JSON。所以「fast 组 + real 组一起」与 workflow 里那两条命令是同一件事的两种写法。形状由 `test/ci-timing.test.ts`（artifact 的键集）与 `test/ci-workflow.test.ts`（这两步与上传步在不在）盯着——改之前先读这两张断言。
:::

## 代码地图 {#map}

顶层七个目录，各管各的：

| 目录 | 是什么 |
|---|---|
| `src/` | 产品代码，506 个文件 |
| `test/` | 跨模块验收：黄金帧 `test/golden/frames/`、跨文档校验、不变式与守卫 |
| `tools/` | 只用于开发和验证，**不属于产品**：演示脚本、测量工具、三条跨文档校验（`check-targets.js` · `check-events.js` · `check-config-keys.js`） |
| `design/` | 规格与来由，跟着代码走，**不属于产品**：`ARCHITECTURE.md` · `ROADMAP.md` · `TARGETS.md` · `RATIONALE.md` |
| `bin/` | `bin/fugue` 一个壳，住在人这一侧 |
| `assets/` | 品牌与界面素材（`brand/` · `ui/`） |
| `.github/` | 唯一的流水线与主分支保护配置 |

`src/` 下面这张表按目录里的文件名读，职责一句话；具体行为以那个目录的文件头为准：

| 目录 | 里面有什么 |
|---|---|
| `cli/` | 入口 `fugue.ts`、解析 `argv.ts`、开关表 `flags.ts`、按命令装载 `load.ts` 与地板 `all.ts`、各命令组 `cmd/` |
| `value/` | 值层：登记表 `registry.ts`、壳 `cli.ts` / `shell.ts` |
| `round/` | 一轮任务：状态机 `machine.ts`、拆分 `plan.ts`、分派 `dispatch.ts`、驱动 `driver.ts`、工作 `work.ts`、说话 `say.ts` |
| `assemble/` | 拼给模型的内容：`assemble.ts` · `constraints.ts` · `protocol.ts` · `render.ts` · `sources-state.ts` |
| `log/` | 工作记录：`log.ts` · `envelope.ts` · `hold.ts` · `batch.ts` · `events.schema.json` |
| `view/` | 文件视图与提交面：`edit.ts` · `view.ts` · `replay.ts` · `snapshot.ts` |
| `materialize/` | 为任务生成的文件树：`fork.ts` · `ensure.ts` · `lay.ts` · `land.ts` · `verify.ts` · `dispose.ts` |
| `execute/` | 隔离执行：`exec.ts` · `reclaim.ts` · `degraded.test.ts` |
| `boundary/` | 边界两层：`confine.ts`（挂载）· `landlock.ts` · `seccomp.ts` · `policy.ts` · `escape.ts` |
| `roots/` | 落点：`host.ts` · `fence.ts` · `paths.ts` · `coords.ts` |
| `merge/` | 合并与漂移：`merge.ts` · `accept.ts` · `drift.ts` |
| `recovery/` | 恢复：`facts.ts` · `finish.ts` · `state.ts` |
| `runtime/` | 运行时：`run.ts` · `step.ts` · `budget.ts` · `restart.ts` |
| `probe/` | 读数：`status.ts` · `metrics.ts` · `ledger.ts` · `doctor.ts` · `watch.ts` |
| `model/` | 模型配置与三种连接：`http.ts` · `catalog.ts` · `wire/` · `fixtures/` |
| `serve/` | serve 那一面：`source.ts` · `jobs.ts` · `tail.ts` · `wire.ts` |
| `ui/` | 终端界面：`term.ts` · `console.ts` · `layout.ts` · `frame.ts` · `keymap.ts` · `gate.ts` |
| `docs/` | 文档生成：`build.ts` · `page.ts` · `prompt.ts` · `publish.ts` · `themes/` |
| `index/` | 索引：`store.ts` · `trigram.ts` · `budget.ts` |
| `search/` | 搜索：`plan.ts` · `pattern.ts` · `trigger.ts` |
| `truth/` | 真源：`git.ts` · `truth.ts` · `blob-lru.ts` |
| `tools/` | 模型能用的那一份工具目录：`catalog.ts` · `execute.ts` · `receipt.ts`（与仓库根的 `tools/` 不是一回事） |
| `contract/` | 契约：`build.ts` · `draft.ts` · `gate.ts` · `precheck.ts` |
| `capability/` | 能力表：`table.ts` · `dispatch.ts` |

顶层还有几个散件要点名：`src/delta.ts`（三个模块唯一共享的类型 `Delta`，以及 `normMode` / `gitModeOf` 两处归一）、`src/config.ts`（两级配置与顶层键域）、`src/checkpoint.ts`（提交）、`src/branch.ts`（ref 那一侧）、`src/terms.ts`、`src/protocol.ts`。

::: note 来源这张地图已经落后
`AGENTS.md` 的目录表只列了 9 个 `src/` 子目录，提交 C 的树里是 24 个；它还把 `src/cli/` 说成「一共 28 条命令」，而入口 `src/cli/fugue.ts` 的分发里现在还有 `tui` · `serve` · `docs …`，以及整条值层支路（`log` · `status` · `watch` 从 `value/registry.ts` 的登记表出去）。数命令以 `fugue --help` 为准，不以文档为准。
:::

**改动落在哪一层。** 名字对得上的测试就是第一道验收：

| 想改的东西 | 从哪儿开始读 | 名字对得上的测试 |
|---|---|---|
| 命令分发、开关、退出码、两面输出 | `src/cli/fugue.ts` → `src/cli/flags.ts` → `src/cli/argv.ts` | `src/cli/argv.test.ts` · `src/cli/help-surface.test.ts` · `src/cli/routing-flags.test.ts` · `test/golden/golden.test.ts` |
| 配置键与叠放 | `src/config.ts` | `src/config.test.ts` · `src/config-own-keys.test.ts` · `tools/check-config-keys.js` |
| 一轮任务的状态与顺序 | `src/round/` | `src/round/*.test.ts` |
| 沙箱的档与退化 | `src/execute/` · `src/boundary/` | `src/execute/degraded.test.ts`（**real 档**）· `src/boundary/policy.test.ts` |
| 工作记录的形状 | `src/log/` | `src/log/*.test.ts` · `test/event-schema.test.ts` · `tools/check-events.js` |
| 一条命令的人面与 `--json` 面 | 该命令的实现 | `test/golden/golden.test.ts`（`test/golden/frames/` 逐字节） |

改了任何一条命令的输出，黄金帧会红——那一层逐字节盯着人面与 `--json` 两面。

## 写入通道与安装 {#write}

`bin/fugue` 是一个 POSIX sh 启动脚本，顺着软链接找到仓库实际位置，然后 **一次 `exec`**：

```sh
ln -s ~/fugue/bin/fugue ~/.local/bin/fugue
```

装好后，在任何目录下运行 `fugue …`，与在仓库里运行 `node src/cli/fugue.ts …` 是同一次调用：同一个进程、同一个 argv、同一份退出码。这一点由 `test/shell.test.ts` 逐字节保证——它真的把壳软链到一个临时 `bin/`，再从与仓库无关的目录敲它，stdout · stderr · 退出码三者与仓库内那条路比，报错的那几条同样比。换解释器设 `FUGUE_NODE=<node 的路径>`。

这个命令**只给人用**：沙箱里没有它，模型看到的文件里也没有它。模型能做的动作是声明过的工具目录，不是 `PATH` 上装了什么就能用什么。

::: warn 写入通道：来源与可实现范围
`AGENTS.md` 说代码工作区的写入走预设 `Fugue · WSL` 的三个工具（改已有文件 `wsl_edit`、新建或整文件替换 `wsl_write`、跑命令 `wsl_exec`，默认工作目录 `~/fugue`），并说 `wsl_write` 的 `content` 走 stdin，所以 `$`、反引号、引号、heredoc 不会被外层吃掉。**这一条在提交 C 的树里核不到**——它是运行环境里的预设，不在仓库里。本页只能确认仓库这一侧的事实：`tools/wsl.ps1` 不在树里（来源也说它已删除），不要退回 `wsl.exe` 命令行。

仓库放在 WSL 的 ext4 上，从 Windows 走 `\\wsl.localhost\<发行版>\home\<用户>\fugue` **只能读**：那条 UNC 路径走 9p，不支持硬链接，原子写会直接报 `ENOTSUP`。
:::

## 不许引入的东西 {#constraints}

- **依赖。** `package.json` 里没有 `dependencies`，也没有 `devDependencies`，`scripts` 只有一条 `test`。CI 里唯一的安装步骤是补 runner 环境（`bubblewrap` + 解除 Ubuntu 24.04 对非特权用户命名空间的限制），不是装仓库的依赖。
- **构建步骤。** Node 直接运行 `.ts`，只做 strip-only 删类型标注。所以下面这些写法**不能用**，因为它们在运行时会生成额外的代码：构造函数的参数属性（`constructor(readonly x: T)`）、`enum`、`namespace`。这是「不需要编译」的代价，不是 bug。
- **比 `engines` 新的 API。** `package.json` 声明 `node >=22.6`。典型踩点是 `import.meta.main`——它是 Node 24.2 才有的，在 22.x 上静默什么都不做。守卫要写成 `resolve(process.argv[1]) === fileURLToPath(import.meta.url)`，`src/cli/fugue.ts` 与 `tools/test-entry.js` 用同一个写法，所以这两个模块都能被 `import` 而不产生副作用。
- **第二处真相。** `src/cli/all.ts` 是装载那一层的地板：短名不在表里、或那一份装不上时，把整个命令族一次装齐。它**只做再导出**——没有第二份分发、没有第二张命令表、一个字节的语义都没有。「地板要是自己长出一份判断，它就成了第二处真相。」
- **模型写配置。** 配置在真实工作树里但不在视图里，写路径只有 `fugue config set` 一条，而它是唯一一条模型没有对应工具的写操作。「模型是被配置者，不是配置者」由位置保证，不是一条禁令。

数据来源只有两样：**git 仓库**与**工作记录**（`.fugue/log`）。其余都是推算，不单独保存。

## 提交与断言的纪律 {#discipline}

每个提交的说明里要写清三件事：

1. 一条可以运行的命令；
2. 一个在修改前会失败、修改后会通过的测试；
3. 这个修改对应架构文档里的哪条要求。

`git log -1 --format=%B` 看全文。每完成一个单元就提交一次，提交说明里附测试输出，以及它满足了哪些要求——**提交历史就是唯一的进度记录**。

断言层面还有三条硬约定：

- **只测结果对不对，不测速度快不快。** 要写进架构文档的性能数字，必须在 ext4 这样的正常 Linux 文件系统上测。
- **比较文件权限要按 git 的规则来。** 盘上的 `st_mode` 带 umask（`umask 002` 下一份普通文件是 `0o100664`，软链 `lstat` 报 `0o120777`），而树里只有 `100644` / `100755` / `120000` 三种。凡是要比「盘上」与「树里」的地方，先过 `src/delta.ts` 的 `gitModeOf`。测试需要比权限就显式 `chmod`，不要依赖跑测试那台机器的 umask。
- **改一处算子，看测试红不红。** `tools/mutation-audit.js` 在干净树上做变异审计，夜间档跑，`--budget-ms 900000` 到点就停，跑多少算多少、剩下的如实报。不红的那一处就是这个变异存活了。

## 容易踩的坑（对照清单） {#pitfalls}

- **空 index 摊不平任何东西。** `GIT_INDEX_FILE=` 配 `git checkout-index` 会返回 0 表示成功，而盘上一个字节都没变。正确做法：先 `read-tree` 把目标树读进一个单独 index，再 `checkout-index -a -f`。`tools/walkthrough-s7.sh` 的 `sync_disk` 就是这一段的现成写法。
- **`fugue commit` 不动 index，所以写回之后 `git status` 反而可能一片红。** 它自己造树、造提交，暂存区还停在旧版本；`git reset` 对齐即可（与 `start` 页「不碰你的暂存区」是同一件事）。判断写回成没成，别拿 `git status` 当读数——要比就比树：另开一个 index、`git add -A`、`write-tree`，拿树 id 去比。
- **跑轮次之前没对齐磁盘。** 写回前的漂移检查会对比起点提交、盘上、目标树三份，它能发现「任务开始前就存在的手改」。演示脚本每一趟 `round run` 之前都要先 `sync_disk`。
- **`--root` 给了空值不等于没给。** `--root` 与 `--agent` 给了却缺值，退出 2，不会退回 `cwd` / 退回 `round`——否则 `write` 会悄悄写进另一份视图。
- **开关表外的开关退 2。** 每条命令（`round`、`docs` 按子命令各一张）有一张声明过的开关表，表外的开关不会被咽下去：「命令跑了、什么都没变」与「这个开关今天没用」不该是同一张脸。
- **报错面跟着 `--json` 走。** `UsageError` 翻成 2，`LogHeldError` 与 `LogCorruptError` 翻成 1，两面都要翻，不是只翻人面。
- **直接用 `node --test`。** 发现 0 个文件时它退出 0。永远走 `tools/test-entry.js`。
- **忘了标 `// tier: real`。** 真依赖留在快档，CI 的 `fast` job 当场红——那是设计好的红，不要靠往 job 里装 `bwrap` 解决。
- **改演示脚本时只改一半。** 它们都只演示和验证，不改产品代码、不引入新依赖；但每一步都要先打命令再原样打输出与退出码，别吞输出。`tools/walkthrough.sh` 收尾有七项自查（重放比对、被杀前写下的内容与模式、事件数对账、修订点连续前缀、被杀那次写的完整性、对象库干净），任何一条不成立就非零退出。`KEEP=1` 留现场，`FUGUE=<命令路径>` 换被测的那一份。