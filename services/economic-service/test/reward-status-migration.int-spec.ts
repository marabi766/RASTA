import { eligibilityClockSql } from '@rasta/testing';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ulid } from 'ulid';
import { ownerDatabaseUrl } from './helpers';

describe('reward status migration on populated historical data', () => {
  it('backfills evidence, refuses to discard it, preserves legacy keys, and runs down/up with no history', () => {
    const schema = `reward_history_${ulid().toLowerCase()}`;
    // Run the shared ESM transport outside Jest, like the other migration
    // fixtures: passwords stay in libpq's environment, never process argv.
    const invoke = (input: string | undefined, file = '') =>
      spawnSync(
        process.execPath,
        [
          '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
          '--input-type=module',
          '-e',
          `
          import { readFileSync } from 'node:fs';
          import { spawnSync } from 'node:child_process';
          import { libpqInvocation } from './scripts/verify-migration-reversible-lib.mjs';
          const url = new URL(process.env.REWARD_MIGRATION_TEST_OWNER_URL);
          url.searchParams.set('options', '-c timezone=UTC -c search_path=' + process.argv[1]);
          const { target, env } = libpqInvocation(url.toString());
          const file = process.argv[2];
          const result = spawnSync('psql', [target, '-X', '-q', '-v', 'ON_ERROR_STOP=1',
            ...(file ? ['-f', file] : [])], {
              input: file ? undefined : readFileSync(0, 'utf8'),
              env: { ...process.env, ...env }, encoding: 'utf8',
            });
          process.stdout.write(result.stdout ?? '');
          process.stderr.write(result.stderr ?? result.error?.code ?? '');
          process.exit(result.status ?? 1);
        `,
          schema,
          file,
        ],
        {
          input,
          encoding: 'utf8',
          cwd: join(__dirname, '..', '..', '..'),
          env: { ...process.env, REWARD_MIGRATION_TEST_OWNER_URL: ownerDatabaseUrl() },
        },
      );
    const psql = (input: string) => invoke(input);
    const dir = join(__dirname, '../prisma/migrations/20261101193000_reward_engine_correctness');
    const apply = (file: string) => invoke(undefined, join(dir, file));
    const succeeds = (result: ReturnType<typeof psql>) =>
      expect({ status: result.status, error: result.stderr }).toEqual({ status: 0, error: '' });
    try {
      succeeds(psql(`CREATE SCHEMA ${schema};`));
      // ISOLATION-ALLOW-UNBOUNDED: every object belongs to this run's unique scratch schema via PGOPTIONS.
      succeeds(
        psql(eligibilityClockSql`
        CREATE TABLE "_prisma_migrations" (migration_name TEXT);
        INSERT INTO "_prisma_migrations" VALUES ('20261101193000_reward_engine_correctness');
        CREATE TYPE "RuleStatus" AS ENUM ('ACTIVE', 'INACTIVE');
        CREATE TABLE reward_rule (id TEXT PRIMARY KEY, status "RuleStatus", valid_from TIMESTAMP(3), created_at TIMESTAMP(3), updated_at TIMESTAMP(3));
        CREATE TABLE reward (organization_id TEXT, user_id TEXT, rule_id TEXT, trigger_event TEXT, source_reference TEXT, period_key TEXT, granted_at TIMESTAMP(3));
        CREATE TABLE reward_source_evaluation (organization_id TEXT, trigger_event TEXT, source_reference TEXT, occurred_at TIMESTAMP(3));
        INSERT INTO reward_rule VALUES
          ('active', 'ACTIVE', '2020-01-01', '2020-02-01', '2020-02-01'),
          ('inactive', 'INACTIVE', '2020-01-01', '2020-02-01', '2020-03-01'),
          ('future', 'ACTIVE', '2030-01-01', '2026-01-01', '2026-01-01');
        INSERT INTO reward VALUES ('A', 'U', 'active', 'USAGE_RECORDED', 'known', '2027-W53', '2030-01-01'),
                                  ('A', 'U', 'active', 'USAGE_RECORDED', 'unknown', '2018-W01', '2030-01-01');
        INSERT INTO reward_source_evaluation VALUES ('A', 'USAGE_RECORDED', 'known', '2026-12-31');
      `),
      );
      succeeds(apply('migration.sql'));
      // ISOLATION-ALLOW-UNBOUNDED: the refused TRUNCATE is confined to the scratch history fixture.
      succeeds(
        psql(`
        DO $$ BEGIN
          IF (SELECT count(*) FROM reward_rule_status_history) <> 4 THEN RAISE EXCEPTION 'status backfill count'; END IF;
          IF NOT EXISTS (SELECT FROM reward_rule_status_history WHERE rule_id = 'inactive' AND status = 'INACTIVE' AND effective_at = '2020-03-01') THEN RAISE EXCEPTION 'inactive evidence'; END IF;
          IF NOT EXISTS (SELECT FROM reward_rule_status_history WHERE rule_id = 'active' AND status = 'ACTIVE' AND effective_at = '2020-01-01') THEN RAISE EXCEPTION 'active evidence'; END IF;
          IF NOT EXISTS (SELECT FROM reward_rule_status_history WHERE rule_id = 'future' AND effective_at = '2026-01-01') THEN RAISE EXCEPTION 'future start evidence'; END IF;
          IF NOT EXISTS (SELECT FROM reward WHERE source_reference = 'known' AND occurred_at = '2026-12-31' AND period_key = '2027-W53') THEN RAISE EXCEPTION 'known occurrence'; END IF;
          IF NOT EXISTS (SELECT FROM reward WHERE source_reference = 'unknown' AND occurred_at IS NULL AND period_key = '2018-W01') THEN RAISE EXCEPTION 'unknown occurrence'; END IF;
          BEGIN
            TRUNCATE reward_rule_status_history;
            RAISE EXCEPTION 'truncate unexpectedly allowed';
          EXCEPTION WHEN restrict_violation THEN NULL;
          END;
        END $$;
      `),
      );
      const refused = apply('down.sql');
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('refusing rollback');
      // ISOLATION-ALLOW-UNBOUNDED: owner-only removal of this run's scratch fixture; production history stays immutable.
      succeeds(
        psql(`
        DO $$ BEGIN
          IF (SELECT count(*) FROM reward_rule_status_history) <> 4 THEN RAISE EXCEPTION 'refusal lost evidence'; END IF;
          IF NOT EXISTS (SELECT FROM "_prisma_migrations" WHERE migration_name = '20261101193000_reward_engine_correctness') THEN RAISE EXCEPTION 'refusal changed migration record'; END IF;
        END $$;
        ALTER TABLE reward_rule_status_history DISABLE TRIGGER trg_reward_rule_status_append_only;
        DELETE FROM reward_rule_status_history;
        ALTER TABLE reward_rule_status_history ENABLE TRIGGER trg_reward_rule_status_append_only;
      `),
      );
      succeeds(apply('down.sql'));
      succeeds(
        psql(`
        DO $$ BEGIN
          IF to_regclass('reward_rule_status_history') IS NOT NULL THEN RAISE EXCEPTION 'down left history'; END IF;
          IF EXISTS (SELECT FROM "_prisma_migrations" WHERE migration_name = '20261101193000_reward_engine_correctness') THEN RAISE EXCEPTION 'down left migration record'; END IF;
          IF (SELECT count(*) FROM reward) <> 2 THEN RAISE EXCEPTION 'down changed old grants'; END IF;
        END $$;
      `),
      );
      succeeds(apply('migration.sql'));
      succeeds(
        psql(
          `DO $$ BEGIN IF (SELECT count(*) FROM reward_rule_status_history) <> 4 THEN RAISE EXCEPTION 'second up'; END IF; END $$;`,
        ),
      );
    } finally {
      // ISOLATION-ALLOW-UNBOUNDED: only this run's ULID-named scratch schema is removed.
      expect(psql(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`).status).toBe(0);
    }
  });
});
