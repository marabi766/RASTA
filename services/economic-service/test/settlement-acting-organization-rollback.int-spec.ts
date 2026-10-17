import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import request from 'supertest';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id, ownerDatabaseUrl } from './helpers';

/**
 * `20261016120000_settlement_acting_organization` once the feature it serves has
 * been used (docs/23 D-054; review of #314 r1, F2).
 *
 * The approved rollback is the **application's**: the previous release is
 * deployed and the additive `acting_organization_id` column stays. `down.sql`
 * refuses while any settlement was made for an organization other than its
 * payer, because for those rows the column is the only record of whom the
 * system administrator acted for. This holds the two halves of that to real
 * data:
 *
 *   - the refusal, with its message, changing nothing — over a crossing
 *     settlement the API itself made, and over the whole file run as an
 *     operator runs it;
 *   - the previous release, column present: its `migrate deploy` has nothing to
 *     do, and its own Prisma client — generated from the schema without the
 *     field — reads every settlement and writes new ones.
 *
 * The scratch schemas are built by the real migrations as the database's owner
 * and dropped at the end. That the file is the exact inverse of the migration
 * on a database without such rows is `verify-migration-reversible.mjs economic`
 * and the last test below.
 */

const MIGRATION = '20261016120000_settlement_acting_organization';
const SERVICE_DIR = join(__dirname, '..');
const MIGRATIONS = join(SERVICE_DIR, 'prisma', 'migrations');
const DOWN = join(MIGRATIONS, MIGRATION, 'down.sql');
const REFUSAL =
  /settlement holds (\d+) row\(s\) made for an organization other than the payer; refusing to drop acting_organization_id/;

const PRISMA_CLI = (() => {
  const require = createRequire(join(SERVICE_DIR, 'package.json'));
  return join(require.resolve('prisma/package.json'), '..', 'build', 'index.js');
})();

/**
 * The Prisma CLI, with the url in the child's environment — never `--url`,
 * where its password would sit in the process's argv (D-045 follow-up).
 */
