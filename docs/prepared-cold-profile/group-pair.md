# Actual literal-group source comparison

Local after checkpoint `697851ac15e54ef29b3ecc9740e82985334de218` (tree `66d40ad4a2e641a0929fddec4bbf69e5baa25ae0`) versus f7-equivalent product source. Raw recorded before HEAD is `a3fec9256c6b930651218e2ae5b9e2d101e59e18`, which adds only developer evidence over f7. Do not relabel these local graph fingerprints as a later public union certificate.

```
node tools/bench-literal-groups-paired.js --before . --after ../fugue-grouped-literal-queries > /tmp/literal-groups-paired.json
```

Only the imported regex-literal.ts source differs. Exact backend graphs share one immutable generated corpus and the same prebuilt artifact per profile, and use fresh Truth/View/store/verifier handles for each pair. Side order alternates across cases; each case has one fresh query plus one memory repeat, not a randomized statistical matrix. Real actions and preconstruction View/Truth observations preserve original concrete host reader/prefetch identity. Every complete `{ok, output}` result was deep-equal to the plain default-host reference, including dense early-stop receipts. No provider or product edit occurs in this harness.

| Fresh query | Code before→after ms | Mixed before→after ms |
|---|---:|---:|
| `rare(?:_hit)` | 186.59→54.47 | 186.57→44.49 |
| `rare(_hit)` | 143.84→49.40 | 188.96→41.20 |
| unchanged literal `rare_hit` | 48.33→52.35 | 43.16→59.45 |
| dense `dense(?:_hit)` | 23.40→44.78 | 26.48→44.38 |
| quantified fallback `rare(_hit)?` | 150.23→170.28 | 229.18→239.66 |

Sparse groups now use five candidate-filter calls, one controlled artifact read, one source read instead of512, one prefetched ID instead of512, 515 metadata calls instead of1540 and six Git requests instead of10. Group source regex verification remains real: one complete source, 257 tested lines, hash/EOF verification. Same-memory repeated groups reduce1024 current metadata calls to7 and wall time about9–14ms to1.1–3.2ms. There are still five Truth prefetch method calls, carrying one already cached ID collectively, and zero Git requests on the repeat. Readiness does not claim to prove every original batch path cached merely because the cohort filtered most paths.

Artifact bytes and SHA256 are identical to the f7 profile: code466,926 bytes/13ecfb7b…, mixed470,034 bytes/3d97f977…. Parser does not participate in preparation; paid prior-pipeline preparation was630.40/656.95ms with512 source reads and four prefetch batches. Seed and each fresh handle/factory charge are separate in raw.json. The same exact artifact is reused by both sources, with no query-time construction.

Adverse cases remain material. Dense groups now pay a full512-path cohort snapshot plus controlled artifact validation before reading the same first source and prefetched32IDs: metadata34→546, no verifier record installed, about21/18ms slower in these samples. Quantified groups remain unsupported and keep512source/IDs,1540metadata calls and10Git requests; their slower samples are retained, not attributed to a mechanism improvement. Entropy preparation again refuses after147sources and1.409s, writes no artifact, and the grouped after query adds a failed cohort lookup and512metadata calls (1540→2052) while still scanning512sources:500.52→533.96ms. Both graphs' full results match plain.

This is a selective optional-index improvement. New grouped syntax can expose existing prepared-index overhead when selectivity is low or preparation failed. Default stays opt-in. Cold50ms remains unfulfilled: code group54.47ms, unchanged literal52.35/59.45ms and fallback/pressure far exceed the gate. Physical cold is unmeasured; OS/JIT/page-cache/GC effects remain uncontrolled, and logical counters are not RSS or physical bytes. Source safety gates remain independently reviewed and tested by the product owner.

Admission controls: same-source and missing-after reference both reject before any private root is allocated. The executed script SHA256, raw SHA256, helper hashes and complete before/after src manifests are in group-provenance.json.
