# 0.2.6：checkpoint 的阶段事实

`checkpoint.ts` 的现有顺序是 `putTree → commit → advance(CAS) → log.append`。它跨 Git 对象、ref 与 M0，和视图编辑的 `blob → 日志 → 内存` 三步是不同接缝。`src/checkpoint-stages.test.ts` 用五个生成的真实 Git／日志用例，确定性地在已完成接口边界注入异常，再关闭后端并重新打开，观察各自实际完成的事实。

每例先保存一份底稿提交、持有真正的写者锁，并通过 `applyEdit` 完成一个包含 NUL、无效 UTF-8 和执行位的新文件。随后 checkpoint 停在：

| 注入点 | ref | M0 新 checkpoint 行 | 已完成对象 |
|---|---|---|---|
| 树已写，尚未提交 | 旧值 | 无 | 可用 `git ls-tree` 读到原文件和新文件的树 |
| 提交已写，尚未 CAS | 旧值 | 无 | 树和可读的孤儿提交 |
| CAS 调用前注入拒绝 | 旧值 | 无 | 树和孤儿提交 |
| CAS 已推进，尚未追加日志 | 新值 | 无 | 新 ref 指向完整提交 |
| 完整日志行已追加，确认失败 | 新值 | 有，且指向同一提交 | 完整提交及 checkpoint 行 |

原有视图写入行在五种状态里都保留。新后端从实际 ref 选下层，再从完整日志行重放，五例都恢复原文件、新文件的逐字节内容、执行位与 rev。已有 `checkpoint.test.ts` 继续验证真实竞争 CAS 的输家不落日志；这里的「CAS 调用前拒绝」是接口异常注入，不冒充一次真实竞争。

负对照在私有副本中把 CAS 移到日志之后，同一五例中的三例变红：不该出现的 checkpoint 行已经写下，或日志确认失败使 CAS 根本没完成。产品不增加故障开关。

```
node tools/test-entry.js real src/checkpoint-stages.test.ts
node tools/test-entry.js fast src/checkpoint.test.ts
```

本矩阵属于路线图 0.2.6 的逐阶段恢复验证，依赖实际 Git 进程，因此明确标记 real。它验证现有对象／CAS／日志顺序，不定义掉电耐久性、原子回滚、活跃 RefHead 缓存恢复或失败后的重试策略。尤其不能把「CAS 已推进，日志未追加」写成 ref 与日志必定相等，也不能把失败返回写成未提交。既有 `replay.test.ts` 的强杀、残缺尾行与快照失效断言仍独立保留；本单元不改产品协议、尾部修复或历史录音，不能替代完整 0.2.6 验收。
