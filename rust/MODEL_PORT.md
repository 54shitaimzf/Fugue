# Native model continuation and recovery

The Rust runtime uses native Anthropic/OpenAI streaming codecs and native tools. It does not invoke Node for product behavior. Tests use bounded offline replay or pure differential oracles; no paid or external network requests are made.

## Implemented recovery

- Durable initial assembly, binding fingerprint, logical agent identity, completed model response, tool intents/receipts, turns, aggregate usage, calibration samples, handoffs and terminal session outcomes
- Automatic continuation of an incomplete matching session. Completed tool receipts are consumed from the journal rather than invoking those tools again. Read-only interrupted tools may be repeated safely; an interrupted mutating intent without a receipt stops explicitly as ambiguous
- A successfully logged decoded response survives a crash before tools or before the step-state receipt. A completed tool receipt survives a crash before the enclosing turn receipt
- Prior unresolved tool/model effects are inspected before accepting a changed binding. Changing model, contract or goal cannot silently discard that uncertainty; an explicit new-session control follows review.
- An interrupted live request without a durable complete response never causes an automatic paid resend. Recovery stops as `ambiguous-model-call`, without needing credentials. Starting a new session is an explicit API control
- Same model target, protocol, scope and branch across mechanical handoff. A successor has a new logical agent identifier while the original physical writer remains the owner of View/Git events and the branch. This prevents a new writer from accidentally losing the prior view or landing on another ref
- Handoff prompts enter the successor's B zone; old turn history is cleared from C. A remains stable, the new B is stable across the successor's steps, and subsequent C grows from new receipts. No round state is changed by handoff
- Context planning uses one upstream-compatible byte estimator and the upper median of the most recent eight finite positive truth/estimate ratios. Truth sums only the supplied input/cache-read/cache-write counts; missing counts remain unknown
- The full handoff prompt and successor prefix are checked before a restart. Oversized handoffs are refused without truncation. Handoffs default to one and have an explicit maximum of sixteen
- Shared physical call numbering persists across resumed sessions, handoffs and fresh verification retries on the same writer. Retry attempts belong to one call number and reuse the exact encoded request bytes
- Configured provider retries validate `count`, `on` and `timeout`, allow at most sixteen extra attempts, record every attempt's status/body hash, and never run tools from incomplete/failed attempts. Decoder/wire failures are not retried as transport timeouts
- HTTP parsing handles bounded informational headers and requires exactly one final SSE content type. HTTPS transport remains bounded and credentials are sent through the curl configuration pipe, never argv or journal events
- Verification feedback is added only to dynamic runtime/C, without broadening contract ownership or altering the frozen goal/B. Holder checkpoint/writeback restrictions remain in force
- Journal-capacity preflight reserves a conservative recovery margin before tool effects. Per-writer runtime locks prevent simultaneous independent model loops on that writer

## Controls and evidence

API options `resume: true` return a completed matching session without another call; `new-session: true` deliberately starts new context on the same preserved branch. `max-steps` bounds cumulative steps of a continuing session. `max-handoffs` bounds logical successors; `no-handoff` disables them. Provider retry declarations are read from the existing authoritative model catalog. `catalog_with_config` uses the supplied configuration without a second read and reports the insertion-order-authoritative `defaultModel`.

Native tests cover real virtual writes with no host worktree mutation, continued replay without duplicate revisions, receipt-gap recovery, ambiguous mutation refusal, preserved branches across logical successors, shared replay numbering, dynamic verification feedback, calibrated budgets and exact fractional journal/Node canonicalization. Pure tests cover retries and HTTP framing. Existing wire-codec and recorded upstream request/response fixtures remain byte-exact where the supported protocol is unchanged.

## Exact limitations

This is bounded continuation, not a distributed exactly-once transaction across a remote model and filesystem. A crash after a mutation but before its receipt is deliberately ambiguous; there is no automatic claim that the effect did or did not happen. A live call interrupted before a durable reply likewise has unknown billing/completion.

Pre-recovery journals that lack durable response arguments/assembly state cannot safely reconstruct an incomplete context. They stop as `legacy-context-unavailable` instead of silently replaying effects; outputs and refs remain preserved. The user can explicitly start new context after reviewing those outputs. Completed older sessions can still start fresh work normally.

A logical successor shares the original View/journal writer, not a newly spawned operating-system worker or new Git branch. There is no unverified alias-ref migration. Static A/B assembly remains pinned when continuing. An explicit changed step cap creates a durable trusted C/cHead notice that supersedes the original cap and all older remaining-step warnings.

The ordinary repository journal has a 64-MiB byte limit. Capacity exhaustion is a real blocker, not success, and this code does not delete/compact source journals or silently discard turns. Dump artifacts are immutable evidence and are never overwritten. Successful actual network transport and a capable-kernel sandbox execution path are not claimed by offline tests.

## Holder conversation integration

The native Idle discussion path archives user/assistant text in the authoritative round journal and projects the original {who,text} JSONL/recent-three format. Planning revisions retain the pinned intent goal, put the new instruction in C, require a current-session artifact, and land a digest/against version without archiving a second raw instruction. Only Idle/Planning accept say. Model state/binding includes the initial recent/distill/current-human context; incomplete effects remain review-required. The session path is a read-only derived control-plane projection, never a physical file or Git/main entry.
