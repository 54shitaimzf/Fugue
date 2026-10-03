# 0.2.6：真实终端退出还原

按main `32bb00c3d43f66b8a4185b03b4b7a4d6a2a593c1` 的维护批次：q、Ctrl-C、SIGTERM与坏日志
四条退出路径要在真实终端上验证。附加SIGHUP与同一信号收尾钩一起覆盖。
不推进serve、TUI客户端化或新事件模型。

`src/ui/terminal-exit.test.ts` 通过Python3标准库打开Unix PTY，把实际Node CLI的stdin/stdout/
stderr接到slave；不是用假的TermOut记写入。普通退出测试量到真实raw模式已启用，然后输入q、空闲Ctrl-C两次（遵守现有3秒退出契约），
或写入完整坏JSON行。SIGTERM/SIGHUP 则排在实际首帧、raw 尚未进入的启动停点。
子进程退出后检查完整termios与启动前完全相同、bracketed paste与alternate screen各关闭恰一次。
普通停下仍退出0，日志损坏仍退出1。

## 捕获的启动窗口

原先SIGTERM/SIGHUP及exit收尾钩在`openKeys`和按键提示的note绘制之后才注册。
这时raw、paste与full screen已经进入，信号仍能走缺省终止路径，留下alt screen。
最初普通PTY探测曾通过，重复运行捕获SIGTERM退出-15，因此不能靠等待几毫秒掩盖问题。

确定性夹具仅在自己创建的CLI进程第一次实际写出ALT_ON之后发SIGSTOP。
父驱动用waitid确认该拥有的进程已停止，再排入SIGTERM/SIGHUP后SIGCONT恢复。上游 PR50
在首帧后异步读取键位配置，因此这个启动停点尚未进入 raw/paste；驱动不能等 paste 开关再发
SIGCONT，否则夹具自己互相等待。启动信号控制明确断言初始 raw 尚未进入，最终 termios 完整还原；
完整启用 raw/paste 后的普通退出、Ctrl-C 与坏日志仍单独覆盖。
不能只看输出就提前SIGCONT：输出写出与随后SIGSTOP之间还有一个测试夹具窗口。
未改main运行同一套测试为4/6：两个启动信号失败；修复把原有幂等收尾钩提前到任何绘制/raw之前，
其余退出链不变，6/6通过。另在私有源码副本中去掉ALT_OFF，实际q退出也被同一断言拒绝；
原checkout字节保持不变。

## 有界的测试资源

驱动只操作本次创建的新session/process group和PTY。8秒内无退出则终止并观察该进程组，
最多收1MiB终端输出；外层12秒超时。finally恢复自己PTY的属性、关闭两个descriptor。
HOME和模型环境是私有测试目录的干净值，无提供方调用/凭据。临时Git仓库与源码副本都由测试创建并清理。
SIGSTOP不是ptrace或主机策略修改；不信号其他进程，不改变用户终端。

```sh
node tools/test-entry.js real src/ui/terminal-exit.test.ts
node tools/test-entry.js fast src/ui/term.test.ts src/ui/keymap.test.ts src/ui/cancel.test.ts
```

测试声明`real`：依赖Unix PTY、Python3标准库和Git，CI full自动走同一官方入口。
它证明这些真实TTY接口与控制字节的还原，不是硬件终端模拟器的视觉验收，
也不替代sandbox/ext4、模型live录音、默认索引或serve审批门。

最新 main `f4b571b3` 的 exit-hooks 与键位接线原样采用；同步后的真实 PTY 六例 6/6。
本篇最早的 4/6 负对照属于旧 main 启动次序，不将其借作新源码的认证。
