# Optional immutable cohort storage

`src/search/cohort-store.ts` stores one opaque cohort artifact at `.fugue/idx/v1/cohorts/<cohort-key>.bin`. The key identifies an exact bounded set of complete Git blob IDs. Existing per-blob v1 records and readers are untouched. This is optional derived-cache storage for the cold-path batch; it does not select a source, build an index, change tool/catalog/event bytes, or enable indexing by default.

API: `createCohortIndexStore(root)` returns `read(ids)`, `write(index, temporaryId?)`, `close()` and observational `stats()`. Reads return an immutable codec handle or `null`; writes return whether all publication, validation and cleanup steps completed. Any unavailable, unsafe, corrupt, wrong-ID, oversized or failed operation stays a miss, so the caller must scan. Only genuine opaque handles from the codec are writable. Codec checksum and expected-ID validation prove self-consistency, not source provenance: the builder must consume complete records from the existing controlled validated leaf store or verified blob construction.

Safety boundaries:

- At most four admitted operations. Admission is reserved before codec/input access, so reentrant close also observes it. No unbounded wait queue or lifetime file descriptors.
- IDs are captured by a dense indexed loop before awaiting IO, bounded by the codec's 4096-blob limit; holes, iterators, duplicates and unsupported IDs cannot enlarge the operation. Encoding returns owned bytes before write IO begins.
- Root and `.fugue` require this UID and no world write; group-writable workspaces remain supported. `idx`, `v1`, `cohorts`, artifacts and temporaries retain the existing strict private `077` predicate. New directories/files use `0700`/`0600`; no permissions are repaired.
- Directory and file opens use no-follow descriptor anchors. Reads require an owned ordinary single-link file within the codec's 32 MiB ceiling. They allocate at most that file size plus one growth-probe byte, verify exact used size and nanosecond metadata epochs, then decode for the exact captured IDs.
- All directory descriptors and the reopened actual namespace are checked before a read is returned. Inode replacement, aliases, permission changes or restored-mode epochs invalidate the result. Writes validate the publication directory epoch before rename, and all ancestor bindings after publication; the last directory's own entry changes are expected.
- Publication uses an exclusive owned temporary, file fsync, atomic rename and directory fsync. A consumed temporary name is immediately disarmed. Cleanup attempts every owned action despite earlier errors and checks the temporary inode before unlinking; collisions, replacements and unknown temporaries are preserved. There is no age/PID sweep. If ownership cannot be verified, cleanup conservatively leaves the temporary.
- Closing refuses new admission immediately and waits for every admitted operation and cleanup. Started filesystem IO is observed, not promised to be forcibly canceled. Descriptor close failures discard the result; counters distinguish observed failures and byte reads.

The read-byte and operation ceilings are independent of codec dictionary/postings caps and decoded-memory use. Returned handles are caller-owned; storage retains no result cache. Linux descriptor anchoring is optional infrastructure: unsupported platforms fail open. These controls do not promise protection against an actively malicious same-UID process forging a self-consistent private cache, and do not alter host/kernel policies.

Focused proof:

```
node tools/test-entry.js fast src/search/cohort-store.test.ts
```

The 14 cases cover artifact/ID roundtrip and the full4096-ID boundary with one physical artifact read, dense preflight without FS, permission boundaries, links and outside-data preservation, corruption/size/growth, ancestor replacement/restored modes, bounded/reentrant close, synchronous/asynchronous cleanup failures, persistent temporary close rejection, foreign nonce collision, two actual publishers reusing a consumed nonce, and replacement-inode preservation. A private negative control removes timestamp epochs while retaining identity checks; the restored-permission case then returns an index instead of a miss and fails. No product fault hook or whole-suite rebaselining is added.

Cold query equivalence, preparation cost, source/request/spawn counts and the 16 MiB target are measured by the integration owner on the exact codec/store/lookup composition. These focused storage checks provide no default-activation, performance, live-model or strict-sandbox certificate.
