-- A transfer in progress on one machine (ADR-062).
--
-- One row per machine at most. Written by the internal transfer-clearance
-- endpoint under the per-asset lock, read by every path that starts new work
-- on the machine under the same lock, and removed when the transfer lands
-- (asset-sync consumer), when it does not happen (asset-service), or when it
-- expires. Holds ids only.
--
-- A new, empty table. Nothing existing is read or rewritten, so there is no
-- backfill: rows appear only when a transfer is attempted after this deploy.
SET LOCAL lock_timeout = '3s';

CREATE TABLE "asset_transfer_fence" (
    "asset_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "fence_id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "asset_transfer_fence_pkey" PRIMARY KEY ("asset_id")
);
