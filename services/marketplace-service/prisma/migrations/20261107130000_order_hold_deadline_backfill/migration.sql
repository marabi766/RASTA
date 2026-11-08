-- =============================================================================
-- marketplace-service: the audit trail of the legacy hold-deadline backfill (FU-234).
--
-- An order from before the fence (20261107120000_order_hold_fence) counts one send with no
-- deadline, so every send it makes now is refused (D-150) and its saga waits for good.
-- `src/ops/hold-deadline-backfill.ts`, run by an operator, gives such a row a deadline;
-- `order_hold_deadline_backfill` is what it gave, written in the same statement as the
-- deadline, and `order_hold_deadline_revocation` is a deadline taken back
-- (`prisma/ops/hold-deadline-revoke.sql`, run by an operator as the migrator).
--
-- Append-only (AGENTS.md S-06; as `ck_return_history_append_only`): no role changes, erases
-- or truncates a row, and an order with a record cannot be deleted (RESTRICT). Each row says
-- who (`operator`, `ticket`, given and checked; `db_role`, the session's login role), what,
-- when and from where (`client_addr`, as the database saw the connection). The database
-- stamps `db_role` and `client_addr`: they are not the writer's to choose.
--
-- New tables: nothing existing is rewritten. The runtime role's DML comes from the
-- schema's default privileges (D-045); the triggers refuse its UPDATE and DELETE.
-- =============================================================================
SET LOCAL lock_timeout = '3s';

CREATE TABLE "order_hold_deadline_backfill" (
    "organization_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "hold_not_after" TIMESTAMPTZ(3) NOT NULL,
    "run_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "hold_send_claims" INTEGER NOT NULL,
    "economic_rule_since" TIMESTAMPTZ(3) NOT NULL,
    "operator" TEXT NOT NULL,
    "ticket" TEXT NOT NULL,
    "db_role" TEXT NOT NULL,
    "client_addr" TEXT NOT NULL,

    -- A deadline given once: a rerun finds the row fenced, and one taken back and given
    -- again is a new deadline, so a new row.
    CONSTRAINT "order_hold_deadline_backfill_pkey"
      PRIMARY KEY ("organization_id", "order_id", "hold_not_after"),
    CONSTRAINT "ck_order_hold_deadline_backfill_actor" CHECK (
      "operator" ~ '^[A-Za-z0-9][A-Za-z0-9._@:#/-]{0,127}$'
      AND "ticket" ~ '^[A-Za-z0-9][A-Za-z0-9._@:#/-]{0,127}$'
    )
);

ALTER TABLE "order_hold_deadline_backfill" ADD CONSTRAINT "fk_order_hold_deadline_backfill_tenant"
  FOREIGN KEY ("organization_id", "order_id") REFERENCES "order"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "order_hold_deadline_revocation" (
    "organization_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "hold_not_after" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by" TEXT NOT NULL,
    "ticket" TEXT NOT NULL,
    "db_role" TEXT NOT NULL,
    "client_addr" TEXT NOT NULL,

    -- Takes back one given deadline, once.
    CONSTRAINT "order_hold_deadline_revocation_pkey"
      PRIMARY KEY ("organization_id", "order_id", "hold_not_after"),
    CONSTRAINT "ck_order_hold_deadline_revocation_actor" CHECK (
      "revoked_by" ~ '^[A-Za-z0-9][A-Za-z0-9._@:#/-]{0,127}$'
      AND "ticket" ~ '^[A-Za-z0-9][A-Za-z0-9._@:#/-]{0,127}$'
    )
);

ALTER TABLE "order_hold_deadline_revocation" ADD CONSTRAINT "fk_order_hold_deadline_revocation_assignment"
  FOREIGN KEY ("organization_id", "order_id", "hold_not_after")
  REFERENCES "order_hold_deadline_backfill"("organization_id", "order_id", "hold_not_after")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "order_hold_deadline_audit_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A record states what its order now has: the deadline given, or, taken back, none. So
    -- no role records a deadline the order does not carry, nor one taken back that it still does.
    IF TG_TABLE_NAME = 'order_hold_deadline_backfill' THEN
      PERFORM 1 FROM "order" WHERE "organization_id" = NEW."organization_id"
        AND "id" = NEW."order_id" AND "hold_not_after" = NEW."hold_not_after";
    ELSE
      PERFORM 1 FROM "order" WHERE "organization_id" = NEW."organization_id"
        AND "id" = NEW."order_id" AND "hold_not_after" IS NULL;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ck_order_hold_deadline_audit_matches_order: a record states the deadline its order has, or no longer has'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW."db_role" := session_user;
    NEW."client_addr" := coalesce(host(inet_client_addr()), 'local');
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ck_order_hold_deadline_audit_append_only: a hold deadline''s record is never changed or erased (% on % refused)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tg_order_hold_deadline_backfill_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "order_hold_deadline_backfill"
  FOR EACH ROW EXECUTE FUNCTION "order_hold_deadline_audit_guard"();

CREATE TRIGGER "tg_order_hold_deadline_backfill_no_truncate"
  BEFORE TRUNCATE ON "order_hold_deadline_backfill"
  FOR EACH STATEMENT EXECUTE FUNCTION "order_hold_deadline_audit_guard"();

CREATE TRIGGER "tg_order_hold_deadline_revocation_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "order_hold_deadline_revocation"
  FOR EACH ROW EXECUTE FUNCTION "order_hold_deadline_audit_guard"();

CREATE TRIGGER "tg_order_hold_deadline_revocation_no_truncate"
  BEFORE TRUNCATE ON "order_hold_deadline_revocation"
  FOR EACH STATEMENT EXECUTE FUNCTION "order_hold_deadline_audit_guard"();
