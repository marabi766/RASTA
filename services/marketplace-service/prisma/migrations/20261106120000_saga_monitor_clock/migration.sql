-- =============================================================================
-- saga_monitor_clock: the reference time the saga's unresolved-money gauges age
-- against (#792 r1 F2). One row, moved only forward: every reader sets it to
-- GREATEST(itself, clock_timestamp()) and ages from what it holds. A database
-- clock set back cannot make an episode younger, so an overdue one stays overdue
-- until it is resolved. A clock run forward and then corrected leaves this ahead:
-- ages read high (alerts early, never late) until the real clock catches up.
--
-- Platform plumbing: no tenant, no identifier, one timestamp. Not a Prisma
-- model; `SagaStartStore` reads and writes it in raw SQL. The runtime role's DML
-- comes from the schema's default privileges (D-045), as for every other table.
-- =============================================================================
SET LOCAL lock_timeout = '3s';

CREATE TABLE "saga_monitor_clock" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "high_water" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saga_monitor_clock_pkey" PRIMARY KEY ("id"),
    -- One reference for every replica: a second row would be a second clock.
    CONSTRAINT "ck_saga_monitor_clock_single_row" CHECK ("id" = 1)
);

-- The row a missing table entry would otherwise leave to chance: a reader that
-- finds no row fails its sample (the gauges are withdrawn) rather than ageing
-- against a clock it cannot keep.
INSERT INTO "saga_monitor_clock" ("id") VALUES (1);
