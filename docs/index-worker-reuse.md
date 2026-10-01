# 有界后台Worker复用：准备成本与前台竞争

这个单元只优化可选索引的后台构建，不改变索引格式、查询候选或事件联合，不启用缺省档。
每blob起一个Worker的准备成本很高，现把同一句柄的已完成Worker暂留复用。

## 所有权与失败退档

- Worker存量上限等于已经校验的maxPending（默认4，上限16），没有Worker候补队列。
  池根在构造时解析一次，之后cwd变化不改变落点。池满给构建失败/scan退档；正在终止的Worker直到exit才减存量，不靠提前退休计数超额创建。
- 一份Worker同时只接一份任务；每次传输实际字节窗口的独立副本，绝不detach借用源buffer。
  独立随机nonce同时关联输入、回执和临时文件。迟到/外来nonce、坏字段、无序/重复/越界键
  都给null且Worker退休，不用旧任务的表排除新blob。
- **两个方向都不信跨边界的消息形状。** `parentPort`是子线程唯一的外部输入面：
  宿主→Worker的消息先逐字段查（`blob`是字符串、`bytes`是`Uint8Array`、`temporaryId`是字符串），
  任一项不对就回`{ok:false}`，**不写成回调的参数解构**——async函数参数解构失败产生的是
  一个没人消费的rejected promise（EventEmitter不看回调返回值），默认unhandledRejection
  模式下当场打死线程，代价正好是一份已经预热好的可复用Worker。宿主侧回执校验不变。
- 回执合法并且任务未取消才可归池。失败、deadline、主动取消和error不能把Worker放回空闲池。
  源回调仍接AbortSignal；忽略signal的外部IO不受强制停止保证，原lookup说明的边界不变。
- 默认空闲10秒后终止（workerIdleMs可配0–60秒，0禁用复用）。空闲Worker和定时器都unref；
  受控Worker代码不打印内容，使用Node默认stdio避免自定义流额外持活引用。
  close显式终止所有存量Worker、收尾已知临时文件，仍不是对已完成缓存发布的回滚。
- stats的workers仍是被未完成任务持有的活动Worker数；workerStarts累计创建次数，
  retainedWorkers含空闲/终止中的实际存量，idleWorkers只计可再借的空闲项。
  这些机制统计不是新M0日志，也不是精确RSS。子线程堆、源字节与codec临时分配仍可能很大。

## 断言与复现

```sh
node tools/test-entry.js fast src/search/index-worker-pool.test.ts src/search/index-worker-reply.test.ts src/search/index-builder.test.ts src/search/index-format.test.ts src/search/index-store.test.ts src/search/blob-index.test.ts
node tools/bench-index-workers.js
node tools/check-targets.js
node tools/check-events.js
```

检查同Worker连续不同blob不混表、无队列/有限存量、失败build后新任务换Worker、活动任务
mock deadline后不复用且下个任务恢复、关闭幂等、相对根跨cwd固定、空闲超时、独立客户端进程不被空闲Worker
拖住、nonce和坏回执退档、可见窗口/私有keys、宿主发来九种坏形状消息都只回`{ok:false}`
且同一份Worker随后仍能完成真实任务（`starts`始终是1）。禁用复用的负对照应把连续任务的创建次数
从1变成3，复用断言红。速度数字不作为测试通过条件。

开发脚本同进程交替比较workerIdleMs=0/10000，各3趟新缓存根，64份源字节共2,304,918字节。
每次都完整核源文本命中ID、64次source/构建与相同gram/canonical字节，close后存量0。
一次共享云环境中位准备14,159.859→1,341.978ms，Worker创建64→1；三对准备分别
14,159.859→2,163.356、22,305.020→1,341.978、10,690.244→508.039ms。
这只是明确准备档的机制对照，不包含产品查询或物理冷盘，也不等同于所有输入的收益。

## 实际查询：收益与尚未达标的竞争

在已验证的接线检查点 `bcf0c1ce9570e45428c805fbaf12eeb512e5322d` + packed builder上
重复256×512行、16,037,385字节的Truth/View/grep矩阵。既有模块仅blob-index/index-worker
哈希变化，另记录两个新池/回执模块哈希；每份精确回执仍与全扫一致。各类准备末仍
256次source/构建、256条、167,431grams/1,069,355canonical字节、零淘汰。

准备合计104,315.173→17,375.866ms，dense/sparse/miss分别32,407.459→6,604.131、
30,867.307→5,370.668、41,040.407→5,401.067ms，只创建3/4/4份Worker。
**前台首miss反而变慢**：dense38.942→478.219、sparse133.097→197.796、
miss162.041→1,132.187ms。既有盘读也有波动。miss档前台Git请求11→16（spawns仍是1），sourceReads4→9、
已完成builds0→7：更快复用使扫描期间接受了额外后台miss，不只是时钟噪声。
miss不等待source/build的promise，不代表
后台CPU、对象读取与文件IO没有竞争；复用让准备吞吐变大，不能隐藏这笔前台代价。

这是单次共享云overlay顺序对照，不能把所有差值归因于池，也不能宣称一等档ext4验收。
默认继续关闭；0.4的16MiB冷查询<50ms尚未满足。后续需要在同环境多次测前台/准备，
并评估更保守的后台资源/调度预算；512条超过LRU时的盘解析问题也不由Worker复用解决。

根捕获修复后的最终源重跑同一矩阵，所有回执/逻辑统计再次相同；准备分别
3,146.417/3,308.901/5,151.692ms，首miss51.994/180.187/192.893ms。该次首miss
sourceReads都是4、builds都是0，说明额外后台读取竞争取决于交错时机，不能假装每趟
都固定达到9次source读取，也不能删去前一趟确实发生的回归。独立交替准备重跑中位
9,001.674→730.577ms（64→1 starts）；两次读数均完整保留，绝对墙钟波动很大。
