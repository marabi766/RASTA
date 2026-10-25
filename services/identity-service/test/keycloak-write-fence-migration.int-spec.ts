import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { withUtcSession } from '@rasta/config';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';

/**
 * D-069 — the fence migration's rollback never silently drops an outstanding
 * fence (#402 r2 addendum F). `down.sql` locks the table before it checks, and
 * refuses while any row is there: each one is a Keycloak write that may still
 * land, or a terminal account an operator has not looked at.
 *
 * In an isolated schema, as the owner, through the supported file runner
 * (`scripts/verify-migration-reversible-lib.mjs`, the one CI's reversibility
 * check uses): every migration up; a fence row; down refused, nothing
 * dropped; the row gone; down succeeds; up again.
 */
const MIGRATION = '20261024120000_keycloak_write_attempt';

function ownerUrl(): string {
  const url = process.env.DATABASE_URL_IDENTITY_MIGRATOR;
  if (!url) {
    throw new Error(
      'DATABASE_URL_IDENTITY_MIGRATOR is not set. The isolated schema is created as the owner, ' +
        'never the runtime role; see .env.migrator.example (docs/23 D-045).',
    );
  }
  return withUtcSession(url);
}

/** Runs one migration file as CI's reversibility check does; the URL stays out of argv. */
function apply(schema: string, file: string): { ok: boolean; output: string } {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import { psqlFileRunner } from './scripts/verify-migration-reversible-lib.mjs';
      const result = psqlFileRunner(process.env.IDENTITY_TEST_OWNER_URL, process.argv[1])(process.argv[2]);
      process.stdout.write(result.output);
      process.exit(result.ok ? 0 : 1);
    `,
      schema,
      file,
    ],
    {
      encoding: 'utf8',
      cwd: join(__dirname, '..', '..', '..'),
      env: { ...process.env, IDENTITY_TEST_OWNER_URL: ownerUrl() },
    },
  );
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('the fence migration refuses to roll back over outstanding fences (D-069)', () => {
  const schema = `fence_rollback_${ulid().toLowerCase()}`;
  const migrations = join(__dirname, '..', 'prisma', 'migrations');
  const owner = new PrismaClient({ datasources: { db: { url: ownerUrl() } } });
  const scoped = new URL(ownerUrl());
  scoped.searchParams.set('schema', schema);
  const scratch = new PrismaClient({ datasources: { db: { url: scoped.toString() } } });

  const catalog = async () => {
    const [row] = await scratch.$queryRaw<Array<{ fence: bigint; columns: bigint }>>`
      SELECT
        (SELECT count(*) FROM information_schema.tables
          WHERE table_schema = ${schema} AND table_name = 'keycloak_write_attempt') AS fence,
        (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = ${schema} AND table_name = 'membership'
            AND column_name IN ('lapse_failures', 'lapse_retry_at')) AS columns`;
    return { fence: Number(row!.fence), columns: Number(row!.columns) };
  };

  /** Every migration up, as a deployment applies them: `prisma migrate deploy`, as the owner. */
  function deploy(): void {
    const result = spawnSync(
      join(__dirname, '..', 'node_modules', '.bin', 'prisma'),
      ['migrate', 'deploy'],
      {
        encoding: 'utf8',
        cwd: join(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: scoped.toString() },
      },
    );
    if (result.status !== 0) throw new Error(`migrate deploy: ${result.stdout}${result.stderr}`);
  }

  beforeAll(async () => {
    await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    deploy();
  });

  afterAll(async () => {
    await scratch.$disconnect();
    await owner.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner.$disconnect();
  });

  it('has no foreign key and no trigger, so a fence insert takes no lock on the user row', async () => {
    const [row] = await scratch.$queryRaw<Array<{ fks: bigint; triggers: bigint }>>`
      SELECT
        (SELECT count(*) FROM information_schema.table_constraints
          WHERE table_schema = ${schema} AND table_name = 'keycloak_write_attempt'
            AND constraint_type = 'FOREIGN KEY') AS fks,
        (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${schema} AND c.relname = 'keycloak_write_attempt'
            AND NOT t.tgisinternal) AS triggers`;
    expect({ fks: Number(row!.fks), triggers: Number(row!.triggers) }).toEqual({
      fks: 0,
      triggers: 0,
    });
  });

  it('down is refused while a fence is outstanding, and drops nothing; once none is, it reverses and up re-applies', async () => {
    await scratch.$executeRawUnsafe(`
      INSERT INTO keycloak_write_attempt
             (attempt_id, user_id, keycloak_id, operation,
              started_at, deadline_at, takeover_at, next_reassert_at)
      VALUES ('KWA_MIGRATION', 'USR_MIGRATION', 'kc-migration', 'replace_attributes',
              now(), now() + interval '10 seconds', now() + interval '130 seconds',
              now() + interval '130 seconds')`);

    const refused = apply(schema, join(migrations, MIGRATION, 'down.sql'));
    expect(refused.ok).toBe(false);
    expect(refused.output).toMatch(/outstanding Keycloak write fences; rollback refused/);
    expect(await catalog()).toEqual({ fence: 1, columns: 2 });
    expect(await scratch.$queryRaw`SELECT attempt_id FROM keycloak_write_attempt`).toEqual([
      { attempt_id: 'KWA_MIGRATION' },
    ]);
    expect(
      await scratch.$queryRaw`SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = ${MIGRATION}`,
    ).toHaveLength(1);

    // A terminal fence is outstanding too: an account an operator has not seen to.
    await scratch.$executeRawUnsafe(
      `UPDATE keycloak_write_attempt SET account_missing_at = now(),
              deadline_at = started_at, takeover_at = started_at`,
    );
    expect(apply(schema, join(migrations, MIGRATION, 'down.sql')).ok).toBe(false);

    await scratch.$executeRawUnsafe('DELETE FROM keycloak_write_attempt');
    const reversed = apply(schema, join(migrations, MIGRATION, 'down.sql'));
    expect(reversed).toMatchObject({ ok: true });
    expect(await catalog()).toEqual({ fence: 0, columns: 0 });
    expect(
      await scratch.$queryRaw`SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = ${MIGRATION}`,
    ).toHaveLength(0);

    deploy();
    expect(await catalog()).toEqual({ fence: 1, columns: 2 });
  });
});
