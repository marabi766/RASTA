-- FU-188: these `timestamp(3)` columns are written from their DEFAULT by raw SQL (a raw INSERT
-- or a function of ours) or are deadlines. `CURRENT_TIMESTAMP` stores the SESSION's wall time
-- there, so a session outside UTC would write them off by its offset. Every other reader
-- takes them as UTC wall time. No rewrite, no row changes: only the default expression.
SET LOCAL lock_timeout = '3s';
ALTER TABLE "order" ALTER COLUMN "saga_start_next_attempt_at" SET DEFAULT timezone('UTC', now());
