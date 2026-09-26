-- Reverses 20260926120000_asset_transfer_fence (ADR-062).
--
-- Roll the code back first: the clearance endpoint, the work-start check and
-- the asset-sync consumer all read or write this table.
--
-- Dropping it loses only fences of transfers in flight. A transfer whose
-- fence disappears is either already committed (its ASSET_TRANSFERRED moves
-- the replica, which is what refuses the previous owner from then on) or will
-- be refused by the old code's own check; no business data lives here.
SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS "asset_transfer_fence";
