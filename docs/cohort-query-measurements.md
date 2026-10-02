# Optional cohort query measurements

The prepared current-View cohort replaces hundreds of per-blob cache reads with one immutable artifact. These developer measurements exercise the actual Truth → View → host → grep path against the same default-off scan receipt. They support an optional implementation checkpoint; the default activation and complete ROADMAP 0.4 acceptance remain open.

## Method and ownership

Run from the repository root:

```
node tools/bench-cohort-query.js --runs 3 --files 512 --lines 256 --profile code
node tools/bench-cohort-query.js --runs 3 --files 512 --lines 256 --profile mixed
node tools/bench-cohort-query.js --runs 1 --files 512 --lines 256 --profile entropy
```

The corpus is generated directly into a disposable Git repository, with an explicit clean Git environment. No materialized working tree supplies search content. Code is repetitive source-like text; mixed adds Unicode identifiers, emoji, combining characters and NUL; entropy adds seeded arbitrary bytes, decoded through the same UTF-8 semantics as grep. Each artifact records corpus SHA256, source SHA256s, all trials, per-phase counters and exact scan-receipt assertions. The independent functional acceptance also covers Unicode/CRLF, all grep output modes, regex fallback, multiple Views, edits, whiteouts, reset/reopen and corrupt/missing/oversized caches.

Each trial runs default scan cold/repeat, optional first missing-index query, explicit preparation, same-handle post-preparation query, and a new Truth/View/adapter session for restart cold/repeat. Cold means fresh handles in the same Node process; the OS page cache is retained. The full timed grep includes enumeration, current-View metadata, candidate filtering and authoritative regex/content verification. Disposable corpus creation, opening Truth/M0 and initial View replay precede query timing; this is not CLI startup latency. Phases run sequentially, so OS warming and scheduling affect comparison. Preparation is paid after the missing-index query, when its source cache may already be warm. Its source callback count is distinct from Git requests and Git process spawns.

The benchmark owns and awaits adapter → store → log → Truth cleanup, even after setup or close failure, and attempts every generated-directory removal. Allocation/hash/corpus setup stays within the outer cleanup scope. Three fast guard tests cover partial setup failure, blocked final close after an earlier rejection, and successful ordered cleanup.

## Results

Three-run medians in milliseconds; the entropy sample is a single separate run. All phases produce byte-identical receipts to the actual default-off reference.

| Corpus / query | Scan cold | First missing | Paid prepare | Fresh prepared query | Prepared repeat |
| --- | ---: | ---: | ---: | ---: | ---: |
| Code 16,037,385 B / dense | 19.154 | 26.041 | 592.055 | 36.396 | 0.408 |
| Code / sparse | 173.776 | 138.843 | 521.297 | 52.682 | 4.992 |
| Code / miss | 163.939 | 159.969 | 555.804 | 35.678 | 3.099 |
| Mixed 16,608,265 B / dense | 21.016 | 27.146 | 723.607 | 39.311 | 0.614 |
| Mixed / sparse | 151.773 | 172.835 | 735.872 | 42.006 | 4.114 |
| Mixed / miss | 147.253 | 151.124 | 640.277 | 42.522 | 3.226 |

The separate 64-file / 494,345-byte code corpus (three runs) has scan-cold dense/sparse/miss 7.058 / 15.358 / 13.597 ms, fresh prepared query 21.613 / 12.715 / 9.095 ms and paid preparation 65.314 / 21.150 / 26.266 ms. Dense again loses to the default scan. [Raw small-corpus evidence](measurements/cohort-query-code64.json) records all phases and hashes.

Code reads one 433,210-byte cohort; mixed reads one 586,962-byte cohort. Fresh prepared queries perform zero source calls and zero builds. Their Git counters are 6 requests / 1 spawn for dense or sparse and 5 / 1 for miss. Preparation calls every one of the 512 selected immutable sources, builds and writes one complete artifact. Cached source calls need not spawn Git: the measured preparation adds 413–511 requests and zero spawns after the first miss. Sparse/miss first-missing queries still read the full source corpus, with 517 requests and one spawn.

Dense baseline remains faster: its warm scan medians are 0.254 ms (code) and 0.347 ms (mixed), versus indexed restart repeat 0.408 / 0.614 ms. The code sparse cold median 52.682 ms exceeds the roadmap 50 ms target. The mixed target result therefore cannot certify all workloads or activate indexing by default.

## Entropy and resource refusal

The 16,037,385-byte entropy corpus exceeds the aggregate two-million-posting preparation budget after 137 verified source calls. Preparation returns false for all three patterns; no cohort is built or written. Its paid dense/sparse/miss costs are 1442.201 / 1379.947 / 1342.076 ms. Subsequent restart queries are ordinary fallback scans, not prepared-cold successes: 35.772 / 510.265 / 699.497 ms, with zero artifact bytes. Sparse/miss fallback remains 517 Git requests / one spawn. Receipt equivalence still passes. These single-run figures document budget behavior and adverse cost, without a statistical speed claim.

The adapter's logical limits are 5,000 paths, 4,096 distinct blobs, 64 MiB source windows, two million postings; the codec independently caps 200,000 dictionary grams and a 32 MiB serialized artifact. Retained decoded records, posting tables, owned copies, Git caches and transient preparation allocations add memory beyond serialized bytes. These are logical resource ceilings, not measured whole-process RSS. Queries never trigger preparation; callers choose and pay for it. The current preparation rebuilds the whole selected cohort rather than proving incremental reuse.

Raw evidence: [code](measurements/cohort-query-code512.json), [mixed](measurements/cohort-query-mixed512.json), [entropy](measurements/cohort-query-entropy512.json). Final source hashes match the measured modules. Earlier exploratory entropy/64-file overlap was excluded from these final 512-file timing records. Full real/audit acceptance, live capture, frozen cost events and default activation are separate gates.
