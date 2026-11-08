import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { ownerDatabaseUrl } from './helpers';

/**
 * `20261108120000_wallet_account_covered_at_commit` on a ledger already in use (FU-228). CI's
 * database is empty when it migrates, so the rows are written first here: an account already below
 * zero makes the deploy refuse and change nothing, and nothing is corrected for the operator.
 *
 * The real steps, in a scratch schema built by the real migrations as the database's owner and
 * dropped at the end: `migrate deploy`, `migrate resolve`, and the whole `down.sql`.
 */
const COVERED = '20261108120000_wallet_account_covered_at_commit';
const SERVICE_DIR = join(__dirname, '..');
const REFUSAL =
  /1 WALLET or ESCROW account\(s\) already sum below zero; refusing to guard a ledger that is already overdrawn, and changing nothing/;

const PRISMA_CLI = (() => {
  const require = createRequire(join(SERVICE_DIR, 'package.json'));
  return join(require.resolve('prisma/package.json'), '..', 'build', 'index.js');
})();

/** The Prisma CLI, with the url in the child's environment, never in its argv (D-045). */
function prismaCli(argv: string[], options: { url: string; stdin?: string }) {
  const result = spawnSync(
    process.execPath,
    [PRISMA_CLI, ...argv, '--schema', 'prisma/schema.prisma'],
    {
      cwd: SERVICE_DIR,
      env: { ...process.env, DATABASE_URL: options.url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      input: options.stdin,
      encoding: 'utf8',
    },
  );
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

describe(`${COVERED}: on a ledger in use`, () => {
  jest.setTimeout(240_000);

  const schema = `wallet_covered_rollout_${ulid().toLowerCase()}`;
  const ORG = 'ORG_WALLET_COVERED_ROLLOUT';
  let owner: PrismaClient;
  let db: PrismaClient;
  let url: string;

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const scratch = new URL(ownerDatabaseUrl());
    scratch.searchParams.set('schema', schema);
    url = scratch.toString();
    const deployed = prismaCli(['migrate', 'deploy'], { url });
    if (!deployed.ok) throw new Error(`migrate deploy failed:\n${deployed.output.slice(0, 1200)}`);
    db = new PrismaClient({ datasources: { db: { url } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
    // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; it names only the scratch schema this
    // suite created (`wallet_covered_rollout_<ulid>`).
    await owner?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner?.$disconnect();
  });

  const guarded = async () =>
    (
      await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace s ON s.oid = c.relnamespace
         WHERE s.nspname = $1 AND t.tgname = 'trg_ledger_entry_wallet_covered'`,
        schema,
      )
    )[0]!.n === 1n;

  const ledger = () =>
    db.$queryRawUnsafe<{ account_id: string; legs: bigint; balance: bigint }[]>(
      `SELECT account_id, count(*) AS legs,
              SUM(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END)::bigint AS balance
         FROM ledger_entry GROUP BY account_id ORDER BY account_id`,
    );

  /** One balanced journal: `from` debited, `to` credited, written while the guard is down. */
  const post = (from: string, to: string, amount: number) =>
    db.$transaction(async (tx) => {
      const journalId = `JRN_${ulid()}`;
      await tx.$executeRawUnsafe(
        `INSERT INTO journal (id, organization_id, journal_type, description, posted_at, posted_by, correlation_id)
         VALUES ($1, $2, 'REWARD_GRANT', 'written by the suite', now(), 'itest', 'itest')`,
        journalId,
        ORG,
      );
      for (const [accountId, direction] of [
        [from, 'DEBIT'],
        [to, 'CREDIT'],
      ]) {
        await tx.$executeRawUnsafe(
          `INSERT INTO ledger_entry (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
           VALUES ($1, $2, $3, $4, $5::"EntryDirection", $6, 'IRR', now())`,
          `LGE_${ulid()}`,
          journalId,
          accountId,
          ORG,
          direction,
          amount,
        );
      }
    });

  it('with no leg below zero, down and up again both run', async () => {
    const result = prismaCli(['db', 'execute', '--stdin'], {
      url,
      stdin: readFileSync(join(SERVICE_DIR, 'prisma', 'migrations', COVERED, 'down.sql'), 'utf8'),
    });
    expect(result.ok ? '' : result.output).toBe('');
    expect(await guarded()).toBe(false);
    expect(prismaCli(['migrate', 'deploy'], { url }).ok).toBe(true);
    expect(await guarded()).toBe(true);
  });

  it('an account already below zero: the deploy refuses, writes nothing, corrects nothing', async () => {
    const down = prismaCli(['db', 'execute', '--stdin'], {
      url,
      stdin: readFileSync(join(SERVICE_DIR, 'prisma', 'migrations', COVERED, 'down.sql'), 'utf8'),
    });
    expect(down.ok ? '' : down.output).toBe('');
    await db.$executeRawUnsafe(
      `INSERT INTO ledger_account (id, organization_id, account_type, account_code, purpose, currency, created_by)
       VALUES ('ACC_ROLLOUT_WALLET', $1, 'LIABILITY', 'ROLLOUT-WALLET', 'WALLET', 'IRR', 'itest'),
              ('ACC_ROLLOUT_ESCROW', $1, 'LIABILITY', 'ROLLOUT-ESCROW', 'ESCROW', 'IRR', 'itest'),
              ('ACC_ROLLOUT_EXPENSE', $1, 'EXPENSE', 'ROLLOUT-EXPENSE', 'REWARD_EXPENSE', 'IRR', 'itest')`,
      ORG,
    );
    // Used, and covered: escrow in and out again. Then the wallet: 1000 in, 1500 out.
    await post('ACC_ROLLOUT_EXPENSE', 'ACC_ROLLOUT_ESCROW', 300);
    await post('ACC_ROLLOUT_ESCROW', 'ACC_ROLLOUT_EXPENSE', 300);
    await post('ACC_ROLLOUT_EXPENSE', 'ACC_ROLLOUT_WALLET', 1000);
    await post('ACC_ROLLOUT_WALLET', 'ACC_ROLLOUT_EXPENSE', 1500);
    const before = await ledger();
    expect(before.find((row) => row.account_id === 'ACC_ROLLOUT_WALLET')?.balance).toBe(-500n);

    const refused = prismaCli(['migrate', 'deploy'], { url });
    expect(refused.ok).toBe(false);
    expect(refused.output).toMatch(REFUSAL);
    expect(await guarded()).toBe(false);
    expect(await ledger()).toEqual(before);
    const [failed] = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "_prisma_migrations"
        WHERE migration_name = $1 AND finished_at IS NULL AND rolled_back_at IS NULL`,
      COVERED,
    );
    expect(failed!.n).toBe(1n);

    // The operator's correction, a journal, and the runbook the refusal names.
    await post('ACC_ROLLOUT_EXPENSE', 'ACC_ROLLOUT_WALLET', 500);
    expect(prismaCli(['migrate', 'resolve', '--rolled-back', COVERED], { url }).ok).toBe(true);
    const deployed = prismaCli(['migrate', 'deploy'], { url });
    expect(deployed.ok ? '' : deployed.output).toBe('');
    expect(await guarded()).toBe(true);
  });
});
