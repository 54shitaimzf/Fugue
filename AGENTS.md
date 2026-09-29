# 在这个仓库里干活

> 这份是**仓库内**的动手说明：环境 · 验收 · 送文件进来的路 · 可擦除语法。
>
> **必须自动生效的规则不在这里。** 它们在文档工作区的 `AGENTS.md`
> （`/mnt/c/Users/Administrator/Desktop/CodeWish/AGENTS.md`）——那一份会被 harness 自动读进
> 每个会话的前缀；这一份不会，因为 `dsh-agent-instructions` 读的是**会话工作区**那条链，
> 而本仓库是另一个项目根。两处各写一段，不互相抄。
>
> 计划与审查规则：`/mnt/c/Users/Administrator/Desktop/CodeWish/PLAN.md`。
> 进度：`git log --oneline`。

## 环境

- 仓库住在 WSL 的 ext4 上：`/home/ubuntu/fugue`（`/dev/sdd`，实体是 `D:\WSL_linux\ext4.vhdx`）。
  不要在 `/mnt/c` 里建仓库——那是 drvfs，小文件创建慢约 180 倍（架构 § 15.7）。
- Windows 侧可以直接看：`\\wsl.localhost\ubuntu-noble\home\ubuntu\fugue`。
  **读得到，写不进**——9p 不支持硬链接，原子写入直接 `ENOTSUP`。
- 沙箱那几条判据要 `bwrap`（挂载层）与内核的 Landlock（第二层）：本机上 `bwrap` 在 `/usr/bin/bwrap`。
  少了 `bwrap`，`src/execute/degraded.test.ts` ④ 那句「这台机器上 bwrap 在」当场红——CI 上由那条流水线补上。

## 验收

```
node tools/test-entry.js
```

唯一入口。它在**一个测试文件都没发现**时非零退出——因为 `node --test` 自己在那种情况下是
笑着退出的（实测 `tests 0 / pass 0 / fail 0`，退出码 0）。这是本仓库"漏了不报错"的第一道封口。

**断言在位，不断言快慢。** 要进架构当常数的读数一律在一等档主机（ext4）上取。

**模式按 git 的档比，验收不随 umask 变。** 盘上的 `st_mode` 带着 umask（`umask 002` 下普通文件是
0664，软链 `lstat` 报 0o120777），树上只有 `100644` · `100755` · `120000`。凡是"盘 vs 树"逐数比模式的地方
（漂移检 · `advance` · `diskEntry`）一律先过 `src/delta.ts` 的 `gitModeOf`；`scanTree` 自己照旧记整模式。
测试夹具要比模式就显式 `chmod`，不押在跑测试那台机器的 umask 上。下面那条送文件的路恒给 644，所以这一类
回归在本机看不见——要在 `umask 002` 下再跑一遍验收入口才量得到（#1）。

**走查**——§ 9.6 那张表逐行走一遍，连命令带输出：

```
sh tools/walkthrough.sh
```

它起一个真仓库：写 · 提交 · 杀进程 · 重放 · 看变更，最后自己断言七条，并在结尾把表里属于
S1 的每一行再走一遍、报退出码。`KEEP=1` 把临时工作区留下，`FUGUE=<cli>` 换掉被走查的那个命令行。

**一站一份走查**，每份都是"一条命令跑完这个站的可用性"，都不改产品、不引依赖：
`tools/walkthrough-s2.sh`（真实 C 项目 + `make`：三档 fork 与增量落地，判据是"假失效"）·
`walkthrough-s3.sh`（N 路并发各物各的树：互不可见 · 全树哈希 == 参照树 · 重铺幂等）·
`walkthrough-s4.sh`（隔离执行：四路 `run build` / `run test` → 并行与串行逐字节一致 → 未声明的写入
被拒并记事件 → 地板 → `dispose` 收尾不留挂载、不留进程、不留端口）·
`walkthrough-s5.sh`（边界可用：`fugue policy` 那一行 → 真编译 + 真测试照跑 → 一个"想逃逸"的动作
每类一条（当场拒 / 够不着 / 路径检查 / 清单写错，各自的文案连指路一起印）→ 地板一（`bwrap` 不在，
第二层接过"写得动什么"：未声明的写入当场拒）→ 地板底（两层都不在：树可写 + 回收兜底）→ `dispose`
收尾不留挂载、不留进程、不留端口）·
`walkthrough-s6.sh`（装配可用：首份真实协议 → 三区哈希跨 agent 全等 · 相邻两步只有 C 区变 · 前缀
里没有绝对路径与环境标识 → 地板：`toolCatalog` 为空也装配得出）·
`walkthrough-s7.sh`（编排可用：`round new` 钉底发契约 → `round run` 干净一趟折完验完推进 → 故意
撞红一趟（冲突树 · 验收打回 · 动作被拒 · 真实工作树不动）→ 打回三个数与日志重放对账 → 漂移那一档
（**盘上摊回主线之后**再量：两边逐字节相同 → 照合并 · 只被删的那一条 → 拒）→ 地板两档 → 收尾不留
挂载、不留进程、不留孤儿分支）。

