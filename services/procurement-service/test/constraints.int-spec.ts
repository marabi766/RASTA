import { ulid } from 'ulid';
import type { PrismaClient } from '../src/generated/prisma';
import { cleanup, newOrganizationId, newProductId, runtimeClient } from './helpers';

/**
 * What the database keeps whatever a future write path forgets (ADR-070 § 2, ADR-063 § 1), proven
 * as the **runtime** role — the one the service connects as — with raw SQL that goes around the
 * code:
 *
 * - one OPEN window per (organization, product); a demand only in a window of its own
 *   organization and product (Q-119 (1)); statuses from the closed lists, as text;
 * - a demand joins only an OPEN window, within [opened_at, closes_at), and is withdrawn only before
 *   the end; a window that ended is frozen; only the declared transitions exist;
 * - a window's total and count are its demands', at commit;
 * - nothing is deleted or truncated; what a row was made from never changes.
 */
const T0 = new Date('2031-05-01T08:00:00.000Z');
const HOUR = 3_600_000;

describe('the database keeps the demand and aggregation invariants', () => {
  let db: PrismaClient;
  const organizations: string[] = [];
  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  beforeAll(() => {
    db = runtimeClient();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await db.$disconnect();
  });

  /** An OPEN window opened at T0 for `hours`, written raw. */
  async function window(
    organizationId: string,
    productId = newProductId(),
    hours = 10,
  ): Promise<{ id: string; productId: string }> {
    const id = `AGG_${ulid()}`;
    await db.$executeRaw`
      INSERT INTO demand_aggregation
        (id, organization_id, product_id, status, opened_at, closes_at, window_hours, min_quantity,
         shortfall_policy, total_quantity, demand_count, extension_count, created_at, updated_at)
      VALUES (${id}, ${organizationId}, ${productId}, 'OPEN', ${T0},
              ${new Date(T0.getTime() + hours * HOUR)}, ${hours}, 0, 'EXTEND', 0, 0, 0, ${T0}, ${T0})`;
    return { id, productId };
  }

  /** A demand and its window's totals in one transaction, as the service writes them. */
  async function join(
    organizationId: string,
    agg: { id: string; productId: string },
    at: Date,
    quantity = 3,
    overrides: { organizationId?: string; productId?: string } = {},
  ): Promise<string> {
    const id = `DMD_${ulid()}`;
    await db.$transaction([
      db.$executeRaw`
        INSERT INTO demand_request
          (id, organization_id, aggregation_id, product_id, quantity, status, submitted_at,
           submitted_by, submitted_correlation_id, created_at, updated_at)
        VALUES (${id}, ${overrides.organizationId ?? organizationId}, ${agg.id},
                ${overrides.productId ?? agg.productId}, ${quantity}, 'SUBMITTED', ${at},
                'USR_1', 'corr-1', ${at}, ${at})`,
      db.$executeRaw`
        UPDATE demand_aggregation
           SET total_quantity = total_quantity + ${quantity}, demand_count = demand_count + 1,
               updated_at = ${at}, version = version + 1
         WHERE organization_id = ${organizationId} AND id = ${agg.id}`,
    ]);
    return id;
  }

  const refusedWith = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

  it('keeps one OPEN window per (organization, product), and any number that ended', async () => {
    const a = org();
    const first = await window(a);
    await refusedWith(window(a, first.productId), /Unique constraint|already exists|unique/i);
    // Another organization, same product: its own window.
    await expect(window(org(), first.productId)).resolves.toBeDefined();
  });

  it('refuses a demand in another organization’s window, or of another product (Q-119 (1))', async () => {
    const a = org();
    const agg = await window(a);
    await refusedWith(
      join(a, agg, T0, 3, { organizationId: org() }),
      /fk_demand_request_aggregation|foreign key|ck_demand_request_joins_open_window/i,
    );
    await refusedWith(
      join(a, agg, T0, 3, { productId: newProductId() }),
      /fk_demand_request_aggregation|foreign key|ck_demand_request_joins_open_window/i,
    );
  });

  it('lets a demand join within [opened_at, closes_at) only — at closes_at it is refused', async () => {
    const a = org();
    const agg = await window(a, newProductId(), 10);
    await expect(join(a, agg, new Date(T0.getTime() + 10 * HOUR - 1))).resolves.toBeDefined();
    await refusedWith(
      join(a, agg, new Date(T0.getTime() + 10 * HOUR)),
      /ck_demand_request_joins_open_window/,
    );
    await refusedWith(
      join(a, agg, new Date(T0.getTime() - 1)),
      /ck_demand_request_joins_open_window/,
    );
  });

  it('refuses a demand in a window that ended, and freezes what the window holds', async () => {
    const a = org();
    const agg = await window(a);
    const demand = await join(a, agg, T0);
    await db.$executeRaw`
      UPDATE demand_aggregation SET status = 'READY', closed_at = ${T0}, version = version + 1
       WHERE id = ${agg.id}`;
    await refusedWith(
      join(a, agg, T0),
      /ck_demand_request_joins_open_window|ck_demand_aggregation/,
    );
    await refusedWith(
      db.$executeRaw`UPDATE demand_aggregation SET closes_at = closes_at + interval '1 hour',
                       extension_count = 1, version = version + 1 WHERE id = ${agg.id}`,
      /ck_demand_aggregation_transition/,
    );
    await refusedWith(
      db.$executeRaw`UPDATE demand_request SET status = 'WITHDRAWN', withdrawn_at = ${T0},
                       withdrawn_by = 'USR_1', withdraw_reason = 'too late to leave',
                       version = version + 1 WHERE id = ${demand}`,
      /ck_demand_request_withdraw_window/,
    );
  });

  it('has only the declared transitions, and no unknown status', async () => {
    const a = org();
    const agg = await window(a);
    await refusedWith(
      db.$executeRaw`UPDATE demand_aggregation SET status = 'RFQ_ISSUED', closed_at = ${T0},
                       rfq_id = 'RFQ_1', version = version + 1 WHERE id = ${agg.id}`,
      /ck_demand_aggregation_transition/,
    );
    // An update to an unknown status is refused by the transition guard first; a row born with
    // one meets the CHECK.
    await refusedWith(
      db.$executeRaw`UPDATE demand_aggregation SET status = 'CLOSED', closed_at = ${T0},
                       version = version + 1 WHERE id = ${agg.id}`,
      /ck_demand_aggregation_transition/,
    );
    await refusedWith(
      db.$executeRaw`
        INSERT INTO demand_aggregation
          (id, organization_id, product_id, status, opened_at, closes_at, window_hours,
           min_quantity, shortfall_policy, total_quantity, demand_count, extension_count,
           closed_at, created_at, updated_at)
        VALUES (${`AGG_${ulid()}`}, ${a}, ${newProductId()}, 'CLOSED', ${T0},
                ${new Date(T0.getTime() + HOUR)}, 1, 0, 'EXTEND', 0, 0, 0, ${T0}, ${T0}, ${T0})`,
      /ck_demand_aggregation_status/,
    );
    const demand = await join(a, agg, T0);
    // A demand follows its window to REFERRED only with it.
    await refusedWith(
      db.$executeRaw`UPDATE demand_request SET status = 'REFERRED', closed_at = ${T0},
                       version = version + 1 WHERE id = ${demand}`,
      /ck_demand_request_follows_window/,
    );
  });

  it('refuses a total that is not the window’s demands’ at commit', async () => {
    const a = org();
    const agg = await window(a);
    await refusedWith(
      db.$executeRaw`UPDATE demand_aggregation SET total_quantity = 9, demand_count = 1,
                       version = version + 1 WHERE id = ${agg.id}`,
      /ck_demand_aggregation_totals/,
    );
    await refusedWith(
      db.$executeRaw`
        INSERT INTO demand_request
          (id, organization_id, aggregation_id, product_id, quantity, status, submitted_at,
           submitted_by, submitted_correlation_id, created_at, updated_at)
        VALUES (${`DMD_${ulid()}`}, ${a}, ${agg.id}, ${agg.productId}, 2, 'SUBMITTED', ${T0},
                'USR_1', 'corr-1', ${T0}, ${T0})`,
      /ck_demand_aggregation_totals/,
    );
  });

  it('never edits a demand, never erases one, and keeps what a window opened with', async () => {
    const a = org();
    const agg = await window(a);
    const demand = await join(a, agg, T0);
    await refusedWith(
      db.$executeRaw`UPDATE demand_request SET quantity = 99 WHERE id = ${demand}`,
      /ck_demand_request_origin_immutable/,
    );
    await refusedWith(
      db.$executeRaw`DELETE FROM demand_request WHERE id = ${demand}`,
      /ck_demand_request_not_erasable/,
    );
    await refusedWith(
      db.$executeRaw`UPDATE demand_aggregation SET min_quantity = 5, version = version + 1
                      WHERE id = ${agg.id}`,
      /ck_demand_aggregation_origin_immutable/,
    );
    await refusedWith(
      db.$executeRaw`DELETE FROM demand_aggregation WHERE id = ${agg.id}`,
      /ck_demand_aggregation_not_erasable/,
    );
  });

  it('refuses a non-positive quantity, a product of another shape and a policy outside the closed set', async () => {
    const a = org();
    const agg = await window(a);
    await refusedWith(join(a, agg, T0, 0), /ck_demand_request_quantity_positive/);
    await refusedWith(
      db.$executeRaw`
        INSERT INTO demand_aggregation
          (id, organization_id, product_id, status, opened_at, closes_at, window_hours,
           min_quantity, shortfall_policy, total_quantity, demand_count, extension_count,
           created_at, updated_at)
        VALUES (${`AGG_${ulid()}`}, ${a}, 'SKU-1', 'OPEN', ${T0}, ${new Date(T0.getTime() + HOUR)},
                1, 0, 'EXTEND', 0, 0, 0, ${T0}, ${T0})`,
      /ck_demand_aggregation_identifiers/,
    );
    await refusedWith(
      db.$executeRaw`
        INSERT INTO demand_aggregation
          (id, organization_id, product_id, status, opened_at, closes_at, window_hours,
           min_quantity, shortfall_policy, total_quantity, demand_count, extension_count,
           created_at, updated_at)
        VALUES (${`AGG_${ulid()}`}, ${a}, ${newProductId()}, 'OPEN', ${T0},
                ${new Date(T0.getTime() + HOUR)}, 1, 0, 'WAIT', 0, 0, 0, ${T0}, ${T0})`,
      /ck_demand_aggregation_snapshot/,
    );
  });
});
