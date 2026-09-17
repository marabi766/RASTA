-- =============================================================================
-- notification-service — initial schema (ADR-054, NTF-001)
--
-- The first real migration of this service. Everything Prisma can express is
-- in the first half and matches `schema.prisma` exactly; everything it cannot
-- — CHECK constraints, partial indexes, the append-only trigger and the
-- deferrable foreign key — is in the second half and is asserted by
-- `scripts/verify-migration-reversible.mjs notification` on every up → down → up.
--
-- Nothing here is business logic (AGENTS.md § 3). The constraints encode the
-- invariants ADR-054 § 4 states for a delivery row, so the database refuses a
-- row the state machine could never legitimately produce.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE "notification_severity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

CREATE TYPE "notification_classification" AS ENUM ('ROUTINE', 'MANDATORY');

CREATE TYPE "intent_status" AS ENUM ('PENDING', 'RESOLVED', 'DISPATCHED', 'SUPPRESSED', 'DISCARDED');

CREATE TYPE "resolution_source" AS ENUM ('IDENTITY_API', 'EVENT_PAYLOAD', 'CONFIGURED_ROLE');

-- IN_APP only. NTF-004 adds EMAIL with the adapter that can write it.
CREATE TYPE "notification_channel" AS ENUM ('IN_APP');

CREATE TYPE "delivery_status" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'DEAD', 'SUPPRESSED');

CREATE TYPE "attempt_outcome" AS ENUM ('SUCCESS', 'TRANSIENT_FAILURE', 'PERMANENT_FAILURE');

-- ---------------------------------------------------------------------------
-- processed_event — consumer idempotency, layer 1 (A-09)
-- ---------------------------------------------------------------------------

CREATE TABLE "processed_event" (
    "event_id" VARCHAR(64) NOT NULL,
    "consumer_name" VARCHAR(128) NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_event_pkey" PRIMARY KEY ("event_id","consumer_name")
);

-- ---------------------------------------------------------------------------
-- notification_intent
-- ---------------------------------------------------------------------------

