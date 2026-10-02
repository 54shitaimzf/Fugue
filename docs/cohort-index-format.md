# Optional packed UTF-16 cohort index, version 1

This is a separately versioned derived artifact. It does not change the existing
`fugue-blob-trigrams` v1 record, Git truth, logs, serving, or default query behavior.
The backend is optional and remains off by default. No speed target is asserted
by the codec; cold end-to-end performance must be measured by its caller.

## Contract and trust boundary

`buildCohortIndex(records)` takes a complete, nonempty set of distinct BlobIndex
records, produced from Git-hash-verified bytes or the existing controlled derived
store. SHA1 and SHA256 Git object IDs are both supported, as full lowercase IDs.
The codec captures indexed input fields and does not use caller array iterators.
It validates the unchanged per-blob v1 shape, sorts by immutable ID, and refuses
an entire over-budget cohort. It never silently drops an ID, gram, or posting.

A self-consistent table is not proof that its grams match its claimed source.
SHA256 checksums detect damage; they do not authenticate source completeness or
protect against active same-UID forgery. The builder and secure store retain the
existing controlled-build trust model. A caller must never build from an
incomplete table or promote a checksum-valid untrusted artifact into a proof.

- `cohortKey(ids)` returns an order-independent key for the exact distinct ID set,
  or null for unsupported, empty, sparse, duplicate, or over-budget input
- `encodeCohortIndex(handle)` returns an owned byte copy
- `decodeCohortIndex(bytes, expectedIds)` returns a handle only for the exact full
  expected set, matching canonical bytes, or null on any failure
- `cohortMightContain(handle, blob, required)` returns true if every required
  three-unit gram has that blob in its postings, false if at least one is absent,
  or null if unsupported, missing, or not a codec-created handle

True is only candidate presence. The caller must apply the original regex to the
original decoded content. False can exclude a blob only when requirements are
provably necessary for that regex. Null always means scan. Requirements are
validated completely before returning a negative result, including malformed
tails. Empty requirements do not constitute a useful proof and return null.

The public CohortIndex is an immutable opaque handle containing its key, frozen
blob IDs, gram count, posting count, and byte length. Packed bytes and ordinal
maps are private in a WeakMap. Caller mutations or transfers of serialized bytes
cannot modify a live proof. Decode owns only the supplied Uint8Array's actual
window; intrinsic view bounds prevent a subclass's spoofed length from bypassing
allocation limits. The module has no filesystem, source reads, workers, or timers.

## Fixed resource bounds

All caps are exported by `src/search/cohort-format.ts`, which is the policy source:

- 4,096 distinct immutable blobs
- 200,000 distinct dictionary grams
- 2,000,000 total gram-to-blob postings
- 32 MiB serialized bytes, checked before allocation/copy
- 256 required grams per membership request
- Per-blob source, decoded-unit, and gram bounds remain those of v1 BlobIndex

Allocation and loops are bounded by these limits, not wire-supplied unchecked
counts. IDs are captured once by dense indexed access. Budget failure is unknown;
it is not permanent evidence that the content lacks a pattern. Bounded grouped
cohorts may be prepared by a caller, but an individual encoded segment must be
complete for its exact expected ID set.

## Deterministic binary layout

All integers are unsigned, big-endian. A gram is three UTF-16 code units, each a
16-bit integer. It is never UTF-8 encoded, normalized, folded, or compared using
locale rules. Its numeric 48-bit key has exactly JavaScript's lexicographic
code-unit ordering. NUL, replacement characters, surrogate halves, and U+FFFF
round-trip without special cases.

| Region | Encoding |
| --- | --- |
| Header, 56 bytes | ASCII `FGCOHORT` (8), version u16 (1), reserved u16 (0), blob count u32, dictionary count u32, posting count u32, cohort identity (32) |
| Blob records, sorted by full ID | digest length u8 (20 or 32), raw Git digest, source bytes u32, decoded UTF-16 units u32, unique gram count u32 |
| Dictionary, sorted unique grams | gram (6), start posting ordinal u32, candidate count u16; 12 bytes per entry |
| Postings | sorted unique blob ordinals u16, contiguous dictionary order |
| Trailer | SHA256 of every preceding byte (32) |

The cohort identity is SHA256 of UTF-8 domain string
`fugue-cohort-utf16-postings-v1\0`, blob count u32, and each sorted blob's digest
length u8 plus raw digest. Count and digest length delimit the complete identities
and distinguish SHA1 from SHA256. Storage can use the complete hex identity in
its separate versioned namespace; identity changes whenever the complete set
changes, even if candidate texts happen to be equal.

Decode checks magic/version/reserved bytes, key, exact expected sorted records,
all metadata bounds, total layout length, checksum, strictly increasing gram
keys, contiguous posting starts, nonempty posting lists, sorted unique in-range
blob ordinals, exact final consumption, and per-blob posting counts. Duplicate
IDs, extra/trailing bytes, truncation, holes, overlaps, empty lists, overflow,
unrecognized versions, unsupported source shapes, or missing identities all
return null. A sum of per-blob posting counts is a consistency check, not source
authentication. The existing v1 codec remains unchanged.

## Reproducible checks

`node --test src/search/cohort-format.test.ts`

The suite compares seeded packed membership with the complete per-blob gram
reference and verifies literal-regex filtered results against canonical full
scan. It covers both Git hash algorithms, UTF-16 edge units and invalid UTF-8,
deterministic ordering, sparse/malicious inputs, snapshot ownership, malformed
requirements, all byte truncations, repaired-checksum structural mutations, and
seeded random corruption/count overflow. End-to-end store security, fallback,
current-view selection, and cold timings belong to their respective adapter and
acceptance suites.
