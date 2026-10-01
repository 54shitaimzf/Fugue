# Rust 重构：兼容性与验收边界

独立本地分支 `rewrite/rust-defensive`。移植起点为 `09e591713db066a3b899daea16d4b9492742f5ff` / 0.2.1；已读取得到最新上游 `633a6b2fb63da459074f1077f92ac8fbfc839416` / 0.2.3，并移植相关版本/路由、目录替换、输入光标与线性折行变化。Git/log/view 格式在两份上游之间没有变化。**这不是“所有平台、全部性能档、真实模型和隔离成功路径均已等价验收”的声明。**没有推送远端、创建 PR、替换远端 main 或部署。

## 原生覆盖

- 28 个原命令名、round 的 new/plan/go/run/work、config 的 show/get/set，以及新的 `--version` 均有 Rust 入口。`bin/fugue` 默认原生，`bin/fugue-node` 保留原对照；产品不启动 Node
- Git 对象/引用、视图读写/软链/权限/改名/墓碑/修订/checkpoint、JSONL CRC32、半行尾恢复、混合 Node/Rust writer 排斥、只读观察与重放
- copy 与真实 hardlink-ro。后者只链接独立的不可变 Git 内容镜像，绝不链接可变用户工作树；来源/内容/dev/ino/link 数先验证，改动脱链。策略是偏好：不可用档明确说明后回退，不假报 overlay 或 reflink
- fork/ensure/verify/dispose/diff-stat、mtime 与增量同步、物化发布及 apply 意图的崩溃恢复；validated `--ro`/API options；空目录修剪可控
- 12 个原工具 schema、契约权限、原生有界 grep/glob；强制 bwrap + Landlock + seccomp、独立执行树、环境最小化、整个声明集合验证后回收、独立持久声明缓存
- OpenAI Chat / Anthropic Messages 的 DeepSeek 方言、严格流解析、A/B 稳定与 C 增长、校准/handoff/restart、跨进程会话和已完成工具回执恢复、共享录制序号、原请求字节重试、动态 cap 通知。未确定的中断副作用需要人工复核，不重复执行
- implement/investigate/resolve、原始种子内容预算、宽松/严格预检、并行契约执行、证据不并入 main、真实 Git 冲突树与 resolve/refold、验收重试、持久 retry/resolver 代际、批准摘要校验、漂移/WAL/CAS/恢复。缺失交付物、越界不可变提交或未提交 overlay 都不得冒充成功
- 八元指标、打回三数、归因、逐调用账、状态投影；round 的 metrics/report 开关实际生效
- 原生交互/全屏 TUI、输入/历史/撤销/粘贴折叠/展开、多行宽字符折行和实际光标、面板/导航/队列/取消、二次确认批准、终端 RAII。NO_COLOR/--no-style 保留交互控制
- Idle 对话/理解链、最近三条原文、Planning 草案修订与 pinned goal、版本/against 校验。对话的原 JSONL 内容可通过 `read .fugue/session/<round>.jsonl` 读取；它从 journal 权威事件派生，不另建会话文件或把控制面文件混入 Git/main

## 差分证据

独立单进程 Node oracle 检查 CRC/JavaScript 数字与 UTF-16 键顺序、视图操作和最终 Git 树、锁排斥、空 Git 目录、12 工具目录哈希 `5681832878aa0634`、原模型夹具请求/响应、实际三分支 fold/冲突 stages、契约/预算、指标/报告、原会话投影及最新 0.2.3 input/glyph 折行光标矩阵。最新 UI oracle 的两个原文件按 SHA-256 固定在测试目录，因此无 Git 元数据/网络的源码包也能跑差分。

上游 CLI 录制此前两次请求与 Rust 字节一致；第三次取决于真实隔离 shell 回执。此机真正拒绝动作，回执与录制成功结果不同，因此严格回放停止，未修夹具或伪造成功。测试中的真实模型联网次数为 0。

精确测试数、release 和 Clippy 结果见 [VERIFICATION.md](VERIFICATION.md)。

