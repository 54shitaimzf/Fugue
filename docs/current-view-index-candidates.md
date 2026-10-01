# 当前视图的索引候选相交

对应路线图 0.3.3 的「当前视图文件集合与 immutable blob 索引相交」。这一小步只提供
`src/search/current-view-candidates.ts` 的独立适配器，没有接入 grep、构造索引或默认启用任何功能。

## 输入与退路

`filterCurrentViewCandidates(view, paths, required, lookup)` 接收当前 View 的只读元数据口、
有序路径批、已经证明必要的 UTF-16 三元组，以及按 immutable BlobId 查询的回调。
每批最多 128 个候选、128 个三元组；这两个限制是数量上限，不是 blob 字节或内存上限。
空条件、稀疏数组、非三单元字符串或超限条件直接保留原批，且不读元数据、不调用索引。
有效条件先取稠密快照并冻结，调用方后续改动数组不改变正在查询的条件。

每个路径重新问 `View.stat`，不缓存 path→blob，也不看物化目录或宿主工作树。
仅普通文件的完整小写 40/64 位对象 ID 可进入索引。回调返回严格 `false` 才排除；
`true`、`null`、异常、错误类型、非文件或坏元数据都保留路径，交给原内容读取与精确正则验证。
因此这里的输出仍是候选集合，不是匹配结果。保留原路径顺序。

整批记录 `base` 与 `rev`；每次异步元数据/索引工作后检查。若其中一个改变，撤销本批
所有先前负判断并退回完整输入批。不会复用旧路径身份，也不会把别的 View 的判断套过来。
这不是整个枚举与查询的原子快照；最初枚举外新出现的路径仍不由这个适配器发现。

## 验证

通过唯一测试入口：

```sh
node tools/test-entry.js fast src/search/current-view-candidates.test.ts
node tools/check-events.js
node tools/check-targets.js
```

八项测试覆盖顺序、独立 View、内容变更、rename、chmod、删除/重建、base/rev 竞态整批回退、
未知/异常/畸形元数据、非文件、稀疏/超限条件的零调用，以及调用方数组突变。
这些是适配器的逻辑测试；实际 host/tool 接线、持久索引失效和冷/热端到端测量留给后续小步。
不改变工具目录或历史 live 录制，不产生新增事件。
