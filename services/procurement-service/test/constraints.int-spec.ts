import { eligibilityClockWrite } from '@rasta/testing';
import { eligibilityClockSql } from '@rasta/testing';
import { ulid } from 'ulid';
import { PrismaClient, type Prisma } from '../src/generated/prisma';
import { ResumableSha256 } from '../src/shared/resumable-sha256';
import {
  cleanup,
  newOrganizationId,
  newProductId,
  ownerDatabaseUrl,
  runtimeClient,
} from './helpers';

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
/** A finished digest: an ended window holds its digest or the state of the one being built. */
const DIGEST = '0'.repeat(64);
/** The empty SHA-256 state the end begins a digest with. */
const FRESH = ResumableSha256.fresh().save();

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
    await eligibilityClockWrite(db)`
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

  /**
   * A window's end as `WindowEnd` writes it for a window it digests in one batch, as one
   * transaction's statements: OPEN → `status` with the digest begun from nothing, then the digest
   * written with every id taken (the value is not the database's to check: it takes any).
   */
  const ending = (id: string, status: string, at: Date, demandsToFollow = 0) => [
    db.$executeRaw`UPDATE demand_aggregation SET status = ${status}, closed_at = ${at},
                     demands_to_follow = ${demandsToFollow}, end_digest_state = ${FRESH},
                     updated_at = ${at}, version = version + 1 WHERE id = ${id}`,
    db.$executeRaw`UPDATE demand_aggregation SET demand_ids_sha256 = ${DIGEST},
                     end_digest_state = NULL, end_digest_counted = demand_count WHERE id = ${id}`,
  ];

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
    await db.$transaction(ending(agg.id, 'READY', T0));
    await refusedWith(
      join(a, agg, T0),
      /ck_demand_request_joins_open_window|ck_demand_aggregation/,
    );
    await refusedWith(
      eligibilityClockWrite(
        db,
      )`UPDATE demand_aggregation SET closes_at = closes_at + interval '1 hour',
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
      eligibilityClockWrite(db)`
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
    // A demand that leaves the counted set without its window giving the quantity back: the
    // update is checked, not skipped as a window's end is (PR-327 r1 F1).
    const demand = await join(a, agg, T0);
    await refusedWith(
      db.$executeRaw`UPDATE demand_request SET status = 'WITHDRAWN', withdrawn_at = ${T0},
                       withdrawn_by = 'USR_1', withdraw_reason = 'left the window alone',
                       version = version + 1 WHERE id = ${demand}`,
      /ck_demand_aggregation_totals/,
    );
  });

  it('lets a window end with its demands: a status-only move keeps the totals', async () => {
    const a = org();
    const agg = await window(a);
    const demand = await join(a, agg, T0, 4);
    const end = new Date(T0.getTime() + 10 * HOUR);
    // The window's end moves statuses only: counted before and after, its totals still hold.
    await db.$transaction([
      ...ending(agg.id, 'REFERRED', end),
      db.$executeRaw`UPDATE demand_request SET status = 'REFERRED', closed_at = ${end},
                       updated_at = ${end}, version = version + 1 WHERE id = ${demand}`,
    ]);
    const [row] = await db.$queryRaw<{ total_quantity: bigint; demand_count: number }[]>`
      SELECT total_quantity, demand_count FROM demand_aggregation WHERE id = ${agg.id}`;
    expect(row).toEqual({ total_quantity: 4n, demand_count: 1 });
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
      eligibilityClockWrite(db)`
        INSERT INTO demand_aggregation
          (id, organization_id, product_id, status, opened_at, closes_at, window_hours,
           min_quantity, shortfall_policy, total_quantity, demand_count, extension_count,
           created_at, updated_at)
        VALUES (${`AGG_${ulid()}`}, ${a}, 'SKU-1', 'OPEN', ${T0}, ${new Date(T0.getTime() + HOUR)},
                1, 0, 'EXTEND', 0, 0, 0, ${T0}, ${T0})`,
      /ck_demand_aggregation_identifiers/,
    );
    await refusedWith(
      eligibilityClockWrite(db)`
        INSERT INTO demand_aggregation
          (id, organization_id, product_id, status, opened_at, closes_at, window_hours,
           min_quantity, shortfall_policy, total_quantity, demand_count, extension_count,
           created_at, updated_at)
        VALUES (${`AGG_${ulid()}`}, ${a}, ${newProductId()}, 'OPEN', ${T0},
                ${new Date(T0.getTime() + HOUR)}, 1, 0, 'WAIT', 0, 0, 0, ${T0}, ${T0})`,
      /ck_demand_aggregation_snapshot/,
    );
  });

  describe('the sweeper’s bookkeeping and the cancellation (plan PR 2)', () => {
    /** A window of two demands, ended REFERRED with one of them still to follow it. */
    async function referredWithOneToFollow(a: string) {
      const agg = await window(a);
      await join(a, agg, T0);
      await join(a, agg, T0);
      await db.$transaction(ending(agg.id, 'REFERRED', T0, 1));
      return agg;
    }

    it('lets a claim, its release and a failed attempt through without a version — on an ended window too', async () => {
      const a = org();
      const agg = await referredWithOneToFollow(a);
      await eligibilityClockWrite(db)`
        UPDATE demand_aggregation
           SET sweep_lease_until = ${T0}, sweep_fence = 'F1', sweep_attempts = 2,
               sweep_next_attempt_at = ${T0}
         WHERE id = ${agg.id}`;
      await eligibilityClockWrite(db)`
        UPDATE demand_aggregation SET sweep_lease_until = NULL, sweep_fence = NULL
         WHERE id = ${agg.id}`;
      // Anything else changed beside it is no longer bookkeeping: the ended window is history.
      await refusedWith(
        eligibilityClockWrite(db)`UPDATE demand_aggregation SET sweep_fence = 'F2',
                         sweep_lease_until = ${T0}, updated_at = ${new Date(T0.getTime() + 1)}
                        WHERE id = ${agg.id}`,
        /ck_demand_aggregation_transition/,
      );
      // A lease without its fence, or a fence without its lease, is not a claim.
      await refusedWith(
        db.$executeRaw`UPDATE demand_aggregation SET sweep_fence = 'F3' WHERE id = ${agg.id}`,
        /ck_demand_aggregation_sweep_claim/,
      );
    });

    it('sets the demands to follow only with the end, and only ever fewer after it', async () => {
      const a = org();
      const agg = await referredWithOneToFollow(a);
      await refusedWith(
        db.$executeRaw`UPDATE demand_aggregation SET demands_to_follow = 2 WHERE id = ${agg.id}`,
        /ck_demand_aggregation_follow/,
      );
      await db.$executeRaw`UPDATE demand_aggregation SET demands_to_follow = 0 WHERE id = ${agg.id}`;
      // An OPEN or READY window has none to follow.
      const open = await window(a);
      await join(a, open, T0);
      await refusedWith(
        db.$executeRaw`UPDATE demand_aggregation SET demands_to_follow = 1 WHERE id = ${open.id}`,
        /ck_demand_aggregation_follow/,
      );
      await refusedWith(
        db.$executeRaw`UPDATE demand_aggregation SET status = 'READY', closed_at = ${T0},
                         demands_to_follow = 1, version = version + 1 WHERE id = ${open.id}`,
        /ck_demand_aggregation_follow/,
      );
    });

    it('keeps the instant a window ended', async () => {
      const a = org();
      const agg = await referredWithOneToFollow(a);
      await refusedWith(
        db.$executeRaw`UPDATE demand_aggregation SET status = 'REFERRED',
                         closed_at = ${new Date(T0.getTime() + HOUR)}, version = version + 1
                        WHERE id = ${agg.id}`,
        /ck_demand_aggregation_transition/,
      );
      const ready = await window(a);
      await join(a, ready, T0);
      await db.$transaction(ending(ready.id, 'READY', T0));
      await refusedWith(
        db.$executeRaw`UPDATE demand_aggregation SET status = 'CANCELLED',
                         closed_at = ${new Date(T0.getTime() + HOUR)},
                         cancelled_at = ${new Date(T0.getTime() + HOUR)}, cancelled_by = 'USR_1',
                         cancel_reason = 'the need went away', version = version + 1
                        WHERE id = ${ready.id}`,
        /ck_demand_aggregation_frozen/,
      );
    });

    it('writes a cancellation only by READY → CANCELLED, with who, when and why', async () => {
      const a = org();
      const open = await window(a);
      await join(a, open, T0);
      const later = new Date(T0.getTime() + HOUR);
      await refusedWith(
        db.$executeRaw`UPDATE demand_aggregation SET status = 'CANCELLED', closed_at = ${T0},
                         cancelled_at = ${later}, cancelled_by = 'USR_1',
                         cancel_reason = 'the need went away', version = version + 1
                        WHERE id = ${open.id}`,
        /ck_demand_aggregation_transition/,
      );
      await db.$transaction(ending(open.id, 'READY', T0));
      await refusedWith(
        db.$executeRaw`UPDATE demand_aggregation SET status = 'CANCELLED', version = version + 1
                        WHERE id = ${open.id}`,
        /ck_demand_aggregation_cancelled/,
      );
      await refusedWith(
        db.$executeRaw`UPDATE demand_aggregation SET status = 'CANCELLED', cancelled_at = ${later},
                         cancelled_by = 'USR_1', cancel_reason = 'short', version = version + 1
                        WHERE id = ${open.id}`,
        /ck_demand_aggregation_cancelled/,
      );
      await db.$executeRaw`UPDATE demand_aggregation SET status = 'CANCELLED', cancelled_at = ${later},
                             cancelled_by = 'USR_1', cancel_reason = 'the need went away',
                             version = version + 1 WHERE id = ${open.id}`;
      // A cancelled one is history: its reason never changes.
      await refusedWith(
        db.$executeRaw`UPDATE demand_aggregation SET cancel_reason = 'a better reason, later',
                         version = version + 1 WHERE id = ${open.id}`,
        /ck_demand_aggregation_transition/,
      );
    });

    /**
     * The digest moves phase by phase (PR-338 r1 F1, r2 F1): none on an OPEN window; begun by the
     * end from nothing; each batch exactly the ids after the last one taken, their bytes in the
     * state; written by the batch that takes the last id; never changed after. In r2 a runtime
     * write of a count on an OPEN window survived into the end, which kept it, so the digest
     * completed with ids never read.
     */
    describe('the digest of the demands a window ended with, phase by phase (PR-338 r2 F1)', () => {
      const MOVES_ONLY_WHILE_BUILT =
        /ck_demand_aggregation_digest: a digest's progress moves only while it is built/;
      const BEGUN_FROM_NOTHING =
        /ck_demand_aggregation_digest: a digest is begun only by the window's end, from nothing/;
      const FORWARD = /ck_demand_aggregation_digest: a digest only moves forward/;
      const EXACT_BATCH =
        /ck_demand_aggregation_digest: a batch of a digest takes exactly the ids it counts/;
      const LAST_BATCH =
        /ck_demand_aggregation_digest: a digest is written only by the batch that takes its last id/;

      /** An OPEN window of `n` demands, and their ids in byte order (ASCII: JS's sort is "C"). */
      async function openWith(a: string, n: number) {
        const agg = await window(a);
        const ids: string[] = [];
        for (let i = 0; i < n; i += 1) ids.push(await join(a, agg, T0));
        return { agg, ids: ids.sort() };
      }

      /** An OPEN window of `n` demands, ended READY with its digest begun, as `WindowEnd` ends it. */
      async function begun(a: string, n = 3) {
        const opened = await openWith(a, n);
        await db.$executeRaw`
          UPDATE demand_aggregation SET status = 'READY', closed_at = ${T0},
                 end_digest_state = ${FRESH}, version = version + 1 WHERE id = ${opened.agg.id}`;
        return opened;
      }

      /** The state after the first `k` ids, fed as `WindowEnd`'s batches feed them. */
      const stateAfter = (ids: string[], k: number) => {
        const hash = ResumableSha256.fresh();
        ids.slice(0, k).forEach((id, i) => hash.update(i === 0 ? id : `\n${id}`));
        return hash.save();
      };

      /** `state` with one byte flipped. */
      const flipped = (state: Buffer, at: number) => {
        const copy = Buffer.from(state);
        copy[at] = (copy[at] as number) ^ 0xff;
        return copy;
      };

      const rowOf = async (id: string) =>
        (
          await db.$queryRaw<{ counted: number; cursor: string | null; version: number }[]>`
            SELECT end_digest_counted AS counted, end_digest_cursor AS cursor, version
              FROM demand_aggregation WHERE id = ${id}`
        )[0];

      it('an OPEN window holds no progress of one: the r2 write of a count is refused, and none is born with one', async () => {
        const a = org();
        const { agg, ids } = await openWith(a, 3);
        // The r2 reproduction, scaled down: a count on an OPEN window of 3 (1000 of 3000 there).
        await refusedWith(
          db.$executeRaw`UPDATE demand_aggregation SET end_digest_counted = 1 WHERE id = ${agg.id}`,
          MOVES_ONLY_WHILE_BUILT,
        );
        await refusedWith(
          db.$executeRaw`UPDATE demand_aggregation SET end_digest_cursor = ${ids[0]}
                          WHERE id = ${agg.id}`,
          MOVES_ONLY_WHILE_BUILT,
        );
        await refusedWith(
          db.$executeRaw`UPDATE demand_aggregation SET demand_ids_sha256 = ${DIGEST}
                          WHERE id = ${agg.id}`,
          MOVES_ONLY_WHILE_BUILT,
        );
        await refusedWith(
          db.$executeRaw`UPDATE demand_aggregation SET end_digest_state = ${FRESH}
                          WHERE id = ${agg.id}`,
          BEGUN_FROM_NOTHING,
        );
        // Born with a count — or a state — is the CHECK's: an OPEN row holds none, whatever wrote it.
        const born = (column: 'end_digest_counted' | 'end_digest_state', value: number | Buffer) =>
          db.$executeRawUnsafe(
            eligibilityClockSql`INSERT INTO demand_aggregation
               (id, organization_id, product_id, status, opened_at, closes_at, window_hours,
                min_quantity, shortfall_policy, total_quantity, demand_count, extension_count,
                created_at, updated_at, ${column})
             VALUES ($1, $2, $3, 'OPEN', $4, $5, 10, 0, 'EXTEND', 1, 1, 0, $4, $4, $6)`,
            `AGG_${ulid()}`,
            a,
            newProductId(),
            T0,
            new Date(T0.getTime() + 10 * HOUR),
            value,
          );
        await refusedWith(born('end_digest_counted', 1), /ck_demand_aggregation_digest/);
        await refusedWith(born('end_digest_state', FRESH), /ck_demand_aggregation_digest/);
        expect(await rowOf(agg.id)).toEqual({ counted: 0, cursor: null, version: 4 });
        // Ended, a window holds its digest or one being built, never neither.
        await refusedWith(
          db.$executeRaw`UPDATE demand_aggregation SET status = 'READY', closed_at = ${T0},
                           version = version + 1 WHERE id = ${agg.id}`,
          /ck_demand_aggregation_digest/,
        );
      });

      it('none is born ended: the r3 terminal INSERT with a saved state is refused (PR-338 r3 F1)', async () => {
        const a = org();
        const productId = newProductId();
        const phantom = ResumableSha256.fresh().update('phantom').save();
        /** A row inserted as the runtime role, otherwise valid, with `extra` columns set. */
        const born = (status: string, extra: Record<string, unknown>) => {
          const columns = Object.keys(extra);
          return db.$executeRawUnsafe(
            eligibilityClockSql`INSERT INTO demand_aggregation
               (id, organization_id, product_id, status, opened_at, closes_at, window_hours,
                min_quantity, shortfall_policy, total_quantity, demand_count, extension_count,
                closed_at, created_at, updated_at${columns.map((column) => `, ${column}`).join('')})
             VALUES ($1, $2, $3, $4, $5, $6, 10, 0, 'EXTEND', 0, 0, 0, $7, $5, $5${columns
               .map((_, index) => `, $${index + 8}`)
               .join('')})`,
            `AGG_${ulid()}`,
            a,
            productId,
            status,
            T0,
            new Date(T0.getTime() + 10 * HOUR),
            status === 'OPEN' ? null : new Date(T0.getTime() + 10 * HOUR),
            ...Object.values(extra),
          );
        };
        // The review's reproduction: LAPSED, nothing counted, a state that already took "phantom".
        // The sweeper would have finished it and its end's event carried SHA-256("phantom").
        await refusedWith(
          born('LAPSED', { end_digest_state: phantom }),
          /ck_demand_aggregation_born_open/,
        );
        for (const status of ['READY', 'REFERRED', 'LAPSED', 'RFQ_ISSUED', 'CANCELLED']) {
          await refusedWith(born(status, {}), /ck_demand_aggregation_born_open/);
        }
        // Born OPEN, it carries no sweep and no cancellation either.
        await refusedWith(
          born('OPEN', { sweep_lease_until: T0, sweep_fence: 'FENCE' }),
          /ck_demand_aggregation_born_open/,
        );
        await refusedWith(born('OPEN', { sweep_attempts: 1 }), /ck_demand_aggregation_born_open/);
        await refusedWith(
          born('OPEN', { demand_ids_sha256: 'a'.repeat(64) }),
          /ck_demand_aggregation_digest/,
        );
        const rows = await db.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM demand_aggregation WHERE organization_id = ${a}`;
        expect(Number(rows[0]?.n)).toBe(0);
        // A clean OPEN row is born as the service writes it.
        await born('OPEN', {});
      });

      it('is begun only by the end, from nothing: the empty SHA-256, no id taken, no cursor', async () => {
        const a = org();
        const { agg, ids } = await openWith(a, 2);
        const end = (state: Buffer, counted: number, cursor: string | null) =>
          db.$executeRaw`UPDATE demand_aggregation SET status = 'READY', closed_at = ${T0},
                           end_digest_state = ${state}, end_digest_counted = ${counted},
                           end_digest_cursor = ${cursor}, version = version + 1
                          WHERE id = ${agg.id}`;
        await refusedWith(end(Buffer.alloc(40), 0, null), BEGUN_FROM_NOTHING);
        await refusedWith(end(FRESH, 1, null), BEGUN_FROM_NOTHING);
        await refusedWith(end(FRESH, 0, ids[0] as string), BEGUN_FROM_NOTHING);
        await refusedWith(end(stateAfter(ids, 1), 1, ids[0] as string), BEGUN_FROM_NOTHING);
        await end(FRESH, 0, null);
        expect(await rowOf(agg.id)).toEqual({ counted: 0, cursor: null, version: 4 });
      });

      it('each batch takes exactly the ids it counts, after the last one taken, their bytes in the state', async () => {
        const a = org();
        const { agg, ids } = await begun(a, 3);
        const batch = (state: Buffer, counted: number, cursor: string | null) =>
          db.$executeRaw`UPDATE demand_aggregation SET end_digest_state = ${state},
                           end_digest_counted = ${counted}, end_digest_cursor = ${cursor}
                          WHERE id = ${agg.id}`;
        const two = stateAfter(ids, 2);
        // Two ids are 61 bytes: no block completed, so the words are still the initial ones.
        expect(two.length).toBe(40 + 61);
        // Counted more than it took — the r2 count, mid-digest — or fewer than the range holds.
        await refusedWith(batch(stateAfter(ids, 1), 2, ids[0] as string), EXACT_BATCH);
        await refusedWith(batch(stateAfter(ids, 1), 1, ids[1] as string), EXACT_BATCH);
        // Its bytes not taken by the state, the incomplete block not their last bytes, the words
        // moved with no block completed, a cursor that is no id taken.
        await refusedWith(batch(stateAfter(ids, 1), 2, ids[1] as string), EXACT_BATCH);
        const claimsMore = Buffer.from(two);
        claimsMore.writeBigUInt64BE(BigInt(61 + 64), 32);
        await refusedWith(batch(claimsMore, 2, ids[1] as string), EXACT_BATCH);
        await refusedWith(batch(flipped(two, two.length - 1), 2, ids[1] as string), EXACT_BATCH);
        await refusedWith(batch(flipped(two, 0), 2, ids[1] as string), EXACT_BATCH);
        await refusedWith(batch(two, 2, `${ids[1]}Z`), EXACT_BATCH);
        // The batch as `WindowEnd` stores it: bookkeeping, no version.
        await batch(two, 2, ids[1] as string);
        expect(await rowOf(agg.id)).toEqual({ counted: 2, cursor: ids[1], version: 5 });
        // Never again from the start, never back, never a count without ids.
        await refusedWith(batch(FRESH, 0, null), FORWARD);
        await refusedWith(batch(stateAfter(ids, 1), 1, ids[0] as string), FORWARD);
        await refusedWith(batch(two, 3, ids[1] as string), FORWARD);
        await refusedWith(batch(flipped(two, 0), 2, ids[1] as string), FORWARD);
        // A claim beside it is still bookkeeping.
        await eligibilityClockWrite(db)`UPDATE demand_aggregation SET sweep_lease_until = ${T0},
                               sweep_fence = 'F1' WHERE id = ${agg.id}`;
        expect(await rowOf(agg.id)).toEqual({ counted: 2, cursor: ids[1], version: 5 });
      });

      it('is written only by the batch that takes its last id, with the window’s count, and never changes after', async () => {
        const a = org();
        const { agg, ids } = await begun(a, 3);
        await db.$executeRaw`UPDATE demand_aggregation SET end_digest_state = ${stateAfter(ids, 1)},
                               end_digest_counted = 1, end_digest_cursor = ${ids[0]}
                              WHERE id = ${agg.id}`;
        const written = (counted: number) =>
          db.$executeRaw`UPDATE demand_aggregation SET demand_ids_sha256 = ${DIGEST},
                           end_digest_state = NULL, end_digest_cursor = NULL,
                           end_digest_counted = ${counted} WHERE id = ${agg.id}`;
        await refusedWith(written(2), LAST_BATCH);
        await refusedWith(
          db.$executeRaw`UPDATE demand_aggregation SET end_digest_state = NULL WHERE id = ${agg.id}`,
          LAST_BATCH,
        );
        // Every id taken, but no digest written; or written as the window moves on in the same
        // statement — the end's event is not out before the transaction that writes it.
        await refusedWith(
          db.$executeRaw`UPDATE demand_aggregation SET end_digest_state = NULL,
                           end_digest_cursor = NULL, end_digest_counted = 3 WHERE id = ${agg.id}`,
          LAST_BATCH,
        );
        await refusedWith(
          db.$executeRaw`UPDATE demand_aggregation SET demand_ids_sha256 = ${DIGEST},
                           end_digest_state = NULL, end_digest_cursor = NULL,
                           end_digest_counted = 3, status = 'CANCELLED', cancelled_at = ${T0},
                           cancelled_by = 'USR_1', cancel_reason = 'the need went away',
                           version = version + 1 WHERE id = ${agg.id}`,
          LAST_BATCH,
        );
        await written(3);
        expect(await rowOf(agg.id)).toEqual({ counted: 3, cursor: null, version: 5 });
        await refusedWith(
          db.$executeRaw`UPDATE demand_aggregation SET demand_ids_sha256 = ${'1'.repeat(64)}
                          WHERE id = ${agg.id}`,
          MOVES_ONLY_WHILE_BUILT,
        );
        await refusedWith(
          db.$executeRaw`UPDATE demand_aggregation SET end_digest_counted = 2 WHERE id = ${agg.id}`,
          MOVES_ONLY_WHILE_BUILT,
        );
        await refusedWith(
          db.$executeRaw`UPDATE demand_aggregation SET demand_ids_sha256 = NULL,
                           end_digest_state = ${FRESH} WHERE id = ${agg.id}`,
          BEGUN_FROM_NOTHING,
        );
        await refusedWith(
          db.$executeRaw`UPDATE demand_aggregation SET demand_ids_sha256 = 'ABC',
                           end_digest_state = NULL WHERE id = ${agg.id}`,
          /ck_demand_aggregation_digest/,
        );
      });

      it('refuses the last batch of a digest whose count ran ahead of its ids, however that count got there', async () => {
        // The r2 state, planted by the owner with the guard lifted (the runtime role cannot write
        // it any more): 2 of 3 counted, nothing taken. The end's batch then reads one id, reaches
        // the window's count and writes the digest — of one id. Refused: 3 ids are left after the
        // cursor, not 1.
        const a = org();
        const { agg, ids } = await begun(a, 3);
        const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
        const unguarded = (write: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          owner.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
              'ALTER TABLE "demand_aggregation" DISABLE TRIGGER "tg_demand_aggregation_guard"',
            );
            await write(tx);
            await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
            await tx.$executeRawUnsafe(
              'ALTER TABLE "demand_aggregation" ENABLE TRIGGER "tg_demand_aggregation_guard"',
            );
          });
        try {
          // Even with the guard lifted, the CHECK holds a written digest to the window's count.
          await refusedWith(
            unguarded(
              (tx) => tx.$executeRaw`UPDATE demand_aggregation SET demand_ids_sha256 = ${DIGEST},
                                       end_digest_state = NULL, end_digest_counted = 2
                                      WHERE id = ${agg.id}`,
            ),
            /ck_demand_aggregation_digest/,
          );
          await unguarded(
            (tx) => tx.$executeRaw`UPDATE demand_aggregation SET end_digest_counted = 2
                                    WHERE id = ${agg.id}`,
          );
        } finally {
          await owner.$disconnect();
        }
        await refusedWith(
          db.$executeRaw`UPDATE demand_aggregation SET demand_ids_sha256 = ${DIGEST},
                           end_digest_state = NULL, end_digest_counted = 3 WHERE id = ${agg.id}`,
          LAST_BATCH,
        );
        // Nor can a batch catch the count up without the ids it skipped.
        await refusedWith(
          db.$executeRaw`UPDATE demand_aggregation SET end_digest_state = ${stateAfter(ids, 1)},
                           end_digest_counted = 3, end_digest_cursor = ${ids[0]}
                          WHERE id = ${agg.id}`,
          EXACT_BATCH,
        );
      });

      it('nothing moves a window on before its end’s event: no cancellation while its digest is built', async () => {
        const a = org();
        const { agg } = await begun(a, 1);
        await refusedWith(
          db.$executeRaw`UPDATE demand_aggregation SET status = 'CANCELLED',
                           cancelled_at = ${T0}, cancelled_by = 'USR_1',
                           cancel_reason = 'the need went away', version = version + 1
                          WHERE id = ${agg.id}`,
          /ck_demand_aggregation_digest/,
        );
      });
    });
  });
});
