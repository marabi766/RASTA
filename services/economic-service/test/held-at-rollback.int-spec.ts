import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { ownerDatabaseUrl } from './helpers';

/**
 * `20261106130000_transaction_funded_hold`'s `down.sql` never drops a `held_at` the next deploy
 * cannot put back (FU-182).
 *
 * The forward migration restamps only a row HELD then, or with a hold of its own. A row HELD in the
 * past with no hold, rolled back and rolled forward, reads as an obligation that never claimed
 * escrow and pays from the spendable balance (FU-164). So the rollback refuses while one exists.
 *
 * The real steps, in a scratch schema built by the real migrations as the database's owner and
 * dropped at the end: `migrate deploy`, and each whole `down.sql` through `prisma db execute`.
 */
const FUNDED_HOLD = '20261106130000_transaction_funded_hold';
const AT_COMMIT = '20261107120000_hold_funded_at_commit';
const SERVICE_DIR = join(__dirname, '..');
const REFUSAL =
  /2 row\(s\) were HELD and have no hold of their own: refusing to drop held_at, the only record that they claimed escrow/;

const PRISMA_CLI = (() => {
  const require = createRequire(join(SERVICE_DIR, 'package.json'));
  return join(require.resolve('prisma/package.json'), '..', 'build', 'index.js');
})();

