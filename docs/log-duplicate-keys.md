# M0 重复键：跟随已接受的上游边界

官方 0.2.6 / `807885e` 接受的是**顶层键唯一**：信封和顶层载荷字段的重复键在 CRC 之前拒绝，包含 JSON 转义后的同名键。编码、CRC 和合法日志读取结果不变。产品 `src/log/envelope.ts` 原样使用上游 `duplicateTopKey`，没有恢复早先候选的所有嵌套作用域拒绝。

嵌套 payload 目前沿用原生 JSON 的最后值语义。上游源码明确把扩大嵌套拒绝留给第二种 payload 实现出现后再论证。`duplicate-keys.test.ts` 保留原来那些嵌套/数组/转义反例的输入，但现在断言它们按已接受的最后值结果读取；未来候选扩大边界必须另经规格决策，不能把历史 fork 证书当成上游已经采纳。

持久交互控制使用**转义的顶层重复键**，保留匹配末值的 CRC：只读载入拒绝、不改字节；完整坏行之后即使带部分 UTF-8 尾段，写者也先拒绝且不截断。只修生成夹具里的坏行后，同一句柄可重试，重放保持索引与目录白障结果。没有 LF 的尾段保留原字节；写者拒绝追加，独占生成夹具经显式处置后才重试。

大合法字符串和带 JSON 样子的文本仍正常读取。当前上游诊断包含完整重复键名，没有继承旧候选的 120 字符展示截断；本分支不另加行长、深度或错误展示拒绝门。原生解析与整文件日志缓冲仍在，不声称端到端有界内存。

运行：

- `node tools/test-entry.js fast src/log/duplicate-keys.test.ts src/log/envelope.test.ts src/log/log.test.ts src/log/maintenance-integration.test.ts src/log/tail-recovery.test.ts`
- `node tools/test-entry.js real src/tools/index-acceptance.test.ts`

早先 `9420f8d` 的全作用域扫描与 7/7、40/40 等读数是该不可变候选的历史证明，认证范围没有迁到本次已接受的顶层实现。当前组合的精确 head 与 CI 另验，不改变事件联合或发送策略，也不把兼容录音称为真实重录。
