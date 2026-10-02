# Incremental cohort preparation evidence

ROADMAP 0.3.2 now has a source-call proof on the actual Truth/View/M0 path: unchanged immutable IDs reuse complete validated records, while a changed ID alone pays for new source verification. The optional runtime remains off by default. These are paid preparation measurements, separate from the foreground cold-query/default-activation gate.

## Reproduction and comparison

```
node tools/bench-cohort-incremental.js --reference /path/to/prior-checkout --runs 3 --files 512 --lines 256 --profile code
node tools/bench-cohort-incremental.js --reference /path/to/prior-checkout --runs 3 --files 512 --lines 256 --profile mixed
```

The reference uses the complete previous backend from the full-preparation checkpoint, equivalent to canonical `3b7ab88a`; the measured current codec/adapter are local `88113d2` and canonical `6813d89f`. Every Truth, View, M0 log, host, store and lookup module is imported from its own backend checkout. A same-lookup fingerprint is rejected before allocation; its negative control exits 1. The raw artifacts fingerprint both backend module sets and this harness. Later additive test-only changes do not change those runtime hashes.

Each of three pairs has independently generated Git-only repositories and alternates backend order. Code is 16,037,385 bytes; mixed Unicode/emoji/combining/NUL is 15,644,169 bytes. This mixed corpus differs from the earlier full-cohort query corpus, so cross-harness wall times are not causal comparisons. Sources never come from a materialized working tree.

Stages are complete initial preparation, identical preparation, one actual `applyEdit` modification adding an intended new match, rename preserving identity, and reopened Truth/View/M0 sessions with either the original or latest complete prior ID-set hint. Every indexed query equals its current default-off scan and must retain the intended match, including after M0 replay. The generated-fixture creation is excluded. Opening/replay setup, the content modification, ID-set hint gathering, preparation and query are separately recorded. The rename operation itself occurs outside preparation timing and is not separately timed; these figures are not complete edit/rename transaction latency. Fresh means handles in the same Node process; OS page caches remain warm. Receipt verification can warm subsequent source caches.

The current optional bounded prefetch callback and record reuse are measured together. A cold source-call reduction is not claimed: both initial preparations verify 512 blobs. Mutation creates its immutable Truth object through the real edit path, with that cost recorded separately. Cached callback calls, Git requests and Git process spawns are different measurements. Benchmark handles use the reviewed attempt-all, awaited cleanup helper; all generated-directory removals are attempted even after a failure.

## Three-pair medians

Milliseconds of paid preparation; reference/current always produce the same current-View receipts.

| Stage | Code reference | Code incremental | Mixed reference | Mixed incremental | Source calls, reference → incremental |
| --- | ---: | ---: | ---: | ---: | --- |
| Initial complete build | 689.886 | 602.894 | 675.753 | 611.667 | 512 → 512 |
| Same IDs | 544.418 | 73.397 | 576.694 | 70.981 | 512 → 0 |
| One changed ID | 579.536 | 56.547 | 690.688 | 63.731 | 512 → 1 |
| Rename only | 540.571 | 69.904 | 584.070 | 78.665 | 512 → 0 |
| Restart, original hint | 565.143 | 77.143 | 639.989 | 91.758 | 512 → 1 |
| Restart, current hint | 630.886 | 95.687 | 672.418 | 99.341 | 512 → 0 |

All three pairs have these exact source counts. Initial preparation reduces Git requests from 517 to 9, using four immediately consumed batches of at most 128 IDs; each backend starts one Git process. Same-ID/rename incremental preparation has zero source calls, requests, prefetches and spawns. Changed-ID preparation has one source call and one hint; the changed object is already available from the separately paid edit path, so it adds zero Git requests or spawns.

Restart hints read one complete controlled artifact. Their preparation adds five Git requests, with one source callback for the original hint or zero for the latest hint. A Git process has already started during separately paid M0 replay: incremental restart setup medians are 13.203 / 11.729 ms for code and 13.704 / 9.822 ms for mixed (original/latest hint). Do not interpret zero preparation spawns as a process-free restart. A missing or corrupt prior hint instead rebuilds from verified current sources; functional tests cover that fallback.

Unchanged preparation still reconstructs/encodes/publishes a complete cohort and can take 70–99 ms; source-call reuse is not zero filesystem or CPU work. All reused and new source/posting ceilings remain charged. Decode, private record extraction, owned copies, dictionaries and transient reconstruction use additional heap beyond canonical bytes; the logical limits are not RSS limits. Entropy refusal and foreground sparse/dense regressions remain as recorded in the earlier baseline, not certified away by faster paid preparation. No default activation, full/audit, live capture, native migration or release claim follows from these figures.

Raw paired evidence: [code](measurements/cohort-incremental-code512.json), [mixed](measurements/cohort-incremental-mixed512.json). Functional source/QA checkpoint: canonical `6813d89f`, with independent actual-View 14-case proof and focused source controls. Source equality, exact push CI and later acceptance are tracked separately.
