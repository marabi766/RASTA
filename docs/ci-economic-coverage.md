# Economic coverage shards (FU-286)

The economic gate keeps both Jest projects and the existing four 90% thresholds.
Three native Jest shards run in separate jobs, each with its own PostgreSQL and
Kafka. Suites remain in band within each leg. A fourth job independently lists
the current Jest inventory, requires all three successful reports, refuses
missing/duplicate/skipped suites and inconsistent coverage source inventories,
and uses Jest 29.7.0's CoverageReporter to merge counters and enforce the unchanged
package configuration. Artifacts come only from the current workflow run.
The required integration aggregate needs both the matrix and the merge job.

Each leg has a seven-minute supervisor inside the existing eight-minute step
limit. On deadline it kills its own child process group, prints the active suite
and the ten slowest completed suites, then fails. Successful legs also print
these timings and upload incremental timings, Jest JSON and Istanbul JSON.
The merge has a two-minute step cap; its job budget is six minutes, including
four for checkout/install/download. Matrix legs budget eight minutes of setup
plus eight for tests. The remaining coverage job's ceiling falls from 92 to 84.
No economic production source, isolation helper, migration or threshold changes.

## Baseline (2026-11-08 through 2026-11-09)

Measured the last 15 main CI runs using `gh run view --json jobs` and `--log`.
Fourteen reached and passed the economic gate; run 42490240845 was cancelled
before it. Every completed gate ran 155 suites. Total gate time: 5,378 seconds;
p50 389.5 seconds; nearest-rank p95 465 seconds; range 312–465 seconds. An eight
minute cap left only 15 seconds above p95. Jest's own total accounts for all but
about 1–2 seconds per run; the logs have no per-suite JSON artifacts or DB spans.

| Main run    | Gate seconds | Jest seconds |
| ----------- | -----------: | -----------: |
| 42490260532 |          459 |      457.582 |
| 42494488302 |          465 |      462.701 |
| 42499118406 |          324 |      322.486 |
| 42504983883 |          356 |      354.034 |
| 42513236555 |          389 |      387.482 |
| 42520734771 |          390 |      388.202 |
| 42548549303 |          329 |      327.553 |
| 42548574020 |          342 |      340.654 |
| 42556440668 |          392 |      390.427 |
| 42561463573 |          416 |      414.161 |
| 42566137442 |          462 |      461.164 |
| 42578591432 |          404 |      402.023 |
| 42585041188 |          338 |      337.007 |
| 42595805013 |          312 |      310.599 |

The ten slowest files by median suite duration across these fourteen runs:

| File (economic-service)                          | p50 seconds | Maximum seconds |
| ------------------------------------------------ | ----------: | --------------: |
| `test/event-flow.int-spec.ts`                    |      26.937 |          27.319 |
| `test/consumer-crash-replay.int-spec.ts`         |      22.176 |          24.267 |
| `test/recorded-source-rollback.int-spec.ts`      |      16.881 |          20.610 |
| `test/outbox-shutdown.int-spec.ts`               |      14.776 |          15.047 |
| `test/settlement-reversal-storage.int-spec.ts`   |      12.115 |          16.445 |
| `test/idempotency-claim-budget.int-spec.ts`      |      10.980 |          11.207 |
| `test/transaction-hold-decision.int-spec.ts`     |       9.210 |          12.264 |
| `test/settlement-creation-proof.int-spec.ts`     |       8.032 |          10.082 |
| `test/commission-pricing-integrity.int-spec.ts`  |       7.782 |           8.461 |
| `test/statement-obligation-rollback.int-spec.ts` |       7.754 |           9.177 |

Jest prints explicit durations for these files (all above its five-second slow
suite threshold). For shorter suites, historical completion-time deltas are only
estimates because reporter/log buffering adds noise. New artifacts record each
suite's `perfStats` directly, avoiding that ambiguity.

Provisioning the databases is a separate step (p50 38 s, max 42 s), as are initial
migrations (p50 16 s, max 22 s) and package builds (p50 10.5 s, max 14 s). They do
not consume the gate's eight minutes. Scratch-schema rollback/rollout suites
intentionally deploy migrations themselves; sharing those would weaken their
isolation. Broker suites include real polling/propagation waits. Instrumentation
and file-local setup are included in Jest's suite totals and cannot be separated
quantitatively from the historical logs. Coverage formatting/finalization is
small: the final suite and report summary occur within roughly one second.

Three legs amortize suite growth without raising the test cap. Setup is repeated
per leg, increasing runner minutes; this is the cost of keeping database and
broker isolation. Marketplace and the other coverage gates retain their commands
and thresholds. PR #1034 is the independently opened timeout stopgap, superseded
by this structural wiring once merged. CI run timings are recorded in PR STATUS.

A local alternating control ran `src/shared/canonical.spec.ts` twice with and
twice without coverage (109/109 tests each, in band). Median wall time was
5.680 s without coverage and 11.729 s with coverage, including collection of
untested sources; suite-only medians were 3.662 s and 3.508 s, respectively.
This small, warm-cache sample measures collection overhead, not the full gate's
instrumentation cost. Train 42597107605 was still reporting passing suites at
10:14:06 and hit its step deadline at 10:14:07, before any Jest summary.
