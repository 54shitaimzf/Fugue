# Fugue Rust

原生产品的构建与使用入口见 [../README.md](../README.md)。Rust 1.85+，Linux；开发差分测试另需 Node 24。产品运行不需要 Node。

```sh
cargo build --release --locked --manifest-path rust/Cargo.toml
cargo install --path rust --locked
sh rust/check.sh
sh rust/real-check.sh
```

check.sh 是 portable 原生 + 全部显式 Node oracle + correctness/suspicious Clippy + release/CLI 验证。没有发现测试会非零退出。real-check.sh 单独要求实际成功安装所有隔离层与执行动作；缺能力必须失败，不自动略过。

[COMPATIBILITY.md](COMPATIBILITY.md) 列完整覆盖和差异，[VERIFICATION.md](VERIFICATION.md) 给实际结果，[CORE_LIMITS.md](CORE_LIMITS.md)、[SANDBOX_PORT.md](SANDBOX_PORT.md)、[MODEL_PORT.md](MODEL_PORT.md) 给模块的准确边界。源码采用要求的密集布局，测试和审计说明保持可检查；不使用 cargo fmt 作为本次验收门。
