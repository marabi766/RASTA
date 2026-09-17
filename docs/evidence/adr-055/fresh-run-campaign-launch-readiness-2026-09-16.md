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

---

## 12. Update — launch preflight bundle contract (later on 2026-09-16)

This section records a code change, not a live probe. §§ 1–5 above are the gate as it was run and
are not rewritten. Nothing was downloaded, no GitHub API or network was called, no workflow was
installed, pushed, dispatched or rerun, and **no real launch record or image-cohort manifest
exists**.

**Added.** `pnpm run check:aggregation-campaign-preflight -- <launch-record> <workflow-snapshot> <image-cohort-manifest>`
(`scripts/aggregation-campaign-preflight.mjs` and its pure library). It is manual and is not part of
`pnpm verify`, the test phases or `ci.yml`. It takes exactly three positional files, checks each size
before reading (record 4 KiB, workflow 256 KiB, manifest 4 KiB), reads them as bytes, writes nothing,
and never prints a path, digest, commit, timestamp or file content. Exit `0` only for
`PREFLIGHT: COMPLETE`, `1` for `PREFLIGHT: REJECTED`, `2` for a usage error.

**Why.** The workflow check (§ 9) and the image-cohort review (§ 11) each validate one launch input
on its own. Nothing tied the file to be installed to the manifest that was reviewed, the commit
being launched, or the retry and retrieval policy accepted for the launch.

**The launch record** is one flat JSON object with exactly these fields. It is read with the same
raw-JSON scanner as the image-cohort manifest, so a duplicate (including an escaped spelling), an
unknown, missing or mistyped field, a BOM, comment, trailing data, nesting, a number or `null`, or
invalid UTF-8 rejects it:

| field                                              | rule                                         |
| -------------------------------------------------- | -------------------------------------------- |
| `schema`                                           | exactly `adr-055-launch-preflight-record/v1` |
| `campaign_commit`                                  | 40 lowercase hex characters                  |
| `workflow_snapshot_sha256`                         | 64 lowercase hex characters                  |
| `image_cohort_manifest_sha256`                     | 64 lowercase hex characters                  |
| `require_run_attempt_one`                          | JSON `true`                                  |
| `rerun_retry_redispatch_ineligible_acknowledged`   | JSON `true`                                  |
| `primary_retrieval`                                | exactly `per-slot-uploaded-artifacts`        |
| `run_log_archive_fallback_acknowledged`            | JSON `true`                                  |
| `fallback_not_artifact_byte_equality_acknowledged` | JSON `true`                                  |
| `retrieval_availability_not_proven_acknowledged`   | JSON `true`                                  |

It has no account, run, billing, timestamp or image-version field.

**What is now mechanically enforced.** `PREFLIGHT: COMPLETE` requires all of:

1. an accepted launch record;
2. SHA-256 of the exact workflow bytes equal to `workflow_snapshot_sha256`, with no normalisation, so
   one changed byte, a line ending or a trailing newline breaks the link;
3. the unchanged `validateWorkflowDraft` passing on that snapshot (59-slot matrix, `ubuntu-24.04`,
   45 minutes, push-only, first-step `run_attempt` refusal, one measurement, one `if: always()`
   upload, pinned actions and the rest of the § 9 contract);
4. SHA-256 of the exact manifest bytes equal to `image_cohort_manifest_sha256`;
5. the unchanged `validateCohortManifest` accepting the manifest at the time the command runs;
6. the record's `campaign_commit` equal to the manifest's.

Workflow problems are counted, not printed; manifest problems are the image-cohort review's fixed
strings. The only library change outside the new files is one exported wrapper,
`parseFlatJsonObject`, around the image-cohort manifest scanner; the image-cohort CLI output is
unchanged (its tests still pass 15/15).

**Tests:** `scripts/aggregation-campaign-preflight.test.mjs`, **12/12**, using the committed workflow
draft byte for byte and **synthetic** records and manifests. They cover a complete bundle, digest
breaks from trailing newline, whitespace, comment, CRLF and field-order changes, commit mismatch,
workflow and manifest validator failures under a matching digest, every missing, duplicate, mistyped
and unknown record field, every false acknowledgment, bad enums, digests, commit and schema,
malformed JSON, invalid UTF-8, oversized and unreadable inputs that are never read, argument errors,
exit codes, leakage and no filesystem writes. Fourteen source-level mutants of the library, run from
a temporary copy, prove that bypassing either digest link, hashing normalised text, bypassing the
commit linkage, ignoring or bypassing the workflow validator, bypassing the manifest validator, or
dropping the acknowledgment or retrieval checks (including each of the five acknowledgments
separately) is caught.

**Still live, and not proven by this check:**

- that the supplied snapshot is, or ever will be, the installed workflow;
- that GitHub never retries hosted-runner infrastructure internally, or that any run has
  `run_attempt` `1`;
- artifact reachability, run-log archive availability, equality of recovered log text with
  artifact bytes, or any real 59-job recovery;
- that the manifest's values match GitHub's real release state.

**Row 9 stays `UNVERIFIED`, row 10 `BLOCKED`, row 11 `UNVERIFIED`, and rows 2, 6, 7 and 8 unresolved.
The verdict stays NO-GO.**

---

## 13. Launch runbook — fail-closed operating sequence (2026-09-17)

This section is **procedure, not evidence**. It was written from the committed tools, the
committed workflow draft and the preregistration. Nothing in it was executed: no workflow was
installed, pushed, dispatched or rerun, no account, billing or release state was observed, nothing
was downloaded, and **no real launch record, image-cohort manifest, digest or campaign commit
exists**. §§ 1–12 are unchanged. Every placeholder below (`<launch-record>`, `<report>` and so on)
names a file that would only exist inside an authorized launch window.

### 13.1 Rules that apply to every step

1. **STOP means NO-GO.** Any failed, skipped, ambiguous or unprovable check ends the attempt. Absence
   of proof is a failure, never a pass.
2. **Before the single push (step L8)**, a STOP launches nothing. Record the reason. A later attempt
   restarts from Gate 0 with freshly produced inputs; the rejected inputs are kept, not edited.
3. **After the push**, nothing is repaired. No rerun, retry, re-dispatch, cancellation, second push
   or replacement slot can make a campaign eligible. This runbook authorizes no second campaign.
4. **Evidence is kept byte-exact.** Tool outputs, the snapshot, manifest, record, downloaded
   artifacts and logs are kept exactly as produced, outside `.github/workflows/`. Nothing is
   reformatted, re-saved, re-encoded or edited. A changed input is a new input with a new digest.
5. **No secrets.** No credential, token or header is requested by this document, printed, stored in
   an evidence file or committed. Credentials are handled only by the owner-authorized operation
   that needs them.
6. **Two kinds of operation.** `[tool]` is a committed package script, invoked exactly as shown.
   `[manual/live]` has **no committed tool**. It is performed by hand under the owner's
   authorization, and its result is recorded by hand. No command is prescribed for it and nothing
   about it is automated or proven by this repository.
7. **Exit codes of every `[tool]`:** `0` is the only pass; `1` is a failed check; `2` is a usage
   error that checked nothing. After exit `2`, only the invocation may be corrected; no input may
   change.

### 13.2 Gate 0 — external evidence, before anything is installed or launched

**Nothing may be installed or launched until rows 2, 6, 7 and 8 each have new live evidence
recorded in a dated update of this document, and each is `VERIFIED`.** All items are
`[manual/live]`.

| #    | required evidence                                                                                                                                                                                                             | row |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| G0.1 | The owner deliberately provides or authorizes any credential scope used to read billing or account facts. The operator does not request, refresh or widen a scope on their own initiative (§ 2.2).                            | 8   |
| G0.2 | Billing, budget, spending-limit and allowance facts, read with that scope and recorded without secrets. The public-repository policy in § 3 and § 4 is a platform policy; it does **not** prove this account's state.         | 8   |
| G0.3 | An explicit, recorded owner authorization for the **2655 job-minute** ceiling (§ 4). The 418 expected job-minutes are not the authorization bound.                                                                            | 8   |
| G0.4 | The account's effective concurrency, from account evidence. The per-plan maximum in § 3 is not an effective value.                                                                                                            | 6   |
| G0.5 | Queue behaviour adequate for a 59-job fan-out, with the basis for judging it adequate recorded next to the evidence. No adequacy criterion is invented here; the § 2.3 observation (at most 5 jobs) does not suffice.         | 7   |
| G0.6 | A retrieval path demonstrated **from the launch environment**: an existing ADR-055 artifact downloaded byte-for-byte from the host that will retrieve the campaign (§ 6 prerequisite 1), with the row 2 reliability evidence. | 2   |

**STOP** unless every item is recorded and rows 2, 6, 7 and 8 are all `VERIFIED`.

**Gate 1 — recorded launch decision.** The § 5 rule makes GO depend on every row being `VERIFIED`.
Rows 9, 10 and 11 contain parts that can only be observed during or after the run (the measured
topology, the 59-artifact retrieval, `run_attempt`). This runbook does **not** reinterpret § 5. A
launch needs a dated update of this document that records the Gate 0 evidence and states explicitly
that the post-run parts of rows 9, 10 and 11 are decided by steps L10–L13 below, each failing closed
to Branch C. **STOP** without that recorded decision.

### 13.3 Launch sequence

Each step names what must be kept. Do not skip or reorder steps.

**L1 — identity and Actions state `[manual/live]`.**

