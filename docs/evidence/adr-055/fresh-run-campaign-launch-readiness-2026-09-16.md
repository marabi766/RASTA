# ADR-055 fresh-run campaign — launch-readiness gate, 2026-09-16

**Verdict: NO-GO.** The preregistered 59-slot campaign must not launch.

**Nothing was launched.** No campaign was run, no workflow was created, committed, pushed or
dispatched, no measurement was taken, and no run was rerun, cancelled, deleted or approved. No
Docker or PostgreSQL resource was started or changed. No credential was refreshed, printed or
altered. The
[preregistration](fresh-run-first-pair-replication-design-2026-09-16.md), the
[threshold-governance review](threshold-governance-review-2026-09-16.md) and every existing
measurement artifact are unchanged. This document is a read-only gate over operational
preconditions. It is not evidence about the estimand.

**Fail-closed rule, fixed before the table was filled in:** the result is GO only if **every** row
below is `VERIFIED`. A `BLOCKED` or `UNVERIFIED` row makes the result NO-GO. Absence of proof is
`UNVERIFIED`, never approval.

| status       | meaning                                                                   |
| ------------ | ------------------------------------------------------------------------- |
| `VERIFIED`   | established in this session by a cited probe, file or primary document    |
| `BLOCKED`    | a concrete, reproduced impediment prevents establishing it                |
| `UNVERIFIED` | not established; no impediment proven, but no evidence of the fact either |

---

## 1. Starting state

| fact                       | value                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| branch                     | `feat/audit-service-aud-004-contract`                                                                                         |
| local `HEAD` = upstream    | `3f5cd8b952174db43adda2bb018032a1635bd596` (`fix(identity): reject calibration retries`)                                      |
| tracked worktree / index   | clean                                                                                                                         |
| `.github/workflows/`       | `ci.yml` only                                                                                                                 |
| retry-contract fix present | `scripts/aggregation-evidence-lib.mjs` guard is `/^--retr(?:y\|ies)/`                                                         |
| focused evidence suite     | `node --test scripts/aggregation-evidence.test.mjs scripts/aggregation-evidence-cli.test.mjs` → **52 tests, 52 pass, 0 fail** |

---

## 2. Live probes (UTC, 2026-09-16)

All commands are read-only. Tokens, headers, local paths and resolved addresses are omitted. The
repository is `marabi766/RASTA`.

### 2.1 Authentication and API reachability — recorded separately

| time                    | command / endpoint  | result                                                                                                |
| ----------------------- | ------------------- | ----------------------------------------------------------------------------------------------------- |
| `11:31:05Z`             | `gh auth status`    | exit 0; logged in to `github.com`; scopes `gist`, `read:org`, `repo`, `workflow`; **no `user` scope** |
| `11:31:16Z`–`11:31:22Z` | `GET rate_limit` ×5 | **5/5 exit 0**; core `4992/5000`                                                                      |
| `11:35:24Z`             | `GET rate_limit`    | exit 0; core `4981/5000`                                                                              |

Every repository-metadata call below also returned successfully. **Authentication is valid** (an
authenticated call to repository-scoped endpoints succeeded) and **`api.github.com` was reachable**
throughout the probe window. These are separate facts.

### 2.2 Repository and Actions facts

| endpoint                                                        | non-sensitive result                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| `GET repos/{repo}`                                              | `visibility=public`, `default_branch=main`, owner type `User`  |
| `GET repos/{repo}/actions/permissions`                          | `enabled=true`, `allowed_actions=all`                          |
| `GET repos/{repo}/actions/permissions/workflow`                 | `default_workflow_permissions=read`                            |
| `GET repos/{repo}/branches/feat/audit-service-aud-004-contract` | `sha=3f5cd8b9…`, `protected=false`                             |
| `GET repos/{repo}/pulls/44`                                     | `open`, `draft=true`, head `3f5cd8b9…`, base `main`            |
| `GET repos/{repo}/actions/runners`                              | `total_count=0` (no self-hosted runners)                       |
| `GET user` → `.plan`                                            | `null` — the plan is **not exposed** to the current credential |
| `GET users/{owner}/settings/billing/usage`                      | **HTTP 404**; CLI: operation needs the `user` scope            |
| `GET users/{owner}/settings/billing/actions`                    | **HTTP 404**; CLI: operation needs the `user` scope            |

