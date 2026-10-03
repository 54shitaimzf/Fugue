# Scoped ancestor batch reader

Roadmap 0.3.3 cold-path prerequisite, kept separate from query integration. `createBlobIndexStore`
adds a `BatchBlobIndexStore.readBatch(ids)` port; the old `BlobIndexStore.read/rebuild` interface and
valid scalar reads remain unchanged. No lifetime FD cache, tool/catalog/event change or default enable.

## Admission and bounds

An indexed dense snapshot is taken from a validated array length. Custom iterators are never called;
sparse/non-string/malformed IDs reject before any filesystem work. Empty input returns `[]`.
More than 128 IDs returns `null`, which means the whole batch is unavailable. An array result stays
in the original order, including duplicate IDs; `null` entries are individual misses, never exclusions.

At most four shard/leaf reads run at once. Across one call, canonical record input is capped at 16 MiB
plus at most 128 single-byte growth probes; retained tables are capped at 1,000,000 trigrams. Byte
reservation happens before buffer allocation/read, gram reservation before returning a decoded table.
Budget rejection leaves the entry unknown. These are input/retention accounting bounds, not a claim
of exact resident-memory usage; JSON parsing and four active records still have temporary overhead.

## Trust and lifecycle

Only root/.fugue/idx/v1 descriptors are shared, within this one call. Every component is opened with
original directory/no-follow flags and checked as a real, owned, non-shared-writable directory.
Each shard repeats its original check. Every leaf keeps the original no-follow, regular-file,
owner/mode/single-link, size, growth, before/after timestamp and complete canonical/checksum guards.

Before any result escapes, all shared ancestors are restatted and compared for device/inode,
owner/mode/link-count and mtime/ctime epoch. The original root name is also reopened and matched to
the captured root, so replacing its namespace cannot silently keep using an old live descriptor.
Any shared invalidation/error/close failure fails open for the whole batch. A leaf-local failure only
makes that entry unknown. Every already-started read and close is observed; no descriptor is retained
past the call. All caller matching still needs current-view identities and exact regex verification.
The existing checksum remains corruption detection, not authentication of a hostile same-owner writer.

## Verification

```sh
node tools/test-entry.js fast src/search/index-read-batch.test.ts src/search/index-store.test.ts
node tools/bench-index-batch.js
```

Controlled tests cover ancestor/shard/leaf aliases, hardlinks/shared mode, ancestor replacement,
unsafe mode restored before return, root-name replacement, shared stat/async/synchronous close
rejection, leaf read error, every opened handle's cleanup, sparse/iterator admission, exact 128/129
rows, and independent raw-byte/retained-gram limits. Large synthetic canonical tables exercise only
budget guards; they are not represented as genuine source-query equivalence. The benchmark instead
constructs every expected index independently from real generated source bytes and compares every
field, with scalar and scoped four-lane reads in alternating order. Failed arguments occur before
temporary-root allocation; instrumentation is confined to the benchmark process and restored on exit.

## Isolated record-read evidence

Cloud overlay, 512 records, 16,037,385 original bytes, seven alternating runs. Direct offline record
preparation cost 3998.888 ms, separate from query/background Worker preparation. The observed API-call
counts are identical across samples:

| Reader | open | stat | read | close | total |
|---|---:|---:|---:|---:|---:|
| scalar four-lane |3072|3584|1024|3072|10752|
| scoped four-lane |1044|1572|1024|1044|4684|

Median record-read time 347.033 → 211.247 ms. The earlier exploratory matrix had one adverse paired sample; the final seven-pair matrix
has zero slower scoped pairs. These small cloud samples still do not establish a universal speedup. Wrappers add overhead and these are API calls, not kernel syscall counts. OS page
cache is primed, no FD/cache is retained by the store, and this is not physical-cold certification.

The reader is not yet consumed by grep/lookup. These data do not establish an end-to-end benefit,
0.4.0 <50ms acceptance, default activation or full/live/kernel isolation. Query integration requires
its own controlled lifecycle/current-view/reference matrix. Upstream PR creation remains blocked 403;
fork push fast CI cannot substitute full acceptance. The previous sized-read experiment stays local
and is not included here.
