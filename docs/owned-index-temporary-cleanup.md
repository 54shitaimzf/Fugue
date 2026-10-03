# 已知自建索引临时叶的收尾

独立叠在外部提交 `82423ec59f48c9d8c8523cb723437118c7f770a3`，原store blob为
`c3165b789f98c35687993180af08ce94ce9b06ec`。不修改外部原分支。

原 `replaceRecord` 的finally先await临时FileHandle.close，再unlink本任务创建的叶。
close持续拒绝会跳过unlink；写入/同步本身有原错误时，还会被后来的close错误覆盖。
故障不是成功发布：stored仍是false，但本任务的可清理临时对象不应因第一项收尾失败而遗留。

现在先捕获操作结局，再依次尝试并观察close和已知自建叶的unlink。原始操作错误优先；
无原错误时保留第一项收尾错误，后一项仍然尝试。unlink的ENOENT仍视为已收走。
纯 `settleOwnedTemporary` 帮助函数只接受操作结局和回调，用于断言错误优先级；
路径与所有权不交给它推断。生产调用仅在exclusive open成功设置created后提供unlink回调，
所以EEXIST碰撞、无法打开的未知文件没有删除能力。成功rename后立即撤销旧临时名称的删除权：
另一合法发布者随后复用同一显式nonce时，其新临时叶不能被前一次收尾删除。

```sh
node tools/test-entry.js fast src/search/owned-temporary-cleanup.test.ts src/search/index-store.test.ts src/search/blob-index.test.ts src/search/index-worker-pool.test.ts
```

负对照改前0/1：实际创建的临时handle持续close拒绝，会留下.tmp叶。
同nonce负对照在修复前也失败：首发布者等待shard同步时，第二发布者已创建新临时叶，
首发布者收尾会删除第二份。现在两份实际rebuild均能完成。
测试还注入真实write/sync + close/unlink故障，验证两个收尾均被尝试；纯帮助函数验证
原始错误和第一收尾错误优先、等待held unlink完成；碰撞叶原字节不变。
测试恢复FS绑定，观察原生close并只清理自己的生成目录。

这不保证操作系统IO故障或进程被杀后一定能回收；不补跨进程未知孤儿的安全回收协议。
父提交的年龄扫描/目录close、离线录音来历与其他独立修复仍分别整合验证；
本单元没有bundled sweep变更，也不把原父提交的全部状态视为认证通过。
不改变权限、目录/文件信任检查、格式/模型协议、索引默认策略或真实live验收门。