- The local branch is `feat/audit-service-aud-004-contract`. The draft's `on.push.branches` names
  that literal branch; any other branch needs a separately reviewed draft.
- The tracked tree and index are clean.
- Local `HEAD` = upstream = remote branch head.
- `.github/workflows/` contains only `ci.yml`.
- Actions is enabled for the repository.
- No run of the campaign workflow exists yet.

Keep the refs and the observed state. **STOP** on any mismatch.

**L2 — workflow snapshot.**

- Take the exact bytes of
  [`fresh-run-campaign-workflow-draft-2026-09-16.yaml.txt`](fresh-run-campaign-workflow-draft-2026-09-16.yaml.txt)
  at the L1 commit as `<workflow-snapshot>`. Keep that copy outside the tracked tree and never under
  `.github/workflows/`.
- `[tool]` `pnpm run check:aggregation-campaign-workflow -- <workflow-snapshot>`.
- **STOP** unless exit `0` and `RESULT: PASS`. Keep the output.

**L3 — local candidate commit, not pushed, not installed.**

- **Why this comes before the manifest.** A report's `commit=` line is `git rev-parse HEAD` in the job's
  checkout (`commitSha()` in `scripts/aggregation-evidence.mjs`). The draft's checkout step passes no
  `ref`, and its only trigger is a push that changes the installed workflow path. So the commit the
  reports will name, and that the cohort review compares with `campaign_commit`, is the pushed commit
  that adds the workflow file. Its SHA exists only after that commit is created.
- `[manual/live]` Create one local commit. Its parent is the L1 `HEAD`. Its only change adds the
  snapshot bytes at the draft's `on.push.paths` path, `.github/workflows/adr-055-fresh-run-first-pair.yml`.
- This commit is **not** an installation: nothing reaches GitHub until L8.
- `[manual/live]` Hash the **committed blob** at that path, not the working-tree file (`.gitattributes`
  applies `* text=auto eol=lf`). The SHA-256 must equal the SHA-256 of `<workflow-snapshot>`, and the
  commit must change exactly that one path.
- `[tool]` `pnpm run check:aggregation-campaign-workflow -- .github/workflows/adr-055-fresh-run-first-pair.yml`.
  It must exit `0` with `RESULT: PASS`. This checks the working-tree text. The byte identity comes
  from the blob digest above.
- Keep the candidate SHA, the two digests and the output.
- **STOP** on any mismatch. The unpushed candidate never left the machine; restart from L2.

**L4 — image-cohort manifest.**

- `[manual/live]` Observe the authoritative runner-image release state: the current and previous
  `ubuntu24/*` releases and their publication times, from the source used in § 2.4.
- Write `<image-cohort-manifest>` as one flat JSON object of at most 4 KiB. It has exactly the nine
  `adr-055-image-cohort-review/v1` fields of § 11:
  - `schema` = `adr-055-image-cohort-review/v1`;
  - `observed_at`;
  - `runner_label` = `ubuntu-24.04`;
  - `current_image_release`;
  - `current_image_published_at`;
  - `previous_image_release`;
  - `previous_image_published_at`;
  - `branch_c_on_topology_mismatch_acknowledged` = `true`;
  - `campaign_commit` = the L3 SHA.
- Record the release values as observed. Never adjust them to pass a check.
- Keep the exact bytes. Any change makes a new manifest, which needs a new digest (L5) and a new
  preflight (L6).
- The tools check chronology only against the review time. That `observed_at` precedes the first
  job start is shown only by the kept timestamps.

**L5 — launch record.**

- Write `<launch-record>` as one flat JSON object of at most 4 KiB, with no BOM. It has exactly the ten
  `adr-055-launch-preflight-record/v1` fields of § 12:
  - `schema` = `adr-055-launch-preflight-record/v1`;
  - `campaign_commit` = the L3 SHA;
  - `workflow_snapshot_sha256` = SHA-256 of the exact `<workflow-snapshot>` bytes;
  - `image_cohort_manifest_sha256` = SHA-256 of the exact `<image-cohort-manifest>` bytes;
  - the five acknowledgments, each `true`;
  - `primary_retrieval` = `per-slot-uploaded-artifacts`.
- Digests are 64 lowercase hex characters. No committed tool prints a digest, so computing them is
  `[manual/live]`: a standard SHA-256 over the file bytes, with no re-saving.

**L6 — preflight.**

- `[tool]` `pnpm run check:aggregation-campaign-preflight -- <launch-record> <workflow-snapshot> <image-cohort-manifest>`.
  The positional order is record, snapshot, manifest.
- **STOP** unless exit `0` and `PREFLIGHT: COMPLETE`. Exit `1` (`PREFLIGHT: REJECTED`) is a STOP
  whatever the reason. Keep the 12-line output.

**L7 — pre-push re-verification `[manual/live]`, immediately before L8.**

- Local `HEAD` is still the L3 candidate.
- Its parent is still the remote branch head.
- Its only change is still the one workflow path.
- The committed blob still hashes to `workflow_snapshot_sha256`.
- The record, snapshot and manifest still hash to the values used in L6.

**STOP** on any difference.

**L8 — the single eligible push `[manual/live, owner-authorized]`.** This push is the installation and
the launch.

- Push exactly the L3 commit to the branch with a normal push: no force, no amend, no other commit.
- `[manual/live]` Confirm that the remote branch head equals `campaign_commit`. Git commit identity
  covers the tree, so that equality binds the installed file to the verified blob. Where the remote
  file bytes can be read, also hash them against `workflow_snapshot_sha256`.
- If the push was definitively rejected (the remote head is unchanged and no run exists), nothing
  launched: **STOP**, NO-GO.
- If whether the push landed, or which bytes were installed, cannot be proven: **STOP**. Do not push
  again. Any run that appears is handled by L9–L10, and a byte mismatch makes the campaign
  ineligible (Branch C).
- From here until L13 is finished, push nothing to the branch. No push may ever touch the installed
  workflow file except its later removal (L15).

**L9 — observe without intervening `[manual/live]`.**

- Exactly one run of the campaign workflow exists, for the `push` event, with head SHA
  `campaign_commit`.
- No run, job or slot is rerun, retried, re-dispatched, cancelled or replaced.
- Wait until all 59 jobs are completed. Job conclusions are recorded as metadata only and are never
  used to classify a slot.
- Zero runs: **STOP**, NO-GO, with no second push. More than one run: ineligible, Branch C.

**L10 — first-attempt verification `[manual/live]`.**

- Record `github.run_attempt` for the run and the attempt of each of its 59 jobs, without credentials.
- Eligible only if the run and every job are proven to be attempt `1`.
- Any other attempt, or a value that cannot be proven, makes the campaign **ineligible → Branch C**,
  even though the draft's first-step guard stops a re-run attempt from measuring.

**L11 — retrieval.**

_Corrected 2026-09-17 (§ 21):_ in the recommended manifest commands of L11–L13, every path placeholder is written in
double quotes. Replace only the placeholder and keep the quotes (§ 20.1).

- **Primary `[manual/live]`.** Download all 59 per-slot artifacts `adr-055-fresh-run-slot-<n>` before
  the draft's 3-day `retention-days` expires. Keep the exact bytes of every file.
- **Fallback, acknowledged in the record.** Use it only when the artifacts cannot be retrieved.
  - `[manual/live]` Obtain the run-log archive or job logs, and keep their exact bytes.
  - `[tool]` `pnpm run recover:aggregation-campaign-logs -- --output-dir <new-directory> <job-log> [<job-log> ...]`,
    with every job log. `<new-directory>` must not exist yet. Its parent must be an existing,
    non-link directory outside the tracked tree and outside `.github/workflows/`.
  - _Updated 2026-09-17 (§ 19), recommended on Windows:_
    `pnpm run recover:aggregation-campaign-logs -- --output-dir "<new-directory>" --logs-manifest "<file>"`,
    where `<file>` lists every job log, one path per line. Keep the manifest with the output.
  - It must exit `0` with a `materialization: WRITTEN - 59 report files …` line and `RESULT: PASS`.
    Keep the output and the directory unedited.
  - _Updated 2026-09-17 (§ 14):_ the recovered reports are now written as files, so L12 and L13 run
    over `<new-directory>/slot-01.txt` … `slot-59.txt` exactly as over downloaded artifacts. The
    earlier limitation, that no committed tool wrote fallback reports, no longer applies.
  - The fallback writes files **only** for a clean recovery whose accounting of all 59 slots is
    complete. Anything less writes nothing, prints `materialization: NOT WRITTEN`, and exits `1`. A
    partial fallback is not combined with downloaded artifact files by any committed tool, and
    this runbook does not combine them.
  - Recovered text is still **not** proven equal to the uploaded artifact bytes (§ 10).
- An expired, unreachable or incomplete retrieval is `missing` for that slot, which means Branch C.
  A materialization failure (exit `1`) leaves no output directory. Keep its output. The same unedited
  logs may be processed again only into another path that does not exist yet. Nothing already
  written is deleted, renamed or reused. Until a run exits `0`, retrieval is incomplete.
