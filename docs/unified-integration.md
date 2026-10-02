# 统一集成分支

后续功能统一进入 `roadmap/maintenance-integration-check`，每个完整、经 focused 测试的检查点
继续 push。并行实现只使用本地临时分支；原有独立来源 ref 保留，最终只准备一个合并 PR。

本次检查点在维护组合 `9515979` 上接入已有的完整可选检索功能：

- `a9a801eb`：walk 代缓存、read 窗口、如实截断的 grep/glob 回执、当前 View blob 过滤、
  有界后台构建、worker 复用和独立 reference 的端到端基准。
- `99ac1a52`：完整受控索引产生的有界 gram facts，未知条件继续扫描。
- `bf462c72` 加 `7b9ea7a2` 的自建临时叶增量：未知/仍在用的临时对象保留，逐项观察目录关闭，
  关闭失败也收尾自建临时叶，成功 rename 后不再删除后来复用的名字。
- 组合审查另发现父任务的取消清理口只有 PID/nonce，没有当前叶所有权；取消路径现已停止按名字删除，
  旧兼容口保守保留未知叶。实际同 nonce 的后来活跃发布者保留并成功完成，新增两例和相关生命周期
  focused 集合 56/56；非 primitive 的 ID/nonce 也在字符串强制转换或文件系统准入前拒绝。
  突然终止的 worker 可能留下派生临时叶，不能把它们当作已证明属于旧任务。
- `54615407` 的格式端源身份边界：预哈希超限只拒绝，确定性预算分类只用于核验后的构建。
  本分支 lookup 采用原始已审实现，不存在外部后来加入的 `unindexableSet`，不会缓存未核验的负事实。

可选检索已提供两条接线：`HostOptions.blobIndex` 的逐 blob 后端，以及
`HostOptions.cohortIndex` 的当前 View 集合后端。后一种句柄只为绑定的 View 排除候选，
按当前 base/rev 和完整 BlobId 集选择一个 artifact；缺失、不可信、超限或代变化继续扫描。
`prepare(readBlob)` 是调用方明确付费的独立动作；cohort 候选查询不会为构建读取源 blob，
匹配候选仍读真实内容并按原正则验证，查询不构建或发布索引。
句柄和存储的关闭仍由调用方观察。两种选项均缺省关闭，现有 v1 blob 字节与读写契约不变；
新 cohort 使用独立版本、命名空间与有界 UTF-16 postings。

检索之外，0.2.8 已带上既有数据的阅读面 diff、长行和黑白属性可读性小批，
痛点与实际终端视觉验收记在 [显示层说明](terminal-readability.md)。它没有引入新的事件或数据路径。

[真实查询读数](cohort-query-measurements.md) 分开记录准备、首次 miss、当前 View 元数据、
重开句柄的查询和重复查询。512 文件约 16MB 的 code/mixed 样本由 512 个盘记录缩为一个
artifact；code sparse 冷中位仍为 52.682ms，dense 全扫更快，entropy 超预算后继续扫描。
这些边界与 paid preparation 都保留，不能拿单项读取或一个样本宣布默认启用。

官方 `bbf2ef1` 路线图保留。原始 `wire-in` 真录制与链验收保留；三个静态 model 协议样例的
工具描述更新和临时生成的 synthetic 当前目录输入不是 live 重录、provider/cache 证书。
未导入外部后来改写历史请求而保留旧响应/usage 的接受路径。

原始组合 owner focused 检查为 store/格式 33/33、lookup/facts/worker/current-view 49/49，
早期额外真实 View/M0 组合 30/30。后续精确 cohort 接线为 fast 9/9，真实 cohort + v1
验收 10/10；基准自建资源清理控制 3/3。codec 与 v1 focused 15/15，cohort store
最大 4096-ID 证明后 14/14，显示层 focused 43/43、follow 11/11 和 real PTY 6/6。
这些是各自相关集合，不是合并整档计数；集中 reviewer 按最终源 blob 和交互验收复核。
云 overlay/挂载、Node runner 反序列化和 kernel 沙箱限制仍如
[维护快照](maintenance-integration.md) 报告；focused 和 fork push fast 都不等于 full。

0.2.7 待批动作、成本事件扩展、serve 与默认索引启用条件保持待定；本分支也不授权合并或发布。

`308a2f99` 提交说明中「exact tree reviewed centrally」写得过早：当时完成的是原单元审查与
组合 owner 检查，集中审查随后发现上述取消所有权问题。修复和最后的集中检查证书应按后续
精确 head 认证，不能把该说明当作 `308a2f99` 已通过最终源码审查的依据。
