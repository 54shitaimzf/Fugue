# Fugue · 原生 Rust 重构

基于 [54shitaimzf/Fugue](https://github.com/54shitaimzf/Fugue) 的独立 Rust 分支。产品实现位于 `rust/src`，`bin/fugue` 默认启动 Rust，可用 `cargo install --path rust --locked` 安装。原 TypeScript 源码和测试保留作兼容性对照，产品运行不启动 Node；旧入口为 `bin/fugue-node`。

## 构建与使用

需要 Rust 1.85+、Linux、Git。实际动作执行还需要 bubblewrap、可用的用户/挂载/PID 命名空间、Landlock ABI 6+ 与 seccomp；模型联网传输使用 curl。安全层不满足时，动作明确拒绝，绝不降级到宿主执行。

```sh
cargo build --release --locked --manifest-path rust/Cargo.toml
./bin/fugue --help
./bin/fugue --root /path/to/project status --once --metrics --report
./bin/fugue --root /path/to/project tui
```

给 `FUGUE_RUST` 指定已构建二进制可覆盖入口路径。`say` 默认仅记录消息，`round run` 默认使用确定性离线桩；只有显式 `--live` 才调用真实模型并可能产生费用，`--wire-in` 是严格字节匹配的离线回放。

## 已实现的产品主线

- Git 原生对象、引用 CAS、兼容 CRC32 JSONL 事件账；读观察不建目录、不修日志
- 独立视图读写、改名、权限、修订、提交；不借用户索引，也不直接改工作树
- 12 个原工具 schema、契约所有权与批准门、原生有界 grep/glob、隔离动作与声明产物回收
- OpenAI Chat / Anthropic Messages 的 DeepSeek 方言、严格 SSE、稳定 A/B 与动态 C、自动 handoff/restart/校准、持久会话和工具回执恢复、提供方重试
- implement / investigate / resolve 契约、实际种子内容预算、宽松/严格预检、证据隔离、Git 冲突解决/refold、验收重试、漂移保护、工作树推进 WAL 与恢复
- 八项指标、打回三数、归因、逐调用账、完整状态投影；原生交互/全屏 TUI、编辑器、面板、批准确认与终端状态恢复
- 两级配置、严格 JSON/路径/大小预算、fd 锚定存储、防软链/硬链/特殊文件穿越、明确错误与保守拒绝

源码按照本次要求使用密集布局和短私有标识符；这不是可证明的“可读性为 0”指标。正确性、安全性、测试与审计材料保持优先。

## 验证与实际限制

```sh
sh rust/check.sh
```

原生测试和独立 Node 差分均不调用真实模型、不读取用户凭据。精确结果、最新上游基线与未完成项见 [rust/VERIFICATION.md](rust/VERIFICATION.md)、[rust/COMPATIBILITY.md](rust/COMPATIBILITY.md)。不要把源码迁移进展或“拒绝测试通过”解释为全量兼容验收完成。

本容器真实 guard 探针以126拒绝（Landlock ABI6不可用），独立 bwrap 探针以1拒绝（NETLINK_ROUTE权限被拒）。成功隔离执行、产物回收、缓存及网络分支尚需在具备相应能力的 Linux 主机复验；没有改变宿主安全配置来绕过限制。macOS/Windows 没有原生动作后端。

原版说明保留在 [docs/UPSTREAM_README_09e5917.md](docs/UPSTREAM_README_09e5917.md)，MIT 许可证及原作者版权保留。此次发布目标为用户的既有 GitHub fork 独立 rewrite/rust-defensive 分支。远端提交、CI 的最终结果以交付报告为准。
