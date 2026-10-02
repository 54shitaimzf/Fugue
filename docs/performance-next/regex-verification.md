# 可选索引流水线中的完整 regex verification：配对证据

这批只测已选中可选 blob/cohort index 的 concrete host 验证缓存；普通默认 host 仍走原始读/解码/JS regex 路径。没有新增默认开关、默认索引启用、提供方调用或产品源码修改。此前 f58 探索指纹的读数另存于 regex-exploratory/，不冒充本批修复后证据。

## 本地源码、语料与方法

- before 本地源码：82db8f754ca7859beaae62db088f245893ad1ceb，相关产品模块与 e883 相同
- after 本地源码：9dbf5134c30afd0b4073fceeaca99a7bf29b136c
- 这是精确本地检查点，不是假定已经可公开访问的远端提交。发布等价映射另行记录，捕获的 HEAD 不重写
- 每个原始文件的 after 模块 SHA256 与 9dbf513 核验，before 与 82db 核验；每个 scriptSha256 与当前最终执行脚本一致。regex-provenance.json 包含原始/探索结果、脚本哈希和环境

代码、mixed、entropy 三份主体语料各有 512 个独立 32,768-byte blob，共 16,777,216 字节；mixed 包括中文、emoji、组合字符和 NUL，entropy 包含确定种子随机字节。路径 c/f0000…c/f0511。稀疏正则 rare(?:_hit) 在最后文件命中；密集 dense_hit 会早停；files_with_matches 每文件第一条命中就停止。另有 64 文件 smoke 和四种独立上限/淘汰语料。

同一 Node 进程加载 before/after 各自完整模块图，交替后端次序。每个 case 新开 Truth/View/host，接着同 host 两次 repeat，再重开句柄 cold 一次；所有阶段保留完整 FaceResult (ok/output/可选字段) 的实际 deepEqual，保存 ok、完整回执哈希及输出字节。原生 concrete host/readBytes 不替换，否则会绕过所有权并悄悄禁用缓存；只包装 View.read/stat 与 Truth.prefetchBlobs 观察。

默认基准构造完整 actions（含 refHeadOf）和 Truth 批预取，并明确选择一个缺失工件的 cohort adapter。候选未知保持原批，这个索引选择属于生成基准，不是产品默认激活。--cohort 单独付费 prepare；--plain 是未绑定 verifier 的默认 host 控制；--no-prefetch 是明确移除批预取的机制上限。生成 Git 语料、句柄构造和关闭在查询时钟之外；prepare 的全部源读取、构建、写盘与 metadata 单独计费。查询时钟内的预取和 Git 往返没有删掉。

before/after 每个 case 的完整返回实际比较。准备 cohort 的 before 是同一旧后端的索引流水线，不假称它自身是无索引扫描；另外，其全部回执哈希与同字节语料、工件缺失的 before 全候选扫描，以及 plain/no-prefetch 控制核验一致（provenance 有跨文件证明）。不是拿一份预设空答案冒充源扫描。

机器同前批：Node24.19.0、Linux6.18.44、Xeon8573C、workspace overlay；没有冷却 OS 页缓存或控制宿主频率。cold 仅指 fresh handle，不是物理冷启动。主体/准备组各三趟，控制/上限组各两趟。脚本的 medians 字段取排序后 floor(n/2)，所以两趟时是较大样本（上位中间值），不能当作两值平均中位数或统计显著性结论。

## 主体：真实预取保留成本

以下主体三趟的中位数都是 full actions/prefetch、工件缺失的已选流水线：

| profile/case | cold before→after ms | repeat2 before→after ms | restart before→after ms |
|---|---:|---:|---:|
| code sparse | 177.055→230.640 | 98.226→78.017 | 118.568→171.445 |
| code miss | 146.998→201.227 | 99.671→91.516 | 145.733→179.770 |
| mixed sparse | 144.508→185.227 | 117.673→59.736 | 145.964→156.631 |
| mixed miss | 144.876→159.074 | 99.024→71.695 | 124.682→160.139 |
| entropy sparse | 458.974→490.835 | 460.150→149.029 | 500.073→482.268 |
| entropy miss | 452.902→472.530 | 410.204→146.423 | 464.255→501.345 |

这些冷态哈希、源自有副本和验证成本不能隐藏。主体 sparse/miss complete 扫描首次安装 512 条完整记录（约 113KB 的逻辑记账）；repeat2 都有 512 hits、0 verifier sourceReads、0 testedLines、0 View.read。可是三份主体 repeat2 仍请求 512 个预取 ID：并没有取消候选预取。在 code sparse/miss 的每次 repeat2 中仍有 5 次 Git batch 请求、1,024 次 View.stat。prefetchedIds 是调用方请求的 ID 数，不是经 Truth LRU 过滤后真正读的 blob 数；gitRequests 是 batch 往返数，不是文件数。原始记录分别保留这些数，不能将任何一栏换名成“所有源 IO 为零”。whole-wall 已包含真实仍发生的预取成本。

