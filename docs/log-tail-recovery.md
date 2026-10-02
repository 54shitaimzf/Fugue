# 日志未提交尾段：非破坏读取与写者拒绝

官方 `ff40425` 的 ROADMAP §10 明确保留盘上原字节，恢复即清理的政策尚未决定。本组合撤回旧候选的自动 `truncate`；旧 `0372b73` / `5202914` 的相关证据是历史候选，不能当作当前已接受的清理策略。

读者只解析最后 LF 之前的完整段，忽略未终止尾段且不改文件。写者仍用既有 64KiB 尾窗口、`readFully` 短读填充和原字节 `completeEndOf`，先验证最后完整行的 CRC 与 writer；发现任何未提交半行时明确拒绝追加，保留诊断字节。整份文件只有首条半行也拒绝写入；超窗口不能确认完整行时不猜序号。更早历史的全量检查仍在读取/重放路径。

这一写者拒绝是 PR45 中的可靠性修复提案：官方主线虽然保留尾段，却仍可能向半行后追加，让原本可读的前缀之后产生坏整行。拒绝避免继续扩大损坏，不替用户决定该删除、保留或迁出哪些字节。用户需要先确认恢复处置再重试；产品没有新增清理命令、事件或自动修复。测试中的人工修复只操作本测试独占的生成夹具。

完整坏行、foreign writer 与顶层重复键先报原错误；后面的半行不能让它们被忽略。整条写命令的 writer fence 保留；同句柄首次初始化按 writer 共用 Promise，失败后可重试。close 关闭新 append 入口，等待已接受的初始化与串行写、观察关闭尝试，再释放 fence；迟到写拒绝。这里依赖合法写者遵守 fence，不承诺抵抗绕锁的同 UID 主动修改。

完整尾行的追加仍遵从架构 §9.5 的 each/batch/never 刷盘档位。没有自动截断或额外恢复 fsync；写入/同步故障的原错误仍交调用者判断，不声称断电硬件证明。原始完整行、事件、编码与 CRC 不变。

```sh
node tools/test-entry.js fast src/log/tail-recovery.test.ts src/log/maintenance-integration.test.ts src/log/log.test.ts
node tools/test-entry.js real src/tools/index-acceptance.test.ts
```

当前控制覆盖不同 flush 档、UTF-8 半码点、跨 64KiB 前缀、首条半行、短读/早零、完整坏行优先、持锁拒绝、同句柄初始化共享、失败后显式修复重试与 close 栅栏。精确当前组合检查与推送 CI 另按 head 记录，不沿用旧自动截断候选的通过数。