/** The Prisma CLI, with the url in the child's environment, never in its argv (D-045). */
function prismaCli(argv: string[], options: { url: string; stdin?: string }) {
  const result = spawnSync(process.execPath, [PRISMA_CLI, ...argv], {
    cwd: SERVICE_DIR,
    env: { ...process.env, DATABASE_URL: options.url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    input: options.stdin,
    encoding: 'utf8',
  });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

const deploy = (url: string) =>
  prismaCli(['migrate', 'deploy', '--schema', 'prisma/schema.prisma'], { url });

/** A migration's whole `down.sql`, as the rollback runbook runs it. */
const down = (url: string, migration: string) =>
  prismaCli(['db', 'execute', '--schema', 'prisma/schema.prisma', '--stdin'], {
    url,
    stdin: readFileSync(join(SERVICE_DIR, 'prisma', 'migrations', migration, 'down.sql'), 'utf8'),
  });

describe(`${FUNDED_HOLD}: down never drops a held_at the next deploy cannot put back`, () => {
  jest.setTimeout(240_000);

  const schema = `held_at_rollback_${ulid().toLowerCase()}`;
  const ORG = 'ORG_HELD_AT_ROLLBACK';
  let owner: PrismaClient;
  let db: PrismaClient;
  let url: string;

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const scratch = new URL(ownerDatabaseUrl());
    scratch.searchParams.set('schema', schema);
    url = scratch.toString();
    const deployed = deploy(url);
    if (!deployed.ok) throw new Error(`migrate deploy failed:\n${deployed.output.slice(0, 1200)}`);
    db = new PrismaClient({ datasources: { db: { url } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
    // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; it names only the scratch schema this
    // suite created (`held_at_rollback_<ulid>`).
    await owner?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner?.$disconnect();
  });

  const hasHeldAt = async () =>
    (
      await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'transaction' AND column_name = 'held_at'`,
        schema,
      )
    )[0]!.n === 1n;

  const stamps = () =>
    db.$queryRawUnsafe<{ id: string; held_at: Date | null }[]>(
      `SELECT id, held_at FROM "transaction" WHERE organization_id = $1 ORDER BY id`,
      ORG,
    );

  const obligation = async (id: string, ...statuses: string[]) => {
    await db.$executeRawUnsafe(
      `INSERT INTO "transaction" ("id", "organization_id", "counterparty_organization_id", "transaction_type",
         "gross_amount_minor", "occurred_at", "correlation_id", "updated_at", "created_by")
       VALUES ($1, $2, 'ORG_HELD_AT_ROLLBACK_PAYEE', 'LOGISTICS', 1000, now(), 'COR-HELD-AT', now(), 'USR-HELD-AT')`,
      id,
      ORG,
    );
    for (const status of statuses) {
      await db.$executeRawUnsafe(
        `UPDATE "transaction" SET status = $2::"TransactionStatus" WHERE id = $1`,
        id,
        status,
      );
    }
  };

  it('with no row stamped, down and up again both run', async () => {
    for (const migration of [AT_COMMIT, FUNDED_HOLD]) {
      const result = down(url, migration);
      expect({ migration, ok: result.ok, output: result.ok ? '' : result.output }).toEqual({
        migration,
        ok: true,
        output: '',
      });
    }
    expect(await hasHeldAt()).toBe(false);
    expect(deploy(url).ok).toBe(true);
    expect(await hasHeldAt()).toBe(true);
  });

  it('a row HELD in the past, or HELD now, with no hold of its own: down refuses and changes nothing', async () => {
    await obligation('TXN_HELD_AT_PAST', 'HELD', 'PENDING_SETTLEMENT');
    await obligation('TXN_HELD_AT_NOW', 'HELD');
    await obligation('TXN_HELD_AT_OWN', 'HELD');
    await db.$executeRawUnsafe(
      `INSERT INTO "ledger_account" ("id", "organization_id", "account_type", "account_code", "purpose", "currency", "created_by")
       VALUES ('ACC_HELD_AT', $1, 'LIABILITY', 'HELD-AT-WALLET', 'WALLET', 'IRR', 'USR-HELD-AT')`,
      ORG,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "wallet" ("id", "organization_id", "currency", "ledger_account_id", "updated_at")
       VALUES ('WLT_HELD_AT', $1, 'IRR', 'ACC_HELD_AT', now())`,
      ORG,
    );
    // D-130's unproven kind, naming no journal: a hold of its own all the same.
    await db.$executeRawUnsafe(
      `INSERT INTO "wallet_hold" ("id", "organization_id", "wallet_id", "amount_minor", "currency", "reference",
         "reference_type", "placed_at", "placed_by")
       VALUES ('HLD_HELD_AT_OWN', $1, 'WLT_HELD_AT', 1000, 'IRR', 'TXN_HELD_AT_OWN', 'TRANSACTION', now(), 'USR-HELD-AT')`,
      ORG,
    );
    const before = await stamps();
    expect(before.map((row) => [row.id, row.held_at !== null])).toEqual([
      ['TXN_HELD_AT_NOW', true],
      ['TXN_HELD_AT_OWN', true],
      ['TXN_HELD_AT_PAST', true],
    ]);

    expect(down(url, AT_COMMIT).ok).toBe(true);
    const refused = down(url, FUNDED_HOLD);
    expect(refused.ok).toBe(false);
    expect(refused.output).toMatch(REFUSAL);
    expect(await hasHeldAt()).toBe(true);
    expect(await stamps()).toEqual(before);
    const [ledger] = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name = $1 AND rolled_back_at IS NULL`,
      FUNDED_HOLD,
    );
    expect(ledger!.n).toBe(1n);
  });

  it('once only a row with a hold of its own is stamped, down runs and up stamps it again', async () => {
    // An operator accepting the loss for the other two (in the suite: the stamp lifted).
    await db.$transaction([
      db.$executeRawUnsafe(`ALTER TABLE "transaction" DISABLE TRIGGER "trg_transaction_held_at"`),
      db.$executeRawUnsafe(
        `UPDATE "transaction" SET held_at = NULL WHERE id IN ('TXN_HELD_AT_PAST', 'TXN_HELD_AT_NOW')`,
      ),
      db.$executeRawUnsafe(`ALTER TABLE "transaction" ENABLE TRIGGER "trg_transaction_held_at"`),
    ]);
    const result = down(url, FUNDED_HOLD);
    expect(result.ok ? '' : result.output).toBe('');
    expect(await hasHeldAt()).toBe(false);

    expect(deploy(url).ok).toBe(true);
    expect((await stamps()).map((row) => [row.id, row.held_at !== null])).toEqual([
      ['TXN_HELD_AT_NOW', true],
      ['TXN_HELD_AT_OWN', true],
      // What the refusal exists for: moved on, with no hold, it reads as never having claimed escrow.
      ['TXN_HELD_AT_PAST', false],
    ]);
  });
});
