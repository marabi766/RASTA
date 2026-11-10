import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  asActor,
  cleanup,
  databaseUrl,
  newPrisma,
  ownerDatabaseUrl,
  plantPaymentIntent,
  tenants,
  wire,
} from './helpers';

/**
 * A payment intent's terms never change once written, it is never erased, and its lifecycle moves
 * only along the service's edges, on evidence nobody can take back: the provider's recorded answer
 * or an approved operator resolution, bound to the task its decision finished (FU-230, #1017 r1,
 * r3; migration 20261109130000_payment_intent_terms_fixed). Written by hand as the runtime role, around the
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
const UNRESOLVED = /only as its reconciliation task is decided on the provider's recorded answer/;
const UNCREDITABLE = /CAPTURED_NOT_CREDITED only on the provider's recorded decline/;
const DECIDED = /A reconciliation task is finished only by its decision/;
const ANSWER_KEPT = /A provider's answer is kept as it was recorded/;
const DECISION_KEPT = /A reconciliation decision is kept as it was made/;

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
    await Promise.all([runtime.$disconnect(), owner.$disconnect(), prisma.stop()]);
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

  /** An open reconciliation task on the intent, written by the service's own `open`; its id. */
  const task = async (intentId: string, kind: 'REFUND' | 'UNCREDITED_REFUND') => {
    const [intent] = await owner.$queryRawUnsafe<{ organizationId: string }[]>(
      'SELECT organization_id AS "organizationId" FROM payment_intent WHERE id = $1',
      intentId,
    );
    const { organizationId } = intent!;
    await asActor({ organizationId }, () =>
      prisma.transaction((tx) =>
        wire(prisma).paymentReconciliation.open(tx, {
          organizationId,
          paymentIntentId: intentId,
          kind,
          outcome: 'ITEST',
          due: 'NOW',
        }),
      ),
    );
    const [row] = await owner.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM payment_reconciliation_task WHERE payment_intent_id = $1 AND status <> 'DONE'`,
      intentId,
    );
    return row!.id;
  };

  /** The task finished, as `close` / `finish` write it: by its decision. */
  const finish = (sql: Sql, taskId: string, resolution: string) =>
    sql.$executeRawUnsafe(
      `INSERT INTO payment_reconciliation_decision
            (organization_id, task_id, payment_intent_id, resolution, decided_by)
       SELECT organization_id, id, payment_intent_id, $2, 'itest' FROM payment_reconciliation_task
        WHERE id = $1`,
      taskId,
      resolution,
    );

  /** The provider's answer to the intent's refund attempt, as `recordOutcome` keeps it. */
  const answer = (
    sql: Sql,
    intentId: string,
    kind: 'REFUND' | 'UNCREDITED_REFUND',
    outcome: 'REFUNDED' | 'DECLINED' | 'NOT_REACHED',
    suffix = kind === 'REFUND' ? ':refund' : ':uncredited',
  ) =>
    sql.$executeRawUnsafe(
      `INSERT INTO payment_provider_outcome
            (organization_id, payment_intent_id, kind, attempt_key, outcome)
       SELECT organization_id, id, $2::"PaymentReconciliationKind", idempotency_key || $3, $4
         FROM payment_intent WHERE id = $1
       ON CONFLICT DO NOTHING`,
      intentId,
      kind,
      suffix,
      outcome,
    );

  /** What a resolution code says the provider did. */
  const outcomeOf = (resolution: string) =>
    resolution.replace(/^(UNCREDITED|REFUND)_/, '') as 'REFUNDED' | 'DECLINED' | 'NOT_REACHED';

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
    // A known outcome is entered on the provider's answer, recorded first.
    if (marker === 'REFUNDED_NOT_REVERSED') await answer(runtime, id, 'REFUND', 'REFUNDED');
    if (marker === 'REFUND_DECLINED_RELEASE_PENDING')
      await answer(runtime, id, 'REFUND', 'DECLINED');
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
      await answer(runtime, id, 'UNCREDITED_REFUND', 'DECLINED');
      await update(id, `failure_reason = 'CAPTURED_NOT_CREDITED'`);
      const txn = await topUp(id);
      await update(
        id,
        `status = 'CAPTURED', captured_at = now(), transaction_id = $2, failure_reason = NULL`,
        txn,
      );
      const taskId = await task(id, 'REFUND');
      await update(id, `failure_reason = 'REFUND_REQUESTED'`);
      await answer(runtime, id, 'REFUND', 'REFUNDED');
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
        await answer(tx, id, 'REFUND', outcomeOf(resolution));
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
        await answer(tx, id, 'UNCREDITED_REFUND', outcomeOf(resolution));
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
      // The provider's answer is there: what is refused is the decision it is offered with.
      await answer(runtime, id, 'UNCREDITED_REFUND', outcomeOf(resolution));
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
      const other = await task(id, 'REFUND');
      await expect(
        runtime.$transaction(async (tx) => {
          await finish(tx, other, 'UNCREDITED_DECLINED');
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

  describe('review probe r2 F1: a decided task is not evidence; a record nobody can take back is', () => {
    it('the review’s path, as written: the runtime role cannot finish the task by hand', async () => {
      const { id, taskId } = await refundUnknown();
      await expect(
        runtime.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE payment_reconciliation_task
                SET status = 'DONE', done_at = now(), resolution = 'UNCREDITED_DECLINED',
                    resolved_by = 'payment-reconciler', lease_token = NULL
              WHERE id = $1`,
            taskId,
          );
          await tx.$executeRawUnsafe(
            `UPDATE payment_intent SET failure_reason = 'CAPTURED_NOT_CREDITED' WHERE id = $1`,
            id,
          );
        }),
      ).rejects.toThrow(DECIDED);
      expect(await statusOf(id)).toEqual({
        status: 'AUTHORIZED',
        reason: 'CAPTURED_REFUND_UNKNOWN',
      });
    });

    it.each([
      [
        'CAPTURED_REFUND_UNKNOWN',
        'UNCREDITED_DECLINED',
        `failure_reason = 'CAPTURED_NOT_CREDITED'`,
      ],
      [
        'CAPTURED_REFUND_UNKNOWN',
        'UNCREDITED_NOT_REACHED',
        `failure_reason = 'CAPTURED_NOT_CREDITED'`,
      ],
      [
        'CAPTURED_REFUND_UNKNOWN',
        'UNCREDITED_REFUNDED',
        `status = 'FAILED', failed_at = now(), failure_reason = 'CAPTURE_NOT_CREDITED'`,
      ],
      ['REFUND_REQUESTED', 'REFUND_DECLINED', `failure_reason = NULL`],
      ['REFUND_UNKNOWN', 'REFUND_NOT_REACHED', `failure_reason = NULL`],
      [
        'REFUND_UNKNOWN',
        'REFUNDED',
        `status = 'REFUNDED', refunded_at = now(), failure_reason = NULL`,
      ],
    ])(
      'leaving %s on a decision (%s) with no recorded answer is refused',
      async (marker, resolution, set) => {
        const { id, taskId } =
          marker === 'CAPTURED_REFUND_UNKNOWN' ? await refundUnknown() : await refunding(marker);
        await expect(
          runtime.$transaction(async (tx) => {
            await finish(tx, taskId, resolution);
            await tx.$executeRawUnsafe(`UPDATE payment_intent SET ${set} WHERE id = $1`, id);
          }),
        ).rejects.toThrow(UNRESOLVED);
        expect((await statusOf(id))!.reason).toBe(marker);
      },
    );

    it.each([
      ['REFUNDED_NOT_REVERSED', null],
      ['REFUND_DECLINED_RELEASE_PENDING', null],
      ['REFUNDED_NOT_REVERSED', 'DECLINED'],
      ['REFUND_DECLINED_RELEASE_PENDING', 'REFUNDED'],
    ] as const)(
      'REFUND_REQUESTED → %s on a recorded answer of %s is refused',
      async (marker, said) => {
        const { id } = await refunding('REFUND_REQUESTED');
        if (said) await answer(runtime, id, 'REFUND', said);
        await expect(update(id, `failure_reason = $2`, marker)).rejects.toThrow(UNTRACKED);
      },
    );

    it.each([
      ['no recorded answer', null],
      ['a decline of the refund attempt, not of returning the capture', ':refund'],
    ])('AUTHORIZED → CAPTURED_NOT_CREDITED on %s is refused', async (_case, suffix) => {
      const id = await authorized();
      if (suffix) await answer(runtime, id, 'UNCREDITED_REFUND', 'DECLINED', suffix);
      await expect(update(id, `failure_reason = 'CAPTURED_NOT_CREDITED'`)).rejects.toThrow(
        UNCREDITABLE,
      );
      expect(await statusOf(id)).toEqual({ status: 'AUTHORIZED', reason: null });
    });

    it('an answer recorded for an earlier refund of the intent is not this one’s', async () => {
      const { id, taskId } = await refunding('REFUND_REQUESTED');
      await runtime.$transaction(async (tx) => {
        await answer(tx, id, 'REFUND', 'NOT_REACHED');
        await finish(tx, taskId, 'REFUND_NOT_REACHED');
        await tx.$executeRawUnsafe(
          `UPDATE payment_intent SET failure_reason = NULL WHERE id = $1`,
          id,
        );
      });
      // A second refund, which this time reached the provider: the old absence (bound to the first
      // task) says nothing of it, and nobody has recorded an answer for this one.
      const second = await task(id, 'REFUND');
      await update(id, `failure_reason = 'REFUND_REQUESTED'`);
      await expect(
        runtime.$transaction(async (tx) => {
          await finish(tx, second, 'REFUND_NOT_REACHED');
          await tx.$executeRawUnsafe(
            `UPDATE payment_intent SET failure_reason = NULL WHERE id = $1`,
            id,
          );
        }),
      ).rejects.toThrow(UNRESOLVED);
    });

    describe('an operator’s resolution is evidence once approved, and only for its own outcome', () => {
      const propose = async (taskId: string, outcome: string) => {
        const resolutionId = `PRR_${ulid()}`;
        await runtime.$executeRawUnsafe(
          `INSERT INTO payment_reconciliation_resolution
                (id, organization_id, payment_intent_id, task_id, provider_outcome, evidence_reference,
                 reason, four_eyes, proposed_by, proposed_by_issuer, proposed_by_subject, proposed_at,
                 correlation_id, created_at, updated_at)
           SELECT $2, organization_id, payment_intent_id, id, $3::"PaymentResolutionOutcome",
                  'TICKET-ITEST', 'an itest probe', true, 'USR-A', 'http://itest.invalid', 'sub-a',
                  now(), 'itest', now(), now()
             FROM payment_reconciliation_task WHERE id = $1`,
          taskId,
          resolutionId,
          outcome,
        );
        return resolutionId;
      };
      const decide = (resolutionId: string, to: 'APPROVED' | 'REJECTED') =>
        runtime.$executeRawUnsafe(
          `UPDATE payment_reconciliation_resolution
              SET status = $2::"PaymentResolutionStatus", decided_by = 'USR-B',
                  decided_by_issuer = 'http://itest.invalid', decided_by_subject = 'sub-b',
                  decided_at = now(), decision_reason = 'checked'
            WHERE id = $1`,
          resolutionId,
          to,
        );
      const creditable = (id: string, taskId: string) =>
        runtime.$transaction(async (tx) => {
          await finish(tx, taskId, 'UNCREDITED_DECLINED');
          await tx.$executeRawUnsafe(
            `UPDATE payment_intent SET failure_reason = 'CAPTURED_NOT_CREDITED' WHERE id = $1`,
            id,
          );
        });

      it('approved, for the outcome the decision names: the intent moves (control)', async () => {
        const { id, taskId } = await refundUnknown();
        await decide(await propose(taskId, 'DECLINED'), 'APPROVED');
        await creditable(id, taskId);
        expect(await statusOf(id)).toEqual({
          status: 'AUTHORIZED',
          reason: 'CAPTURED_NOT_CREDITED',
        });
      });

      it.each([
        ['pending approval', 'DECLINED', null],
        ['rejected', 'DECLINED', 'REJECTED'],
        ['approved, for another outcome', 'REFUNDED', 'APPROVED'],
      ] as const)('%s: refused', async (_case, outcome, to) => {
        const { id, taskId } = await refundUnknown();
        const resolutionId = await propose(taskId, outcome);
        if (to) await decide(resolutionId, to);
        await expect(creditable(id, taskId)).rejects.toThrow(UNRESOLVED);
      });
    });
  });

  describe('review probe r2 F1: the evidence is kept as written, and its keys are the database’s', () => {
    it('a recorded answer is never updated or deleted', async () => {
      const { id } = await refunding('REFUNDED_NOT_REVERSED');
      for (const sql of [
        `UPDATE payment_provider_outcome SET outcome = 'DECLINED' WHERE payment_intent_id = $1`,
        `DELETE FROM payment_provider_outcome WHERE payment_intent_id = $1`,
      ]) {
        await expect(runtime.$executeRawUnsafe(sql, id)).rejects.toThrow(ANSWER_KEPT);
      }
    });

    it('a decision is never updated or deleted, and the task it finished never changes', async () => {
      const { id, taskId } = await refunding('REFUND_REQUESTED');
      await finish(runtime, taskId, 'NOTHING_TO_RECONCILE');
      for (const sql of [
        `UPDATE payment_reconciliation_decision SET resolution = 'REFUND_DECLINED' WHERE task_id = $1`,
        `DELETE FROM payment_reconciliation_decision WHERE task_id = $1`,
      ]) {
        await expect(runtime.$executeRawUnsafe(sql, taskId)).rejects.toThrow(DECISION_KEPT);
      }
      for (const set of [
        `resolution = 'REFUND_DECLINED'`,
        `status = 'PENDING', done_at = NULL,
          resolution = NULL, resolved_by = NULL`,
        `updated_at = now()`,
      ]) {
        await expect(
          runtime.$executeRawUnsafe(
            `UPDATE payment_reconciliation_task SET ${set} WHERE id = $1`,
            taskId,
          ),
        ).rejects.toThrow(DECIDED);
      }
      // Deciding it again inserts nothing: it is decided once.
      await expect(finish(runtime, taskId, 'REFUND_DECLINED')).resolves.toBe(0);
      expect((await statusOf(id))!.reason).toBe('REFUND_REQUESTED');
    });

    it.each([
      [
        'payment_provider_outcome',
        'trg_payment_provider_outcome_no_truncate',
        'record_payment_provider_outcome',
      ],
      [
        'payment_reconciliation_decision',
        'trg_payment_reconciliation_decision_no_truncate',
        'finish_payment_reconciliation_task',
      ],
    ])(
      '%s is never truncated: the statement trigger stands, enabled',
      async (table, trigger, fn) => {
        const [row] = await owner.$queryRawUnsafe<{ def: string; enabled: string }[]>(
          `SELECT pg_get_triggerdef(t.oid) AS def, t.tgenabled::text AS enabled
           FROM pg_trigger t WHERE t.tgrelid = $1::regclass AND t.tgname = $2`,
          table,
          trigger,
        );
        expect(row?.def).toMatch(/ BEFORE TRUNCATE ON \S+ FOR EACH STATEMENT EXECUTE FUNCTION /);
        expect(row?.def).toContain(table);
        expect(row?.def).toContain(`${fn}()`);
        expect(row?.enabled).toBe('O');
      },
    );

    it('an answer’s task and instant, and a decision’s instant, are the database’s', async () => {
      const { id, taskId } = await refunding('REFUND_REQUESTED');
      await runtime.$executeRawUnsafe(
        `INSERT INTO payment_provider_outcome
              (organization_id, payment_intent_id, kind, attempt_key, outcome, task_id, recorded_at)
         SELECT organization_id, id, 'REFUND', idempotency_key || ':refund', 'DECLINED', NULL, '2000-01-01'
           FROM payment_intent WHERE id = $1`,
        id,
      );
      await runtime.$executeRawUnsafe(
        `INSERT INTO payment_reconciliation_decision
              (organization_id, task_id, payment_intent_id, resolution, decided_by, decided_at)
         SELECT organization_id, id, payment_intent_id, 'NOTHING_TO_RECONCILE', 'itest', '2000-01-01'
           FROM payment_reconciliation_task WHERE id = $1`,
        taskId,
      );
      const [row] = await owner.$queryRawUnsafe<
        { task: string; recorded: number; decided: number }[]
      >(
        `SELECT o.task_id AS task,
                abs(extract(epoch FROM o.recorded_at - (now() AT TIME ZONE 'UTC')))::float8 AS recorded,
                abs(extract(epoch FROM d.decided_at - (now() AT TIME ZONE 'UTC')))::float8 AS decided
           FROM payment_provider_outcome o
           JOIN payment_reconciliation_decision d ON d.task_id = o.task_id
          WHERE o.payment_intent_id = $1`,
        id,
      );
      expect(row?.task).toBe(taskId);
      expect(row?.recorded).toBeLessThan(60);
      expect(row?.decided).toBeLessThan(60);
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
          await answer(tx, made.id, 'REFUND', 'REFUNDED');
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

    it('it stays its own: re-checked on every write, not only the one that assigns it', async () => {
      const id = await captured();
      await task(id, 'REFUND');
      // The transaction's source is not fixed by its own guard: the runtime role re-points it.
      await runtime.$executeRawUnsafe(
        `UPDATE "transaction" SET source_reference = 'PAY_ELSEWHERE'
          WHERE id = (SELECT transaction_id FROM payment_intent WHERE id = $1)`,
        id,
      );
      await expect(update(id, `failure_reason = 'REFUND_REQUESTED'`)).rejects.toThrow(PROVENANCE);
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
    it.each([
      ['reject_payment_intent_rewrite', false],
      ['assert_payment_intent_evidenced', false],
      ['record_payment_provider_outcome', false],
      ['guard_payment_reconciliation_task', false],
      ['finish_payment_reconciliation_task', true],
    ])('%s pins its path to the catalogue, temporary relations last', async (name, definer) => {
      const [row] = await owner.$queryRawUnsafe<{ config: string[]; definer: boolean }[]>(
        `SELECT proconfig AS config, prosecdef AS definer FROM pg_proc WHERE proname = $1`,
        name,
      );
      expect(row).toEqual({ config: ['search_path=pg_catalog, pg_temp'], definer });
    });

    it('the schema-local path ends with the function: the caller’s path is unchanged', async () => {
      const { id, taskId } = await refunding('REFUND_REQUESTED');
      const paths = await runtime.$transaction(async (tx) => {
        const read = async () =>
          (
            await tx.$queryRawUnsafe<{ path: string }[]>(
              `SELECT current_setting('search_path') AS path`,
            )
          )[0]!.path;
        const before = await read();
        await answer(tx, id, 'REFUND', 'DECLINED');
        await finish(tx, taskId, 'NOTHING_TO_RECONCILE');
        return [before, await read()];
      });
      expect(paths[1]).toBe(paths[0]);
      // Absolute too: a pooled session an earlier write leaked into would compare equal.
      expect(paths[1]).not.toMatch(/pg_catalog/);
    });

    it('the runtime role cannot execute the definer: only its trigger runs it', async () => {
      const [row] = await runtime.$queryRawUnsafe<{ allowed: boolean }[]>(
        `SELECT has_function_privilege('finish_payment_reconciliation_task()', 'EXECUTE') AS allowed`,
      );
      expect(row?.allowed).toBe(false);
    });

    it('an owner session whose path finds a shadow schema first reads only the table’s own (r2 F2)', async () => {
      const id = await authorized();
      const shadow = `w_shadow_${ulid().toLowerCase()}`;
      const outcomes = await owner
        .$transaction(async (tx) => {
          // The review's probe: a matching top-up and a decline that exist only in the shadow.
          await tx.$executeRawUnsafe(`CREATE SCHEMA ${shadow}`);
          for (const table of ['"transaction"', 'payment_provider_outcome']) {
            await tx.$executeRawUnsafe(
              `CREATE TABLE ${shadow}.${table} (LIKE ${table} INCLUDING DEFAULTS)`,
            );
          }
          await tx.$executeRawUnsafe(
            `INSERT INTO ${shadow}."transaction" (id, organization_id, transaction_type, status,
               gross_amount_minor, net_amount_minor, currency, occurred_at, source_type,
               source_reference, correlation_id, created_by, updated_at, created_at)
             VALUES ('TXN_SHADOW', $2, 'WALLET_TOP_UP', 'SETTLED', 1000, 1000, 'IRR', now(),
                     'PAYMENT_INTENT', $1, 'itest', 'USR-ITEST', now(), now())`,
            id,
            org.a,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO ${shadow}.payment_provider_outcome
                  (organization_id, payment_intent_id, kind, attempt_key, outcome, recorded_at)
             SELECT organization_id, id, 'UNCREDITED_REFUND', idempotency_key || ':uncredited',
                    'DECLINED', now() FROM payment_intent WHERE id = $1`,
            id,
          );
          await tx.$executeRawUnsafe(`SET LOCAL search_path = ${shadow}, public`);
          await tx.$executeRawUnsafe(`SET CONSTRAINTS trg_payment_intent_evidenced IMMEDIATE`);
          const attempt = (sql: string) =>
            tx
              .$executeRawUnsafe(`SAVEPOINT probe`)
              .then(() => tx.$executeRawUnsafe(sql, id))
              .then(
                () => 'accepted',
                (error: Error) => error.message,
              )
              .finally(() => tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT probe`));
          const result = [
            await attempt(
              `UPDATE payment_intent SET status = 'CAPTURED', captured_at = now(),
                 transaction_id = 'TXN_SHADOW' WHERE id = $1`,
            ),
            await attempt(
              `UPDATE payment_intent SET failure_reason = 'CAPTURED_NOT_CREDITED' WHERE id = $1`,
            ),
          ];
          throw Object.assign(new Error('rolled back'), { result });
        })
        .catch((error: { result?: string[]; message?: string }) => error.result ?? [error.message]);
      expect(outcomes?.[0]).toMatch(PROVENANCE);
      expect(outcomes?.[1]).toMatch(UNCREDITABLE);
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
