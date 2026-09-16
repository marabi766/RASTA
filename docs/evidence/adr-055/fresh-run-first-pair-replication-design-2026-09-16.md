# ADR-055 fresh-run first-pair replication — preregistered design, 2026-09-16

**This is a preregistration. Nothing in it was run.** No campaign was executed, no workflow was
created, no measurement was taken, no existing evidence artifact was altered, no local Docker or
PostgreSQL was started or changed, and no threshold, safety margin, predictor, classifier,
preflight or CI gate was selected or implemented.

It exists to discharge the one explicit prerequisite the
[threshold-governance review](threshold-governance-review-2026-09-16.md) § 8 left open: _state a
defensible statistical target and derive the replication count from it, before any data is
collected._ The count below is **derived**, not chosen, and it is fixed here so that the campaign
cannot be reshaped after its results are visible.

Three kinds of statement appear below and are kept apart on purpose:

| marker       | meaning                                                                      |
| ------------ | ---------------------------------------------------------------------------- |
| **observed** | arithmetic over already-committed artifacts or already-recorded run metadata |
| **design**   | a decision made here, before data, and binding on the future campaign        |
| **future**   | an inference the campaign may license later — not licensed now               |

---

## 1. Question and estimand

**Primary question (design).** Does the environment-caused failure observed on serial `pair-1` of
the induced campaign recur among **independent fresh-run first pairs** at the already-measured
fixed condition `CPU_PERIOD_US=1000000` / `CPU_QUOTA_US=15000` (`0.015 CPU`)?

**Primary estimand (design).** The probability that the **first** Probe→unchanged-suite pair in a
**fresh ephemeral GitHub-hosted job with a fresh service database**, at that exact fixed condition,
produces a qualifying environment-caused stress-suite failure.

**What this campaign is not.** It is not a threshold-selection campaign, not a safety-margin
campaign, and not a predictor-selection campaign. It addresses exactly one defect of the existing
dataset — the perfect confound between the single failure and pair order recorded in
[the review](threshold-governance-review-2026-09-16.md) § 5.2 — and nothing else. No outcome of
this campaign, in any branch, selects a number.

**Observed, for context only.** The induced campaign
(`induced-calibration-0015cpu-github-2026-09-16.txt`, run `35048202361`, commit `a0db638`) ran 20
serial pairs in one job against one database: `VALID=20`, suite `passed=19 failed=1`, and the one
failure is `pair-1` — simultaneously the slowest probe (`39.82` tps vs next-slowest `192.75`), the
lowest per-interval minimum (`1` vs next-lowest `3`) and the longest suite (`271.3 s` vs
next-longest `150.4 s`).

---

## 2. Target, anchored to committed evidence

**Smallest recurrence probability the design is built to detect: `p = 5%` (design).**

The anchor is arithmetic, not judgement: `1/20 = 5%` is the **only** observed failure frequency in
the only committed induced campaign. No other number in the repository has any claim to being the
scale of this effect, so the design takes the observed frequency as the smallest effect it is
worth building to detect and derives everything else from it.

Three things this anchor explicitly is **not**:

1. **Not an independent estimate of the true rate.** The 1/20 came from twenty _serial_ pairs in
   one job against one database, sharing caches, one WAL, one filesystem and one runner. The review
   § 3 already records that these are not demonstrably independent Bernoulli trials and that the
   illustrative Clopper–Pearson interval `[0.13 %, 24.87 %]` **may not be used to justify, size or
   bound any threshold**. That prohibition is carried forward here unchanged: `5%` is a _design
   sensitivity_, not a measured rate.
2. **Not a product or business tolerance.** Nothing in the product documents says a 5 % CI-flake
   rate is acceptable or unacceptable. Inventing such a tolerance would be exactly the
   business-fact invention AGENTS.md § 9 forbids.
