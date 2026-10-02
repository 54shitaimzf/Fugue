# 历史探索读数，不是最终修复源码的性能证据

这些结果属于 f58e13139f2deab7b22aef3aa46c81779f9a0213 的产品模块指纹。measured-harness.js 是原样执行脚本；每个 scriptSha256 和 after 模块哈希均核验。原始 HEAD 可能含同指纹的后续测试提交，保留不重写。

当时 host 未提供 actions/Truth prefetch，且所有 concrete host 都绑定 verifier。缓存命中后零 View.read/regex 工作可以揭示机制上限，但不能代表真实批预取仍有成本的路径。该源码还保留 sliced line，可能让小匹配保留较大 source backing；因此不用于最终 retained-data 安全结论。最终 9dbf513 改为可选 index 构造 gating、完整已验证匹配行 detachment，并重新跑 full actions/prefetch 矩阵；最终结果放在上一层。

这些历史数值和原始负样本保留用于审计，不宣称 2MiB 是 heap/RSS 限额，不授权默认索引启用。
