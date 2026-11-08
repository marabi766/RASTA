-- D-080: preserve applicability independently of purgeable outbox history.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE reward ADD COLUMN occurred_at TIMESTAMP(3);
-- Only owner-confirmed occurrence evidence; never substitute delivery time.
UPDATE reward r SET occurred_at = e.occurred_at
  FROM reward_source_evaluation e
 WHERE e.organization_id = r.organization_id
   AND e.trigger_event = r.trigger_event
   AND e.source_reference = r.source_reference
   AND e.occurred_at IS NOT NULL;
CREATE INDEX reward_organization_id_user_id_rule_id_occurred_at_idx
  ON reward (organization_id, user_id, rule_id, occurred_at);

CREATE TABLE reward_rule_status_history (
  id BIGSERIAL PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES reward_rule(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  status "RuleStatus" NOT NULL,
  effective_at TIMESTAMP(3) NOT NULL
);
CREATE INDEX reward_rule_status_history_rule_id_effective_at_id_idx
  ON reward_rule_status_history (rule_id, effective_at, id);

-- Best available evidence, not a reconstruction of purged transitions:
-- historically ACTIVE from validFrom (or createdAt if earlier), currently
-- INACTIVE from last update. Future validFrom still gates applicability.
INSERT INTO reward_rule_status_history (rule_id, status, effective_at)
  SELECT id, 'ACTIVE', LEAST(valid_from, created_at) FROM reward_rule;
INSERT INTO reward_rule_status_history (rule_id, status, effective_at)
  SELECT id, 'INACTIVE', updated_at FROM reward_rule WHERE status = 'INACTIVE';

CREATE FUNCTION reject_reward_rule_status_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'reward_rule_status_history is append-only'
    USING ERRCODE = 'restrict_violation';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_reward_rule_status_append_only
  BEFORE UPDATE OR DELETE ON reward_rule_status_history
  FOR EACH ROW EXECUTE FUNCTION reject_reward_rule_status_mutation();
CREATE TRIGGER trg_reward_rule_status_no_truncate
  BEFORE TRUNCATE ON reward_rule_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION reject_reward_rule_status_mutation();
COMMIT;
