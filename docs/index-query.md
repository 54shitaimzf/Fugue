# 可选索引查询接线

路线图 0.3.3：trigram 候选与当前视图 blob 集相交，再沿原读取路径按原正则逐行验证。
这是显式可选接线。0.4.0 的缺省启用与 16MB 冷路径目标尚待测量与验收。

## 装配与生命周期

```ts
const index = createBlobIndexLookup(root, (blob, signal) => truth.getBlob(blob))
try {
  const host = createToolHost(view, roots, { ...options, blobIndex: index })
  // 通过原 dispatch / grep 使用 host；没有新工具、参数或模型前缀。
} finally {
  await index.close()
}
```

`HostOptions.blobIndex` 不给时沿原扫描路径走，不创建派生目录或后台任务。
句柄由装配方持有并关闭，host 不接管它。`drain()` 用于显式准备/收尾，不是 grep 的
前置条件。源回调要自觉响应 signal；真源当前读口不支持取消，实际已经发出的 I/O
不会因此倒退。后台准备的开销应另记，不能把它藏在热路径数字里。

只有保守字面正则抽出的必要 UTF-16 三元组可缩候选；短模式、量词、分组、选择、字符类、
lookaround、反向引用或不支持的转义回全扫。详见[必要字面三元组](regex-literal-trigrams.md)。
按当前 32/128 候选批问当前 `View.stat` 的 blob ID，不缓存 path→blob，不读物化树。
`false` 才能排除，`null` 或失败保留原候选；变代撤销整批负判断。

候选口只看当前批，回执早停后不再问下一批元数据/索引，也不预取下一批。随后仍通过
原 prefetch/readBytes 缓存读真实字节、用同一个 RegExp 验证，返回顺序、三种输出模式、
文件行号、UTF-8 解码和回执预算规则不变。索引误报只是多读文件，不能直接变成匹配。
全局 walk 的部分/未知覆盖信息也保持原样，排除所有已枚举候选不构成完整全局「无匹配」。

可选 ToolHost.filterCandidates 接口接收独立冻结的路径/条件副本。返回结果必须是
原批的无重复子集；乱序会按原批重排，注入、错误类型、抛错或输入突变退回原批。
它不提供整个搜索的原子快照；首次 walk 外新增的文件不在这次枚举里。

## 验证与测量

```sh
node tools/test-entry.js fast src/tools/index-query.test.ts src/tools/index-query-store.test.ts src/search/current-view-candidates.test.ts src/search/regex-literal.test.ts
node tools/bench-index-query.js --runs 3
# 16MB 级、超过默认 256 条记录的 LRU，显式量其磁盘解析退路：
node tools/bench-index-query.js --runs 1 --files 512 --lines 256
```

测试包含三种模式逐字节全扫对照、假阳性精确正则验证、可选口的冻结/失败/注入/乱序退路、
当前 View 内容和模式变化、rename、删除与目录墓碑重建、独立 base/host、查询中变代回退、
无效 UTF-8/emoji、真实日志与 Git blobs、损坏磁盘记录及关闭 pending/源失败退路。

测量工具在同一 immutable 下层语料上比较默认扫描冷/热、第一趟缺索引查询、后台任务收尾、
显式全体准备、重启后的磁盘冷读和随后重复查询（容量内才是内存热读）；每个阶段分别记录 Git requests 与 spawns、
实际内容读取和预取候选数，并校验精确回执相同。文件/行数可设置，参数失败发生在临时
工作区分配之前；句柄先关闭，再清理本次生成的临时目录。

云环境是 overlay，不是路线图基准要求的 ext4；测量是趋势，不代替缺省启用的验收。
历史 live 录制仍保留原请求字节，其工具目录描述已在先前早停小步改变，完整 live acceptance
仍需要真正重新录制。当前 GitHub 集成不能向原 upstream 建 draft PR（403），fork push CI
只跑 fast，不能将它描述为 full/live/隔离全绿。详见[早停的验收边界](search-stop.md)。

### 小语料实测：先保留 opt-in

