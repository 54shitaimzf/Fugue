# 仓库对象格式探测（0.2.6）

M1 创建不存在的 ref 时，Git 要求 `update-ref` 的旧值是仓库格式对应的全零 OID。
此前从调用方的 `to.length` 生成零串；Git 接受提交缩写，但 12 字符缩写生成的旧值
不合法，SHA1 与 SHA256 仓库都无法创建 ref。`CommitId` 的品牌没有规定必须是完整长度。

现在每个 Truth 句柄在首次 `advance(..., null)` 前，用既有 Git 进程层执行一次
`rev-parse --show-object-format=storage`。只接受准确的 `sha1\n` 或 `sha256\n` 回复，
分别生成 40 或 64 个零。并发调用共享探测，成功结果在句柄内保留；失败清除待定状态，
以后可重试。失败在 `update-ref` 前退出，不猜 SHA1，也不把任意长回复带进诊断。
句柄假定其对象库格式在使用期间不变；不支持将同一句柄移到另一个对象库。

这增加每个首次创建 ref 的句柄一次 Git 请求、一个短命进程；读取对象、推进已有 ref
和只打开句柄不触发探测。请求计数与进程计数分别保留原口径。探测是 read-only plumbing，
沿用 `gc.auto=0` 与环境隔离；不新增 M1 方法、事件、日志字段或配置，不触碰 HEAD、
index 或工作树。已有树解析继续使用 Git 返回的完整 tree ID，本批不扩大成其他 ID 入口改造。

验证入口：

```
node tools/test-entry.js real src/truth/object-format.test.ts
node tools/test-entry.js fast src/truth/truth.test.ts src/truth/blob-lru.test.ts
```

新增测试在生成的真实 SHA1 / SHA256 仓库中分别验证完整与缩写目标、已有 ref CAS、
树/文件读取、失败后仓库目录清单/模式和文件字节/mtime 不变，以及纯探测前后整仓不变。
Git 拒绝 CAS 时可能创建再删除 ref 锁，目录 mtime 不作为拒绝后不变的判据。
第一次失败对照只加入两个缩写回归：原始 `bbf2ef1` 为 0/2，通过日志可见错误的
12 位旧值；修复后通过。未知/多行/缺换行/大回复和子进程错误均保持可重试、诊断有界。
新文件依赖真 Git，声明 real 档；生成夹具只使用显式 PATH、私有 HOME、身份和隔离配置，
不继承调用者的 `GIT_DIR` 等对象库重定向。快档既有 M1 / blob LRU 测试单独跑。
最终新增 real 测试 5/5，既有 fast 测试 24/24；目标与事件面校验通过。
此项实现不代表整个 0.2.6 的 fast + full 验收已完成。
