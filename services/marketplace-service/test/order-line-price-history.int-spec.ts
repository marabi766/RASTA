import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withUtcSession } from '@rasta/config';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaClient } from '../src/generated/prisma';
import {
  asActor,
  cleanup,
  id,
  key,
  newPrisma,
  publishOffer,
  sagaStep,
  tenants,
  wire,
} from './helpers';

/**
 * D-156 in the database: an order line's price is one its offer published at the
 * version the line names (fk_order_line_price_history); an order's lines are written
 * by the transaction that places it, which seals it at its end (lines_sealed, data that a
 * restore keeps, #1010 r4), and never change; its parties, total, currency and seal never
 * change; no history row ever changes (#1010 r2).
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
      return {
        key: await tx.$queryRaw<
          { convalidated: boolean; confdeltype: string; confupdtype: string }[]
        >`
          SELECT convalidated, confdeltype, confupdtype FROM pg_constraint
           WHERE conname = 'fk_order_line_price_history'`,
        // Every order already there is placed: sealed; a new one starts open.
        seals: await tx.$queryRaw<{ sealed: boolean; fresh: string }[]>`
          SELECT bool_and(lines_sealed) AS sealed,
                 (SELECT column_default FROM information_schema.columns
                   WHERE table_name = 'order' AND column_name = 'lines_sealed'
                     AND table_schema = current_schema()) AS fresh
            FROM "order"`,
        legacy: String(await insertLine(tx, orderAtV1).catch((error: unknown) => error)),
      };
    });
    // Validated over the rows, RESTRICT both ways ('r').
    expect(after.key).toEqual([{ convalidated: true, confdeltype: 'r', confupdtype: 'r' }]);
    expect(after.seals).toEqual([{ sealed: true, fresh: 'false' }]);
    expect(after.legacy).toMatch(/ck_order_lines_sealed/);
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

  /**
   * In `tx`: an order placed by hand, its header copied from orderAtV1 (`sealed` as the INSERT
   * writes it). Resolves with its id.
   */
  const placeByHand = async (tx: PrismaClient, sealed = false): Promise<string> => {
    const order = id('ORD');
    await tx.$executeRaw`
      INSERT INTO "order" (id, organization_id, supplier_organization_id, placed_by,
                           total_amount_minor, currency, idempotency_key, correlation_id,
                           created_by, updated_at, lines_sealed)
      SELECT ${order}, organization_id, supplier_organization_id, placed_by, 40000, currency,
             ${key('ph-hand')}, correlation_id, created_by, now(), ${sealed}
        FROM "order" WHERE id = ${orderAtV1}`;
    return order;
  };
  /** In `tx`: a hand-written line of `offer` (by default the one nobody ordered), on `order`. */
  const insertLine = (
    tx: PrismaClient,
    order: string,
    version = 1,
    price = 40_000n,
    currency = 'IRR',
    quantity = 1,
    offer = unordered,
  ) =>
    tx.$executeRaw`
      INSERT INTO order_line (id, organization_id, order_id, offer_id, product_id,
                              unit_price_minor, quantity, line_total_minor, currency,
                              offer_version, product_name)
      SELECT ${id('OLN')}, o.organization_id, o.id, f.id, f.product_id,
             ${price}, ${quantity}, ${price} * ${quantity}, ${currency}, ${version}, 'hand-written'
        FROM "order" o, offer f WHERE o.id = ${order} AND f.id = ${offer}`;

  it.each([
    ['a price the offer never published', 1, 40_001n, 'IRR'],
    ['a version the offer has not reached', 2, 40_000n, 'IRR'],
    ['another currency', 1, 40_000n, 'USD'],
  ])('refuses an INSERTed line at %s', async (_label, version, price, currency) => {
    await rolledBack(async (tx) => {
      const order = await placeByHand(tx);
      await expect(insertLine(tx, order, version, price, currency)).rejects.toThrow(
        /fk_order_line_price_history/,
      );
    });
  });

  it('lets the placing transaction write its lines, and seals the order at its end', async () => {
    const seen = await rolledBack(async (tx) => {
      const order = await placeByHand(tx);
      expect(await insertLine(tx, order)).toBe(1);
      const sealed = () =>
        tx.$queryRaw<
          { lines_sealed: boolean }[]
        >`SELECT lines_sealed FROM "order" WHERE id = ${order}`;
      const open = await sealed();
      // The end of the transaction, now: the deferred seal fires.
      await tx.$executeRawUnsafe(`SET CONSTRAINTS "tg_order_lines_seal" IMMEDIATE`);
      const closed = await sealed();
      const late = String(await insertLine(tx, order).catch((error: unknown) => error));
      return { open, closed, late };
    });
    expect(seen).toMatchObject({
      open: [{ lines_sealed: false }],
      closed: [{ lines_sealed: true }],
    });
    expect(seen.late).toMatch(/ck_order_lines_sealed/);
    const placed = await runUnscoped('the suite reads a placed order back', () =>
      prisma.client.order.findUniqueOrThrow({ where: { id: orderAtV1 } }),
    );
    expect(placed.linesSealed).toBe(true);
  });

  // ---- an order placed is sealed (#1010 r2, r4) ---------------------------------------

  it.each([
    ['as the runtime role', () => prisma.client],
    ['even as the owner', () => owner],
  ])('refuses a line appended to a placed order, %s', async (_l, client) => {
    await expect(
      runUnscoped('the suite appends the line the seal exists to refuse', () =>
        insertLine(client() as unknown as PrismaClient, orderAtV1, 1, 40_000n, 'IRR', 20),
      ),
    ).rejects.toThrow(/ck_order_lines_sealed/);
  });

  /**
   * Committed by the owner as a pg_restore writes rows, before any trigger exists: an order
   * stored with `sealed`, and one line. Resolves with its id.
   */
  const restored = (sealed: boolean) =>
    owner.$transaction(async (raw) => {
      const tx = raw as unknown as PrismaClient;
      await tx.$executeRawUnsafe(`ALTER TABLE "order" DISABLE TRIGGER "tg_order_lines_seal"`);
      await tx.$executeRawUnsafe(
        `ALTER TABLE order_line DISABLE TRIGGER "tg_order_line_admission"`,
      );
      const order = await placeByHand(tx, sealed);
      await insertLine(tx, order, 1, 100_000n, 'IRR', 1, offerId);
      await tx.$executeRawUnsafe(`ALTER TABLE order_line ENABLE TRIGGER "tg_order_line_admission"`);
      await tx.$executeRawUnsafe(`ALTER TABLE "order" ENABLE TRIGGER "tg_order_lines_seal"`);
      return order;
    });

  it('refuses a line appended to a restored order, whatever transaction id the appender has', async () => {
    const order = await restored(true);
    await expect(
      runUnscoped('the suite appends to a restored order', () =>
        insertLine(prisma.client as unknown as PrismaClient, order, 1, 40_000n, 'IRR', 20),
      ),
    ).rejects.toThrow(/ck_order_lines_sealed/);
    // Even the transaction that wrote the restored rows: no counter is consulted.
    let same: unknown;
    await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(
        `ALTER TABLE order_line DISABLE TRIGGER "tg_order_line_admission"`,
      );
      const copy = await placeByHand(tx, true);
      await insertLine(tx, copy);
      await tx.$executeRawUnsafe(`ALTER TABLE order_line ENABLE TRIGGER "tg_order_line_admission"`);
      same = await insertLine(tx, copy).catch((error: unknown) => error);
    });
    expect(String(same)).toMatch(/ck_order_lines_sealed/);
  });

  it('serializes a seal and an append: the append waits for the seal, then is refused', async () => {
    const order = await restored(false);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const sealing = new Promise<void>((resolve) => (locked = resolve));
    const seal = owner.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE "order" SET lines_sealed = true WHERE id = ${order}`;
        locked();
        await held;
      },
      { timeout: 30_000 },
    );
    await sealing;
    const append = runUnscoped('the suite appends while the seal is in flight', () =>
      insertLine(prisma.client as unknown as PrismaClient, order),
    );
    const early = await Promise.race([
      append.then(
        () => 'admitted',
        () => 'refused',
      ),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 1_500)),
    ]);
    release();
    await seal;
    expect(early).toBe('waiting');
    await expect(append).rejects.toThrow(/ck_order_lines_sealed/);
  });

  it.each([
    ['total_amount_minor', 'total_amount_minor = total_amount_minor + 1'],
    ['currency', `currency = 'USD'`],
    ['supplier_organization_id', `supplier_organization_id = 'ORG-ELSEWHERE'`],
    ['organization_id', `organization_id = 'ORG-ELSEWHERE'`],
    ['id', `id = 'ORD_ELSEWHERE'`],
    ['lines_sealed (unsealing)', 'lines_sealed = false'],
  ])('refuses an UPDATE of an order’s %s, as the runtime role and the owner', async (_c, set) => {
    const sql = `UPDATE "order" SET ${set} WHERE id = $1`;
    await expect(
      runUnscoped('the suite attempts the header write the guard exists to refuse', () =>
        prisma.client.$executeRawUnsafe(sql, orderAtV1),
      ),
    ).rejects.toThrow(/ck_order_financial_immutable/);
    await expect(owner.$executeRawUnsafe(sql, orderAtV1)).rejects.toThrow(
      /ck_order_financial_immutable/,
    );
  });

  it('lets an order’s status and the saga’s columns move (the header guard is not all-or-nothing)', async () => {
    await rolledBack(async (tx) => {
      expect(
        await tx.$executeRaw`UPDATE "order" SET status = 'CANCELLING', cancellation_reason = 'x',
                                    total_amount_minor = total_amount_minor WHERE id = ${orderAtV1}`,
      ).toBe(1);
    });
  });

  it('refuses the r2 replacement step by step, and a cancellation still restores what was reserved', async () => {
    const { offerId: reserved } = await publishOffer(wiring, org.supplier, {
      availableQuantity: 6,
    });
    const placed = await asBuyer(() =>
      wiring.orders.place(
        { lines: [{ offerId: reserved, offerVersion: 1, quantity: 2 }] },
        key('ph-r2'),
      ),
    );
    const line = placed.lines[0]!.id;
    const asRuntimeRaw = (sql: string, ...values: unknown[]) =>
      runUnscoped('the suite attempts the r2 replacement', () =>
        prisma.client.$executeRawUnsafe(sql, ...values),
      );
    // 1. Park the line under another id, in another order of the same buyer.
    await expect(
      asRuntimeRaw(
        `UPDATE order_line SET id = $2, order_id = $3 WHERE id = $1`,
        line,
        id('OLN'),
        orderAtV1,
      ),
    ).rejects.toThrow(/ck_order_line_price_immutable: .*UPDATE refused/);
    // 2. A new line with 20 units in the placed order (the same offer is still taken, so the
    //    sibling: another offer).
    await expect(
      runUnscoped('the suite appends to the placed order', () =>
        insertLine(prisma.client as unknown as PrismaClient, placed.id, 1, 40_000n, 'IRR', 20),
      ),
    ).rejects.toThrow(/ck_order_lines_sealed/);
    // 3. The header the obligation is created from.
    await expect(
      asRuntimeRaw(`UPDATE "order" SET total_amount_minor = 1 WHERE id = $1`, placed.id),
    ).rejects.toThrow(/ck_order_financial_immutable/);

    await asBuyer(() => wiring.orders.cancel(placed.id, { reason: 'r2 replacement refused' }));
    await asActor(
      {
        organizationId: org.buyer,
        authType: 'SERVICE',
        callerService: 'marketplace-service',
        roles: ['SERVICE'],
      },
      () => wiring.orders.markCancelled(placed.id, 'r2 replacement refused', sagaStep()),
    );
    const offer = await runUnscoped('the suite reads the offer the cancellation released', () =>
      prisma.client.offer.findUniqueOrThrow({ where: { id: reserved } }),
    );
    expect(offer.availableQuantity).toBe(6);
    const order = await asBuyer(() => wiring.orders.get(placed.id));
    expect(order).toMatchObject({ status: 'CANCELLED', totalAmountMinor: placed.totalAmountMinor });
  });

  it('refuses to delete a price a line agreed to, and an offer that was ordered', async () => {
    // The guard answers before the key does; both refuse.
    await expect(
      owner.$executeRaw`DELETE FROM offer_price_history WHERE offer_id = ${offerId} AND version = 1`,
    ).rejects.toThrow(/ck_offer_price_history_immutable: .*DELETE refused/);
    await expect(owner.$executeRaw`DELETE FROM offer WHERE id = ${offerId}`).rejects.toThrow(
      /order_line_offer_id_fkey|fk_order_line_price_history|ck_offer_price_history_immutable/,
    );
  });

  // ---- no row is removed, so none is replaced (#1010 r1) ------------------------------

  /** As the runtime role, in one statement: delete a row and put it back under the same id. */
  const asRuntime = (sql: string, ...values: unknown[]) =>
    runUnscoped('the suite attempts the replacement the guard exists to refuse', () =>
      prisma.client.$executeRawUnsafe(sql, ...values),
    );

  it('refuses the runtime role deleting a line and re-inserting its id with 20 units', async () => {
    await expect(
      asRuntime(
        `WITH gone AS (DELETE FROM order_line WHERE id = $1 RETURNING *)
         INSERT INTO order_line (id, organization_id, order_id, offer_id, product_id,
                                 unit_price_minor, quantity, line_total_minor, currency,
                                 offer_version, product_name)
         SELECT id, organization_id, order_id, offer_id, product_id, unit_price_minor, 20,
                unit_price_minor * 20, currency, offer_version, product_name FROM gone`,
        lineAtV1,
      ),
    ).rejects.toThrow(/ck_order_line_price_immutable: .*DELETE refused/);
    // The id is still taken, so a re-insert is an upsert; its order is sealed, so the INSERT is
    // refused before the conflict would make it an UPDATE (which the row guard refuses).
    await expect(
      asRuntime(
        `INSERT INTO order_line SELECT * FROM order_line WHERE id = $1
           ON CONFLICT (id) DO UPDATE SET quantity = 20,
                                          line_total_minor = EXCLUDED.unit_price_minor * 20`,
        lineAtV1,
      ),
    ).rejects.toThrow(/ck_order_lines_sealed/);
    const line = await runUnscoped('the suite reads the line back', () =>
      prisma.client.orderLine.findUniqueOrThrow({ where: { id: lineAtV1 } }),
    );
    expect(line).toMatchObject({ quantity: 2, lineTotalMinor: 200_000n });
  });

  it('refuses the runtime role deleting an unreferenced price and re-inserting it cheaper', async () => {
    await expect(
      asRuntime(
        `WITH gone AS (DELETE FROM offer_price_history WHERE offer_id = $1 AND version = 1
                       RETURNING *)
         INSERT INTO offer_price_history (id, organization_id, offer_id, version,
                                          unit_price_minor, currency, changed_at, changed_by)
         SELECT id, organization_id, offer_id, version, 1, currency, changed_at, changed_by
           FROM gone`,
        unordered,
      ),
    ).rejects.toThrow(/ck_offer_price_history_immutable: .*DELETE refused/);
  });

  /** DELETE of `parent` row `id` with only foreign key `keep` into it left (the rest dropped, rolled back). */
  async function deleteThrough(
    tx: PrismaClient,
    parent: string,
    id: string,
    keep: string,
    disable?: [table: string, trigger: string],
  ): Promise<number> {
    const references = await tx.$queryRawUnsafe<{ conname: string; child: string }[]>(
      `SELECT conname, conrelid::regclass::text AS child FROM pg_constraint
        WHERE contype = 'f' AND confrelid = $1::regclass AND conname <> $2`,
      `"${parent}"`,
      keep,
    );
    for (const { conname, child } of references) {
      await tx.$executeRawUnsafe(`ALTER TABLE ${child} DROP CONSTRAINT "${conname}"`);
    }
    if (disable)
      await tx.$executeRawUnsafe(`ALTER TABLE ${disable[0]} DISABLE TRIGGER "${disable[1]}"`);
    return tx.$executeRawUnsafe(`DELETE FROM "${parent}" WHERE id = $1`, id);
  }

  it.each([
    [
      'an order deletes its lines',
      'order',
      () => orderAtV1,
      'fk_order_line_tenant',
      ['order_line', 'tg_order_line_price_guard'],
      /ck_order_line_price_immutable: .*DELETE refused/,
    ],
    [
      'an offer deletes its price history',
      'offer',
      () => unordered,
      'fk_offer_price_history_tenant',
      ['offer_price_history', 'tg_offer_price_history_guard'],
      /ck_offer_price_history_immutable: .*DELETE refused/,
    ],
  ] as const)(
    'refuses the cascade when %s — by the row guard',
    async (_l, parent, row, keep, guard, refusal) => {
      let refused: unknown;
      await rolledBack(async (tx) => {
        refused = await deleteThrough(tx, parent, row(), keep).catch((error: unknown) => error);
      });
      expect(String(refused)).toMatch(refusal);
      // And it is the guard that refuses: without it the same cascade succeeds.
      await rolledBack(async (tx) => {
        expect(await deleteThrough(tx, parent, row(), keep, [...guard])).toBe(1);
      });
    },
  );

  // ---- the guards, by raw SQL --------------------------------------------------------

  it.each([
    ['unit_price_minor', 'unit_price_minor = unit_price_minor + 1'],
    ['quantity', 'quantity = quantity + 1'],
    ['line_total_minor', 'line_total_minor = line_total_minor + 1'],
    ['currency', `currency = 'USD'`],
    ['offer_version', 'offer_version = 1'],
    ['offer_id', `offer_id = '${'OFR_ELSEWHERE'}'`],
    ['id', `id = 'OLN_SAVED'`],
    [
      'order_id (to another order of its buyer)',
      `order_id = (SELECT id FROM "order" o WHERE o.organization_id = order_line.organization_id
                      AND o.id <> order_line.order_id LIMIT 1)`,
    ],
    [
      'organization_id with a matching order',
      `(organization_id, order_id) = (SELECT organization_id, id FROM "order" o
                      WHERE o.organization_id <> order_line.organization_id LIMIT 1)`,
    ],
    ['product_id', `product_id = 'PRD_ELSEWHERE'`],
    ['product_name', `product_name = 'renamed'`],
    ['nothing (a no-op)', 'quantity = quantity'],
  ])('refuses an UPDATE of a line’s %s, as the runtime role and the owner', async (_c, set) => {
    // The v2 line: `offer_version = 1` with v1's price absent would otherwise be
    // a key violation; the guard answers first, whatever the change.
    const sql = `UPDATE order_line SET ${set} WHERE id = $1`;
    await expect(
      runUnscoped('the suite attempts the line write the guard exists to refuse', () =>
        prisma.client.$executeRawUnsafe(sql, lineAtV2),
      ),
    ).rejects.toThrow(/ck_order_line_price_immutable: .*UPDATE refused/);
    await expect(owner.$executeRawUnsafe(sql, lineAtV2)).rejects.toThrow(
      /ck_order_line_price_immutable: .*UPDATE refused/,
    );
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
