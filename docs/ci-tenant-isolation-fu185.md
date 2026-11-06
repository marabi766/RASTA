# Tenant isolation timing — FU-185

Measured 2026-11-06 with `gh run list`, `gh api .../actions/runs/<id>/jobs?per_page=100`
and `gh run view <id> --job <job-id> --log`. Fixed window: the latest 20
**successful main push runs at collection**, 2026-11-05 19:14 through
2026-11-06 21:19 UTC (42091919570..42295730635). These are not the mixed
PR/train/main runs used for FU-165's 540 s median. This main-only median is 520 s.
Every intervening non-success is listed below. Run IDs link to raw logs/jobs.

Command boundaries use `[test-phases] workspace phase started` timestamps embedded
in logs, rather than Turbo's buffered per-package log delivery times. Unit time
ends at the integration start; integration time ends at the step completion and
includes the exclusive identity stress phase. Rounding and shell/pnpm startup
explain the small difference from the API's whole-second step duration.
Setup is the sum of **all steps without an explicit timeout**, including container
initialization, broker startup, post actions and teardown; it excludes the six
limited security steps. Do not use the old monolithic job's other test steps as
"setup". Quantiles are nearest-rank, rank ceil(0.95 * 20) = 19.

| Metric (seconds)                      |  Median |     p95 | Maximum |
| ------------------------------------- | ------: | ------: | ------: |
| Whole old isolation step              |     520 |     572 |     588 |
| Duplicate unit command                | 207.257 | 230.901 | 236.040 |
| Integration command, including stress | 309.756 | 348.708 | 351.259 |
| Unbounded setup steps                 |   302.5 |     320 |     323 |

The new isolation cap is 480 s: 37.7% over p95 and 36.7% over the observed maximum.
Setup allowance is 420 s: 31.3% over p95 and 30.0% over maximum
(`ceil(1.3 * 323 / 60) = 7` minutes). Job budget: 8 + 8 + 5 + 3 * 2 + 7 = 34 min.
These are observational limits, not an assertion that future runs cannot exceed them.

## Successful main sample