The `user` scope was **not** requested: `gh auth refresh` is outside this gate's mandate.

### 2.3 Queue behaviour available from existing runs

`GET repos/{repo}/actions/runs/{id}/jobs`, job `created_at` → `started_at`:

| run           | jobs sampled | queue delay per job | simultaneous jobs observed                                                       |
| ------------- | -----------: | ------------------- | -------------------------------------------------------------------------------- |
| `35048202361` |            1 | `2 s`               | overlapped with CI run `35048205928`: **5** jobs started `02:29:53Z`–`02:29:56Z` |
| `35048205928` |            6 | `2 s` each          | (same window)                                                                    |
| `35045042687` |            1 | `2 s`               | 1                                                                                |
| `35071436785` |            6 | `1`–`2 s`           | 4 then 2                                                                         |

The largest simultaneous fan-out this repository has recorded is **5 jobs**. Nothing here observes
queueing at 20, let alone 59, jobs.

### 2.4 Runner image in use today

From the run-level log archive of the latest CI run `35071436785` (`08:00Z` today), the
`Runner Image` group of all six executed jobs reads `Image: ubuntu-24.04`,
`Version: 20260907.300.1` — the same version recorded in the committed induced artifact.
`GET repos/actions/runner-images/releases` (`11:35Z`): newest `ubuntu24/*` release is
`ubuntu24/20260907.300`, published `2026-09-08T09:34:53Z`; the previous is `ubuntu24/20260831.293`.

### 2.5 Evidence retrieval, against the existing run `35048202361`

`GET repos/{repo}/actions/runs/35048202361/artifacts`: `adr-055-induced-calibration-0015cpu`,
`2272` bytes, `expired=false`, expires `2026-09-19T03:36:45Z`.

All downloads went to a temporary directory outside the repository, which was removed afterwards
(exact directory only).

| time        | route                                                                | result                                                                   |
| ----------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `11:32:30Z` | `gh run download 35048202361 -n adr-055-induced-calibration-0015cpu` | **exit 1** — `dial tcp … connectex` timeout to `*.blob.core.windows.net` |
| `11:33:07Z` | `GET repos/{repo}/actions/artifacts/10429646723/zip`                 | **exit 1** — same host, same connect timeout                             |
| `11:33:30Z` | `GET repos/{repo}/actions/jobs/{job}/logs`                           | **exit 1** — same host, same connect timeout                             |
| `11:33:54Z` | `GET repos/{repo}/actions/runs/35048202361/logs` (run archive)       | **exit 0**, `63103` bytes                                                |
| `11:34:47Z` | `GET repos/{repo}/actions/runs/35071436785/logs` (run archive)       | **exit 0**, `333727` bytes                                               |

**Log-recovery fallback, exercised read-only.** In the run archive the report begins at the line
`ADR-055 paired calibration - probe immediately followed by the unchanged stress project`. Taking
that line and the following 169 lines, removing CR and stripping only the leading
`YYYY-MM-DDThh:mm:ss.fffffffZ ` prefix produced text that is **byte-identical** to the committed
`induced-calibration-0015cpu-github-2026-09-16.txt` (`cmp` equal; both SHA-256
`06150071b3dd59bd198d3e4ec56f299f0360857426d288f5de9cdbcc6394a6dc`).

What this does **not** prove, and why it is not enough:

1. The committed file was itself recovered from the job log in an earlier iteration, because the
   artifact was unreachable then too. Agreement shows the log recovery is **reproducible**, not
   that it equals the **artifact bytes**. The artifact digest (`sha256:ec3eba5f…`) is over the zip,
   which could not be fetched.
