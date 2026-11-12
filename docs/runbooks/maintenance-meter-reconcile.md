# Maintenance meter reconciliation (ADR-073 PR 7b)

7b-2b-i adds **per-asset apply**, stacked on the 7b-2a source certificate.
The authoritative full inventory, persisted full-run marker and serialized
first-meter initialization remain for 7b-2b-ii. New assets still start LEGACY;
this slice never authorizes offline rollout or infers completion from gauge zero.

Build maintenance-service, provide its normal runtime environment plus
`FLEET_SERVICE_URL`, then run from the workspace root:

```sh
pnpm --filter @rasta/maintenance-service maintenance-meter-reconcile --organization-id ORG_ID --dry-run
pnpm --filter @rasta/maintenance-service maintenance-meter-reconcile --organization-id ORG_ID --apply
```

Default is dry-run. Use the runtime role, never the migrator. The CLI starts no
consumers or relay: the normal fleet relay and maintenance usage consumer must
remain deployed and their backlog/DLQ monitored. Deploy the complete-interval
fleet writer and PR 7a ledger consumer before applying; retain their outbox facts
until acknowledged. Do not roll those writers back during cutover.
Run separately per tenant and protect the JSON as operational tenant data.
Exit 1 always means the global rollout remains incomplete, including an empty
inventory or successful per-asset apply; exit 2 means invocation/configuration/
inventory failure. Inspect every asset outcome and refusal.

Reports contain tenant, asset, under-lock M, fresh L, exact decimal diff (L - M),
record count, snapshot marker, snapshotVerified and tenant-owned schedule IDs.
The local asset replica plus orphan meters is only an operator inventory;
it is not authoritative source-wide enumeration. Top-level sourceComplete stays
false. An asset's sourceComplete is true only after verified apply commits.
Dry-run rolls back all staging, never announces, and keeps sourceComplete false.
The inherited preview refusal code CUTOVER_PROOF_REQUIRED means no cutover was
committed. Live page-only sources remain preview-only, never apply fallbacks.

## Certificate and durable handoff

Fleet's authenticated maintenance-only certificate fixes pg_current_snapshot()
and all asset facts in one REPEATABLE READ transaction. The manifest contains
identities and eight minimal physical fact fields across historical owners,
with canonical exact decimal/UTC SHA-256 equality. More than 20,000 facts,
malformed source data, the 16-MiB response ceiling or exchange deadline refuses.
The digest is not a signature or an authorization token.

The source write invariant is UsageService.record: its sole production usage
insert and complete USAGE_RECORDED enqueue share one repository transaction.
Usage facts have no production update/delete path; assignment/driver reference
changes do not change the certified physical fields. Demo seeds (guarded by
assertDemoSeedAllowed/assertDemoSeedDatabase) and administrator SQL are outside
this live-write contract; never run them on a cutover dataset. A transaction excluded by
the snapshot (including a backdated one) therefore commits its complete durable
outbox envelope together with its usage fact. Relay delivery is at least once;
maintenance entry identity and processed_event make the resulting fold exactly
once. This requires eventual relay/consumer progress, not an empty backlog at
snapshot time. Unresolved old interval-less events/facts refuse; never guess or
rewrite their history. Resolve the producer/replay evidence before retrying.

Apply stages facts **before** lockUsageMeter, verifies the exact ledger set
**under** that lock, calculates current L with the shared fold, and commits
LEDGER, both counters and ledger metadata in the same transaction. There are no
fact inserts or uniqueness waits after the meter lock. Ordering for a fact
excluded by the certificate is exhaustive:

- Its maintenance transaction commits before verification: its extra identity
  causes SOURCE_LEDGER_MISMATCH and rollback; a LEGACY asset remains LEGACY.
- Its transaction has not committed when verification reads: it must acquire
  the same meter lock after apply commits, read LEDGER there, and recompute L.
- A certificate fact is already inserted by an uncommitted live transaction:
  staging awaits that uniqueness conflict before taking the meter lock. The
  live transaction finishes first and apply recomputes from the resulting set.

These orders cover a live insert paused before its meter lock, in either queue
order, without a meter/fact lock cycle. No dry-run value is reused. Missing,
conflicting, incomplete or unavailable proof refuses that asset. Repeated apply
recomputes the same set; it does not add deltas again. Existing LEDGER assets
are never demoted by refusal. APPLIED is reported only after confirmed commit;
APPLY_UNCONFIRMED means a lost transaction result may have committed: inspect
and rerun verification, never assume LEGACY or an untouched counter.
announceForAsset runs in tenant context after commit. ANNOUNCEMENT_UNCONFIRMED
preserves the confirmed meter and can be retried by apply or the normal scan;
previous announcements are not retracted. Review L < M with maintenance staff.

Real PostgreSQL regressions use fleet's actual UsageService, PrismaOutboxStore
and OutboxRelay in a separate process, with HTTP test delivery to the actual
maintenance consumer. They cover covered spill 100, both live orders, both r3
insert-before-lock orders (102, never 104), fresh apply, replay, tenant reports,
post-snapshot tail/backdated commits, and lost commit/announcement results.
The test transport replaces Kafka only; normal CI Kafka suites remain required.

## Gauge and rollback

The background gauge samples every 30 seconds with one outstanding read,
1-second acquisition/statement limits, 2-second transaction and 5-second sampling
deadline. Scrapes publish cached count and monotonic sample age. Failure removes
both series as unknown; late results are discarded and shared shutdown owns its
deadline. It counts local replicas plus orphan meters without LEDGER. Zero is
never proof of complete authoritative inventory or a persisted full-run marker.

Before apply, image rollback retains PR 7a schema/data. After any apply, keep
ledger facts and run an image that understands LEDGER; retain the full-run marker
once 7b-2b-ii introduces it. Never reset modes to LEGACY, delete facts/processed
markers or run schema down: arrival-order folding can double-count covered or
replayed usage. Pause rollout, preserve evidence, repair source/delivery issues,
and rerun verified apply. Full rollout still requires the separately persisted
marker and its first-meter race proof; this PR neither writes nor infers it.
