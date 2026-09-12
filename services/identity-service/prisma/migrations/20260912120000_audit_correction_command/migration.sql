-- AUD-003 correction -- idempotency for the audit correction command (ADR-053 § 7).
--
-- Additive only: a new table, nothing existing is altered.
--
-- ## Why not `idempotency_key`
--
-- That table is keyed `(organization_id, endpoint, key)` with a NOT NULL tenant,
-- because every endpoint it was designed for acts inside one organization. The
-- correction command does not: it is a SYSTEM_ADMIN command that may target a
-- genuinely platform-scoped record, which has no organization at all. Storing it
-- there would need a magic tenant value standing in for "none" -- and any such
-- value is a string a real organization id could one day equal. So the command
-- gets its own table, keyed by the verified actor and the key they chose.
--
-- ## Why the actor is part of the key
--
-- An `Idempotency-Key` is caller-chosen. Keying by the key alone would let one
-- administrator's key replay -- or block -- another administrator's command.
--
-- ## What is stored
--
-- A SHA-256 of the normalised request (never the request), the target id, the
-- event id of the one outbox row the command produced, and the accepted
-- response a retry replays. The row is written in the same transaction as that
-- outbox row, so the two exist together or not at all.
--
-- ## Retention
--
-- None, deliberately. A correction is permanent and irreversible, so its replay
-- protection is kept as long as the evidence it produced; the table grows by one
-- row per correction, which is bounded by the number of corrections a
-- SYSTEM_ADMIN issues.
CREATE TABLE "audit_correction_command" (
    "actor_id" VARCHAR(256) NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "target_id" VARCHAR(64) NOT NULL,
    "event_id" VARCHAR(26) NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_correction_command_pkey" PRIMARY KEY ("actor_id", "idempotency_key")
);
