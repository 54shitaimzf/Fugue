# 开发快照读口：同频同步 metadata 检查的配对证据

只比较前一批已经有界的 awaited-stat 快照读口和本批 fstatSync+公平让出实现；不是旧缓存 M0 与新快照的比较。产品轮询缓存未改变。这份脚本、生成语料和记录不作提供方调用、不修改产品、不授予默认功能启用。

## 精确源与运行

- before：82db8f754ca7859beaae62db088f245893ad1ceb；stream.ts SHA256 5459de7176a850074e359082be88ccb5445e7a10d22696d199623c3a53c336e6
- after（本地实现检查点，公开组合提交使用不同 SHA）：4b67def9c7feae6360dd2b3225284f5004a66871；stream.ts SHA256 2704e994b8f4b3944c33eaee8e232896e27968db18c5647a277e71546ff63a43
- 原始三趟读数：reader-stat-paired.json；小烟测：reader-stat-smoke.json；执行脚本 SHA256 与原始记录相同

```sh
node tools/bench-reader-stat-paired.js --before /path/to/82db --after /path/to/4b67 --runs 3
```

沿用上一批相同的 8 writer×3,000 行语料：24,000 行、42,804,200 字节，相同确定的 envelope、长 handoff 文本、多字节字符和调用账。先在计时之外对原 M0、before/after 快照全部逐行 deepEqual 独立生成参考序列；每趟交替 awaited/sync 次序，在线折叠完整结果哈希和最多 5 行的调用账。fromSeq 后缀与最后 writer 末尾完整坏行也检查；两版都在第一行输出前拒绝迟到坏行。语料构建与计时外 equality 会暖 OS 页缓存，不是物理冷启动。

## 读数与代价

| 快照状态 | 首行中位数 ms | 全量折叠中位数 ms | async stat | sync fstat | 读取字节 |
|---|---:|---:|---:|---:|---:|
| awaited 首次 | 883.342 | 15,711.710 | 194,656 | 0 | 85,608,400 |
| sync 首次 | 752.523 | 2,084.203 | 8 | 194,648 | 85,608,400 |
| awaited 重复 | 800.131 | 15,265.238 | 194,656 | 0 | 85,608,400 |
| sync 重复 | 744.564 | 1,972.422 | 8 | 194,648 | 85,608,400 |

metadata 调用总数每趟完全相同，脚本明确断言频率没有减少。同步实现并未取消 size/ino/dev/mtimeNs/ctimeNs 比较，初始快照 8 次 stat 仍然异步，其他 fd-bound 检查转为同步。两版仍读两遍、全量校验后才输出，仍不存整份解析历史。完整折叠包含相同哈希/账本工作和开发包装开销。

这台机器这一窗口的中位数约减少 7.5 倍的 whole-wall；不能推广为所有文件系统的速度保证，尤其不能和旧缓存 M0 的热轮询速度混为一谈。同期 awaited 读数比前一批更慢，说明宿主/调度/GC 噪声不可忽略。

同步系统调用会占用事件循环；每个读调用共享一个计数器，在第 64 个 guard 前通过 setImmediate 让出。脚本同时运行 10ms resolution 的 monitorEventLoopDelay 和 10ms timer lag 采样，预热及末尾 timer drain 不计入 whole-wall/CPU：

- awaited 首次 histogram max：156.238、27.116、77.988ms；sync：87.556、12.321、91.554ms
- awaited repeat max：149.815、147.718、15.401ms；sync repeat：12.739、22.249、16.351ms
- sync 首次 timer lag max：77.537、2.178、81.535ms；repeat：2.735、13.675、6.347ms

保留约 92ms 的不利样本，不把 64 次公平门槛说成固定毫秒上界。timer 与 histogram 是采样调度延迟，也包含宿主和 GC，不是单个 fstat 的持续时间或普遍响应性保证。

logicalRetention 仅给源码导出的有界头/chunk/行片段算法计数，不作 RSS/heap 实测声称；目录 writer 名称枚举仍然在 maxWriters 检查之前，未获准库存无总体空间上界。真实峰值内存、系统调用安全负对照由实现/验收另行负责。本批基准只跑生成语料、小烟测和开发脚本语法/所有权 sentinel，没有跑全套产品测试。
