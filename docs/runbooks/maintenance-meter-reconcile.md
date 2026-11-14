# Maintenance meter reconciliation (ADR-073 PR 7b)

7b-2b-i adds **per-asset apply**, stacked on the 7b-2a source certificate.
The authoritative full inventory, persisted full-run marker and serialized
first-meter initialization remain for 7b-2b-ii. New assets still start LEGACY;
this slice never authorizes offline rollout or infers completion from gauge zero.

Build maintenance-service, provide its normal runtime environment plus
`FLEET_SERVICE_URL`. Apply also requires `METER_RECONCILE_OPERATOR_ID`, the
configured operator platform ID (printable ASCII, 1–256 characters); missing or
malformed identity refuses before database access. Then run from the workspace root:

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

Every applied meter transition enqueues `MAINTENANCE_METER_RECONCILED` v1 in
that meter transaction, even with no due schedules. Audit retains previous/new
mode, exact counters and ledger metadata, certificate digest, snapshot, run ID
and operator. Replay compares the state under the shared lock: unchanged state
(including timestamp-only repeats) emits nothing; a later actual transition
produces fresh evidence. The run ID is also the event correlation ID.
Snapshot markers over 2,000 characters refuse apply to preserve audit's scalar
bounds; dry-run still accepts the source certificate's larger marker limit.
The normal maintenance outbox relay and audit domain projector must be running.

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

## Full-run activation acceptance contract (implementation still blocked)

The full-run follow-up must persist its authoritative inventory, per-asset
outcomes and explicit refusals before activating a durable marker. The local
replica scan, a collection of per-asset certificates, an empty tenant report
and a zero gauge cannot establish inventory exhaustion. An unavailable or
unproven owner inventory must refuse activation, including after restart.
Historical/transferred source usage and local orphan meters must be accounted
for; the owner inventory must define which concurrent asset creations belong
to the run. No operator flag may substitute for that proof.

Activation must recheck durable modes and outcomes while serialized against
every production first-meter insertion. Prove both PostgreSQL race orders:
an earlier LEGACY insertion is included in the final check or blocks activation;
an insertion following activation observes the committed marker. An explicitly
refused pre-existing asset must retain its LEGACY treatment even if its first
meter is created later. Only proven new assets may start LEDGER. Unknown apply
results require durable reconciliation and must not silently become refusals.

The serialization must preserve the existing fact-insert-before-meter-lock
order and both r3 regressions (102, never 104). Test restart, lost activation
responses, explicit refusals and unavailable inventory against real PostgreSQL.
The full-run marker and each per-asset cutover also require transactional audit
evidence; a conditional MAINTENANCE_DUE announcement is not cutover evidence.

After activation, rollback retains the inventory, refusals, marker, ledger facts,
processed-event markers and transactional cutover evidence. Keep a LEDGER-aware
image that also honors the marker and refused-asset bootstrap rules. If no such
image is available, pause rollout instead of resetting modes, removing the
marker or running schema down. Gauge zero remains an additional rollout check,
never authority to activate or erase the marker.

## Full-run marker foundation (not operational rollout)

The `MeterFullRun` operator primitive persists the sealed inventory, explicit
refusals, marker and `MAINTENANCE_METER_FULL_RUN_ACTIVATED` outbox evidence in one
transaction. A PostgreSQL `BEFORE INSERT` trigger on `asset_usage_meter` takes
`FOR SHARE` on the `meter_full_run` row and assigns the first mode, overriding
explicit modes as well as omitted values. There is no LEGACY column default.
This covers old images, seeds, model API and future inserts; missing gate state
raises `FULL_RUN_GATE_MISSING`. Activation takes the exclusive gate lock before
the final check of locally visible facts/meters/replicas. `asset_ref` replication
itself is not fenced; the owner seal must prove full source completeness.
Refused physical assets remain LEGACY on first creation even after an ownership
change. Unseen assets start LEDGER only after the durable marker commits.
Missing fence state refuses processing; gauge zero never activates anything.

This slice has **no production inventory authority or CLI activation path**.
The constructor without an authority refuses `AUTHORITATIVE_INVENTORY_REQUIRED`.
The stacked follow-up must implement the trusted owner adapter's
`withSealedInventory(runId, commit)` contract: durably retain and re-serve the
same seal for each run, including its original boundary and ownership rows;
all physical assets, historical/transferred fleet
usage and a fenced future-creation boundary held through maintenance commit.
A caller manifest, replica pagination or per-asset certificates cannot implement
that contract. The PostgreSQL tests inject a synthetic sealed inventory to test
the maintenance transaction and races; they do not prove source completeness.
The activation inventory is persisted atomically, not a resumable progress log;
source sealing, durable pre-activation progress/refusals and CLI reporting remain
in the follow-up. Sealed inventories and explicit refusal lists are capped at
20,000 assets; overflow refuses activation without truncation. Until then keep
operational rollout disabled.

Operator IDs use the same configured, self-asserted identity as per-asset apply;
they are attributable operational configuration, not identity-service verification.
The global activation audit event has no tenant and does not disclose the
per-asset inventory. No tenant request may invoke the global primitive.
After activation, schema-down refuses `ACTIVE_METER_FULL_RUN_ROLLBACK_REFUSED`.
Retain the marker, refusal inventory, facts, processed markers and outbox;
rollback only to an image honoring the creation fence and refusals.

