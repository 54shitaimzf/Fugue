# grep 已声明选项的兑现

这一单元修复工具目录已有、实现却忽略的 `glob` 和 `output_mode`，并允许 `path` 指一条文件。
它是路线图 0.3.0 早停之前的接口修复；没有新增工具字段、改目录字节、改版本或声称这一站收口。

- `glob` 用与 `glob` 工具相同的路径模式，**视图根相对的那一份与范围相对的那一份都认**（两边取并）；
  先与 `path` 范围取交集，随后才预取和读内容。
  只按视图根相对配的话，`path:'src'`（或 `cwd:'src'`）之下最自然的那个模式 `*.ts` 配不上 `src/a.ts`，
  回的是毫无限定的 `no line matches …` —— 而发现类工具回空列表看起来只是"真没有"，一个字的错都不报
  （这一条坑在 `glob` 工具上真烧过一格，见 `src/tools/execute.ts` 里 `globToRe` 的注释）。
  模型能看到的 schema 只有 `Only look at these paths (path pattern)`，"根相对"这件事它读不到。
- `path` 可指文件或目录，缺省仍是当前工具工作目录；目录包含其后代。**尾斜杠归一掉**：
  `path:'src/'` 与 `path:'src'` 是同一件事（不归一的话候选集是空集，同样一个字都不报）。
- 范围与路径模式这两条语义 `glob` 工具与 `grep` 共用同一处（`scopeOf` / `inScope` / `matchesInScope`），
  所以两条发现类工具的 scope 讲法一致：`glob` 的 `path` 从此也认尾斜杠、也认直接指一条文件。
- `output_mode` 缺省 `content`，返回 `路径:行号:正文`，逐字节保留旧的默认回执（包括末尾空行匹配和非法 UTF-8 的替代字符）。
- `files_with_matches` 每个命中文件只列一次路径；文件内第一条匹配已足够，不再数后续行。
- `count` 每个命中文件返回 `路径:匹配行数`。这里数行，不数一行里出现几次；空文件和末尾 LF 的空段仍遵循旧 grep 的 `split('\n')` 语义。
- 空结果仍说 `no line matches …`。错误的模式值和非字符串的 `glob` 在枚举视图前拒绝。
- 预取读口缺席时仍逐文件读。过滤后的候选与返回顺序沿用原 `walk` 顺序；缓存和真源没有改。

验证：

```
node tools/test-entry.js fast src/tools/grep-options.test.ts src/tools/execute.test.ts src/tools/read-window.test.ts
```

新增回归在原实现上实际失败：glob 仍读不属于候选的文件，文件名/计数档返回内容行，坏模式还进入宿主枚举。
回执继续经过原来的统一 `capReceipt` 出口；**完整扫描和大结果截断的旧行为仍在**，早停与 MAX_ROWS 如实报将另作路线图 0.3.0 单元。
