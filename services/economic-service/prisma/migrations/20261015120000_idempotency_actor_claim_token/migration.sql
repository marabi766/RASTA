-- Whose an idempotency record is, and which reservation may complete it
-- (review of #287, findings 1 and 2; docs/23 D-054).
--
-- `actor_hash`: SHA-256 of the actor who reserved the key (a person's verified
-- issuer and subject, or the calling service). The same key from another actor
-- is 409 IDEMPOTENCY_KEY_REUSED, never a replay of someone else's answer.
--
-- `claim_token`: a random token per reservation. Completing, recording a
-- refusal and releasing all require it, so a request whose claim expired and
-- was replaced can no longer complete — or delete — the replacement.
--
-- Populated databases: two nullable columns with no default — a catalogue
-- change under a brief ACCESS EXCLUSIVE lock, no rewrite, every existing row
-- valid with NULLs. A record written before this has no actor: it is replayed
-- only through the endpoint's replay guard, and only until it expires (24 h).
-- It has no token either, so this code never completes or releases it; it
-- belongs to a request the previous release is still running.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "idempotency_key"
  ADD COLUMN IF NOT EXISTS "actor_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "claim_token" TEXT;
