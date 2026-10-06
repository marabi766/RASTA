-- =============================================================================
-- contract-service — a review names the move that caused it only when one did (CON-003 PR 2
-- review round 6, ruling 1; docs/23 D-050).
--
-- A review row (and its CONTRACT_SIGNATURE_AUTHORITY_FLAGGED) used to name "the" ORGANIZATION_MOVED
-- event, the moved organization and its instant. Two ways that named the wrong one:
--
--   * a later move coalesced into the open task and the task took its version but kept the first
--     move's event — fixed in the coalescing statement, which now carries the whole provenance of
--     the move whose version it keeps;
--   * a move that has nothing to do with the employer (an unrelated organization moved) queued a
--     re-check, and the re-check found the employer already outside the union: the detection was
--     real, the named event was not its cause.
--
-- So the cause is optional and the detection says what found it, a closed code:
--
--   `ORGANIZATION_MOVED` — a move proven to be the cause (the employer is in the moved
--                          organization's subtree and carries that move's hierarchy version):
--                          `cause_event_id` and `moved_at` name it;
--   `MOVE_RECHECK`       — a move queued the re-check but is not shown to be its cause (an unrelated
--                          move, or an event without a version): no event, no instant. The version
--                          the signatures were compared against stays in `moved_version`, as the
--                          basis of the comparison, not as a claim about a cause.
--
-- Existing rows are all `ORGANIZATION_MOVED`: they were written naming their event.
-- =============================================================================

ALTER TABLE "signature_authority_review"
  ALTER COLUMN "cause_event_id" DROP NOT NULL,
  ALTER COLUMN "moved_at" DROP NOT NULL,
  ADD COLUMN "detected_by" TEXT NOT NULL DEFAULT 'ORGANIZATION_MOVED';

ALTER TABLE "signature_authority_review" ALTER COLUMN "detected_by" DROP DEFAULT;

ALTER TABLE "signature_authority_review" DROP CONSTRAINT "ck_review_reason";
ALTER TABLE "signature_authority_review" ADD CONSTRAINT "ck_review_reason"
  CHECK ("reason" = 'AUTHORITY_CHANGED_DURING_SIGNING' AND "side" = 'EMPLOYER');

ALTER TABLE "signature_authority_review" ADD CONSTRAINT "ck_review_detection"
  CHECK ("detected_by" IN ('ORGANIZATION_MOVED', 'MOVE_RECHECK')
         AND (("detected_by" = 'ORGANIZATION_MOVED')
              = ("cause_event_id" IS NOT NULL AND "moved_at" IS NOT NULL))
         AND ("cause_event_id" IS NULL OR btrim("cause_event_id") <> ''));
