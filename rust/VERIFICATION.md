# Verification record · 2026-10-01 UTC

Native implementation source is complete for the documented functional scope. **Portable verification passes; strict successful isolation acceptance is blocked by this host.** This is not a claim of full platform/performance/vendor equivalence or certified successful sandbox execution.

Branch: rewrite/rust-defensive. Initial upstream:09e591713db066a3b899daea16d4b9492742f5ff (0.2.1). Latest comparison:633a6b2fb63da459074f1077f92ac8fbfc839416 (0.2.3). Implementation revision5b85c59e509ea3a7c21be48aacc350e1b71f434a passed the literal archive gate. The deliverable CHECKPOINT.txt also identifies the documentation-only delivery revision. The later defensive extension and authorized fork publication are described in HARDENING.md and the delivery CHECKPOINT.txt; no upstream PR/merge/deployment is authorized.

## Delivered checkpoint portable gate

Run `sh rust/check.sh` against the literal Git-archive checkpoint source with a separate Cargo target directory. The gate rejects zero discovered tests, runs all native targets, explicitly invokes every ignored Node differential lane, runs Clippy correctness/suspicious checks, builds the release executable and smoke-checks help/primary Rust shim.

Original delivered checkpoint counts, parsed from its immutable gate log:

- library/unit32
- CLI9; contracts11; core22
- final integration review7
- materialization11; topology13
- model/assembly13; model recovery14
- diagnostics11; round E2E22; round/transaction14
- sandbox/tools19; conversation sessions6; UI26
- Native total230
- Explicit Node differential checks14: core5, contracts1, diagnostics1, round fold1, latest UI2, conversation1, materialization1, latest topology1, fractional canonicalization1
- Portable total244, no test failures
- Five positive-isolation tests remain ignored in the portable lane and are explicitly run in the separate strict real lane below

Clippy command: `cargo clippy --all-targets -- -D clippy::correctness -D clippy::suspicious -A clippy::possible_missing_else -A clippy::suspicious_assignment_formatting`. The two allows concern the requested dense formatting. Other style/performance warnings remain; this is not unrestricted warning-free Clippy. `cargo fmt --check` is intentionally outside acceptance because the user requested dense low-readability source. Tests, evidence and reports remain inspectable.

Environment: Linux x86-64 container/overlay, Rust1.98.1, Node24.19.0, system Git/bubblewrap/curl. Metadata-only batched object sizing and fixed version probes are bounded; no performance number measured here is advertised as an ext4 benchmark.

## Strict real lane: verified failure/blocker

`sh rust/real-check.sh` explicitly invokes all five positive acceptance cases. Actual outcome: **0 passed,5 failed**, at the required native guard availability check. Guard exits126: Landlock ABI6 unavailable. Independent bwrap namespace probe exits1: `NETLINK_ROUTE` operation not permitted.

The five cases require actual security-layer installation, isolated action and new exact-file reclaim success, declared cache persistence without Git import, outside-write refusal, and no-net enforcement. They do not accept a missing capability as success and do not silently skip. No eligible alternative computer/saved environment was available when the parent rechecked.

No kernel/security setting, sudo privilege, unsafe host fallback or external network/model call was used to change these outcomes. Successful action/reclaim/cache/network paths need re-verification on an eligible Linux host before final isolation acceptance. Portable refusal tests prove actual refusal/no side effects, not installation success.

## Defensive and differential evidence

Coverage includes malformed/duplicate JSON; JS-safe integers/fractional CRC; partial-tail versus complete corruption; special/hardlinked/symlink storage; stale views and mixed-runtime writers; checkpoint permission faults; invalid IDs/ref/tree/parents; ownership and approval digest+round binding; Idle-understanding/foreign-draft refusal; no inherited doctor PATH/secrets; strict streaming/truncation; cumulative cap and exact initial binding recovery; missing credentials with zero outbound intents; uncertain effect refusal; interrupted response/tool receipts; bounded all-or-none normal projection preflight and crash-prefix idempotence; exact replay request bytes/retries; handoff branch preservation; partial retry/resolver generations; deliverable checks and evidence exclusion.

Topology tests include20 distinct injected crash-prefix/direction combinations (2 shapes×5 prefixes×2 recovery directions), Git-normalized modes, restored directory permissions, no-follow existing outside symlinks, preserved/untracked/edited descendants, complete preflight, malformed directory WAL and same-ref CAS. Materialization checks include both strategies' five publication phases, COW provenance/detachment, partial apply recovery and explicit fallback.

Real PTYs verify key/paste decoding, wide/emoji wrap boundaries, visible caret, Ctrl-O folding, approval race/round changes, no-style/NO_COLOR controls, cancellation, corruption/error/unwind and quit/Ctrl-C/SIGTERM restoration. The nonblocking test writer handles partial writes/EINTR/EAGAIN with a strict deadline; failed writes are never discarded.

Standalone Node oracles use unchanged upstream source or exact SHA-pinned 0.2.3 fixtures. They run from an archive without a .git directory or network access. Product source has no Node process bridge. Actual model calls/credentials/fees remain zero.

## Upstream baselines, unchanged in separate source trees

- Initial0.2.1: `node tools/test-entry.js fast` reports467 tests,459 pass/8 fail
- Latest0.2.3: same official entry reports530 tests,523 pass/7 fail

Failures include the Node24.19 test IPC-deserialization defect, actual isolation/cleanup restrictions, and overlay rather than required ext4. They were not patched or counted as Rust passes. The upstream all/real lane is not claimed passing. CI evidence must be read for the exact published extension commit; the prior checkpoint had no remote workflow run.

## Delivery boundary

Archive includes complete source, Git bundle, base-relative patch, Linux x86-64 release executable, full checksums, license notices, compatible fixtures and logs of portable/strict-real/original baseline runs. See COMPATIBILITY.md for persistent-overlay/lazy/snapshot limits and stronger safety behavior. Source completeness and portable success do not remove the explicitly blocked isolation acceptance.

## Additional defensive extension

See HARDENING.md for reproduced failures, safeguards and stronger compatibility limits. The final delivery CHECKPOINT.txt and evidence logs record the extension's exact native/oracle counts, immutable implementation revision, fork branch/commit and actual CI state. A passing portable extension gate does not replace the five blocked positive-isolation cases.
