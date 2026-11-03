# Integration suite sharding: prerequisite and baseline (task 1204 A)

This PR adds independent package discovery to the existing integration validator.
It does **not** split execution or reduce timeouts. The worker size rule requires
a separate follow-up for job provisioning, phase orchestration and command/env
inventory changes. `INTEGRATION_PARTITIONS` currently describes the single,
unfiltered workspace phase; it is checked against manifests, not used to discover
them. Exact commands and aggregate dependency/verdict checks still apply.

Discovery reads every `packages` glob in `pnpm-workspace.yaml`, including future
roots and exclusions. Only workspace manifests declaring `test:integration`
belong to the partition. Root orchestration and installed dependencies are not
workspace members. The empty api-gateway integration project is a member.
Unknown, missing and duplicate assignments, unreadable/malformed manifests and
invalid discovery configuration fail closed. Duplicate workspace names fail too.
The partition declaration is not yet a validator for filtered execution: the
follow-up must bind each package list to the exact effective Turbo filters.

## Pinned baseline

[Main CI run 41496157174](https://github.com/marabi766/RASTA/actions/runs/41496157174),
SHA `ec5ef32cbef6bc848b35112a4ff86089796010c8`, 2026-11-02. Times below are Jest's
reported elapsed seconds in the `Integration tests` step, grouped by Turbo task;
they are concurrent task durations, not serial contributions to the step.

| Package (`@rasta/` omitted)             |                             Seconds |   Files | Passed tests | Skipped tests |
| --------------------------------------- | ----------------------------------: | ------: | -----------: | ------------: |
| analytics-service                       |                              91.278 |      10 |          149 |             0 |
| api-gateway                             | empty project; no Jest elapsed time |       0 |            0 |             0 |
| asset-service                           |                             134.778 |      23 |          291 |             0 |
| audit-service                           |                             155.389 |      20 |          275 |             4 |
| construction-service                    |                             500.147 |      68 |         1118 |             0 |
| contract-service                        |                             434.103 |      27 |          625 |             0 |
| document-service                        |                             108.909 |      13 |          218 |             0 |
| economic-service                        |                             462.796 |      80 |         1192 |             0 |
| fleet-service                           |                             122.094 |      27 |          273 |             0 |
| identity-service                        |                             353.740 |      33 |          399 |             0 |
| inventory-service                       |                             186.609 |      18 |          255 |             0 |
| maintenance-service                     |                              81.454 |      18 |          210 |             0 |
| marketplace-service                     |                             151.276 |      30 |          445 |             0 |
| notification-service                    |                             106.915 |      18 |          157 |             0 |
| organization-service                    |                              34.331 |      10 |          132 |             0 |
| procurement-service                     |                             280.882 |      18 |          207 |             0 |
| supplier-service                        |                              83.242 |      22 |          410 |             0 |
| identity aggregation stress (exclusive) |                              33.388 |       1 |           22 |             0 |
| **Total**                               | concurrent, do not sum as wall time | **436** |     **6378** |         **4** |

The suite step took 636 seconds (GitHub step timestamps). Construction alone is
longer than 50% (318 seconds); the brief's fallback target is therefore 500.147
seconds before candidate measurements. The aggregate critical path from the
integration jobs' start to the aggregate's completion was 1,411 seconds, including
guards and coverage. Summed durations of the five integration jobs plus aggregate:
4,767 seconds = 79.45 runner minutes (unrounded elapsed time, not billing units).
No candidate performance or cost improvement is claimed by this prerequisite.

## Proposed follow-up B (stacked on this PR)

Use four explicit `integration-*` suite jobs, each needing `quality`: construction
alone; economic plus procurement; contract plus inventory, marketplace and audit;
identity plus all remaining workspaces. Their lower bounds from the longest task
are 500.147, 462.796, 434.103 and 353.740 seconds, respectively. These are planning
bounds, **not measured shard durations or chosen timeout caps**. Keep stress inside
the identity shard through `run-test-phases`, after its other tasks exit even on
failure. With a separate PostgreSQL per job, no other shard shares its WAL; docs/14
§ 14.3's exclusivity reasoning and the stress bounds remain applicable.

Retain full provisioning initially, exact suite env, private per-job Kafka
credentials, dependency-only caches, and all database-guard prerequisites. Move
only the workspace suite step; preserve coverage/security/backup gates. Bind each
partition to exact filters, inventory every new env key and literal, update
`check:test-phases`, require every shard in the aggregate, and measure individual
caps and setup cost. Obtain two runs at the final reviewed SHA, compare test
identities and passed/skipped counts including stress and filtered security, then
remove the retired single-step cap/comment. Existing baseline logs give file
identities and totals but do not enumerate every test title; title-level baseline
evidence still needs collection. #374, #376 and #387 are already merged.
