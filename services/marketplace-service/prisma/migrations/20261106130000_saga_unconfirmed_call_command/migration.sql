-- =============================================================================
-- saga_unconfirmed_call.command: which scheduled command owns the record (#836 r1
-- R1). The generation named the latest database opening, so an older command's
-- attempt that opened late took the row and closed it with an answer of its own
-- (a step record's cached one included): a newer command's unanswered call went
-- silent. The row now names its command (the saga step key) and when Temporal
-- scheduled it; an opening by an older command is refused before it calls, and
-- only the owner's own opening confirms (`OrderRepository.openSagaCall`).
--
-- Both NULL on a row opened before this release: no command is known to own it,
-- so the first command to open it takes it, as every opening did before.
-- Adding nullable columns without a default rewrites nothing; the CHECK reads
-- every row once under the table's lock, bounded by lock_timeout.
-- =============================================================================
SET LOCAL lock_timeout = '3s';

ALTER TABLE "saga_unconfirmed_call"
  ADD COLUMN "command" TEXT,
  ADD COLUMN "command_scheduled_at" TIMESTAMPTZ(3);

-- A command without its scheduling cannot be ordered against another one.
ALTER TABLE "saga_unconfirmed_call" ADD CONSTRAINT "ck_saga_unconfirmed_call_command_whole"
  CHECK (("command" IS NULL) = ("command_scheduled_at" IS NULL)
    AND ("command" IS NULL OR length(btrim("command")) > 0));
