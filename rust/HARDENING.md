# Additional defensive review · 2026-10-01

This pass follows the delivered a1299cf/5b85c59 checkpoint. It addresses reproduced gaps and explicit resource bounds; it does not certify immunity to every attack. All model/protocol checks use offline recordings or harmless local subprocesses. No real provider request or credential was used.

## Changes and regression evidence

- Protocol decoders are permanently poisoned after any parse/state failure. Role, envelope, tool-kind, usage consistency, outbound history and assembly shapes reject malformed values instead of coercing them.
- HTTPS uses curl with URL globbing disabled, stdin-only credential configuration and a cleared environment. The parent independently pumps nonblocking input/output, bounds bytes and wall time, kills the process group before reaping and refuses malformed HTTP framing. Child lifecycle tests cover stalls, large input/output, errors and background descendants.
- Wire evidence uses an exclusively created no-follow private call directory. Partial, pre-existing, symlinked or dangling evidence cannot be overwritten and malformed checksum markers refuse replay.
- Git metadata is checked before every plumbing call. Objects/refs/logs/info symlinks and special files, shared mutable control files, foreign alternates/commondir/grafts and config includes refuse. Filtered hash requests accept no extra options, including Git's abbreviated long options. Merge renormalization is disabled; safe packed and SHA-256 repositories still work. Config failure text does not echo arbitrary Git values.
- Canonical JSON uses a bounded streaming buffer and total node budget, preserving JavaScript float/UTF-16 behavior. Merged journal replay bounds all physical bytes, including partial tails, and counts directory names/entries. Writer IDs and virtual paths have a128-component ceiling.
- Configuration input and serialized output are both limited to1 MiB. Pretty output is streamed into a bounded buffer and reparsed before publication, so deeply nested keys/values cannot poison subsequent reads. Failed validation preserves prior config/history. Invalid mutation leaves/parent traversal refuse before creating prefixes; operation locks reject hardlinks and special files.
- One bounded symlink-graph implementation checks composed escapes, cycles and protected targets. Merge also lazily checks actual unchanged/preserved/untracked disk links without following them; replacing an unsafe old link and safe dangling links remain supported.
- Materialization, reclamation, cleanup, argv/environment, receipts and edit expansion have combined bounds. Success and error paths clean background process groups. Entry accounting includes directories and verifies directory identity before cleanup.
- WAL replay rejects orphan/duplicate/reused transaction receipts and reserves terminal capacity before mutation. Session receipts and version chains validate duplicates and empty understanding. Interrupted intent publication and later planning resume only the same pinned goal. A changed overall goal needs a new round; drafts/output plans may still change under the original goal.
- Candidates bind immutable worker checkpoints, and replay refolds from completed evidence. Forged candidates, stale worker/resolver stop receipts and missing conflict provenance refuse. Legacy conflict replay without enough immutable evidence requires review instead of guessing or invoking a new model call.
- The portable gate discovers all ignored developer lanes; the strict lane asserts that all five named positive isolation cases exist before executing them. An accidentally missing acceptance case cannot produce a zero-test success.

Failure-first proofs and final focused/aggregate logs are included in the private delivery evidence. Final counts, exact local/remote revisions and SHA256 checksums are in CHECKPOINT.txt. Native CI runs the portable gate only; the legacy TypeScript job is skipped on Rust rewrite branches so its runner-security setup is not invoked there.

## Boundaries

Mandatory successful isolation still needs an eligible Linux host. This container lacks usable Landlock ABI6 and bwrap NETLINK capabilities; the five positive cases remain failing acceptance, not silently skipped proof. No kernel/security switch or unsafe host fallback was used.

Git and final filesystem validation are not a sandbox against another malicious process running under the same UID that races between validation and access. CRC/checksum chains detect corruption and semantic inconsistency, not cryptographically authenticate an attacker-writable journal. Configuration/journal/cache/ref stores retain their documented cross-store I/O crash boundaries. Successful live-provider interoperability and macOS/Windows backends remain unverified/unsupported as documented.

## First published CI portability correction

The first native GitHub run on Ubuntu24.04 rejected the default systemd resolver alias while running the doctor secret/PATH regression. The correction accepts only /etc/resolv.conf itself and the three documented systemd files (/run/systemd/resolve/stub-resolv.conf, /run/systemd/resolve/resolv.conf and /usr/lib/systemd/resolv.conf). This exposes one bounded, public-readable, system-owned regular DNS configuration file and never grants a /run directory. Private /etc aliases and an alias into a different/undeclared /opt toolchain refuse. Owner checks use the observed /usr system owner, including mapped container UIDs. Eight new pure/real-workspace policy regressions and the doctor regression verify these conditions.

References: [Ubuntu networking](https://ubuntu.com/server/docs/explanation/networking/configuring-networks/) and [upstream systemd resolver modes](https://github.com/systemd/systemd/blob/main/man/systemd-resolved.service.xml). No kernel/security switch or namespace, Landlock or seccomp requirement changed.
