# Prepared-cold attribution at f7

Source: `f7b6002170d0df3125ebc513be22e965107ffafe`, tree `a7310d46` (full fingerprints in provenance.json). Run:

```
node tools/profile-prepared-cold.js > /tmp/prepared-cold-profile.json
```

`raw.json` contains every sample, complete-receipt digest, exact source/harness hashes and the two raw inspector profiles. All prepared and repeated results were deep-equal to the same exact graph's plain/default host full `{ok, output}` result. Literal `rare_hit`, noncapture `rare(?:_hit)` and capture `rare(_hit)` receipts are identical. Profiles use the established generated code/mixed/entropy corpus: 512 files × 32 KiB = 16 MiB, 256 fixed-width rows per file, one rare match in the last file; mixed includes Unicode, combining marks and NUL. Entropy is a known preparation-pressure control, not representative source code.

## Findings

The largest actionable avoidable cost is conservative regex syntax coverage. Prepared postings already exclude 511 of 512 sources for `rare_hit`. Both equivalent literal-only groups currently bypass the cohort completely. No source/metadata authority can be dropped based on this observation; changing extraction requires an independently proved grammar.

| Fresh query | Code ms (two fresh handles) | Mixed ms (two fresh handles) | View reads | Prefetched IDs | Git requests | View stat calls |
|---|---:|---:|---:|---:|---:|---:|
| literal sparse | 78.74, 51.85 | 71.05, 47.01 | 1 | 1 | 6 | 515 |
| miss | 52.06, 67.46 | 45.10, 37.54 | 0 | 0 | 5 | 512 |
| noncapture group | 352.87, 343.53 | 165.34, 158.90 | 512 | 512 | 10 | 1540 |
| capture group | 180.36, 137.62 | 166.27, 165.72 | 512 | 512 | 10 | 1540 |
| dense early stop | 61.57, 95.77 | 42.47, 31.89 | 1 | 32 | 6 | 546 |

These are noisy, fixed-order machine-local samples, not paired implementation speedups or a statistical certificate. The plain dense controls were 29.56/37.90 ms and retain an advantage over the first prepared dense samples. Sparse prepared repeats cost 1.2–2.3 ms; grouped repeats cost 8.6–35.3 ms with 512 verifier hits, 1024 current metadata checks and zero actual prefetch. Thus existing warm elision is working, but it cannot replace the cold syntax gate.

Code artifact: 466,926 bytes, 758 grams, 220,423 postings. Mixed: 470,034 bytes, 761 grams, 221,959 postings. A fresh literal query reads the full controlled artifact once; two leaf reads include EOF. Actual leaf read wall time was 0.094–1.51 ms across literal/dense samples. Controlled store time was 3.86–41.62 ms, including namespace/epoch checks, ownership/copy, checksum and structural decode. Independent exact-artifact decode replays were code 8.06, 2.48, 2.19, 5.56, 5.67 ms and mixed 3.26, 1.97, 2.44, 1.85, 2.06 ms. They are warmed independent calibration, not a subtraction proving store overhead in the live query.

Cold walk/Truth tree and metadata admission is material: sparse/miss `walkDetailed` took code 24.8–45.1 ms and mixed 22.6–47.9 ms, before the cohort filter; the metadata info table missed all 512 IDs. Whole filter time was code 22.1–46.0 ms and mixed 13.5–22.4 ms. Surviving literal source read was only 1 × 32 KiB with 257 tested lines, versus group fallback 512 × 32 KiB and 131,584 line tests. Group prefetch alone took code 58.1–137.1 ms and mixed 61.2–72.8 ms. Metadata timers overlap concurrent prefetch and may exceed wall time; do not add them to prefetch/filter/store timers. Source reads here count View API work, not physical storage traffic; immutable Truth returns own copies.

`cpu-summary.json` derives inclusive ancestor samples within the recorded monotonic query bounds from raw inspector timeDeltas. Its diagnostic sparse query was 39.96 ms (about 40.68 ms sampled interval; interval boundary noise), with 16.91 ms idle, about 1.10 ms in decode, 1.02 ms in posting lookup and 5.42 ms beneath searchWalk. Group fallback was 364.30 ms, with about 149.74 ms idle, 25.40 ms GC, 23.38 ms beneath verifier scan and 18.93 ms beneath hash update. Async ancestry is incomplete and inclusive categories overlap; inspector affects execution. These are sampling evidence, not additive exact CPU attribution.

Caller-paid preparation: code 737.03 ms and mixed 635.22 ms, 512 source reads and four prefetch calls each. Generated Git seeding was separately 3.58/3.72 s; fresh handle/factory admission is recorded per measurement as setupMs outside the query. Entropy preparation spent 1937.15 ms and 147 source reads before refusing, installed no artifact, and subsequently read all 512 sources: literal 575.27 ms/group 739.50 ms, five cohort fallbacks for the literal. Unicode/NUL, pressure refusal, dense truncation, cold costs and default host behavior remain explicit.

## One optimization and its gates

Implement only conservative balanced, unquantified literal capture/noncapture concatenation flattening in requiredLiteralTrigrams. Preserve original RegExp as the sole positive-match source verifier. Reject the entire optimization for quantifiers, alternation, character classes, lookaround, backreferences, flags, malformed/nested-special groups, exceeded pattern/gram/depth budgets, or any uncertainty. The source-hash/EOF/provenance and exact View-generation cohort rules do not change.

Proof plan: pure extraction tests for nested groups/escaped punctuation/anchors, exhaustive small literal-group equivalence and every unsupported construct; exact current-source prepared code/mixed noncapture/capture/full receipt pairs, plus literal, dense early-stop, quantifier fallback and entropy refusal. Verify source512→1, metadata1540→515, prefetch512→1, Git10→6 while artifact identity and paid preparation stay identical. Preserve cold grouped overhead for dense sources and all fallback costs. B owns product implementation/review.

No physical-cold or cold50ms success is established. The optional index remains opt-in; several exact fresh samples exceed50ms. Source hashes name this local historical graph even after publication moves. Logical verifier/cache counters are not RSS. Corpus generation, closing and cleanup remain outside query clocks; preparation and seeding have separate charges. No provider or remote write is involved.

## Post-measurement harness ownership repair

The measured harness is archived verbatim as executed-harness.js and its hash matches raw.json. The current script routes builtin restoration/resync and every owned-root removal through one attempt-all cleanup helper, preserving a primary query error even when resync throws. `node tools/probe-prepared-profile-cleanup.js` passed both injected resync controls (with/without primary failure); both roots were removed each time. This cleanup-only repair did not rerun or alter measured product graphs. Current and executed script/helper hashes are distinct and recorded in provenance.json.
