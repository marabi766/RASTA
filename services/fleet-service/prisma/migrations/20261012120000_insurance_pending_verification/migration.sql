-- INSURANCE_RECORDED events parked until the replica catches up with asset-service
-- (#240 round 8).
--
-- Every INSURANCE_RECORDED is verified at asset-service before it is applied
-- (ADR-061 § 4), and asset-service answers the asset's CURRENT owner only. When
-- the machine has been transferred at the source but fleet has not consumed
-- ASSET_TRANSFERRED yet — the insurance and asset topics carry no order between
-- them — the answer is NOT_CURRENT_OWNER, or names a later ownership generation
-- than the replica's. Retrying for ~1.5 s and dead-lettering lost the new
-- owner's valid coverage until a manual replay. Such an event is now stored
-- here, its delivery marked processed in the same transaction; the transfer's
-- handler re-verifies every parked event of the machine once the transfer is
-- projected, and a periodic sweep re-verifies what is left and dead-letters a
-- row whose attempts run out (PARKED_VERIFICATION_EXHAUSTED). Nothing in here is
-- ever applied without the source's answer.
--
-- Tenant data: `organization_id` is the event envelope's tenant, and the table
-- is in the tenant guard's scoped list. A new, empty table: nothing existing is
-- read or rewritten.
BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE "insurance_pending_verification" (
    "event_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    -- The envelope as consumed, payload included: re-verified from it, and
    -- dead-lettered as it, so a replay is the same event.
    "envelope" JSONB NOT NULL,
    -- Where the delivery came from, for the dead letter (the replay goes out
    -- under the kept key, docs/runbooks/replay-dlq.md).
    "message_key" TEXT,
    "source_topic" TEXT NOT NULL,
    "source_partition" INTEGER,
    "source_offset" TEXT,
    -- Why it is parked: NOT_CURRENT_OWNER or SOURCE_AHEAD, or the last failure.
    "reason" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "last_attempt_at" TIMESTAMPTZ(3),

    CONSTRAINT "insurance_pending_verification_pkey" PRIMARY KEY ("event_id"),
    CONSTRAINT "ck_insurance_pending_verification_attempts" CHECK ("attempts" >= 0)
);

-- Tenant-led, like every tenant table's indexes (ADR-011).
CREATE INDEX "insurance_pending_verification_organization_id_asset_id_idx"
    ON "insurance_pending_verification" ("organization_id", "asset_id");
-- The transfer's handler: every parked event of one machine, whichever tenant parked it.
CREATE INDEX "insurance_pending_verification_asset_id_idx"
    ON "insurance_pending_verification" ("asset_id");
-- The sweep: the oldest first.
CREATE INDEX "insurance_pending_verification_first_seen_at_idx"
    ON "insurance_pending_verification" ("first_seen_at");

COMMIT;