After a lost response, use `MeterFullRun.status(runId, operatorId)` without an
authority to read the stored digest, source boundary, asset count and refusal
count. It rejects ambient tenant contexts and mismatched run/operator IDs.
A replay with the same run/operator but a changed seal or refusals returns
`ALREADY_ACTIVE_INVENTORY_DRIFT`; reconcile the stored evidence instead of
starting a new run. Definite failures before the Prisma transaction callback
returns (pool acquisition, statement failure or callback timeout) refuse with
`FULL_RUN_PRECOMMIT_FAILED`. Failures once commit is possible remain
`FULL_RUN_UNCONFIRMED`, including loss of the owner-fence release response.

The singleton share lock remains held until each inserting fold commits,
including `ON CONFLICT` on an existing meter. The concurrent-fold race test
records a bounded synthetic measurement, not a production throughput guarantee
or starvation proof. Schedule eventual activation in a maintenance window with
usage consumers and reconcile/preview runs paused/drained; resume only after status confirms the marker.
Active schema-down refuses to remove this database fence.

### Fleet source seal (operator primitive; activation remains disabled)

`FleetMeterInventorySeal.seal(runId, operatorId)` enumerates all physical asset
identities in fleet's replica, usage, assignments, availability, transfer fences,
transfer releases and pending insurance, including historical owners and orphans.
It refuses ambiguous ownership or more than 20,000 assets. One transaction takes
SHARE locks on all seven source tables, locks the singleton gate, persists the
inventory and boundary, and enqueues `FLEET_METER_INVENTORY_SEALED` on
`rasta.fleet.v1` (platform stream `meter-inventory-seal`). The global audit carries
only the digest, boundary, count, run and configured operator, never the inventory.

The durable database fence covers INSERT and UPDATE from old images, direct SQL,
replication and future writers on these seven tables. Once sealed, new physical
asset identities refuse `SOURCE_INVENTORY_SEALED`; existing identities may continue
writing. Missing gates and non-READ-COMMITTED writes refuse. Pause asset creation
and drain source writers before sealing. This deliberately blocks future creation
until a later reviewed protocol can coordinate reopening with maintenance; this
slice provides no release, expiry or automatic activation. Schema-down refuses an
active source seal. Do not operate this primitive in production yet.

The fence binds the asset/organization pair through indexed, immutable
`meter_inventory_seal_asset` rows. Owner updates and inserts under another owner
refuse `SOURCE_OWNER_DRIFT`, including a replica INSERT for a known orphan.
Historical rows, including foreign-owner parked insurance, may update non-identity
fields. An UPDATE preserving both the asset key and organization is allowed;
INSERTs and every identity change must match the sealed pair. The parked sweep
can count attempts and mark rows due without changing their accepted identity.
Sealing refuses immediately with `SOURCE_WRITERS_ACTIVE` when a source writer
holds conflicting locks; drain writers and retry the same run. Replay takes no
source-table locks. The operator transaction must use READ COMMITTED.
The owner-fence migration refuses an already-active legacy seal as
`SOURCE_SEAL_UPGRADE_REFUSED`: its ownership may already have drifted. Active down
refuses `SEALED_SOURCE_ROLLBACK_REFUSED`; no automatic repair or reopening exists.

Before applying or rolling back `20261113220000_meter_inventory_owner_fence`,
pause all fleet source writers (consumers, parked sweep, API commands and seeds),
then wait for their transactions to drain. Its existing ACCESS EXCLUSIVE NOWAIT
gate lock conflicts with each in-flight writer's FOR SHARE lock. Keep that applied
migration unchanged to preserve recorded checksums; a later migration cannot fix
its earlier lock acquisition. A refusal aborts the entire transaction: retry only
after draining, never bypass the lock. The identity-update follow-up instead waits
up to `lock_timeout = '5s'` for the gate; timeout still aborts atomically.

Malformed source rows refuse `SOURCE_INVENTORY_MALFORMED`; malformed stored inventory
refuses `SOURCE_SEAL_INVALID`. Pool, statement and callback failures proven before
commit refuse `SOURCE_SEAL_PRECOMMIT_FAILED`. Ambiguous or post-callback failures
remain `SOURCE_SEAL_UNCONFIRMED`; no failure implies success. The mode trigger pins
`search_path` to `pg_catalog, pg_temp`; its down migration refuses an active full
run or any LEDGER meter (`ACTIVE_METER_MODE_ROLLBACK_REFUSED`).

Replay the SAME run and operator after `SOURCE_SEAL_UNCONFIRMED`: it re-serves the
immutable pair inventory after a lost commit response. A different run
or operator refuses `SOURCE_SEAL_CONFLICT`. Ambient request/service contexts are
refused. Operator identity is configured and self-asserted, as for per-asset apply.
A REST authority adapter, durable pre-activation per-asset progress/refusals,
reconciliation/reporting and the explicit activation CLI remain separate work.
Fleet sealing proves its own source inventory; it does not attest an undrained
asset-service stream. That cross-service completeness check remains required
before wiring the production authority.

Per-asset apply refuses oversized snapshots as `SNAPSHOT_NOT_AUDITABLE` and invalid
post-lock audit payloads as `CUTOVER_AUDIT_INVALID`; neither is an ambiguous commit.
