# wire-in 这份夹具的来历账

一次真实 round 的录像：**发出去的请求字节**、**上游回来的原话**、三区指纹与那三项账。
回放档（`fugue round run --wire-in …`）按 `requestHash` 逐字节核，核不上就当场拒——所以它既是
一次端到端验收，也是"发出去的字节就是装配出来那一份"的证据。机器可读的那一份在
`provenance.json`，这一页是它的说明。

## 哪些是录的，哪些是离线改齐的

**录的（永不改）**：`wire/call-*/response.sse`（上游原话的原始字节）与它的 `response.sha256` ·
请求里除 `tools` 以外的每一栏（`messages` · `system` · `max_tokens` · `model` · `stream` ·
`thinking` · `output_config`）· `meta.json` 里那几栏账（`target` · `responseBytes` ·
`responseHash` · `events` · `attempts` · `opened` · `closed` · `stop` · `failure` · `outcome`）·
`scenario.json`（录制那个工作区的全部输入，含第一行那个趟次标记）。

**离线改齐的（可逐字节复算）**：`request.json` 里 **`tools` 那一栏**——工具目录的描述进请求
字节，所以改一句描述这三份请求就过期；改齐就是把它换成当前目录在该线型上的投影（形状由那条
线自己的适配器给），再把派生栏一起重算：`request.sha256` · `meta.json` 的 `requestBytes` ·
`requestHash` · `tools`，以及从 `system` **复算**出来的 `zoneAHash`。

## 两条红线

**响应永不改。** 上游那一段话是证据，不是我们的输入。`response.sse` 与它自己的 `meta.json`
对不上就是一份被改过的取证物——回放那一档当场拒，离线改齐脚本也当场拒、一个字节都不写。

**录的字节被改即拒。** `request.json` 动一个字节，`meta.json` 的 `requestHash` 就对不上，
回放当场拒（`src/cli/chain.test.ts` 序 1 的负对照量着这一条）。所谓离线改齐，说的是"把 `tools`
那一栏换成当前目录投影、把派生栏一起重算"，不是"把指纹修得像新的"。

## 什么时候用哪一条

| 漂的是什么 | 处置 | 命令 | 代价 |
|---|---|---|---|
| 目录文案（描述 · 参数说明） | **离线改齐** | `node tools/align-wire-in.ts` | 不出网 · 不读凭据 · 不花钱 |
| 响应侧要新证据 | 真跑重录 | `sh tools/record-wire-in.sh` | 约 ¥0.02 · 3 次调用 · 要网要凭据 |
| 参数面 / 语义 | 真跑重录 | 同上 | 同上（旧响应不再是有意义的对照，离线改齐就成了伪造对照） |

改齐之后：快档 `src/cli/wire-in.test.ts` 当场绿，real 档 `src/cli/chain.test.ts` 序 1 照旧
回放；`--wire-in` 那一趟仍然是**一次 fetch 都没有**。
