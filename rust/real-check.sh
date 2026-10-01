#!/bin/sh
set -eu
r=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$r"
# This lane deliberately fails if required security layers cannot be installed.
# It never changes kernel/security settings or uses an unsafe host fallback.
t=$(mktemp)
trap 'rm -f "$t"' EXIT HUP INT TERM
cargo test --locked --manifest-path rust/Cargo.toml --test isolation_required -- --list --ignored >"$t"
for name in required_guard_installs_both_native_layers required_new_exact_file_output_succeeds_and_reclaims_safely required_declared_cache_persists_without_becoming_git_content required_outside_write_is_denied_with_no_host_effect required_no_net_action_has_a_private_loopback_only_namespace; do
  grep -q "^$name: test$" "$t" || { printf '%s\n' "Missing required isolation case: $name" >&2;exit 1; }
done
cargo test --locked --manifest-path rust/Cargo.toml --test isolation_required -- --ignored --test-threads=1
