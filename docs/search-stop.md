# 搜索回执早停与不完整枚举（路线图 0.3.0 单元）

`grep` / `glob` 不再先构造全部命中、再把中间截掉。它们保留有限的结果前缀，并在结果预算到点时停止。
使用者会看到 `Search stopped …`，不能把这份前缀当成全量结果；可以缩小路径或模式继续找。
这一单元没有改版本，没有声称成本台账等 0.3.0 所有内容已收口。

## 结果说清什么

- 完整枚举且未碰结果预算时，小结果逐字节保持原样，空结果仍说 `no line/path matches …`。
- 已发现但放不下的命中如实报 `results are incomplete`；刚好填满预算就停时，后续有没有命中尚未查明，报 `further matches and completeness are unknown`。
- 命中列表是前缀，头里说 `N lines/paths shown`。不编造未扫描的总命中数、遗漏字节数或遗漏文件数。
- 第一条命中就过长时给完整 UTF-8 前缀，并说 `Last result line shortened`；保留完整字符，不劈开汉字/emoji。
- `count` 对已经完整扫描并显示的文件给精确匹配行数，早停只发生在文件结果行之间。文件名档只需找出文件内第一条匹配。
- 行迭代保留旧 grep 的末尾 LF 空段和空文件一段语义；不预先拆出整文件行数组。
- 枚举到行数/深度上限，显示 `Enumeration incomplete (rows/depth limit)`；即使请求的文件/glob 不在已枚举前缀中，也不能说整个范围都没有匹配。
- 旧宿主没有详细枚举读口时如实报 `Enumeration completeness unavailable`。这是不知道，不能假报完整。

候选边界仍由原宿主维护：不跟软链，深度 24，最多 5,000 条文件。详细状态来自
[walk 限制读口](walk-limits.md)，不改冻结的 View/Truth 契约。搜索结果正文预算为 7,680 字节，
为头、说明、运行时步预算留 512 字节；最终仍过统一 `capReceipt` 出口。没有 cgroup/内核安全配置变化。

## 预取成本与实测取舍

候选仍按原 walk 顺序，先过滤路径/glob，再每 32 条预取一批。回执够了就不再预取下一批，也不再读后续文件。
完整 blob 仍会取回；这不是 git 范围 I/O 或索引查询。

`tools/bench-search-stop.js` 用**同一份下层 blob 语料与当前缓存**，隔离比较旧的整树预取/全扫和新早停。
它不是旧版本完整端到端对比，也不作 CI 速度断言。在云工作区取 3 趟中位数，256 文件 × 64 行，1,972,900 字节：

- 密集命中：冷 100.473 → 31.904 ms，热 32.286 → 0.256 ms；读文件 256 → 1，预取路径 256 → 32；冷请求仍 5，热仍 0
- 稀疏命中：冷 51.018 → 87.757 ms，热 8.017 → 7.147 ms；冷请求 5 → 12，完整扫描仍读/预取 256 条
- 没有命中：冷 89.188 → 53.771 ms，热 17.096 → 7.311 ms；冷请求同样 5 → 12，完整扫描仍读/预取 256 条

**不是每档都变快。**冷稀疏档这次变慢，分批多付 7 次请求；时间有波动，请求数与读取数更能解释机制。
32 条是当前有界预取批次，不把稀疏退步藏掉。适应性批次将作为独立小单元比较，不在这一笔里悄悄换掉策略。
原 `tools/bench-grep.js --runs 3 --json` 在本仓 src 副本（264 文件、3,869,192 字节，模式 `export function`）
测到冷 43.61 ms / 60 请求，热 5.53 ms / 0 请求。所有云读数仅供趋势，不是一等档 ext4 的性能常数。

## 工具目录与离线请求重录

路线图 §10 要求把早停/MAX_ROWS 的描述变化一次付清。grep/glob 描述同时更新，schema 不变；
三种状态同一份目录（`src/tools/search-prefix.test.ts` 的第一条就是它）。

- `node tools/make-fixtures.ts` 重新捕获三份**离线请求**（`src/model/fixtures/*.json`），响应/历史 usage 原样保留
- `node tools/adapt-wire-in.ts` 把回放夹具 `src/cli/__fixture__/wire-in/` 里那份录制请求的
  `tools` 栏**就地**改齐当前整份目录（不只是 grep/glob），并重算 `request.sha256` 与 `meta.json`
  的 `requestBytes` / `requestHash` / `zoneAHash`；响应、usage、timings、`messages` 一个字节不动。
  来历写在 `src/cli/__fixture__/wire-in/PROVENANCE.md`，机器可读的那份在同目录的 `provenance.json`
- `src/cli/wire-in-catalog.test.ts` 在 **fast** 档盯着这件事：盘上那一份与当前目录不一致就当场红，
  而不是等 `full` 档里的 real 测试
- **"录下来的字节被改过就当场拒"一个字没松**：请求改一个字节仍被产品 transport 拒
  （`src/cli/chain.test.ts` 的「序 1 负对照」与 `src/cli/wire-in-catalog.test.ts` 的最后一条各守一档）

**离线适配不是新的 live 录制、提供方成功证据、付费前缀读数或 cache 成本证据。**响应、用量和时间来自历史，
新请求没有发给提供方。路线图 §10 的**真正新 live 重录仍是阻塞项**，需要明确的提供方/凭据/费用授权，
以及具备隔离能力的 Linux 主机。本云环境 bwrap NETLINK_ROUTE 被拒，
未绕过宿主策略，也不将有界搜索的测试通过算作隔离正向通过。

**为什么不是"目录字节变了就让历史 chain 红着"**：`--wire-in` 过期之后 `src/cli/chain.test.ts`
序 1 不是"报出一处不同"，而是整条端到端验收（验收照过 · 产物逐字节相同 · 每条调用逐条对上 ·
围栏 `full` + `bwrap+landlock` · 停因收敛）**一条都不再执行**，`full` 这道合并闸门长期红。
那不是更严格，只是更瞎——所以口径拆成两句：目录字节漂了就离线改齐（可逐字节复算 · 来历写明），
录下来的字节被改过仍当场拒。

## 验证入口

```
node tools/test-entry.js fast src/tools/search-stop.test.ts src/tools/search-prefix.test.ts src/tools/grep-options.test.ts src/tools/walk.test.ts src/tools/w10.test.ts
node tools/test-entry.js real src/model/http.test.ts
node tools/bench-search-stop.js --runs 3
node tools/bench-grep.js --runs 3 --json
node tools/check-events.js
node tools/check-targets.js
```

新增早停回归在先前实现上失败，独立审查抓到的恰好填满预算真值问题已补回归。
普通 `read`/`bash` 的完整文本截断不变；W10 的 read 标记断言保留，grep 改测早停真值与 UTF-8 边界。
