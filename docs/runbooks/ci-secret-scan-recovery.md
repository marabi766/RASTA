# Recover a refused main secret-scan range

The `Secret scan` step refuses malformed or missing commits, an empty unequal
range (including a rollback), octopus merges, and Gitleaks errors or incomplete scans. These refusals are security
failures: a green scan of an empty range is not proof that main was scanned.
Re-running the same event cannot repair its immutable `before` SHA.

Record the failed run URL, its `before` and head SHAs, and the reason for refusal.
Use a fresh local clone/worktree with full history at the exact affected head;
keep the shared clone's checkout unchanged. Obtain PM agreement on a manual base:
an earlier, already-scanned ancestor of that head, distinct from it. For a
rollback, choose an ancestor older than the rollback target, not the abandoned
descendant. For rewritten history, recover missing objects from a retained clone
where possible. If no scanned ancestor can be established, stop for a full-history
security review; do not substitute `HEAD`, skip the scan, or edit the ignore list.

After reviewing the checkout's scan/helper code, install dependencies with
`pnpm install --frozen-lockfile`. Set `SCAN_BASE` and `SCAN_HEAD` to the agreed
40-character SHAs. In that checkout, run:

```bash
set -euo pipefail
export SCAN_BASE SCAN_HEAD
test "$(git rev-parse HEAD)" = "$SCAN_HEAD"
test "$SCAN_BASE" != "$SCAN_HEAD"
git merge-base --is-ancestor "$SCAN_BASE" "$SCAN_HEAD"
export RUNNER_TEMP="$(mktemp -d)"
export GITHUB_PATH="$RUNNER_TEMP/path"
node scripts/ci-tool-download.mjs install gitleaks
export PATH="$(cat "$GITHUB_PATH"):$PATH"
GITLEAKS_TEST_BINARY="$(command -v gitleaks)" node --test scripts/ci-tool-download.test.mjs
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { parse } from "yaml";
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  writeFileSync(process.env.RUNNER_TEMP + "/scan.sh",
    workflow.jobs.security.steps.find(s => s.name === "Secret scan").run);
'
bash "$RUNNER_TEMP/scan.sh"
```

Keep the exit status, redacted log, pinned tool version, exact SHAs, and report
with the incident. A finding still fails (exit 2); investigate it using normal
secret-response procedures. Never paste secret values into the incident.
Octopus history needs a separate reviewed scan plan; the manual base must not
exclude an unscanned octopus merge just to pass this guard.

Also account for commits removed from main: recover and scan their previously
unscanned ranges separately. If objects cannot be recovered, report that coverage
as unknown and escalate; scanning the replacement head cannot prove their safety.
Remove the temporary tool directory after retaining the evidence. The original
CI event stays red; attach the manual evidence for PM disposition, without
claiming that it retroactively passed CI.

Gitleaks 8.30.1 can exit zero after logging `ERR` (including Git warnings on stderr)
or a partial scan. The workflow captures both streams in
`$RUNNER_TEMP/gitleaks.*.log`, refuses `ERR`/`partial scan`, and requires the positive
`INF scanned ~<bytes> bytes (...) in <duration>` completion summary. An absent or
changed summary refuses too. Retain that log; do not treat "no leaks found" alone
as proof of a complete scan or disable the guard to recover.

For a reviewed false positive introduced by a merge conflict resolution, the
pinned parser reports the exact path `b/<file>` (for example `b/base`), although
that prefixed path does not exist in the tree. Copy the **reported fingerprint**
into `.gitleaksignore`: `<merge-commit-sha>:b/<file>:<rule-id>:<line>`, for example
`<merge-commit-sha>:b/base:range-fixture:1`. Do not strip `b/`, ignore a directory,
or change detection rules. The topology test asserts this identity so a future
parser change requires review.

The CI tool archive key uses the reviewed `ci-tool-v2-linux-x64-` namespace to
retire old immutable remote cache entries. Version and SHA-256 remain in the key,
and every restored archive is verified again before extraction. A future corrupt
remote entry still requires a reviewed salt rotation; deleting a local archive
cannot overwrite an immutable remote entry. Never relax checksum verification.
