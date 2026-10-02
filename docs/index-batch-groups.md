# 派生索引读取：批大小与预算退档的量尺

这是 `roadmap/scoped-index-batch` 的开发量尺扩展，基础为精确提交
`c9d010ffde553e6183926b9c35cc25967d9aa769`。没有改产品 store、lookup、候选过滤、
工具目录或默认启用策略。之前四行 scheduler 的端到端实验有密集/稀疏回归，仍未发布。

## 可复算边界

`tools/bench-index-batch.js --compare-batch 4` 把旧侧换成四行 scoped batch，
新侧的 `--batch 32` / `128` 对应工具当前候选批大小。每侧仍只有四个叶读取 lanes，
每次返回前都重核祖先与根名称绑定，不持跨调用目录句柄。两侧在同进程交替运行，
每个成功记录与从真实源字节独立构建的完整 index 比较。准备时间单列，源、canonical
字节量、gram量、代码与量尺 SHA-256、全部样本和 API 次数随结果保存。

- 默认语料：512文件 × 256行重复代码，16,037,385源字节
- 预算语料：128文件，各50,000个 seeded UTF-16 code units，来自512字符字母表；
  12,800,000源字节，单条记录均合法，合计超过单批1,000,000 gram /16MiB预算
- `--entropy-chars` 每文件最多200,000，files × chars最多8,000,000；参数校验在临时目录分配前
- `--recover-unknown` 对有效却因合计预算缺席的记录用四个 scalar lanes 额外重读，
  费用在墙钟/API次数内，最终要求完整 index 数组逐条与源参考一致

未知项不是排除项。没有恢复时，只能说已返回记录正确，不能把跳过48/108条记录后的
更快读数报告成等量工作的收益。恢复只是机制对照，不是未来产品策略；这里没有创建
lookup factory，因此不量 source读取、Worker构建、实际grep回执或Git requests/spawns。

```sh
node tools/bench-index-batch.js --compare-batch 4 --batch 32 --runs 7
node tools/bench-index-batch.js --compare-batch 4 --batch 128 --runs 7
node tools/bench-index-batch.js --compare-batch 4 --batch 32 --files 128 --entropy-chars 50000 --recover-unknown --runs 5
node tools/bench-index-batch.js --compare-batch 4 --batch 128 --files 128 --entropy-chars 50000 --recover-unknown --runs 5
node tools/test-entry.js fast src/search/index-batch-bench.test.ts src/search/index-read-batch.test.ts src/search/index-store.test.ts
```

## 测得什么

最终精确源码结果见 `measurements/index-batch-groups.json`。这是自生成语料、page cache
已预热、带in-process API计数包装的云端量尺，计数不是内核syscall次数；没有物理cold、
ext4、真实sandbox、模型付费前缀或live验收声明。

精确当前脚本的最终隔离结果（同侧中位数，不是逐对比值中位数）：

- 重复代码：4→32为324.964→202.251ms，4→128为260.601→145.813ms；两组各7对均未更慢。
  open/stat/read/close从1664/2688/1024/1664分别降至1104/1680/1024/1104、1044/1572/1024/1044。
  总canonical1,353,771字节、204,039grams，均在大批预算内，完整参考覆盖未减少。
- 预算语料：canonical57,607,981字节、6,397,317grams。group32每次48条unknown并额外48次scalar读，
  2318.407→2713.578ms，5对中4对更慢；read256→352，open416→564。
- group128每次108条unknown并额外108次scalar读，2334.176→2237.512ms；虽然两侧中位数略有收益，
  5对中3对更慢，open416→909、read256→290。早一轮同工作负载为2056.557→2126.468ms（回归），
  所以不是稳定或普遍收益。记录完整恢复后的语义等价，不能把未知项省掉的读数当成收益。

所有最终矩阵都含相同精确量尺hash，未和其他测试/性能任务同时运行。
先前跳过unknown的快读数不进入最终等价矩阵；初始四行scheduler端到端数据也不被此机制量尺取代。

## 下一步条件

大批共享祖先的机制收益不能直接推出产品收益。合计预算可能让有效磁盘记录返回unknown；
旧lookup把unknown当miss后还可能读取source/重新构建。因此任何可选批量查询口都必须先
证明完整当前View/原始regex回执等价，量首次missing、drain/准备与source/build计数，
覆盖预算饱和、代际变动、取消和close，且保持未知退扫描与诚实partial回执。
本量尺不满足0.4冷查询门槛，不批准默认索引、native阶段或新的工具并行。
