# 统一上游基线与路线图贡献

本分支以官方 `f271ad2fd6dc64e26bfa6a7d8a28d3f8d7c00ad5`（PR53 的机制、PR55 发布归档与 PR56 文档校准已合入）为最新实际祖先；此前基于 `ba77d765` 合入公开审查汇总
`claude/fugue-roadmap-pr-review-c0t5od` 的 `a5010b8430286d803a5fcc625d2dff2a12a0d303`，
再接入随后完成的增量 cohort 构建和真实 View/M0 验收。只持续更新
`roadmap/maintenance-integration-check`，沿用上游 draft PR45；旧来源 ref 保留，不改写历史。

官方 0.2.5 的 read、catalog、receipt、walk 机制与测试保留，已吸收的贡献不再当作一套待并入的
独立实现。工具宿主继续使用后来扩展的 base/rev 详细遍历状态，以保留共享并发、失效重试和如实
截断；上游原始纯机制帮助口及其测试作为独立覆盖保留。官方最新 T19 / Windows-first 路线图、
TARGETS 与架构来自实际上游，未用旧文件整篇覆盖。

汇总功能包括维护恢复/重复键/哈希探测/终端退出，read 窗口、搜索回执与早停、纯显示层可读性，
只读调用账本，以及缺省关闭的 blob/cohort 索引、worker/facts/存储安全控制。
cohort 的 `prepare(readBlob, options)` 复用完整不可变记录，只为新 BlobId 读取、核验和构建源；
查询仍只按当前 View 集合排除明确否定的候选，再用实际内容和原 regex 验证。

此次上游同步原样保留已接受的**顶层**日志重复键检查，早先候选的嵌套作用域拒绝没有带回产品；
嵌套 payload 最后值语义由测试明确记录。转义顶层重复键与半行恢复的持久交互覆盖保留，
具体边界见[重复键说明](log-duplicate-keys.md)。官方发布说明、版本和最新 ROADMAP 保留。

0.2.7 的[实际装配诊断](assembly-constraints.md)采用官方清理后的真实方针，历史宿主路径诊断不再是当前基线。官方常驻证人、真实 facts 与非静默整段 C 诊断均保留；新的 A 前缀真实录制不能由源码同步证明。
0.2.9 的[内部不变量诊断网](../design/INVARIANT-CHECKS.md)采用上游已审的完整主体与能力表，
额外保留目录重名、层域、能力标识重名和声明集布尔四格。纯显示层和键位接线采用上游
PR49/50 的源码与断言，旧显示实现不再形成 PR 差异；真实 PTY 退出控制作为额外覆盖保留。
外观改造按官方 0.4.3 行排在 serve 之后，本次没有扩大实施范围。

汇总分支中的确定性预算负 memo 已有地址核验与 close 清空控制；未核验的超限回复继续未知/重试。
取消清理保留无所有权证明的临时叶。cohort 发布者清理时另核 inode；v1 发布者依据独占创建
标记，在 rename 成功后立即撤销清理资格，并依赖同 UID 的受控命名空间，不声称同样的 inode
复核。合并中
仅删除重复的 `IndexStoreStats` 类型声明与过时 sweep 注释，不改变统计字段或可执行语句。

历史输入明确分层：`wire-in/original` 固定保存 `e02fa524` 的请求、响应与 metadata，并钉住 manifest
指纹；当前上游兼容输入只改目录投影与派生请求指纹，响应/usage 仍是旧记录。它们不是新 live
录制、provider/cache 证明。静态 model 测试对象直接沿用公开汇总分支的既有对象；目录投影与派生请求指纹的
兼容修订也不改变旧响应的证据性质。源码相同不表示新证据。

此前 `a321e8b9` 组合检查：codec/增量构建 focused 25/25；维护、View/M0、索引、哈希与真实 PTY 的适用 real
集合 44/44。完整本地 fast 初次为 847/854，五个 Node runner 克隆数据传输失败与两条既有
挂载/overlay 非 ext4 条件失败；受影响文件随后单独复核通过。以上不能写成整档全绿，PR 的
精确 head fast/full 证书另验，云严格内核隔离限制也不据此消失。

