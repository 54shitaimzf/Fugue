# 0.2.8 阅读面显示小批

## 开工前观察（2026-10-01）

基线：`951597962e0febb04334322a4777a272dffd8c6c`。依据：路线图 0.2.8，只改纯渲染层，零数据路径、零规格改动。以下是实现者用已有 `StatusRow` 形状构造的显示夹具，不是用户反馈。

在云桌面的 Xfce Terminal 真终端上目视检查了 60 列、18 行的 `frameOf` 输出：

- 长改名的坐标与旧路径占满一行，新路径完全不可见；上下翻行也看不到被 `cell` 截掉的后半段
- 契约写入面只有前三条，第四条路径被省略；正文先压成一行并截到 160 列，再被框宽截一次，段落与尾部要求都看不到
- 阅读面展开后顶框仍写「处境 / 读数」，与正在读的整幅正文不匹配；标题与正文同一强度，最新永久行在账尾与框线一起变暗

例如改名输入：`src/really-long-component-name/旧路径/é-👩‍💻-implementation.ts` → `src/really-long-component-name/new-name-with-important-suffix.ts`。契约输入有四条路径和超过 160 列的两段正文，尾部为 `FINAL_REQUIREMENT: verify the fourth path.`。基线屏幕只有 `agent/r1/implementation 1 · 改名 src/really-long-componen…`，契约正文只有 `正文 First paragraph: preserve exact paths and test beh…`。

## 本批定稿

1. 把已有 diff 两端与契约各条路径、正文原文排成可阅读的行，不读 blob，不把「写」猜成 add/modify
2. 一把纯函数折行尺供显示与翻行共用，按显示列与完整 Unicode 簇断行；原有上下键、翻页、首尾、Esc 行为保持
3. 阅读面顶框与标题明确层级；只用黑白 SGR 属性，无样式、NO_COLOR、管道历史保持现有退回规则
4. 保留阅读面的有界行数与显式遗漏提示，不另建程序快照出口

## 验证

### 自动断言

- `node tools/test-entry.js fast src/ui/read.test.ts src/ui/frame.test.ts src/ui/theme.test.ts src/ui/stage.test.ts src/ui/term.test.ts`：43 / 43 通过
- `node tools/test-entry.js fast src/ui/follow.test.ts`：11 / 11 通过
- `node tools/test-entry.js real src/ui/terminal-exit.test.ts`：6 / 6 通过，包括真实 PTY 的正常退出、信号退出、坏日志退出与缺 ALT_OFF 负对照
- `node tools/check-events.js`、`node tools/check-targets.js`、`git diff --check`：通过
- 把本批五份测试单独放到原始 `9515979` worktree，同一 focused 入口退出 1，43 条中 8 条红：长 diff / 契约、显示行上限、控制字节、物理行滚动与 resize、阅读标题/遗漏数、黑白主题分别有能红的对照

正文空格、空段、标点保持；控制字节显示为 `\uXXXX`，不允许正文改变终端光标或注入 SGR。一列放不下的宽簇用明确的 `…` 代替。显示与按键滚动共享 `faceRowsOf` 的宽度排版，不改读面折叠、事件模型、键表或退出流程。

### 目视与 PTY

使用已有公开纯函数加临时夹具在 Xfce Terminal 中真打印，目视检查基线 60 列、修改后 60 列与 40 列（18 行），以及契约从显示行 12 开始的正文尾部。改名的「从 / 到」两端能读到；第四条路径可见；长正文保留两段，在 40 列中能翻到 `FINAL_REQUIREMENT: verify the fourth path.`；框名是「阅读面」，标题与最近永久行加粗、框线暗一档。英文正文在空格后折行，长路径按簇硬折；单/双栏原处境页仍使用原有布局。临时夹具经 `script -q -e -c 'node <临时夹具> <worktree> 40 12' <临时记录>` 在真实 PTY 运行，退出 0。不把这些临时输出做成产品快照接口。

字体限制另列：本环境 Xfce 字体把 `👩‍💻` ZWJ 序列画成分开的两个 emoji，而既有 `glyph.ts` 的声明近似把整簇算两列。自动测试证明完整簇与列宽模型一致，**不等于**证明所有终端字体的 emoji 几何一致。本批不改共用 Unicode 量尺的既有语义；CJK 与组合重音在该终端可见对齐。

### 聚合验收边界

本环境的 fast 聚合尝试：593 条中 587 通过、6 失败。失败是四路挂载不可用（期望 4 实际 0）、工作区 overlay 不等于 ext4，以及四份文件的 Node test runner cloned-data 反序列化异常（本批 read focused 通过）。full 聚合已启动，真实沙箱测试报 `NETLINK_ROUTE socket: Operation not permitted`，在确认与基线同类环境限制后中止（退出 130，未完成）；保留原始日志。**这里不宣称路线图要求的 fast + full 双绿，也不把 0.2.8 标成正式验收完成**；应在符合架构基线的主机 / CI 上复跑聚合。
