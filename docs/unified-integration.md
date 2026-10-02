# 统一上游基线与路线图贡献

本分支以官方 `807885e081cbb97997d426e4e22b9edbff5a04e0`（已发布 0.2.6 与已定案的后续路线图）为最新实际祖先；此前基于 `ba77d765` 合入公开审查汇总
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

0.2.7 的[实际装配诊断](assembly-constraints.md)只改两处已定案的方针指针，并忠实报告剩余
宿主示例路径与整段 C 的追加判据差异；它不证明零违反，新的 A 前缀真实录制尚未完成。
0.2.9 的[内部不变量诊断网](../design/INVARIANT-CHECKS.md)先作为开发测试前置，再支撑能力表
名字转发与唯一一次内部载入核对的移除；其他输入/执行校验保留，不接 ui.keys，也不改冻结接口。

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

0.2.7 三项已按最新官方路线图定案，但具体实现、方针/追加判据收口与真实录制尚待完成。
冻结成本事件、serve 三项前置审批、默认索引、native 触发条件与发布/合并门保持独立。
PR23 仍只作前置审批输入，不当成已批或直接合入的 serve 实现。T19 后续阶段按官方节奏。

早先 `308a2f99` 提交中的「exact tree reviewed centrally」写得过早；当时仅有单元与 owner
组合检查，集中审查随后发现取消所有权问题。后续修复与精确 head 证书才是源码认证依据。
