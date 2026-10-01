# 历史录音与合成目录兼容回放

`original/` 完整保留提交 `e02fa524579bbd6332278e21a27b15c7b12c4b05` 的这份夹具：
场景及三条调用的请求、响应、meta、sha256、README 均逐字节不变。
`original/manifest.json` 标明源提交及每个文件的完整 SHA-256；适配器固定核对 manifest
自身的指纹，再核全部种子，不能把被改过的种子或 manifest 当成原录音。
这些字节不会被适配器写入。

`wire/` 是额外的合成兼容覆盖：请求的 `tools` 换成当前 catalog 投影，
`request.sha256`、meta 的 `requestBytes` / `requestHash` / `zoneAHash` 跟着复算。
除此之外的请求字段、meta、response、usage、timings、scenario 与原种子一致。
调用子目录中的历史 README 说明录音的文件形状；当前请求是否是真实录音以本说明和
`provenance.json` 为准，不能把这个合成目录称为新的提供方响应或 live 录制。

## 确定性和写入边界

`node tools/adapt-wire-in.ts` 总从原种子派生，不从已经适配过的请求派生。
全部种子、调用集合、目标非目录请求字段、历史 meta/response/scenario 和目标文件存在性
都验证之后才写入；后面的坏调用不会让前面的请求已被半套改写。
还拒绝夹具内的目录/叶软链与多硬链接文件，防止输出别名改写原种子。
这是本地静态验证，不是同 UID 活跃攻击者隔离，也不是多个文件写入的跨进程事务。

`provenance.json` 只含确定性信息：源提交、源 manifest、原请求/meta/响应完整 hash、
合成请求指纹和 catalog 指纹。每条 `changed` 表示相对原请求是否不同，
不是这次是否写盘。函数返回和命令的 `writtenFiles` 才是这次实际写入文件数，
不写进 provenance。相同目录重复执行时字节、mtime、原始来历均不变，写入数为0；
`adaptWireIn(root, false)` 只核对和计算，不写盘。过程不出网、不读凭据、不花钱。

## 验收口径

合成回放可覆盖当前请求结构与历史响应解析的兼容性。它不能替代
`src/model/http.ts` 的冻结历史录制规则，也不提供新的响应、usage、付费前缀、
缓存收益、时延或全量 live 验收证据。工具目录变更仍需真正运行并录制新的提供方调用，
这项门槛目前未完成；不得靠离线改齐把它报告为 full/live 验收通过。

`wire-in-integrity.test.ts` 单独验证原始 transport 接受原请求、拒绝当前 catalog 的
合成请求。`wire-in-catalog.test.ts` 和本分支 `chain.test.ts` 的适配请求消费是
合成兼容覆盖，必须连同上述限制解读。产品 transport 的逐请求字节核对没有修改。

```sh
node tools/test-entry.js fast src/cli/wire-in-integrity.test.ts src/cli/wire-in-catalog.test.ts
node tools/adapt-wire-in.ts
```
