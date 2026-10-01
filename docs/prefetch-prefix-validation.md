# 预取前缀提示的输入边界

独立叠在外部精确提交 `5c91606d7be1f2004516c34daaf25ce5bf5c70ca` 上，不改外部原分支。
该基线新增了 `ToolHost.prefetch` 的数字返回：字节预算只预取候选前缀时，grep扫描这一段，
下一批从第一条未覆盖的候选继续。数字是提示，不是可信的路径/遍历完成证明。

原处理把任意number用于数组索引；返回 `1.5` 时 `candidates[1.5]` 是undefined，
`batch.indexOf(undefined)` 给-1，原批于是推进到倒数第一条，却只读了第一条候选。
一个真实中间命中可被跳过，回执仍声称 `no line matches`，完整性也没有警告。

现在只有safe整数、非负且不大于当前过滤后候选数的值可缩短批次。其他值按未知提示处理：
扫描完整原候选，顺序不变，不从坏计数推断已读覆盖。有效0仍至少推进一条，避免不前进；
有效1/2/全长仍按原预取预算重新分批。索引过滤造成的原路径空洞不能被当成候选计数。

```sh
node tools/test-entry.js fast src/tools/prefetch-prefix.test.ts src/tools/adaptive-prefetch.test.ts src/tools/grep-options.test.ts src/tools/search-stop.test.ts src/tools/index-query.test.ts src/tools/read-window.test.ts
```

负对照在改前0/1：小数1.5把实际两条命中变成完整的“没有命中”。断言覆盖content/count/files
三种输出、NaN/正负无穷/负数/小数/越界、有效0/1/2/全长及索引过滤空洞，每条保留路径恰好读一次。
这是正确性修复，不是提速读数。没有工具目录、模型协议、历史录音或权限策略变化。
该父提交的其他外部修订不因此获得整体验收证书；年龄清理/离线适配来历的独立修复和
真实live录制、一等档sandbox/ext4、默认索引冷路径、serve设计门仍分别处理。
