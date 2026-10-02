# PR45 review checkpoint and remaining gates

This is a finite review summary for the optional implementation on [PR45](https://github.com/54shitaimzf/Fugue/pull/45), not a release or a completed-roadmap claim. The reviewed source is [9a5aba19](https://github.com/StevenLi-phoenix/Fugue/commit/9a5aba19f1bdeb275ab48799fa6c88d236c40ae3), tree `a51d2182aa8a4414d6d673e2f880749c6f8b9a31`, with official main `f271ad2fd6dc64e26bfa6a7d8a28d3f8d7c00ad5` in its ancestry. Later documentation heads need their own CI result; this source certificate stays tied to 9a5.

## Implemented optional candidates

The branch supplies blob/cohort format and storage, complete current-View candidate intersection, incremental preparation that reuses unchanged immutable IDs, conservative mandatory regex facts, complete source-bound regex verification, and whole-original-candidate prefetch readiness. Unknown, missing, corrupt, stale or over-budget derived information falls back to the native scanner. Default hosts retain their existing scanning path. These are review-ready 0.3.1–0.3.3 candidates; maintainer acceptance of the stations and default activation are separate decisions.

The persistent functional witnesses are [cohort format](../src/search/cohort-format.test.ts), [incremental preparation](../src/search/cohort-incremental.test.ts), [real View/cohort queries](../src/tools/cohort-acceptance.test.ts), [real incremental source counts](../src/tools/cohort-incremental-acceptance.test.ts), [source-byte ownership](../src/tools/truth-source-ownership-acceptance.test.ts), [native regex cache receipts/default-off](../src/tools/grep-verifier-acceptance.test.ts), [complete prefetch readiness](../src/tools/grep-prefetch-acceptance.test.ts), and [minimum-one repetition](../src/tools/min-one-literal-acceptance.test.ts). The existing [full job](https://github.com/54shitaimzf/Fugue/actions/runs/37059091222/job/111010954728) passed fast 1015/1015 and real 232/232 on the exact source graph. The [upstream fast job](https://github.com/54shitaimzf/Fugue/actions/runs/37059091222/job/111010954367) and [fork fast job](https://github.com/StevenLi-phoenix/Fugue/actions/runs/37059084932/job/111010935157) also passed; audit was skipped, not certified by these runs.

## The cold/default gate remains open

The [existing-runner diagnostic](ci-cold-diagnostic.md) and its [exact report](ci-cold-report-9a5.json) cover two order-reversed laps on the approved 512-file, 16 MiB corpus. The PR checkout was merge commit `7fd3fc5ac7de2c50825859982805873e2c649ced`, with parents official f271 and PR head 9a5. Its tree equals the reviewed source tree. All 161 production module hashes and the test hash matched; checkout, fixture, Git objects and artifact each reported statfs `0xef53` corroborated by findmnt `ext4`.

| Pattern | Lap | Default scan ms | Prepared optional ms |
|---|---:|---:|---:|
| Sparse `rare(_hit)+` | 0 | 174.340 | 101.144 |
| Sparse `rare(_hit)+` | 1 | 151.381 | 56.323 |
| Dense `dense_hit.+` | 0 | 29.695 | 52.923 |
| Dense `dense_hit.+` | 1 | 21.350 | 47.299 |

Seeding cost 2358.254 ms and complete preparation 627.851 ms are separate from these query times; each sample also records its own handle setup cost. Full FaceResults agree. Optional queries read one prepared artifact, build no sources, and verify one real source; all 512 eager information checks remain. Sparse reaches EOF and installs one proof, while dense stops early and installs none. Sparse native Git requests fall from 10 to 6; dense keeps 6. The dense default scan is faster in both laps.

Cold here means new Truth/Log/View/RefHead/store/index/host/verifier handles in the same Node process. Imports, JIT and OS caches are reused after paid seed/preparation; no disk cache was dropped. Hosted-runner trends under [ROADMAP §2](https://github.com/54shitaimzf/Fugue/blob/f271ad2fd6dc64e26bfa6a7d8a28d3f8d7c00ad5/design/ROADMAP.md#L28) are not first-grade architecture constants. Sparse exceeds 50 ms in both laps and dense regresses, so [0.4.0](https://github.com/54shitaimzf/Fugue/blob/f271ad2fd6dc64e26bfa6a7d8a28d3f8d7c00ad5/design/ROADMAP.md#L89) default indexing remains unapproved. Before activation, the acceptance workload and cold-cost boundary must be agreed and satisfy the official target on the required measurement host; another local optimizer is not justified by this certificate alone.

## Cost accounting is partial

The [derived call ledger](call-ledger.md) reads existing `llm/call` records and preserves model-call usage, source positions, known status/attempt fields and unknown values. Its [persistent tests](../src/probe/call-ledger.test.ts) and [snapshot refusal/cleanup controls](../src/log/stream-acceptance.test.ts) cover that current scope. It does not complete the 0.3.0 per-tool cost goal: tool elapsed time, argument bytes and receipt bytes are `null`; unrecorded detour/retry consumption and monetary cost are unknown. Model-call tokens cannot be allocated to individual tools, and `run/end.ms` cannot supply missing read/grep timings.

The next decision is the approved ruler and event shape for these facts: units, attribution, start/end and failure boundaries, and replay treatment of absent values. The frozen event union must be reviewed before recording new facts. A developer report does not authorize an event expansion or turn absent costs into zero.

## Serve and later native work

[ROADMAP §5](https://github.com/54shitaimzf/Fugue/blob/f271ad2fd6dc64e26bfa6a7d8a28d3f8d7c00ad5/design/ROADMAP.md#L100) requires three design approvals before dependent implementation:

1. How a serve-held log relates to the single writer and `round.lock`
2. The event interleaving shape for parallel tool execution
3. The single-tree serial fork model: one materialized tree, queued use and reset ownership, with native Windows as the first service target

PR23 is approval input, not an approved implementation. Protocol freeze and client lifecycle follow these decisions; the visual refactor remains at 0.4.3 after serve. This checkpoint supplies none of these approvals.

The gix read-path/core batch is explicitly later [1.0.1](https://github.com/54shitaimzf/Fugue/blob/f271ad2fd6dc64e26bfa6a7d8a28d3f8d7c00ad5/design/ROADMAP.md#L129), with TS fallback and whole-workload spawn/equality evidence. The current cold shortfall does not authorize moving it forward, adding a native dependency, or replacing the TS path. Merge, release and default enablement remain human decisions.