## 仍未覆盖或有意收紧

1. **真实隔离正向验收被此机阻塞。**guard 实际退出126（Landlock ABI6不可用）；bwrap 实际退出1（NETLINK_ROUTE 操作权限被拒）。正向专用 `real-check.sh` 必须失败，不会把缺能力当通过。动作成功/新文件回收/缓存/网络隔离需要具备能力的 Linux 主机复验；没有绕过限制
2. **没有持久原生 overlay 后端。**仅作命名空间能力探测，报告 backend 缺口后真实选择 copy/hardlink-ro。reflink 在原版也只进入拒绝/退档梯子。没有宿主挂载、安全配置或 sudo 改动
3. 树仍为有界 eager map；stat/list 的大小用一次 metadata-only batch 和 8,192 项每句柄缓存，不读 blob body。没有原版 lazy-tree、长驻 cat-file 或持久 snapshot 加速；`replay --verify` 比较两次完整权威重放，不能证明两条独立快照/全量路径等价
4. toolchain facts 只允许已验证公共系统可执行文件的固定版本 argv。在无法安全执行任意声明时给 null/说明，不执行配置里的任意宿主 shell。`changeDetector`/`detectRenames` 与上游一样为验证后的 advisory 声明；安全验证仍检查内容
5. say 默认离线；显式 live 才可能付费。对话是权威 journal 派生投影，物理保存布局与上游虚拟 `.fugue/session` 不完全一样。TUI 功能通过原生/差分/PTY 验证，整套菜单/配色/人读 CLI 列布局不保证像素或逐字一致
6. Linux/Unix 专用；macOS/Windows 无原生动作后端。裸仓库、linked-worktree 的 `.git` 文件、非 UTF-8 路径/内容预算不明、JS regex 的 lookaround/backreference 都明确拒绝。目录 rename 和编辑 gitlink 的限制保留
7. 不继承任意宿主环境，不暴露 home/credential 根；只开放可信公共 toolchain roots。HOME/TMP 新 tmpfs；仅明确声明的 action cache 持久化且不入视图。没有 per-job cgroup quotas；不能当作完整恶意多租户资源隔离平台
8. 已有旧的非安全软链可以按 immutable base 作为叶删除/回滚，不跟随；新 target 仍禁止逃逸软链。目录替换只删声明叶与空目录，不递归清掉未跟踪、被编辑或保留的后代，比原版更保守

## 事务和防御边界

所有输入、路径、对象/日志、JSON、工具数量、流、输出和进程时限有预算。fd 锚定、O_NOFOLLOW、特殊文件/未授权硬链拒绝；文件替换是临时对象 + 原子 rename。真正完成的工具效果有持久回执；无回执中断不声称能安全自动重做。

用户索引不被推进修改。多文件工作树更新不是全树单条原子操作；WAL 验证不可变 old/new 树和目录拓扑后完成/回滚。观察到用户晚改、CAS 冲突或权限问题时拒绝。不能保证最后校验到 rename 的极窄窗口没有同 UID 宿主竞争者。

Git ref、journal 与缓存是不同耐久存储。正常形状/权限/容量故障先预检；不可预见的 fsync/I/O 故障仍可能使 ref 前进而末条日志未耐久，错误明确报告。旧上游 acceptance 没有配置绑定摘要的记录无法额外证明断言配置从未变化；新 Rust acceptance 绑定断言/actions 并拒绝配置变化恢复。

## Defensive extension compatibility boundary

See HARDENING.md. Path/writer depth128, merged physical journal64 MiB, total canonical JSON1,000,000 nodes and input/output configuration1 MiB are explicit ceilings. Foreign Git alternates/commondir/grafts, config includes, shared mutable Git control files and unsafe metadata links are unsupported. Decoder errors are terminal, malformed protocol shapes no longer coerce, replacing a pinned overall goal requires a new round (same-goal draft replanning remains supported), and unprovable legacy conflict candidate recovery requires manual review. These refusals preserve the fail-closed boundary and are not claims of unrestricted upstream equivalence.