2. The slice length (170 lines) was taken from the reference file. No mechanical end-of-report
   rule was demonstrated that works **without** a reference.
3. No committed validator parses a recovered report for completeness and redaction; that check is
   not yet executable.
4. It was one single-job run. Recovery of 59 matrix jobs from one run archive was not demonstrated.

### 2.6 What the report content can identify

`formatCalibrationReport` (`scripts/aggregation-evidence-lib.mjs`) writes `commit=`, `generated=`
and `topology:` in its header; `scripts/aggregation-evidence.mjs` passes no `runUrl` and no slot
index into `meta`. With `--pairs 1` every slot's report says `pair-1`. **The report text alone does
not identify its slot index.** Under the preregistered design the index lives only in the artifact
and report _names_ (§ 8.3), and under the log fallback only in the job name. No committed tool
enumerates slots `1..59` and asserts `non-events + events + blockers + missing == 59`.

---

## 3. Official documentation (primary GitHub sources, accessed 2026-09-16)

| source                                                                                              | documented platform fact                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Actions limits](https://docs.github.com/en/actions/reference/limits)                               | "A job matrix can generate a maximum of 256 jobs per workflow run." Standard GitHub-hosted runner total concurrent jobs: Free `20`, Pro `40`, Team `60`, Enterprise `500`. 6 h per job on GitHub-hosted runners. The 24 h queue limit sits under the self-hosted heading. |
| [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)       | "GitHub Actions usage is free for self-hosted runners and for public repositories that use standard GitHub-hosted runners." Spending "may be limited by one or more budgets." Larger runners are always billed.                                                           |
| [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) | public-repository standard Linux runner: 4 CPU, 16 GB RAM, 14 GB SSD; `-latest` images are "the latest stable images that GitHub provides".                                                                                                                               |
| [actions/runner-images README](https://github.com/actions/runner-images)                            | "We typically deploy weekly updates to the software on the runner images." "Usually, image deployment takes 2-3 days". A specific **OS** label can be chosen (e.g. `ubuntu-22.04`); no image-**version** pin is offered.                                                  |

**Platform limits are not account facts.** `256 ≥ 59` settles matrix size. The concurrency table
is a per-plan **maximum**; this account's plan was not exposed (§ 2.2), and a maximum is not an
effective concurrency. Queueing behaviour beyond the concurrency limit is not stated on the limits
page.

---

## 4. Cost exposure, recomputed from preregistration § 9

| quantity                    | arithmetic                        | result                                             |
| --------------------------- | --------------------------------- | -------------------------------------------------- |
| expected per job            | `72 + 10 + 60 + 5.76 + 271.3 + 6` | `425.06 s`                                         |
| expected campaign           | `59 × 425.06 s`                   | `25078.54 s` = **`417.98` job-minutes** ≈ 6 h 58 m |
| fully bounded harness worst | `59 × 2308 s`                     | `136172 s` = `2269.53` job-minutes                 |
| preregistered ceiling       | `59 × 45 min`                     | **`2655` job-minutes** ≈ 44 h 15 m                 |

The fixed 59 slots, the 45-minute job timeout, the 5 % / one-sided 95 % target, eligibility and
interpretation are **unchanged**. Elapsed wall-clock depends on an effective concurrency `C` that
is **not** established (§ 3).

**Billing and authorization.** The repository is public and the documented policy says standard
hosted runners are free for public repositories. That is a platform policy, not a verified account
state: the billing and usage endpoints were refused for lack of the `user` scope, and no budget,
spending-limit or allowance fact could be read. **No recorded authorization by the account owner
for a 418 expected / 2655 ceiling job-minute exposure exists in this repository.**

---

## 5. GO / NO-GO table

| #   | precondition                                     | status         | evidence                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | GitHub authentication                            | **VERIFIED**   | § 2.1 `gh auth status` exit 0 with `repo`,`workflow` scopes; authenticated repository calls succeeded (§ 2.2)                                                                                                                                                                                |
| 2   | API / network reliability                        | **BLOCKED**    | REST API 100 % reachable in-window (§ 2.1), but `*.blob.core.windows.net` connect-timed-out on 3/3 routes (§ 2.5); reliability over a ≥ 7 h campaign not observable                                                                                                                          |
| 3   | branch / commit identity                         | **VERIFIED**   | local `HEAD` = upstream = remote branch = PR #44 head = `3f5cd8b9…` (§ 1, § 2.2); a future campaign commit must be re-verified at launch                                                                                                                                                     |
| 4   | Actions enabled                                  | **VERIFIED**   | `enabled=true`, `allowed_actions=all`, default workflow token `read` (§ 2.2)                                                                                                                                                                                                                 |
| 5   | 59-entry matrix support                          | **VERIFIED**   | documented platform maximum 256 jobs per workflow run (§ 3)                                                                                                                                                                                                                                  |
| 6   | effective / account concurrency                  | **UNVERIFIED** | plan `null` to the current credential (§ 2.2); per-plan table is a maximum, not an effective value (§ 3)                                                                                                                                                                                     |
| 7   | queue behaviour                                  | **UNVERIFIED** | largest observed fan-out 5 jobs, 1–2 s queue (§ 2.3); no evidence at 20+ jobs; not documented beyond the limit (§ 3)                                                                                                                                                                         |
| 8   | billing / allowance / spending authorization     | **BLOCKED**    | billing endpoints HTTP 404, `user` scope required and not requested (§ 2.2); no owner authorization recorded (§ 4)                                                                                                                                                                           |
| 9   | runner / image comparability plan                | **UNVERIFIED** | today's jobs are on `20260907.300.1` (§ 2.4) but images update weekly with a 2–3 day rollout and no version pin (§ 3); the newest release is 8 days old, so a roll-forward during the campaign is plausible. Only the 59 resulting `topology:` lines can validate it; a mismatch is Branch C |
| 10  | artifact retrieval                               | **BLOCKED**    | artifact download and artifact zip both timed out (§ 2.5); log fallback reproduced the committed text byte-identically but not against artifact bytes, without a reference-free boundary rule, validator or 59-job demonstration (§ 2.5 items 1–4)                                           |
| 11  | retry prohibition                                | **UNVERIFIED** | harness contract rejects all seven retry spellings (52/52, § 1), but the matrix workflow does not exist, so job-level no-retry and manual re-run detection (`run_attempt`) cannot be checked yet; draft later statically checked (§ 9), installed workflow not yet reviewed                  |
| 12  | account for all 59 indices from artifact content | **VERIFIED**   | implemented later on 2026-09-16, not a live probe: reports carry `campaign_slot=<n>` from the required `--slot`; `account:aggregation-campaign` resolves `1..59` from content (§ 8). `UNVERIFIED` at gate time (§ 2.6)                                                                       |

**Overall: NO-GO.** At gate time rows 2, 6, 7, 8, 9, 10, 11 and 12 were not `VERIFIED`. After the
slot-accounting implementation (§ 8) row 12 is `VERIFIED`; rows 2, 6, 7, 8, 9, 10 and 11 remain
unresolved, so the verdict is unchanged.

---

## 6. Prerequisites before any launch iteration

1. **Retrieval:** a host that can reach `*.blob.core.windows.net`, proven by downloading an
   existing ADR-055 artifact byte-for-byte; or a separately reviewed, reference-free and
   mechanically validated log-recovery procedure demonstrated on a multi-job run. **Offline,
   reference-free recovery tooling implemented later on 2026-09-16 (§ 10); the demonstration on a
   real multi-job run is still outstanding.**
2. **Billing and authorization:** account billing, budget and allowance facts read with an
   appropriately scoped credential that the owner provides deliberately, plus an explicit, recorded
   owner authorization for the 2655 job-minute ceiling.
3. **Concurrency and queueing:** the account plan and its effective concurrency established from
   account evidence, not from the documentation maximum.
4. **Slot accounting:** a reviewed way to bind each report to its slot index from artifact content,
   and a slot-accounting procedure that enumerates `1..59` without reading job conclusions.
   **Implemented later on 2026-09-16 (§ 8).**
5. **Image cohort:** a launch timed and documented against the runner-image release state, with
   the Branch C consequence of any topology mismatch accepted in advance. **Manifest contract and
   post-run cohort check implemented later on 2026-09-16 (§ 11); the real pre-launch snapshot and the real
   59-report check are still outstanding.**
6. **Retry prohibition at job level:** verified in the workflow itself when it is drafted, including
   a check that every run's `run_attempt` is `1`. **Draft and static check implemented later on
   2026-09-16 (§ 9); the review of the installed workflow at launch is still outstanding.**

None of these changes the preregistered design.

---

## 7. Reproducing this gate

- Tests: `node --test scripts/aggregation-evidence.test.mjs scripts/aggregation-evidence-cli.test.mjs`.
- Probes: the endpoints in §§ 2.1–2.5 with `gh api`. In Git Bash, pass endpoints **without** a
  leading `/`; otherwise the shell rewrites them into filesystem paths (the first five probes of
  this session failed locally for exactly that reason and never reached the network).
- Arithmetic: § 4, from preregistration § 9.1–9.2.

---

## 8. Update — row 12 resolved by implementation (later on 2026-09-16)

This section records a code change, not a new live probe. §§ 1–5 above are the gate as it was run
and are not rewritten.

- `scripts/aggregation-evidence.mjs --calibrate` now **requires** `--slot <1..59>` and refuses it
  without `--calibrate`. It rejects a missing, repeated, empty, signed, decimal, zero-padded, zero or
  out-of-range slot before any prerequisite check. Every calibration report, refused or measured,
  carries `campaign_slot=<n>` exactly once as its third line. The legacy evidence report is byte-for-byte
  unchanged.
- `pnpm run account:aggregation-campaign -- <report> …` (`scripts/aggregation-campaign-accounting.mjs`
  and its pure library) resolves every slot `1..59` to `non-event`, `event`, `blocker` or `missing`
  from report content only. It treats absent, duplicate, malformed or out-of-range slot claims,
  truncated or edited reports, extra inputs, and commit or topology mismatches as missing or
  rejected. It prints `non-events + events + blockers + missing = 59` and exits `0` only for a
  complete, consistent campaign with zero blockers and zero missing slots. It reads no job
  conclusion and applies no threshold or interpretation.

**Row 12 is `VERIFIED`. Rows 2, 6, 7, 8, 9, 10 and 11 remain unresolved. The verdict stays NO-GO.**
Still not content-verifiable: the quota read-back. A job that fails it stops before measuring and
leaves no report, so that slot is `missing`, but a report does not itself record the applied
quota.

---

## 9. Update — row 11: workflow draft and static retry check (later on 2026-09-16)

This section records a code and document change, not a new live probe. §§ 1–5 above are the gate as
it was run and are not rewritten. Nothing was installed, pushed, dispatched or rerun, and no GitHub
API was called.

**Added.**

- A reviewed, **non-executable** draft:
  [`fresh-run-campaign-workflow-draft-2026-09-16.yaml.txt`](fresh-run-campaign-workflow-draft-2026-09-16.yaml.txt).
  It sits under `docs/evidence/adr-055/` with a `.yaml.txt` extension, so GitHub cannot discover it.
  `.github/workflows/` still holds only `ci.yml`.
- A manual static check:
  `pnpm run check:aggregation-campaign-workflow -- <draft>`
  (`scripts/aggregation-campaign-workflow.mjs` and its pure library). It reads only the named file,
  never prints the path, and exits `0` only when the whole contract holds, `1` otherwise and `2` on a
  usage error. It is not part of `pnpm verify`, the test phases or `ci.yml`.

**What the check proves about the draft.** It uses a narrow parser for the draft's own YAML subset
and refuses anything outside it, including any duplicate key. On the parsed structure it requires:

- exactly one job with exactly one `postgis/postgis:16-3.4` service container, and a literal `slot`
  matrix holding each of `1..59` exactly once, with no other axis and no dynamic matrix;
- `fail-fast: false`, `runs-on: ubuntu-24.04` and `timeout-minutes: 45`;
- `permissions` of exactly `contents: read`, declared only at top level, and
  `cancel-in-progress: false`;
- a single literal `push` trigger on the installed workflow path, never a dispatch or schedule;
- a **first step** whose shell exits non-zero unless `github.run_attempt` is `1`, with no step
  condition, before checkout and before measurement;
- one calibration step whose body captures and re-raises exactly one
  `calibrate:aggregation-stress -- --pairs 1 --slot "${{ matrix.slot }}" "$RUNNER_TEMP/<slot-named>.txt"`;
- an `if: always()` upload of that same slot-named report with `if-no-files-found: error`;
- every `uses:` pinned to a 40-hex commit SHA.

It also rejects:

- `continue-on-error`, extra step or job keys, and step conditions other than the upload's;
- retry, rerun, re-dispatch or replacement spellings, shell loops and the `gh` CLI;
- caching, and expression contexts other than `matrix.slot`, `runner.temp`, `github.ref` and `env.*`
  (so no `secrets`, `fromJSON` or step outputs);
- token references.

The committed draft passes: CLI exit `0`. `scripts/aggregation-campaign-workflow.test.mjs`
(**17/17**) rejects every required mutation, runs the CLI exit-code and no-path tests, and proves the
committed draft passes.

**Why row 11 stays `UNVERIFIED`.** The row is about the retry prohibition of the campaign that
launches, and this gate's fail-closed rule does not accept a proxy for that. Three things remain
unproven:

1. **No installed workflow was reviewed.** An uninstalled draft governs no run, and nothing yet shows
   that the file installed at launch is byte-identical to this draft.
2. **Static checks do not see GitHub internals.** They cannot prove that GitHub never retries
   hosted-runner infrastructure internally.
3. **The guard does not catch a second push.** A second push that touches the installed file starts
   a new run with `run_attempt` `1`.

What is now proven: the proposed job-level shape carries no retry, rerun, replacement or optional
stopping, and a manual re-run attempt of any slot exits before checkout and uploads no report.

**Launch requirement this adds.** Run the check against the installed file before its single push.
Do not push any other change to that file while it is installed. Record that every campaign run
reports `run_attempt` `1`.

**Rows 2, 6, 7, 8, 9, 10 and 11 remain unresolved. The verdict stays NO-GO.**

---

## 10. Update — row 10: offline, reference-free log recovery (later on 2026-09-16)

This section records a code change, not a live probe. §§ 1–5 above are the gate as it was run; the
only edit to them is a punctuation fix in row 11 (`yet.;` → `yet;`) with no change of meaning.
**Nothing was downloaded**: no artifact, no job log and no run archive. No GitHub API or network was
called, and no workflow was installed, pushed, dispatched or rerun.

**Added.** `pnpm run recover:aggregation-campaign-logs -- <job-log> …`
(`scripts/aggregation-campaign-log-recovery.mjs` and its pure library). It is manual and is not part
of `pnpm verify`, the test phases or `ci.yml`. It reads only the log files named on the command line
and writes nothing.

**What replaced the § 2.5 fragility.** The § 2.5 slice took its length (170 lines) from the
committed reference report. The recovery contract instead uses:

- **Boundaries:** only the exported `CALIBRATION_REPORT_HEADER` and `CALIBRATION_REPORT_FOOTER`. No
  reference report, line count, file name, artifact or job name, slot order, job conclusion or colour
  is read.
- **Framing, fail-closed:**
  - Inside one report every line is either unprefixed or carries exactly one valid
    `YYYY-MM-DDThh:mm:ss.fffffffZ ` prefix (the § 2.5 shape); the two modes never mix.
  - Line endings inside a report are consistently CRLF or LF, and every report line is terminated.
  - Only that prefix and the CR of CRLF are removed. Nothing is trimmed, normalised or de-coloured,
    and the final newline is restored.
  - Boundary text in any other framing is rejected. So are an orphan footer, a nested header, an
    unterminated report, a malformed, repeated or mixed timestamp, and any control character in a
    report (ANSI escapes, NUL, tab, bare CR, BOM, C1).
  - Unrelated log text outside a report is ignored.
- **Limits** (named in `LOG_RECOVERY_LIMITS`; a breach rejects, never truncates):

  | limit                      | value   |
  | -------------------------- | ------- |
  | logs                       | 128     |
  | bytes per log              | 64 MiB  |
  | bytes in total             | 256 MiB |
  | reports                    | 59      |
  | lines per report candidate | 200     |
  | bytes per report candidate | 32 KiB  |

  The CLI checks file sizes before reading, so an oversized log is never read.

- **Validation and accounting:**
  - Every candidate must pass the unchanged strict `parseSlotReport`. A malformed, edited or
    truncated report, a report claiming more than one pair, or one whose slot is missing or out of
    range is a recovery rejection.
  - The recovered multiset goes to the unchanged `accountCampaign` and `formatAccounting`, so
    duplicate slots and commit or topology mismatches stay accounting failures.
  - Output prints the recovery counts separately from the accounting.
  - Exit `0` only for zero rejections and a complete accounting with zero blockers and zero missing
    slots. Unreadable input, any rejection, or an incomplete or blocked campaign exits `1`; a usage
    error exits `2`.
  - Diagnostics are fixed reasons with counts. They never contain a path, a timestamp or log content.

**Tests:** `scripts/aggregation-campaign-log-recovery.test.mjs`, **17/17**. They use reports rendered
by the real harness in **synthetic** log framing, and cover:

- byte-exact recovery from plain LF and timestamp-prefixed CRLF logs;
- multiple reports and logs, and all 59 slots accounting complete;
- independence from input order and file names;
- red event reports, recovered exactly like passing ones;
- the framing, limit, parser, provenance, CLI and leakage failures above.

**Sub-gaps closed:** items 2 and 3 of § 2.5.

- **Item 2:** extraction no longer needs a reference; the report's own boundaries delimit it.
- **Item 3:** a committed validator now checks every recovered report for completeness, using the same
  strict parser as downloaded reports.
- Faithful prefix removal and composition with 59-slot accounting are proven on synthetic input.

**Sub-gaps still open:**

1. Equality between recovered text and the **artifact bytes** (§ 2.5 item 1): the artifact still
   cannot be downloaded from this host.
2. A demonstration on a **real multi-job run archive** (§ 2.5 item 4): no such archive exists as
   tracked evidence, and none was downloaded. The synthetic fixtures are not that demonstration.
3. **Future archive availability:** the run-level archive route worked in § 2.5, but nothing proves it
   will work for a 59-job run.
4. **Direct artifact download itself:** still blocked (§ 2.5).

**Row 10 stays `BLOCKED`. Rows 2, 6, 7, 8, 9, 10 and 11 remain unresolved. The verdict stays
NO-GO.**

---

## 11. Update — row 9: image-cohort review contract (later on 2026-09-16)

This section records a code change, not a live probe. §§ 1–5 above are the gate as it was run and
are not rewritten; the only other edit is a note on prerequisite 5 in § 6. Nothing was downloaded,
no GitHub API or network was called, no release state was observed, and no workflow was installed,
pushed, dispatched or rerun.

**Added.** `pnpm run review:aggregation-campaign-image-cohort -- <review-manifest> <report> …`
(`scripts/aggregation-campaign-image-cohort.mjs` and its pure library). It is manual and is not part
of `pnpm verify`, the test phases or `ci.yml`. It reads only the named files, writes nothing, and
never prints a path or a manifest value.

**What is now mechanically enforced.** The review keeps two things separate:

1. **The pre-launch snapshot**, a JSON manifest written before launch. Its fields are exactly:

   | field                                        | rule                                                             |
   | -------------------------------------------- | ---------------------------------------------------------------- |
   | `schema`                                     | exactly `adr-055-image-cohort-review/v1`                         |
   | `observed_at`                                | whole-second UTC (`YYYY-MM-DDThh:mm:ssZ`), not after review time |
   | `runner_label`                               | exactly `ubuntu-24.04`, the draft's `runs-on`                    |
   | `current_image_release`                      | `ubuntu24/<8 digits>.<1–6 digits>` (the § 2.4 tag shape)         |
   | `current_image_published_at`                 | whole-second UTC, not after `observed_at`                        |
   | `previous_image_release`                     | same shape, different from the current release                   |
   | `previous_image_published_at`                | whole-second UTC, strictly before the current publication        |
   | `branch_c_on_topology_mismatch_acknowledged` | JSON `true`                                                      |
   | `campaign_commit`                            | 40 lowercase hex characters                                      |

   A manifest that is not one flat JSON object of strings and booleans, or that is larger than
   4 KiB, repeats a field (checked in the raw text, including escaped spellings), or has an unknown,
   missing or mistyped field, is rejected. No maximum age, rollout window or image version is built
   in. The output states that the `runs-on` label selects an image family, not a version, so the
   snapshot cannot guarantee which image any job receives.

2. **The post-run cohort.** The reports go through the unchanged `accountCampaign` and
   `parseSlotReport`, whose byte-identical `topology:` and commit comparison is reused, not
   re-implemented. The cohort is consistent only when the accounting is complete (59 uniquely
   claimed, parseable reports, zero blockers, zero missing, zero rejected inputs), carries exactly
   one commit equal to `campaign_commit`, and exactly one measured topology. File names, input order,
   job conclusions and majority voting play no part.

**Result.** `COHORT: CONSISTENT` (exit `0`) only for an accepted snapshot and a consistent cohort.
Everything else prints `COHORT: BRANCH C` (exit `1`); a usage error exits `2`. Diagnostics are fixed
strings with counts and, for a single cohort, a 16-hex topology digest. Event and non-event totals
are not printed. No threshold, p-value or event interpretation is applied.

**Tests:** `scripts/aggregation-campaign-image-cohort.test.mjs`, **15/15**, with reports rendered by
the real harness and **synthetic** manifests. The fixture topology equals the committed induced
artifact's line. They cover a clean cohort, order independence, a runner-image roll-forward (1, 3
and 29 of 59 slots, so no majority is taken), drift in each of the 17 captured fields, commit
mismatch, refused or unmeasured topology, blockers, missing, duplicate and malformed reports,
malformed and hostile manifests, chronology, the acknowledgment, leakage and the CLI exit codes.
Mutation-style assertions show that an accounting blind to any one topology field, or one that
rewrites the minority topology to the majority, would pass where the real review forces Branch C.

**Not proven, so row 9 stays `UNVERIFIED`:**

1. No real snapshot of the runner-image release state has been taken for an actual launch.
2. No real 59-report campaign exists, so the post-run check has only run on synthetic reports.
3. The manifest is checked for shape and internal chronology only. Nothing checks that its values
   match GitHub's real release state, or that it was written before the first job started.
4. Neither the label nor the snapshot pins an image, so a roll-forward during the campaign stays
   possible; the review can only detect it afterwards and force Branch C.
5. The comparison is the preregistered byte identity. Fifty-nine identical lines that all read
   `runner_image=unknown` would still count as one topology, so a human reviewer must still read
   the single topology.

**Rows 2, 6, 7, 8, 9, 10 and 11 remain unresolved. The verdict stays NO-GO.**