function prismaCli(argv: string[], options: { url: string; stdin?: string }) {
  const result = spawnSync(process.execPath, [PRISMA_CLI, ...argv], {
    cwd: SERVICE_DIR,
    env: { ...process.env, DATABASE_URL: options.url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    input: options.stdin,
    encoding: 'utf8',
  });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

function mustRun(argv: string[], options: { url: string; stdin?: string }): string {
  const result = prismaCli(argv, options);
  if (!result.ok) throw new Error(`prisma ${argv[0]} failed:\n${result.output.slice(0, 1200)}`);
  return result.output;
}

const runDown = (url: string) =>
  prismaCli(['db', 'execute', '--schema', 'prisma/schema.prisma', '--stdin'], {
    url,
    stdin: readFileSync(DOWN, 'utf8'),
  });

describe(`${MIGRATION} after a cross-tenant settlement`, () => {
  jest.setTimeout(240_000);

  describe('over the settlement the API made', () => {
    let harness: ApiHarness;
    let owner: PrismaClient;
    const acting = apiTenant('ROLLBACK-A');
    const payer = apiTenant('ROLLBACK-B');
    const payee = apiTenant('ROLLBACK-C');

    beforeAll(async () => {
      harness = await startApi();
      owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    });

    afterAll(async () => {
      await owner?.$disconnect();
      await cleanup(harness.prisma, [acting, payer, payee]);
      await harness.close();
    });

    it('the preflight refuses with its message, inside the lock, and leaves the column and the row', async () => {
      const http = harness.app.getHttpServer() as Server;
      const asPayer = `Bearer ${admin(payer)}`;
      const post = (path: string, token: string, body?: object) =>
        request(http)
          .post(path)
          .set('authorization', token)
          .set('idempotency-key', id('rollback'))
          .send(body ?? {});

      const wallet = await request(http)
        .get('/v1/wallets/me')
        .set('authorization', asPayer)
        .expect(200);
      await post(`/v1/wallets/${wallet.body.id as string}/top-up`, asPayer, {
        amountMinor: '100000',
      }).expect(201);
      await request(http)
        .get('/v1/wallets/me')
        .set('authorization', `Bearer ${admin(payee)}`)
        .expect(200);
      const created = await post('/v1/transactions', asPayer, {
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '9000',
        currency: 'IRR',
        holdFunds: true,
      }).expect(201);
      const transactionId = created.body.id as string;
      await post(`/v1/transactions/${transactionId}/authorise-settlement`, asPayer).expect(200);
      const settled = await post(
        '/v1/settlements',
        `Bearer ${admin(acting, ['SYSTEM_ADMIN'], 'platform')}`,
        { transactionId },
      ).expect(201);

      // The file's own check — its LOCK TABLE and its count — in a transaction
      // that is rolled back whatever happens: never the drop, on a database
      // other suites share.
      const check = /DO \$\$[\s\S]*?\$\$;/.exec(readFileSync(DOWN, 'utf8'))?.[0];
      expect(check).toContain('LOCK TABLE "settlement" IN ACCESS EXCLUSIVE MODE');
      const refused = owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(check!.replace(/;$/, ''));
      });
      await expect(refused).rejects.toThrow(REFUSAL);

      const [row] = await owner.$queryRawUnsafe<{ acting: string | null }[]>(
        'SELECT "acting_organization_id" AS acting FROM "settlement" WHERE "id" = $1',
        settled.body.settlementId,
      );
      expect(row).toEqual({ acting });
    });
  });

  describe('in a scratch schema, the whole file and the previous release', () => {
    const schemas: string[] = [];
    const clients: PrismaClient[] = [];
    // Under this package, not the system's temp directory: `prisma generate`
    // finds its project — this package.json and its @prisma/client — by
    // walking up from the schema.
    const cache = join(SERVICE_DIR, 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    const work = mkdtempSync(join(cache, 'settlement-rollback-'));
    let owner: PrismaClient;

    const urlOf = (schema: string) => {
      const url = new URL(ownerDatabaseUrl());
      url.searchParams.set('schema', schema);
      return url.toString();
    };

    /** A schema holding every migration of this release, as `migrate deploy` leaves it. */
    async function scratch(): Promise<{ url: string; db: PrismaClient }> {
      const schema = `rollback_${ulid().toLowerCase()}`;
      schemas.push(schema);
      await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      const url = urlOf(schema);
      mustRun(['migrate', 'deploy', '--schema', 'prisma/schema.prisma'], { url });
      const db = new PrismaClient({ datasources: { db: { url } } });
      clients.push(db);
      return { url, db };
    }

    const A = 'ORG_ROLLBACK_A';
    const B = 'ORG_ROLLBACK_B';
    const C = 'ORG_ROLLBACK_C';

    /** A settlement of B to C, as this release records it; `acting` is whom for. */
    async function settle(db: PrismaClient, suffix: string, acting: string | null) {
      await db.transaction.create({
        data: {
          id: `TXN_${suffix}`,
          organizationId: B,
          counterpartyOrganizationId: C,
          transactionType: 'MARKETPLACE_ORDER',
          grossAmountMinor: 9000n,
          occurredAt: new Date(),
          correlationId: `COR_${suffix}`,
          createdBy: 'USR_ROLLBACK',
        },
      });
      await db.settlement.create({
        data: {
          id: `STL_${suffix}`,
          organizationId: B,
          transactionId: `TXN_${suffix}`,
          journalId: `JRN_${suffix}`,
          payerOrganizationId: B,
          payeeOrganizationId: C,
          grossAmountMinor: 9000n,
          commissionAmountMinor: 0n,
          netAmountMinor: 9000n,
          currency: 'IRR',
          settledAt: new Date(),
          settledBy: 'USR_ROLLBACK',
          actingOrganizationId: acting,
        },
      });
    }

    /** What `down.sql` could change: the column, the ledger row, each settlement's acting org. */
    async function shape(db: PrismaClient) {
      const columns = await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'settlement'
            AND column_name = 'acting_organization_id'`,
      );
      const ledger = await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "_prisma_migrations" WHERE "migration_name" = $1`,
        MIGRATION,
      );
      const column = Number(columns[0]!.n) === 1;
      const rows = column
        ? await db.$queryRawUnsafe<{ id: string; acting: string | null }[]>(
            `SELECT "id", "acting_organization_id" AS acting FROM "settlement" ORDER BY "id"`,
          )
        : await db.$queryRawUnsafe<{ id: string }[]>(`SELECT "id" FROM "settlement" ORDER BY "id"`);
      return { column, applied: Number(ledger[0]!.n) === 1, rows };
    }

    /**
     * The previous release's `prisma/` directory: this schema without the field
     * (and its comment), every migration but this one — and its own client,
     * generated from that schema.
     */
    function previousRelease() {
      const current = readFileSync(join(SERVICE_DIR, 'prisma', 'schema.prisma'), 'utf8');
      const field =
        /\n {2}\/\/\/ The organization the settler acted for:[^\n]*\n(?: {2}\/\/\/[^\n]*\n)*? {2}actingOrganizationId String\? @map\("acting_organization_id"\)\n/;
      expect(field.test(current)).toBe(true);
      const clientDir = join(work, 'client');
      const previous = current
        .replace(field, '\n')
        .replace('output   = "../src/generated/prisma"', `output   = ${JSON.stringify(clientDir)}`);
      expect(previous).not.toMatch(/acting_organization_id|actingOrganizationId/);
      expect(previous).toContain(`output   = ${JSON.stringify(clientDir)}`);

      const dir = join(work, 'prisma');
      cpSync(MIGRATIONS, join(dir, 'migrations'), { recursive: true });
      rmSync(join(dir, 'migrations', MIGRATION), { recursive: true });
      writeFileSync(join(dir, 'schema.prisma'), previous);
      return { schema: join(dir, 'schema.prisma'), clientDir };
    }

    beforeAll(() => {
      owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    });

    afterAll(async () => {
      for (const client of clients) await client.$disconnect();
      for (const schema of schemas) {
        // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; it names only a
        // scratch schema this suite created (`rollback_<ulid>`).
        await owner?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      await owner?.$disconnect();
      rmSync(work, { recursive: true, force: true });
    });

    it('refuses, naming the rows, and changes nothing; the previous release deploys and runs with the column present', async () => {
      const { url, db } = await scratch();
      await settle(db, 'CROSSED', A); // a system administrator acting for A
      await settle(db, 'OWN', B); // the payer itself
      await settle(db, 'LEGACY', null); // before the migration
      const before = await shape(db);
      expect(before).toEqual({
        column: true,
        applied: true,
        rows: [
          { id: 'STL_CROSSED', acting: A },
          { id: 'STL_LEGACY', acting: null },
          { id: 'STL_OWN', acting: B },
        ],
      });

      // The whole file, as an operator runs it: refused, with the reason, and
      // nothing changed — the column, its values and the ledger row all stand.
      const down = runDown(url);
      expect(down.ok).toBe(false);
      expect(down.output).toMatch(REFUSAL);
      expect(REFUSAL.exec(down.output)?.[1]).toBe('1');
      expect(down.output).toContain(
        'Those rows are the only record of whom a system administrator acted for (docs/23 D-054).',
      );
      expect(await shape(db)).toEqual(before);

      // The previous release, the column still there.
      const previous = previousRelease();

      // Its deploy step: every migration it knows is applied — nothing to do,
      // and no complaint about the one it does not know.
      const deployed = mustRun(['migrate', 'deploy', '--schema', previous.schema], { url });
      expect(deployed).toContain('No pending migrations to apply.');

      // Its client, which has never heard of the column.
      mustRun(['generate', '--schema', previous.schema], { url });
      // Node's own require: the generated client is loaded as the release
      // loads it, not through jest's transform.
      const { PrismaClient: PreviousClient } = createRequire(__filename)(
        join(previous.clientDir, 'index.js'),
      ) as { PrismaClient: new (options: object) => PrismaClient };
      const old = new PreviousClient({ datasources: { db: { url } } });
      clients.push(old);

      // It reads every settlement, the crossed one included...
      const read = await old.settlement.findMany({
        where: { payerOrganizationId: B },
        orderBy: { id: 'asc' },
      });
      expect(read.map((row) => row.id)).toEqual(['STL_CROSSED', 'STL_LEGACY', 'STL_OWN']);
      for (const row of read) expect(row).not.toHaveProperty('actingOrganizationId');
      expect(
        await old.settlement.findUnique({ where: { transactionId: 'TXN_CROSSED' } }),
      ).toMatchObject({ id: 'STL_CROSSED', organizationId: B, settledBy: 'USR_ROLLBACK' });

      // ...and writes one the way it always did: the column takes NULL.
      await old.transaction.create({
        data: {
          id: 'TXN_PREVIOUS',
          organizationId: B,
          counterpartyOrganizationId: C,
          transactionType: 'MARKETPLACE_ORDER',
          grossAmountMinor: 9000n,
          occurredAt: new Date(),
          correlationId: 'COR_PREVIOUS',
          createdBy: 'USR_ROLLBACK',
        },
      });
      await old.settlement.create({
        data: {
          id: 'STL_PREVIOUS',
          organizationId: B,
          transactionId: 'TXN_PREVIOUS',
          journalId: 'JRN_PREVIOUS',
          payerOrganizationId: B,
          payeeOrganizationId: C,
          grossAmountMinor: 9000n,
          commissionAmountMinor: 0n,
          netAmountMinor: 9000n,
          currency: 'IRR',
          settledAt: new Date(),
          settledBy: 'USR_ROLLBACK',
        },
      });
      expect((await shape(db)).rows).toEqual([
        { id: 'STL_CROSSED', acting: A },
        { id: 'STL_LEGACY', acting: null },
        { id: 'STL_OWN', acting: B },
        { id: 'STL_PREVIOUS', acting: null },
      ]);

      // The attribution survived the rollback, and still holds the line.
      const again = runDown(url);
      expect(again.ok).toBe(false);
      expect(REFUSAL.exec(again.output)?.[1]).toBe('1');
    });

    it('with no settlement made for another organization, the file runs and leaves the previous migration', async () => {
      const { url, db } = await scratch();
      await settle(db, 'OWN', B);
      await settle(db, 'LEGACY', null);

      const down = runDown(url);
      expect(down.output).not.toMatch(REFUSAL);
      expect(down.ok).toBe(true);
      expect(await shape(db)).toEqual({
        column: false,
        applied: false,
        rows: [{ id: 'STL_LEGACY' }, { id: 'STL_OWN' }],
      });
    });
  });
});
