# 0.2.6：写者恢复未完成尾段后再追加

依据ROADMAP §3的崩溃注入维护项，基线bbf2ef1。之前读者会忽略未换行的半行，但重启
写者只算出下一序号，没有删掉半行；新记录接在旧碎片后，后续重放变成JSON损坏。
本单元只在写者首次准备该日志时恢复尾段，不让观察者修日志。

仍只读现有64KiB尾窗口，用有界循环填满短读；截点按原字节的LF计算，不按UTF-8解码
后的字符长度计算，因此半个emoji不会把截点推错。先验紧邻尾段的最后完整行CRC、
信封writer与文件名，再核文件size/mtime/ctime未在读中改变，才去掉最后LF后的未完成
字节。首条半行且整文件在窗口内可恢复为空；窗口内无法确认一条完整行则保持拒绝，
不猜序号、不截掉诊断证据。更早行的全量检查仍属读/重放路径，append没有偷偷全扫历史。

沿用既有整条写命令writer fence；同writer的第二句柄取不到锁，在碰日志字节前拒绝。
同句柄并发首写共用按writer键控的初始化Promise，不能各开fd再互相截断已完成行；
初始化失败清pending以便显式修复后重试。close先关新append入口，观察已接受的初始化/
串行写完成，等待已有fd的关闭尝试后才释放fence；close幂等，返回后不许迟到写者重新发布fd或追加。
跟踪量只随既有正在接受的调用数增长，settle清理，没有新增无限后台队列或改close错误口径。
截断是FileHandle.truncate对已打开文件的一次操作，必须完成后才让O_APPEND写新EOF。
无新增事件/schema/编码/CRC；完整坏行、foreign-writer行、opaque大尾段或恢复中发现
文件变化时不截断。检查与截断之间依赖合法写者遵守同一fence，不承诺阻挡绕锁的主动
同UID文件修改。只读重放继续忽略未换行尾段，日志字节与目录项不由读者改变。

架构§9.5的耐久档位保留：each在新事件写完后sync，batch按原计数刷，never仍交OS；
**不因为恢复偷偷给never加fsync**。测试观察truncate→write→sync（each）与truncate→write
（batch/never）；完整尾行不做恢复截断。sync失败向调用者报错，不能把已写入的完整行
假说成不存在或已获耐久确认，后续写者按实际完整尾行的序号接续。这里是进程/IO故障
注入与调用顺序证据，不是断电硬件证明，也不是一等档全量验收。

```sh
node tools/test-entry.js fast src/log/tail-recovery.test.ts src/log/log.test.ts src/log/envelope.test.ts src/log/cache.test.ts src/log/hold.test.ts src/view/replay.test.ts
node tools/check-targets.js
node tools/check-events.js
```

最终16条在未改动基线为2通过/14失败，修改后16/16：覆盖each/batch/never、UTF-8半码点、
首条半行、完整坏CRC/不同writer/超窗口、已有锁拒绝、短读/早零、恢复中追加与sync失败；
另覆盖跨64KiB多行前缀、并发首写共享、失败重试、不同writer独立与close等待/晚写拒绝。
正常旧行和合法字节前缀完整保留；既有重放/缓存/持锁套件同时验证。相关日志/重放focused
54/54，读数跟提交序列记录；duplicate-key读取拒绝位于独立分支，本单元不用它代替既有
坏CRC拒绝。
