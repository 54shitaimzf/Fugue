# 候选索引探测的有界只读调度

这是 0.3.3 可选接线后的测量驱动小步，不是 0.5.0 的并行工具执行。
不改变工具目录、事件模型、host/tool 的查询接口或缺省启用策略。

## 机制与退路

此前当前批的元数据/索引判断逐个等待。现在 `filterCurrentViewCandidates` 最多开四路
只读探测；仍只看现有 32/128 候选批，不枚举/预取下批，回执早停边界保持原样。
路径和必要三元组先快照；每个负判断仍绑定当前 View 的有效 immutable BlobId。
完成顺序不决定结果顺序，按原批下标重组。严格 false 才剔除，null/异常仍扫描。

每次异步元数据/lookup 前后检查 base/rev 与 sticky stale。发现变代后不再排后续候选，
撤销整批负判断；已经启动的口全部观察到完成或拒绝后，返回完整原批。
这不是全查询原子快照，也不取消非合作的外部源 I/O。四路是派生只读口的并发数量上限，
不是 blob 字节、后台源 I/O 或整批内存上限。lookup 自身的 pending 限制低于四路时，
不能接受的探测仍以 null 退回扫描，不把预算拒绝当负判断。

## 验证

```sh
node tools/test-entry.js fast src/search/current-view-candidates.test.ts src/tools/index-query.test.ts src/tools/index-query-store.test.ts src/search/index-probe-benchmark.test.ts
```

新增受控负对照：旧串行实现只有一路进入阻塞口，四路断言红。新的控制口测试覆盖上限、
逆序完成、false/null/error/true 混合结果、变代后无第五次排队、未完成旧口被观察收尾，
以及非标准 generation 回退也不能解除已检测 stale。仍跑现有真实 Truth/View 逐字节对照。
测试不以耗时判通过；计时仅留在独立测量脚本。另以独立 TMPDIR 负对照验证
参数/引用模块失败不会分配基准临时目录。

## 隔离已准备记录的 before/after

先取此前接线分支的 worktree（fork commit `65e7df60dc1cade1b4955d9330fc7cf7a1ac5f7d`），
以它的 host 与 lookup/store 为独立对照：

```sh
node tools/bench-index-probes.js --reference-root /path/to/prior-checkout --runs 5
node tools/bench-index-probes.js --reference-root /path/to/prior-checkout --runs 3 --files 512 --lines 256
```

同一份 immutable 语料、同一组已准备 canonical 记录，before/after 交替顺序，每个计时
session 都新建 Truth/View/lookup。before 显式加载 reference 的 host 和 lookup；lookup
的相对 import 因而绑定到 reference store/codec。只换 host 却共用当前后端，会在测后端
变化时让两个同样错误的实现自证，现已用会抛 sentinel 的 reference factory 负对照钉住。额外默认关闭的全扫作为独立答案；两种索引路径每趟
都必须与它的精确回执相同。这个全扫在计时 pairs 外，也会预热 OS 文件缓存，所以这里的
“磁盘冷”是重启 lookup 的冷口，不是物理设备/page cache 冷测量。

脚本显式记录生成语料与线下直接 rebuild 的准备时间。这隔离候选探测调度，不代表正常
后台 Worker 准备可以这样免费绕过；首次 miss、源读、Worker 与持久化全成本仍在
[查询接线](index-query.md) 的原矩阵里。参数、host/lookup 模块与 source hash 校验都在分配临时目录前；
即使 reference lookup 构造失败，也关闭已开 Truth/log 口再清理本脚本自己建的目录。
输出分别保留 before 的 lookup/store/codec 与当前源 hash、逐趟资源读数与中位数。

cloud overlay 趋势，不能替代 ext4/0.4.0 验收：

| 语料 / 模式 | 旧磁盘冷 → 四路 ms | 旧重复 → 四路 ms |
|---|---:|---:|
| 64 文件 / dense | 68.964 → 39.553 | 0.699 → 0.790 |
| 64 文件 / sparse | 126.754 → 53.693 | 0.581 → 0.510 |
| 64 文件 / miss | 130.539 → 58.505 | 0.658 → 0.524 |
| 512 文件 / dense | 77.880 → 75.897 | 0.954 → 0.884 |
| 512 文件 / sparse | 990.031 → 487.578 | 1014.728 → 500.352 |
| 512 文件 / miss | 1072.445 → 452.057 | 1016.650 → 446.599 |

64×64 行是 494,345 字节、5 趟；512×256 行是 16,037,385 字节、3 趟。线下记录准备
分别付出 248.980 / 2700.912 ms（不是原 Worker 的 72.7–83.0 秒全体准备）。
密集 64 文件重复趟略慢，512 dense 冷读收益很小，不能声称每种场景都快。

资源读数 before/after 一致：64 冷 dense/sparse/miss Git requests 5/5/4，512 冷为 6/6/5；
各冷趟 actual gitSpawns 1，重复趟 requests/spawns 0。内容读取 1/1/0，预取 32/1/0。
所有已准备 probes 的 sourceReads 为 0。64 sparse/miss 重复有 64 memoryHits、0 diskHits；
512 sparse/miss 仍各有 512 diskHits、0 memoryHits，并未解决 256-record LRU 容量抖动。

16MB 冷仍 452–488 ms，远高于 <50 ms 目标。只发布这笔可审的小改进，默认继续关闭；
进一步的 descriptor/codec/工作集策略应分别测量，不能掩盖准备成本或扩大容量冒充解决。
历史 live 录制、云隔离及 upstream PR 403 的既有验收边界同样保留。

### 未准备路径的补充 smoke

另跑 `node tools/bench-index-query.js --runs 1`（64 文件）：每种模式的精确默认扫描对照都通过。
首次 miss dense/sparse/miss Git requests 9/10/10，默认扫描冷为 5/6/6，仍多 4 次；实际
spawns 都是 1。首次 miss 时延 19.461/23.867/18.346 ms；后台收尾另付
172.605/130.600/146.283 ms，全体 Worker 准备另付 9841.646/7566.139/7488.594 ms。
它是单趟补充，不据此声称 missing-path 速度改进，也不能把线下直接 rebuild 的准备数字
换成正常后台成本。已准备探测对照、首缺索引完整矩阵与准备成本分别保留。


### Reference 后端的测量守卫

本修复是测量正确性小步，没有声称产品加速，也不默认启用索引。此前四路调度对照的两侧
后端源码相同，所以已公布的纯调度读数仍成立；之后比较不同后端必须用新加载规则。
四个测试通过唯一入口：参数/引用错误不分配临时工作区；受控 reference lookup 构造器
抛 sentinel，子进程确实碰到它且清理全部自己生成的工作区。旧共用当前后端的脚本在
第二条反例上红（子进程反而成功）；直接模拟 reference close 拒绝仍观察到 log/Truth
两个关闭口完成；log 拒绝时必须等待阻塞的 Truth.close，同步抛错也不能跳过它，不允许只核 source hash 却不调用所声明的后端。

该分支 foundation 组合已独立审查的 pool `771e8640edd50f618812e53f6af98e03d384a0f0`
与四路查询 `4639dd25c901d9aca8adb0f7b85eecd619456be2` 的精确源码，供后续测量复用。
没有带入 sized-read 实验：它的正确性测试通过，但首次端到端矩阵有明显退化，故保留本地
实验与原读数，不发布优化或 0.4.0 达标声明。原 canonical 编码/完整信任检查保持不变。