- **Optional byte comparison, only when both complete sets exist** (_added 2026-09-17, § 15_).
  - Use it only when all 59 downloaded artifact reports **and** all 59 files of a fallback run that
    exited `0` are on disk. It is **not** required when the primary artifact set alone is complete;
    then L12 and L13 run over the artifact files as before.
  - Record the decision to run it before running it. Once run, keep its output whatever the result.
  - `[tool]`, **recommended, Windows-safe** (_updated 2026-09-17, § 16_):
    `pnpm run compare:aggregation-campaign-retrievals -- --artifacts-manifest "<file>" --fallback-manifest "<file>"`.
    - Each manifest is a plain path list written by the operator: exactly 59 LF-terminated lines, one
      report path per line, in the § 16 grammar.
    - A relative line resolves against the manifest's own directory.
    - Keep both manifests with the output. A manifest only transports paths. It is **not** evidence
      and proves nothing about authenticity or provenance.
  - `[tool]`, still valid:
    `pnpm run compare:aggregation-campaign-retrievals -- --artifacts <report> ... --fallback <report> ...`,
    with the 59 artifact report paths after `--artifacts` and the 59 materialized paths after
    `--fallback`. On Windows, 118 long paths can exceed the `cmd.exe` command-line limit of
    `pnpm run`. Use manifests instead.
  - Exit `2` (a usage or manifest-contract error) compared nothing. Only the invocation or a manifest's
    path list may be corrected; no report file may change.
  - `COMPARISON: MATCH` (exit `0`) means only that the two supplied byte sets are identical for every
    slot. It does not show that either source is authentic, retrievable, fresh, from attempt `1` or
    from the authorized run.
  - `COMPARISON: DIFFERENT` or `COMPARISON: REJECTED` (exit `1`) is a **STOP**. It cannot be repaired
    by choosing one side, mixing files from the two sources, editing, re-downloading or
    re-materializing. The campaign cannot reach Branch A or B (Branch C).

**L12 — slot accounting.**

- The input is all 59 report files: the downloaded artifact files, or the 59 files materialized by
  the L11 fallback.
- `[tool]`, **recommended, Windows-safe** (_updated 2026-09-17, § 17_):
  `pnpm run account:aggregation-campaign -- --reports-manifest "<file>"`.
  - `<file>` is a **report-path manifest**: a plain list of the 59 report paths written by the
    operator, in the § 16 grammar. A relative line resolves against the manifest's own directory.
  - Keep it with the output. It only transports paths. It is **not** evidence and proves nothing
    about authenticity or provenance.
- `[tool]`, still valid: `pnpm run account:aggregation-campaign -- <report> [<report> ...]`. On
  Windows, 59 long paths can exceed the `cmd.exe` command-line limit of `pnpm run`. Use the
  manifest instead.
- It must exit `0` with `accounting: COMPLETE` and an invariant line that ends in `holds`.
- Exit `2` (a usage or report-path-manifest error) accounted nothing. Only the invocation or the
  manifest's path list may be corrected; no report file may change.
- Anything else (a blocker, missing slot, rejected input or provenance problem) is Branch C. Keep
  the output.
- The 59 files are always one complete set from one source. Never mix artifact and fallback files.
  If the optional L11 comparison was run, L12 is allowed only after `COMPARISON: MATCH`.

**L13 — image-cohort review.**

- `[manual/live]` Re-hash the manifest; it must still equal `image_cohort_manifest_sha256`.
- The input is the same image-cohort manifest and the same 59 reports as L12 (one set from one
  source, never mixed).
- `[tool]`, **recommended, Windows-safe** (_updated 2026-09-17, § 17_):
  `pnpm run review:aggregation-campaign-image-cohort -- "<image-cohort-manifest>" --reports-manifest "<file>"`.
  - `<image-cohort-manifest>` is the L4 JSON snapshot. It is unchanged and still comes first.
  - `<file>` is a separate **report-path manifest**: the same kind of plain path list as in L12, not
    the JSON snapshot. It is not evidence either.
- `[tool]`, still valid:
  `pnpm run review:aggregation-campaign-image-cohort -- <image-cohort-manifest> <report> [<report> ...]`.
- Exit `2` (a usage or report-path-manifest error) reviewed nothing. Only the invocation or the path
  list may be corrected; the JSON snapshot and the reports may not change.
- It must exit `0` with `COHORT: CONSISTENT`. Otherwise (`COHORT: BRANCH C`) the result is Branch C.
- A human reads and records the single measured topology (§ 11, item 5). Keep the output.

**L14 — preregistered interpretation.** Allowed only when L10 proved attempt `1`, L12 is `COMPLETE`
and L13 is `CONSISTENT`. Take the event count from the L12 totals line.

| condition                                 | branch | wording                                          |
| ----------------------------------------- | ------ | ------------------------------------------------ |
| `events >= 1`                             | **A**  | exactly as in preregistration § 6                |
| `events = 0` and `non-events = 59`        | **B**  | exactly as in § 6 (bound `4.9508 %`)             |
| anything else, or any earlier failed step | **C**  | inconclusive for the 5 % / one-sided 95 % target |

No threshold, count, target, eligibility rule or classification is changed. No slot is classified
from a job conclusion. Every deferral in § 6 stays deferred.

**L15 — after evidence capture.**

- The installed workflow is removed by deletion only, as a separate reviewed step, and only after
  L11–L13 are complete. That removal is not a second campaign push.
- A run caused by any later push is not campaign evidence.
- Kept evidence is committed only in a separately authorized evidence commit, without secrets.

### 13.4 Abort and rollback

- **Before L8:** a STOP launches nothing. Keep what was produced, discard only the unpushed local
  candidate, and restart later from Gate 0.
- **After L8:** there is no rollback of a launched campaign. Keep all evidence unedited; do not rerun,
  cancel or re-push to "repair" eligibility.
- **Topology:** a mismatch across the 59 reports is Branch C.
- **Accounting or retrieval:** if either is incomplete, the result can never become Branch A or B.
- **Fallback files:** `--output-dir` never overwrites, merges with, cleans or deletes an existing
  path. A refused or failed materialization leaves no output directory. The tool never removes
  evidence to make room for a retry.
- **Retrieval comparison:** the comparator only reads. A `DIFFERENT` or `REJECTED` result is kept and
  is final. No source is chosen, no files are mixed, and nothing is re-run to get `MATCH`.
- **Records:** a launch record or manifest is real only when produced inside an authorized launch
  window under Gates 0 and 1. The examples in tests are synthetic.

### 13.5 Evidence matrix

| checkpoint | rows    | evidence kept                                                       | fail-closed result                                         |
| ---------- | ------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| G0.1–G0.3  | 8       | owner scope authorization, billing facts, 2655 job-minute approval  | not `VERIFIED` → STOP, NO-GO                               |
| G0.4       | 6       | effective concurrency from account evidence                         | not `VERIFIED` → STOP, NO-GO                               |
| G0.5       | 7       | queue evidence and its recorded adequacy basis                      | not `VERIFIED` → STOP, NO-GO                               |
| G0.6       | 2, 10   | byte-for-byte download of an existing artifact from the launch host | not demonstrated → STOP, NO-GO                             |
| Gate 1     | 2, 6–11 | dated launch decision recorded in this document                     | absent → STOP, NO-GO                                       |
| L1         | 3, 4    | refs, clean state, `ci.yml`-only listing, Actions enabled           | mismatch → STOP, NO-GO                                     |
| L2–L3      | 3, 11   | snapshot bytes, blob digest, workflow check outputs                 | exit ≠ 0 or digest mismatch → STOP, NO-GO                  |
| L4–L6      | 9, 11   | manifest bytes, record bytes, preflight output                      | not `PREFLIGHT: COMPLETE` → STOP, NO-GO                    |
| L7–L8      | 3, 11   | pre-push hashes, remote head = `campaign_commit`                    | before launch → STOP; after launch → Branch C              |
| L9–L10     | 11      | the one run, per-job `run_attempt` metadata                         | not exactly one run or attempt ≠ 1 → Branch C              |
| L11        | 2, 10   | 59 artifact files, or recovery output and its 59 materialized files | missing, expired, or fallback not `RESULT: PASS` → not A/B |
| L11 (opt.) | 10      | comparator output and its two manifests, if it was run              | `DIFFERENT` or `REJECTED` → not A/B (Branch C)             |
| L12        | 12      | accounting output, and its report-path manifest if one was used     | not `accounting: COMPLETE` → Branch C                      |
| L13        | 9       | cohort output, human-read topology, report-path manifest if used    | `COHORT: BRANCH C` → Branch C                              |
| L14        | —       | the branch statement, worded as in preregistration § 6              | any earlier failure → Branch C                             |

### 13.6 Status after this section

Nothing above was performed, and no live fact was established. The table in § 5 is unchanged:

- Row 9 stays `UNVERIFIED`.
- Row 10 stays `BLOCKED`.
- Row 11 stays `UNVERIFIED`.
- Rows 2, 6, 7 and 8 stay unresolved.
- Rows 3, 4 and 12 are still `VERIFIED` only as recorded in §§ 5 and 8. Row 3 must be re-verified at
  L1.

**The verdict stays NO-GO.**

---

## 14. Update — opt-in materialization of fallback-recovered reports (2026-09-17)

This section records a code change, not a live probe. §§ 1–12 are unchanged. In § 13, only L11,
L12, the abort rules and the L11 row of the evidence matrix changed. Nothing was downloaded, no
GitHub API or network was called, no workflow was installed, pushed, dispatched or rerun, and **no
real log, report or campaign evidence exists**.

**The gap.** `recover:aggregation-campaign-logs` (§ 10) validated and accounted for recovered
reports only in memory and wrote nothing. The image-cohort review (§ 11) and the accounting command
(§ 8) read report **files**. So a campaign retrieved through the log fallback could not reach
Branch A or B with committed tools (§ 13, L11 as first written).