**走查自己也要"盘上与主线一致"**（S7 的 A10 之后）：漂移那一档的判据是三方比出来的（底 · 盘上 ·
目标树），它看得见"轮次开跑之前就存在的手改"，所以走查在每一趟 `round run` 之前要先把盘上摊回主线
那一棵树（`tools/walkthrough-s7.sh` 里那个 `sync_disk`）。**空 index 摊平不了任何东西**：
`git checkout-index` 只按 index 写，`GIT_INDEX_FILE=` 给一个空 index 时它 rc 0 而盘上纹丝不动——
要先把主线那棵树 `read-tree` 进一个另开的 index。

## 命令壳（人这一侧）

`bin/fugue` 是个 shim：顺着软链找到自己，再 `exec` 仓库里那个命令行。装法就一条：

```
ln -s ~/fugue/bin/fugue ~/.local/bin/fugue
```

装完在**任何目录**里敲 `fugue …`，与在仓库里敲 `node src/cli/fugue.ts …` 是同一次调用——
stdout · stderr · 退出码逐字节相同，报错的那几条同样（断言在 `test/shell.test.ts`）。
**它只住在人这一侧**：沙箱里没有它，视图里也没有它——模型那一侧的动作面是声明过的工具
目录，不是 PATH（架构 § 24 纪律 13）。换解释器：`FUGUE_NODE=<node 的路径>`。

## 只写可擦除的 TypeScript

Node 直跑 `.ts` 是 **strip-only**：**参数属性**（`constructor(readonly x: T)`）、`enum`、
`namespace` 都用不了——它们带运行时语义。这是"无构建步骤"的代价，不是缺口。

## 从 Windows 侧送文件进来

会话的 shell 是 bash 时，一次重定向就够——内容随**工具参数**走，不经任何命令行，所以
`$` 不会被替换，`umask 022` 也直接给出 644：

```
wsl -d ubuntu-noble -- bash -c 'cat > /home/ubuntu/fugue/src/x.ts' <<'ZZEOF'
…内容，原样…
ZZEOF
```

回退（会话的 shell 不是 bash）：在文档工作区里用
`pwsh -File tools/wsl.ps1 put <暂存目录> /home/ubuntu/fugue`，它 `cp` 进去、补 `chmod 644`、删暂存。

## 仓库长什么样

对外那一面在 `README.md`（**第一读者是用它的人**：它替你做什么 · 先看它干一趟真的 · 装 · 第一次用它干真活 · 随时看它在干什么 · 这一版不做什么）。动手那一面在这里。

| 目录 | 是什么 |
|---|---|
| `src/cli/` | 命令行（26 条命令） |
| `src/round/` | 一轮：拆分 · 门 · 派发 · 驱动 · 合并 |
| `src/assemble/` | 前缀装配：三区 · 段源 · 协议值 · 约束 |
| `src/log/` | 事件账：追加 · 索引 · 交错读 |
| `src/view/` · `src/materialize/` · `src/execute/` | 视图 · 物化树 · 隔离执行 |
| `src/model/` | 模型声明 · 线协议 · 三档传输（真网络 / 回放 / 夹具） |
| `src/probe/` | 读数：快照 · 八元指标 · 打回三数 |
| `src/ui/` | TUI：排版（纯函数）· 终端 · 跟随 · 按键 |
| `tools/` | **取证用的，不是产品的一部分**：走查 · 探针 · 基准 |

**CI 只有一条**（`.github/workflows/test.yml`）：`ubuntu-latest` · node 24 · 跑 `node tools/test-entry.js`。**触发面是分支的 push 与 PR，标签一个都不跑**（`branches: ['**']` 与 `tags-ignore: ['**']` 两条缺一不可——只写 `tags-ignore` 会让分支的 push 也静默地不再跑）。仓库侧没有依赖，也就没有安装步骤；那条流水线里唯一一步安装装的是 **runner 的环境**——`bubblewrap`（镜像不带它）+ 放开 24.04 的无特权 userns 限制，少了它 `src/execute/degraded.test.ts` ④ 会红。推之前先在本地跑一遍同一入口。

**一条能跑的命令 + 一条会失败的断言 + 它兑现的架构条款**：三样一起进提交信息（`git log -1 --format=%B` 看全文）。

## 真源只有两处

git 对象库 + `M0` 日志（架构 § 1.4）。派生不持久化，文档不落进视图。
本仓库自己遵守同一条：**提交序列是唯一的进度记录**——一个单元一次提交，提交信息带
断言输出与被它兑现的条款。
