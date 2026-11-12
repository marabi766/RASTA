# Maintenance meter reconciliation (ADR-073 PR 7b)

PR 7b-1 supplies a **read-only preview**, not permission to enable offline usage.
PR 7b-2 must add the source completeness fence, apply transaction and full-run
marker. Existing and newly discovered assets still start in `LEGACY`.

Build maintenance-service, provide its normal runtime environment plus
`FLEET_SERVICE_URL`, then run from the workspace root:

```sh
pnpm --filter @rasta/maintenance-service maintenance-meter-reconcile --organization-id ORG_ID
# Equivalent explicit preview:
pnpm --filter @rasta/maintenance-service maintenance-meter-reconcile --organization-id ORG_ID --dry-run
```

Use the maintenance runtime role, never the migrator. Connection settings and
internal tokens come from the environment. The CLI starts no consumers or relay.
Run separately for each tenant; protect the JSON as operational tenant data.
Exit 1 means preview only (including an empty inventory); exit 2 means invocation,
configuration or inventory failure. Review every asset's refusal, not just exit status.
`--apply` is refused before configuration or database access in this slice.

The report contains tenant, asset, current `M`, candidate `L`, signed exact decimal
`diff` (`L - M`), and tenant-owned schedule IDs that would announce at the report's
single UTC instant. It never publishes announcements. Source pages are validated,
followed through empty intermediate pages, and bounded to 1,000 pages / 20,000
records per asset. Missing/repeated cursors, duplicate IDs, unreadable/malformed
facts and limits refuse the asset without a partial `L`. Candidate calculation
uses the existing ledger helpers inside an intentionally rolled-back transaction;
no ledger entry, missing meter, mode, marker, schedule or outbox change survives.
Historical entries with missing interval endpoints or conflicting facts are refused;
this slice never guesses or overwrites them. Resolve from fleet in PR 7b-2 or keep
that asset `LEGACY`.

The inventory is the local asset replica plus orphan usage meters, partitioned by
current local ownership. It is not authoritative fleet-wide asset enumeration.
`pagesExhausted=true` only means the traversal ended. `sourceComplete=false` is
always explicit, even for matching counts, repeated scans or an empty response.
The live `(period_end,id)` cursor in PR 9 has no snapshot/future-write fence.

| Interleaving                                                 | What this preview proves / safe outcome                                                                                                                                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical covered +2 and anchor 100 both observed           | Candidate is 100, not 102; persisted M and LEGACY mode stay unchanged.                                                                                                                                         |
| Live event commits before the preview takes the meter lock   | Existing ledger rows and M are read under the shared lock; candidate is advisory.                                                                                                                              |
| Live event inserts a row, then pauses before the meter lock  | Preview stages facts before taking the meter lock, matching the live insert/lock order. A conflicting uncommitted fact is awaited first; there is no opposite meter/fact lock cycle. No cutover is authorized. |
| Preview holds the lock before live event                     | Preview rolls back before releasing the lock. No marker or mode has changed.                                                                                                                                   |
| Tail/backdated source insert commits after its page was read | It can be absent from the traversal. Asset remains LEGACY; exhausted pages never certify completeness.                                                                                                         |
| Source write commits after the final page or after preview   | Same refusal. A dry-run value must never be reused by apply.                                                                                                                                                   |

Review diff and refused assets now. The remaining rollout sequence is gated:
**dry-run → review → proven apply (PR 7b-2) → verify gauge 0 plus the full-run marker**.
Before shipping apply, prove every pre/during/post-sweep usage reaches the ledger
exactly once, including both r3 insert-before-lock orders, and recompute current L
under `lockUsageMeter` before changing mode. A source-owned consistent snapshot
plus a durable live-write handoff, or an equally strong fence, is required; counts,
terminal cursors or matching repeated scans alone cannot establish this. Only a
complete authoritative full run may enable LEDGER initialization for new assets.

`maintenance_meter_legacy_assets` uses maintenance's existing Prometheus registry.
It counts the union of local asset replicas and meters without a verified LEDGER
mode, including missing meter rows. It has no tenant/asset labels. Reads occur on
scrape; failed reads remove the series (unknown, never zero). It is stopped and
awaited by the shared shutdown coordinator. Zero covers only known local assets;
**zero alone is not evidence of inventory completeness or a successful cutover**.

Rollback before any apply: revert this image while retaining PR 7a schema/data;
previews have no durable writes. After a future apply: keep ledger facts and the
cutover marker, and run an image that understands LEDGER. Switching mode back to
LEGACY is never automatic or a safe generic rollback: the old arrival-order fold
can double-count covered/replayed usage and does not reconstruct the prior state.
Pause rollout, preserve evidence, repair the completeness/fact issue, and rerun a
verified apply; do not delete entries, reset event markers, run schema down, or
change modes as an operational shortcut.
