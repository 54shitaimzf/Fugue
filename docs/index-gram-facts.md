# 有界不可变gram知识：跨完整表LRU的重复查询

这个单元给**已经可选启用**的索引句柄增加一份有限内存知识，不启用产品缺省索引，不修改
事件/工具目录。解决的是512份blob循环访问超过256份完整表LRU时，重复查询仍读512次盘。
新查询、新gram、不可用索引仍走原来的完整表或scan退档，不能凭热查询宣布0.4冷档达标。

## 学什么，不能推断什么

- 私有缓存按完整BlobId与48位UTF-16三单元键记present/absent。每个lookup创建自己的缓存；
  独立仓库/句柄不共享状态，SHA1的40字符hex ID与SHA256的64字符hex ID也不会混淆。
- **只从非null、完整、受控的PreparedIndex学习**：可信源的内容地址核对/受控存储信任边界
  沿用原索引。不从原扫描、miss、异常、半张表或调用方布尔猜测灌入知识。
  容器本身不认证来源；checksum不能证明主动同UID伪造表的完整性，这个边界没有被缓存消除。
- 任一个必要gram已知absent即可返回false；所有必要gram已知present才返回true；其余null。
  true只意味着**候选**，原文件的regex验证始终还在。一个未知项不是缺失项。
- 必要键在任何await前捕获。异步结果回到句柄后先看closed，再学习；close清知识，迟到结果
  不能重新填回。冲突的旧/新知识或同批重复键互相矛盾，会清整份blob知识并拒绝该批。
- 没有路径知识、没有永久索引或额外日志。当前View身份/变代回退仍由候选适配器执行。
  源回调不遵从AbortSignal的外部IO问题仍存在，不能用close的内存清理冒充强制停止该IO。

## 两层不同的保留预算

完整表仍是256条 / 1,000,000个packed键 / 16MiB canonical字节三个独立LRU约束。
**额外事实层**默认2048份blob / 32768个事实 / 1MiB逻辑记账，独立约束并按整blob LRU淘汰。
逻辑记账为ASCII blob ID长度 + 每事实8字节键、1字节布尔。Map/对象/Worker/源字节还有额外
分配，这些数字不是总RSS；事实也不挤占完整表的canonical预算或假装一份完整表。

```ts
createBlobIndexLookup(root, source, {
  facts: { maxBlobs: 2048, maxFacts: 32768, maxLogicalBytes: 1024 * 1024 },
})
// facts:false关闭事实；原完整表的任一保留预算=0也关闭事实，避免暗中重启缓存。
```

事实上限的合法范围分别0–16384 / 0–262144 / 0–16MiB；0禁用，溢出预算只淘汰或未知。
机制stats分别报告factHits/factEntries/factKeys/factLogicalBytes/factEvictions/factConflicts，
不把这份统计写成新的M0成本台账，不虚构per-tool token归属。

## 断言与复现

```sh
node tools/test-entry.js fast src/search/index-facts-lookup.test.ts src/search/index-gram-facts.test.ts src/search/index-worker-pool.test.ts src/search/index-worker-reply.test.ts src/search/index-builder.test.ts src/search/index-format.test.ts src/search/index-store.test.ts src/search/blob-index.test.ts
node tools/bench-index-facts.js
node tools/bench-index-membership.js --product-root <已审查query/probes组合checkout> --reference-root <771e8640旧lookup checkout> --runs 3 --files 512 --lines 256
node tools/check-targets.js
node tools/check-events.js
```

容器有5000份生成查询对照及UTF-16/binary/SHA1/SHA256实际codec模型；集成覆盖未知新gram
重新读完整表、跨实例/仓库不共享、requirement异步变更、close竞态、坏记录/失败不学习、
预算/禁用退档。组合查询测试还复跑当前View新ID/变代、真实store、fake端口、早停/截断。

模型基准明确没有文件系统IO：512/256循环的第二同query完整解码512→0；多样新query
仍512次解码，不能只挑一份命中缓存的query泛化。实际基准另用指定的已审查产品模块，
**分别导入旧/current lookup后端并核不同源hash**；默认关闭的scan作第三方逐字节回执参考。
准备是明确的离线可信构建，不能当runtime首次miss/drain免费；scan在pairs外预热OS页缓存，
也不能当物理冷盘。

一次3趟交替的实际512文件、16,037,385字节读数：首次sparse567.434→548.530ms；紧接
重复sparse445.822→6.524ms（disk512→0，factHits512），再后重复sparse441.477→5.456ms，
重复miss416.762→6.758ms。新miss481.549→494.798ms、新file510350.125→383.112ms，
dense23.013→31.308ms，仍有无收益/变慢档。最终11392事实/123008逻辑字节，全体回执与
默认关闭scan一致。不要隐去首次/新查询成本、单靠零source请求冒充零磁盘读取。

这些是共享云overlay趋势，不是一等档ext4验收或一般16MB冷查询<50ms。新查询冷路径、
第一份缺索引查询、后台source/build准备仍要单列。缺索引与runtime准备矩阵见下一节；
达标以前产品默认继续关闭，不能宣布0.4完成。

## 首miss与runtime准备（不是上面已准备档）

同一16,037,385字节的实际组合checkout另跑一次缺索引矩阵（所有最终lookup/helper hash
匹配）。dense/sparse/miss首查询34.743/215.803/210.892ms，首查询sourceReads均4、
factKeys均0；miss没有偷学扫描结果，也没有把首次源构建藏进热档。
对应drain138.078/3.171/1.816ms，后续显式补齐准备4,160.018/4,633.253/4,010.235ms。
重开句柄的已有盘读70.757/599.377/501.391ms；同句柄重复0.983/7.975/5.720ms。
这份单次矩阵与3-pair已准备对照职责不同，source/build、盘读、新query都不能删去。
目前只有重复/已知知识档改善；所有条件齐之前缺省仍不启用。
