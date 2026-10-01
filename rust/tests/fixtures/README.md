# Standalone topology differential fixture

`merge-accept-0.2.3.ts` is an unmodified copy of upstream `src/merge/accept.ts`
at commit `633a6b2fb63da459074f1077f92ac8fbfc839416` (Fugue 0.2.3).
It retains the upstream MIT license and source comments.

SHA-256: `ad22ea3def9362aece17c784e574d9010633cafc554592ad0c6225e8eec2217c`

The explicit Node oracle reads this local fixture, verifies the hash, and rewrites
only import locations in a temporary copy. It never reads the source checkout's
`.git`, fetches a revision, or uses the network. System Git is used only for the
temporary repositories under test.

The runtime dependency files `src/contract/types.ts`, `src/delta.ts`,
`src/materialize/diffstat.ts`, `src/merge/merge.ts`, `src/truth/truth.ts`, and
`src/truth/git.ts` are byte-identical between the original source baseline
`09e591713db066a3b899daea16d4b9492742f5ff` and the pinned 0.2.3 commit. The remaining
direct imports are type-only and also unchanged. These files remain in the
source archive, so no separate Git bundle is required to run the oracle.

Run `cargo test --test merge_topology -- --include-ignored`. Node 24 is required
only for the explicit differential case; the Rust product never invokes it.

Parity is checked for the new directory-to-symlink landing and nested preserved
prefix refusal. Rust additionally rejects untracked descendants rather than
recursively deleting them, and supports file/symlink-to-directory transactions
with recoverable directory metadata. Those are deliberate stronger boundaries.
