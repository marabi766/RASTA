-- =============================================================================
-- construction-service — the replay deadline of an idempotency record (PM decision D-065)
--
-- A caller that sends `Idempotency-Replay-Deadline` says until when its request may still be executed under
-- its key. The FIRST claim stores the effective deadline here (the caller's, clamped to the record's own
-- expiry less the fence budget B — `shared/idempotency.ts`); a later claim of the same key past it is refused
-- (`REPLAY_WINDOW_CLOSED`) instead of finding the key expired and running the request again.
--
-- Nullable: a record written before this migration, or for a request that sent no deadline, has none and
-- behaves exactly as it did (an expired key is reused). The constraint ties the deadline to the record's own
-- expiry: a deadline past it would promise a key the service no longer keeps.
-- =============================================================================

ALTER TABLE "idempotency_key" ADD COLUMN "replay_deadline_at" TIMESTAMP(3);

ALTER TABLE "idempotency_key" ADD CONSTRAINT "ck_idempotency_replay_deadline_within_expiry"
  CHECK ("replay_deadline_at" IS NULL OR "replay_deadline_at" <= "expires_at");
