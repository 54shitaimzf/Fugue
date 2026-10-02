# Complete regex verification cache (0.3.3)

Concrete tool hosts selected through the existing optional blob/cohort index construction now retain bounded complete grep verification, keyed by the current immutable BlobId, native regular-expression source and flags. A cache record contains every matching line and its original number; it does not contain a path. Renames, aliases and permission changes can reuse the same verified content, while a new BlobId requires verification. Each host owns its own cache. Plain default hosts retain their original awaits, reader, decoding and regex testing without cache metadata/copy/hash work. This completes the separate cached-verification mechanism named in ROADMAP §4 / 0.3.3; it does not certify the whole milestone or enable the trigram/cohort index by default.

The binding lives in a private WeakMap. `ToolHost`, Truth, View, tool parameters, catalog bytes, events and persistent formats are unchanged. The exact host object and its original readBytes function must still match the construction binding. Generic hosts, spread/wrapped hosts and replaced readers follow the original scanner. There is no configuration or persisted cache to coordinate.

Before a hit, the adapter reads the current View's file identity and captures base/rev. The tool rechecks the private proof after its await and before consuming any cached positive or negative. A changed generation or reader falls back to the original read. Metadata and source await boundaries are checked too. This is per-file authority, not an atomic snapshot of an entire multi-file query.

Only fully exhausted original `searchLines` verification can install a record. Breaking for a full content receipt or the first files_with_matches hit leaves no partial record; the scanner does not finish the remaining file just to populate the cache. Count mode and complete content scans can populate it; later output modes use the same complete record. LF splitting, CRLF, invalid UTF-8 replacement, NUL, empty-file and terminal-blank numbering remain the existing JS regex behavior.

Admission requires an owned copy of the intrinsic Uint8Array visible window and a full SHA1/SHA256 Git blob hash match before installation. Caller byteLength/offset/buffer getters and iterators do not supply the window. After exhaustion, hash verification and budget admission, matching lines are detached through an owned UTF-8 encode/decode copy. Source-decoded lines round-trip exactly, and retained small slices cannot keep the entire source string backing alive. Partial and oversized records are not copied for caching. Native regex source and flags are read with intrinsic getters. Global/sticky regex, subclasses, custom exec/test and oversized pattern keys are not cached; their original behavior remains available. The public grep schema still takes its existing pattern field, without adding flags or syntax.

Logical cache bounds are independent: source verification at most 1 MiB; one record at most 64 KiB and 4096 matches; retained records at most 1024 entries and 2 MiB, with LRU eviction. Matching strings are charged by UTF-16 units plus key/row accounting. These are logical retained-data and per-source ceilings, not measured heap/RSS bounds. Original oversized reads/decoding and separate Truth caches retain their existing resource policy. No background work or cache persistence is introduced.

Cold misses add a current-identity stat and an eligible owned copy. Hash work happens only after a complete eligible scan; dense early stopping avoids that hash and cache fill. Source reads and existing batch prefetch remain unchanged on misses, and prefetch is not skipped on hits in this first unit. Paired measurements must retain those costs and adverse workloads before claiming a speed benefit. Default activation, the 16 MiB cold target, genuine provider recordings and strict isolation remain separate gates.

Focused proof:

```sh
node tools/test-entry.js fast src/tools/grep-verifier.test.ts src/tools/grep-options.test.ts src/tools/search-stop.test.ts
```

Controls cover complete-only installation, source/flag keys, stateful/native fallback, intrinsic windows, wrong-address retry, SHA1/SHA256, immutable rows, generation/reader replacement after awaits, source/record ceilings, and independent entry/byte LRU pressure. Actual View/M0 all-mode receipts and paired latency/resource evidence are separate integrated gates.
