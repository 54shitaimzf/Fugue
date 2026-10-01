# 这一份夹具的来历

`wire/call-000N/` 是 `fugue round run --dump-wire` 落下来的形状（读法见每个子目录里的 `README`）。
`provenance.json` 是机器可读的那一份同样内容。

## 响应是**录下来的**，请求是**离线改齐的**

- `response.sse` · `response.sha256` · `meta.json` 的 `responseBytes` / `responseHash` / `stop` /
  usage / timings：**都是当时真跑那一趟收回来的字节**，一个字节都没有被改过。
- `request.json`：正文（`messages` · `system` · 三区内容 · 协议参数）同样是当时发出去的那一份；
  **只有 `tools` 那一栏被离线改齐成当前 `src/tools/catalog.ts` 的投影**，跟着它派生的
  `request.sha256`、`meta.json` 的 `requestBytes` / `requestHash` / `zoneAHash` 一并重算。

改齐这件事由 `node tools/adapt-wire-in.ts` 做（实现在 `test/helpers/wire-catalog.ts`）：它读本仓库
的目录、按产品那把序列化器（`src/model/wire/stream.ts` 的 `stableJson`）重写请求字节。**整个过程
不出网、不读凭据、不花钱**，而且逐字节可复算——拿同一个提交跑两遍得到同一份字节。

## 为什么不是"过期就红着"

`--wire-in` 按请求字节逐字核对（`src/model/http.ts`），所以**改一句工具描述就会让这一份过期**。
过期之后 `src/cli/chain.test.ts` 的序 1 不是"报出一处不同"，而是整条端到端验收（验收照过 · 产物
逐字节相同 · 每条调用逐条对上 · 围栏 `full` + `bwrap+landlock` · 停因收敛）**一条都不再执行**，
`full` 这道合并闸门长期红。那不是更严格，只是更瞎。

所以口径拆成两句：

- **目录字节漂了就改齐**（这一份 · 可离线复算 · 来历写在这里）。
  `src/cli/wire-in-catalog.test.ts` 在 **fast** 档盯着它：盘上这一份与当前目录不一致就当场红，
  而不是等 `full` 档里的 real 测试。
- **录下来的字节被改过就当场拒**（产品规则，一个字都没松）。`request.json` 改一个字节 →
  `meta.json` 与它对不上 → 回放拒（`src/cli/chain.test.ts` 的「序 1 负对照」与
  `src/cli/wire-in-catalog.test.ts` 的最后一条各在一档上守着这件事）。

## 这一份**不能**证明什么

它不是一次新的真调用：响应、usage、缓存读数、时延全都是历史的。要新的证据就真跑一趟
（`tools/record-wire-in.sh`），那要提供方、凭据与花钱的授权。
