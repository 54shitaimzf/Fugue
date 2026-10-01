# 0.3.1 增量：blob 键控 trigram 格式 v1

这是路线图 § 4 的第一个独立小步：格式与 codec。持久 `.fugue/idx/` 读写、
损坏后的实际重建、随读增量构建和查询接线在后续单元，不宣称阶段二已完成。
它不改冻结的 Truth/View/Log 契约，不加外部依赖，不抽取 T1 符号，不启用 rg。

## 格式

每份记录只描述一个完整 Git blob ID，字段顺序固定：

```json
{"format":"fugue-blob-trigrams","version":1,"blob":"<40/64个小写hex>","sourceBytes":3,"textUnits":3,"tables":{"trigrams":["abc"],"symbols":null},"checksum":"<payload的SHA256>"}
```

编码是 UTF-8 JSON，加一个换行。校验和覆盖除 checksum 外的固定字段与表。
trigram 是 **3 个 UTF-16 code units**，严格排序、去重：先用与 grep 相同的
Buffer UTF-8 解码，再取字符串片段。不能直接取原始 3 字节，否则非法 UTF-8
转成的替换字符、emoji 和非 ASCII 查询会出现漏查。

`symbols: null` 明确保留未来的另一张表，但没有抽取或查询能力。当前 decoder
不理解非 null 的符号表，会给 miss；未来扩展必须有明确的版本兼容处理。

## 预算与失败

- 源 blob 最多 64 MiB；构建先核原字节的 Git 内容地址（SHA-1 或 SHA-256）
- 单份记录最多 8 MiB，最多 200,000 个不同 trigram；超预算拒绝构建
- 解码时核完整对象 ID、版本、字段面、预算、严格排序/唯一性与完整 canonical 字节
- 损坏、半份字节、重复/额外字段、异版本、异对象、不支持的符号表都返回 null
- 调用方必须把 null/不可索引预算读成退回扫描或重建，不能让它阻止读取真源

**信任边界：校验和是损坏检测，不是来源认证。** 内容覆盖来自本模块对真实
blob 的完整构建。一个能按正确格式与新校验和伪造整份表的人仍能伪造表内容；
codec 只拒明显不可能的空表/长度形状，不能证明一个格式合法的非空表确实
覆盖了原内容全部 trigram；不声称认证攻击者制造的索引，也不把索引当新的真源。后续存储单元必须
保留受控构建来源和损坏退档，不把任意外部提供的表接进查询。

## 检查

```sh
node tools/test-entry.js fast src/search/index-format.test.ts
node tools/check-targets.js
node tools/check-events.js
```

断言覆盖格式往返、确定性、空/短文本、非法 UTF-8、NUL、emoji/换行、SHA-1/SHA-256
源绑定、损坏 miss、未知/重复字段、符号位、排序/唯一性、三种预算与重新构建。
200 份固定种子的二进制语料逐片段核 decoded UTF-16 trigram 全部保留。
没有时长阈值、ext4 性能常数或阶段二冷路径达标声明。
