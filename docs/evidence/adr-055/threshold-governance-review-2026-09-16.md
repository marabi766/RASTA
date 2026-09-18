# ADR-055 § 6 threshold-governance review — 2026-09-16

**Decision: NO-GO for selecting a capability threshold.**

The § 6 _collection_ prerequisite is met: a paired, two-sided dataset now exists. The § 6
_governance_ prerequisite is not. The induced dataset contains exactly one failing pair, and
that pair is simultaneously the first pair, the slowest probe and the slowest suite — so every
threshold that separates this sample is post-hoc and unvalidated. No number, no margin, no
predictor and no classifier is chosen here.

This document is an analysis of already-committed evidence. It is **not** a generated
calibration artifact, it generates no new measurement, and it alters no existing evidence
file. Every figure below was recomputed from the per-pair rows of the source artifacts with a
temporary, uncommitted script; nothing was copied from the source reports' own narrative or
summary lines, which are instead used as an independent cross-check.

---

## 1. Source provenance

|                     | Quiet campaign                                                               | Induced campaign                                                                                              |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Artifact            | `quiet-calibration-github-2026-09-15.txt`                                    | `induced-calibration-0015cpu-github-2026-09-16.txt`                                                           |
| Commit in artifact  | `89ebe9943ba9a29d6a7e67beadec8192d14060d5`                                   | `a0db6386f6d027cfdd0fbf2c250a70eb4c90bb4c`                                                                    |
| Generated (UTC)     | `2026-09-15T16:20:14.085Z`                                                   | `2026-09-16T03:36:45.366Z`                                                                                    |
| GitHub run          | [`34989897833`](https://github.com/marabi766/RASTA/actions/runs/34989897833) | [`35048202361`](https://github.com/marabi766/RASTA/actions/runs/35048202361)                                  |
| Induced condition   | none (quiet runner)                                                          | `CPU_PERIOD_US=1000000`, `CPU_QUOTA_US=15000` (`0.015 CPU`), PostgreSQL container only, verified by read-back |
| Pairs               | 20                                                                           | 20                                                                                                            |
| Outcomes            | `VALID=20`, `INVALID=0`, `INCONCLUSIVE=0`                                    | `VALID=20`, `INVALID=0`, `INCONCLUSIVE=0`                                                                     |
| Control             | `VALID`                                                                      | `VALID`                                                                                                       |
| Suite result        | passed 20 / failed 0                                                         | passed 19 / failed 1                                                                                          |
| Rows with `ran=yes` | 20                                                                           | 20                                                                                                            |
| Process bound hit   | none                                                                         | none                                                                                                          |

Two supporting single observations exist and are **not** paired evidence:
`aggregation-stress-cost-observation-github-2026-09-16.txt` (`0.05 CPU`, suite passed, 88.0 s)
and `aggregation-stress-cost-observation-0015cpu-github-2026-09-16.txt` (`0.015 CPU`, suite
failed, 153.2 s, `sqlstate57014=1`). They are used below only to describe how the induced
condition was chosen, never as samples.

### Topology comparability

The `topology:` line of the two calibration artifacts is **byte-for-byte identical**: Ubuntu
24.04.5 LTS, image `ubuntu24/20260907.300.1`, kernel `6.17.0-1022-azure`, 4 CPU, 15.6 GiB,
`overlay2`; `postgis/postgis:16-3.4`, PostgreSQL 16.4, `fsync=on`, `synchronous_commit=on`,
`wal_level=replica`, `wal_sync_method=fdatasync`, `full_page_writes=on`,
`shared_buffers=128MB`, `max_connections=100`, `max_wal_size=1GB`, `checkpoint_timeout=5min`.

One comparability caveat, stated rather than glossed: the two campaigns ran at different
commits, and `scripts/aggregation-evidence.mjs` changed between them (commit `f2406f4`, the
process-bound repair). What did **not** change is what the comparison depends on —
`git diff 89ebe99 a0db638` is empty for both `scripts/aggregation-evidence-lib.mjs` (all
probe SQL, validity rules, parsing, summarisation, distribution and report formatting) and for
the stress spec `services/identity-service/test/security-event-aggregation.int-spec.ts`. The
runner change affects only process-group termination and settle semantics, and neither
campaign hit a process bound: no row is `timedOut`, no row carries the `(process bound
exceeded)` marker, and the `timeout` infrastructure category is `0` in every scope of both
artifacts.

### Observation versus inference

Everything in §§ 2–4 below is **observation** — arithmetic over committed rows. Everything in
§ 5 is **inference about what the observations cannot support**. No causal claim is made
anywhere; in particular, the first-pair effect discussed in § 5 is named as an unresolved
confound, not as a demonstrated cause.

---

## 2. Row-level comparison — induced campaign (`0.015 CPU`)

All values read from the artifact's own per-pair rows. `stall` is `probe_longest_stall_s`.

| pair | outcome | `probe_tps` | `probe_min_interval_tps` | `stall` | result   | exit | `stress_wall_s` | tests pass/fail | failure categories                |
| ---: | ------- | ----------: | -----------------------: | ------: | -------- | ---: | --------------: | --------------: | --------------------------------- |
|    1 | `VALID` |   **39.82** |                    **1** |       0 | **FAIL** |    1 |       **271.3** |            20/2 | `sqlstate57014=1` `jestTimeout=1` |
|    2 | `VALID` |      201.71 |                       31 |       0 | PASS     |    0 |           135.3 |            22/0 | —                                 |
|    3 | `VALID` |      211.87 |                       26 |       0 | PASS     |    0 |           140.3 |            22/0 | —                                 |
|    4 | `VALID` |       209.2 |                       41 |       0 | PASS     |    0 |           113.6 |            22/0 | —                                 |
|    5 | `VALID` |      200.94 |                        3 |       0 | PASS     |    0 |           150.4 |            22/0 | —                                 |
|    6 | `VALID` |       208.6 |                       21 |       0 | PASS     |    0 |           138.4 |            22/0 | —                                 |
|    7 | `VALID` |      211.57 |                       21 |       0 | PASS     |    0 |           116.3 |            22/0 | —                                 |
|    8 | `VALID` |      206.78 |                       25 |       0 | PASS     |    0 |           115.4 |            22/0 | —                                 |
|    9 | `VALID` |      208.61 |                       26 |       0 | PASS     |    0 |           114.6 |            22/0 | —                                 |
|   10 | `VALID` |      192.75 |                       28 |       0 | PASS     |    0 |           113.9 |            22/0 | —                                 |
|   11 | `VALID` |      205.45 |                       31 |       0 | PASS     |    0 |           115.4 |            22/0 | —                                 |
|   12 | `VALID` |      212.01 |                       26 |       0 | PASS     |    0 |           115.9 |            22/0 | —                                 |
|   13 | `VALID` |      212.02 |                       37 |       0 | PASS     |    0 |           113.1 |            22/0 | —                                 |
|   14 | `VALID` |      202.59 |                       30 |       0 | PASS     |    0 |           115.3 |            22/0 | —                                 |
|   15 | `VALID` |      208.92 |                       30 |       0 | PASS     |    0 |           114.9 |            22/0 | —                                 |
|   16 | `VALID` |      201.24 |                       34 |       0 | PASS     |    0 |           110.6 |            22/0 | —                                 |
|   17 | `VALID` |      196.57 |                        9 |       0 | PASS     |    0 |           117.6 |            22/0 | —                                 |
|   18 | `VALID` |      203.75 |                       27 |       0 | PASS     |    0 |           118.3 |            22/0 | —                                 |
|   19 | `VALID` |      202.87 |                       26 |       0 | PASS     |    0 |           140.6 |            22/0 | —                                 |
|   20 | `VALID` |      201.78 |                       11 |       0 | PASS     |    0 |           143.6 |            22/0 | —                                 |

**Cross-check against the artifact's own summary lines.** Recomputed `passed=19 failed=1 of
20` matches `stress: passed=19 failed=1 of 20`. Recomputed `probe_tps` min/median/max
`39.82 / 204.6 / 212.02` and `probe_min_interval_tps` `1 / 26 / 41` and
`probe_longest_stall_s` `0 / 0 / 0` match the artifact's distribution lines exactly.

**One precision note, not a discrepancy.** Recomputing `stress_wall_s` from the displayed rows
gives `110.6 / 116.1 / 271.3`, while the artifact's distribution line reads
`110.56 / 116.12 / 271.27`. The harness renders per-row wall time at one decimal and the
distribution at two, from the same unrounded value (`fmt(run.wallSeconds, 1)` for rows,
`fmt(..., 2)` inside `distributionLine`). The two agree to within the rows' display precision.
The same offset appears in the quiet artifact (`20.4 / 57.65 / 59.8` recomputed from rows
versus `20.41 / 57.64 / 59.78` reported). Where this document quotes `stress_wall_s`
statistics it uses the row-derived values and says so.

**What the two failure categories mean here.** The row records 2 failed tests, `other=0`, and
category counts summing to 2. The classifier counts every failure message it sees, adding a
message with no matching pattern to `other`; a message matching both patterns would contribute
two counts by itself and force the total above 2. So the aggregate is consistent with exactly
one outcome: two distinct failing tests, one carrying a `57014`
(`canceling statement due to statement timeout`), the other exceeding its own Jest timeout.
The three product-assertion categories (`secondRowOrWindowCrossing`, `countSequence`,
`finalRow`) are `0`, and the fourteen infrastructure categories are `0` across pairs with
`other=3` — the harness's three product-side notes for a report that exists and says tests
failed, not an environment diagnostic. No raw message text is read or reproduced anywhere.

---

## 3. Descriptive statistics

**Quartile convention, stated exactly:** Hyndman–Fan **type 7** — the R and NumPy default —
i.e. for sorted `x[0..n-1]` and probability `p`, `h = (n − 1)p` and
`Q(p) = x[⌊h⌋] + (h − ⌊h⌋)·(x[⌊h⌋+1] − x[⌊h⌋])`, computed in exact rational arithmetic. For
`n = 20` the median under this convention is the mean of the 10th and 11th order statistics,
which is also the convention the harness itself uses, so the medians here and in the artifacts
are directly comparable. **No normality assumption is used anywhere**, and none of these
samples is treated as normal: the induced `probe_tps` sample is strongly left-skewed by a
single extreme value (mean `196.95` sits below `Q1 = 201.59`), which is exactly the shape for
which mean-and-standard-deviation summaries mislead.

### Induced campaign (`0.015 CPU`), n = 20

| statistic | `probe_tps` | `probe_min_interval_tps` | `probe_longest_stall_s` | `stress_wall_s` † |
| --------- | ----------: | -----------------------: | ----------------------: | ----------------: |
| n         |          20 |                       20 |                      20 |                20 |
| min       |       39.82 |                        1 |                       0 |             110.6 |
| Q1        |    201.5925 |                       21 |                       0 |           114.825 |
| median    |       204.6 |                       26 |                       0 |             116.1 |
| Q3        |      208.99 |                    30.25 |                       0 |           138.875 |
| IQR       |      7.3975 |                     9.25 |                       0 |             24.05 |
| max       |      212.02 |                       41 |                       0 |             271.3 |
| mean      |    196.9525 |                     24.2 |                       0 |            130.74 |

† row-derived, per the precision note in § 2.

### Quiet campaign, n = 20

| statistic | `probe_tps` | `probe_min_interval_tps` | `probe_longest_stall_s` | `stress_wall_s` † |
| --------- | ----------: | -----------------------: | ----------------------: | ----------------: |
| n         |          20 |                       20 |                      20 |                20 |
| min       |      2494.8 |                      405 |                       0 |              20.4 |
| Q1        |   2956.3075 |                  782.675 |                       0 |              55.7 |
| median    |     3268.23 |                  1013.95 |                       0 |             57.65 |
| Q3        |   3406.7475 |                 1321.825 |                       0 |             58.25 |
| IQR       |      450.44 |                   539.15 |                       0 |              2.55 |
| max       |     3797.51 |                   2174.3 |                       0 |              59.8 |
| mean      |   3184.6295 |                 1090.585 |                       0 |            55.755 |

### Outcome-stratified ranges (induced)

| subset       |   n | `probe_tps`          | `probe_min_interval_tps` | `probe_longest_stall_s` | `stress_wall_s` †    |
| ------------ | --: | -------------------- | ------------------------ | ----------------------- | -------------------- |
| suite `PASS` |  19 | 192.75 … 212.02      | 3 … 41                   | 0 … 0                   | 110.6 … 150.4        |
| suite `FAIL` |   1 | 39.82 (single value) | 1 (single value)         | 0 (single value)        | 271.3 (single value) |

A one-observation "range" is a point. It is written out here so no reader mistakes the layout
for a distribution.

### Illustrative interval — explicitly non-decisional

The observed environment-caused failure rate under this fixed condition is 1/20 = 5 %. An exact
Clopper–Pearson 95 % interval for that proportion is **[0.13 %, 24.87 %]**.

**This interval may not be used to justify, size or bound any threshold, and it is not used
that way here.** It assumes independent Bernoulli trials. The twenty pairs ran serially in one
job against one database, sharing caches, one WAL, one filesystem and one runner, with the
induced quota applied once before the first pair — so independence is not demonstrated and is
in fact doubted by the data itself (see § 5). The interval is quoted for one purpose only: to
show that even taking it at face value, the failure rate consistent with this sample spans
more than two orders of magnitude, which is not a basis for governing CI.

---

## 4. Separability audit

A threshold `T` on predictor `X` would be applied as "declare the environment incapable when
`X ≤ T`". A candidate is _separating on this sample_ when it puts every failing row on one
side and every passing row on the other.

**`probe_tps`.** The failing row is `39.82`; the passing rows span `192.75 … 212.02`. Every
`T` with `39.82 < T ≤ 192.75` separates all 20 observations perfectly. That is an open
interval **152.93 tps wide**, containing infinitely many candidates and — because all 20
observations are fit identically by every one of them — **no data-driven way to prefer any
candidate over any other, and no data-driven way to derive a safety margin around one.**
Picking a point inside it would be an arbitrary choice presented as a measurement.

**`probe_min_interval_tps`.** The failing row is `1`; the passing rows span `3 … 41`, with
sorted passing values `3, 9, 11, 21, 21, 25, 26, 26, 26, 26, 27, 28, 30, 30, 31, 31, 34, 37,
41`. Every `T` with `1 < T ≤ 3` separates this sample. The interval is narrow — an observed
gap of **2 units** — but narrowness is not confirmation: the gap rests on one failing
observation and on a single passing observation at `3`, with no replication of either, and the
statistic is a per-interval minimum, i.e. the most volatile summary of the probe. A boundary
resting on two adjacent single observations is not a governed boundary.

**`probe_longest_stall_s`.** `0` for all 20 induced rows (and all 20 quiet rows). It is
constant on this data and therefore has **no discriminating value whatsoever** here. It cannot
be the predictor, and its being zero on the failing row is a fact about this dataset, not
evidence that stalls are irrelevant.

**`stress_wall_s`.** Listed for completeness and rejected as a predictor by construction: it
is measured _after_ the suite runs, so it cannot gate the suite. Its values are reported only
as an outcome description.

**Pair ordinal.** Perfectly separating on this sample (`ordinal = 1` ⇔ `FAIL`) and obviously
unusable as a capability predictor. Its perfect fit is precisely the warning in § 5.

**What the quiet campaign contributes, and what it cannot.** Twenty additional `VALID` pairs,
all passing, with `probe_tps` `2494.8 … 3797.51` and `probe_min_interval_tps` `405 … 2174.3`.
Its slowest probe is about **11.8×** the induced campaign's fastest (`2494.8` versus `212.02`)
and its lowest per-interval minimum about **9.9×** the induced maximum (`405` versus `41`). So
the quiet data sit far above both candidate gaps and confirm only that the boundary is well
below `2494.8`. **They cannot resolve the choice inside either induced interval**, which is
where the boundary actually lies — the same objection ADR-055 § 6 already raised against the
`4564 … 4622` runner distribution.

---

## 5. Confounding and evidence limitations

1. **One failure in twenty.** The entire failure side of the dataset is a single row. Every
   quantity that would govern a threshold — where the boundary sits, how wide a safety margin
   must be, how often a capable environment would be wrongly failed — is being asked of `n = 1`.
2. **The failure is perfectly confounded with pair order.** `pair-1` is simultaneously the only
   `FAIL`, the slowest probe (`39.82`, next-slowest `192.75` at pair-10), the lowest
   per-interval minimum (`1`, next-lowest `3` at pair-5) and the longest suite (`271.3 s`,
   next-longest `150.4 s` at pair-5). Four "most extreme" labels land on the same row, and that
   row is also the first one executed.
3. **First-run effects cannot be separated from capability by this design — and no causal claim
   is made.** A first pair in a fresh job differs from later pairs in ways this dataset cannot
   disentangle: cold filesystem and PostgreSQL caches, first TypeScript compilation and module
   load, and the transition immediately after the quota was applied. Whether any of these
   _caused_ the low probe and the failure, whether the induced constraint alone did, or whether
   it was chance, **is not determined by this evidence**. This is recorded as an unresolved
   confound, not as a cold-start explanation.
4. **No repeated independent failure-side samples.** The twenty pairs are serial within one job
   on one database; they are not twenty independent draws of the failure process. There is no
   second campaign at this condition to check whether a first-pair failure recurs.
5. **No holdout or validation data.** Any predictor and any boundary would be chosen on exactly
   the same twenty observations used to justify them. A rule fitted and evaluated on one sample
   reports its own construction, not its performance.
6. **Predictor selection and threshold selection would be confounded with each other.** Two
   different statistics (`probe_tps`, `probe_min_interval_tps`) each separate this sample
   perfectly, over intervals differing by two orders of magnitude in width. The data give no
   basis for choosing between the statistics, let alone a value within one.
7. **False-capable and false-incapable rates cannot be estimated.** With one failure and no
   replication there is no usable estimate of how often a threshold would pass a genuinely
   incapable environment or fail a capable one — the two error rates ADR-055 § 6 exists to
   control.
8. **A safety margin cannot be derived.** ADR-055 § 6 requires a versioned threshold _and_ its
   safety margin. A margin is a statement about dispersion near the boundary; this dataset has
   no observations near either candidate boundary at all — the nearest passing observations are
   `192.75` and `3`, each a single point.
9. **The induced condition is one fixed point.** All conclusions are conditional on
   `0.015 CPU` on this exact runner and image. Nothing here characterises behaviour at other
   constraints, other hardware or production-like hosts.

---

## 6. ADR-055 § 6 requirement decision table

| § 6 requirement                                                                          | Status                                     | Evidence / gap                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paired samples: preflight + unchanged suite, same database, immediately adjacent in time | **met**                                    | Both artifacts: 20 rows each, probe line immediately followed by stress line, one control first, no intervening step                                                                                 |
| Suite unchanged while evidence was collected (SQL, timeouts, lanes, window, assertions)  | **met**                                    | Stress spec byte-identical across both campaign commits; `validateCalibrationContract` enforced the constants at run time; no filter, retry or `--passWithNoTests`                                   |
| Probe validity explicit and enforced                                                     | **met**                                    | `VALID=20` / `INVALID=0` / `INCONCLUSIVE=0` in both campaigns; control `VALID` in both                                                                                                               |
| Full distribution recorded, not just averages                                            | **met**                                    | Four distributions per artifact with n / available / unavailable / min / median / max, plus every row                                                                                                |
| Both outcome sides present, environment-caused failure included                          | **met**                                    | Induced campaign: 19 `VALID`+pass and 1 `VALID`+environment-caused fail (`sqlstate57014`, `jestTimeout`; product-assertion categories `0`)                                                           |
| Interval minimum TPS, stalls and suite failure classification recorded                   | **met**                                    | `probe_min_interval_tps`, `probe_longest_stall_s` and seven failure categories present on every row                                                                                                  |
| Aggregates-only, redacted reporting                                                      | **met**                                    | Both artifacts validated on entry: no URL, connection string, credential, token, absolute path, IP, PID, container identity, raw exception, raw subprocess output or test identifier                 |
| Evidence sufficient to **choose the predictor**                                          | **not sufficient for threshold selection** | Two candidates separate this sample equally perfectly; no basis to choose (§ 4, § 5.6)                                                                                                               |
| Evidence sufficient to **choose the numeric boundary**                                   | **not sufficient for threshold selection** | Separating intervals `39.82 < T ≤ 192.75` and `1 < T ≤ 3`; every candidate fits identically (§ 4)                                                                                                    |
| Evidence sufficient to **derive the safety margin**                                      | **not sufficient for threshold selection** | No observations near either candidate boundary; dispersion at the boundary unknown (§ 5.8)                                                                                                           |
| Evidence sufficient to write **boundary and mutation tests** on the value                | **not sufficient for threshold selection** | Depends on a chosen value; tests on an arbitrary value would encode the arbitrariness                                                                                                                |
| Independent replication of the failure side                                              | **not sufficient for threshold selection** | `n = 1`, confounded with pair order, no second campaign (§ 5.1–5.4)                                                                                                                                  |
| Estimable false-capable / false-incapable rates                                          | **not sufficient for threshold selection** | Not estimable from one failure without replication (§ 5.7)                                                                                                                                           |
| Local `29.2` upper bound replaced by traceable provenance                                | **partially met**                          | Both campaigns supply traceable distributions on a native runner, but neither measures the local Docker Desktop host, so the provenance-less `29.2` figure in `docs/14` § 14.3 is still not replaced |

---

## 7. Decision

- **No capability threshold is selected, calculated, implied, or written into any document or
  any line of code.** No safety margin is derived.
- **ADR-055 remains `Proposed`.** This review does not move it toward `Accepted`.
- `VALID_CAPABLE` / `VALID_INCAPABLE`, the capability classifier, the phase preflight, the
  orchestration change in `scripts/run-test-phases.mjs`, the fail-fast gate, any bypass, any
  retry and any skip-green behaviour **remain unimplemented**. Nothing was added to ordinary
  CI, to `pnpm verify` or to the test phases.
- `pair-1` remains **`VALID`** — a valid probe followed by a failed unchanged suite. It is not
  relabelled `VALID_INCAPABLE`; that label is the capability judgement § 6 defers.
- **AUD-004 remains open. ADR-053 remains `Proposed`. `COM-009` remains `READY` at 13 points.**
- No existing evidence artifact was modified, and no new measurement was taken for this review.

---

## 8. Pre-registered next evidence proposal — **not executed**

Registered here before any further data is collected, so the next campaign cannot be shaped
after the fact. **It is a proposal only: nothing below was run, authorised or scheduled in this
iteration, and it requires its own separate review before execution.**

**Target: the confound, not the sample size.** Appending more serial pairs to a single long job
would add observations of pairs 21…N — positions already well represented by the nineteen
passing rows — while adding nothing about the one position that actually failed. The open
question is not "what happens in the middle of a run" but **"does the first pair of a fresh run
fail, and is its probe low, when the run is repeated independently?"**

**Design.** Independent fresh-run **first-pair replications** at the already-measured fixed
condition `CPU_PERIOD_US=1000000` / `CPU_QUOTA_US=15000` (`0.015 CPU`):

- **One pair per replication**, using the existing unchanged Probe → full-suite pair contract
  (`--pairs 1`, already supported: `MIN_CALIBRATION_PAIRS = 1`). No serial chain.
- **One fresh ephemeral job and database per replication**, so each replication reproduces the
  first-pair conditions rather than inheriting a warmed database from a previous pair.
- **Exact verification before every measurement**: exact service image, topology capture, and
  quota read-back of `HostConfig.CpuPeriod` and `HostConfig.CpuQuota`, refusing before
  measuring if either differs from the requested constant — the existing gate, unchanged.
- **Unchanged stress constants and timeouts**: 500 writes, four independent clients,
  `LANES_PER_CLIENT = 2`, the 5000 ms statement bound, the 60 s aggregation window,
  `--runInBand`, all assertions. Evidence gathered by loosening the proof describes a proof
  that does not exist.
- **No retries, no filters, no `--passWithNoTests`, no second quota, no variation between
  replications.**
- **Aggregates-only redacted artifacts**, one per replication, under distinct paths that
  overwrite nothing.
- **Non-zero propagation preserved**: a replication whose suite fails is expected to exit
  non-zero and must not be painted green.
- **No ordinary-CI integration**, no `pnpm verify` change, no test-phase change, and removal of
  any temporary workflow in the same iteration that adds it.

**Sample size is an explicit prerequisite of that future review, not a number chosen here.**
No replication count is invented in this iteration. Before the campaign may run, its review
must first state a defensible precision or error target — for example, the width of the
interval it intends to place on the first-pair failure probability, or the smallest failure
rate it intends to be able to distinguish from zero, each with a stated confidence level — and
then **derive** the count from that target. A count picked without such a target would repeat,
at a larger cost, exactly the unfounded-choice problem this review refuses.

**And a further design will still be needed if replication is not enough.** If fresh-run
replication does not yield enough valid environment-caused failures to support boundary
governance — for instance if first-pair failures prove rare at `0.015 CPU` — then a **steady
state / near-boundary design** is still required: measurements taken after a warm-up pair so
first-run effects are outside the measured window, at a constraint chosen to place outcomes
near the boundary rather than far from it, so that observations exist on both sides _close to_
the candidate value and a safety margin becomes estimable rather than invented.

**The one-sided logarithmic-midpoint fallback does not apply and is not used.** That rule was
written for a dataset with only one outcome side. The current campaign is two-sided, so
bisecting toward `0.05` or `0.005` CPU is not the indicated next step; the indicated next step
is replication at the condition already measured.

---

## 9. Reproducing this review

Every figure above is a function of two committed files and nothing else:

- `docs/evidence/adr-055/quiet-calibration-github-2026-09-15.txt`
- `docs/evidence/adr-055/induced-calibration-0015cpu-github-2026-09-16.txt`

To reproduce: parse each artifact's `pair-N:` blocks for `outcome`, `tps`,
`min_interval_tps`, `longest_zero_commit_s`, `result`, `exit` and `wall_s`; compute type 7
quartiles as defined in § 3; stratify by `result`; and compare the failing row's value against
the sorted passing values to obtain the separating intervals of § 4. The per-row values should
then be checked against each artifact's own `outcomes:`, `stress:` and distribution lines,
which are derived independently by the harness. No analysis code is committed for this: it is
arithmetic over twenty rows, and committing a script to perform it would add a maintained
artifact with no consumer.
