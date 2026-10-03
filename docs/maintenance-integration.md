# 0.2.6 组合验证分支

本页记录 [`9515979`](https://github.com/StevenLi-phoenix/Fugue/commit/951597962e0febb04334322a4777a272dffd8c6c)
时的维护组合快照；同一集成分支随后可继续接入独立检索功能，以下来源与读数只认证该维护快照。

后续与已发布官方 0.2.6 同步时，重复键行为遵从上游顶层边界；嵌套拒绝的旧候选证书不迁移为
当前实现。当前持久交互控制用转义顶层键，仍验证完整坏行先拒绝再考虑半行恢复；详见
[当前边界](log-duplicate-keys.md)。以下数字保留原历史快照的含义。

这是七件独立维护单元的组合验证材料，基于官方 main
[`bbf2ef1`](https://github.com/54shitaimzf/Fugue/commit/bbf2ef10294ddd54f662da217dcab661a4d78fbc)。
分支 `roadmap/maintenance-integration-check` 不表示已经合并、发布或完成 0.2.6 验收。
原单元 ref 保留；未并入外部索引实现、离线改写的历史模型请求或待批接口。

| 单元 | 已审原始 fork head | 精确 push fast 读数 |
|---|---|---|
| 重复 JSON 键拒绝 | [9420f8d](https://github.com/StevenLi-phoenix/Fugue/commit/9420f8d93b0e362e190f9d4ce4cf8e22e4368fee) | [36913691935](https://github.com/StevenLi-phoenix/Fugue/actions/runs/36913691935)：通过 |
| 半行尾段恢复及初始化所有权 | [0372b73](https://github.com/StevenLi-phoenix/Fugue/commit/0372b73f77463ec3c2f9869b0bcd2bf538887c6f) | [36919703944](https://github.com/StevenLi-phoenix/Fugue/actions/runs/36919703944)：通过 |
| 仓库 storage 哈希格式探测 | [16654cd](https://github.com/StevenLi-phoenix/Fugue/commit/16654cdb2e0d3b81322cda6dffcbfc17762aa950) | [36921988508](https://github.com/StevenLi-phoenix/Fugue/actions/runs/36921988508)：通过 |
| 真终端四条退出路径 | [ddb194c](https://github.com/StevenLi-phoenix/Fugue/commit/ddb194c77652a9529fbd66f008e2bf430df061a5) | [36917227127](https://github.com/StevenLi-phoenix/Fugue/actions/runs/36917227127)：通过 |
| 编辑持久化阶段恢复 | [415cbc7](https://github.com/StevenLi-phoenix/Fugue/commit/415cbc705ae3300136439a87d4efdef5e730a2ad) | [36919537136](https://github.com/StevenLi-phoenix/Fugue/actions/runs/36919537136)：通过 |
| 拒绝后不变的共享断言 | [3cc862b](https://github.com/StevenLi-phoenix/Fugue/commit/3cc862b7467c10132077ed186c186fbc87e97938) | [36920969072](https://github.com/StevenLi-phoenix/Fugue/actions/runs/36920969072)：通过 |
| checkpoint tree→commit→CAS→log 阶段 | [fba6920](https://github.com/StevenLi-phoenix/Fugue/commit/fba692067ac5e561760e34ebe1dde779b552b34d) | [36922797213](https://github.com/StevenLi-phoenix/Fugue/actions/runs/36922797213)：通过 |

上述 push 的 full / audit 均跳过，不能把 fast 读数当作 full 通过。
组合只解决 CHANGELOG 的追加条目冲突，原始 23 份非 CHANGELOG 文件的 Git blob 标识
逐项一致，见 [公开来源清单](maintenance-integration-provenance.json)。事件联合、M1/GitHandle
契约、包声明和模型/装配历史夹具与基线一致。组合本身没有新的产品源代码修补。

新增三条 fast 交互断言：合法 CRC 的完整重复键行（含转义别名）后面还有半行时，
恢复必须先拒绝，所有原字节保留；修好测试夹具后同一句柄可重试；没有 LF 的歧义尾段
仍未提交，只移除尾段再写预期下一行。去掉重复键拒绝的负对照 1/3，去掉恢复的负对照
0/3；当前三个交互测试与原 parser/tail 测试合跑 26/26。
读侧仍检查每个完整行，写侧初始化仍只检查继承的 64KiB 尾窗内最后完整行；不宣称校验全部历史。

```
node tools/test-entry.js fast src/log/maintenance-integration.test.ts src/log/duplicate-keys.test.ts src/log/tail-recovery.test.ts test/refusal.test.ts
node tools/test-entry.js real src/ui/terminal-exit.test.ts src/view/edit-stages.test.ts src/view/edit-refusal.test.ts src/checkpoint-stages.test.ts src/truth/object-format.test.ts
```

组合产品源未改的读数（Node 24.19.0）：上述 real 集合 30/30；独立审查的原维护项 fast 集合
28/28，加入三个交互测试后的上述 fast 集合 31/31；目标/事件面与空白校验通过。
独立交互检查还验证：两个首次 append 共享坏行初始化，
close 等拒绝和句柄关闭后才释放 fence，既不 truncate 也不写入。

整档 fast 已实际跑完但未全绿：560/570，8 个文件因 Node runner 反序列化错误失败，
另 2 条要求 ext4 / 四个 overlay 挂载，而云工作区是 overlay、没有该挂载能力。
8 个受影响文件逐个经同一入口重跑全部通过（73/73），这不是整档重跑全绿的替代证书。
新增交互测试是在该整档读数之后加入并按上面命令验证。未在这台云主机重跑已知受阻的全部
kernel/sandbox real 档；一等档主机的 fast + full、上游 PR 准入和合并验收仍未完成。
保留原有 sync 模式与全部策略，不用测试豁免填补环境差距。

当前官方 `ff40425` 尾段政策与早先表中候选不同：撤回自动截断，读者保留磁盘字节，写者遇半行拒绝追加；测试在独占夹具上显式处置后验证重试。上述旧次数/负对照只认证当时源码，不能用于当前政策，见[尾段边界](log-tail-recovery.md)。
