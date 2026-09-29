-- Where in each producer's stream an asset's status was last set by an event (D-039).
--
-- fleet-service and maintenance-service events move an asset's status
-- (ASSET_ASSIGNED, MAINTENANCE_STARTED, …). `<topic>` and `<topic>.retry` are
-- separate streams, so a replayed event can arrive after a newer one; without a
-- stored position the replay would move the status back. One row per asset,
-- created on the first such event: `{ "<producer>": { seq, streamKey, at,
-- eventId } }`. A new, empty table: nothing existing is read or rewritten.
SET LOCAL lock_timeout = '3s';

CREATE TABLE "asset_event_position" (
    "asset_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "positions" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_event_position_pkey" PRIMARY KEY ("asset_id")
);
