# main 的分支保护（0.2.2）

**必绿集合 = 快 + 真**：两个 check 名 `fast` 与 `full`（下面那张表）。文档仓那条 `check-*`
**留在本机**——文档仓没有远端，跨仓的 `check-events` / `check-ui` 要两个 checkout 同台，**不搬进
代码仓**（口径如实记，不是漏了）。审档 `audit` **不在**这份名单里：它只报不挡。

payload 只有一处：`.github/main-protection.json`（下面那条命令吃的就是它，别在别处再抄一份）。
`test/ci-workflow.test.ts` 把它钉死了：必绿集合必须**恰好**是 `fast` + `full`，而且每个名字都必须
是 workflow 里**存在的 job 名**——错一个名就永远挡合，这是这类配置最常见的翻车点。

## 应用（一条命令）

```sh
gh api -X PUT repos/54shitaimzf/Fugue/branches/main/protection --input .github/main-protection.json
```

**别在本机跑**：这是远端操作（0.2.2 的交付物是本地提交序列 + 这份清单，推不推由人定）。

## 静态对照表：payload 里的 context ↔ workflow 里的 job/check 名

| payload 里的 context | workflow 里的 job（`name:` = job id = check 名） | 跑在哪些事件上 | 跑什么 |
|---|---|---|---|
| `fast` | `fast` | push · pull_request | 快档 |
| `full` | `full` | pull_request | 快档 + 真档，计时读数存 artifact `ci-timing` |
| ——（不在集合里） | `audit` | schedule · workflow_dispatch | 全量兜底 + 变异审计，报告存 artifact `mutation-audit` |

`full` 这一条覆盖真档：同一个 job 里先 `node tools/ci-timing.js fast` 再
`node tools/ci-timing.js real`，逐档墙钟分开落在 artifact 里——真档有没有跑，看 artifact。

## 这份 payload 的选择（以及什么条件下改主意）

- **`required_pull_request_reviews: null`：不要求 PR。** 仓库现行纪律是"接口冻结点开 PR 人审，
  机械单元攒批 PR 只看断言输出"，而那是**纪律不是门**；一个维护者的仓上加"必须有人批准"会让
  每一次合都卡死（自己批不了自己）。路线图 §2 那句「CI 挡的是合，不是写」就是这个意思。
  改主意的条件：有了第二个稳定维护者。
- **`strict: false`**：不要求"合之前先把 main 合进来"。改 true 的条件：并行 PR 多到"合上来才发现红"。
- **`enforce_admins: true`**：规则对维护者也生效——否则管理员账号一步绕过，等于没有保护。
  代价是维护者也不能把红的 PR 合进 main；要紧急绕过就得先改这份配置（改规格，人批）。
- **`allow_force_pushes: false` · `allow_deletions: false`**：main 的历史不许重写、分支不许删。
- 直推 main 会不会被必绿集合拦住：**没实测**（本机全程不碰远端）。观察点是推送后清单的 **P3**；
  真被拦了，改哪一格由人定。