**Added.** One explicit opt-in form of the same command:

`pnpm run recover:aggregation-campaign-logs -- --output-dir <new-directory> <job-log> [<job-log> ...]`

- **The read-only form is unchanged.** Without `--output-dir` the command writes nothing, and its
  output and exit codes are identical to before.
- **Option syntax:** exactly one `--output-dir` followed by a value that is non-empty and does not
  start with `-`. Anything else exits `2` before any file is read: no value, `--output-dir=…`, a
  repeated option, an empty or `-`-prefixed value, or any other option. The option consumes the next
  argument, so a log path placed there becomes the destination. The remaining logs then cannot
  account for 59 slots, and nothing is written.
- **When files are written:** only when recovery is clean **and** the unchanged accounting is
  complete (59 slots, zero blockers, zero missing, zero rejected inputs, no commit or topology disagreement).
  Otherwise the output ends with
  `materialization: NOT WRITTEN - recovery or accounting is not complete; nothing was created`, the
  exit is `1`, and the file system is not touched.
- **What is written:** `slot-01.txt` … `slot-59.txt`. Each name comes from the integer slot that the
  unchanged `parseSlotReport` read from that report. No name comes from a path, input order, job
  name or text. Each file's bytes are exactly the accepted recovered string, UTF-8, including its
  final LF. The recovery library now keeps each accepted string bound to its parsed slot, and the
  plan re-checks every binding with `parseSlotReport` before anything is written. No second parser
  exists.
- **How it is written, fail-closed and non-destructive:**
  1. The destination must not exist in any form (file, directory, symlink or junction), checked
     with `lstat`, which never follows a link. Its parent must be an existing directory that is not
     a link.
  2. One uniquely named staging directory (`mkdtemp`) is created in that parent. The command checks
     that it lies directly inside the intended parent before writing anything.
  3. Each report is created with exclusive creation (`wx`, which never overwrites or follows an
     existing entry), read back and compared byte for byte. The staging directory must then hold
     exactly the 59 names.
  4. The destination is checked again, and one `rename` puts the complete directory in place. No
     partial destination is ever visible.
  5. On any failure before that rename, the command removes only the files it created, then its own
     staging directory with a non-recursive `rmdir`. A foreign entry is never removed. It never
     overwrites, merges with, cleans or deletes a destination.
- **Diagnostics** are fixed sentences, with exit `1`:
  - `output path already exists`;
  - `output parent is not an existing directory that is not a link`;
  - `report file could not be created exclusively`;
  - the other reasons in `MATERIALIZATION_REASON`;
  - a cleanup state: `nothing was created`, `owned staging state was removed` or
    `owned staging state could not be fully removed`.

  No path, report content, commit, timestamp or run value is added. The accounting section still
  prints the one campaign commit, exactly as the read-only form always has.

**Residual race, stated rather than hidden.** Node has no portable no-replace directory rename. A
directory created at the destination by another process **between** the final check and the rename
could, on POSIX, be replaced if it is empty. A non-empty directory, a file or a link makes the rename
fail, and Windows refuses to rename onto an existing directory. The window is one system call wide.
Use a destination path that nothing else writes to.

**Tests:** `scripts/aggregation-campaign-log-recovery.test.mjs`, **26/26** (the 17 existing tests
unchanged, plus 9 new ones). They cover:

- the unchanged read-only output, with no file system call;
- slot binding, deterministic names and exact bytes under shuffled logs and regrouped reports;
- refusal of incomplete, rejected, duplicate, provenance-inconsistent, blocked and edited campaigns,
  and of tampered bindings;
- option syntax (exit `2`, nothing read or written);
- existing file, directory and link destinations;
- unusable parents;
- exclusive-create, read-back, foreign-entry, late-destination, rename, unlink, `mkdtemp` and
  outside-staging faults, through an injected in-memory file system, including that every mutation
  stays in owned staging and no partial destination appears;
- a real-file-system CLI run: 59 exact files, no staging residue, and a repeat, an existing file, an
  existing empty directory and a junction or symlink each refused unchanged;
- leakage checks.

An end-to-end **synthetic** test feeds the 59 materialized files to the unchanged accounting command
(`COMPLETE`, identical to accounting over the rendered reports) and to the image-cohort review with
a synthetic nine-field manifest (`COHORT: CONSISTENT`). A one-byte edit of one file forces
`COHORT: BRANCH C`. The five campaign tool test files together pass **87/87** (baseline 78/78).

**Still not proven, so nothing changes:**

- that a real run-log archive is retrievable for a 59-job run;
- that recovered text equals the uploaded artifact bytes (§ 2.5 item 1);
- any real 59-job recovery;
- any real runner-image cohort.

The synthetic fixtures are contract evidence only. **Row 9 stays `UNVERIFIED`, row 10 `BLOCKED`,
row 11 `UNVERIFIED`, and rows 2, 6, 7 and 8 unresolved. The verdict stays NO-GO.**

---

## 15. Update — optional byte comparison of artifact and fallback retrievals (2026-09-17)

This section records a code change, not a live probe. §§ 1–12 and § 14 are unchanged. In § 13, only
L11, L12, L13, the abort rules and the evidence matrix changed. Nothing was downloaded, no GitHub API
or network was called, no workflow was installed, pushed, dispatched or rerun, and **no real
artifact, log, report or comparison exists**.

**The gap.** § 14 made the log fallback write report files. But no committed tool could show whether
those files are byte-identical to the downloaded artifacts when both exist. Comparing them by hand
risks decoding, line-ending conversion, or pairing files by name instead of by slot.

**Added.** One manual, read-only command:

`pnpm run compare:aggregation-campaign-retrievals -- --artifacts <report> ... --fallback <report> ...`

- **Interface.** `--artifacts` and `--fallback` each appear exactly once, in either order. Each is
  followed by its cohort's paths, up to the other option or the end. A path belongs to the option
  before it. Order within a cohort and file names mean nothing. Exit `2`, before any file is checked
  or read, for:
  - a missing, repeated or unknown option, or `--artifacts=…` / `--fallback=…`;
  - a path before the first option, or an option with no path;
  - an empty path, or a path starting with `-`;
  - `--` anywhere except before the first option;
  - the same resolved path in both cohorts (a string check only; it cannot prove the sources differ);
  - more than 128 paths in a cohort (`LOG_RECOVERY_LIMITS.maxLogs`).

  A usage error prints a fixed reason and the usage line, never an argument.

- **Reading.** Only the named files are read, as raw bytes, each only after its size is at most
  32 KiB (`LOG_RECOVERY_LIMITS.maxCandidateBytes`). A cohort with other than 59 paths is not read.
  Nothing is written, no directory is scanned, and no network or GitHub API is called.
- **Validation, per cohort, alone.** Strict UTF-8 decoding keeps a BOM, so a BOM fails the parser. The
  unchanged `accountCampaign`, and so `parseSlotReport`, is then applied. A cohort is accepted only
  with:
  - exactly 59 inputs, all readable;
  - complete accounting: no rejected input, blocker, missing or unparseable slot;
  - exactly one campaign commit and exactly one measured topology;
  - every report bound one to one to the slot the parser read.

  No second parser exists and no bound was relaxed.

- **Comparison.** For each slot `1..59`, `Buffer.equals` compares the exact bytes of the two
  cohorts' reports. Nothing is trimmed, normalized, re-rendered, re-encoded or reduced to parsed
  fields or digests. A CRLF report fails the parser, so its cohort is `REJECTED`.
- **Outcomes.**

  | output                  | exit | meaning                                                         |
  | ----------------------- | ---- | --------------------------------------------------------------- |
  | `COMPARISON: MATCH`     | `0`  | both cohorts accepted, all 59 slots byte-identical              |
  | `COMPARISON: DIFFERENT` | `1`  | both cohorts accepted, at least one slot differs                |
  | `COMPARISON: REJECTED`  | `1`  | at least one cohort incomplete or invalid; nothing was compared |

  The output is 8 fixed lines: per-cohort counts (`inputs`, `read`, accounting state), fixed problem
  sentences, and `slots_compared`, `identical` and `different` counts. It never contains a path,
  file name, report content, slot of a difference, commit, topology, timestamp or run value.

**Scope.** `MATCH` establishes equality of the supplied bytes only. It is not evidence that either
source is authentic, retrievable, fresh, from attempt `1` or from the authorized run. The comparator
is optional (L11) and is not needed when the artifact set alone is complete. Once run, a `DIFFERENT`
or `REJECTED` result cannot be repaired by mixing sources and cannot reach Branch A or B. Branch
A/B/C thresholds, eligibility and first-attempt rules are unchanged. The command is outside
`pnpm verify`, the test phases and `ci.yml`.

**Tests:** `scripts/aggregation-campaign-retrieval-comparison.test.mjs`, **12/12**, all synthetic.
They cover:

- an exact 59-slot match;
- shuffled inputs on either side, and swapped cohort labels;
- a one-byte difference in slot 1, 17 or 59;
- reports equal in every parsed field but different in bytes;
- a sampled sweep of single-byte edits that never yields `MATCH`;
- per side: CRLF, a missing final newline, BOM, a duplicate, a missing or extra report, a malformed
  report, a blocker, commit and topology inconsistency, oversized, unreadable and non-UTF-8 input;
