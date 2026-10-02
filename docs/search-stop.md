# 搜索回执早停与不完整枚举（路线图 0.3.0 单元）

`grep` / `glob` 不再先构造全部命中、再把中间截掉。它们保留有限的结果前缀，并在结果预算到点时停止。
使用者会看到 `Search stopped …`，不能把这份前缀当成全量结果；可以缩小路径或模式继续找。
这一单元没有改版本，没有声称成本台账等 0.3.0 所有内容已收口。

## 结果说清什么

- 完整枚举且未碰结果预算时，小结果逐字节保持原样，空结果仍说 `no line/path matches …`。
- 已发现但放不下的命中如实报 `results are incomplete`；刚好填满预算就停时，后续有没有命中尚未查明，报 `further matches and completeness are unknown`。
- 命中列表是前缀，头里说 `N lines/paths shown`。不编造未扫描的总命中数、遗漏字节数或遗漏文件数。
- **总数确实知道的时候要报出来**：`glob` 只配路径、一个文件都不读，所以枚举完整时命中总数是白捡的——
  头里说 `N of M paths shown`，说明里说 `M-N more paths are not shown`，**不说** `Further matches are unknown`。
  把可知的数说成未知与"不猜未知"是两件事，而模型最需要的恰好是"这个模式一共匹配 5,000 条、我该收紧"。
  枚举自己不全（或完整性未知）时 `M` 不是总数，那一档仍然只报前缀与未知。
  `grep` 的 `content` / `count` / `files_with_matches` 一律不报总数：不读完文件确实不知道还有多少命中。
- 第一条命中就过长时给完整 UTF-8 前缀，并说 `Last result line shortened`；保留完整字符，不劈开汉字/emoji。
- `count` 对已经完整扫描并显示的文件给精确匹配行数，早停只发生在文件结果行之间。文件名档只需找出文件内第一条匹配。
- 行迭代保留旧 grep 的末尾 LF 空段和空文件一段语义；不预先拆出整文件行数组。
- 枚举到行数/深度上限，显示 `Enumeration incomplete (rows/depth limit)`；即使请求的文件/glob 不在已枚举前缀中，也不能说整个范围都没有匹配。
- 旧宿主没有详细枚举读口时如实报 `Enumeration completeness unavailable`。这是不知道，不能假报完整。

候选边界仍由原宿主维护：不跟软链，深度 24，最多 5,000 条文件。详细状态来自
[walk 限制读口](walk-limits.md)，不改冻结的 View/Truth 契约。最终仍过统一 `capReceipt` 出口。
没有 cgroup/内核安全配置变化。

**结果行的预算是算出来的，不是拍出来的**（`src/tools/search-receipt.ts` 的 `SEARCH_ROW_BYTES`）：
8,192 减去「说明块最长那一份（四条全上 + 每条一个换行）333 字节」「结果头最长那一份
（`N of M paths shown:` + 换行，两个数各留 7 位）32 字节」「运行时在回执后面追加的那一句
（`stepsLeftTail`）留 256 字节」= **7,571 字节**。

原先写的是 `MAX_RECEIPT_BYTES - 512`，而最坏情况下实测只剩 **42 字节**余量：说明措辞再长一句、
或者 `AGENT_LAND_NOW` 改一句话就越界，搜索回执就被 `capReceipt` 中段截掉——正是这一单元声称要
避免的那件事。而且**没有一条测试能发现它**：`w10.test.ts` 的字节断言都落在追加那一句**之前**的
face 输出上。`search-stop.test.ts` 的「the row budget leaves room for the worst case …」把这件事
钉成断言：最坏说明集的 `render` 结果拼上真正的 `stepsLeftTail`，`capReceipt` 一个字节都不许动它，
并对着 `driver.ts` / `plan.ts` 两处真正的收工句子核 256 这个留量。

## 预取成本与实测取舍

