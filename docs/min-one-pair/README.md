# Actual minimum-one `+` source pair

Exact before `ede5443c03b4841df7a0927935fdf1144b5257ad`, after local frozen `96c7010f4125fccf1c3b496bff41418552952bf0` (tree `588226e9cd6231506646ff7fbcf31d21a42782c8`). Only imported regex-literal.ts differs. Declined tree-name indexing is absent from both graphs; these historical/local source hashes are not a later public union certificate.

```
node tools/bench-min-one-paired.js --before /path/to/ede --after /path/to/96c > /tmp/min-one-paired.json
```

One tiny native code corpus:512×32KiB=16MiB, same approved corpus and466,926-byte prepared artifact (SHA25613ecfb7b…). Each case has one fresh query and one memory repeat; before/after order alternates across cases. Both sources share the immutable corpus/artifact. Truth/View/host slots remain fully native; observations are external stats. Every complete `{ok, output}` is deep-equal to the plain/default before-host reference, including dense truncation. Imports and distinct-source/unrelated-module checks precede temp allocation; handles/roots use attempt-all primary-error-preserving cleanup.

| Fresh query | before→after ms | verified source reads |
|---|---:|---:|
| `rare(_hit)+` |220.48→76.92|512→1|
| `rare.+hit` |147.04→39.70|512→1|
| dense `dense_hit.+` |24.29→58.47|1→1|
| unsupported `rare\|absent_needle` |135.04→154.12|512→512|

Selective queries still compile and execute the original regex over real source bytes. Their line tests131,584→257 and Git requests10→6. Each after query performs five bounded candidate-filter calls, one controlled artifact read and one complete source hash/EOF verification. Eager object info misses/entries remain512 for every fresh query. Aggregate Truth info hits1540→1027 are listing/stat cache observations, not direct View.stat call counts. Native reader/generation authority is unchanged.

Group-plus memory repeat32.95→2.31ms, dot-plus9.90→0.95ms; all repeat source reads and Git requests are zero. Aggregate repeat info hits1024→7. This selective mechanism does not justify blanket/default gains.

Dense control still reads one source, tests52lines, makes6Git requests and installs no verifier record because the receipt truncates. Newly admitted mandatory filtering pays whole-cohort metadata/artifact work first, with aggregate info hits34→1058 and a slower fresh58.47ms sample. Unsupported alternation makes zero candidate-filter calls, scans512sources/tests131,584lines and makes10Git requests on both graphs; its slower after sample is retained.

Caller-paid baseline preparation622.70ms,512 source reads and four prefetch batches. Generated Git seeding2.80s and fresh handle/factory setup are separately charged. Closing/cleanup and corpus byte generation are outside query clocks. Parser does not participate in preparation; artifact identity is unchanged.

Single sequential samples are machine-local/noisy, not randomized repeated timing or physical cold. OS/JIT/page-cache/GC effects remain uncontrolled. The code-only scope does not certify other repositories or mixed/entropy distributions. Full raw values, CPU usage, source/index/store/Truth counters, setup/prepare and receipt hashes are preserved. Code group-plus76.92ms and dense58.47ms keep cold50ms/default activation unresolved. Logical cache gauges are not RSS. No provider, product edit, remote write or runtime dependency is used.

Raw/executed/helper hashes and complete source manifests are in provenance.json. Same-source/missing-after admission controls2/2 reject before owned-root allocation. Source safety and actual-View QA are independent gates; this small performance artifact does not replace them.

## Provenance-only repair after measurement

The first full after-manifest snapshot used current-worktree tracked files after timing and included a subsequently folded QA-only test, src/tools/min-one-literal-acceptance.test.ts, absent from recorded96c. Every other source hash and every imported/executed production module matched96c. The original capture is preserved verbatim in provenance-as-captured.json. provenance.json now derives the exact382-file96c manifest from immutable Git tree/blob bytes and records the original snapshot hash, extra test hash and regeneration method. Raw measured HEAD/tree, complete receipts, timings and executed harness/module hashes are unchanged; no timing rerun was necessary.