- 22 usage errors with zero reads;
- oversized reports never read, and wrong-count cohorts not read;
- output leakage;
- the command staying outside `pnpm verify`, the test phases and CI;
- a spawned CLI over temporary files: `MATCH`, a one-byte `DIFFERENT`, a CRLF `REJECTED`, with no
  file created, removed or changed.

The six campaign tool test files together pass **99/99** (baseline 87/87).

**Still not proven, so nothing changes:** that any real artifact set or log archive is retrievable,
that real recovered reports equal real artifact bytes, and any real 59-job retrieval. **Row 9 stays
`UNVERIFIED`, row 10 `BLOCKED`, row 11 `UNVERIFIED`, and rows 2, 6, 7 and 8 unresolved. The verdict
stays NO-GO.**

---

## 16. Update — bounded cohort manifests for the retrieval comparator (2026-09-17)

This section records a code change, not a live probe. §§ 1–12, § 14 and § 15 are unchanged. In § 13,
only the L11 comparator bullet and the `L11 (opt.)` matrix row changed. Nothing was downloaded, no
GitHub API or network was called, no workflow was installed, pushed, dispatched or rerun, and **no
real artifact, log, report, manifest or comparison exists**.

**The gap.** § 15 recorded that on Windows, `pnpm run` passes arguments through `cmd.exe`, whose
command line is limited to 8191 characters. 118 long report paths exceed it, so the documented
package command could fail before the comparator started.

**Added.** A second input mode for the same command. The explicit-path mode is kept.

`pnpm run compare:aggregation-campaign-retrievals -- --artifacts-manifest <file> --fallback-manifest <file>`

- **Options.**
  - Each manifest option appears exactly once, in either order, followed by exactly one manifest
    path.
  - Both cohorts must use the same mode.
  - Exit `2` before any report is read for: mixed modes; a missing, repeated or unknown option;
    `--option=value`; a manifest option without one following path (none, empty, or starting with
    `-`); any extra argument; `--` after the first option; a path over 1024 UTF-8 bytes; the same
    manifest for both cohorts.
- **Manifest grammar.**
  - Strict UTF-8 with no BOM, at most 60 475 bytes (59 × (1024 + 1)).
  - Exactly 59 lines, each ended by LF. No CR, NUL, tab or other control character.
  - Each line is one report path of 1–1024 UTF-8 bytes. It has no leading or trailing whitespace and
    does not start with `-`, `#`, `"` or `'`. It does not end with a quote, is not a `scheme:` URL and
    is not a Windows drive-relative `C:name`.
  - There are no comments, quoting or escapes.
  - An absolute line is used as written. A relative line resolves against the directory holding that
    manifest, never the caller's working directory.
  - Line order means nothing. Slots still come only from parsed report content.
- **Bounded reading.**
  - Each manifest's size is checked before it is read, and the bytes are checked again after reading.
  - Only the two named manifests and the 59 + 59 report files they list are read.
  - Every manifest failure exits `2` with one fixed line, `artifacts manifest: <problem>` or
    `fallback manifest: <problem>`, and **zero report reads**.
  - No path, manifest line or OS error is printed. Nothing is written, no directory is scanned and no
    glob is expanded.
- **Path collisions, in both modes.** After resolution, the same report path twice in one cohort
  exits `2` (this is new for explicit paths, which previously ended as `REJECTED`). So does a path
  present in both cohorts.
  - **On Windows**, comparison is conservative: separators are normalized, each segment's trailing
    dots and spaces are dropped, and case is folded.
  - **On POSIX**, it is exact after normalization.
  - No filesystem identity is consulted, so hard links, junctions, symlinks and 8.3 short names are not
    detected.
  - Explicit paths also gained the 1024-byte path bound.
- **Unchanged:** per-cohort validation by `accountCampaign` and `parseSlotReport`, slot binding,
  `Buffer.equals` on the original bytes, the three outcomes and exit codes `0`/`1`, the 8-line
  output, and the scope. A manifest is operator-supplied transport. It is not evidence and proves
  nothing about authenticity, provenance, freshness, attempt or authorization.

**Tests:** `scripts/aggregation-campaign-retrieval-comparison.test.mjs`, **21/21**: the 12 earlier
tests plus 9 new ones, all synthetic. They cover:

- the new explicit-path duplicate and length checks, including Windows case and trailing-dot variants
  under an injected `win32` policy;
- manifest grammar and inclusive bounds;
- 28 grammar violations, each with its fixed problem;
- Windows and POSIX path keys;
- manifest `MATCH`, `DIFFERENT` and `REJECTED`, with resolution relative to each manifest, shuffled
  lines and either option order, and output identical to explicit paths;
- each manifest failure on either side (11 malformed forms, oversized or unknown size before reading,
  growth after the size check, unreadable), with zero report reads;
- duplicates and shared paths after resolution;
- 18 option errors with no file access;
- a spawned run of the package script's command in manifest mode over 118 real paths totalling more
  than 8191 characters: `MATCH`, a one-byte `DIFFERENT`, and a CRLF manifest exiting `2`. Names,
  sizes, mtimes and bytes were unchanged around every run, and output was leak-scanned.

All 22 hand-made mutants of the new code were caught. The six campaign tool test files together pass
**108/108** (baseline 99/99).

**Still not proven, so nothing changes:** that any real artifact set or log archive is retrievable,
that real recovered reports equal real artifact bytes, and any real 59-job retrieval. **Row 9 stays
`UNVERIFIED`, row 10 `BLOCKED`, row 11 `UNVERIFIED`, and rows 2, 6, 7 and 8 unresolved. The verdict
stays NO-GO.**

## 17. Update — report-path manifests for slot accounting and image-cohort review (2026-09-17)

This section records a code change, not a live probe. §§ 1–12 and §§ 14–16 are unchanged. In § 13,
only the L12 and L13 tool bullets and their matrix rows changed. Nothing was downloaded, no GitHub API
or network was called, no workflow was installed, pushed, dispatched or rerun, and **no real report,
report-path manifest, image-cohort manifest, accounting or review exists**.

**The gap.** § 16 removed the `cmd.exe` 8191-character obstacle for the comparator only. L12 and L13
still passed 59 long report paths through `pnpm run`, which can exceed the same limit on Windows.

**Added.** One more input mode for each command. The explicit-path forms are kept.

- `pnpm run account:aggregation-campaign -- --reports-manifest <file>`
- `pnpm run review:aggregation-campaign-image-cohort -- <image-cohort-manifest> --reports-manifest <file>`

**One shared contract.** The § 16 grammar, byte bounds, path resolution and duplicate policy moved
unchanged into `scripts/aggregation-campaign-report-manifest-lib.mjs`. The comparator, accounting and
image-cohort commands all use that module, so no rule has a second copy. The comparator's output and
tests are unchanged. The module holds only parsing, path arithmetic and constants.

- **Report-path manifest.**
  - Strict UTF-8 without BOM, at most 60 475 bytes, exactly 59 LF-terminated lines.
  - Each line is one report path of 1–1024 UTF-8 bytes. It has no CR, control character, padding,
    comment, quoting, escape, `-` prefix, URL or `C:name`.
  - A relative line resolves against the manifest's own directory. Line order means nothing.
- **Not the image-cohort manifest.** The L4 JSON snapshot keeps its own validator, its 4 KiB bound and
  its meaning, and still comes first.
  - A path list given as the snapshot is a rejected snapshot (`COHORT: BRANCH C`).
  - A snapshot given as `--reports-manifest` breaks the path-list grammar (exit `2`).
- **Options.** `--reports-manifest` appears once, followed by exactly one path and nothing else. A
  leading `--` is accepted only before the first real argument. These exit `2` before any report is
  read (and, for the review, before the JSON snapshot is read):
  - mixed modes;
  - a repeated, unknown or inline option (`--reports-manifest=value`);
  - a missing, empty or `-`-prefixed manifest path, or one over 1024 UTF-8 bytes;
  - any extra argument, or a late `--`;
  - for the review, `--reports-manifest` before the snapshot.
- **Bounded reading.**
  - The manifest's size is checked before it is read. A size that is too large, unknown or not a
    byte count is refused unread. The bytes are checked again after reading.
  - Every manifest failure exits `2` with one fixed line, `reports manifest: <problem>`, and **zero
    report reads**.
  - Only the named files and the 59 listed reports are read. Nothing is written, no directory is
    scanned and no glob is expanded. No path, argument, manifest line or OS error is printed.
- **Explicit paths, tightened consistently.** These now exit `2` before any read:
  - an empty path, or a path over 1024 UTF-8 bytes;
  - more than 128 paths. This is `LOG_RECOVERY_LIMITS.maxLogs`, the bound the image-cohort review
    and the comparator already had; accounting had none. The bound is not 59, so an unexpected
    extra report still reaches accounting and is reported there (exit `1`), as before;
  - a late `--`.
  - An unknown option still exits `2`, but accounting no longer echoes it.
- **Duplicates, in both modes.** The same report path twice after resolution exits `2` before any read.
  - **On Windows**, comparison is conservative: separators are normalized, each segment's trailing
    dots and spaces are dropped, and case is folded.
  - **On POSIX**, it is exact after normalization.
  - Hard links, junctions, symlinks and 8.3 short names are not detected.