3. **Not a threshold.** It is a probability of an event, not a boundary on a probe statistic. It
   licenses no `T` on `probe_tps`, on `probe_min_interval_tps`, or on anything else.

**Confidence target: one-sided `95%` (design).** The question is directional — _does the event
recur?_ — not symmetric estimation of a mature rate. A two-sided interval would answer a question
this campaign is not asking and would inflate the count without improving the answer to the
question it _is_ asking.

---

## 3. Fixed sample-size derivation

The trials are modelled as independent Bernoulli draws with recurrence probability `p`. The
probability that `n` such trials contain **at least one** qualifying recurrence is

```
P(at least one | p, n) = 1 - (1 - p)^n
```

Requiring that this reach the one-sided `95%` target at the design sensitivity `p = 0.05`:

```
1 - (1 - 0.05)^n >= 0.95
        (0.95)^n <= 0.05
     n * log(0.95) <= log(0.05)
                 n >= log(0.05) / log(0.95)          (log 0.95 < 0, inequality flips)
                 n >= (-2.995732273553991) / (-0.05129329438755058)
                 n >= 58.4039748143197
                 n  = ceil(58.4039748143197) = 59
```

**`n = 59` independent valid replications (design).**

**Boundary check (observed arithmetic).** 59 is the smallest integer that clears the target, and it
clears it by a small margin — which is the point of deriving rather than rounding:

| `n` |  `1 - 0.95^n` | reaches 95 %?              |
| --: | ------------: | -------------------------- |
|  57 | `94.626645 %` | no                         |
|  58 | `94.895313 %` | no                         |
|  59 | `95.150547 %` | **yes**                    |
|  60 | `95.393020 %` | yes (but not the smallest) |

**The zero-event branch, stated before the data exists.** If all 59 replications are valid and none
carries a qualifying failure, the exact one-sided 95 % **Clopper–Pearson** upper bound on the
recurrence probability is the `U` solving `(1 - U)^59 = 0.05`:

```
U = 1 - 0.05^(1/59) = 0.04950761... = 4.950761 %
```

which is **just below** the 5 % design sensitivity — the arithmetic dual of the power statement
above, and the reason 59 rather than 58 is the derived count: at `n = 58` the same bound is
`5.033934 %`, which sits **above** 5 % and would leave the design sensitivity inside the interval
the data failed to exclude.

**Explicitly excluded methods (design).** No normal approximation to the binomial, no post-hoc
power calculation, no two-sided interval, no optional stopping rule, no sequential or group
sequential boundary, and no count other than 59. Substituting any of these after the fact would
reintroduce, at greater cost, the post-hoc-choice defect the review refused.

---

## 4. Fixed design: 59 slots, no optional stopping

**Pre-registered (design):**