code denseEarly 冷态 32.767→34.941ms、repeat2 0.250→0.339ms，每次只读一个文件、测试 55 行、0 installations；仍预取首批 32 IDs。code filesEarly 冷态 135.377→156.538ms、repeat2 78.444→106.738ms，512 View.read、512 首条测试、0 installations。消费者没走完整个 source 就不哈希/安装部分结果，密集/文件模式没有凭空缓存收益。entropy dense restart 45.440→94.177ms，是保留的不利样本，不作普遍加速承诺。

最终源码的 no-prefetch 控制只有机制上限意义：code sparse repeat2 的较大样本 141.460→4.433ms，miss 120.758→7.083ms。它明显比真实预取组更漂亮，必须明确分开。普通 plain host 的 verification 始终 null，source/read/prefetch 路径不被新缓存替换；时钟有噪声，plain sparse repeat2 较大样本 110.008→104.985ms，而 miss 97.818→105.793ms，不能挑单侧称加速。

## 付费 preparation 与已准备工件

regex-cohort-code-512.json 每个 case/句柄单独准备并保存所有成本，不能把这个时间从收益账中删除。首次准备每版、每 case 都是 512 sourceReads、512 metadata stat、一个工件写入；CPU/Git 请求也保存。before 首次准备的原始范围 611.907–1,080.779ms，after 583.017–801.835ms；restart 准备又独立计费，原始记录包含它。

准备后 sparse（正则要求保守，候选仍走全部）cold 中位数 104.648→132.950ms、repeat2 91.311→73.025ms；miss 已由工件排除，不触发 verifier，repeat2 0.447→0.728ms。dense/files 的早停也不安装完整 verification。这个比较不表示冷 CLI 总成本只有查询毫秒，也没有证明准备总会回本。

## 四个上限与不利淘汰

final source 在 source hash、完整 exhaustion、代际与 record budget 通过之后，才把 admitted line 做 owned UTF-8 encode/decode detachment，避免一条小 slice 保留整份 source backing。语料/Truth 自己的缓冲仍留在基准进程，因此这里没有进行 verifier-only heap/RSS 实验。以下是逻辑 admitted-record 记账和 per-source 边界，不是进程 RSS 限额，也不涵盖对象/Map 开销、GC 或原来的 Truth cache。

- sourcecap：单文件 2MiB 超过 1MiB eligible source；每次 View.read 仍为1，repeat2 entries/bytes/hits 均0，原 lazy scan 保留。Truth 自己热缓存可避免 Git 重读，不能归功于 verifier
- recordcap：64×32KiB，count 模式完整匹配超64KiB记录预算；每次完整扫描64文件，0 installations/verifiedSources。repeat2较大样本19.904→35.660ms，预算拒绝仍可能更慢
- bytecap：512×32KiB，count many_hit，每文件32条匹配。全局在每次返回保持236条、2,089,072 logical bytes <2,097,152；第一次276次淘汰，三次累计1,300。repeat2 512 evictions、0 hits、512 View.read，较大样本147.746→163.271ms，顺序压力使缓存颠簸
- entrycap：1,100×128B 无匹配 source，保持1,024条、227,328 logical bytes；第一次淘汰76，三次累计2,276。repeat2淘汰1,100、0 hits、1,100 View.read，较大样本29.125→55.443ms。数目上限可让 warm 扫描退步

每一趟都 assert source/record不安装、byte/entry压力真的发生淘汰，并 assert 返回时 entries/bytes 不越限。测试不只跑低压漂亮数据。

## 开发脚本资源边界

后端 imports 和不同源码 admission 在分配语料/HOME前完成。之后全部 setup 在拥有者范围；attempt-all cleanup 保留最初错误。check-next-benchmark-owned.js 的9个 invalid-reference、same-backend、setup失败、async/sync fs恢复与清理失败 sentinels 全通过，保存于 harness-failure-checks.json。每一版脚本语法检查通过。这里只跑生成基准、smoke、开发脚本所有权验证，不声称全套产品测试或整个路线图验收。

```sh
node tools/bench-regex-verification-paired.js --before /path/to/82db --after /path/to/9db --runs 3 --profile code
# profile=mixed/entropy 同样；以下是明确的独立控制
node tools/bench-regex-verification-paired.js --before /path/to/82db --after /path/to/9db --runs 3 --cohort
node tools/bench-regex-verification-paired.js --before /path/to/82db --after /path/to/9db --runs 2 --plain
node tools/bench-regex-verification-paired.js --before /path/to/82db --after /path/to/9db --runs 2 --no-prefetch
# scenario=sourcecap/recordcap/bytecap/entrycap，各 runs=2
```