- **Unchanged.**
  - Fewer than 59 explicit reports still produce the ordinary accounting with missing slots (exit
    `1`), and an incomplete review is still `COHORT: BRANCH C`.
  - Slots come only from `parseSlotReport` and `accountCampaign`. The review still calls
    `validateCohortManifest` and `reviewImageCohort`.
  - Output, classifications, topology and chronology checks, thresholds, eligibility and Branch rules
    are unchanged. Exit codes `0` and `1` mean what they meant.

**Tests**, all synthetic: accounting **24/24** (17 + 7), image-cohort **20/20** (15 + 5), comparator
**22/22** (21 + 1; the new test proves the comparator re-exports the shared contract rather than a
copy). They cover:

- explicit behavior kept, and explicit syntax, bound and duplicate errors;
- manifest success over 59 long relative paths, from another working directory, in shuffled order,
  with output identical to explicit paths;
- unchanged domain failures;
- 19 grammar violations, and oversized, unknown-size, post-read-growth and unreadable manifests;
- overlong entries and arguments;
- POSIX and injected Windows duplicates;
- option errors;
- zero report reads on every failure, and fixed diagnostics;
- a spawned run of each package script's command over 59 real paths totalling more than 8191
  characters: success, one domain failure and one exit `2`. Names, sizes, mtimes and bytes were
  unchanged around every run.

All 25 hand-made mutants of the new code were caught. The six campaign tool test files together pass
**121/121** (baseline 108/108).

A manual run of the real `pnpm run` commands on Windows used a temporary synthetic cohort: 59 paths
per set, about 11 300 characters if passed one by one. Through manifests it gave
`accounting: COMPLETE`, `COHORT: CONSISTENT` and `COMPARISON: MATCH`. One product-failure report gave
exit `1` in each command, and a CRLF manifest gave exit `2` in each. No file changed and no path
leaked.

**Still not proven, so nothing changes:** any real report set, its retrieval, its authenticity or its
provenance. A report-path manifest is operator-supplied transport and proves none of these. **Row 9
stays `UNVERIFIED`, row 10 `BLOCKED`, row 11 `UNVERIFIED`, and rows 2, 6, 7 and 8 unresolved. The
verdict stays NO-GO.**

## 18. Update — synthetic rehearsal of the post-run fallback chain (2026-09-17)

This section records a test, not a live probe or a code change. §§ 1–17 are unchanged. No production
code, package script, workflow, CI definition, threshold, classification or readiness row changed.
Nothing was downloaded, no GitHub API or network was called, no workflow was installed, pushed,
dispatched or rerun, and **no real log, artifact, report, manifest, comparison, accounting or review
exists**.

**Question.** Do the committed tools compose in the § 13 order, with each step's output as the next
step's input? The order is L11 fallback recovery, then the optional L11 comparison, then L12
accounting, then L13 review.

**Added.** `scripts/aggregation-campaign-post-run-rehearsal.test.mjs`, **5/5**. It is manual: it is
run directly with `node --test` and is not referenced by `pnpm verify`, the test phases, a package
script or `ci.yml`.

**The rehearsal.**

- **Setup.** One new temporary root outside the repository and `artifacts/`, removed in `finally`.
  It holds:
  - 59 synthetic reports rendered by the real harness code, including one environment-only event;
  - 59 job logs, both plain LF and timestamp-prefixed CRLF;
  - an independently written artifact copy of every report, under file names whose number is never
    the slot;
  - three report-path manifests in three shuffled orders, with absolute and relative lines;
  - a synthetic JSON review manifest.
- **Commands.** It spawns the four package-script commands read from `package.json`, in order:
  1. `recover:aggregation-campaign-logs -- --output-dir <new-directory> <job-log> ...`
  2. `compare:aggregation-campaign-retrievals -- --artifacts-manifest <file> --fallback-manifest <file>`
  3. `account:aggregation-campaign -- --reports-manifest <file>`
  4. `review:aggregation-campaign-image-cohort -- <review-manifest> --reports-manifest <file>`
- **Command-line length.** Passed one by one, either 59-report cohort would exceed the 8191-character
  `cmd.exe` limit, so steps 2–4 use only manifests.
- **Stopping rule.** A step passes only on its runbook result. The helper stops after the first step
  that does not pass.

**Results of the complete chain.**

- Recovery exits `0` with `materialization: WRITTEN - 59 report files …` and `RESULT: PASS`.
- The comparison exits `0` with `slots_compared=59 identical=59 different=0` and `COMPARISON: MATCH`.
- Accounting exits `0` with `accounting: COMPLETE`. Its output is identical to the accounting text
  that recovery printed from memory.
- The review exits `0` with `COHORT: CONSISTENT`, `commits=1 manifest_commit_match=yes`, and the same
  topology digest as the accounting.

**Handoff integrity.**

- Every manifest lists exactly the intended 59 files.
- Accounting and review read the same selected cohort manifest.
- Recovered bytes equal the independently written artifact bytes for every slot, where slots are read
  from content.
- File names and manifest order carry no slot.

**Writes and output.**

- The whole tree is snapshotted after setup and after every command: relative name, type, size,
  mtime and SHA-256.
- Recovery adds only its new directory and exactly `slot-01.txt` … `slot-59.txt`. No staging directory
  remains.
- The comparison, accounting and review add, remove or change nothing.
- No command prints a path, private marker, report content, log framing or OS error, and stderr is
  empty.

**Fail-closed chains.**

| case                                      | stops after | result                                                        |
| ----------------------------------------- | ----------- | ------------------------------------------------------------- |
| one changed artifact byte                 | comparison  | exit `1`, `identical=58 different=1`, `COMPARISON: DIFFERENT` |
| CRLF artifact manifest                    | comparison  | exit `2`, `artifacts manifest: …carriage return…`             |
| selected manifest naming one report twice | accounting  | exit `2`, duplicate path; review not run                      |
| a product-assertion blocker in one slot   | recovery    | exit `1`, `blockers=1`, `NOT WRITTEN`, nothing created        |
| one job on a rolled-forward runner image  | recovery    | exit `1`, topology differs, `NOT WRITTEN`, nothing created    |
| a review manifest for another commit      | review      | exit `1`, `manifest_commit_match=no`, `COHORT: BRANCH C`      |

Domain failures are exit `1` at the first step that evaluates them, never transport errors. Every
failing step wrote nothing.

**Mutation check.** Ten hand-made mutants were run against the rehearsal. Nine were caught:

- the helper not stopping after a failed step, or accepting a non-`MATCH` comparison;
- recovery writing unpadded file names, or placing its output elsewhere;
- relative manifest lines resolved from the caller's working directory;
- the comparator ignoring byte differences;
- the review dropping one listed report;
- accounting echoing the manifest path, alone and with the leak scan disabled.

The tenth (the review echoing a path on a manifest failure, which this rehearsal does not exercise)
is caught by the image-cohort suite. All were reverted.

Test totals: the seven campaign tool test files together pass **126/126**. That is the earlier six
at 121/121 plus the 5 rehearsal tests. The three manifest-enabled suites stay at 66/66.

**Known limit.** Recovery still takes its job logs as explicit paths; it has no manifest mode. The
rehearsal spawns `node` directly, so it does not show that 59 long log paths fit through `pnpm run`
on Windows. Operators should keep log paths short there.

**Still not proven, so nothing changes.** The rehearsal establishes synthetic tool composition only.
It supplies no authorization, billing, concurrency, queue, download, retrievability, provenance,
freshness, attempt or live campaign evidence. **Row 9 stays `UNVERIFIED`, row 10 `BLOCKED`, row 11
`UNVERIFIED`, and rows 2, 6, 7 and 8 unresolved. The verdict stays NO-GO.**

## 19. Update — job-log path manifests for fallback recovery (2026-09-17)

This section records a code change, not a live probe. §§ 1–18 are unchanged, except for one dated
note under the L11 fallback tool bullet in § 13. Nothing was downloaded, no GitHub API or network was
called, no workflow was installed, pushed, dispatched or rerun, and **no real log, job-log manifest,
recovery or materialized report exists**.

**The gap.** § 18 recorded the last `cmd.exe` obstacle: recovery took its job logs only as explicit
paths. Passed through `pnpm run` on Windows, 59 long log paths can exceed the 8191-character command
line.

**Added.** One more input mode for the same package script. The explicit form is kept.

- `pnpm run recover:aggregation-campaign-logs -- --logs-manifest <file>` (read-only)
- `pnpm run recover:aggregation-campaign-logs -- --output-dir <new-directory> --logs-manifest <file>`

**One shared contract.** `scripts/aggregation-campaign-report-manifest-lib.mjs` now exposes the § 17
grammar as a bounded path-manifest primitive (`parsePathManifest`, `loadPathManifest`) with a caller-
given entry range. The report-manifest exports are thin wrappers with exactly 59 entries. Their
sentences, bounds and results are unchanged, and the three report-manifest suites still pass
**66/66**. The module still holds only parsing, path arithmetic and constants.

- **Job-log manifest.**
  - The § 17 grammar: strict UTF-8 without BOM, LF only and a final LF, one path of 1–1024 UTF-8
    bytes per line, no CR, control character, padding, blank line, comment, quoting, `-` prefix, URL
    or `C:name`.
  - **1 to 128 lines** (`LOG_RECOVERY_LIMITS.maxLogs`), not exactly 59: one log may hold several
    reports, and slots are still accounted from content. At most 131 200 bytes.
  - A relative line resolves against the manifest's own directory. Logs are recovered in line
    order, which means nothing, just like explicit order.
