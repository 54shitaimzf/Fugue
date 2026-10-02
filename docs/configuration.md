# 配置：查看在场的键与现有消费族

`fugue config ls` 只列系统级与工作区级合并后**在场的键**。它与 `config show` / `config get` 使用同一份 `readConfig`：系统级打底、工作区级覆盖，对象深合并，数组与标量整份覆盖。它不展示值，不列未配置的默认值，也不是所有合法键的 schema 注册表；消费者的形状、语义检查与缺省处理照旧。

```sh
fugue config ls
fugue --json config ls
fugue config get round.id
fugue config show
```

普通路径一行一个点分键，按每级键名的 JavaScript 字符串顺序排列。数组、null 和空对象都是末端值，不列数组下标；空配置不输出行。段里有点、空串、空白或控制字节时，文本输出 JSON 段数组，避免把一个键误说成几层。`--json` 始终输出段数组的数组，例如 `[["docs","a.b","path"],["round","id"]]`；它保留精确键名。两种输出的 JSON 都显式转义 C1、双向/格式控制字符，解析后仍还原原键名。现有点分 `get` / `set` 不能寻址包含字面点的键，这一命令没有新增转义寻址格式。

`ls` 不接受额外位置参数，不读视图、对象库或日志，不创建配置与历史文件。坏 JSON、未知顶层键与坏 UI 形状继续使用现有拒绝。凭据族里存的是引用；本命令连引用值也不打印、更不解析凭据。`--system` 仍只选择 `set` 的写入级；`ls` 和 `show` / `get` 一样读合并配置。

## 当前顶层域

顶层域来自 `src/config.ts` 的 `TOP_LEVEL_KEYS`，以下是现有消费面说明，不替开放的成员名增添约束。

| 域 | 现有消费与边界 |
|---|---|
| `actions` | `actions.<name>` 是动作绑定；argv、cwd、outputs、cache、env、net 由 binding 消费并核验。动作名按配置在场值取，不另外注册。 |
| `ports` | `ports.range` 是工作区端口池范围，由 binding 读取。 |
| `boundary` | `boundary.enforcement` 选围栏强度；`boundary.env` 选继承/注入环境；`boundary.reach` 声明只读可达根。 |
| `platform` | 平台声明在项目配置/系统状态投影中消费。 |
| `round` | `round.id`、`round.model`、`round.assertions`、`round.split` 由现有轮次 CLI 消费，名称、模型、检查与拆分规则仍在各自边界核验。 |
| `config` | `config.net` 是系统状态投影的配置值；此域也能保存既有 JSON 自定义数据，存下不等于有生产消费者。 |
| `docs` | `docs.<name>` 的 path/prompt 由文档端与装配投影消费；动态文档名照旧。 |
| `workspace` | 项目配置中的工作区声明进入已有系统状态投影。 |
| `credentials` | `credentials.<provider>` 是环境变量名/文件路径的引用，真出网时才取值；不是模型目录的认证槽。 |
| `toolchain` | `toolchain.<name>` 的 probe/doc 是声明，reading 是工作区级的探测缓存；不因为 ls 运行探针。 |
| `ui` | `ui.keys` / `ui.keys.<action>` 是现有按键覆盖；动作/键串/冲突由 keymap 核验，语义错的读侧退化继续如实提示。 |

## 文档诊断

`node tools/check-config-keys.js` 校验此表与实际顶层键域一一对应，且现有导出的围栏/端口键与生产源码的字面读取键都有说明。它确定性遍历 `src` 的非测试 TS/JS/MJS 文件，不跟随软链；新文件中的直接字面 `getConfig` 调用也在覆盖内。新增这些键而漏文档会红，表里漏域、重名或多写未知域也会红。扫描是文本诊断，不解析完整语法：动态成员、函数别名与任意 JSON 子键不靠它冒充完整 schema；新增消费族仍须更新说明并按自己的边界核验。

同一诊断还核命令帮助的独立行与当前旗标表入口；`assemble <protocol>` 已补回速查表，漏行或列出未知入口会红。此处按实际入口集合比较，不手抄一个命令总数。

JSONC、配置分家与扩展设置面按官方 1.3.0 阶段处理；本批没有新配置格式或设置键。
