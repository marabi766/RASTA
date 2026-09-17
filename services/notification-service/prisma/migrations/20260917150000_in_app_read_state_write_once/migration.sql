-- =============================================================================
-- NTF-002 — the read state of an in-app notification is write-once.
--
-- ADR-054 § 4: "there is no un-read transition — the platform would be making
-- a claim about a human's attention that it cannot know", and dismissing is
-- not deleting. `read_at` and `dismissed_at` are therefore the durable record
-- of *when this user acted*, and a record is only a record if it cannot be
-- rewritten. The service already never does; this trigger makes that a
-- property of the row rather than of the code that happens to write it.
--
-- Refused: clearing either timestamp once set, and moving one that is set.
-- Allowed: setting a null one, and every other column. DELETE is untouched so
-- the retention sweep (NTF-005) can remove expired rows.
--
-- No business logic here (AGENTS.md § 3): the rule is "a fact, once recorded,
-- stays recorded", which is the same rule the append-only trigger on
-- delivery_attempt enforces one table over.
-- =============================================================================

CREATE OR REPLACE FUNCTION refuse_in_app_state_regression() RETURNS trigger AS $$
BEGIN
  IF OLD."read_at" IS NOT NULL
     AND (NEW."read_at" IS NULL OR NEW."read_at" <> OLD."read_at") THEN
    RAISE EXCEPTION 'in_app_notification.read_at is write-once; % is refused', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."dismissed_at" IS NOT NULL
     AND (NEW."dismissed_at" IS NULL OR NEW."dismissed_at" <> OLD."dismissed_at") THEN
    RAISE EXCEPTION 'in_app_notification.dismissed_at is write-once; % is refused', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "in_app_notification_state_write_once"
  BEFORE UPDATE ON "in_app_notification"
  FOR EACH ROW EXECUTE FUNCTION refuse_in_app_state_regression();