- **Options.** `--output-dir <new-directory>` may appear once, before or after
  `--logs-manifest <file>` (or before, between or after explicit logs, as before). One leading `--`
  is accepted. These exit `2` with one fixed line, before any log is read and before any output
  file system call:
  - mixed modes, or any argument after the manifest path;
  - a repeated, unknown or inline option (`--logs-manifest=value`);
  - a missing, empty or `-`-prefixed manifest path, or one over 1024 UTF-8 bytes;
  - a late or repeated `--`.
- **Bounded reading.**
  - The manifest's size is checked before it is read. A size that is too large, unknown or not a
    byte count is refused unread. The bytes are checked again after reading, so growth is refused.
  - Every manifest failure exits `2` with `logs manifest: <problem>`, **zero log reads and zero
    materialization calls**.
  - After parsing, every listed log is sized before any is read, as before. An individually
    oversized log is never read, and no log is read when the aggregate limit is exceeded.
  - Only the named manifest and the listed logs are read. No directory is scanned, no glob is
    expanded, and no path, argument, manifest line or OS error is printed.
- **Explicit paths, tightened consistently with § 17.** These now exit `2` before any read:
  - an empty path, or one over 1024 UTF-8 bytes;
  - more than 128 paths (before: exit `1` from the recovery limit, after sizing);
  - a late `--` (before: ignored);
  - the same log twice (before: exit `1` as a duplicate slot, after reading).
  - The explicit success forms, their output and their exit codes are unchanged.
- **Duplicates, in both modes.** The same log path twice after resolution exits `2` before any read.
  - **On Windows**, comparison is conservative: separators are normalized, each segment's trailing
    dots and spaces are dropped, and case is folded.
  - **On POSIX**, it is exact after normalization.
  - Hard links, junctions, symlinks and 8.3 short names are not detected.
- **Unchanged.**
  - A listed log that cannot be read or is too large is still a recovery failure (exit `1`),
    counted and never named.
  - Recovery, rejection accounting, slot binding, report bytes, the output, and the all-or-nothing
    materialization with its staging cleanup.
  - Exit codes `0` and `1` mean what they meant.

**Tests**, all synthetic. The recovery suite is **33/33** (26 + 7), covering:

- the shared primitive and the unchanged report-manifest contract;
- every accepted option order in both modes, and 35 usage errors with fixed lines;
- 26 grammar violations, and oversized, unknown-size, post-read-growth and unreadable manifests,
  each in read-only and materializing form with zero log reads and zero output calls;
- the exact 131 200-byte bound, and missing, oversized and aggregate-oversized listed logs (exit
  `1`, sized before any read);
- POSIX and injected Windows duplicates in both modes;
- shuffled relative lines from another working directory, reaching recovery in line order, with
  output and output calls identical to explicit mode;
- a real spawned `pnpm --silent run recover:aggregation-campaign-logs -- …` over 59 log paths of
  213 characters each on the Windows host used (12 744 characters if passed one by one) through one
  short manifest path. Read-only gave `RESULT: PASS` and changed nothing. A CRLF manifest gave exit `2`.
  With `--output-dir`, the only additions were the new directory and its 59 reports. Names, sizes,
  mtimes and SHA-256 were snapshotted around every run.

The post-run rehearsal (§ 18) now runs recovery through that same package script with
`--logs-manifest`. The 59 log paths (189 characters each on that host) would total 11 328 characters if passed one by one, and the
manifest is shuffled and relative. Commands run from a directory where caller-relative resolution
finds nothing. The rehearsal adds one case, a job-log manifest naming one log twice: exit `2`,
nothing created, chain stopped. All earlier chain, fail-closed, no-write, cleanup and leak
assertions are kept. It is still manual: **5/5**.

Test totals: recovery and rehearsal together **38/38** (baseline 31/31); the seven campaign tool test
files together **133/133** (baseline 126/126). Fifteen hand-made mutants of the new code were all
caught.

**What this closes.** Only the offline Windows argument-transport gap named in § 18. A job-log
manifest is operator-supplied transport, not evidence: it proves nothing about which logs belong to
the campaign, their completeness, authenticity or provenance.

**Still not proven, so nothing changes.** No authorization, billing, concurrency, queue, download,
retrievability, provenance, freshness, attempt or live campaign evidence exists. **Row 9 stays
`UNVERIFIED`, row 10 `BLOCKED`, row 11 `UNVERIFIED`, and rows 2, 6, 7 and 8 unresolved. The verdict
stays NO-GO.**

## 20. Appendix — L11–L13 operator command card (2026-09-17)

This appendix is **procedure, not evidence**. It condenses § 13 L11–L13 as updated by §§ 14–19 into
one page. It adds no step, removes none, and changes no rule. Where this card and § 13 seem to
differ, § 13 governs and the difference is a defect to report. §§ 1–19 are unchanged. Nothing here
was executed: no workflow was installed or run, nothing was downloaded, no GitHub API or network was
called, and **no real log, manifest, report, snapshot or tool output exists**.

The four marked command blocks below are checked by the manual static test
`scripts/aggregation-campaign-command-card.test.mjs`. It checks them against `package.json`, the
exported argument parsers of the four tools, and their real output text. It runs no command on real
inputs.

### 20.1 Rules for every command on this card

- **When.** Only inside an authorized launch window, after L10, in the order below, under every rule
  of § 13.1.
- **Absolute paths only.** Write every placeholder (`<new-directory>`, each manifest,
  `<image-cohort-manifest>`) as an absolute path. `pnpm run` runs the script from the repository
  root, so a relative argument resolves there, not in the shell's directory. A relative line
  _inside_ a manifest resolves against that manifest's own directory.
