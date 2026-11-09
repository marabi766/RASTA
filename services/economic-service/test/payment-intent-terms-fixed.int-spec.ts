import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  cleanup,
  databaseUrl,
  newPrisma,
  ownerDatabaseUrl,
  plantPaymentIntent,
  tenants,
} from './helpers';

/**
 * A payment intent's terms never change once written, it is never erased, and its lifecycle moves
 * only along the service's edges, on the service's evidence (FU-230, #1017 r1; migration
 * 20261109130000_payment_intent_terms_fixed). Written by hand as the runtime role, around the
 * service: every refusal here is a write the service never makes, and each `control` is one it does.
 */
jest.setTimeout(60_000);

const FIXED = /A payment intent's amount, currency, wallet and terms never change once written/;
const STEP = /A payment intent does not move /;
const ONCE = /is written once, by its own step/;
const BORN = /A payment intent is written CREATED, with nothing done yet/;
const ERASED = /A payment intent is never erased \(DELETE refused\)/;
const PROVENANCE = /A payment intent names only the transaction its own capture recorded/;
const UNTRACKED = /only while a reconciliation task is open on it/;
const UNRESOLVED = /only as its reconciliation task is finished with that outcome/;

type Sql = Pick<PrismaClient, '$executeRawUnsafe'>;

