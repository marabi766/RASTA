import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withUtcSession } from '@rasta/config';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaClient } from '../src/generated/prisma';
import { asActor, cleanup, id, key, newPrisma, publishOffer, tenants, wire } from './helpers';

/**
 * D-156 in the database: an order line's price is one its offer published at the
 * version the line names (fk_order_line_price_history), and neither the agreed
 * columns of a line nor a history row ever change (the two guards).
 *
 * Every refusal is asserted with raw SQL, not through the service — the service
 * is not the only writer a database has. Schema-changing steps (rolling the
 * three migrations back and forward over a used table, dropping a foreign key to
 * reach a TRUNCATE) run on the owner's connection inside a transaction that is
 * always rolled back: DDL is transactional, so the shared schema is untouched.
 */

jest.setTimeout(60_000);

const MIGRATIONS = join(__dirname, '../prisma/migrations');
const CHAIN = [
  '20261108120000_order_line_price_history_precheck',
  '20261108120100_order_line_price_history_fk',
  '20261108120200_order_line_price_immutable',
] as const;

/** A script's statements; a dollar-quoted body is one. Its own BEGIN/COMMIT and ledger row are the harness's. */
function statements(file: string): string[] {
  const sql = readFileSync(file, 'utf8').replace(/^--.*$/gm, '');
  const parts = sql.split('$$');
  const out: string[] = [''];
  parts.forEach((part, i) => {
    const pieces = i % 2 === 1 ? [part] : part.split(/;\s*\n/);
    pieces.forEach((piece, j) => {
      if (j > 0) out.push('');
      out[out.length - 1] += (i > 0 && j === 0 ? '$$' : '') + piece;
    });
  });
  return out
    .map((statement) => statement.trim().replace(/;$/, ''))
    .filter(Boolean)
    .filter((statement) => !/^(BEGIN|COMMIT)$/i.test(statement))
    .filter((statement) => !statement.includes('_prisma_migrations'));
}

const up = (name: string) => statements(join(MIGRATIONS, name, 'migration.sql'));
const down = (name: string) => statements(join(MIGRATIONS, name, 'down.sql'));

class RolledBack extends Error {}

