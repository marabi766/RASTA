-- Task 130 (PR #483 r1 R5) -- public registration's uniform intake.
--
-- Additive only: a new table, nothing existing is altered.
--
-- `POST /v1/registration-requests` needs no token. Task 117 made every valid
-- submission answer the same bytes, but the work behind the answer still
-- differed: a fresh identity inserted the user, the request and its outbox row
-- and committed, while a held username or email failed at the user's unique
-- index and rolled back -- measurably faster (21.8 ms against 13.5 ms locally),
-- so the time to the answer still said whether an account existed.
--
-- Now the request path writes one row here and commits, whoever the applicant
-- is: no lookup, no unique index on the applicant's username or email, nothing
-- the existence of an account can change. The registration worker
-- (`RegistrationIntakeWorker`) then decides privately, after the answer has
-- gone: it records the user, the request (under this row's id) and the
-- REGISTRATION_SUBMITTED event, or -- the username or the email already held,
-- which the users' unique indexes decide -- discards it. Either way it deletes
-- the row in the same transaction.
--
-- ## Retention
--
-- Only until the worker has handled it (seconds; `REGISTRATION_INTAKE_*`). A
-- submission that collided is not kept: the applicant's details are dropped
-- with the row. `submission` holds the validated request body; it is personal
-- data (username, email, name, phone) for that short time only.
--
-- ## Provenance (PR #483 r2 N1)
--
-- The event the worker writes is built after the request has ended, so the
-- request context it used to be built in is gone. The provenance that context
-- carried is stored here, beside the applicant's submission and apart from it:
-- `actor_type`/`actor_id` -- the verified principal of the submitting request
-- (a platform user, or a calling service), taken from the auth guard's
-- context, never from the body; both NULL for an anonymous submission -- and
-- `correlation_id`, the request's own. The worker passes them, explicitly, to
-- the event (`OutboxMessageInput.provenance`), so REGISTRATION_SUBMITTED is
-- attributed to the submitter and continues the submission's trail, as when it
-- was written in the request. No credential is stored: an id, not a token.
--
-- ## Retry
--
-- A row whose handling fails stays and waits out a backoff recorded in it
-- (`next_attempt_at`, doubling per attempt up to a cap); the worker reads only
-- rows that are due, so one failing submission never holds back the others.
CREATE TABLE "registration_intake" (
    "id" VARCHAR(64) NOT NULL,
    "submission" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" VARCHAR(16),
    "actor_id" VARCHAR(256),
    "correlation_id" VARCHAR(128) NOT NULL,

    CONSTRAINT "registration_intake_pkey" PRIMARY KEY ("id"),
    -- What `captureOutboxProvenance` can produce, and nothing else: a user or a
    -- service, both columns or neither, and a correlation id in the charset and
    -- bound a verified service may forward (`isServiceCorrelationId`). A CASE,
    -- not an OR: a NULL in one column would make an OR unknown, and a CHECK
    -- passes on unknown. (The id's bound is its VARCHAR(256); PostgreSQL's
    -- regular expressions cap a repetition count at 255.)
    CONSTRAINT "ck_registration_intake_actor" CHECK (
        CASE WHEN "actor_type" IS NULL THEN "actor_id" IS NULL
             ELSE "actor_type" IN ('USER', 'SERVICE')
                  AND "actor_id" IS NOT NULL
                  AND "actor_id" ~ '^[!-~]+$'
        END
    ),
    CONSTRAINT "ck_registration_intake_correlation" CHECK (
        "correlation_id" ~ '^[A-Za-z0-9_.:-]{1,128}$'
    )
);

-- The worker's read: due rows, oldest first.
CREATE INDEX "ix_registration_intake_due" ON "registration_intake" ("next_attempt_at", "id");