- **Keep the double quotes** (_corrected 2026-09-17, § 21_). Every path placeholder in a marked command
  is enclosed in double quotes. Replace only the placeholder, including its `<` and `>`, and keep both
  quotes, so a path that contains spaces stays one argument. The quotes are shell syntax, not part of
  the path: the tool receives the path without them. Do not end a quoted path with `\`. On Windows a
  `\` directly before the closing quote escapes it, and the rest of the command is misread. Lines
  _inside_ a manifest are never quoted.
- **Exit codes.**
  - `0` is the only pass.
  - `1` is a failed check. Keep the output. The step's consequence below applies.
  - `2` is a usage or manifest-contract error. Nothing was checked, compared or written.
- **After exit `2`.** Only the command line, or a manifest's path list, may be corrected before the
  same step is run again. An exit-`2` correction **never** edits, re-saves, renames, re-encodes,
  re-downloads, re-materializes, replaces or deletes any job log, artifact, report, JSON snapshot,
  output directory or kept tool output.
- **Keep byte-exact.**
  - The original job logs and artifacts.
  - Every manifest exactly as used, including one refused with exit `2`.
  - Every tool output.
  - The output directory of a successful recovery.
  - Nothing is kept under `.github/workflows/`.

### 20.2 Three kinds of input file — never interchangeable

| file                                                                                                               | used by                                                        | what it is                                                                      | entries              | byte bound |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------- | ---------- |
| **job-log manifest** `<job-log-manifest>`                                                                          | step 1 only (`--logs-manifest`)                                | plain path list of every kept job log                                           | **1–128** lines      | 131 200    |
| **report-path manifest** `<artifacts-report-manifest>`, `<fallback-report-manifest>`, `<selected-report-manifest>` | step 2 (one per source), steps 3 and 4 (the same selected one) | plain path list of one source's reports                                         | **exactly 59** lines | 60 475     |
| **image-cohort JSON snapshot** `<image-cohort-manifest>`                                                           | step 4 only, first argument                                    | the L4 flat JSON object with its nine fields, hashed in L5; **not** a path list | —                    | 4 KiB      |

- **Both path lists** share one grammar:
  - strict UTF-8 without BOM, LF line endings and a final LF;
  - one path of 1–1024 UTF-8 bytes per line;
  - no blank line, padding, CR or other control character, comment, quoting, `-` prefix, URL or
    drive-relative `C:name`.
- **Resolution and duplicates.**
  - A relative line resolves against the manifest's own directory. Line order means nothing.
  - The same path twice after resolution exits `2`. On Windows, case and trailing dots and spaces are
    ignored. Links, junctions and 8.3 names are not detected.
- **Status.** A manifest is operator-supplied transport. It is **not** evidence of which files belong
  to the campaign, or of their completeness, authenticity or provenance.

### 20.3 Step 1 — L11 fallback recovery, only if the primary artifacts are unavailable

**Run it only when** the 59 per-slot artifacts cannot be retrieved, the fallback is acknowledged in
the launch record, and the job logs are kept byte-exact.

- `<new-directory>` must not exist yet.
- Its parent must be an existing, non-link directory outside the tracked tree and outside
  `.github/workflows/`.
- `<job-log-manifest>` lists every kept job log.

<!-- command-card:L11-recover -->

```text
pnpm run recover:aggregation-campaign-logs -- --output-dir "<new-directory>" --logs-manifest "<job-log-manifest>"
```

- **Pass — exit `0`.** All three lines are required:
  - `accounting: COMPLETE - every slot resolved from content, zero blockers, zero missing`
  - `materialization: WRITTEN - 59 report files slot-01.txt..slot-59.txt in a newly created output directory`
  - `RESULT: PASS`, as the last line.
  - Steps 3 and 4 then use `<new-directory>/slot-01.txt` … `slot-59.txt` as the one fallback source.
- **Exit `1` — `RESULT: FAIL`.**
  - Causes include `materialization: NOT WRITTEN` or `FAILED`, an unreadable or oversized log, a
    rejection, and an incomplete or blocked accounting.
  - The materialization line states what was cleaned up. Nothing is deleted by hand to make room for
    a retry.
  - Retrieval stays incomplete, and a slot that is never retrieved is `missing` (Branch C).
  - The same unedited logs may be processed again only into another path that does not exist yet.
    Nothing already written is deleted, renamed or reused.
- **Exit `2`.** The output is `logs manifest: <problem>`, or a fixed usage error. No log was read and
  nothing was written.

### 20.4 Step 2 — optional L11 byte comparison, only when both complete sources exist

**Run it only when** all 59 downloaded artifact reports **and** all 59 files of a step 1 run that
exited `0` are on disk, **and** the decision to compare was recorded before running it. Once run, its
output is kept whatever the result.

- `<artifacts-report-manifest>` lists the 59 artifact reports.
- `<fallback-report-manifest>` lists the 59 materialized files.
- The two manifests are different files, and the two sources share no path.

<!-- command-card:L11-compare -->

```text
pnpm run compare:aggregation-campaign-retrievals -- --artifacts-manifest "<artifacts-report-manifest>" --fallback-manifest "<fallback-report-manifest>"
```

- **Pass — exit `0`.** All four lines are required:
  - `artifacts cohort: ACCEPTED inputs=59 read=59 accounting=COMPLETE`
  - `fallback cohort: ACCEPTED inputs=59 read=59 accounting=COMPLETE`
  - `comparison: slots_compared=59 identical=59 different=0`
  - `COMPARISON: MATCH`
- **Exit `1` — `COMPARISON: DIFFERENT` or `COMPARISON: REJECTED`.**
  - This is a **STOP**, and the campaign is **Branch C**.
  - It is **not** permission to choose a source.
  - It cannot be repaired by mixing files, editing, re-downloading, re-materializing or re-running.
- **Exit `2`.** The output is `artifacts manifest: <problem>`, `fallback manifest: <problem>`, or a
  fixed usage error. Nothing was compared.

### 20.5 Step 3 — L12 accounting of one complete, unmixed 59-report source

**The input is one complete set of 59 reports from one source:** the downloaded artifacts, or the
files of a step 1 run that exited `0`. Never mix the two.

- If step 2 was run, step 3 is allowed only after `COMPARISON: MATCH`.
- This card does not choose between two matching sets. Record which single source
  `<selected-report-manifest>` lists.

<!-- command-card:L12-account -->

```text
pnpm run account:aggregation-campaign -- --reports-manifest "<selected-report-manifest>"
```

- **Pass — exit `0`.** Both lines are required:
  - an `invariant:` line ending in `= 59 (expected 59) holds`;
  - `accounting: COMPLETE - every slot resolved from content, zero blockers, zero missing`.
- **Exit `1`.** The output is `accounting: INCOMPLETE - …`: a blocker, a missing slot, a rejected
  input or a provenance problem. The result is **Branch C**.
- **Exit `2`.** The output is `reports manifest: <problem>`, or a fixed usage error. No report was
  read.

### 20.6 Step 4 — L13 image-cohort review of that same source, after the snapshot hash check

**Before running**, `[manual/live]`:

- Compute the SHA-256 of the exact `<image-cohort-manifest>` bytes. It must equal
  `image_cohort_manifest_sha256` in the launch record.
- A mismatch, or a hash that cannot be computed, is a failed check. Do not run the review; the result
  is **Branch C**.

**Inputs.** The JSON snapshot comes first. `<selected-report-manifest>` is the same file used in
step 3.

<!-- command-card:L13-review -->

```text
pnpm run review:aggregation-campaign-image-cohort -- "<image-cohort-manifest>" --reports-manifest "<selected-report-manifest>"
```

- **Pass — exit `0`.** All three lines are required:
  - `pre-launch snapshot: ACCEPTED`
  - `commits=1 manifest_commit_match=yes`
  - `COHORT: CONSISTENT`
  - A human then reads and records the single measured topology (§ 11, item 5).
- **Exit `1`.** The output is `COHORT: BRANCH C`, whatever the reason. The result is **Branch C**.
- **Exit `2`.** The output is `reports manifest: <problem>`, or a fixed usage error. Neither the
  snapshot nor any report was read.

### 20.7 What no line on this card proves

None of these outcomes shows that any log, artifact or report is authentic, retrievable, from the
authorized run, fresh, or from attempt `1`:

- a manifest that parses;
- a `WRITTEN` materialization;
- `COMPARISON: MATCH`;
- `accounting: COMPLETE`;
- `COHORT: CONSISTENT`.

None of them grants Branch A or B. A branch is stated only under L14, and only when L10 proved
attempt `1`, L12 is `COMPLETE` and L13 is `CONSISTENT`.

**Status.** This card establishes no live fact. **Row 9 stays `UNVERIFIED`, row 10 `BLOCKED`, row 11
`UNVERIFIED`, and rows 2, 6, 7 and 8 unresolved. The verdict stays NO-GO.**

## 21. Update — command-quoting correction for § 13 L11–L13 and the § 20 card (2026-09-17)

This is a **correction of procedure text and of a test blind spot, not evidence**. Nothing was installed, pushed,
dispatched, downloaded or run on a real input, and no live fact was established.

- **Defect.** § 20 called its four manifest-based commands Windows-safe and required absolute paths, but wrote every
  path placeholder unquoted, as did the recommended manifest commands of § 13 L11–L13. A real absolute path that
  contains a space would be split by the invoking shell into several arguments before any tool's parser saw it. The
  result would be a usage error or a different mode, not the intended manifest run.
- **Why the check missed it.** The § 20 static test split each command on spaces and replaced placeholders only with
  paths that contain no space, so it could not observe the split.
- **Correction.** Every path placeholder is now double-quoted in the four marked card commands and in the four
  recommended manifest commands of § 13 L11–L13: the recovery output directory, the job-log manifest, both comparison
  manifests, the selected report manifest and the image-cohort JSON snapshot. § 20.1 now says:
  - keep both quotes when replacing a placeholder;
  - the quotes are shell syntax, not part of the path;
  - never end a quoted path with `\`;
  - lines inside a manifest are never quoted.
- **Unchanged.** No other command form, bound, threshold, classification or rule changed. The still-valid explicit-path
  forms in § 13 and the historical text of §§ 14–19 are unchanged; where they differ, § 13 and § 20 govern.
- **Test.** `scripts/aggregation-campaign-command-card.test.mjs` (manual, 8 tests) now:
  - reads each command with a strict reader for the fixed template grammar, not a shell parser. Bare tokens are the
    package, verb, script, `--` and options. Each path placeholder occurs exactly once, in its role, inside one
    balanced pair of double quotes;
  - replaces the decoded placeholder, not the quotes, with absolute POSIX and Windows paths that contain spaces, up to
    exactly 1024 bytes (one byte more is refused by every parser), then calls the real exported parser. The longest
    command line stays below 8191 characters;
  - checks that § 13 L11–L13 gives the same quoted forms;
  - rejects drift: an unquoted placeholder in each command and in the whole card as first written, single quotes, a
    missing opening or closing quote, quotes spanning an option, a quote glued to the next token, a quoted option, a
    placeholder used twice, and swapped roles;
  - on Windows only, runs the four exact quoted commands through `cmd.exe` and `pnpm` from the repository root. It uses
    absolute paths with spaces in a test-owned temporary directory, where no manifest exists. Each command reaches its
    manifest contract (`logs manifest:`, `artifacts manifest:` or `reports manifest:` followed by
    `manifest could not be read`) and exits `2`. No output directory is created and nothing is written. Two controls
    show that the same boundary misreads the command without the quotes, or with a `\` before a closing quote. No
    supplied path is printed, and the temporary directory is removed.
- **Not covered.** PowerShell and other shells are not exercised. Paths that contain `"`, `%` or other `cmd.exe`
  metacharacters were not tested.
- **Correction, later on 2026-09-17 — test-harness hardening, no live evidence.** On a host where `cmd.exe` resolves no
  `pnpm`, although the repository-declared pnpm works through Corepack, the Windows smoke test failed 7/8. It reported
  an empty first line at `L11-recover` as a missed manifest contract, when in fact `pnpm` had never started. The test
  now:
  - runs a package-manager preflight before any card command. A `pnpm` resolved by `cmd.exe` is preferred. Otherwise
    the Corepack launcher next to the active Node executable is used, through a test-owned `pnpm.cmd` shim under the
    test's temporary directory, on a PATH prepended for child processes only. Either must report the pnpm version
    declared in `package.json`; if neither does, the test fails once with a fixed diagnostic;
  - checks every spawn for a runner failure before judging its output: the shell not starting, a timeout or signal,
    no numeric exit status, `pnpm` not resolved, or pnpm not starting the step's script. Each failure is reported with
    a fixed sentence and no path or raw output;
  - counts the shim in its zero-write baseline, and covers runner selection, shim argument forwarding and the
    fail-first diagnostic with focused cases.

  The test file now has 10 tests. The card commands, § 13 and every readiness row are unchanged.

**Status.** This correction establishes no live fact. **Row 9 stays `UNVERIFIED`, row 10 `BLOCKED`, row 11
`UNVERIFIED`, and rows 2, 6, 7 and 8 unresolved. The verdict stays NO-GO.**