[冷查询基线](cohort-query-measurements.md)与[增量准备读数](cohort-incremental-measurements.md)
是分别带源指纹的历史样本。后者二次源读取 0、新 ID 1；前者 code sparse 52.682ms 与 entropy
退化、dense 全扫优势仍保留。此次源合并不把旧指纹迁成新源码的性能证书，不启用索引缺省。

官方 PR53 已实现 ask-ruler-2 的轮内一次裁断、ask/raised 与 ask/ruling 事件、结论回传以及 Lower.putBlob / Entry.blob 真源 ID 携带；本组合直接保留官方类型与行为。整段 C 的非静默诊断与真实前缀录制仍按各自口径判断。
冻结成本事件、serve 三项前置审批、默认索引、native 触发条件与发布/合并门保持独立。
PR23 仍只作前置审批输入，不当成已批或直接合入的 serve 实现。T19 后续阶段按官方节奏。

早先 `308a2f99` 提交中的「exact tree reviewed centrally」写得过早；当时仅有单元与 owner
组合检查，集中审查随后发现取消所有权问题。后续修复与精确 head 证书才是源码认证依据。

本次按[维护者反馈](https://github.com/54shitaimzf/Fugue/pull/45#issuecomment-5951446836)同步：
以旧 canonical `307613fb` 与最新 main 为双亲，保留提交历史；相对于 main，纯显示层、配置接线和
能力表不再重复。0.3.x 搜索/索引/账本仍作为待逐站审查的候选；旧基准与当前源码不自动互换证书。

本次 owner 检查：新/现有不变量、键位接线与退出钩 22/22；维护与 UI 相关组 79 通过，
execute 文件出现一次已见 Node cloned-data 传输错误，随后 execute/两份网测试 26/26。
真实装配/View/M0 19/19；PTY 的旧启动夹具在新异步键位读取下互等，修正 readiness 后 6/6。
这些是适用检查，精确推送 head 的完整 CI 另验。

本次 `5202914` 与官方 `ba4d2392`、`ff40425` 的追加式同步保留各方祖先：采用官方 AGENTS、U18 事件/固定尺与 M2 ID 来源；已接受的 `completeEndOf`/`readFully` 与已验证的初始化/append-close 栅栏共用原字节读法。可选搜索/索引候选仍逐站审查；`5202914` 的绿 CI 属于旧 base，不借给新组合。

新的 View 所有权修复在任何 await 之前捕获自有字节，令 Entry、Lower.putBlob 与持久 Delta 使用同一快照；读取与 diff 返回值也不借出内部 Buffer。真源 ID 仍由官方 Lower 端口提供，详见[字节绑定](../design/VIEW-BYTE-OWNERSHIP.md)。纯内存测试和 walk/read 演示实现相同端口，不调用真实 Git。

可选索引管线现在可复用完整、已核 BlobId 的 regex 验证结果；默认宿主仍走原扫描路径，未穷尽、超限或身份变化不安装缓存，详见[缓存边界](grep-verification-cache.md)。[配对读数](performance-next/regex-verification.md)是在上游同步前的固定源码图上量得，保留完整源指纹与冷代价，不作为当前新组合的性能证书；最终实际 View 与持久写入的正确性另在当前组合验证。

官方 ROADMAP §10 的尾段政策采用非破坏恢复：读者保留盘上字节，当前写者遇已观察到的半行先拒绝追加。旧自动 truncate 候选撤回，显式清理仍待决定，见[尾段边界](log-tail-recovery.md)。

随后与官方 `f271ad2` 的同步只改变五份已审文档：凭据查找、命令速查差异与 s8/s9 演示清单均依上游校准；源码、历史录音与上述功能证据不变。
