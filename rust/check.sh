#!/bin/sh
set -eu
r=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$r"
t=$(mktemp);m=$(mktemp)
trap 'rm -f "$t" "$m"' EXIT HUP INT TERM
cargo test --locked --manifest-path rust/Cargo.toml --all-targets -- --list >"$t"
grep -q ": test$" "$t" || { printf "%s\n" "Rust test discovery returned no tests" >&2; exit 1; }
cargo test --locked --manifest-path rust/Cargo.toml --all-targets
# Discover every ignored developer lane; only mandatory real isolation is separate.
cargo metadata --locked --no-deps --manifest-path rust/Cargo.toml --format-version 1 >"$m"
lanes=$(node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const p=m.packages.filter(p=>p.name==="fugue");if(p.length!==1)throw Error("ambiguous package");const t=p[0].targets.filter(t=>t.kind.includes("test")).map(t=>t.name);if(!t.length||t.some(t=>!/^[A-Za-z0-9_]+$/.test(t)))throw Error("invalid test target inventory");console.log(t.sort().join("\n"))' "$m")
for lane in __library__ $lanes; do
  if [ "$lane" = __library__ ]; then set -- --lib; else set -- --test "$lane"; fi
  cargo test --locked --manifest-path rust/Cargo.toml "$@" -- --list --ignored >"$t"
  if [ "$lane" = isolation_required ]; then
    grep -q ": test$" "$t" || { printf '%s\n' 'Missing mandatory isolation acceptance cases' >&2;exit 1; }
    printf '%s\n' 'Mandatory successful isolation belongs to rust/real-check.sh, never counted as portable success'
  elif grep -q ": test$" "$t"; then
    cargo test --locked --manifest-path rust/Cargo.toml "$@" -- --ignored
  fi
done
cargo clippy --locked --manifest-path rust/Cargo.toml --all-targets -- -D clippy::correctness -D clippy::suspicious -A clippy::possible_missing_else -A clippy::suspicious_assignment_formatting
cargo build --locked --release --manifest-path rust/Cargo.toml
"${CARGO_TARGET_DIR:-rust/target}/release/fugue" --help >/dev/null
FUGUE_RUST="${CARGO_TARGET_DIR:-rust/target}/release/fugue" sh bin/fugue --help >/dev/null
