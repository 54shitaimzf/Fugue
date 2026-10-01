# 0.4决策证据：暂不接rg sidecar

状态：**仅开发测量，暂不生产接线、不默认启用，不表示0.4验收完成**。
ROADMAP §4要求读数决定rg是否值得引入。本次生成语料说明：原生扫描可能快，但准备
当前View的文件快照远贵于裸rg；而默认regex语义不兼容，不能拿物理工作树作为捷径。

## 可执行来源已核对

使用已安装ripgrep15.2.0，完整可执行SHA256为
`e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849`。
它逐字节等于[官方Linux-musl发行包](https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0)
中的rg；发行包SHA256是`33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c`，
与官方GitHub release asset digest一致。官方签名tag指向
`e89fff89ac9af12e8d4ce9d5fd07beb408ca730f`；探针运行前再次核实际可执行字节，非该指纹拒绝。
没有安装或发布rg二进制，也不把PCRE2开关自动接进产品。每次探针调用使用
`--no-config`，不接受继承的RIPGREP_CONFIG_PATH对输出/引擎/预处理的隐式改写。

## 权威边界与负对照

生成512份文件，内容先入Git，View变更按对象→M0→View顺序记录；物理工作树故意写
`physical_only`，而View是`virtual_only`。rg只读由View.read复制出的独立私有快照，结果
匹配View源文本文件ID参考，永不读物理工作树。物理树后来变更不影响快照；View后来
变更必须视旧快照为旧代并重新捕获。捕获中base/rev变化即拒，不能声明混合代快照有效。

快照探针只接受指定的生成file路径，1024文件/32MiB上限，先捕获密集数字索引路径，不消费调用方自定义迭代器；
拒symlink/缺失/路径逃逸/重复/稀疏项，
写入可见字节的独立副本。目录必须是新建、空、私有、由当前UID拥有。它不是通用
物化API，也不承诺抵御主动同UID目录竞态；部分失败快照由调用方丢弃。Close失败仍需
逐项尝试清理所有已生成目录，单项清理失败不跳过其余目录，最终汇总错误；不把这份派生体持久化成另一份权威状态。

## 读数与兼容性

```sh
node tools/test-entry.js fast src/search/sidecar-snapshot.test.ts src/search/rg-decision-cleanup.test.ts
node tools/bench-rg-decision.js
node tools/check-targets.js
node tools/check-events.js
```

最终一次云overlay读数：16,006,532字节当前View快照561.130ms、1022次Git请求、0次
新Git进程；捕获计时包含View读取、私有文件写入及快照回读参考准备，每趟rg另有1次
进程spawn。dense/rare/miss的裸rg19.296/11.975/10.349ms，把捕获算进去580.426/
573.105/571.479ms。相同源字节上的JS内存扫描14.388/14.834/13.555ms，**内存扫描
与文件系统扫描不是同一档**；不得用这些不同档的比值宣称产品胜出。View改到rev2后
完整重新捕获还花558.685ms、511次Git请求、0次新Git进程，不把更新快照视为免费。
之前快照501.655/562/719.685/2543.463ms也保留在测量记录中，展示共享机器的绝对值波动。
最终运行继承一个排除所有文件的rg配置仍得到完整源参考结果，证明`--no-config`生效。
JSON记录探针/捕获/清理模块的SHA256，便于核对读数源；不是ext4验收。

程序还断言以下兼容反例，不能把失配悄悄当nomatch：

- emoji一整行与`^.$`：JS默认UTF-16是两单元不匹配，rg Unicode是一码点匹配
- `(a)\1`：JS匹配aa，默认rg报不支持backreference（exit2）
- 非法UTF-8字节与U+FFFD：JS解码替换后匹配，rg默认Unicode路径不匹配
- NUL控制：显式text + `\x00`两边一致，仅此不能证明完整regex兼容

决定：**当前不引入透明rg替代/永久sidecar**。以后若评估限定语法加fallback或快照复用，
必须再次核当前View代、所有准备/增量更新/spawn成本和语义矩阵；不能读物理树绕过
Git/M0，不能因裸rg快便提前批准索引缺省或serve。这里没有一等档ext4/完整PR real验收。