CREATE TABLE "notification_intent" (
    "id" VARCHAR(64) NOT NULL,
    "organization_id" VARCHAR(128) NOT NULL,
    "source_event_id" VARCHAR(64) NOT NULL,
    "source_event_name" VARCHAR(128) NOT NULL,
    "source_topic" VARCHAR(128) NOT NULL,
    "source_partition_key" VARCHAR(256) NOT NULL,
    "source_stream_seq" BIGINT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "correlation_id" VARCHAR(128) NOT NULL,
    "causation_id" VARCHAR(128),
    "rule_key" VARCHAR(128) NOT NULL,
    "template_key" VARCHAR(128) NOT NULL,
    "severity" "notification_severity" NOT NULL,
    "classification" "notification_classification" NOT NULL,
    "subject_type" VARCHAR(64) NOT NULL,
    "subject_id" VARCHAR(128) NOT NULL,
    "dedupe_key" VARCHAR(64) NOT NULL,
    "context_data" JSONB NOT NULL,
    "status" "intent_status" NOT NULL DEFAULT 'PENDING',
    "resolution_attempts" INTEGER NOT NULL DEFAULT 0,
    "next_resolution_at" TIMESTAMPTZ(6),
    "last_resolution_error" VARCHAR(64),
    "claim_token" VARCHAR(64),
    "claim_owner" VARCHAR(128),
    "claim_expires_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "dispatched_at" TIMESTAMPTZ(6),
    "terminal_reason" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_intent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_intent_source_event" ON "notification_intent"("source_event_id");

CREATE INDEX "ix_intent_org_status_next" ON "notification_intent"("organization_id", "status", "next_resolution_at");

CREATE INDEX "ix_intent_org_dedupe" ON "notification_intent"("organization_id", "dedupe_key");

CREATE INDEX "ix_intent_stream_subject" ON "notification_intent"("organization_id", "source_topic", "source_partition_key", "subject_id");

-- ---------------------------------------------------------------------------
-- notification_dedupe — layer 2
-- ---------------------------------------------------------------------------

CREATE TABLE "notification_dedupe" (
    "dedupe_key" VARCHAR(64) NOT NULL,
    "organization_id" VARCHAR(128) NOT NULL,
    "intent_id" VARCHAR(64) NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seen_count" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_dedupe_pkey" PRIMARY KEY ("dedupe_key")
);

CREATE INDEX "ix_dedupe_org_expiry" ON "notification_dedupe"("organization_id", "expires_at");

-- ---------------------------------------------------------------------------
-- recipient_resolution
-- ---------------------------------------------------------------------------

CREATE TABLE "recipient_resolution" (
    "id" VARCHAR(64) NOT NULL,
    "intent_id" VARCHAR(64) NOT NULL,
    "organization_id" VARCHAR(128) NOT NULL,
    "user_id" VARCHAR(128) NOT NULL,
    "resolved_role" VARCHAR(64),
    "email_snapshot" VARCHAR(320),
    "locale_snapshot" VARCHAR(16) NOT NULL DEFAULT 'fa-IR',
    "timezone_snapshot" VARCHAR(64) NOT NULL DEFAULT 'Asia/Tehran',
    "resolved_at" TIMESTAMPTZ(6) NOT NULL,
    "resolution_source" "resolution_source" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipient_resolution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_resolution_intent_user" ON "recipient_resolution"("intent_id", "user_id");

CREATE INDEX "ix_resolution_org_user" ON "recipient_resolution"("organization_id", "user_id");

-- ---------------------------------------------------------------------------
-- notification_delivery
-- ---------------------------------------------------------------------------

CREATE TABLE "notification_delivery" (
    "id" VARCHAR(64) NOT NULL,
    "intent_id" VARCHAR(64) NOT NULL,
    "organization_id" VARCHAR(128) NOT NULL,
    "user_id" VARCHAR(128) NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "status" "delivery_status" NOT NULL DEFAULT 'QUEUED',
    "template_key" VARCHAR(128) NOT NULL,
    "template_version" INTEGER NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(6),
    "scheduled_for" TIMESTAMPTZ(6),
    "suppression_reason" VARCHAR(64),
    "last_error_class" VARCHAR(64),
    "sent_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_delivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_delivery_intent_user_channel" ON "notification_delivery"("intent_id", "user_id", "channel");

CREATE INDEX "ix_delivery_org_user" ON "notification_delivery"("organization_id", "user_id");

CREATE INDEX "ix_delivery_channel_status_next" ON "notification_delivery"("channel", "status", "next_attempt_at");

-- ---------------------------------------------------------------------------
-- delivery_attempt
-- ---------------------------------------------------------------------------

CREATE TABLE "delivery_attempt" (
    "id" VARCHAR(64) NOT NULL,
    "delivery_id" VARCHAR(64) NOT NULL,
    "organization_id" VARCHAR(128) NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "outcome" "attempt_outcome" NOT NULL,
    "error_class" VARCHAR(64),
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_attempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_attempt_delivery_no" ON "delivery_attempt"("delivery_id", "attempt_no");

-- ---------------------------------------------------------------------------
-- in_app_notification
-- ---------------------------------------------------------------------------

CREATE TABLE "in_app_notification" (
    "id" VARCHAR(64) NOT NULL,
    "delivery_id" VARCHAR(64) NOT NULL,
    "intent_id" VARCHAR(64) NOT NULL,
    "organization_id" VARCHAR(128) NOT NULL,
    "user_id" VARCHAR(128) NOT NULL,
    "rule_key" VARCHAR(128) NOT NULL,
    "severity" "notification_severity" NOT NULL,
    "classification" "notification_classification" NOT NULL,
    "subject_type" VARCHAR(64) NOT NULL,
    "subject_id" VARCHAR(128) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "action_path" VARCHAR(512),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "dismissed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "in_app_notification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_in_app_delivery" ON "in_app_notification"("delivery_id");

CREATE INDEX "ix_in_app_owner_created" ON "in_app_notification"("organization_id", "user_id", "created_at" DESC);

CREATE INDEX "ix_in_app_org_expiry" ON "in_app_notification"("organization_id", "expires_at");

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE "recipient_resolution" ADD CONSTRAINT "recipient_resolution_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "notification_intent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "notification_intent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "delivery_attempt" ADD CONSTRAINT "delivery_attempt_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "notification_delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "in_app_notification" ADD CONSTRAINT "in_app_notification_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "notification_delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "in_app_notification" ADD CONSTRAINT "in_app_notification_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "notification_intent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- Hand-written: what Prisma cannot express
-- =============================================================================

-- ---------------------------------------------------------------------------
-- notification_dedupe → notification_intent, deferred.
--
-- The consumer decides "fresh window or repeat" with one INSERT … ON CONFLICT
-- on this table, naming the intent id it is *about* to write. With an
-- immediate foreign key that statement would fail before the intent exists;
-- deferring the check to commit lets the decision come first and the intent
-- row follow only when the decision was "fresh". A repeat leaves `intent_id`
-- pointing at the window's original intent, which still exists, so the
-- deferred check passes either way.
-- ---------------------------------------------------------------------------

ALTER TABLE "notification_dedupe"
  ADD CONSTRAINT "notification_dedupe_intent_id_fkey"
  FOREIGN KEY ("intent_id") REFERENCES "notification_intent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Intent invariants
-- ---------------------------------------------------------------------------

-- A terminal-by-decision intent says why; every other status says nothing.
ALTER TABLE "notification_intent"
  ADD CONSTRAINT "ck_intent_terminal_reason"
  CHECK (
    ("status" IN ('SUPPRESSED', 'DISCARDED') AND "terminal_reason" IS NOT NULL)
    OR ("status" NOT IN ('SUPPRESSED', 'DISCARDED') AND "terminal_reason" IS NULL)
  );

-- A dispatched intent was resolved, and both timestamps are present.
ALTER TABLE "notification_intent"
  ADD CONSTRAINT "ck_intent_dispatched_is_resolved"
  CHECK ("status" <> 'DISPATCHED' OR ("resolved_at" IS NOT NULL AND "dispatched_at" IS NOT NULL));

-- The ADR-050 claim triple is held whole or not at all.
ALTER TABLE "notification_intent"
  ADD CONSTRAINT "ck_intent_claim_triple"
  CHECK (
    ("claim_token" IS NULL AND "claim_owner" IS NULL AND "claim_expires_at" IS NULL)
    OR ("claim_token" IS NOT NULL AND "claim_owner" IS NOT NULL AND "claim_expires_at" IS NOT NULL)
  );

-- Only a pending intent can be claimed, and only a pending intent waits.
ALTER TABLE "notification_intent"
  ADD CONSTRAINT "ck_intent_claim_only_when_pending"
  CHECK ("status" = 'PENDING' OR ("claim_token" IS NULL AND "next_resolution_at" IS NULL));

ALTER TABLE "notification_intent"
  ADD CONSTRAINT "ck_intent_attempts_nonneg"
  CHECK ("resolution_attempts" >= 0);

ALTER TABLE "notification_intent"
  ADD CONSTRAINT "ck_intent_dedupe_key_is_sha256"
  CHECK ("dedupe_key" ~ '^[0-9a-f]{64}$');

-- The claim worker's scan: pending rows in due order, nothing else.
CREATE INDEX "ix_intent_claimable"
  ON "notification_intent" ("next_resolution_at")
  WHERE "status" = 'PENDING';

-- ---------------------------------------------------------------------------
-- Dedupe invariants
-- ---------------------------------------------------------------------------

ALTER TABLE "notification_dedupe"
  ADD CONSTRAINT "ck_dedupe_seen_count_positive"
  CHECK ("seen_count" >= 1);

ALTER TABLE "notification_dedupe"
  ADD CONSTRAINT "ck_dedupe_window_ordered"
  CHECK ("first_seen_at" <= "last_seen_at" AND "first_seen_at" < "expires_at");

-- ---------------------------------------------------------------------------
-- Delivery invariants (ADR-054 § 4)
-- ---------------------------------------------------------------------------

-- 2. SUPPRESSED carries a reason and zero attempts; nothing else carries a reason.
ALTER TABLE "notification_delivery"
  ADD CONSTRAINT "ck_delivery_suppressed_shape"
  CHECK (
    ("status" = 'SUPPRESSED' AND "suppression_reason" IS NOT NULL AND "attempt_count" = 0)
    OR ("status" <> 'SUPPRESSED' AND "suppression_reason" IS NULL)
  );

-- 1. SENT and DELIVERED name the moment they were sent.
ALTER TABLE "notification_delivery"
  ADD CONSTRAINT "ck_delivery_sent_has_timestamp"
  CHECK ("status" NOT IN ('SENT', 'DELIVERED') OR "sent_at" IS NOT NULL);

-- 3. DEAD only after the attempts were really spent.
ALTER TABLE "notification_delivery"
  ADD CONSTRAINT "ck_delivery_dead_exhausted"
  CHECK ("status" <> 'DEAD' OR "attempt_count" >= "max_attempts");

ALTER TABLE "notification_delivery"
  ADD CONSTRAINT "ck_delivery_attempts_bounded"
  CHECK ("attempt_count" >= 0 AND "max_attempts" >= 1 AND "attempt_count" <= "max_attempts");

-- A retry is scheduled only for a delivery that is still open.
ALTER TABLE "notification_delivery"
  ADD CONSTRAINT "ck_delivery_next_attempt_only_when_open"
  CHECK ("next_attempt_at" IS NULL OR "status" IN ('QUEUED', 'SENDING'));

ALTER TABLE "delivery_attempt"
  ADD CONSTRAINT "ck_attempt_no_positive"
  CHECK ("attempt_no" >= 1);

ALTER TABLE "delivery_attempt"
  ADD CONSTRAINT "ck_attempt_ordered"
  CHECK ("started_at" <= "finished_at");

-- A successful attempt has no error class; a failed one names its class.
ALTER TABLE "delivery_attempt"
  ADD CONSTRAINT "ck_attempt_error_class_shape"
  CHECK (
    ("outcome" = 'SUCCESS' AND "error_class" IS NULL)
    OR ("outcome" <> 'SUCCESS' AND "error_class" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- delivery_attempt is append-only.
--
-- An attempt is a record of what happened at a moment; editing one afterwards
-- would make the delivery history say something other than what occurred.
-- DELETE is not refused, because the retention sweep (NTF-005) must be able
-- to remove an expired delivery together with its attempts.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION refuse_attempt_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'delivery_attempt is append-only; % is refused', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "delivery_attempt_append_only"
  BEFORE UPDATE ON "delivery_attempt"
  FOR EACH ROW EXECUTE FUNCTION refuse_attempt_update();

-- ---------------------------------------------------------------------------
-- In-app invariants (ADR-054 § 4, § 10)
-- ---------------------------------------------------------------------------

-- Dismiss means read. A dismissed-but-unread row would inflate the badge
-- counter forever.
ALTER TABLE "in_app_notification"
  ADD CONSTRAINT "ck_in_app_dismiss_implies_read"
  CHECK ("dismissed_at" IS NULL OR "read_at" IS NOT NULL);

-- A deep link is a relative path the web app resolves against its own origin.
-- An absolute URL, a scheme-relative `//host` or a `javascript:` value stored
-- here would be an open redirect with a delivery mechanism attached (§ 10).
ALTER TABLE "in_app_notification"
  ADD CONSTRAINT "ck_in_app_action_path_relative"
  CHECK ("action_path" IS NULL OR ("action_path" ~ '^/' AND "action_path" !~ '^//'));

ALTER TABLE "in_app_notification"
  ADD CONSTRAINT "ck_in_app_text_not_blank"
  CHECK (length(btrim("title")) > 0 AND length(btrim("body")) > 0);

ALTER TABLE "in_app_notification"
  ADD CONSTRAINT "ck_in_app_expires_after_created"
  CHECK ("expires_at" > "created_at");

-- The unread badge and list: rows that are neither read nor dismissed.
CREATE INDEX "ix_in_app_unread"
  ON "in_app_notification" ("organization_id", "user_id", "created_at" DESC)
  WHERE "read_at" IS NULL AND "dismissed_at" IS NULL;
