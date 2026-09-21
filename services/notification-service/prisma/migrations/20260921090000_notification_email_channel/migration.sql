-- NTF-004 — the email channel: the enum value, the templates it renders from,
-- the quiet window it respects, and the claim the sending worker fences on
-- (ADR-054 § 5, § 7, § 10).
--
-- ## Why the enum value arrives here and not earlier
--
-- `notification_channel` has held `IN_APP` alone since the service existed,
-- and the schema header says why: an enum value no code path can write is a
-- claim of a capability the platform does not have (docs/24 Q-07). This
-- migration ships with the worker that writes it. Applying it without that
-- code would re-open exactly the problem the restriction existed to prevent.
--
-- ## Quiet hours are their own table, and that is a deviation
--
-- ADR-054 § 5 draws `quietHoursStart`, `quietHoursEnd` and `timezone` as
-- columns on `notification_preference`. That table holds one row per scope per
-- channel, so the drawing allows one person to hold three different quiet
-- windows for the same channel — a RULE row, a CATEGORY row and a GLOBAL row —
-- with nothing in the document saying which one a delivery obeys. The
-- precedence ladder answers "may this channel deliver", not "when", and there
-- is no ladder for a time window.
--
-- A quiet window is a property of a person in a tenant, so it is keyed that
-- way here: one row per `(user, organization)`. Everything the ADR asks for is
-- still expressible, and the question its shape could not answer does not
-- arise. Recorded in the implementation plan § 5 as a named deviation.
--
-- ## What the rendered message does not leave behind
--
-- `notification_delivery.rendered_hash` is a SHA-256 of what was sent, never
-- the text (ADR § 10.4). This database is not a second copy of every message
-- the platform has mailed; the hash answers "was this the body we sent"
-- without keeping the body in order to answer it.

-- ---------------------------------------------------------------------------
-- 1. The channel itself
-- ---------------------------------------------------------------------------

-- PostgreSQL has allowed this inside a transaction since 12, but the new value
-- cannot be *used* in the same transaction. Nothing here uses it; the first
-- writer is the worker this migration ships with.
ALTER TYPE "notification_channel" ADD VALUE IF NOT EXISTS 'EMAIL';

-- ---------------------------------------------------------------------------
-- 2. Templates — seeded configuration with immutable published versions
-- ---------------------------------------------------------------------------

CREATE TABLE "notification_template" (
    "template_key" VARCHAR(128) NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_template_pkey" PRIMARY KEY ("template_key", "channel")
);

CREATE TABLE "notification_template_version" (
    "template_key" VARCHAR(128) NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "version" INTEGER NOT NULL,
    "locale" VARCHAR(16) NOT NULL,
    "subject_template" VARCHAR(500) NOT NULL,
    "body_template" TEXT NOT NULL,
    "required_variables" JSONB NOT NULL,
    -- SHA-256 over subject, body and the required-variable list. What makes
    -- "this published version was edited in place" detectable at boot rather
    -- than in somebody's inbox.
    "content_hash" VARCHAR(64) NOT NULL,
    "created_by" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_template_version_pkey"
      PRIMARY KEY ("template_key", "channel", "version", "locale")
);

ALTER TABLE "notification_template_version"
  ADD CONSTRAINT "fk_template_version_template"
  FOREIGN KEY ("template_key", "channel")
  REFERENCES "notification_template" ("template_key", "channel")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_template_version"
  ADD CONSTRAINT "ck_template_version_positive" CHECK ("version" >= 1);

-- `fa-IR`, `en-US` — the shape the renderer falls back within (ADR § 10.4).
ALTER TABLE "notification_template_version"
  ADD CONSTRAINT "ck_template_version_locale_shape"
  CHECK ("locale" ~ '^[a-z]{2}-[A-Z]{2}$');

-- A required-variable list has to be a list. A published version whose
-- `required_variables` was an object would make the strict renderer check
-- nothing, which is the one failure strict rendering exists to prevent.
ALTER TABLE "notification_template_version"
  ADD CONSTRAINT "ck_template_version_required_is_array"
  CHECK (jsonb_typeof("required_variables") = 'array');