- **59 attempt slots, indexed `1..59`. Every slot runs, regardless of every other slot's outcome.**
- **No early stopping.** Not on success ("we already saw a recurrence"), not on futility ("the
  first thirty all passed"), not on cost.
- **No result-driven extension.** If 59 valid replications produce zero qualifying failures, the
  answer is the zero-event branch of § 6 — not "run 30 more".
- **No rerun of a failed proof, and no retry at any level.** Not a Jest retry, not a matrix-job
  retry, not a manual re-dispatch of a red slot. A retried sample is not evidence.
- **No replacement, omission or renumbering.** Slot `k` is slot `k` forever.

**Attrition rule (design).** The inferential target of § 3 is met **only** if all 59 attempt slots
produce eligible, comparable, independent **valid** replications. If any slot is `INVALID`,
`INCONCLUSIVE`, missing, cancelled, provenance-mismatched, or lacks its artifact, then the fixed
campaign is **INCONCLUSIVE for the 5 % / 95 % target** and must be reported as such.

No attrition rate is invented here and no automatic replacement policy is created, because neither
is derivable from committed evidence: exactly two GitHub campaign jobs exist at this condition and
both completed, which is not a basis for an attrition model. A later, **separately reviewed**
campaign may address attrition; this design may not.

---

## 5. Eligibility and endpoint classification, fixed before data

### 5.1 Eligibility of a replication

A replication is **eligible** only when _all_ of the following hold:

1. The read-only **control** probe ran first and is `VALID`.
2. The pair's **probe** is `VALID` — the existing `PROBE_VALIDITY` rules, unchanged. `INVALID` and
   `INCONCLUSIVE` are ineligible, not events.
3. The **unchanged full stress suite actually ran** (`ran=yes`) as the step immediately after that
   probe, unfiltered, in band, with no `--passWithNoTests` and no retry.
4. The **exact service image, topology capture and quota read-back** all passed _before_ the
   measurement: exactly one `postgis/postgis:16-3.4` container, and
   `HostConfig.CpuPeriod` / `HostConfig.CpuQuota` read back as exactly `1000000` / `15000`.
5. The **aggregate artifact is complete** — the campaign report exists, parses, and carries its
   outcomes, stress line and all four distributions.

### 5.2 Endpoint classification

| classification               | definition (design)                                                                                                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **qualifying primary event** | an eligible `VALID` pair whose unchanged suite **fails only** with the established environment categories (for example `sqlstate57014` and/or `jestTimeout`) **and** has **zero** product-assertion categories (`secondRowOrWindowCrossing`, `countSequence`, `finalRow` all `0`) |
| **non-event**                | an eligible `VALID` pair whose unchanged suite **passes**                                                                                                                                                                                                                         |
| **blocker / inconclusive**   | any product-assertion failure; any mixed product+environment failure; any unknown or unclassified failure; any setup, launcher or process-bound failure (`timedOut`, `(process bound exceeded)`, non-zero `timeout` category); any contract drift refusal                         |

A blocker is **neither** a qualifying event **nor** evidence of incapability. It is a defect in the
measurement or a signal about the product, and it invalidates the slot under § 4.

**Vocabulary (design).** The existing outcome vocabulary is kept exactly: `VALID`, `INVALID`,
`INCONCLUSIVE`. `VALID_CAPABLE` and `VALID_INCAPABLE` are **not** introduced — they are the
capability judgement ADR-055 § 6 defers, and this campaign does not make it.

---

## 6. Pre-registered interpretation

Written before the data exists, binding on the future review, and deliberately narrow.

**Branch A — at least one qualifying failure among 59 fully eligible replications.**
Record only: _fresh-run recurrence of the environment-caused first-pair failure was observed at
`0.015 CPU` on this runner/image cohort._ Do **not** infer a threshold, do **not** treat the
observed count as a precise estimate of the failure probability, and do **not** attribute the
failure to cold start, to the quota, or to any other cause this design cannot separate.

**Branch B — zero qualifying failures, all 59 eligible and comparable.**
Record only: _recurrence at a probability of 5 % or greater was not reproduced at the one-sided
95 % target; the exact one-sided 95 % Clopper–Pearson upper bound is `4.9508 %`._ Do **not** claim
the event is impossible, does not occur, or has been ruled out. An upper bound below 5 % is an
upper bound, not a zero.

**Branch C — anything else** (any slot `INVALID` / `INCONCLUSIVE` / missing / cancelled /
provenance-mismatched / artifact-less, or any blocker under § 5.2).
The campaign is **inconclusive for the 5 % / 95 % target**. The slots that did complete remain
committed evidence and may inform a later design; they do not partially satisfy this one.

**Deferred in every branch.** Predictor selection, the numeric boundary, the safety margin, the
false-capable and false-incapable rates, ADR acceptance, and every line of implementation —
`VALID_CAPABLE`/`VALID_INCAPABLE`, the capability classifier, the phase preflight, the
`run-test-phases.mjs` orchestration change, the fail-fast gate — all remain exactly where the
review left them: not selected, not implemented.

**And a further design is still required.** If this campaign does not supply sufficient replicated
failure-side evidence **close to a candidate boundary**, a **steady-state / near-boundary** design
is still needed before threshold governance: measurements taken after a warm-up pair, so first-run
effects fall outside the measured window, at a constraint chosen to place outcomes near the
boundary rather than far from it. Branch A does not by itself license threshold selection, because
fresh-run replication at one far-from-boundary condition still leaves the safety margin
underivable (review § 5.8).

---

## 7. Independence and comparability contract

**Independence (design).** One pair per **fresh ephemeral GitHub-hosted job** with a **fresh
PostgreSQL service database**, using the existing calibration mode with
`--calibrate --pairs 1 --slot <matrix index>`.
No serial chain, no shared mutable database, no reuse of a warmed database between slots.

**Comparability (design) — everything below stays exactly as committed:**

| held fixed                | value                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| service image             | `postgis/postgis:16-3.4`                                                     |
| runtime                   | Node `22`, pnpm `11.22.0`                                                    |
| provisioning / migrations | `infrastructure/docker/postgres/00-init-databases.sh`, identity `db:migrate` |
| induced condition         | `CPU_PERIOD_US=1000000`, `CPU_QUOTA_US=15000`, PostgreSQL container only     |
| probe                     | `WAL_PROBE_SQL`, 60 s, `PROBE_VALIDITY` unchanged; 10 s read-only control    |
| stress constants          | `TOTAL = 500`, four independent clients, `LANES_PER_CLIENT = 2`              |
| timeouts / window         | `timeoutMs: 5000` statement bound, `WINDOW_SECONDS = 60`, `}, 120_000);`     |
| invocation                | unfiltered `pnpm run test:aggregation-stress`, `--runInBand`, all assertions |
| retries / filters         | none, at any level                                                           |

**Quota read-back is mandatory in every job.** A slot that cannot verify both
`HostConfig.CpuPeriod` and `HostConfig.CpuQuota` as the exact requested constants refuses **before
measuring** and is an ineligible slot under § 4 — never a silently unconstrained measurement.

**Provenance (design).** Every artifact and log records the same narrow, safe provenance vocabulary
already in use: runner OS and image label, kernel, CPU count, memory, storage driver, running
container count, container image names, the two quota constants, and the ten named `pg_settings`.
Nothing else.

**Independence caveat, stated rather than glossed.** Fresh ephemeral jobs with fresh databases make
these trials **materially more independent** than twenty serial pairs sharing one job, one
database, one WAL and one filesystem. They do **not** prove universal independence: the slots still
share a hosted-runner fleet, an image family, a container registry and a scheduler, and they may
share physical hardware or noisy neighbours in ways this design cannot observe. Results generalise
to _this hosted-runner and image cohort at this condition_ and no further.

---

## 8. Future workflow feasibility audit — **the YAML was not created**

Inspection of the harness, the package scripts, the current `ci.yml` and the temporary campaign
workflow as it existed at commit `a0db638` shows the design is implementable. The required shape is
described here in prose so the future campaign iteration can build it; **no YAML, and no
copy-pasteable fragment that could accidentally trigger, is committed.**

### 8.1 Harness audit — what was independently verified

Each claim below was re-verified against the current working tree by importing the modules
read-only in a temporary script **outside** the repository (not committed — it is a one-shot
assertion list with no consumer).

| claim                                               | result                                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MIN_CALIBRATION_PAIRS = 1`                         | **holds** — and `MAX_CALIBRATION_PAIRS = 20`                                                                                                                             |
| the CLI accepts `--pairs 1`                         | **holds** — parses to `{ mode: 'calibrate', pairs: 1 }`; `0` and `21` are refused                                                                                        |
| the plan is control, then adjacent Probe→full-suite | **holds** — `plan(1)` is exactly `control`, `pair-1-probe`, `pair-1-stress`, in that order                                                                               |
| the stress step is the unfiltered root script       | **holds** — `['run','test:aggregation-stress','--','--json']`                                                                                                            |
| the contract accepts the real spec with `pairs: 1`  | **holds** — zero problems                                                                                                                                                |
| the contract rejects **filters**                    | **holds** — `--testNamePattern=…` → "stress run must be unfiltered"; `--passWithNoTests` refused                                                                         |
| the contract rejects **drift**                      | **holds** — six independent mutations refused (`TOTAL`, `LANES_PER_CLIENT`, `WINDOW_SECONDS`, the 5000 ms bound, the 120 s test timeout, the single-`created` assertion) |
| the contract rejects **retries**                    | **holds with one narrow blind spot** — see § 8.2                                                                                                                         |
| the contract rejects non-adjacent pairs             | **holds**                                                                                                                                                                |
| reports are aggregates-only                         | **holds** — a rendered report for a synthetic failing pair contains no connection string, absolute path, credential word, IP, PID, stack frame or Jest marker            |
| reports keep the `VALID` vocabulary                 | **holds** — no `VALID_CAPABLE` / `VALID_INCAPABLE` anywhere                                                                                                              |
| a failed suite propagates non-zero                  | **holds** — `results.every(r => r.passed) && !topo.error ? 0 : 1`                                                                                                        |
| the full-suite step keeps its 30-minute bound       | **holds** — `timeoutMs: 30 * MINUTE`                                                                                                                                     |
| test-phase placement is unchanged                   | **holds** — the exclusive phase is still `@rasta/identity-service` `test:aggregation-stress`, and `planTestRun('test')` is still workspace-then-exclusive                |
| the campaign is outside every ordinary gate         | **holds** — `pnpm verify` does not reference `calibrate:aggregation-stress`, and neither does `ci.yml`                                                                   |

### 8.2 The one residual harness finding — recorded, not fixed here

`validateCalibrationContract` rejects a retry argument with `/^--retry/`. That matches `--retry`
and `--retryTimes=…` but **not** the literal `--retries` / `--retries=2`, which passes the guard.

This is **not** a blocker for this design, for three independent reasons: the pre-registered
invocation passes no extra arguments at all (`--calibrate --pairs 1 <path>`); the plan the contract
validates is machine-generated by `planCalibrationRun`, which can never emit a retry argument; and
the _spec-side_ retry guard (`/retryTimes|\.retry\(/`) is separate and does reject a spec that
retries. It is recorded here as a narrow defence-in-depth gap worth a separate, independently
reviewed fix. **No script was changed in this iteration.**

### 8.3 Required shape of the future temporary workflow

- **A 59-entry matrix indexed `1..59`**, one pair per matrix job, each invoking
  `calibrate:aggregation-stress -- --pairs 1 --slot <matrix index>` so the report content carries
  `campaign_slot=<matrix index>` (added 2026-09-16, after this preregistration; the slot is explicit
  input and changes no design value).
- **`strategy.fail-fast: false`** — mandatory. A qualifying failure makes its own job red, and
  cancelling the other 58 would convert a measured event into 58 missing slots. (`ci.yml` already
  uses this setting on its existing container matrix, so the pattern is in-repo precedent.)
- **One PostgreSQL service container per matrix job**, and nothing else on the machine — the exact
  image resolution in the `a0db638` workflow refuses unless exactly one container matches.
- **Unique artifact and report names containing the replication index**, so that no slot can
  overwrite another and no existing evidence artifact under `docs/evidence/adr-055/` can be
  overwritten.
- **`if: always()` on the upload step** — a red job is precisely the job whose artifact matters.
- **No shared mutable database**, **no matrix job retry**, **no `continue-on-error`**.
- **Capture and re-raise each campaign exit** (`set +e` … `status=$?` … `exit "$status"`, as in
  `a0db638`), so the artifact is uploaded _and_ the qualifying failure stays red, while the other
  matrix entries continue to completion.
- **A workflow `concurrency` group with `cancel-in-progress: false`** — a half-measured campaign is
  a dataset with a hole in it, not a shorter campaign.
- **Pinned action SHAs** and **`permissions: contents: read`**, as in both `ci.yml` and `a0db638`.
- **No ordinary-CI integration**: `ci.yml` untouched, `pnpm verify` untouched, test phases
  untouched.
- **Deletion of the temporary workflow in the same future iteration**, immediately after evidence
  capture — the established practice of every prior campaign iteration on this branch.

**Verification before the quota, in every job** — the infrastructure-free
`pnpm run test:aggregation-evidence-lib` and `pnpm run check:test-phases`, exactly as in `a0db638`,
so a drifted harness or contract fails before any measurement cost is attributed to the database.

**Reviewed draft, added 2026-09-16 after this preregistration.** The shape above now exists as a
non-executable draft,
[`fresh-run-campaign-workflow-draft-2026-09-16.yaml.txt`](fresh-run-campaign-workflow-draft-2026-09-16.yaml.txt)
(not under `.github/workflows/`, so GitHub cannot run it). Its first step exits non-zero before
checkout unless `github.run_attempt` is `1`, so a manual re-run of any slot measures nothing. Check it
with `pnpm run check:aggregation-campaign-workflow -- <draft>`. The check is static and manual, and
exits `0` only when the whole contract holds. A launch must run the same check on the installed copy
before pushing it. No design value in this section or in §§ 3–7 and § 9 changed.

**Offline log recovery, added 2026-09-16 after this preregistration.** The § 9.3 fallback now has a
committed tool: `pnpm run recover:aggregation-campaign-logs -- <job-log> …`. It recovers each report
between the calibration header and footer, removes only the § 9.3 log-line prefix and CRLF line framing, validates each
report with the same strict parser as a downloaded artifact, and runs the § 8.4 accounting. Its
fixtures are synthetic, and no design value changed.

### 8.4 How the aggregation/review step counts 59 slots

**A red job is neither missing nor green, and the counting step must not read job conclusions at
all.** Under this design a qualifying failure _is_ a red job, so `conclusion == failure` carries no
information about slot validity.

The review step therefore enumerates **slot indices `1..59`** — not artifacts found, not jobs
succeeded — and for each index resolves exactly one of four states from the **artifact content**:

| resolved from the artifact                                                                                               | slot state                    |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `VALID` pair, suite passed                                                                                               | eligible **non-event**        |
| `VALID` pair, suite failed with environment categories only, product-assertion categories all `0`                        | eligible **qualifying event** |
| `INVALID` / `INCONCLUSIVE` / `ran=no` / process bound / product-assertion or mixed or unknown failure / contract refusal | **blocker** (§ 5.2)           |
| no artifact for that index, or an artifact that does not parse or whose provenance does not match                        | **missing**                   |

The denominator is fixed at 59 by construction. `eligible non-events + qualifying events +
blockers + missing == 59` is an assertion the review step must make and report; any other total is
itself a blocker. Branch A/B of § 6 apply only when `blockers == 0` and `missing == 0`; otherwise
Branch C applies.

**Implemented 2026-09-16, after this preregistration.** The counting step is
`pnpm run account:aggregation-campaign -- <report> …`, given every campaign report explicitly. It
reads the slot from each report's `campaign_slot=` field, never from a name or order, applies the
four states above from content, prints every slot and the invariant, and exits `0` only for a
complete, provenance-consistent campaign with zero blockers and zero missing slots. It applies no
§ 6 interpretation. Only the invocation in § 7 and § 8.3 gained `--slot`; no design value in
§§ 3–7 or § 9 changed. One reading is made explicit rather than invented: `otherDatabaseError` is
not among the established environment categories of § 5.2, so it is counted as an unclassified
failure — a blocker, never a qualifying event.

---

## 9. Cost and operational caveats

### 9.1 Per-job timeout, recomputed from measured evidence

The old 180-minute bound was sized for **20 serial pairs in one job**. It is **not** multiplied or
scaled here. The one-pair-per-job budget is rebuilt from measured components:

| component                                             | measured value                                                              | source                                                                                   |
| ----------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| job start → measurement step start                    | `61 s` and `72 s`; **max `72 s`** used                                      | run `35045042687` (`01:41:01Z`→`01:42:02Z`), run `35048202361` (`02:29:53Z`→`02:31:05Z`) |
| read-only control probe                               | `10 s` nominal (`CONTROL_SECONDS`)                                          | harness constant                                                                         |
| pair probe                                            | `60 s` nominal (`PROBE_SECONDS`)                                            | harness constant                                                                         |
| per-pair non-stress harness overhead                  | **`5.76 s`** mean                                                           | derived below                                                                            |
| unchanged stress suite, worst observed at `0.015 CPU` | **`271.3 s`** (the `pair-1` row — the very position this campaign measures) | induced artifact; the single `0.015 CPU` observation was `153.2 s`                       |
| measurement end → job complete                        | `6 s` and `5 s`; **max `6 s`** used                                         | same two runs                                                                            |

**Per-pair overhead, derived (observed).** Step 13 of run `35048202361` ran `02:31:05Z`→`03:36:45Z`
= `3940 s`. The accounted measurement time inside it is `20 × 60 s` probes + `10 s` control + the
row-summed stress wall `2614.8 s` = `3824.8 s`. The residue is `115.2 s` over 20 pairs =
**`5.76 s` per pair** (sampler start/stop, WAL reads, settle, report assembly).

**Expected per job:** `72 + 10 + 60 + 5.76 + 271.3 + 6` = **`425.06 s` ≈ 7 m 5 s**, using the
_worst_ observed stress wall at this condition rather than the median.

**Fully bounded worst case per job**, i.e. every harness bound hit rather than the measured cost:
`72` setup + `120` topology bound + `130` control-probe bound (`10 + 2 min`) + `180` pair-probe
bound (`60 + 2 min`) + `1800` full-suite bound (`30 * MINUTE`, unchanged) + `6` teardown =
**`2308 s` ≈ 38 m 28 s**.

**Derived per-job timeout: `45 minutes` (design).** It exceeds the fully bounded worst case by
`392 s`, so **the harness's own 30-minute step bound — not the job bound — is what stops a hung
stress run**, which is the property that keeps the artifact writable and the slot accountable
rather than silently missing. It is `6.35 ×` the expected cost, and it is `135 minutes` _smaller_
than the serial campaign's bound, not a multiple of it.

### 9.2 Runner-minutes versus wall-clock

These are different quantities and the design does not conflate them:

- **Total job wall-clock, summed:** `59 × 425.06 s` ≈ **`6 h 58 m`** at the expected cost.
- **Absolute ceiling if every slot ran to its bound:** `59 × 45 min` = **`2655 job-minutes`**
  ≈ `44 h 15 m` of summed job time.
- **Elapsed wall-clock** is `ceil(59 / C) × per-job` for an effective concurrency `C`. **`C` is not
  claimed here.** It depends on account-level concurrency limits and queue behaviour, neither of
  which is established by anything in this repository.

**Not claimed, and required to be verified by the future campaign review before launch:** the
effective concurrency level, queue time, the current GitHub matrix-size limit, runner-image
stability across a 59-job fan-out, billing granularity or allowance, and artifact-download
availability. Two committed runs at this condition are evidence about cost per job; they are not
evidence about fleet behaviour under fan-out.

**Runner/image consistency is a comparability requirement, not only a cost one.** The two committed
campaigns share a byte-identical `topology:` line (Ubuntu 24.04.5 LTS, image
`ubuntu24/20260907.300.1`, kernel `6.17.0-1022-azure`, 4 CPU, 15.6 GiB, `overlay2`). If the 59 jobs
do **not** all report the same topology, the slots are not comparable and § 6 Branch C applies. The
future review must check this across all 59 artifacts, not assume it.

**Cohort review, added 2026-09-17 after this preregistration.** That check now has a committed tool:
`pnpm run review:aggregation-campaign-image-cohort -- <review-manifest> <report> …`. It validates a
pre-launch release-snapshot manifest, runs the § 8.4 accounting, and prints `COHORT: BRANCH C` unless
the accounting is complete with one commit and one byte-identical measured topology. Its fixtures
are synthetic, and no design value or Branch A/B/C meaning changed.

### 9.3 Evidence-retrieval risk and its predeclared fallback

**Observed.** On this local host `gh run download` has repeatedly failed because
`*.blob.core.windows.net` is unreachable. This is a **retrieval** risk, not a measurement risk, and
it is **not** solved or exercised in this iteration.

**Predeclared fallback (design), byte-identity preserving.** The harness prints the complete report
text to its log from the _same string_ it writes to the artifact file. So when artifact download is
unavailable, each slot's text may be recovered from that job's log by stripping only the GitHub log
line prefix, with **no figure edited, reformatted, re-rounded or reconstructed**. The fallback is
admissible only when, for every recovered slot, the recovered text passes the same redaction and
completeness validation as a downloaded artifact and the slot accounting of § 8.4 still totals 59.
If any single slot cannot be recovered byte-faithfully, that slot is **missing** and Branch C
applies — a partially recovered campaign is not a 59-slot campaign.

---

## 10. Security and governance

**Artifacts remain aggregates-only and redacted.** No URL, connection string, credential, token,
local absolute path, IP address, PID, container identity, raw exception text, raw subprocess output,
or test identifier/title. No secret, no broad environment dump, no broad `docker inspect` — quota
verification reads exactly the two `HostConfig` fields and nothing else, exactly as in `a0db638`.
This was re-verified mechanically against a rendered report for a synthetic failing pair (§ 8.1).

**Governance, unchanged by this document:**

- This is an **engineering calibration decision**, not a business rule, so it is **not** added to
  `docs/24-open-questions.md` — the same reasoning ADR-055 already records for the threshold itself.
- **ADR-055 remains `Proposed`.** ADR-053 remains `Proposed`. **AUD-004 remains open.** `COM-009`
  remains `READY` at **13 points**. `planning/backlog.json`, statuses and point values are
  untouched.
- **No runtime or CI behaviour was added or changed.** No threshold, no safety margin, no
  predictor, no `VALID_CAPABLE`/`VALID_INCAPABLE`, no capability classifier, no phase preflight, no
  fail-fast gate, no bypass, no retry, no skip-green behaviour, and no `pnpm verify` or test-phase
  change.
- **No campaign was run and no workflow was created.** `.github/workflows/` still contains only
  `ci.yml`.

---

## 11. Reproducing the numbers in this document

Every figure above is a function of committed artifacts, recorded GitHub run metadata, and closed-
form arithmetic:

- **Sample size:** `ceil(log(0.05) / log(0.95))`, and `1 - 0.95^n` for `n ∈ {57, 58, 59, 60}`.
- **Zero-event bound:** `1 - 0.05^(1/n)` for `n ∈ {58, 59}`; cross-check `(1 - U)^59 = 0.05`.
- **Stress wall sum:** sum the 20 `wall_s=` values in
  `induced-calibration-0015cpu-github-2026-09-16.txt` → `2614.8 s`.
- **Per-pair overhead:** `(3940 - 20*60 - 10 - 2614.8) / 20`.
- **Setup and teardown:** step timestamps of runs `35048202361` and `35045042687`.

No analysis script is committed for this: it is closed-form arithmetic over a handful of values,
and committing a script to perform it would add a maintained artifact with no consumer — the same
reasoning the threshold-governance review § 9 records.
