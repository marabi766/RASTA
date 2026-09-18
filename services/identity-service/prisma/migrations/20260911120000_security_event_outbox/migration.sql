-- ADR-053 § 4 — the refusal outbox (AUD-004 Phase C1).
--
-- A second, separate queue beside `outbox_message`, never a use of it. A `403`
-- happens before (or without) any domain transaction, so there is no state
-- change for a transactional-outbox row to share a commit with — and the
-- ordinary outbox's stream sequencing (ADR-051 B3) belongs to domain events
-- only. This table is written by the exception filter in its own short
-- transaction and drained by a second relay onto `rasta.audit.trail.v1`.
--
-- Bounded by construction. Every column is a fixed-size fact the audit contract
-- needs (`packages/contracts/src/events/audit-trail.ts`); there is no JSON
-- payload, no header blob and nowhere a request body, token or exception text
-- could be put. The column bounds match the `audit_event` columns they end up
-- in, so a row this table accepts is never refused downstream for its size.
--
-- Additive: nothing existing changes, and no code that predates it reads it.

SET LOCAL lock_timeout = '3s';

CREATE TABLE "security_event_outbox" (
    -- ULID. Becomes `envelope.eventId`, the audit consumer's idempotency key,
    -- so a redelivery of this row can never become a second audit record.
    "id"                VARCHAR(26)   NOT NULL,

    -- The tenant the refused request was acting for, from the verified token.
    -- NULL only for a caller acting for no organization (a platform record).
    "organization_id"   VARCHAR(128),

    "actor_type"        VARCHAR(16)   NOT NULL,
    "actor_id"          VARCHAR(256)  NOT NULL,
    "actor_roles"       TEXT[]        NOT NULL DEFAULT ARRAY[]::TEXT[],

    -- Fixed per refusal site in code (`refusal-sites.ts`), never from the URL
    -- or the body.
    "action"            VARCHAR(256)  NOT NULL,
    "resource_type"     VARCHAR(128)  NOT NULL,
    "resource_id"       VARCHAR(256),
    "error_code"        VARCHAR(64)   NOT NULL,
    "reason"            VARCHAR(1000),

    "source_ip"         VARCHAR(64),
    "source_user_agent" VARCHAR(512),
    "correlation_id"    VARCHAR(128)  NOT NULL,
    "traceparent"       VARCHAR(55),

    "producer_version"  VARCHAR(64)   NOT NULL,
    "occurred_at"       TIMESTAMP(3)  NOT NULL,
    "created_at"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Delivery state, with exactly the ADR-050 semantics `outbox_message` has:
    -- the token is the only fence, expiry only decides reclamation, and the
    -- retry is scheduled with the database clock.
    "published_at"      TIMESTAMP(3),
    "attempts"          INTEGER       NOT NULL DEFAULT 0,
    "last_error"        VARCHAR(1000),
    "claim_token"       TEXT,
    "claim_owner"       TEXT,
    "claim_expires_at"  TIMESTAMP(3),
    "claim_count"       INTEGER       NOT NULL DEFAULT 0,
    "next_attempt_at"   TIMESTAMP(3),

    CONSTRAINT "security_event_outbox_pkey" PRIMARY KEY ("id")
);

-- Delivery invariants — the same five `outbox_message` carries (ADR-050).
ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_claim_triple"
  CHECK (num_nonnulls("claim_token", "claim_owner", "claim_expires_at") IN (0, 3));

ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_claim_count_nonneg"
  CHECK ("claim_count" >= 0);

ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_attempts_nonneg"
  CHECK ("attempts" >= 0);

ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_published_is_clean"
  CHECK ("published_at" IS NULL
         OR ("claim_token" IS NULL AND "claim_owner" IS NULL
             AND "claim_expires_at" IS NULL AND "next_attempt_at" IS NULL));

ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_next_attempt_requires_failure"
  CHECK ("next_attempt_at" IS NULL OR ("published_at" IS NULL AND "attempts" >= 1));

-- Evidence invariants. A row that breaks one of these would be refused by the
-- audit contract at flush time and retried forever, so it is refused at write
-- time instead — where the refusal costs one counter increment and nothing else.
ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_actor_type"
  CHECK ("actor_type" IN ('USER', 'SERVICE', 'SYSTEM'));

ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_actor_id_not_blank"
  CHECK (length(btrim("actor_id")) > 0);

ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_organization_id_not_blank"
  CHECK ("organization_id" IS NULL OR length(btrim("organization_id")) > 0);

ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_resource_id_not_blank"
  CHECK ("resource_id" IS NULL OR length(btrim("resource_id")) > 0);

ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_correlation_id_not_blank"
  CHECK (length(btrim("correlation_id")) > 0);

ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_actor_roles_bounded"
  CHECK (cardinality("actor_roles") <= 64);

ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_action_dotted"
  CHECK ("action" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');

ALTER TABLE "security_event_outbox" ADD CONSTRAINT "ck_security_event_outbox_traceparent_format"
  CHECK ("traceparent" IS NULL OR "traceparent" ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');

-- The claim query's ordering and its two retry/lease eligibility columns, over
-- only the rows the flusher can ever return.
CREATE INDEX IF NOT EXISTS "ix_security_event_outbox_claimable"
    ON "security_event_outbox" ("created_at", "id")
 WHERE "published_at" IS NULL;

CREATE INDEX IF NOT EXISTS "ix_security_event_outbox_claim_expiry"
    ON "security_event_outbox" ("claim_expires_at")
 WHERE "published_at" IS NULL AND "claim_expires_at" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_security_event_outbox_next_attempt"
    ON "security_event_outbox" ("next_attempt_at")
 WHERE "published_at" IS NULL AND "next_attempt_at" IS NOT NULL;
