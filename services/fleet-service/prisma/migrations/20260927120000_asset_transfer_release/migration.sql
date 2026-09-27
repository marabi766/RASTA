-- Releases of transfers that did not happen (ADR-062, review #127 round 2).
--
-- asset-service releases a transfer's fence when the transfer fails, and a
-- release can arrive before the clearance it answers has taken the per-asset
-- lock: the handler may still be resolving an older fence or waiting for a
-- connection. Without a record of the release, that clearance would then
-- place a fence for a transfer that no longer exists. The release writes one
-- row here, under the same exclusive lock; a clearance that finds its own
-- transfer here refuses and fences nothing.
--
-- Rows hold ids only and are kept at least an hour (the longest fence life),
-- removed by expiry when the same machine is next released. A new, empty
-- table: nothing existing is read or rewritten.
SET LOCAL lock_timeout = '3s';

CREATE TABLE "asset_transfer_release" (
    "asset_id" TEXT NOT NULL,
    "fence_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "released_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "asset_transfer_release_pkey" PRIMARY KEY ("asset_id", "fence_id")
);