ALTER TABLE "notification_template_version"
  ADD CONSTRAINT "ck_template_version_content_hash_shape"
  CHECK ("content_hash" ~ '^[0-9a-f]{64}$');

-- A published version is immutable: editing means publishing a new version
-- (ADR § 10.1). A delivery references `(template_key, version)`, so "exactly
-- what did we send them" has to survive the next edit of the template.
--
-- DELETE stays possible: the down migration drops the table, and a version
-- nothing was ever delivered under may be withdrawn. UPDATE does not, and the
-- refusal lives here rather than in a service because the seeder, the tests
-- and any future admin path all reach this table.
CREATE OR REPLACE FUNCTION notification_template_version_immutable()
RETURNS TRIGGER AS $trg$
BEGIN
    RAISE EXCEPTION
      'notification_template_version is append-only: publish a new version instead of editing % v% (%)',
      OLD."template_key", OLD."version", OLD."locale"
      USING ERRCODE = 'restrict_violation';
END;
$trg$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_template_version_immutable"
    BEFORE UPDATE ON "notification_template_version"
    FOR EACH ROW EXECUTE FUNCTION "notification_template_version_immutable"();

-- ---------------------------------------------------------------------------
-- 3. Quiet hours — defer, never drop (ADR § 5)
-- ---------------------------------------------------------------------------

CREATE TABLE "notification_quiet_hours" (
    "organization_id" VARCHAR(128) NOT NULL,
    "user_id" VARCHAR(128) NOT NULL,
    -- Minutes from local midnight rather than `time`: the comparison the
    -- worker makes is arithmetic on a wall clock in the recipient's own zone,
    -- and a `time` column invites comparing it against a UTC timestamp.
    "start_minute" SMALLINT NOT NULL,
    "end_minute" SMALLINT NOT NULL,
    -- The zone the window is read in. `Asia/Tehran` is the platform default
    -- and the recipient snapshot's default; a stored value overrides it.
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Tehran',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" VARCHAR(128) NOT NULL,

    CONSTRAINT "notification_quiet_hours_pkey" PRIMARY KEY ("user_id", "organization_id")
);

ALTER TABLE "notification_quiet_hours"
  ADD CONSTRAINT "ck_quiet_hours_minutes_in_day"
  CHECK ("start_minute" BETWEEN 0 AND 1439 AND "end_minute" BETWEEN 0 AND 1439);

-- Equal bounds are a window of either zero minutes or twenty-four hours
-- depending on which way the reader resolves it, and one of those two readings
-- silences a person permanently. Refused rather than interpreted.
ALTER TABLE "notification_quiet_hours"
  ADD CONSTRAINT "ck_quiet_hours_not_degenerate" CHECK ("start_minute" <> "end_minute");

CREATE INDEX "ix_quiet_hours_org" ON "notification_quiet_hours" ("organization_id");

-- ---------------------------------------------------------------------------
-- 4. What a sending channel needs on the delivery row
-- ---------------------------------------------------------------------------

-- For `IN_APP` the delivery is the insert, so there was nothing to claim. An
-- email delivery is queued now and sent later by a worker that may be one of
-- several replicas, so it needs the same durable claim as every other queue on
-- this platform (ADR-050). `claim_token` is the only fence; the owner is
-- diagnostic, and the expiry decides reclamation and nothing else.
ALTER TABLE "notification_delivery"
  ADD COLUMN "claim_token" VARCHAR(64),
  ADD COLUMN "claim_owner" VARCHAR(128),
  ADD COLUMN "claim_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "rendered_hash" VARCHAR(64);

ALTER TABLE "notification_delivery"
  ADD CONSTRAINT "ck_delivery_rendered_hash_shape"
  CHECK ("rendered_hash" IS NULL OR "rendered_hash" ~ '^[0-9a-f]{64}$');

-- The claim predicate, kept narrow: only rows a sender could take.
CREATE INDEX "ix_delivery_sendable"
    ON "notification_delivery" ("channel", "next_attempt_at")
 WHERE "status" IN ('QUEUED', 'SENDING');
