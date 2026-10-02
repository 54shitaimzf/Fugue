# Actual all-hit prefetch implementation: one bounded comparison chain

The earlier exact527 no-op fixture establishes only headroom. This file records the subsequently authorized actual source change, with no host/readBytes/prefetch replacement in the benchmark.

- before local source:527319e76a1780e668f47c95f340087a99170564
- after local source:97160db4ca288b91f8df2ac498ba81d6b9d6fd66 (6342a41 plus the original-prefetch-source binding repair)
- Every recorded source hash matches its exact commit; raw/script fingerprints are verified in real-provenance.json. These are local measured fingerprints, not an implied public or later-union full-graph certificate

Same512×32KiB/16MiB corpus hash as the counterfactual. One real scenario chain per backend, no matrix: cold fill; content twice; count/files mode reuse; new pattern; one scoped additional pattern inducing entry eviction; rare replay; dense cold/repeat; fresh plain-default control. Real actions, Truth prefetch and a deliberately selected missing-artifact optional cohort are used. Truth instrumentation is installed BEFORE host construction, respecting the new identity guard. Exact host/readBytes/prefetch slots stay unchanged. Every complete FaceResult is deepEqual across before/after.

| Case | before wall ms | after wall ms | requested prefetch IDs before→after | Git batches before→after | View.read before→after |
|---|---:|---:|---:|---:|---:|
| cold rare fill | 442.067 | 219.871 |512→512|10→10|512→512|
| warm content1 |209.614|13.425|512→0|5→0|0→0|
| warm content2 |222.010|12.495|512→0|5→0|0→0|
| warm count |146.555|11.545|512→0|5→0|0→0|
| warm files |82.909|12.885|512→0|5→0|0→0|
| cold new pattern |157.609|189.357|512→512|5→5|512→512|
| one extra scoped pattern |2.282|1.340|1→1|1→1|1→1|
| rare after entry eviction |147.081|125.373|512→512|5→5|512→512|
| dense early cold |3.506|4.729|32→32|1→1|1→1|
| dense early repeat |0.636|0.288|32→32|0→0|1→1|

All four genuine warm cases have512 hits and0 sourceReads/testedLines, and actual prefetch requests and Git round trips disappear. Metadata stays1,024 per warm query: the readiness pass AND original per-file authority pass remain. Therefore actual11.5–13.4ms is appropriately slower than the prior fixture ceiling5.2–5.3ms; no safety check was inferred away from timing.

Do not attribute442→219ms initial cold timing to the optimization. Both versions perform512 source reads,512 requested prefetch IDs and10 Git batches; after has1,540 metadata calls versus1,536 before. This sequential single-run chain is noisy and before runs first. The new-pattern cold case is a retained regression189.357ms versus157.609ms, with5 additional metadata calls (2,053 versus2,048). Initial/latest cold still exceeds50ms. There is no universal or statistical speed guarantee, no default activation and no physical-IO-byte/RSS claim.

The scoped extra pattern occurs after512 records for each of two patterns fill the1,024-entry capacity. One extra record evicts an old rare record. Sequential rare replay then causes the LRU chain to miss all512 records in both versions; readiness fails open, full original prefetch/read/hash behavior remains, and the capacity bound holds. It is not presented as a beneficial mixed-hit case. Mixed compaction is still out of scope.

Dense x scans stop at the same receipt budget, read exactly one source, prefetch only the original first32 candidates and install no partial verification. Plain-default hosts have verification=null,512 reads and512 prefetch IDs in both versions; plain cold162.064→166.425ms and repeat157.310→110.266ms are uncontrolled samples, not a cache gain.

The implementation is more conservative than the minimum investigation proposal: ALL original pre-filter batch paths must be complete/current before any elision, then the shared4MiB planner applies to the ordered filtered subset. It does not translate a shorter uncached list or broaden original prefix coverage. Original host.prefetch and underlying Truth.prefetchBlobs identities are construction-bound; generation/regex/source/record presence guards remain. Per-file verified consumption still rechecks authority. Source-level race/prefix/byte-bound/eviction gates are separate focused tests run by the source owner/reviewer, not a claim from these timings alone.

This developer artifact changes no product file, performs no provider or remote action, and runs no full suite. Seed/handle construction/close are outside query clocks. Generated ownership cleanup attempts every handle/directory even on failure.

```sh
node tools/bench-all-hit-prefetch.js --before /path/to/527 --after /path/to/97160db
```
