# 0.2.9 不变量诊断网：目录与能力表

这一件只补开发诊断与 fast 测试，产品载入断言继续保留。它不接装配、模型发送或工具执行路径，不改变工具目录、事件联合、Truth 或 ToolHost。

运行 `node tools/check-invariants.ts`，从真实 `TOOL_ENTRIES` 和独立的 `CAPABILITY_TABLE` 对账：工具名双向完整且不重名；层属于架构 § 8.9 声明的四层；能力标识就是该格工具名；声明集标记是布尔值，且只能挂在执行层。运行 `node tools/test-entry.js fast test/invariants.test.ts` 验证同一函数的正反两半。

具体缺口是已有工具被填入 `layer: 'unknown', decl: false`：原来的 `checkInvariant` 只核名字及非执行层的真声明集，因而报零违反。新诊断必须点出该工具和未知层。截短目录、缺能力行、表外名字和重名也是负对照；工具名来自目录，不在诊断工具里另抄一张表。

这不是整站 0.2.9 收口证明。协议、契约字段、信封及其余不变量仍由原有测试负责；本单元没有移除载入检查，也没有实现 `ui.keys` 或清扫运行时断言。
