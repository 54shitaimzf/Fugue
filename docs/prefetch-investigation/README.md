# Read-only investigation: redundant prefetch on optional verification hits

Exact source: 527319e76a1780e668f47c95f340087a99170564. This is an investigation, not a product patch. Default optional-index activation stays off and the 16MiB cold <50ms target remains unfulfilled. CLI/diagnostics/UI work is outside this scope. No provider, full-suite run, persistent cache or matrix was used.

## Meaningful headroom exists in one controlled warm case

`probe-hit-prefetch.js` creates one immutable 512-file/16MiB Git corpus and one real concrete host with full actions/Truth prefetch and a selected missing-artifact cohort adapter. One cold query fills complete source-hash-verified records. Four subsequent samples alternate real prefetch and a fixture-only no-op prefetch; readBytes is never replaced. Each sample has 512 real cache hits, no View.read/source verification, and the complete FaceResult equals the cold source scan.

| Warm fixture sample | wall ms | View.stat | requested prefetch IDs | Git batch requests | View.read |
|---|---:|---:|---:|---:|---:|
| real prefetch | 70.086 | 1,024 | 512 | 5 | 0 |
| fixture no-op | 5.321 | 512 | 0 | 0 | 0 |
| fixture no-op | 5.233 | 512 | 0 | 0 | 0 |
| real prefetch | 66.574 | 1,024 | 512 | 5 | 0 |

Cold warm-up took247.549ms. OS caches, host noise and seed/handle construction are not controlled or included; there is no statistical or universal latency claim. The no-op is a counterfactual ceiling on this stable all-hit fixture, NOT a safe shipping decision: no readiness API currently exists. Requested IDs are not actual source-read byte counts, Git requests are batch round trips, and nothing here is an RSS measurement.

## Current contracts do not expose enough readiness

- `hasGrepVerifier` proves only exact host/readBytes binding, not a hit for these paths/pattern
- `grepVerificationStats` is aggregate observation; counts cannot authorize skipping any particular source
- `verifiedGrepMatches` reads a source on a miss, so calling it ahead of prefetch is not a non-loading readiness probe. It would turn cold misses into individual reads and change paid preparation behavior
- `prefetch(paths)` has no pattern argument. Its numeric return is an ORIGINAL ordered-candidate prefix, not a count of hits or a shorter uncached list
- Current concrete prefetch selects a4MiB metadata-sized prefix, including paths that happen to be verification hits. `grepFace` maps that prefix back through candidate-filter holes to the original walk batch; covered0 still forces one original candidate to guarantee progress

Therefore a conditional optimization needs a new private construction-bound, non-loading readiness operation. Public ToolHost fields, Truth/View APIs, model/catalog/event/config/persistent formats need not change.

## Smallest safe first unit: preserve the old prefix, skip only an all-hit prefix

1. Factor a shared ORIGINAL-prefix planner from concrete `prefetchNow`: same current View metadata, original ordering, duplicate/nonfile/invalid-ID treatment,4MiB arithmetic and first-oversized behavior. Do not duplicate its budget arithmetic in execute.ts
2. Cheaply rule out unbound/ineligible/empty-cache cases before extra awaits. Default plain/generic/spread hosts stay byte-for-byte on the existing path. A miss probe must not read/copy/decode/hash any source or install any record
3. For only the prefix that original concrete prefetch would cover, obtain ready records from one synchronous cache snapshot AFTER the bounded metadata await. Every served path must have current file BlobId + native source/flags + a complete EOF-exhausted, hash-verified, admitted record. Cache stats, Bloom candidates and old query results are not proof. No cache record for missing/nonfile/partial/over-budget/g/y/custom regex means unknown, not absence
4. Bind readiness to the exact concrete host, original readBytes, original captured prefetch function and owning View. Capture base/rev; check after every await and again before each cached positive/negative consumption. Native regex/prototype/source/flags must still match. Changed reader, prefetch, generation or pattern falls back to the existing authoritative path
5. If ANY served-prefix candidate is unknown, use original prefetch for the complete original candidate input. Do not individually load misses during planning. Mixed hits deliberately get no optimization in the first unit
6. If ALL served-prefix candidates are ready, skip those source prefetches, return the SAME original coverage length, and consume pinned immutable proofs in original path/line order. Reuse metadata/proofs rather than immediately stat-ing every path again. Do not enlarge a4MiB prefix to the whole128-path batch just because it was cached; if authority changes before fallback reads, legacy source-budget/progress behavior must still apply
7. If a proof becomes stale, never consume a cached negative. Fall back to current authoritative reads; before falling back for a remaining batch, reapply normal prefix coverage if needed. This remains per-file authority, not an atomic multi-file query
8. Acquire ready cache records at one moment, not across a chain of awaited per-path lookups. Pin only one existing bounded prefix (<=128 paths and at most the current2MiB accounted admitted payload, deduplicated by cache record); no persistent second map, no copies of entire sources, and no scanner completion just to populate the cache. Cache eviction after proof capture cannot change an immutable verified record, but it must not relax generation/reader/pattern checks

