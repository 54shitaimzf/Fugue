# Actual mandatory-run source comparison

Exact before product graph `2a721de1e33ac6f0c87a58577b4639de72b3856c`, after local frozen source `1623f12c994ae04728d130e541a975891ad2f5fa` (tree `c8bbe56c3cc9cdf5b68383c00a811e015cd87a1b`). Only the imported regex-literal.ts source differs. These are exact historical/local measured graphs, not a later public union certificate. Native Truth/View/host methods stay untouched; external stats observe actual source verification, eager object info and Git requests.

```
node tools/bench-required-runs-paired.js --before /path/to/2a --after /path/to/1623 > /tmp/required-runs-paired.json
```

One small code/mixed chain,512 files×32KiB=16MiB each. Corpus and prepared artifact fingerprints match the earlier approved profile; both sources share that same immutable corpus and artifact. For every case, one fresh query and one same-memory repeat use fresh Truth/View/adapter/store/verifier handles. Source order alternates across cases. Every complete `{ok, output}` is deep-equal to the plain/default before-host reference, including bounded dense truncation. Source-hash inequality and unrelated imported-module equality are checked before private temp allocation.

| Fresh query | Code before→after ms | Mixed before→after ms |
|---|---:|---:|
| optional suffix `rare(_hit)?` |169.75→62.11|180.45→44.69|
| variable span `rare.*hit` |148.92→47.26|167.93→56.29|
| dense `dense_hit.*` |21.83→51.82|23.63→46.02|
| unsupported-plus fallback `rare.+hit` |135.91→169.03|151.88→169.19|

Both selective patterns reduce actual verified source reads512→1, line tests131,584→257 and Git requests10→6. The original regex still verifies real source content/hash/EOF. Both after patterns use five bounded candidate-filter calls, one controlled artifact read and one complete source record. Actual eager object info misses and entries remain512 on every fresh query; nothing bypasses the existing missing-file/symlink lookup semantics. Aggregate Truth info hits fall1540→1027 (these include View listing/stat work and are not direct View.stat call counts).

Selective memory repeats fall code11.34/10.52ms→2.38/2.00ms and mixed10.24/9.12ms→0.93/0.81ms; all repeat source reads and Git requests are zero. Native repeated aggregate info hits1024→7. New prepared filtering reduces the work needed before cache consumption; it does not relax source/generation/reader authority.

Adverse cases are explicit. Dense source count stays1, line tests52 and Git requests6. The newly admitted dense pattern pays512-path cohort admission and full artifact validation before the same first source; aggregate info hits34→1058. It installs no verifier record because the receipt truncates early and is slower in both fresh samples. Plus remains unsupported: both sources still read512 sources, test131,584 lines, issue10Git requests, and make zero candidate-filter calls. The slower after fallback samples are retained; no causal speedup is inferred there.

Paid baseline preparation: code738.45ms and mixed655.72ms,512 immutable source reads and four preparation prefetch calls each. Generated Git seeding2.40/3.34s and fresh handle/factory setup are separately recorded. Artifacts466,926/470,034 bytes and exact hashes are unchanged; parser never participates in preparation. Closing/cleanup and corpus byte generation remain outside query clocks.

This is one noisy sequential case chain, not repeated randomized timing or a physical-cold certificate. OS/JIT/page-cache/GC effects remain uncontrolled; full raw samples, CPU use, setup/prepare, source/index/store counters and receipt hashes are retained. Cold50ms/default activation remain unresolved: code optional62.11ms, mixed dot-star56.29ms and dense/fallback samples still exceed50ms. Logical cache counters are not RSS. No provider, product edit, remote write, index default activation or new runtime dependency occurs in the harness.

`raw.json` and provenance.json preserve the executed harness/helper hashes and complete before/after src manifests. Same-source and missing-after admission controls2/2 reject before any owned root is allocated. This actual source evidence is separate from the fixture-only required-run opportunity proof and the rejected metadata-batching experiment.
