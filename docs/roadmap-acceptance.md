# Roadmap实现与验收清单

**时间截面：2026-10-01 17:50 UTC（PR/head表采样17:32）；不表示全部roadmap完成。** 本清单从Git提交、公开PR/CI和
现有设计重算，便于接续；进度真源仍是提交与验收证据，本页不替代[ROADMAP](../design/ROADMAP.md)
或人审。链接中的提交SHA完整且不可变，表内只显示前12位；分支会继续移动，使用前须重查。

上游main为 `a5bd9b4d765075dcc6179e73eed99008c5ba23b2`，相对 `e02fa524579bbd6332278e21a27b15c7b12c4b05`
只接回两张架构表及CHANGELOG。17:32公开API所示PR21–38的base快照仍是e02，全部open/non-draft。
这些PR后来在外部出现；本轮此前create-PR返回403，未重复创建、未推断写权限恢复，未擅自改
PR状态或合并。下列七份新fork分支在该PR截面没有对应上游PR；**fork发布≠上游PR或版本验收**。

## 按里程碑区分状态

| Roadmap | 已实现/证据 | 尚未验收的条件 |
|---|---|---|
| §2–3 / 0.2.1–0.2.4 | 上游已有分组、CI三档、blob缓存/批量预取的版本记录 | 此后分支证书不能替代上游版本周期；受影响选择/分片仍按实测门槛启动 |
| §3 / 0.2.5 | walk代缓存、read窗口已实现并独立审查；普通不切片read与walk输出保留，原来忽略的已公布slice选项修正 | 当前外部slice标题/catalog描述等前移差异须重新核；一等档bench/完整PR验收与必要live捕获未收口 |
| §3 / 0.3.0 | 早停与不完整枚举如实回执已实现；旧日志可导出LLM-call成本 | **每工具持久成本仍缺**：冻结event扩展未获审批；不可虚构每工具tokens；目录改变后的真实前缀重录未完成 |
| §4 / 0.3.1 | 版本化trigram格式、受控落盘、损坏回退/重建、符号槽 | 可选分支实现；不是已发布缺省档；校验和不认证同UID伪造表完整性 |
| §4 / 0.3.2 | 当前blob增量、miss不等构建、有界后台worker与生命周期 | 可选接缝；source不合作取消时实际IO可能继续，close不许宣称回滚已完成发布 |
| §4 / 0.3.3 | 候选交当前View blob集合、仍以原regex验证、变代整批回退 | 默认关闭；本地/CI正确性不替代冷路径门槛 |
| §4 / 0.4.0 | packed builder/worker复用/facts有各自域内读数；rg决定暂不引入 | **测量门未过**：16MB首趟/新模式仍超过50ms，云overlay不是一等档ext4；不能启用索引缺省 |
| §5 / 0.4.1–0.5.0 | [serve提案](https://github.com/StevenLi-phoenix/Fugue/blob/79947aa01bce50bc35de5b4a9efc9615a063c28a/docs/serve-design-proposal.md)明确proposed/unapproved | **设计门**：round写者同一round.lock整条命令所有权及并行事件形状须批；协议冻结/serve/TUI客户端化均未启动 |
| §6 / 1.0.0 | 可以核既有八步验证；本轮保留证据与负对照 | 完整逃逸/基线、一等档、真实捕获、PR周期、#1并或关、人审tag→Release仍缺；与阶段一至三正交，不伪造完成 |
| §7–8 / 1.x–2.x | 沿原roadmap保留原生/分发路线，弃置的是此前整仓Rust重写 | 尚未进入相应收口/测量条件；T1明确暂缓，T3已有兑现记录，其他条件目标无新触发证据；不越过人审或用新语言回避机制证据 |

## 当前PR head与历史审查点

旧证书只证明当时head/tree。出现“已外部前移”时，不把旧fast/full绿转移给新head；
已单独审过的局部差异也不是整个新组合的发布验收。外部改动保留，不强推覆盖。

| 上游PR | fork分支 | 17:32当前head | 原独立审查head | 边界 |
|---|---|---|---|---|
| [#21](https://github.com/54shitaimzf/Fugue/pull/21) | `roadmap/call-cost-ledger-derived` | [4ba1af0042aa](https://github.com/StevenLi-phoenix/Fugue/commit/4ba1af0042aabe30eac1015f91aa1a2879a826a7) | [6b0a34a9358d](https://github.com/StevenLi-phoenix/Fugue/commit/6b0a34a9358d21d5af64002a49b6730d135697de) | 已外部前移；须核新增差异 |
| [#22](https://github.com/54shitaimzf/Fugue/pull/22) | `roadmap/regex-literal-trigrams` | [fe596b9fb87b](https://github.com/StevenLi-phoenix/Fugue/commit/fe596b9fb87b6c8f54ee81ece11dd842b46a0194) | [7258e4a214d0](https://github.com/StevenLi-phoenix/Fugue/commit/7258e4a214d0a63a159f29becac150a55a42db38) | 已外部前移；须核新增差异 |
| [#23](https://github.com/54shitaimzf/Fugue/pull/23) | `roadmap/serve-design-proposal` | [79947aa01bce](https://github.com/StevenLi-phoenix/Fugue/commit/79947aa01bce50bc35de5b4a9efc9615a063c28a) | [016435f06705](https://github.com/StevenLi-phoenix/Fugue/commit/016435f067058f1bb30c1ebc7deeb4d5d5aeaf6d) | 已外部前移；须核新增差异 |
| [#24](https://github.com/54shitaimzf/Fugue/pull/24) | `roadmap/trigram-index-format` | [3c166cc6d663](https://github.com/StevenLi-phoenix/Fugue/commit/3c166cc6d6632218e14148ae5a9e67673bfb5492) | [74510409365f](https://github.com/StevenLi-phoenix/Fugue/commit/74510409365fccbcacba8c69c104a9a8377ac0cc) | 已外部前移；须核新增差异 |
| [#25](https://github.com/54shitaimzf/Fugue/pull/25) | `roadmap/ts-b-read-windows` | [93ee2e4cc33a](https://github.com/StevenLi-phoenix/Fugue/commit/93ee2e4cc33a14081028e1df0f2bcf6e84e3958d) | [2cf0f746ec27](https://github.com/StevenLi-phoenix/Fugue/commit/2cf0f746ec27388e49feae794d5349c98d686c76) | 已外部前移；须核新增差异 |
| [#26](https://github.com/54shitaimzf/Fugue/pull/26) | `roadmap/view-walk-cache` | [a8fe898795e3](https://github.com/StevenLi-phoenix/Fugue/commit/a8fe898795e3d4b1addce59603d954d711244ed3) | [1a90599fa42b](https://github.com/StevenLi-phoenix/Fugue/commit/1a90599fa42b29d6e1a3a402499eda434513459b) | 已外部前移；须核新增差异 |
| [#27](https://github.com/54shitaimzf/Fugue/pull/27) | `roadmap/current-view-index-candidates` | [edab968b79d8](https://github.com/StevenLi-phoenix/Fugue/commit/edab968b79d84cf4f419891459c4e83fe87dbfbf) | [2b055ccb3b3a](https://github.com/StevenLi-phoenix/Fugue/commit/2b055ccb3b3a4b5d9731e2f0eeca87a0822324e9) | 已外部前移；须核新增差异 |
| [#28](https://github.com/54shitaimzf/Fugue/pull/28) | `roadmap/trigram-index-storage` | [4097857f426f](https://github.com/StevenLi-phoenix/Fugue/commit/4097857f426f034032de7c49ed1decd9a0f7b54d) | [a6251f81e310](https://github.com/StevenLi-phoenix/Fugue/commit/a6251f81e310b6ffe5f0d7ac6e81e0ddf7aa060c) | 已外部前移；须核新增差异 |
| [#29](https://github.com/54shitaimzf/Fugue/pull/29) | `roadmap/ts-b-grep-options` | [eb43e5715ae8](https://github.com/StevenLi-phoenix/Fugue/commit/eb43e5715ae81fbc366acdddecdf18e65c2b9f8a) | [8ace0e2b45e7](https://github.com/StevenLi-phoenix/Fugue/commit/8ace0e2b45e77f5572fa094312f1902764f8fdfd) | 已外部前移；须核新增差异 |
| [#30](https://github.com/54shitaimzf/Fugue/pull/30) | `roadmap/walk-truncation-status` | [477ed0ef8056](https://github.com/StevenLi-phoenix/Fugue/commit/477ed0ef80564a68df42eea62aab8290f4d9a275) | [45eb1600c386](https://github.com/StevenLi-phoenix/Fugue/commit/45eb1600c386537292e7fdd7647116eed1e76113) | 已外部前移；须核新增差异 |
| [#31](https://github.com/54shitaimzf/Fugue/pull/31) | `roadmap/trigram-index-incremental` | [dea2f8d691d5](https://github.com/StevenLi-phoenix/Fugue/commit/dea2f8d691d5e13a31ddc6ade514427cf4496e20) | [17bc0a6eac1d](https://github.com/StevenLi-phoenix/Fugue/commit/17bc0a6eac1d76d09656aff2890f16af7dfed434) | 已外部前移；须核新增差异 |
| [#32](https://github.com/54shitaimzf/Fugue/pull/32) | `roadmap/index-builder-keys` | [730339feb0a3](https://github.com/StevenLi-phoenix/Fugue/commit/730339feb0a318455d2d76a52d0924220a878f5f) | [d901af1c0810](https://github.com/StevenLi-phoenix/Fugue/commit/d901af1c0810fa4b05e8c64880ff0cea9bc1bd35) | 已外部前移；须核新增差异 |
| [#33](https://github.com/54shitaimzf/Fugue/pull/33) | `roadmap/ts-b-grep-early-stop` | [5676670c4f9c](https://github.com/StevenLi-phoenix/Fugue/commit/5676670c4f9c4d30d0f0f1073343d36a48fd08b2) | [c6a8571ff0db](https://github.com/StevenLi-phoenix/Fugue/commit/c6a8571ff0dba43d97274dc47fd015cd70e5154a) | 已外部前移；须核新增差异 |
| [#34](https://github.com/54shitaimzf/Fugue/pull/34) | `roadmap/index-worker-reuse` | [b8336805361d](https://github.com/StevenLi-phoenix/Fugue/commit/b8336805361d6494304e0dec3ebf68fce81b8ba9) | [771e8640edd5](https://github.com/StevenLi-phoenix/Fugue/commit/771e8640edd50f618812e53f6af98e03d384a0f0) | 已外部前移；须核新增差异 |
| [#35](https://github.com/54shitaimzf/Fugue/pull/35) | `roadmap/ts-b-adaptive-prefetch` | [d212cf7b7c18](https://github.com/StevenLi-phoenix/Fugue/commit/d212cf7b7c182a52e5d264ec08d04e48edec8046) | [13c6ebe54460](https://github.com/StevenLi-phoenix/Fugue/commit/13c6ebe54460ce557d2d2296d1028b96eed4b492) | 已外部前移；须核新增差异 |
| [#36](https://github.com/54shitaimzf/Fugue/pull/36) | `roadmap/index-query-wiring` | [486c384622e9](https://github.com/StevenLi-phoenix/Fugue/commit/486c384622e9f05be21a238a6a90f3ddfee5ffd5) | [65e7df60dc1c](https://github.com/StevenLi-phoenix/Fugue/commit/65e7df60dc1cade1b4955d9330fc7cf7a1ac5f7d) | 已外部前移；须核新增差异 |
| [#37](https://github.com/54shitaimzf/Fugue/pull/37) | `roadmap/bounded-index-probes` | [0050de4c8f43](https://github.com/StevenLi-phoenix/Fugue/commit/0050de4c8f434dd5f537e0c392ef5cfc97ca1ad1) | [4639dd25c901](https://github.com/StevenLi-phoenix/Fugue/commit/4639dd25c901d9aca8adb0f7b85eecd619456be2) | 已外部前移；须核新增差异 |
| [#38](https://github.com/54shitaimzf/Fugue/pull/38) | `roadmap/index-benchmark-reference` | [5c91606d7be1](https://github.com/StevenLi-phoenix/Fugue/commit/5c91606d7be1f2004516c34daaf25ce5bf5c70ca) | [a9a801eb09f5](https://github.com/StevenLi-phoenix/Fugue/commit/a9a801eb09f599f9e3ef48ec48f0c8faf8a23721) | 已外部前移；须核新增差异 |

需特别处理的差异：

- 同一5c916 lookup对未核请求BlobId的超预算source回复永久memo为unindexable，挡住后来
  正确小blob的重试；close也未清该负memo。独立负对照复现，须将未验证oversize保留为
  可重试unknown，并结清句柄负状态；单独修复进行中。它不能被归作设计/访问门。
- 最新PR38组合5c916引入可选数字prefetch coverage：非整数covered=1.5可跳过中间真实
  命中文件并错误报告完整nomatch，独立官方负对照0/1失败。**这是未结功能缺陷，不是环境门**；
  必须拒无效覆盖并回正常扫描，单独修复尚待审查/整合。该组合还带下列两项未整合问题。
- PR34的b833含按年龄清未知.tmp和同步close抛错漏收尾；现有full绿未抓住独立复现。
  修复另放bf462，保留未知writer临时叶并观察所有close，**尚未并入PR34**。
- 17:22时PR25/29/33含507748d9将历史wire-in请求/hashes/meta离线换成新目录，仍复用旧response/usage。
  这不是一次真实模型调用。9f533保留外部适配过的wire/目录，另加逐字节原样的
  original/种子与分离synthetic衍生路径，按不可变原录音派生并保持幂等，
  **尚未并入原PR**；修复本身也不补出新live证据。
- PR21新增malformed/sparse retry列表的只读ledger保守处理，当前4ba1af的focused测试18/18通过；
  未改冻结event或运行时落账，仍不补齐持久每工具成本。

## 新fork分支的精确证书与依赖

以下均已独立核tree与对应push-fast，full/audit因push跳过；它们不是上游full验收。

| fork分支 | 精确head | 对应push run | 结论 |
|---|---|---|---|
| `roadmap/index-gram-facts` | [99ac1a5215d5](https://github.com/StevenLi-phoenix/Fugue/commit/99ac1a5215d50534051311af652c9e5076078b2b) | [36887807362](https://github.com/StevenLi-phoenix/Fugue/actions/runs/36887807362) | fast通过；full/audit跳过 |
| `roadmap/scoped-index-batch` | [c9d010ffde55](https://github.com/StevenLi-phoenix/Fugue/commit/c9d010ffde553e6183926b9c35cc25967d9aa769) | [36891673457](https://github.com/StevenLi-phoenix/Fugue/actions/runs/36891673457) | fast通过；full/audit跳过 |
| `roadmap/store-temporary-safety` | [bf462c7290a1](https://github.com/StevenLi-phoenix/Fugue/commit/bf462c7290a1f576a089d3ab67e163dd651b9ae0) | [36895443458](https://github.com/StevenLi-phoenix/Fugue/actions/runs/36895443458) | fast通过；full/audit跳过 |
| `roadmap/rg-sidecar-readings` | [a43d9d8387fe](https://github.com/StevenLi-phoenix/Fugue/commit/a43d9d8387fe2a5f9c90d21d6132e570d307cb27) | [36895580763](https://github.com/StevenLi-phoenix/Fugue/actions/runs/36895580763) | fast通过；full/audit跳过 |
| `roadmap/wire-adaptation-integrity` | [9f5334667e90](https://github.com/StevenLi-phoenix/Fugue/commit/9f5334667e901d935d570e5730b268274d7fdf6b) | [36897315946](https://github.com/StevenLi-phoenix/Fugue/actions/runs/36897315946) | fast通过；full/audit跳过 |
| `roadmap/index-validation-profile` | [21eda34d0ce7](https://github.com/StevenLi-phoenix/Fugue/commit/21eda34d0ce79573e76b62f52452cec59d8fd768) | [36897779337](https://github.com/StevenLi-phoenix/Fugue/actions/runs/36897779337) | fast通过；full/audit跳过 |
| `roadmap/scoped-index-group-replay` | [5307ac0a9a7e](https://github.com/StevenLi-phoenix/Fugue/commit/5307ac0a9a7e94f21cec2815aad595709851487c) | [36900090439](https://github.com/StevenLi-phoenix/Fugue/actions/runs/36900090439) | fast通过；full/audit跳过 |

依赖分开记录，不能当作已经合并的一条大分支：facts99ac父提交是原已审worker
`771e8640edd50f618812e53f6af98e03d384a0f0`；disk profile21eda父为facts99ac；rg a43d父为
上游a5bd。安全bf462父是外部b833，wire修复9f533父是外部93ee；两者待独立整合重验。
scoped reader c9d是原查询/probe/worker组合上的独立store接缝，**无产品query接线**。
group replay5307父为c9d，是[已审开发读数](https://github.com/StevenLi-phoenix/Fugue/blob/5307ac0a9a7e94f21cec2815aad595709851487c/docs/index-batch-groups.md)，不是scheduler产品接线。
benchmark reference a9a801父为 `641d891bb22b0285effaab71eb5349e09462fa9f`，
其旧/新backend必须真正分开导入，不能自比。叠PR推进不意味着授权merge。
M1取数必须把gitRequests（请求/RPC数）和gitSpawns（实际进程数）分开；请求减少不是
spawn减少，现有读数不批准原生迁移，仍沿T7/ROADMAP启动条件和1.x收口前提走。

### 已核精确head的上游full事实与局限

| head / PR | 精确run | 已核jobs | 仍缺什么 |
|---|---|---|---|
| 93ee / #25 | [36890591620](https://github.com/54shitaimzf/Fugue/actions/runs/36890591620) | fast110464920597 / full110464920968通过；audit跳过 | 使用离线改过的历史请求，不是新live |
| 63b6 / #33 | [36890590085](https://github.com/54shitaimzf/Fugue/actions/runs/36890590085) | fast110464915950 / full110464915252通过；audit跳过 | 同上，真实前缀捕获未补 |
| b833 / #34 | [36890370161](https://github.com/54shitaimzf/Fugue/actions/runs/36890370161) | fast110464168507 / full110464168650通过；audit跳过 | 仍缺临时叶/close负对照修复整合 |

17:32新增前移的PR33/35/36/37/38待复核，不迁移旧证书；上表63b6不再是PR33当前head。
历史worker771的[full36878929851](https://github.com/54shitaimzf/Fugue/actions/runs/36878929851)
通过不认证现在b833。较早查询/早停/probe PR的real133有132通过、1条冻结wire-in链失败；
当时可运行的sandbox用例通过。云本地则overlay/ext4判据和bwrap NETLINK_ROUTE受环境阻断，
未改动上游控制也复现；局部named green与中止/incomplete aggregate分开记，不称全量绿。
这三类“runner通过、cloud跑不起来、真正live证据缺失”不能互相替代。

## 已停止的无收益接线与下一步

- readSized及小组scheduler未发布：语义检查绿，但dense/sparse配对墙钟回退，不能只拿API减少做收益。
- 大组32/128的store-only重复读数减少时间，却在同样预算的50k-unit语料中分别失去48/108条
  完整覆盖；必须scalar回查所有unknown。包含恢复后的32配对2318→2714ms，128混合且3/5对回退，
  不支持产品接线或默认开启。它不是0.4冷路径验收。
- [rg决定](https://github.com/StevenLi-phoenix/Fugue/blob/a43d9d8387fe2a5f9c90d21d6132e570d307cb27/docs/rg-sidecar-decision.md)
  已核官方可执行字节，但View私有快照/更新/spawn有成本，且UTF-16/backreference/非法UTF-8语义失配。
- [磁盘观察器](https://github.com/StevenLi-phoenix/Fugue/blob/21eda34d0ce79573e76b62f52452cec59d8fd768/docs/index-validation-readings.md)
  只说明完整校验的API扇出；重叠时长不是墙钟占比，包装开销/OS热缓存不是产品优化。

下一步先修复未结coverage功能缺陷，再整合独立安全/录音完整性修复并重验精确组合head；
还需取得一等档与genuine live证据；
按已有冻结点取得成本/serve设计批准；恢复适当PR访问后发独立PR，合并与发布由人定。
未结功能缺陷需继续修，不以门为由搁置；其余条件未具备时状态是**受真实门阻塞**，
不是“roadmap全部完成”，也不制造新微优化掩盖停点。
