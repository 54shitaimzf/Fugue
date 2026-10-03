# Metadata-only batching: negative performance result

Decision: retain measurements only. Increasing metadata chunk256 to512 or1024 reduced the expected Git round trips but produced no consistent meaningful prepared-cold wall-time gain. No production constant, default activation or public interface changes are proposed.

Exact baseline: `2a721de1e33ac6f0c87a58577b4639de72b3856c`. Local isolated variants:512=`656119c` and1024=`3a8d4df` (full heads/trees/blobs in provenance.json). Both change only infoOfMany's bounded header batch. Content OBJECT_MANY_CHUNK stays256; host candidate32/128 rows and4MiB prefix remain unchanged. Native Truth/View/host methods were never replaced or wrapped. Stats are external observations. Every complete `{ok, output}` matches the same plain/default baseline receipt, including dense truncation, and generated missing-file and missing-symlink error name/message pairs match exactly across all three graphs.

## Reproduce

Create three isolated worktrees from the exact baseline, apply variant-512.patch and variant-1024.patch only to their respective experiment worktrees, then run the developer harness from this evidence checkout:

```
node tools/bench-info-batch.js --before /path/to/2a --512 /path/to/info512 --1024 /path/to/info1024 > /tmp/info-batch.json
```

The two patches reproduce the measured source bytes without depending on unpublished local variant commits. Verify the imported/full-source SHA256 manifests in provenance.json; rerun HEADs may differ while source bytes must match. Imports, distinct-source checks and all unrelated imported-module equality checks precede private temp allocation. Standard attempt-all owned handle/root helpers preserve primary errors. Same-source and missing-reference admission controls reject before creating roots.

## Results

Three rotating backend orders for sparse/miss:256/512/1024,1024/256/512,512/1024/256. Each uses a fresh Truth/View/adapter/store/verifier handle followed by memory repeat. One dense and quantified control per code/mixed graph. Sources share one immutable16MiB corpus and one exact prepared artifact per profile. Code/mixed use512×32KiB, preserving the prior approved corpus hashes. Pressure uses1024×16KiB (same total bytes) to distinguish larger metadata batches.

| Fresh query median ms |256 baseline|512 headers|1024 headers|
|---|---:|---:|---:|
|code grouped sparse|54.11|84.83|68.33|
|mixed grouped sparse|38.52|46.72|40.90|
|code miss|38.43|36.38|36.34|
|mixed miss|30.86|31.55|38.62|
|1024-file pressure miss|67.34|65.32|65.08|

Counters establish the narrow mechanism, not a wall improvement: all512 or1024 eager info misses/entries remain.512-file sparse Git requests6→5→5; miss5→4→4.1024-file pressure miss7→5→4. Sparse still reads one actual source; miss still reads none. Quantified fallback still reads512 sources and Git10→9→9. The same prepared artifact is read once per fresh supported query. Repeats avoid info misses and Git requests; there is no systematic repeat benefit from changing a cold info batch constant.

Single dense samples: code255.15/46.45/55.74ms, mixed50.98/46.39/47.98ms. The code baseline is a large retained outlier, with no repetition supporting a causal dense gain. Quantified fallback: code165.31/248.83/178.71ms, mixed260.38/184.78/193.51ms. Fixed case order, JIT/OS cache/GC and shared-host scheduling are uncontrolled. Three small rotating trials do not identify the cause of noisy regressions or certify a universal improvement. Full raw values, CPU usage, per-phase setup and exact receipt hashes are retained rather than selectively dropping slow cases.

Paid preparation uses the unchanged baseline once per shared corpus: code908.84ms, mixed781.75ms, pressure753.38ms;512/512/1024 immutable source reads and4/4/8 preparation prefetches. Seed charges are3.22/3.88/8.08s. These are separate from query wall clocks; fresh factory/handle setup is reported independently. Artifact bytes are466,926/470,034/640,870 and exact SHA256 is recorded. Closing/cleanup and corpus byte generation remain outside query clocks.

## Bounded response effects and limits

For these SHA1 normal blob replies with five-digit sizes, the protocol header is52 bytes (`40-digit-id blob size\n`); derived maximum header payload per metadata ask is13,312/26,624/53,248 bytes for256/512/1024 rows.512-file variants512 and1024 both issue only512 rows, so both cap that corpus's actual ask at26,624 derived header bytes. Pressure exposes1024-row asks. Total eager headers and retained info entries do not shrink; only grouping and round-trip counts change. Pending reply-array capacity grows with the info cap. These are source-derived protocol/count bounds, not instrumented wire-byte, RSS, allocation, event-loop-delay or physical IO measurements. Content bodies and source cache budgets are unchanged.

The old f7 profile separately recorded walkDetailed23–48ms and whole-query512 info misses, but did not split info work by stage. Source shows listAt eagerly sizes and rejects missing blobs for all lower file/symlink entries before View applies upper/tombstone masking; a no-size walk alone would shift missing info into cohort snapshot's sequential stat calls. The rejected no-info approach would also hide existing eager missing-object failures for otherwise excluded files/symlinks. This experiment retains every eager check and does not claim listAt enforced object-type validation beyond missing-object rejection. No cross-module authority seam is introduced.

Cold50ms remains unresolved: grouped code medians54–85ms and pressure65–67ms already exceed it. Default index activation is not justified. No provider, remote write, product integration or new runtime dependency was used. No further repeats of this hypothesis are planned.
