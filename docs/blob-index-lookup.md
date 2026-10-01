# 0.3.2 增量：非阻塞 miss、受控后台构建与扫描退档

`src/search/blob-index.ts` 将 codec 与存储接成一份可选读句柄：

```ts
const index = createBlobIndexLookup(root, (blob, signal) => truth.getBlob(blob))
try {
  await index.mightContain(blob, requiredTrigrams) // boolean | null
  index.stats()
} finally {
  await index.close()
}
```

- true：全部必要三元组在表里，仍须回真实文件做 regex 验证
- false：受控构建/格式校验的表不含至少一个必要三元组，可排除这一 blob
- null：条件不支持、索引不可用、读/构建失败或预算不足，调用方必须扫描

当前单元**没有产品查询接线、没有默认启用、没有0.4性能达标声明**。调用方要
先从当前 View 取 blob ID、只提取确定必要的 UTF-16 三元组，不能拿物理工作树
或不兼容 regex 的猜测替代。持久表沿用 codec/存储明确的受控构建信任边界，
校验和不是对主动同 UID 伪造合法非空表的认证。

## 查询与后台工作的边界

先查句柄内存，再做有界磁盘读取。已有不可变 ID 不重读原字节。磁盘 miss
**先给主查询 null**，下一事件循环才调用原字节回调；核内容地址、计算与持久化
在独立 Worker 中执行。因此缺索引不能把查询挂在 source/rebuild 的等待链上，
但磁盘 probe、校验和已有记录解码仍有成本，也不承诺主线程绝不受后台资源竞争影响。
新增 ID 只补自己；损坏记录给 miss，然后从可信原字节重建。没有第二份权威状态。

后台任务默认最多4份，上限16份；同 ID 共享，不保存无限候补队列。满额给 null，
以后查询可以重试。默认60秒任务时限（可配0–120秒），包括磁盘 probe/source/构建；
0禁用新任务。每个任务向 source 传 AbortSignal，close 或外部 signal 取消任务、
终止已经启动的 Worker，清句柄缓存与逻辑 pending，并尝试收走自己 nonce 对应的临时文件。
Worker可在同一句柄内短暂复用，池存量/空闲退出与创建次数见[复用边界](index-worker-reuse.md)。
Worker 只收到可见字节窗口的独立副本并转移该副本，不转移借用 Buffer 的 backing store，
不会携带池内其它字节，也不会 detach 原回调的字节。Worker 不继承宿主环境变量。

调用方拥有句柄生命周期，须显式 close；主查询不能先 drain 再扫描。
`drain()` 仅供开发基准/收尾等已接受任务，不自动接受新任务。
取消**不是事务回滚**：已发布的完整派生记录可以留下；临时清理是尽力而为。
不遵从 AbortSignal 的 source 回调，其外部 IO 可能继续，退休逻辑槽也不能证明该 IO
已停止或其真实并发已封顶。迟到的回调结果会被丢弃，不再启动 Worker；需要真正的 IO
取消/并发界限时，调用方必须提供遵从 signal 的源。测试覆盖 source 等待及 Worker 活跃时
close、超时、失败重试和外部 abort，不声称任意外部回调都可强制终止。

## 内存与持久边界

句柄默认保留最多256条、1,000,000个packed48位 UTF-16键、16MiB canonical记录
字节记账，三个独立 LRU 上限。runtime Set/Map 与 Worker 还有额外分配，
**canonical字节数是逻辑记账，不是精确堆内存或RSS**。单份记录/source预算由codec控制。
必要三元组在任何 await 前拷成私有数值键，后来的调用者数组变化不改这次判断。
失败不缓存；任务完成/失败/取消清逻辑pending。**唯一的例外是确定性失败**：同样的字节永远同样的结果（超 64 MiB 源字节预算、超 20 万个 trigram），记进有界集合（4096 份，满了丢最旧的，`stats().unindexable`），之后这份 blob 直接回扫描，不再读源、不再起 Worker；读源出错、超时、取消都不记，下次仍会重试。容量0可退档，危险磁盘不阻止可信内存构建。
持久存储没有全盘配额/淘汰，原字节回调与M0/M1既有缓冲也不属于保留缓存的RSS保证。

## 复现与测量

```sh
node tools/test-entry.js fast src/search/blob-index.test.ts src/search/index-store.test.ts src/search/index-format.test.ts
node tools/bench-blob-index.js
node tools/check-targets.js
node tools/check-events.js
```

固定基准把缺索引查询与后续 drain/preparation 分开，报告原字节读取、磁盘命中、
内存命中和未知候选。每一趟候选回真实文本验证，并将**精确命中ID**与完全未过滤的
源文本参考比较；初始8个命中、新增后9个，不能靠所有档都误删成0骗过基准。

一次云工作区读数（16个blob，2,228,495字节）：首次缺索引查询20.498ms，全部16个
候选退扫描；后台补齐另耗1652.047ms。内存热2.864ms、磁盘冷重启28.634ms；新增ID
的miss查询28.023ms给扫描，drain另记录1次source/构建。这里的后台成本不得隐去。

另一个257条/默认256容量的顺序语料专门测循环LRU失配：预建729.703ms，两趟均
257次磁盘命中、0次内存命中、0次原字节读，分别390.835/434.149ms，精确命中均129条。
**原字节读取为0不等于快**；反复磁盘读取/解码会抹掉收益。默认启用前必须在真实语料
测量容量、磁盘/内存冷热和端到端grep。以上是独立机制的云overlay读数，不能冒充
一等档ext4常数、完整grep验收或0.4达标证据。