| Run                                                                        | Head      |  Unit s | Integration s | Whole step s | Setup s |
| -------------------------------------------------------------------------- | --------- | ------: | ------------: | -----------: | ------: |
| [42091919570](https://github.com/marabi766/RASTA/actions/runs/42091919570) | 727bf274e | 159.369 |       249.874 |          410 |     266 |
| [42100832490](https://github.com/marabi766/RASTA/actions/runs/42100832490) | 8c1aca939 | 161.891 |       263.032 |          426 |     271 |
| [42111105730](https://github.com/marabi766/RASTA/actions/runs/42111105730) | a8e2c7670 | 136.491 |       209.444 |          347 |     238 |
| [42119705227](https://github.com/marabi766/RASTA/actions/runs/42119705227) | 4f4597c2d | 204.465 |       307.470 |          513 |     298 |
| [42125381899](https://github.com/marabi766/RASTA/actions/runs/42125381899) | 5c0ddc77d | 196.330 |       291.708 |          489 |     300 |
| [42132263175](https://github.com/marabi766/RASTA/actions/runs/42132263175) | 6a86f6510 | 210.049 |       317.051 |          528 |     306 |
| [42147345839](https://github.com/marabi766/RASTA/actions/runs/42147345839) | f7942ed4b | 124.150 |       204.486 |          329 |     224 |
| [42162604734](https://github.com/marabi766/RASTA/actions/runs/42162604734) | 404ca40b2 | 222.049 |       348.708 |          572 |     323 |
| [42169365733](https://github.com/marabi766/RASTA/actions/runs/42169365733) | 4ee799c6b | 163.983 |       278.582 |          444 |     277 |
| [42176049944](https://github.com/marabi766/RASTA/actions/runs/42176049944) | c72dea5b6 | 225.945 |       318.776 |          546 |     313 |
| [42195109616](https://github.com/marabi766/RASTA/actions/runs/42195109616) | 923a2d065 | 213.669 |       312.041 |          527 |     314 |
| [42202098189](https://github.com/marabi766/RASTA/actions/runs/42202098189) | 10b645eaf | 172.892 |       256.763 |          431 |     257 |
| [42211260281](https://github.com/marabi766/RASTA/actions/runs/42211260281) | b0943837c | 236.040 |       351.259 |          588 |     318 |
| [42224269254](https://github.com/marabi766/RASTA/actions/runs/42224269254) | a6afef6da | 226.308 |       336.887 |          564 |     314 |
| [42235909934](https://github.com/marabi766/RASTA/actions/runs/42235909934) | 2ea19ba46 | 177.540 |       299.068 |          478 |     282 |
| [42255340666](https://github.com/marabi766/RASTA/actions/runs/42255340666) | 453371f85 | 230.901 |       329.021 |          561 |     320 |
| [42262683328](https://github.com/marabi766/RASTA/actions/runs/42262683328) | 787242925 | 228.310 |       320.500 |          550 |     308 |
| [42275833624](https://github.com/marabi766/RASTA/actions/runs/42275833624) | 4926256ad | 145.785 |       227.868 |          375 |     264 |
| [42286179671](https://github.com/marabi766/RASTA/actions/runs/42286179671) | 17e8b2143 | 227.266 |       344.006 |          572 |     305 |
| [42295730635](https://github.com/marabi766/RASTA/actions/runs/42295730635) | 3dc724eae | 222.500 |       343.191 |          567 |     313 |

## Exclusions, failures and censoring

No isolation step in this fixed main window was cancelled or timed out; all
reached isolation steps succeeded. Failed whole runs are not failed isolation
steps. For the three retried runs (42202098189, 42235909934, 42184150509),
`attempts/1/jobs` was also checked: isolation succeeded on attempt 1. The latest
jobs endpoint reuses these successful jobs when only failed jobs are rerun.
Attempt-1 failures were respectively unit tests, portal browser tests and image
scans; no isolation timeout is hidden by a retry. The 20 successful-run sample
uses the latest attempt's successful isolation job once per run.

| Run                                                                        | Conclusion at collection | Isolation disposition                                                                 |
| -------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| [42100755927](https://github.com/marabi766/RASTA/actions/runs/42100755927) | cancelled                | Job cancelled before any step started (0 steps)                                       |
| [42100792482](https://github.com/marabi766/RASTA/actions/runs/42100792482) | cancelled                | No isolation job started                                                              |
| [42111067196](https://github.com/marabi766/RASTA/actions/runs/42111067196) | cancelled                | Job cancelled before any step started (0 steps)                                       |
| [42132235528](https://github.com/marabi766/RASTA/actions/runs/42132235528) | cancelled                | Job cancelled before any step started (0 steps)                                       |
| [42147297802](https://github.com/marabi766/RASTA/actions/runs/42147297802) | cancelled                | Job cancelled before any step started (0 steps)                                       |
| [42147321848](https://github.com/marabi766/RASTA/actions/runs/42147321848) | cancelled                | No isolation job started                                                              |
| [42162557202](https://github.com/marabi766/RASTA/actions/runs/42162557202) | cancelled                | Job cancelled before any step started (0 steps)                                       |
| [42162580019](https://github.com/marabi766/RASTA/actions/runs/42162580019) | cancelled                | No isolation job started                                                              |
| [42169317956](https://github.com/marabi766/RASTA/actions/runs/42169317956) | cancelled                | Job cancelled before any step started (0 steps)                                       |
| [42169342046](https://github.com/marabi766/RASTA/actions/runs/42169342046) | cancelled                | No isolation job started                                                              |
| [42184098682](https://github.com/marabi766/RASTA/actions/runs/42184098682) | cancelled                | Job cancelled before any step started (0 steps)                                       |
| [42184124901](https://github.com/marabi766/RASTA/actions/runs/42184124901) | cancelled                | No isolation job started                                                              |
| [42184150509](https://github.com/marabi766/RASTA/actions/runs/42184150509) | failure                  | Succeeded (457 s); image scans/aggregate failed; not used in success quantiles        |
| [42211231029](https://github.com/marabi766/RASTA/actions/runs/42211231029) | cancelled                | Job cancelled before any step started (0 steps)                                       |
| [42224236361](https://github.com/marabi766/RASTA/actions/runs/42224236361) | cancelled                | Job cancelled before any step started (0 steps)                                       |
| [42235834370](https://github.com/marabi766/RASTA/actions/runs/42235834370) | cancelled                | Job cancelled before any step started (0 steps)                                       |
| [42235871009](https://github.com/marabi766/RASTA/actions/runs/42235871009) | cancelled                | No isolation job started                                                              |
| [42255292873](https://github.com/marabi766/RASTA/actions/runs/42255292873) | cancelled                | Job cancelled before any step started (0 steps)                                       |
| [42275750876](https://github.com/marabi766/RASTA/actions/runs/42275750876) | cancelled                | Job cancelled before any step started (0 steps)                                       |
| [42275793169](https://github.com/marabi766/RASTA/actions/runs/42275793169) | cancelled                | No isolation job started                                                              |
| [42286098058](https://github.com/marabi766/RASTA/actions/runs/42286098058) | cancelled                | Job cancelled before any step started (0 steps)                                       |
| [42286139072](https://github.com/marabi766/RASTA/actions/runs/42286139072) | cancelled                | No isolation job started                                                              |
| [42304430170](https://github.com/marabi766/RASTA/actions/runs/42304430170) | cancelled                | Job cancelled before any step started (0 steps)                                       |
| [42304459843](https://github.com/marabi766/RASTA/actions/runs/42304459843) | cancelled                | No isolation job started                                                              |
| [42304490776](https://github.com/marabi766/RASTA/actions/runs/42304490776) | in_progress              | Still in progress at snapshot; later succeeded, isolation 335 s; outside fixed window |

The three omitted runs from FU-165's older mixed-branch sample are now accounted for:
42255292873 was **cancelled** (security job cancelled with zero steps);
42235871009 was **cancelled** (no jobs); 42254977655 was **failure**
(typecheck/unit failed, security job skipped with zero steps). None is a
600-second censored isolation observation. The saved prior jobs responses and
this task's refreshed API/log evidence are in `~/worker12/session/1289/` and
`~/worker12/session/1284/` on rasta-dev.

## Date bisection and cause

There is **no single merge that permanently doubled the step**. Date bisection
shows incremental test/collection growth mixed with substantial runner variation.
The one old 253 s observation is not a stable old median. Adjacent merge probes
also disprove attributing the doubling to the new disclosure setup, new analytics
service, or idempotency alone:

| Run / date (UTC)                                                                        | Merge head |  Unit s | Integration s | Step s |
| --------------------------------------------------------------------------------------- | ---------- | ------: | ------------: | -----: |
| [38600385830](https://github.com/marabi766/RASTA/actions/runs/38600385830) / 2026-10-14 | f33e613c0  |  90.526 |       161.644 |    253 |
| [38830787724](https://github.com/marabi766/RASTA/actions/runs/38830787724) / 2026-10-16 | bdca3d074  |  94.523 |       180.816 |    276 |
| [38835266069](https://github.com/marabi766/RASTA/actions/runs/38835266069) / 2026-10-16 | 004c5a6f7  |  87.156 |       139.173 |    227 |
| [39002526156](https://github.com/marabi766/RASTA/actions/runs/39002526156) / 2026-10-17 | f49cd78a4  | 133.463 |       226.175 |    361 |
| [39393333054](https://github.com/marabi766/RASTA/actions/runs/39393333054) / 2026-10-20 | dbeac46d3  | 139.163 |       218.493 |    359 |
| [39833749432](https://github.com/marabi766/RASTA/actions/runs/39833749432) / 2026-10-22 | 8ec3e2895  | 137.243 |       207.641 |    346 |
| [39843283379](https://github.com/marabi766/RASTA/actions/runs/39843283379) / 2026-10-22 | ddf0b95b2  | 111.173 |       178.229 |    290 |
| [39850927326](https://github.com/marabi766/RASTA/actions/runs/39850927326) / 2026-10-22 | cea2bd7dc  | 148.257 |       261.402 |    411 |
| [40163416703](https://github.com/marabi766/RASTA/actions/runs/40163416703) / 2026-10-25 | 61a13bbce  | 116.971 |       228.952 |    347 |
| [40413510272](https://github.com/marabi766/RASTA/actions/runs/40413510272) / 2026-10-26 | a21a7ba62  | 133.651 |       207.969 |    343 |
| [40436125339](https://github.com/marabi766/RASTA/actions/runs/40436125339) / 2026-10-27 | 7fbf690bc  | 132.617 |       198.494 |    332 |
| [40529495529](https://github.com/marabi766/RASTA/actions/runs/40529495529) / 2026-10-27 | f08003bcb  | 175.472 |       273.287 |    450 |
| [40785910814](https://github.com/marabi766/RASTA/actions/runs/40785910814) / 2026-10-28 | f3f95b7f1  | 202.637 |       267.768 |    472 |
| [41140885419](https://github.com/marabi766/RASTA/actions/runs/41140885419) / 2026-10-30 | 051346033  | 120.154 |       202.766 |    324 |
| [41496157174](https://github.com/marabi766/RASTA/actions/runs/41496157174) / 2026-11-02 | ec5ef32cb  | 193.109 |       253.029 |    447 |
| [41701033314](https://github.com/marabi766/RASTA/actions/runs/41701033314) / 2026-11-03 | 9d99d9581  | 122.947 |       211.824 |    336 |
| [41928120650](https://github.com/marabi766/RASTA/actions/runs/41928120650) / 2026-11-04 | 07b6b89dd  | 128.854 |       190.289 |    320 |

Concrete additions between f33e613c0 and 3dc724eae explain the increased work:

- Economic integration grew from 219 passing / 585 discovered tests to 504 / 1606. Its Jest time grew 94.881 → 279.882 s; the parallel integration workspace
  phase grew 126.915 → 331.116 s. Commits 004c5a6f7 (#287, atomic idempotent
  commands), 59785c264 (#329, statement obligations), 3d4cf407d (#480, rewards),
  aec2188a0 (#545, reward races/replay), 06136729e (#721, reversal storage),
  a8e2c7670 (#747, canonical command bodies), ddf742ecc (#762, settlement
  creation proofs), and 3dc724eae (#824, hold decisions) add the relevant specs.
- Procurement 852118fc0 (#327) and analytics ddf0b95b2 (#337) added two more
  integration workspaces: in run 42295730635 they execute 48 and 34 selected
  tests (97.173 and 32.013 Jest seconds). They also add unit collection.
- The duplicate unit run loads every spec even when most test names are skipped.
  Web collection grew 3385 → 10844 discovered tests (5 → 67 selected), Jest
  59.357 → 180.314 s; nest-common 714 → 1844 (87 → 192 selected), 10.478 →
  54.230 s. Representative additions: 954d42197 (#426, disclosure), cb0cd3a8b
  (#492, redirect refusal), 5d3d38635 (#565, tenant writes), 2c5f5197d (#366,
  supplier screens), fb67aa010 (#336, returns), 453371f85 (#830, demand screens).
  The whole unit command grew 90.526 → 222.500 s in those two runs.
- This is cumulative work, not proof of an exact seconds-per-commit allocation:
  #287's adjacent runs are 276 → 227 s, #337's 346 → 290 s, and #452's
  343 → 332 s. Later main still takes only 320 s on Nov 4, 329 s on Nov 6,
  and 335 s after #875/#831. Same-spec timing variation remains. No hardware
  cause is asserted without CPU data. In the 20-run window, setup and whole-step
  durations have Pearson correlation 0.967, consistent with broader performance
  variation rather than an isolation-only retry. Container startup is outside this step;
  the stress phase already existed in the baseline (34.503 s then, 12.021 s
  in 42295730635). Successful logs show one unit workspace phase, one
  integration phase and one stress phase; no new command retry explains it.

## Coverage proof and change boundary

Removed only `pnpm run test -- --testNamePattern="(tenant|isolation|authorization|subtree visibility)"`.
The integration selector, verbose output, stress orchestration, credentials and
environment are unchanged. All 25 workspaces with a `test` script have the same
Jest selection in `test:unit`, modulo `--passWithNoTests`. The new split guard
checks all workspace manifests through the shared fail-closed workspace reader;
missing, unknown or narrowed selection refuses. The old unbounded-unit exception
is retired; the concurrency guard refuses reintroducing the filtered rerun. It also requires the unfiltered
`quality-unit` / `Unit tests` step exactly once. The existing quality guard
refuses skip/forgiveness and executes the aggregate verdict against non-success
results. `test:unit:ci` runs `turbo run test:unit --concurrency=3` without filters.
The branch-protection API confirms **Lint, types and unit tests** is required.
Thus a unit failure still blocks merge. A real example is run 42202098189 attempt
1: `Unit tests` failed, the quality aggregate failed, and isolation still passed.

Sibling instances audited: all test/test:unit workspace scripts, all quality job
skip/failure settings, integration selectors/stress phase, other step budgets and
their cumulative job budgets. Other jobs' historical measurements were not used
to recalibrate their limits; a scheduled generic budget monitor remains a
separate follow-up, beyond this measured isolation change.

The PR's own CI before/after result is recorded in its STATUS comment and
`~/worker12/outbox/1289.md`; it cannot be measured before the single push.