候选仍按原 walk 顺序，先过滤路径/glob。首批预取 32 条；回执不足四分之一时后续批增至最多 128 条，
否则仍取 32 条。回执够了就不再预取下一批，也不再读后续文件。这是**候选条数**边界，不是总字节/内存边界。
完整 blob 仍会取回；这不是 git 范围 I/O 或索引查询。

`tools/bench-search-stop.js` 用**同一份下层 blob 语料与当前缓存**，隔离比较旧的整树预取/全扫和新早停。
它不是旧版本完整端到端对比，也不作 CI 速度断言。在云工作区取 3 趟中位数，256 文件 × 64 行，1,972,900 字节：

- 密集命中：冷 100.473 → 31.904 ms，热 32.286 → 0.256 ms；读文件 256 → 1，预取路径 256 → 32；冷请求仍 5，热仍 0
- 稀疏命中：冷 51.018 → 87.757 ms，热 8.017 → 7.147 ms；冷请求 5 → 12，完整扫描仍读/预取 256 条
- 没有命中：冷 89.188 → 53.771 ms，热 17.096 → 7.311 ms；冷请求同样 5 → 12，完整扫描仍读/预取 256 条

**不是每档都变快。**冷稀疏档这次变慢，分批多付 7 次请求；时间有波动，请求数与读取数更能解释机制。
这些是首个固定 32 条单元的原始读数，保留稀疏退步的记录，不以新样本偷偷替换旧结论。
下一小单元测量后采用上述自适应批次，比较如下。
原 `tools/bench-grep.js --runs 3 --json` 在本仓 src 副本（264 文件、3,869,192 字节，模式 `export function`）
测到冷 43.61 ms / 60 请求，热 5.53 ms / 0 请求。所有云读数仅供趋势，不是一等档 ext4 的性能常数。

## 自适应批次的单独复核

`--reference-root` 可用同一份语料与当前缓存，对指定的先前工具实现逐字节复核回执。
以先前固定 32 档（remote `c6a8571f` 的同树源码）作参照，5 趟中位数：

- 密集：读 1 个文件/预取 32 条不变，冷请求仍 5、热仍 0；冷 18.590 → 15.150 ms，热 0.513 → 0.341 ms
- 稀疏：冷请求 12 → 7，冷 44.684 → 42.057 ms，热 8.199 → 7.314 ms
- 无命中：冷请求 12 → 7，冷 49.967 → 41.314 ms，热 6.538 → 6.605 ms

稀疏与无命中仍完整读/预取 256 条，冷热输出与固定档逐字节相同，热请求仍 0。
新策略少付 5 次批请求，但仍比最初整树预取的 5 次请求多 2 次；没有宣称全面提速。
稀疏首批之后突然出现密集命中时，新策略可能提前取最多 128 条；回归案例量到先取 32 + 128 条、实际只读 33 个文件，随后停止。
这比固定档在同一转折多预取一些候选，是减少冷批请求的代价，不把它写成全档少读。
单个 blob 可能很大，128 条上限不等于 128 个小文件，所以预取另有一道字节预算（`PREFETCH_BYTE_BUDGET`，4 MiB，缓存缺省容量的一半）：超出就只取回前缀并如实告知 `grep` 覆盖到了第几条，其余下一轮重新成批。72 KiB × 256 个文件的冷搜索，没有这道预算是 134 次请求（一批 9 MiB 挤爆 8 MiB 缓存，前几条被逐条重取），有了它回到几批。
目录描述、schema 和模型夹具字节没有再变，不需要再适配前缀或改历史 live 验收。

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
node tools/bench-search-stop.js --runs 5 --reference-root <先前固定批次的checkout>
node tools/bench-grep.js --runs 3 --json
node tools/check-events.js
node tools/check-targets.js
```

新增早停回归在先前实现上失败，独立审查抓到的恰好填满预算真值问题已补回归。
普通 `read`/`bash` 的完整文本截断不变；W10 的 read 标记断言保留，grep 改测早停真值与 UTF-8 边界。