64 文件 × 64 行，494,345 原字节，三趟中位数，cloud overlay。每次新建同一内容的
仓库；单独重启 Truth/View/lookup 比冷读。这里的“内存热”不是只重跑前一次缺索引查询，
而是先显式把全体 64 个 immutable blob 的索引准备好。准备时间与主查询分开记。

| 模式 | 默认冷 / 热 ms | 首缺索引 ms | 磁盘冷 / 内存热 ms | 后台收尾 / 全体准备 ms |
|---|---:|---:|---:|---:|
| dense | 27.841 / 0.556 | 41.693 | 104.149 / 1.252 | 249.984 / 9607.183 |
| sparse | 18.817 / 5.257 | 30.125 | 196.308 / 0.801 | 151.215 / 8939.534 |
| miss | 26.358 / 6.144 | 37.820 | 94.166 / 0.665 | 144.740 / 6327.422 |

三趟请求数一致：默认冷 dense 5、sparse/miss 6；首缺索引分别 9、10、10，即增加 4 次
Git request。真实 gitSpawns 均为冷 1、热 0，不能把额外 request 描述成额外进程。
准备后的磁盘冷 dense/sparse/miss 请求分别 5/5/4；内存热均为 0。
内容读取默认分别 1/64/64，索引准备后的读取分别 1/1/0，预取数分别 32/1/0。
第一趟 miss 仍读原 1/64/64 文件，没有隐藏默认扫描退路。
后台收尾的额外 Git request 为 0；全体准备 dense 32、sparse/miss 0（后两者此前完整扫描
已把原字节缓存好了）。这些也是成本，而不是免费的准备。

这个结果显示准备后的稀疏/无命中热路径节省读取，同时首 miss、磁盘冷与显式准备有明显
回退。64 条还没有超过默认 256 条 LRU；不能据此宣布 16MB 目标达标或默认启用。
后续可分别优化磁盘解析和 worker/持久化准备开销，再重复同一脚本、同一语料与所有阶段。

### 16MB 级与超容量重复：未达缺省启用门槛

512 文件 × 256 行，16,037,385 原字节，单趟 cloud 趋势。它超过默认 256 条记录的 LRU。
脚本的 `preparedRepeat` 在这种工作集上不是全内存热读：顺序扫描发生 LRU 抖动，sparse/miss
重复趟仍各解析 512 份磁盘记录；统计中 diskHits 与 memoryHits 能区分这件事。

| 模式 | 默认冷 / 重复 ms | 首缺索引 ms | 磁盘冷 / 索引重复 ms | 后台收尾 / 全体准备 ms |
|---|---:|---:|---:|---:|
| dense | 33.271 / 0.438 | 40.960 | 422.334 / 0.615 | 125.510 / 82970.894 |
| sparse | 209.084 / 304.466 | 194.937 | 1766.659 / 1058.554 | 166.042 / 72901.403 |
| miss | 229.577 / 138.162 | 187.475 | 1089.130 / 1069.439 | 21.956 / 72662.699 |

默认冷 dense/sparse/miss 请求 6/10/10；首缺索引 10/14/14，仍额外 4 次 request。
默认重复 sparse/miss 请求 5（8MiB 原 blob 缓存也装不下这份语料）；索引重复请求 0，
但磁盘记录读取不是 Git request，不能因此声称全零 I/O。所有冷趟实际 gitSpawns 为 1，
重复趟为 0。全体准备另花 Git requests 480/508/508，追加 spawns 为 0。
后台收尾的追加 requests/spawns 均为 0。索引准备后 content reads 为 1/1/0。
每个主查询与原扫描的回执仍逐字节相同。

这些数据保留了明显冷退化与容量抖动，**不满足 0.4.0 的冷 <50ms 验收**，也未在 ext4
复验。后续先做测量驱动的小优化，不能直接把默认改开。该次依赖源码核对为
`17bc0a6eac1d76d09656aff2890f16af7dfed434` 的 blob-index/index-format/index-source/index-store/index-worker
内容；基线是同一套 early-stop/adaptive host 的默认扫描，不是旧整树预取。
