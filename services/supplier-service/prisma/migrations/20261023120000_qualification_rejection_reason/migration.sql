-- =============================================================================
-- supplier-service — the rejection reason is part of the qualification record
-- (Codex review of PR 366, finding 4).
--
-- `RejectQualification` has always required a reason "stated for the
-- supplier", and until now it lived only in the `SUPPLIER_REJECTED` event: the
-- row kept the reviewer's private note and nothing the supplier was meant to
-- read, so the supplier's own record of a rejection said nothing about why. A
-- seven-day topic is not a record anybody can open.
--
-- ## The column
--
-- `rejection_reason`, the supplier-visible reason, written in the same UPDATE
-- that decides the row. It is a different thing from `decision_note`, which is
-- the reviewer's private note and is projected to reviewers only.
--
-- ## The rules
--
--   ck_qualification_rejection_reason_shape   a reason belongs to a rejection
--                                             and is never blank. Validated:
--                                             no row holds the column yet.
--   ck_qualification_rejected_has_reason      a rejection carries a reason.
--                                             `NOT VALID`: enforced on every
--                                             row written or updated from now
--                                             on, and not checked against
--                                             rejections recorded before this
--                                             migration, whose reason may be
--                                             gone with its outbox row (below).
--                                             A decided row is never updated
--                                             again, so nothing old trips it.
--
-- ## The backfill
--
-- Best effort, from the outbox: a rejection whose `SUPPLIER_REJECTED` row is
-- still in `outbox_message` (published rows are purged after their retention)
-- gets the reason that event published. The column holds the whole event
-- envelope (`buildOutboxRow`), whose `payload` is the validated domain payload
-- (`events/publisher.ts`), so `payload->'payload'->>'reason'` is the stated
-- reason verbatim. A rejection whose event is already purged keeps a null reason and
-- the API returns `rejectionReason: null` for it; nothing is invented.
-- =============================================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE "qualification" ADD COLUMN "rejection_reason" TEXT;

ALTER TABLE "qualification" ADD CONSTRAINT "ck_qualification_rejection_reason_shape"
  CHECK (
    "rejection_reason" IS NULL
    OR ("state" = 'REJECTED' AND "rejection_reason" ~ '[^[:space:]]')
  );

UPDATE "qualification" AS q
   SET "rejection_reason" = o."payload"->'payload'->>'reason'
  FROM "outbox_message" AS o
 WHERE o."event_name" = 'SUPPLIER_REJECTED'
   AND o."aggregate_id" = q."id"
   AND q."state" = 'REJECTED'
   AND q."rejection_reason" IS NULL
   AND o."payload"->'payload'->>'reason' ~ '[^[:space:]]';

ALTER TABLE "qualification" ADD CONSTRAINT "ck_qualification_rejected_has_reason"
  CHECK ("state" <> 'REJECTED' OR "rejection_reason" IS NOT NULL) NOT VALID;