describe('an order line agrees to a published offer price, in the database (D-156)', () => {
  const prisma = newPrisma();
  const wiring = wire(prisma);
  const org = tenants();
  let owner: PrismaClient;
  /** A used table: lines at v1 from two buyers, a reprice to v2, a line at v2. */
  let offerId: string;
  let lineAtV1: string;
  let lineAtV2: string;
  let orderAtV1: string;
  /** An offer nobody ordered, for lines inserted by hand. */
  let unordered: string;

  const asBuyer = <T>(fn: () => Promise<T>, organizationId = org.buyer) =>
    asActor({ organizationId, roles: ['PROCUREMENT_USER'], userId: 'USR-PH-B' }, fn);
  const asSupplier = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.supplier, roles: ['SUPPLIER'], userId: 'USR-PH-S' }, fn);

  beforeAll(async () => {
    const url = process.env.DATABASE_URL_MARKETPLACE_MIGRATOR;
    if (!url) throw new Error('DATABASE_URL_MARKETPLACE_MIGRATOR is required by this suite');
    owner = new PrismaClient({ datasources: { db: { url: withUtcSession(url) } } });

    ({ offerId } = await publishOffer(wiring, org.supplier, { unitPriceMinor: '100000' }));
    ({ offerId: unordered } = await publishOffer(wiring, org.supplier, {
      unitPriceMinor: '40000',
    }));
    const place = (version: number, label: string, buyer = org.buyer) =>
      asBuyer(
        () =>
          wiring.orders.place(
            { lines: [{ offerId, offerVersion: version, quantity: 2 }] },
            key(label),
          ),
        buyer,
      );
    const first = await place(1, 'ph-v1-a');
    await place(1, 'ph-v1-b', org.other);
    await asSupplier(() => wiring.catalogue.updateOffer(offerId, { unitPriceMinor: '125000' }));
    const second = await place(2, 'ph-v2');
    orderAtV1 = first.id;
    lineAtV1 = first.lines[0]!.id;
    lineAtV2 = second.lines[0]!.id;
  });

  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await owner.$disconnect();
    await prisma.onModuleDestroy();
  });

  /** Runs `work` as the owner, then rolls everything back. Resolves with what it returned. */
  async function rolledBack<T>(work: (tx: PrismaClient) => Promise<T>): Promise<T> {
    let result: T | undefined;
    await expect(
      owner.$transaction(
        async (tx) => {
          result = await work(tx as unknown as PrismaClient);
          throw new RolledBack();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toBeInstanceOf(RolledBack);
    return result as T;
  }

  async function run(tx: PrismaClient, sql: readonly string[]): Promise<void> {
    for (const statement of sql) await tx.$executeRawUnsafe(statement);
  }

  /** Back to the schema before D-156: the three down scripts, newest first. */
  const rollBackChain = (tx: PrismaClient) =>
    run(
      tx,
      [...CHAIN].reverse().flatMap((name) => down(name)),
    );

  // ---- the migration over a used database -------------------------------------------

  it('migrates a used table: lines at v1 and v2 all prove their price, and the key is validated', async () => {
    const after = await rolledBack(async (tx) => {
      await rollBackChain(tx);
      const gone = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_constraint WHERE conname = 'fk_order_line_price_history'`;
      expect(gone[0]?.n).toBe(0n);
      await run(
        tx,
        CHAIN.flatMap((name) => up(name)),
      );
      return tx.$queryRaw<{ convalidated: boolean; confdeltype: string; confupdtype: string }[]>`
        SELECT convalidated, confdeltype, confupdtype FROM pg_constraint
         WHERE conname = 'fk_order_line_price_history'`;
    });
    // Validated over the rows, RESTRICT both ways ('r').
    expect(after).toEqual([{ convalidated: true, confdeltype: 'r', confupdtype: 'r' }]);
  });

  it.each([
    [
      'a price no history row records',
      `UPDATE order_line SET unit_price_minor = unit_price_minor + 1,
              line_total_minor = (unit_price_minor + 1) * quantity WHERE id = $1`,
    ],
    ['a version the offer never had', `UPDATE order_line SET offer_version = 99 WHERE id = $1`],
    ['another currency', `UPDATE order_line SET currency = 'USD' WHERE id = $1`],
  ])('aborts on a planted line with %s, says why, and relabels nothing', async (_label, plant) => {
    await rolledBack(async (tx) => {
      await rollBackChain(tx);
      expect(await tx.$executeRawUnsafe(plant, lineAtV1)).toBe(1);
      const history = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM offer_price_history WHERE offer_id = ${offerId}`;
      // The precheck refuses before anything is built, in its own words…
      await expect(run(tx, up(CHAIN[0]))).rejects.toThrow(
        /1 order lines name an offer price no history row records/,
      );
      return history;
    });
    // …and the key itself refuses the same row without it (a separate rollback).
    await rolledBack(async (tx) => {
      await rollBackChain(tx);
      await tx.$executeRawUnsafe(plant, lineAtV1);
      await expect(run(tx, up(CHAIN[1]))).rejects.toThrow(/fk_order_line_price_history/);
    });
    // Nothing was invented or changed: the line and its proof are as placed.
    const line = await runUnscoped('the suite reads the planted line back', () =>
      prisma.client.orderLine.findUniqueOrThrow({ where: { id: lineAtV1 } }),
    );
    expect(line).toMatchObject({ offerVersion: 1, unitPriceMinor: 100_000n, currency: 'IRR' });
  });

  // ---- the key, by raw SQL -----------------------------------------------------------

  /** A hand-written line on an existing order, for the offer nobody ordered. */
  const insertLine = (version: number, price: bigint, currency = 'IRR') =>
    owner.$executeRaw`
      INSERT INTO order_line (id, organization_id, order_id, offer_id, product_id,
                              unit_price_minor, quantity, line_total_minor, currency,
                              offer_version, product_name)
      SELECT ${id('OLN')}, o.organization_id, o.id, f.id, f.product_id,
             ${price}, 1, ${price}, ${currency}, ${version}, 'hand-written'
        FROM "order" o, offer f WHERE o.id = ${orderAtV1} AND f.id = ${unordered}`;

  it.each([
    ['a price the offer never published', 1, 40_001n, 'IRR'],
    ['a version the offer has not reached', 2, 40_000n, 'IRR'],
    ['another currency', 1, 40_000n, 'USD'],
  ])('refuses an INSERTed line at %s', async (_label, version, price, currency) => {
    await expect(insertLine(version, price, currency)).rejects.toThrow(
      /fk_order_line_price_history/,
    );
  });

  it('accepts a hand-written line at the published price (the key is not vacuous)', async () => {
    await rolledBack(async (tx) => {
      expect(
        await tx.$executeRaw`
          INSERT INTO order_line (id, organization_id, order_id, offer_id, product_id,
                                  unit_price_minor, quantity, line_total_minor, currency,
                                  offer_version, product_name)
          SELECT ${id('OLN')}, o.organization_id, o.id, f.id, f.product_id,
                 40000, 1, 40000, 'IRR', 1, 'hand-written'
            FROM "order" o, offer f WHERE o.id = ${orderAtV1} AND f.id = ${unordered}`,
      ).toBe(1);
    });
  });

  it('refuses to delete a price a line agreed to, and an offer that was ordered', async () => {
    await expect(
      owner.$executeRaw`DELETE FROM offer_price_history WHERE offer_id = ${offerId} AND version = 1`,
    ).rejects.toThrow(/fk_order_line_price_history/);
    // ON DELETE CASCADE from the offer reaches the history only if the offer can
    // go, and order_line_offer_id_fkey (RESTRICT) says it cannot.
    await expect(owner.$executeRaw`DELETE FROM offer WHERE id = ${offerId}`).rejects.toThrow(
      /order_line_offer_id_fkey|fk_order_line_price_history/,
    );
  });

  // ---- the guards, by raw SQL --------------------------------------------------------

  it.each([
    ['unit_price_minor', 'unit_price_minor = unit_price_minor + 1'],
    ['quantity', 'quantity = quantity + 1'],
    ['line_total_minor', 'line_total_minor = line_total_minor + 1'],
    ['currency', `currency = 'USD'`],
    ['offer_version', 'offer_version = 1'],
    ['offer_id', `offer_id = '${'OFR_ELSEWHERE'}'`],
  ])('refuses an UPDATE of a line’s %s, even by the owner', async (_column, set) => {
    // The v2 line: `offer_version = 1` with v1's price absent would otherwise be
    // a key violation; the guard answers first, whatever the change.
    await expect(
      owner.$executeRawUnsafe(`UPDATE order_line SET ${set} WHERE id = $1`, lineAtV2),
    ).rejects.toThrow(/ck_order_line_price_immutable/);
  });

  it('refuses the same UPDATE from the runtime role', async () => {
    await expect(
      runUnscoped(
        'the suite attempts the write the guard exists to refuse',
        () =>
          prisma.client
            .$executeRaw`UPDATE order_line SET unit_price_minor = 1, line_total_minor = quantity
                                    WHERE id = ${lineAtV1}`,
      ),
    ).rejects.toThrow(/ck_order_line_price_immutable/);
  });

  it('lets a line’s other columns keep their own rules (the guard is not all-or-nothing)', async () => {
    await rolledBack(async (tx) => {
      expect(
        await tx.$executeRaw`UPDATE order_line SET product_name = 'renamed' WHERE id = ${lineAtV1}`,
      ).toBe(1);
      // A no-op write of an agreed column is not a change.
      expect(
        await tx.$executeRaw`UPDATE order_line SET unit_price_minor = unit_price_minor WHERE id = ${lineAtV1}`,
      ).toBe(1);
    });
  });

  it.each([
    ['unit_price_minor', 'unit_price_minor = unit_price_minor + 1'],
    ['currency', `currency = 'USD'`],
    ['changed_by', `changed_by = 'someone-else'`],
  ])('refuses an UPDATE of a price history row’s %s', async (_column, set) => {
    await expect(
      owner.$executeRawUnsafe(
        `UPDATE offer_price_history SET ${set} WHERE offer_id = $1 AND version = 2`,
        offerId,
      ),
    ).rejects.toThrow(/ck_offer_price_history_immutable/);
  });

  /** TRUNCATE of `table` alone: every foreign key into it is dropped first (and rolled back). */
  async function truncateAlone(tx: PrismaClient, table: string, disable?: string): Promise<void> {
    const references = await tx.$queryRawUnsafe<{ conname: string; child: string }[]>(
      `SELECT conname, conrelid::regclass::text AS child FROM pg_constraint
        WHERE contype = 'f' AND confrelid = $1::regclass`,
      table,
    );
    for (const { conname, child } of references) {
      await tx.$executeRawUnsafe(`ALTER TABLE ${child} DROP CONSTRAINT "${conname}"`);
    }
    if (disable) await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER "${disable}"`);
    await tx.$executeRawUnsafe(`TRUNCATE ${table}`);
  }

  it.each([
    [
      'order_line',
      'tg_order_line_no_truncate',
      /ck_order_line_price_immutable: .*TRUNCATE refused/,
    ],
    [
      'offer_price_history',
      'tg_offer_price_history_no_truncate',
      /ck_offer_price_history_immutable: .*TRUNCATE refused/,
    ],
  ])('refuses a TRUNCATE of %s — by its own trigger', async (table, trigger, refusal) => {
    let refused: unknown;
    await rolledBack(async (tx) => {
      refused = await truncateAlone(tx, table).catch((error: unknown) => error);
    });
    expect(String(refused)).toMatch(refusal);
    // And it is the trigger that refuses: without it the same TRUNCATE succeeds.
    await rolledBack(async (tx) => {
      await truncateAlone(tx, table, trigger);
    });
  });
});