The all-hit-prefix unit can recover most of the observed warm waste without immediately tackling a heterogeneous prefix-credit protocol. Cold, pressure, dense receipt stops and invalid authorities still follow the old path. The real performance gate includes extra readiness metadata work; the no-op ceiling is not the predicted shipping timing.

## Why mixed-hit compaction needs a separate gate

Let C be the ORIGINAL ordered candidate prefix and U the uncached subsequence with original positions j0<j1<… . A return r from prefetch(U) covers U[0:r], not C[0:r]. If r<|U|, the first unserved original candidate is j_r; only C[0:j_r] has coverage credit from verified cached hits plus the actually served uncached prefix. If r=|U|, the complete planned C prefix is covered. Leading cached hits, filtered walk holes, covered0/first-oversized progress and invalid numeric hints must be translated deliberately.

It is unsafe to advance by the number of uncached paths, by hit-count+covered-count, by the size of U, or across an unserved original miss. Stale hit proofs lose coverage credit after awaits. First ship neither this compaction nor byte-budget credit expansion; prove it independently with an exhaustive small model before considering it.

## Minimal proof plan before any product edit/performance matrix

- Pure planner/prefix model: empty/all/mixed/leading-hit bitmaps, filtered walk holes, exact4MiB boundary, first-oversized coverage0, invalid/fractional/negative/too-large coverage, stable progress and no skipped/duplicated original paths
- Non-loading readiness: miss/unknown does zero read/copy/hash/install; partial content/files_with_matches and capacity refusals do not become ready; LRU eviction between metadata awaits is handled from one bounded cache snapshot
- Exact ownership: wrong/spread/wrapped host, replaced readBytes/prefetch, different View, SHA1/SHA256 alias/rename/perms, pattern source/flags/native-prototype changes all fail open
- Await attacks: mutate View base/rev or reader after metadata and before cached-negative consumption; assert current source result/read occurs, never stale absence. Preserve per-file semantics and original fallback prefix budgets
- Receipt parity: complete FaceResult equality for content/count/files modes, dense early stop, UTF8/CRLF/NUL/empty/trailing blank; no source work past the normal prefix or just to warm a cache
- One final527-derived before/after all-hit fixture plus one cold/new-pattern, one partial-hit/evicted-record and one dense-early control, with real actions/prefetch. Charge wall/first yield, metadata, requested/actual eligible prefetch prefix, Git batches, View reads and source/hash installs. Only then consider a broader matrix

The existing generated probe already establishes that the ceiling is worthwhile. Product implementation, gate execution and broader benchmarking need a subsequent scoped task; they are not silently performed by this investigation.

## Subsequent scoped source comparison

A separately authorized implementation now has a real-source comparison in real-chain.md / real-chain.json, with exact527→97160db fingerprints. The earlier no-op probe remains a historical ceiling. Actual source keeps both readiness and per-file authority checks (1,024 warm metadata calls), skips all actual warm prefetch IDs/Git batches, and retains cold/new-pattern/eviction/dense/default costs. No giant matrix or product edit was added by the measurement artifact.