describe('a payment intent’s terms are fixed and its lifecycle evidenced (real database)', () => {
  let runtime: PrismaClient;
  let owner: PrismaClient;
  let prisma: PrismaService;
  const org = tenants();

  beforeAll(() => {
    runtime = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    prisma = newPrisma();
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await Promise.all([runtime.$disconnect(), owner.$disconnect(), prisma.onModuleDestroy()]);
  });

  /** A CREATED intent, as the service writes one; its id. */
  const created = async (organizationId = org.a) => {
    const id = `PAY_${ulid()}`;
    await runtime.$executeRawUnsafe(
      `INSERT INTO payment_intent (id, organization_id, wallet_id, provider, amount_minor, currency,
         idempotency_key, request_hash, correlation_id, created_by, created_by_issuer, created_by_subject)
       VALUES ($1, $2, $3, 'mock', 1000, 'IRR', $4, $5, 'itest', 'USR-ITEST', 'http://itest.invalid', 'SUB-ITEST')`,
      id,
      organizationId,
      `WLT_${ulid()}`,
      `KEY-${id}`,
      'a'.repeat(64),
    );
    return id;
  };

  const update = (id: string, set: string, ...params: unknown[]) =>
    runtime.$executeRawUnsafe(`UPDATE payment_intent SET ${set} WHERE id = $1`, id, ...params);

  /** A WALLET_TOP_UP as the capture records it (`completeCapture`), or as a probe varies it. */
  const topUp = async (
    intentId: string,
    { organizationId = org.a, amount = 1000, currency = 'IRR', source = 'PAYMENT_INTENT' } = {},
  ) => {
    const id = `TXN_${ulid()}`;
    await runtime.$executeRawUnsafe(
      `INSERT INTO "transaction" (id, organization_id, transaction_type, status, gross_amount_minor,
         net_amount_minor, currency, occurred_at, source_type, source_reference, correlation_id,
         created_by, updated_at)
       VALUES ($1, $2, 'WALLET_TOP_UP', 'CREATED', $3, $3, $4, now(), $5, $6, 'itest', 'USR-ITEST', now())`,
      id,
      organizationId,
      amount,
      currency,
      source,
      intentId,
    );
    return id;
  };

  /** An open reconciliation task on the intent, as `reconciliation.open` writes one; its id. */
  const task = async (
    intentId: string,
    kind: 'REFUND' | 'UNCREDITED_REFUND',
    sql: Sql = runtime,
  ) => {
    const id = `PRT_${ulid()}`;
    await sql.$executeRawUnsafe(
      `INSERT INTO payment_reconciliation_task (id, organization_id, payment_intent_id, kind,
         next_attempt_at, correlation_id, created_at, updated_at)
       SELECT $1, organization_id, id, $3::"PaymentReconciliationKind", now(), 'itest', now(), now()
         FROM payment_intent WHERE id = $2`,
      id,
      intentId,
      kind,
    );
    return id;
  };

  /** The task finished, as `close` / `finish` write it. */
  const finish = (sql: Sql, taskId: string, resolution: string) =>
    sql.$executeRawUnsafe(
      `UPDATE payment_reconciliation_task
          SET status = 'DONE', done_at = now(), updated_at = now(), resolution = $2, resolved_by = 'itest'
        WHERE id = $1`,
      taskId,
      resolution,
    );

  const authorized = async (organizationId = org.a) => {
    const id = await created(organizationId);
    await update(id, `status = 'AUTHORIZED', authorized_at = now(), provider_reference = 'PSP-1'`);
    return id;
  };

  const captured = async () => {
    const id = await authorized();
    await update(
      id,
      `status = 'CAPTURED', captured_at = now(), transaction_id = $2`,
      await topUp(id),
    );
    return id;
  };

  /** A CAPTURED intent whose refund is under `marker`, with its open task. */
  const refunding = async (marker: string) => {
    const id = await captured();
    const taskId = await task(id, 'REFUND');
    await update(id, `failure_reason = 'REFUND_REQUESTED'`);
    if (marker !== 'REFUND_REQUESTED') await update(id, `failure_reason = $2`, marker);
    return { id, taskId };
  };

  /** An AUTHORIZED intent whose capture is uncredited and its refund unanswered (U6). */
  const refundUnknown = async () => {
    const id = await authorized();
    const taskId = await task(id, 'UNCREDITED_REFUND');
    await update(id, `failure_reason = 'CAPTURED_REFUND_UNKNOWN'`);
    return { id, taskId };
  };

  const statusOf = async (id: string) => {
    const [row] = await owner.$queryRawUnsafe<{ status: string; reason: string | null }[]>(
      'SELECT status::text AS status, failure_reason AS reason FROM payment_intent WHERE id = $1',
      id,
    );
    return row;
  };

  describe('controls: each edge the service takes, on its evidence', () => {
    it('a top-up captured after a declined refund, then refunded', async () => {
      const id = await authorized();
      await update(id, `failure_reason = 'CAPTURED_NOT_CREDITED'`);
      const txn = await topUp(id);
      await update(
        id,
        `status = 'CAPTURED', captured_at = now(), transaction_id = $2, failure_reason = NULL`,
        txn,
      );
      const taskId = await task(id, 'REFUND');
      await update(id, `failure_reason = 'REFUND_REQUESTED'`);
      await runtime.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE payment_intent SET status = 'REFUNDED', refunded_at = now(), failure_reason = NULL
            WHERE id = $1`,
          id,
        );
        await finish(tx, taskId, 'REFUNDED');
      });
      // Writing a written-once column again with the same value changes nothing: no rewrite.
      await update(id, `provider_reference = 'PSP-1', transaction_id = $2`, txn);
      expect(await statusOf(id)).toEqual({ status: 'REFUNDED', reason: null });
    });

    it.each([
      [
        'REFUND_UNKNOWN',
        'REFUNDED',
        `status = 'REFUNDED', refunded_at = now(), failure_reason = NULL`,
      ],
      [
        'REFUNDED_NOT_REVERSED',
        'REFUNDED',
        `status = 'REFUNDED', refunded_at = now(), failure_reason = NULL`,
      ],
      ['REFUND_UNKNOWN', 'REFUND_NOT_REACHED', `failure_reason = NULL`],
      ['REFUND_DECLINED_RELEASE_PENDING', 'REFUND_DECLINED', `failure_reason = NULL`],
      ['REFUND_REQUESTED', 'REFUND_DECLINED', `failure_reason = NULL`],
    ])('a refund under %s resolved %s', async (marker, resolution, set) => {
      const { id, taskId } = await refunding(marker);
      await runtime.$transaction(async (tx) => {
        await finish(tx, taskId, resolution);
        await tx.$executeRawUnsafe(`UPDATE payment_intent SET ${set} WHERE id = $1`, id);
      });
      expect((await statusOf(id))!.reason).toBeNull();
    });

    it.each([
      ['UNCREDITED_DECLINED', `failure_reason = 'CAPTURED_NOT_CREDITED'`, 'AUTHORIZED'],
      ['UNCREDITED_NOT_REACHED', `failure_reason = 'CAPTURED_NOT_CREDITED'`, 'AUTHORIZED'],
      [
        'UNCREDITED_REFUNDED',
        `status = 'FAILED', failed_at = now(), failure_reason = 'CAPTURE_NOT_CREDITED'`,
        'FAILED',
      ],
    ])('an unanswered uncredited refund resolved %s', async (resolution, set, status) => {
      const { id, taskId } = await refundUnknown();
      await runtime.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE payment_intent SET ${set} WHERE id = $1`, id);
        await finish(tx, taskId, resolution);
      });
      expect((await statusOf(id))!.status).toBe(status);
    });

    it('a failure is recorded, before or after the authorization', async () => {
      await expect(
        update(
          await created(),
          `status = 'FAILED', failed_at = now(), failure_reason = 'DECLINED'`,
        ),
      ).resolves.toBe(1);
      await expect(
        update(
          await authorized(),
          `status = 'FAILED', failed_at = now(), failure_reason = 'CAPTURE_DECLINED'`,
        ),
      ).resolves.toBe(1);
    });
  });

  describe('review probe F1: a marker is not financial evidence on its own', () => {
    it('CAPTURED_REFUND_UNKNOWN → CAPTURED_NOT_CREDITED by the marker alone is refused', async () => {
      const { id } = await refundUnknown();
      await expect(update(id, `failure_reason = 'CAPTURED_NOT_CREDITED'`)).rejects.toThrow(
        UNRESOLVED,
      );
      expect(await statusOf(id)).toEqual({
        status: 'AUTHORIZED',
        reason: 'CAPTURED_REFUND_UNKNOWN',
      });
    });

    it.each([
      ['finished in an earlier transaction', 'UNCREDITED_DECLINED', true],
      [
        'finished with an outcome that is not the move (UNCREDITED_REFUNDED)',
        'UNCREDITED_REFUNDED',
        false,
      ],
    ])('nor with its task %s', async (_case, resolution, earlier) => {
      const { id, taskId } = await refundUnknown();
      if (earlier) await finish(runtime, taskId, resolution);
      await expect(
        runtime.$transaction(async (tx) => {
          if (!earlier) await finish(tx, taskId, resolution);
          await tx.$executeRawUnsafe(
            `UPDATE payment_intent SET failure_reason = 'CAPTURED_NOT_CREDITED' WHERE id = $1`,
            id,
          );
        }),
      ).rejects.toThrow(UNRESOLVED);
    });

    it('nor with a task of the other kind (REFUND) finished in the same transaction', async () => {
      const { id, taskId } = await refundUnknown();
      // One open task per intent: its own goes first, earlier, as in the case above.
      await finish(runtime, taskId, 'UNCREDITED_DECLINED');
      await expect(
        runtime.$transaction(async (tx) => {
          await finish(tx, await task(id, 'REFUND', tx), 'UNCREDITED_DECLINED');
          await tx.$executeRawUnsafe(
            `UPDATE payment_intent SET failure_reason = 'CAPTURED_NOT_CREDITED' WHERE id = $1`,
            id,
          );
        }),
      ).rejects.toThrow(UNRESOLVED);
    });

    it.each(['REFUND_DECLINED_RELEASE_PENDING', 'REFUNDED_NOT_REVERSED'])(
      'REFUND_UNKNOWN → %s (an outcome the provider never gave) is refused',
      async (marker) => {
        const { id } = await refunding('REFUND_UNKNOWN');
        await expect(update(id, `failure_reason = $2`, marker)).rejects.toThrow(STEP);
      },
    );

    it.each([
      ['REFUND_UNKNOWN', `status = 'REFUNDED', refunded_at = now(), failure_reason = NULL`],
      ['REFUND_REQUESTED', `status = 'REFUNDED', refunded_at = now(), failure_reason = NULL`],
      ['REFUNDED_NOT_REVERSED', `status = 'REFUNDED', refunded_at = now(), failure_reason = NULL`],
      ['REFUND_UNKNOWN', `failure_reason = NULL`],
      ['REFUND_DECLINED_RELEASE_PENDING', `failure_reason = NULL`],
    ])('leaving %s without finishing its task (%s) is refused', async (marker, set) => {
      const { id } = await refunding(marker);
      await expect(update(id, set)).rejects.toThrow(UNRESOLVED);
    });

    it('nor leaving CAPTURED_REFUND_UNKNOWN for FAILED', async () => {
      const { id } = await refundUnknown();
      await expect(
        update(id, `status = 'FAILED', failed_at = now(), failure_reason = 'CAPTURE_NOT_CREDITED'`),
      ).rejects.toThrow(UNRESOLVED);
    });

    it.each([
      [
        'REFUND_REQUESTED on a CAPTURED intent',
        'CAPTURED',
        `failure_reason = 'REFUND_REQUESTED'`,
        null,
      ],
      [
        'CAPTURED_REFUND_UNKNOWN with no task',
        'AUTHORIZED',
        `failure_reason = 'CAPTURED_REFUND_UNKNOWN'`,
        null,
      ],
      [
        'CAPTURED_REFUND_UNKNOWN beside a REFUND task',
        'AUTHORIZED',
        `failure_reason = 'CAPTURED_REFUND_UNKNOWN'`,
        'REFUND',
      ],
    ] as const)('a tracked marker is not entered untracked: %s', async (_case, from, set, kind) => {
      const id = from === 'CAPTURED' ? await captured() : await authorized();
      if (kind) await task(id, kind);
      await expect(update(id, set)).rejects.toThrow(UNTRACKED);
    });
  });

  describe('review probe F1: status and markers move only forward, along an edge', () => {
    it.each([
      ['REFUNDED', `status = 'CREATED'`],
      ['REFUNDED', `status = 'CAPTURED', failure_reason = 'REFUND_REQUESTED'`],
      ['REFUNDED', `status = 'FAILED', failed_at = now(), failure_reason = 'X'`],
      ['CAPTURED', `status = 'AUTHORIZED'`],
      ['CAPTURED', `status = 'CREATED'`],
      ['CAPTURED', `status = 'FAILED', failed_at = now(), failure_reason = 'X'`],
      ['CAPTURED', `status = 'REFUNDED', refunded_at = now()`],
      ['CAPTURED', `failure_reason = 'DECLINED'`],
      ['CAPTURED', `failure_reason = 'CAPTURED_NOT_CREDITED'`],
      ['FAILED', `status = 'AUTHORIZED', authorized_at = now()`],
      ['FAILED', `failure_reason = 'CAPTURED_NOT_CREDITED'`],
      ['AUTHORIZED', `status = 'CREATED'`],
      ['AUTHORIZED', `failure_reason = 'REFUND_REQUESTED'`],
      [
        'AUTHORIZED',
        `status = 'FAILED', failed_at = now(), failure_reason = 'CAPTURED_NOT_CREDITED'`,
      ],
      ['CREATED', `status = 'CAPTURED', authorized_at = now(), captured_at = now()`],
      ['CREATED', `status = 'REFUNDED', captured_at = now(), refunded_at = now()`],
      ['CREATED', `failure_reason = 'CAPTURED_NOT_CREDITED'`],
    ])('%s: %s is refused', async (from, set) => {
      const id =
        from === 'CREATED'
          ? await created()
          : from === 'AUTHORIZED'
            ? await authorized()
            : from === 'CAPTURED'
              ? await captured()
              : null;
      let row = id;
      if (from === 'FAILED') {
        row = await created();
        await update(row, `status = 'FAILED', failed_at = now(), failure_reason = 'DECLINED'`);
      }
      if (from === 'REFUNDED') {
        const made = await refunding('REFUND_REQUESTED');
        await runtime.$transaction(async (tx) => {
          await finish(tx, made.taskId, 'REFUNDED');
          await tx.$executeRawUnsafe(
            `UPDATE payment_intent SET status = 'REFUNDED', refunded_at = now(), failure_reason = NULL WHERE id = $1`,
            made.id,
          );
        });
        row = made.id;
      }
      await expect(update(row!, set)).rejects.toThrow(STEP);
    });
  });

  describe('review probe F1: an instant is written once, by its own step', () => {
    it.each([
      ['AUTHORIZED', `authorized_at = authorized_at - interval '1 day'`],
      ['AUTHORIZED', `failed_at = now() + interval '1 year'`],
      ['AUTHORIZED', `refunded_at = now()`],
      ['CAPTURED', `captured_at = NULL, status = 'CAPTURED'`],
      ['CAPTURED', `authorized_at = now() + interval '1 year'`],
      ['CAPTURED', `failure_reason = 'REFUND_REQUESTED', captured_at = now()`],
    ])('%s: %s is refused', async (from, set) => {
      const id = from === 'AUTHORIZED' ? await authorized() : await captured();
      if (from === 'CAPTURED') await task(id, 'REFUND');
      await expect(update(id, set)).rejects.toThrow(ONCE);
    });

    it('a step writes its own column, not nothing: a capture names its transaction', async () => {
      const id = await authorized();
      await expect(update(id, `status = 'CAPTURED', captured_at = now()`)).rejects.toThrow(ONCE);
    });
  });

  describe('review probe F1: transaction_id is the capture’s own transaction', () => {
    it.each([
      ['a transaction that does not exist', async () => `TXN_${ulid()}`],
      [
        'another tenant’s top-up of this intent',
        async (id: string) => topUp(id, { organizationId: org.b }),
      ],
      ['the top-up of another intent', async () => topUp(`PAY_${ulid()}`)],
      ['a top-up of another amount', async (id: string) => topUp(id, { amount: 999 })],
      ['a top-up in another currency', async (id: string) => topUp(id, { currency: 'USD' })],
    ])('naming %s is refused at commit', async (_case, transactionOf) => {
      const id = await authorized();
      const txn = await transactionOf(id);
      await expect(
        update(id, `status = 'CAPTURED', captured_at = now(), transaction_id = $2`, txn),
      ).rejects.toThrow(PROVENANCE);
      expect((await statusOf(id))!.status).toBe('AUTHORIZED');
    });

    it('nor is it assigned to an intent already CAPTURED without one (same status)', async () => {
      const id = await authorized();
      await plantPaymentIntent(
        `UPDATE payment_intent SET status = 'CAPTURED', captured_at = now() WHERE id = $1`,
        id,
      );
      await expect(update(id, `transaction_id = $2`, await topUp(id))).rejects.toThrow(ONCE);
    });

    it('nor on a CREATED or AUTHORIZED intent', async () => {
      const id = await created();
      const txn = await topUp(id);
      await expect(update(id, `transaction_id = $2`, txn)).rejects.toThrow(ONCE);
      await update(
        id,
        `status = 'AUTHORIZED', authorized_at = now(), provider_reference = 'PSP-1'`,
      );
      await expect(update(id, `transaction_id = $2`, txn)).rejects.toThrow(ONCE);
    });

    it.each([
      ['transaction_id', `transaction_id = 'TXN_OTHER'`, `transaction_id = NULL`],
      ['provider_reference', `provider_reference = 'PSP-OTHER'`, `provider_reference = NULL`],
    ])('%s, once written, is never rewritten or erased', async (_column, rewrite, erase) => {
      const id = await captured();
      await expect(update(id, rewrite)).rejects.toThrow(ONCE);
      await expect(update(id, erase)).rejects.toThrow(ONCE);
    });
  });

  describe('review probe F1: an INSERT or an upsert plants no later state', () => {
    it.each([
      ['CAPTURED', `'CAPTURED', NULL, now(), now(), NULL`],
      ['a marker', `'CREATED', 'CAPTURED_NOT_CREDITED', NULL, NULL, NULL`],
      ['an instant', `'CREATED', NULL, now(), NULL, NULL`],
      ['a provider reference', `'CREATED', NULL, NULL, NULL, 'PSP-1'`],
    ])('an intent born with %s is refused', async (_case, values) => {
      const id = `PAY_${ulid()}`;
      await expect(
        runtime.$executeRawUnsafe(
          `INSERT INTO payment_intent (id, organization_id, wallet_id, provider, amount_minor, currency,
             idempotency_key, request_hash, correlation_id, created_by, created_by_issuer, created_by_subject,
             status, failure_reason, authorized_at, captured_at, provider_reference)
           VALUES ($1, $2, 'WLT_X', 'mock', 1000, 'IRR', $1, $3, 'itest', 'USR-ITEST', 'http://itest.invalid',
                   'SUB-ITEST', ${values})`,
          id,
          org.a,
          'a'.repeat(64),
        ),
      ).rejects.toThrow(BORN);
    });

    it('nor born naming a transaction, even its own top-up', async () => {
      const id = `PAY_${ulid()}`;
      const txn = await topUp(id);
      await expect(
        runtime.$executeRawUnsafe(
          `INSERT INTO payment_intent (id, organization_id, wallet_id, provider, amount_minor, currency,
             idempotency_key, request_hash, correlation_id, created_by, transaction_id)
           VALUES ($1, $2, 'WLT_X', 'mock', 1000, 'IRR', $1, $3, 'itest', 'USR-ITEST', $4)`,
          id,
          org.a,
          'a'.repeat(64),
          txn,
        ),
      ).rejects.toThrow(BORN);
    });

    it('an upsert onto an existing intent is an UPDATE, and moves nothing backwards', async () => {
      const id = await captured();
      await expect(
        runtime.$executeRawUnsafe(
          `INSERT INTO payment_intent (id, organization_id, wallet_id, provider, amount_minor, currency,
             idempotency_key, request_hash, correlation_id, created_by)
           VALUES ($1, $2, 'WLT_X', 'mock', 1000, 'IRR', $1, $3, 'itest', 'USR-ITEST')
           ON CONFLICT (id) DO UPDATE SET status = 'AUTHORIZED'`,
          id,
          org.a,
          'a'.repeat(64),
        ),
      ).rejects.toThrow(STEP);
    });
  });

  describe('terms', () => {
    it.each([
      ['amount_minor', `amount_minor = 999999`],
      ['currency', `currency = 'USD'`],
      ['wallet_id', `wallet_id = 'WLT_SOMEONE_ELSES'`],
      ['organization_id', `organization_id = organization_id || '-X'`],
      ['provider', `provider = 'other'`],
      ['simulated', `simulated = false`],
      ['idempotency_key', `idempotency_key = 'KEY-OTHER'`],
      ['request_hash', `request_hash = NULL`],
      ['correlation_id', `correlation_id = 'other'`],
      ['created_at', `created_at = created_at - interval '1 day'`],
      ['created_by', `created_by = 'USR-OTHER'`],
      ['the creator identity', `created_by_issuer = NULL, created_by_subject = NULL`],
      ['id', `id = id || 'X'`],
    ])('a change of %s is refused, whatever the status', async (_column, set) => {
      const id = await created();
      await expect(update(id, set)).rejects.toThrow(FIXED);
      // Beside a lifecycle step, all the same.
      await expect(
        update(
          id,
          `status = 'AUTHORIZED', authorized_at = now(), provider_reference = 'P', ${set}`,
        ),
      ).rejects.toThrow(FIXED);
    });

    it('a payment intent is never deleted', async () => {
      const id = await created();
      await expect(
        runtime.$executeRawUnsafe('DELETE FROM payment_intent WHERE id = $1', id),
      ).rejects.toThrow(ERASED);
    });

    it('nor truncated: the statement trigger stands, enabled, on the table', async () => {
      const [row] = await owner.$queryRawUnsafe<{ def: string; enabled: string }[]>(
        `SELECT pg_get_triggerdef(t.oid) AS def, t.tgenabled::text AS enabled
           FROM pg_trigger t
          WHERE t.tgrelid = 'payment_intent'::regclass AND t.tgname = 'trg_payment_intent_no_truncate'`,
      );
      expect(row?.def).toMatch(
        /BEFORE TRUNCATE ON \S*payment_intent FOR EACH STATEMENT EXECUTE FUNCTION \S*reject_payment_intent_rewrite\(\)/,
      );
      expect(row?.enabled).toBe('O');
    });
  });

  describe('review probe F2: no session path moves the comparison', () => {
    it('the row rule pins its own path to the catalogue, temporary relations last', async () => {
      const [row] = await owner.$queryRawUnsafe<{ config: string[] }[]>(
        `SELECT proconfig AS config FROM pg_proc WHERE proname = 'reject_payment_intent_rewrite'`,
      );
      expect(row?.config).toEqual(['search_path=pg_catalog, pg_temp']);
    });

    it('an owner session that puts an always-equal = before pg_catalog changes neither rule', async () => {
      const id = await authorized();
      const shadow = `w_shadow_${ulid().toLowerCase()}`;
      const outcomes = await owner
        .$transaction(async (tx) => {
          // The review's trigger: `=(jsonb,jsonb)` and `=(text,text)` that answer true, first.
          await tx.$executeRawUnsafe(`CREATE SCHEMA ${shadow}`);
          for (const type of ['jsonb', 'text']) {
            await tx.$executeRawUnsafe(
              `CREATE FUNCTION ${shadow}.yes(${type}, ${type}) RETURNS boolean LANGUAGE sql AS 'SELECT true'`,
            );
            await tx.$executeRawUnsafe(
              `CREATE OPERATOR ${shadow}.= (LEFTARG = ${type}, RIGHTARG = ${type}, FUNCTION = ${shadow}.yes)`,
            );
          }
          await tx.$executeRawUnsafe(`SET LOCAL search_path = ${shadow}, pg_catalog, public`);
          await tx.$executeRawUnsafe(`SET CONSTRAINTS trg_payment_intent_evidenced IMMEDIATE`);
          const attempt = (sql: string, ...params: unknown[]) =>
            tx
              .$executeRawUnsafe(`SAVEPOINT probe`)
              .then(() => tx.$executeRawUnsafe(sql, ...params))
              .then(
                () => 'accepted',
                (error: Error) => error.message,
              )
              .finally(() => tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT probe`));
          const result = [
            // The probe's own key named by pg_catalog's `=`, or the shadow matches every row.
            await attempt(
              `UPDATE payment_intent SET amount_minor = 1 WHERE id OPERATOR(pg_catalog.=) $1`,
              id,
            ),
            await attempt(
              `UPDATE payment_intent SET status = 'CAPTURED', captured_at = now(), transaction_id = 'TXN_NONE'
                WHERE id OPERATOR(pg_catalog.=) $1`,
              id,
            ),
          ];
          throw Object.assign(new Error('rolled back'), { result });
        })
        .catch((error: { result?: string[] }) => error.result);
      expect(outcomes?.[0]).toMatch(FIXED);
      expect(outcomes?.[1]).toMatch(PROVENANCE);
    });
  });
});
