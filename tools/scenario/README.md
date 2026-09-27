# 样本盘（`tools/scenario/`）

**一句话**：把"这一版到底改对了没有"变成一个**不依赖模型**的读数——出题的人先写下
**已知答案**，跑完拿**真实工作树**去比对。此前量得到的两样是"机制对不对"（夹具 · 逐字节 ·
停因）与"模型自己报的"（它挑的断言跑没跑过）；模型挑一条永远为真的断言，验收照样绿，所以
那两样答不了"改对了没有"。

## 跑法（`cd ~/fugue`）

    sh tools/scenario/board.sh --selftest                  # 离线：判据自己有牙没有（不花钱）
    sh tools/scenario/board.sh --live --runs 3             # 真档：每一案连跑 3 趟
    sh tools/scenario/board.sh --live --case "改码 · 单文件（最小的一案，反复采样用）"
    sh tools/scenario/board.sh --stub                      # 打桩档：只烟测铺底与判据
    sh tools/scenario/board.sh --live --out /tmp/盘-01      # 读数落在哪

`--stub` 跑不动那条链：`round plan` 那一格要真响应才有草案，打桩档到不了门口（那一趟记
"退回"，不是读数）。

## 四样东西

| 是什么 | 在哪 |
|---|---|
| 出题人的声明：底（`base`）· 目标那一句（`goal`）· 可用动作（`actions`）· **已知答案**（`answer`）· **应当判过的那棵树**（`solved`）· 出题人自己的观察（`observes`）· 覆盖哪些环节（`covers`） | `tools/scenario/cases.json` |
| 判据（**纯读**：只吃一棵树的快照，不碰盘 · 不发网 · 不写日志）+ 它的六条断言 | `src/probe/board.ts` · `src/probe/board.test.ts` |
| 跑链 · 判答案 · 压成账上一行 | `tools/scenario/board.sh` · `tools/scenario/board-node.ts` |
| 账（制表符分隔，一行一趟） | `<out>/ledger.tsv`；每一趟的现场在 `<out>/run/<案>-<趟>/` |

## 五条纪律

1. **答案只写结果，不写过程**：不规定它怎么拆、改几步、用哪条工具——"怎么切"归模型。
2. **一条判据都没有 = 不过**（与 `src/merge/accept.ts` 那句"没人能判不算绿"同一个口径）。
3. **跑不起来就不判**：`work.json` 是空的（产品或配置当场拒了）记"没有读数 + 那一句原话"，
   不拿一棵没跑过的树去判——那是假阴性。
4. **用量从日志现算**（`statusOf`），不看模型报什么；观察（`observes`）是出题人给的命令，
   与模型挑的断言无关。
5. **判据自己有牙**：`--selftest` 拿每一案的 `solved` 与 `base` 各判一次——前者必须过、
   后者必须不过。三处负对照（改坏 `solved` · 抽掉答案 · 抽空 `answer`）当场各红一条。

## 账上那一行（15 列）

`案 · 趟 · 门退回 · 停因收敛 · 验收 · 已知答案 · 观察 · 冲突 · 拒绝 · 越界 · 调用 · input ·
cacheRead · output · 推进`

## 已经量到的（都是真档，读数在那几趟的提交信息里）

- **"两格同写一份"到不了冲突环**（把第三案按那个样子摆过一次）：`round run` 在**合并前的
  写集预检**当场拒——`merge：合并前的写入集预检不放行：r1.implement.1 与 r1.implement.2：
  src/counter.js ↔ src/counter.js [implement × implement]`，**0 次调用**。所以"冲突"这一段
  今天要先回答"怎么进得去"。
- **持轮者那一格到不了门口**：6 步撞上界、草案没写出来（`.fugue/plan/r1.md` 不在视图里），
  门退回——不是"没人能判"，是那一格收了工却没交卷。

**取证用，不是产品的一部分**（仓库约定 § 七）。凭据经环境变量给，不打印它的值。
