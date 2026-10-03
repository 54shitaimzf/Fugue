# 0.3.0 开发读口与候选元数据：配对测量

这份记录只证明两批改动的局部机制和代价；不表示路线图全部完成、不启用默认索引、不作真实提供方调用。脚本只创建自己的生成语料和 Git 仓库，最后清理，没有产品源码修改。

## 源码与复现

- 比较起点：`a73a1770ba77c0fb054fc7c91655103e57107ab2`
- A 实现：`5ca844a079219272c25e9498fef4519ddf4cf705`
- B 实现：`ab48c950b6836b74a1d1f652011199c81ba1d85e`
- 两批源码已合在不可变提交 [e8830bee](https://github.com/54shitaimzf/Fugue/commit/e8830bee58079adf588a1f14cd1f3fde078aa5d4)。每个被测 after 模块的 SHA256 已逐一对这个提交核验。原始 JSON 的 HEAD 字段保留运行当时的提交；有未提交新文件时，以源码 SHA256 为精确识别。
- `provenance.json` 给出各原始结果的 SHA256；`environment-source-manifest.json` 保存完整 src 文件清单与哈希、Node、CPU、内核和文件系统。历史执行脚本保存在 measured-harness/；原始矩阵的哈希与这些历史版本一致。审查后的当前脚本有资源所有权和回执检查修复，哈希单独记在 provenance.json，不冒充原来跑时的版本。

测量机器：Node v24.19.0、Linux 6.18.44、Intel Xeon Platinum 8573C；生成语料放在工作区 overlay 文件系统，不能当作 WSL ext4 的目标机器认证。没有丢弃 OS 页缓存，没有频率或其他宿主进程控制，也没有统计显著性承诺。重 CPU 测量窗口已与实现者协调。

从含这份脚本的目录运行，两个路径必须是分别检出的精确源码；基线目录不需要有 stream.ts：

```sh
node tools/bench-reader-paired.js --before /path/to/a73 --after /path/to/e883 --runs 3
node tools/bench-call-ledger.js --source /path/to/e883
node tools/bench-cohort-paired.js --before /path/to/a73 --after /path/to/e883 --files 64 --runs 2 --profile code
for profile in code mixed entropy; do
  node tools/bench-cohort-paired.js --before /path/to/a73 --after /path/to/e883 --files 512 --runs 3 --profile "$profile"
done
```

脚本的语料构建不计入查询时钟；它是开发测量准备，不是产品查询的隐藏工作。Truth/View/adapter/store 的构造和关闭也在单次查询时钟之外。索引内容准备单独完整计费。原始结果保留每次墙钟、CPU、读数和回执哈希，不只保留中位数。

## A：保留量变小，完整读取变慢

`reader-paired.json`：8 位 writer，每位 3,000 行，共 24,000 行、42,804,200 字节；非调用行包含长文本与多字节字符。先在计时之外逐行 deepEqual 两个完整结果与独立生成的参考序列，再交替次序运行原始读口，在线折叠完整结果哈希与最多 5 行的调用账。三次 fresh 与三次 repeat 都检查完整哈希、逐调用账、总调用数。另检查 fromSeq 后缀。最后一个 writer 的末尾插入完整坏行，两个读口都在首行输出前抛 LogCorruptError，没有漏掉迟到的损坏。

| 读口/状态 | 首行中位数 ms | 全部折叠中位数 ms | 每次源字节读取 | stat 次数 |
|---|---:|---:|---:|---:|
| 缓存 M0，新句柄 | 911.149 | 1,170.022 | 42,804,200 | 8 |
| 快照流，新调用 | 788.557 | 10,527.539 | 85,608,400 | 194,656 |
| 缓存 M0，同句柄重复 | 2.887 | 294.438 | 0 | 8 |
| 快照流，重复调用 | 749.568 | 11,738.984 | 85,608,400 | 194,656 |

这不是速度提升。fresh 全量中位数约慢 9 倍；repeat 约慢 40 倍。首行之前必须全量校验，所以不能把逐行 API 叫作免校验的即时首行。两遍解码、每条结果前对所有 writer 做稳定性 stat，以及没有解析缓存，是实际付出的成本。计时包含相同完整结果折叠，也包含开发用 I/O 包装开销。产品 M0 轮询仍使用原缓存；这条新路径仅供开发调用账。

逻辑保留量与实测内存分开：旧路径保留全部 24,000 个解析行，归并另持有 24,000 个行引用；新路径归并最多 8 个头，暂停的迭代器各保留 64KiB chunk，以及有上限的行片段。原始 JSON 的 logicalRetention 是由源码和语料导出的算法计数，不是 heap/RSS 实测值，不包括 GC、字符串布局、临时拼接、文件名库存等所有内存。maxWriters 的拒绝发生在目录库存枚举之后，文件名枚举仍无总量边界；已经获准的读取才受 writer×rowLimit 边界约束。坏行、尺寸上限或稳定性拒绝均不修复日志。

`reader-capped-heap.json` 是另一个、不可用于延迟优劣比较的独立进程负对照：单 writer、24,000 行、109,823,886 字节、300 次调用，最终账只保留 5 行。两个子进程都限制 V8 old-space 为 32MiB，禁用生成基准进程的 core dump。旧路径 SIGABRT；完整 stderr 明确记载 V8 heap OOM。快照路径成功，4,273.855ms，实测进程 maxRSS 69,452KiB。32MiB 的 V8 上限不是总进程 RSS 上限；RSS 含原生内存。这个反例只说明这份生成语料在该上限下新路径可完成，不能推出任意语料的 RSS 公式。次序 cached-first、OS 缓存未清，不能拿两进程比较速度。

## B：去掉本代已经证明过的路径 stat

`cohort-*-512.json`：每份语料 512 个独立 blob，每文件恰好 32,768 字节，总计 16,777,216 字节。code 是代码样式 ASCII；mixed 加中文、emoji、组合字符及 NUL；entropy 加确定种子的随机字节。每份都有密集命中、最后一文件的稀疏命中、无命中三种查询。`cohort-code-64.json` 是 64 文件/2MiB 的补充读数。

两个后端加载各自完整模块图，避免把旧 host 的所有权检查和新 adapter 的 WeakMap 混搭。每趟交替 before/after，使用相同生成字节但独立 Git 仓库。历史大矩阵每一种查询的每一个阶段都与原始 full-scan 的完整 output 文本严格相等，包括截断说明；当时没有保存 FaceResult.ok，所以这不是完整返回对象的比较。原始 JSON 的 fullReceiptEquality 字段名称过宽，必须按这里只证明 output 文本相等来读。dense 的文本回执会早停，不能假装扫描了 512 份源文件。修复后的脚本比较完整 FaceResult、断言 ok 为 true 并保存 ok 与完整回执哈希；64 文件小烟测重新验证了这条增强检查，不把它嫁接成历史 512 文件时钟的证明。

阶段分别保存：全扫描 fresh/repeat、初始索引缺失、付费 prepare、准备后 memory/repeat、重开 Truth/View/adapter/store 的 restartDisk、其后的 memory repeat。restartDisk 是新句柄的磁盘工件加载，不是物理冷启动。一次 prepare 在三种查询间共享；initialMissing 按 dense/sparse/miss 固定次序，首项承担首次 metadata 快照，其后已经能复用缺失结论。preparation 不能从收益账中删除。

以下是 512 文件 code 的三次中位数；括号是每次都相同的 View.stat 次数：

| 查询/阶段 | before ms（stat） | after ms（stat） |
|---|---:|---:|
| dense restartDisk | 39.407（545） | 38.830（513） |
| dense memory repeat | 0.415（33） | 0.275（1） |
| sparse restartDisk | 37.745（1,025） | 35.825（513） |
| sparse memory repeat | 3.723（513） | 1.178（1） |
| miss restartDisk | 34.027（1,024） | 33.189（512） |
| miss memory repeat | 3.462（512） | 0.547（0） |

code 的 prepare 中位数 623.865→617.647ms，每趟都读取 512 份源记录、做 512 次 metadata stat 并写一个工件。新路径 sparse 的余下 1 次 stat 属于最终真源命中文件验证，miss 为 0；磁盘重开仍要重新证明全部 512 个当前 View 路径。sparse 最终 readBytes 为 1，miss 为 0，两版相同；减少的是冗余 metadata，不是取消真源最终校验。dense 都只 readBytes 一份源，旧 adapter 另查首批 32 候选，新 adapter 从私有代际地图取已验证 ID。

mixed 的机制计数完全相同。其 restartDisk sparse 中位数 39.061→37.070ms，memory repeat 4.255→1.170ms；miss restartDisk 41.105→42.044ms，repeat 5.413→0.718ms。prepare 680.628→808.118ms。时钟有噪声，不能从每个阶段都推导普遍加速。原始样本中 after code miss restart 为 54.045ms；after mixed sparse/miss restart 为 83.265/85.518ms，dense 为 51.331ms，已经是 50ms 全覆盖承诺的反例。

dense 的 code 原始扫描 fresh 中位数分别 21.501/24.840ms，比准备工件后的磁盘重开约 39ms 还便宜。64 文件读数也有退步：sparse restart 12.260→16.454ms、dense repeat 0.476→0.730ms。不能只摘取最漂亮的热态数值。

entropy 的三次 preparation 两版都返回 false，都在第 147 份 sourceReads 后停止，没有产出工件；付费准备中位数分别 1,768.285/1,368.667ms。后续查找全部保持精确扫描 output 文本回执。sparse restart 中位数 578.164→622.021ms，miss restart 580.350→509.414ms，热态仍要扫描 512 文件；没有索引收益。拒绝是预算边界的正确退化，不能从这份测量授予默认启用。

每阶段 JSON 都保存 View.stat、工具 readBytes/prefetch、adapter sourceReads/diskReads/builds/fallbacks、store bytesRead/read/write 与 Git 请求/进程/缓存命中增量。prepare 的 sourceReads 是逻辑源读取次数，实际 Git 请求可能因 Truth LRU 已热而更少，二者没有混用。开发包装没有改产品算法。此次只跑生成基准与脚本语法检查，没有跑全套测试；产品验收另由实现者负责。

## 测量后开发脚本审查修复

原始时间矩阵保持不变，不为清理修复重跑产品性能。当前 reader 在分配语料和修改 fs 绑定之前先完成所有后端导入；分配后所有 setup 都进入拥有者 try/finally。当前 cohort 在分配 HOME 前完成导入与源码哈希不同的 admission，后续全部 setup 都在拥有者范围。两者用 benchmark-cleanup.js 逐一尝试所有清理并保留最初操作错误。无效 before/after 不创建语料；同一个 cohort 后端会明确拒绝，避免伪配对。

check-batch-benchmark-owned.js 的 9 个廉价 failure sentinels 全部通过：四种无效引用、相同后端、reader setup 失败后 fs 绑定复原与无残留、cohort 在 HOME 之后分配失败仍清理 HOME，以及全部 cleanup 继续尝试/原始错误优先。另有 2 writer×60 行 reader 烟测和 64 文件 code cohort 烟测通过。分别保存在 harness-failure-checks.json、reader-repaired-smoke.json、cohort-repaired-smoke.json。当前哈希、历史执行哈希和原始结果哈希分开保存；这些修复没有产品源码修改或重开默认功能。
