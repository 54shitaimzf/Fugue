# Tree-name lookup: warm gain, cold inclusion declined

Decision: preserve evidence only. The private bounded name index improves repeated native no-IO stat work, but this experiment does not establish a meaningful prepared-cold benefit and doubles the tested oversized-name fallback cost. Candidate42→4af and its QA stay isolated; no production name-index source is included or installed.

Exact current baseline `ede5443c03b4841df7a0927935fdf1144b5257ad`, isolated after `4af9882a07c9dce733ee54476f1a59924bcf7013`. Only truth.ts and the private tree-name-index helper alter imported behavior. Its immutable parsed-array identity and first-duplicate semantics are preserved; eager file/symlink info, source reads and mode/error paths are unchanged. Raw native query counters compare exactly across sources, complete `{ok, output}` matches the baseline plain/default reference, and generated missing-file and missing-symlink error names/messages are identical. Separate source QA covers duplicate/decoded-name and cap semantics; this timing report does not broaden those gates.

## Reproduce

Create baseline and candidate worktrees from exactede; candidate.patch reproduces all changed src bytes without requiring unpublished local experiment commits. Run from this evidence checkout:

```
node --expose-gc tools/bench-tree-name-paired.js --before /path/to/ede --after /path/to/name-candidate > /tmp/tree-name-paired.json
```

Native Truth/View/host methods are never wrapped or replaced. Imports and distinct-source/unrelated-module equality checks precede private allocation. All handle/root cleanups attempt every owned resource and preserve primary errors. Same-source and missing-reference admission controls2/2 reject before creating roots. Raw/executed/helper/patch/full-source fingerprints are in provenance.json.

## Prepared-cold query evidence

Code/mixed512×32KiB and pressure1024×16KiB all total16MiB. Corpus/artifact identities match prior approved evidence. Same immutable repository/artifact per profile; three alternating before/after fresh queries for sparse/miss, each followed by memory repeat. One dense/unsupported-plus control per code/mixed graph. Fresh Truth/View/adapter/store/verifier handles are query-cold, not physical cold. Fixed case order, JIT/OS cache/GC and scheduling noise remain uncontrolled.

| Fresh median ms | ede | candidate |
|---|---:|---:|
|code sparse|37.49|78.34|
|mixed sparse|43.60|71.19|
|code miss|37.12|39.11|
|mixed miss|56.57|57.36|
|1024 pressure miss|65.58|63.08|

Sparse source reads remain1, miss0, eager info misses/entries512 or1024, and native Git requests6/5/7 respectively. There is no source/metadata elision. Cold sparse samples include retained candidate173.40ms and baseline73.88ms; no slow sample was discarded. Single dense code37.74→43.32ms/mixed48.55→41.66ms. Unsupported-plus fallback still reads512 sources:168.31→165.60ms/code,183.41→236.76ms/mixed. These sparse cold trials neither prove a regression mechanism nor support the proposed cold-goal gain; no further repetitions were requested.

Paid baseline preparation code963.74ms/mixed675.45ms/pressure987.89ms, with512/512/1024 source reads and4/4/8 prefetch batches. Seed charges2.61/3.55/9.77s and fresh handle/factory setup are separate from query clocks. Corpus byte generation/closing/cleanup are outside clocks. Artifacts466,926/470,034/640,870 bytes and their exact hashes are retained.

## Warm CPU mechanism

A separate native Truth pair primes tree arrays/info, then executes six alternating no-IO stat laps. Each lap performs eight full path passes:4096 calls for512files,8192 for1024files. Complete metadata row arrays are deep-equal before hashing; every lap has zero Git requests and zero info misses. These warm calls do not use grep/index/verifier caches and cannot be treated as prepared-cold query latency.

| Warm lap median | ede wall / process CPU ms | candidate wall / process CPU ms |
|---|---:|---:|
|code8×512stats|16.64 /17.60|10.54 /11.89|
|mixed8×512stats|21.82 /26.04|14.85 /17.92|
|pressure8×1024stats|48.14 /48.13|21.17 /25.50|

This supports repeated lookup work reduction under equal IO/metadata. The earlier7.8ms inclusive lookup CPU sample was not Array.find self time; it is not reused as causal savings. Process CPU may exceed wall due runtime/JIT threads and is not a sampled synchronous-function subtotal.

## Retention and adverse cap control

Added positive-index logical accounting uses the exact candidate policy:128+2×TreeId.length+64×rows+2×nameUnits per tree. Standard two-tree corpus totals513rows/4102units/41,452accounted bytes; pressure1025rows/8222units/82,460bytes. New retention caps are256trees,32768rows,1MiB UTF-16 units and4MiB accounted bytes. These are policy charges, not measured allocation/heap/RSS bounds. Keys/row references may reuse existing objects, while Map/object/allocator overhead differs. The inherited parsed-tree and info caches remain outside this new bound. Whole-index eviction precedes new Map construction.

Forced-GC cache-prime snapshots are diagnostic whole-Truth retention, not isolated index allocation: heapUsed deltas code−6456/32560bytes before/after, mixed57448/87168, pressure100208/252840. They include parsed trees, info cache, child/transport/runtime/JIT and unrelated collection; pressure baseline external delta−5,595,223bytes illustrates that noise. RSS/external/array-buffer snapshots are preserved raw, with no attribution or physical cap claim.

One separate metadata-only oversized-name control uses1024long unique names, one shared tiny blob and1,075,200UTF-16 units, exceeding the1,048,576-unit cap. Both native graphs preserve exact stat metadata and have zero new info/Git work. Four alternating laps perform two full1024-path passes. Baseline median wall/CPU12.41/12.77ms; candidate24.52/24.48ms. Rejected trees retry admission preflight on each lookup before falling back to original linear search; that added scan doubles this control's work. No long-name search matrix or repair/memoization is included in the declined source.

Prepared-cold50ms/default activation remain unfulfilled. Warm gains do not close that gate or outweigh the demonstrated fallback cost for this proposed cold-path inclusion. No provider, remote write, product change, runtime dependency or further repetitions are part of this evidence checkpoint.
