# Integration suite sharding (tasks 1204 A / 1224 B / 1236)

Slice B uses four explicit suite jobs, each needing `quality`, with exact package
filters produced by `run-test-phases.mjs --shard=<name>`. The aggregate retains
its required-check name and needs all four jobs plus the existing coverage,
security and backup jobs. Missing, duplicate or unknown packages fail independent
manifest discovery; the validator also checks the runner's effective plan.
FU-027 independently cross-checks partition step-name keys against the suite
command inventory and all workflow jobs, refusing missing, unknown or repeated
steps. The command inventory is not derived from ownership keys.

Every shard provisions the existing complete infrastructure. Services, setup
steps and suite environments use YAML anchors/aliases (no merge keys), supported
by [GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations).
This preserves per-job Kafka credential generation, masking and ACLs, private
bucket setup and the Unix scanner transport. Only dependency caches are reused.
All suite environment keys are inventoried, fixed literals are pinned, and extra
suite environment keys are refused. Missing infrastructure fails validation.

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

## Slice B topology and provisional budgets

| Job                      | Packages                                |            Baseline lower bound | Initial step cap | Job cap |
| ------------------------ | --------------------------------------- | ------------------------------: | ---------------: | ------: |
| integration-suites       | identity and remaining small packages   | 353.740 + 33.388 stress seconds |           13 min |  75 min |
| integration-construction | construction                            |                       500.147 s |           17 min |  25 min |
| integration-economic     | economic, procurement                   |                       462.796 s |           16 min |  24 min |
| integration-contract     | contract, inventory, marketplace, audit |                       434.103 s |           15 min |  23 min |

Initial caps round up twice the longest measured package duration (plus stress
for identity). These are provisional until actual shard durations are available;
they are **not** claims of measured shard performance. The retired 21-minute
single-step inventory and stopgap comment are removed. Each new job adds the
existing 8-minute full-provisioning setup allowance; identity's job retains 54
minutes of guard/connection-step limits plus its 13-minute suite cap and setup.

Stress stays inside the identity job, after all its workspace tasks exit, even
on failure, with the original first-failure exit status. Other shards have their
own PostgreSQL instances, so none shares its WAL. The exclusivity reasoning in
docs/14 § 14.3 and stress bounds still hold. Test caching remains disabled by
`turbo.json`; the unsharded, filtered security selection is unchanged. Suite steps and the
filtered security integration run add `--verbose` solely to expose file/test names
in candidate logs; no selection or assertion changes.

No coverage or security steps moved. All database guards, their full database
provisioning and migrations stay in `integration-suites`. An explicit shared
package build now precedes its suite step, so guards never depend on incidental
build outputs from unrelated workspaces. The backup-drill exemption is unchanged.

## Evidence still required before acceptance

#591 has merged and #594 now targets `main`, so final-head CI can run. Full test-title
baseline evidence also remains unavailable in the archived baseline logs. Do not
infer identity equality from the same file/test totals. The expected partition
of the archived baseline, not an observed candidate result, is:

| Shard        | Files including stress | Passed tests | Skipped tests |
| ------------ | ---------------------: | -----------: | ------------: |
| identity     |                    175 |         2261 |             0 |
| construction |                     68 |         1118 |             0 |
| economic     |                     98 |         1399 |             0 |
| contract     |                     95 |         1600 |             4 |
| Total        |                    436 |         6378 |             4 |

Acceptance requires two full runs at the final reviewed head, complete file/test
identities and passed/skipped counts including stress and filtered security,
measured per-step durations, aggregate critical path and summed integration runner
minutes. Three extra complete setup sequences increase runner cost; no candidate
performance or cost improvement is claimed without those runs. #374, #376 and
#387 are merged and their behavior is preserved.
