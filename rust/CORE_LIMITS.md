# Core port: verified behavior and intentional limits

The Rust product does not call Node. `tests/core_oracle.rs` is an explicit,
opt-in developer differential check using the unchanged upstream Node 24 code.
Run it with `cargo test --test core_oracle -- --ignored`.

## Preserved semantics

- Existing Git object store; plumbing commands only, with no writes to HEAD,
  index or the user worktree. Blob/tree/commit/ref formats are Git-native.
- `round` maps to `refs/heads/main`; other writers map to their named branches.
  Branch creation is compare-and-swap and idempotent at the same base.
- Journals remain `.fugue/log/<writer>.jsonl`, with flattened event envelopes,
  monotonically increasing per-writer `seq`, and CRC32 of canonical JSON without
  `crc`. Canonical formatting follows JavaScript numbers and UTF-16 key order.
- Reads ignore only an unterminated tail and never create, lock, truncate or
  repair journal storage. Appends validate every complete row before writing,
  then remove only the incomplete tail. Complete corruption is an error.
- File, executable file, symlink and Gitlink trees retain Git-native modes.
  Virtual reads return symlink target bytes without following the link.
- Upper changes and tombstones overlay the writer's current branch base.
  Removing a directory and recreating a child does not revive its siblings.
  Diffs retain the operation sequence, not merely the final net difference.
- Rename/chmod of lower-only content first pin its bytes to history. Checkpoint
  advances its ref by CAS before recording `ckpt/commit`, as upstream does.

## Stronger defensive behavior

Complete rows reject duplicate JSON keys, mismatched writer names, noncontiguous
sequence numbers, invalid CRCs, unsafe paths, and noncanonical view-event modes.
View mutations reject stale state after taking the writer lock. Storage access is
anchored by directory descriptors; symlinks, hardlinked log files, FIFOs and
nonregular log files are rejected. Writer locks combine atomically published
upstream-compatible owner records with kernel locks and inode-checked release.
Nested writers acquire both the intended lock path and the upstream implementation's duplicated-prefix legacy lock path, so mixed-runtime mutation stays mutually exclusive. Takeover requires proof of a dead owner using boot ID, PID and process start time.

Git subprocesses use a cleared environment, fixed identity, disabled hooks,
fsmonitor, automatic GC, prompts, signing and network protocols, bounded pipes,
and a bounded execution time. External text/filter helpers and configured custom
merge drivers are refused; built-in three-way text merges remain available.

## Limits and crash boundaries

- This implementation targets Linux/Unix and uses `/proc` and kernel `flock`.
  Linked-worktree `.git` files and bare repositories are not supported.
- Non-UTF-8 names/targets, protected `.git`/`.fugue` path segments, NUL targets,
  malformed historic events and unsafe/noncanonical modes fail explicitly.
- There are bounded 64 MiB object/pipe/journal budgets, 1,000,000 event/entry
  budgets, and bounded paths, JSON nesting and subprocess duration.
- Trees are loaded as a bounded full leaf map, not the upstream lazy tree/cache
  implementation. Stat/list sizes use one bounded metadata-only cat-file batch
  and an8,192-entry immutable per-handle cache; blob bodies are not read for size.
  There is no long-lived cat-file or persistent snapshot acceleration. Full
  journal replay remains authoritative, including complete old-row validation.
- SHA-256 repositories are supported for Git objects and upper symlink IDs,
  correcting the upstream view's SHA-1-only upper-ID computation.
- Directory rename and edits to Gitlinks are explicitly unsupported, matching
  the upstream view boundary. Reading/statting existing Gitlinks is supported.
- A fsynced multi-event batch preserves complete-prefix crash semantics. It does
  not promise that several events survive a power loss all-or-none. All normal
  validation occurs before any row in the batch is appended.
- Git refs and journal files are separate durable stores. Preflight catches
  ordinary envelope/capacity failures before checkpoint CAS, but an I/O failure
  after successful CAS can still leave an advanced ref without a durable
  checkpoint row. The error explicitly reports this state; the implementation
  does not claim cross-store atomicity.
- Read-only callers can observe different writers at different instants; merged
  ordering is deterministic for the rows read, not a globally atomic snapshot.
- Git control-plane roots, objects/refs/logs/info directories and critical files
  are revalidated before every plumbing command. Symlinks/special files,
  shared mutable control files, external alternates/commondir/grafts and config
  includes are refused; normal packed and SHA-256 repositories remain supported.
  Filtered hash requests are refused and merge renormalization is disabled.
  This is not a filesystem sandbox around Git; concurrent same-UID metadata
  replacement between validation and Git's later access remains outside the
  guarantee. Safe ref CAS does not authenticate journal contents.
- Relative paths and writer IDs have at most128 components. Merged replay has
  a total64 MiB physical journal budget, including ignored partial tails.
  Canonical JSON streams into a bounded buffer and has a total1,000,000-node
  budget. Configuration input and serialized output both have a1 MiB limit;
  oversized edits are refused before replacing the prior configuration.
