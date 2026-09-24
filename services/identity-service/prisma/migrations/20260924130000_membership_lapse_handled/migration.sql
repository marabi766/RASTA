-- ADR-060 § 5 -- a membership's validUntil is enforced, and its passing is
-- projected.
--
-- Additive only: one nullable column and one partial index.
--
-- `lapse_handled_at` records that the expiry sweep has acted on a membership
-- whose `valid_until` has passed: moved the user's active organization off it
-- if it was the active one, published MEMBERSHIP_EXPIRED, and re-projected the
-- user into Keycloak. Null means "not yet". The sweep claims a row by setting
-- it with `WHERE lapse_handled_at IS NULL`, so two replicas never act on the
-- same lapse twice, and a restart resumes exactly where the last sweep
-- stopped -- nothing depends on the process having been up at the moment a
-- membership expired.
--
-- The column does not decide access. Whether a membership grants anything is
-- decided from `status`, `valid_from` and `valid_until` against the clock
-- (`membership-window.ts`), whether or not the sweep has run yet.
ALTER TABLE "membership" ADD COLUMN "lapse_handled_at" TIMESTAMP(3);

-- Only the rows the sweep still has to visit: lapsing, not yet handled, not
-- deleted. Stays small however many memberships have ever expired.
CREATE INDEX "ix_membership_lapse_pending"
  ON "membership" ("valid_until")
  WHERE "lapse_handled_at" IS NULL AND "valid_until" IS NOT NULL AND "deleted_at" IS NULL;
