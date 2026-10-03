# 内部不变量网：上游主体与能力表补充

当前主体采用上游 `f4b571b3aad7fd114506ed5b01e90f0fb4106a0c` 的 `tools/check-invariants.ts`：能力表、协议、段源、契约字段与事件信封五段正反对照全部保留。生产能力表采用同一上游版本，不重新落一份表或恢复模块载入 throw。

按 PR45 的审查意见，额外保留四格检查：目录重名、层的允许域、跨行能力标识重名、声明集标记必须是布尔值。纯开发帮助口 `tools/capability-invariants.ts` 读取实际目录和独立能力表；完整 CLI 网调用它，打印四条对应负对照。`test/check-invariants.test.ts` 要求这些标签确实出现，防止只测试帮助口而漏掉真实 CLI 接线；`test/invariants.test.ts` 继续覆盖名字缺失、身份错误、声明集层约束、同源数组引用与公开目录字节指纹。

运行：

- `node tools/check-invariants.ts`
- `node tools/test-entry.js fast test/invariants.test.ts test/check-invariants.test.ts src/capability/table.test.ts`

能力标识重名和「标识不等于本行工具名」分别报错；一个坏表可同时违反两条，不能用后一条的偶然命中代替前一条证据。上游其他内部断言处置由其已审版本负责，模型输入、路径围栏、沙箱与执行校验没有本次新增处置。

`ui.keys` 已由上游 PR50 实现并通过实际配置/键盘接线测试；旧贡献中尚待请示的表述属于历史状态。本次仅同步已实现的配置，不扩展视觉工作；外观批按最新路线图排在 serve 之后。
