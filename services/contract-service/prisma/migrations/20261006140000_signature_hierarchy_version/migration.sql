-- =============================================================================
-- contract-service — a signature records the hierarchy VERSION it read, and a move is ordered
-- against it by number (CON-003 PR 2 review round 4, ruling 1; docs/23 D-050).
--
-- Round 3 compared instants: the signature's `hierarchy_read_at` with the move's `occurredAt`. A
-- timestamp cannot order a move in another service: `occurredAt` is taken before the move
-- commits, so a hierarchy read after it and before the commit still sees the old tree with a
-- "later" time, and was never flagged. organization-service now stamps a `hierarchy_version` on
-- the moved organization and every descendant in the move's own transaction, answers it with
-- "within", and carries the new value on ORGANIZATION_MOVED. So:
--
--   * `contract_signature.hierarchy_version` — the employer's version in the tree the answer came
--     from. NULL on a signature recorded before this migration (and on one that needs no
--     hierarchy); a NULL under evidence is treated as older than any move;
--   * `policy_reconciliation_task.moved_version` — the move's version; a task that coalesces a
--     later move keeps the HIGHER one (its flagging then covers both). NULL on a task queued
--     before this migration: the window alone decides for it;
--   * `signature_authority_review.moved_version` / `recorded_version` — what was compared, for the
--     record.
--
-- A signature is flagged when its recorded version is LOWER than the move's and it could still
-- have committed after the move was prepared (`hierarchy_commit_deadline >= moved_at`): the
-- window bounds which signatures are looked at, the version decides which of them read the old
-- tree. `hierarchy_read_at` stays as diagnostics. Nothing is revoked.
-- =============================================================================

ALTER TABLE "contract_signature" ADD COLUMN "hierarchy_version" BIGINT;
ALTER TABLE "contract_signature" ADD CONSTRAINT "ck_signature_hierarchy_version"
  CHECK ("hierarchy_version" IS NULL
         OR ("hierarchy_version" >= 1 AND "hierarchy_read_at" IS NOT NULL));

ALTER TABLE "policy_reconciliation_task" ADD COLUMN "moved_version" BIGINT;
ALTER TABLE "policy_reconciliation_task" ADD CONSTRAINT "ck_policy_reconciliation_moved_version"
  CHECK ("moved_version" IS NULL OR "moved_version" >= 1);

ALTER TABLE "signature_authority_review"
  ADD COLUMN "moved_version" BIGINT,
  ADD COLUMN "recorded_version" BIGINT;
ALTER TABLE "signature_authority_review" ADD CONSTRAINT "ck_review_versions"
  CHECK (("moved_version" IS NULL OR "moved_version" >= 1)
         AND ("recorded_version" IS NULL OR "recorded_version" >= 1));
