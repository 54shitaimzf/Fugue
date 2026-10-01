# 0.2.6：拒绝含重复JSON键的完整M0行

依据已合入上游32bb00c的ROADMAP §3 / 0.2.6维护批。JSON.parse会保留重复键的最后值，
原M0再按该结果算CRC，因而一行可同时写`seq:999`和`seq:2`却通过后者的CRC。完整行
现在拒绝这种歧义：信封、载荷及任意嵌套对象都要求键唯一，数组成员各有独立对象作用域。

先由原生JSON.parse验语法，再用迭代扫描识别冒号前的键。键按JSON解码后的字符串
比较，所以`a`与`\u0061`是重复；空键、escaped quote/backslash、UTF-16 surrogate别名
同样按实际键判断。字符串内容里的JSON样子不是结构，相邻对象复用键也不是重复。
只有JSON escape等价会合并，大小写/Unicode NFC等不做额外归一化。

这是对畸形输入的读取拒绝，不增加事件字段或M0方法；encodeEvent、字段顺序与CRC计算
逐字节保留。旧正常行、重排键、JSON允许的空白、模型内容中JSON样子的字符串继续读。
完整重复键行走已有LogCorruptError，并指出writer/行号；只读加载不改日志字节、不造
锁或修复文件，写者遇重复键完整尾行也不能继续追加。未换行的尾段保留既有读侧忽略
规则；本单元不新增/改写物理尾段恢复策略，不扩大为0.2.7发送策略或工具成本event批准。

扫描不递归、不对每个value做二次JSON解析，线性走原行，额外状态仅是当前嵌套的对象
键集合与结构栈，总量受输入长度约束；长键的错误展示只取120个UTF-16单元，避免异常
消息放大。**这不是端到端有界内存日志读取**：既有JSON.parse/native对象与M0整文件/
多writer缓冲仍在，也未偷偷加新的行长/深度拒绝门。大的正常字符串仍需正常解析与CRC。

```sh
node tools/test-entry.js fast src/log/duplicate-keys.test.ts src/log/envelope.test.ts src/log/log.test.ts src/log/cache.test.ts src/log/hold.test.ts
node tools/check-targets.js
node tools/check-events.js
```

新7条在未改动main是1通过/6失败（只有正常兼容性通过），修改后7/7；日志focused套件
40/40，视图重放/轮协议/既有模型wire兼容检查19/19。负对照不是坏CRC：先保留原规范记录的末值与CRC，额外塞第一份歧义键，也必须
被拒。冻结的旧有效字节向量仍往返，所有事件类型/缓存/并发writer/截尾现有断言一并跑。
没有更改冻结event/schema或把synthetic录音当真实模型验收；全量/一等档/PR验收另计。
