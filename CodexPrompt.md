Continue on the existing `feat/outbox-durable-claim` branch. Do not create another branch, amend, force-push, or merge PR #23.

I reviewed the repository at `438e6739b88ed93134a0894d8bc76e171522c780`. The four-stream rewrite meets the recorded filter ceiling, but it introduces an untested `SKIP LOCKED` under-filled-batch risk.

## Verified gap

The current query:

1. applies `LIMIT $4` inside each unlocked eligibility stream;
2. reduces the merged candidates to `LIMIT $4`;
3. only then applies `FOR UPDATE SKIP LOCKED`.

Concurrent callers can therefore choose the same pre-limited candidates. If one locks them first, another may return an empty or short batch despite additional eligible rows beyond that window.

The existing test does not cover this: it is sequential, seeds only 10 rows, lets the first claimant take all 10, and expects the second to receive zero.

## Required engineering change

Make the four-stream claim query contention-safe: it must continue past locked oldest candidates and return a full batch whenever at least `limit` unlocked eligible rows exist.

Preserve:

- one atomic SQL statement;
- `FOR UPDATE SKIP LOCKED`;
- UUID fencing-token semantics;
- database-time eligibility;
- deterministic `created_at, id` ordering among rows available to the claimant;
- four mutually exclusive eligibility streams;
- the final eligibility re-check;
- no tenant filter;
- all renewal, retry, shutdown, and at-least-once guarantees;
- D-027 remaining open.

Do not use sleeps, whole-claim retry loops, planner switches, arbitrarily oversized candidate windows, or unbounded scans.

Evaluate the smallest correct restructuring. Locking within each stream before its `LIMIT` is one candidate, but verify it rather than assuming it is correct. Measure and document its possible `4 × limit` lock amplification and whether temporarily locking candidates not selected by the final global limit is acceptable. If it is not, implement another bounded one-statement solution.

## Deterministic contention tests

Add real PostgreSQL tests against the production `claimPendingSql`.

At minimum:

1. Seed substantially more than `2 × limit` eligible rows.
2. On connection A, begin a transaction and lock the oldest `limit` rows without committing.
3. While those locks remain held, call the real `claimPending(limit)` through connection B.
4. Assert B returns exactly `limit` rows.
5. Assert none belongs to A’s locked set.
6. Assert B’s rows follow deterministic `created_at, id` order.
7. Roll back A and clean up without timing assumptions.

Repeat or parameterize this for:

- fresh rows;
- expired-lease-only rows;
- due-retry-only rows;
- paired expired-lease plus due-retry rows;
- contention distributed across multiple streams.

Prove that sufficient unlocked backlog produces a full batch, locked rows are skipped, batches remain disjoint, no row is claimed twice, and no ineligible or published row is admitted.

Retain the original sequential fencing test as a separate property.

## Performance re-verification

Run `EXPLAIN (ANALYZE, BUFFERS)` using the exact final production statement for all six ADR fixtures and an additional locked-prefix fixture.

Record:

- returned batch size;
- execution time;
- buffers;
- chosen indexes;
- rows removed by filter;
- sort method and memory;
- temporary disk use;
- rows locked per stream and total lock amplification where observable.

The final query must still satisfy:

- no sequential scan on scaled fixtures;
- `rows removed by filter <= 10 × LIMIT`;
- full batch after skipping a locked prefix;
- bounded execution on the one-million-row fixture.

If it cannot satisfy these requirements, stop and present measured design options. Do not waive or rewrite the criterion.

## Correct contradictory evidence

The tracked evidence currently disagrees:

- `outbox-sql.ts` says `0.067–5.4 ms`;
- the ADR table says `0.048–6.578 ms`;
- all eight new migration comments say approximately `10.4 MB`, a `27 MB` table, and indexes growing `21 MB → 31 MB`;
- the ADR and `PROJECT_MEMORY.md` say approximately `8 MB`, a `24 MB` table, and indexes growing `21 MB → 28 MB`.

Remeasure once using the final fixture and indexes. Make the code comment, all eight migration comments, ADR evidence, and `PROJECT_MEMORY.md` agree with the actual results.

Also verify why `ix_outbox_due_lease` is recorded as only `8192 bytes` in a 200,000-row fixture. Document the fixture distribution if correct; otherwise correct the measurement and every dependent statement.

Do not rewrite commit `438e673`; add a new atomic corrective commit and explicitly correct the earlier figures in the final report.

## Verification

Run and report actual results for:

- focused contention and eligibility-equivalence tests;
- all 24 ADR tests and every added regression test;
- formatting, lint, and typecheck;
- all unit and integration suites;
- migration `up → down → up` for all eight databases;
- tenant-isolation, authorization, idempotency, and financial-consistency gates;
- full E2E;
- unchanged coverage gates;
- `pnpm verify`;
- `pnpm audit --audit-level=high`;
- Semgrep with the exact CI configuration;
- Gitleaks over the complete branch range;
- all eight local image builds where the environment supports them.

Push normally to the existing branch and wait for fresh PR CI. Report retries and environmental failures honestly.

Keep ADR-050 `Proposed`, D-026 and D-027 open, progress percentages unchanged, and `design/claude-design` untouched. Do not start Marketplace seed, Supplier Service, frontend, or design sync.

Return the new head SHA, final SQL and locking design, deterministic contention evidence, corrected performance and index-size figures, complete verification results, and fresh PR #23 CI state. Stop without merging.
