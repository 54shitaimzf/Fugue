# 正则候选过滤的保守字面量前置

这是路线图 0.3.3 查询接线的独立前置单元，不接工具、宿主或持久索引，不改版本/目录/回执，
也不表示 0.3.3 已完成。当前工具读法不受影响。

`requiredLiteralTrigrams(pattern, flags)` 只在能证明每个真匹配都必须包含某段 literal 时，
返回非空的三元组条件；无法证明返回 `null`，后续调用方必须回到完整扫描。
它接受的是 `new RegExp(pattern)` 的模式字符串，不是 `/…/flags` 形式的代码。

## 支持与退回

- 支持整段普通 literal、单个外层 `^` / `$`，以及转义后的正则标点、斜线、连字符
- 转义后的 `$` 是正文，不被误当锚点；两个反斜线后的 `$` 则仍是锚点
- 量词（包括 `abc*` / `abc?` 可省略末字）、选择、类、分组、lookaround、反向引用、字符/边界转义、任何 flags 或其他不确定语法都返回 `null`
- 短于三个 UTF-16 code units 的 literal 无法产生非空条件，返回 `null`
- 超过 4,096 pattern units 也退回扫描，不裁掉模式、拒绝调用或改变正则匹配语义
- 最多返回 128 个去重、有序的必需三元组。只选一个必需子集仍安全，少取只会多扫，不会漏掉真匹配

三元组按解码后的 JavaScript UTF-16 code units 取，不按 UTF-8 原始字节或 Unicode code points。
这与索引格式和现有 `Buffer.toString('utf8')` / `RegExp` 相同。emoji 的 surrogate 边界和非法 UTF-8
的替代字符都保留这个口径；JSON 可以表示三元组里的孤立 surrogate，不另外做 NFC 等归一化。

## 调用方纪律

过滤是辅助机制。只有经过验证的索引明确证明某个必需 gram 不在 blob 中，才可以排除这个候选。
索引缺席、损坏、不支持、超预算或失败都必须扫描；空条件不构成排除证据。
即使所有必需 gram 都在，仍须用原始正则在真实文件行上验证，不能把 gram 命中当成正则命中。
完整候选范围仍由视图/遍历状态决定，索引不能把不完整枚举变成“没有匹配”的证明。

## 验证

```
node tools/test-entry.js fast src/search/regex-literal.test.ts
```

测试包含字面量/锚点/转义标点、可省末字、选择、lookaround/flags/反向引用的退回、
emoji/替代字符/孤立 surrogate、工作预算，以及 3,000 个固定种子的 matcher ⇒ gram 包含矩阵。
null 的未实现接缝负对照抓住了正向字面量与 Unicode 条件的缺口；不以速度常数作断言。
