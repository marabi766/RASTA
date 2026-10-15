import { MockActivityEnvironment } from '@temporalio/testing';
import { RastaError, getContext, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { createActivities, type OrderActivities } from '../src/temporal/activities';
import type { EconomicClient } from '../src/economic/economic.client';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  asActor,
  cleanup,
  key,
  newPrisma,
  publishOffer,
  tenants,
  wire,
  type Wiring,
} from './helpers';

/**
 * A saga activity whose completion Temporal never recorded is run again — and
 * by then a party may have moved the order on (D-053, Codex on #279).
 *
 * Each case commits a step, drops its answer (the worker died, shut down or
 * lost the response before Temporal recorded the completion), lets a party
 * commit, and then runs the **same scheduled activity** again: same workflow,
 * same run, same activity id, next attempt. That is all Temporal changes on a
 * retry, and it is what these cases vary. The retry must answer what the first
 * attempt answered and change nothing.
 *
 * The activities run inside `MockActivityEnvironment`, so the step's key comes
 * from the real activity context the way it does on a worker — not from a
 * stand-in the suite supplies. The domain, the state machine, the row lock and
 * the database are the real ones; only `EconomicClient` is stubbed, as in
 * `activities.int-spec.ts`.
 *
 * Before the step record, the first three cases failed with a non-retryable
 * BUSINESS_RULE_VIOLATION — the saga's end, with the obligation still HELD —
 * and the reminder case counted one reminder twice.
 */
describe('a retried saga activity answers what its first attempt answered (D-053)', () => {
  jest.setTimeout(60_000);

  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.onModuleDestroy();
  });

  const asBuyer = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-RPL-B' }, fn);
  const asSupplier = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.supplier, roles: ['SUPPLIER'], userId: 'USR-RPL-S' }, fn);
  const asOperator = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.other, roles: ['UNION_ADMIN'], userId: 'USR-RPL-OPS' }, fn);

  /** An economic-service stub that counts what it was asked, per method. */
  function stubEconomic(settle: () => Promise<unknown> = async () => SETTLED) {
    const calls: string[] = [];
    const method = (name: string, answer: () => Promise<unknown>) => async (): Promise<unknown> => {
      // Asserted so a call can never leave without the buyer's tenant.
      expect(getContext().organizationId).toBe(org.buyer);
      calls.push(name);
      return answer();
    };
    const economic = {
      createObligation: method('createObligation', async () => ({ id: `TXN_${ulid()}` })),
      authoriseSettlement: method('authoriseSettlement', async () => undefined),
      settle: method('settle', settle),
      refund: method('refund', async () => undefined),
      cancel: method('cancel', async () => undefined),
      dispute: method('dispute', async () => undefined),
      resolveDispute: method('resolveDispute', async () => undefined),
      findObligation: method('findObligation', async () => null),
      // JUSTIFIED-ANY: the activities call only these eight methods, and the
      // client's own HTTP behaviour has its own spec.
    } as any as EconomicClient;
    return { calls, economic };
  }

  /**
   * One saga run. `step(n)` is the n-th activity the workflow scheduled;
   * `attempt` is the only thing that changes when Temporal retries it.
   */
  function sagaRun(orderId: string, economic: EconomicClient) {
    const activities = createActivities({ orders: wiring.orders, economic });
    const runId = `RUN-${ulid()}`;
    // When the workflow scheduled each activity: fixed at its first attempt
    // and kept by every retry, as Temporal does.
    const scheduled = new Map<number, number>();
    return {
      /** Schedules `activityId` at `at` rather than at its first attempt. */
      schedule(activityId: number, at: number): void {
        scheduled.set(activityId, at);
      },
      run<R>(
        activityId: number,
        attempt: number,
        fn: (acts: OrderActivities) => Promise<R>,
      ): Promise<R> {
        if (!scheduled.has(activityId)) scheduled.set(activityId, Date.now());
        const env = new MockActivityEnvironment({
          workflowExecution: { workflowId: `order-${orderId}`, runId },
          activityId: String(activityId),
          attempt,
          scheduledTimestampMs: scheduled.get(activityId)!,
        });
        return env.run(() => fn(activities));
      },
    };
  }

  /**
   * economic-service once its stored answers have expired
   * (`ECONOMIC_IDEMPOTENCY_TTL_HOURS`): every command is judged by the
   * transaction state machine against the state now, as on a retry a day
   * later. `loseNextAnswer()` makes the next command commit and then fail to
   * answer — the worker died, or the response was lost, before the step could
   * record it.
   */
  function expiredEconomic() {
    const calls: string[] = [];
    const obligation = {
      id: `TXN_${ulid()}`,
      orderId: '',
      status: 'HELD',
      commissionAmountMinor: '0',
      netAmountMinor: '0',
      disputedAt: null as string | null,
      disputeReason: null as string | null,
      settlement: null as { id: string; journalId: string; settledAt: string } | null,
    };
    let loseNext = false;

    const move = (name: string, from: string[], to: string, effect: () => void = () => {}) => {
      expect(getContext().organizationId).toBe(org.buyer);
      calls.push(name);
      if (!from.includes(obligation.status)) {
        throw RastaError.invalidStateTransition('Transaction', obligation.status, to);
      }
      obligation.status = to;
      effect();
      if (loseNext) {
        loseNext = false;
        throw RastaError.upstreamUnavailable('economic-service');
      }
    };

    const economic = {
      createObligation: async (input: { orderId: string }) => {
        calls.push('createObligation');
        obligation.orderId = input.orderId;
        return { id: obligation.id };
      },
      authoriseSettlement: async () => move('authoriseSettlement', ['HELD'], 'PENDING_SETTLEMENT'),
      settle: async () => {
        move('settle', ['PENDING_SETTLEMENT'], 'SETTLED', () => {
          obligation.commissionAmountMinor = SETTLED.commissionAmountMinor;
          obligation.netAmountMinor = SETTLED.netAmountMinor;
          obligation.settlement = {
            id: SETTLED.settlementId,
            journalId: `JRN_${ulid()}`,
            settledAt: new Date().toISOString(),
          };
        });
        return SETTLED;
      },
      refund: async () => move('refund', ['HELD', 'PENDING_SETTLEMENT', 'DISPUTED'], 'REFUNDED'),
      readObligation: async (input: { orderId: string; transactionId: string }) => {
        expect(getContext().organizationId).toBe(org.buyer);
        calls.push('readObligation');
        // The client's own check: only this order's obligation answers.
        if (input.transactionId !== obligation.id || input.orderId !== obligation.orderId) {
          return null;
        }
        return {
          id: obligation.id,
          organizationId: org.buyer,
          counterpartyOrganizationId: org.supplier,
          transactionType: 'MARKETPLACE_ORDER',
          status: obligation.status,
          grossAmountMinor: '500000',
          commissionAmountMinor: obligation.commissionAmountMinor,
          netAmountMinor: obligation.netAmountMinor,
          currency: 'IRR',
          sourceReference: obligation.orderId,
          disputedAt: obligation.disputedAt,
          disputeReason: obligation.disputeReason,
          settlement: obligation.settlement,
        };
      },
      // JUSTIFIED-ANY: the methods these cases reach; the client's HTTP
      // behaviour, and its own check of the obligation, have their own spec.
    } as any as EconomicClient;

    return {
      calls,
      economic,
      obligation,
      loseNextAnswer: () => {
        loseNext = true;
      },
    };
  }

  /** What an older worker leaves behind: the step's effect, and no record of it. */
  async function forgetRecords(orderId: string): Promise<void> {
    await runUnscoped('the suite removes the records a worker before D-053 never wrote', () =>
      prisma.client.sagaStep.deleteMany({ where: { orderId } }),
    );
  }

  async function recordsOf(orderId: string) {
    return runUnscoped('the suite reads the records the saga wrote', () =>
      prisma.client.sagaStep.findMany({ where: { orderId }, select: { activity: true } }),
    );
  }

  async function placeOrder(): Promise<string> {
    const { offerId } = await publishOffer(wiring, org.supplier, { unitPriceMinor: '500000' });
    const order = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('RPL')),
    );
    return order.id;
  }

  async function rowOf(orderId: string) {
    return runUnscoped('the suite reads the order the saga drove', () =>
      prisma.client.order.findUniqueOrThrow({ where: { id: orderId } }),
    );
  }

  async function historyOf(orderId: string) {
    return runUnscoped('the suite reads the history the saga wrote', () =>
      prisma.client.orderStatusHistory.findMany({
        where: { orderId },
        orderBy: { occurredAt: 'asc' },
        select: { kind: true, fromStatus: true, toStatus: true },
      }),
    );
  }

  async function eventsOf(orderId: string, eventName: string) {
    return runUnscoped('the suite counts the events the saga wrote', () =>
      prisma.client.outboxMessage.count({ where: { aggregateId: orderId, eventName } }),
    );
  }

  /** Placed, held and recorded as FUNDS_HELD: activities 1-3 of the run. */
  async function held(economic = stubEconomic().economic) {
    const orderId = await placeOrder();
    const saga = sagaRun(orderId, economic);
    await saga.run(1, 1, (a) => a.readOrder(orderId));
    const { transactionId } = await saga.run(2, 1, (a) => a.createObligation(orderId));
    await saga.run(3, 1, (a) => a.markFundsHeld(orderId, transactionId));
    return { orderId, saga, transactionId };
  }

  /** Held, then confirmed, fulfilled and its receipt confirmed by the parties. */
  async function receiptConfirmed(economic = stubEconomic().economic) {
    const run = await held(economic);
    await asSupplier(async () => {
      await wiring.orders.confirm(run.orderId);
      await wiring.orders.fulfill(run.orderId, {});
    });
    await asBuyer(() => wiring.orders.confirmReceipt(run.orderId, {}));
    return run;
  }

  /** Receipt confirmed, then authorised and settling (activities 4-5). */
  async function settling(economic = stubEconomic().economic) {
    const { orderId, saga, transactionId } = await receiptConfirmed(economic);
    await saga.run(4, 1, (a) => a.authoriseSettlement(orderId, transactionId));
    await expect(saga.run(5, 1, (a) => a.markSettling(orderId))).resolves.toBe('SETTLING');
    return { orderId, saga, transactionId };
  }

  it('the hold: recorded, confirmed by the supplier, retried — still FUNDS_HELD, nothing rewritten', async () => {
    // Codex finding 1, step for step.
    const orderId = await placeOrder();
    const saga = sagaRun(orderId, stubEconomic().economic);
    const { transactionId } = await saga.run(2, 1, (a) => a.createObligation(orderId));

    // Attempt 1 commits; its completion never reaches Temporal.
    await expect(saga.run(3, 1, (a) => a.markFundsHeld(orderId, transactionId))).resolves.toBe(
      'FUNDS_HELD',
    );
    // The supplier confirms through the API.
    await asSupplier(() => wiring.orders.confirm(orderId));
    expect((await rowOf(orderId)).status).toBe('CONFIRMED');

    // Attempt 2 of the same activity. It used to be refused CONFIRMED ->
    // FUNDS_HELD, non-retryable: the workflow failed with the obligation HELD
    // and no saga left to settle or refund it.
    await expect(saga.run(3, 2, (a) => a.markFundsHeld(orderId, transactionId))).resolves.toBe(
      'FUNDS_HELD',
    );

    const row = await rowOf(orderId);
    expect(row.status).toBe('CONFIRMED');
    expect(row.economicTransactionId).toBe(transactionId);
    expect(await historyOf(orderId)).toEqual([
      { kind: 'TRANSITION', fromStatus: 'PENDING', toStatus: 'FUNDS_HELD' },
      { kind: 'TRANSITION', fromStatus: 'FUNDS_HELD', toStatus: 'CONFIRMED' },
    ]);
    expect(await eventsOf(orderId, 'ORDER_FUNDS_HELD')).toBe(1);
  });

  it('a failed settlement attempt: recorded, disputed by the buyer, retried — the dispute stands', async () => {
    // Only the step record can answer this one: nothing on the order says
    // which settlement attempt failed, and DISPUTED -> RECEIPT_CONFIRMED is an
    // edge the saga may never take (ADR-039 § 7, defect 2).
    const { orderId, saga } = await settling();

    await expect(saga.run(6, 1, (a) => a.markSettlementFailed(orderId))).resolves.toBe(
      'RECEIPT_CONFIRMED',
    );
    await asBuyer(() =>
      wiring.orders.raiseDispute(orderId, { reason: 'the delivered part is the wrong size' }),
    );

    await expect(saga.run(6, 2, (a) => a.markSettlementFailed(orderId))).resolves.toBe(
      'RECEIPT_CONFIRMED',
    );

    expect((await rowOf(orderId)).status).toBe('DISPUTED');
    expect(await eventsOf(orderId, 'ORDER_SETTLEMENT_FAILED')).toBe(1);
  });

  it('a settlement that yielded to a dispute: the dispute refunded, retried — still the yield', async () => {
    // The saga read RECEIPT_CONFIRMED; the buyer disputed before it acted.
    const { orderId, saga } = await receiptConfirmed();
    await asBuyer(() =>
      wiring.orders.raiseDispute(orderId, { reason: 'the goods arrived broken in two' }),
    );

    await expect(saga.run(5, 1, (a) => a.markSettling(orderId))).resolves.toBe('DISPUTED');
    await asOperator(() =>
      wiring.orders.resolveDispute(orderId, {
        outcome: 'REFUND',
        resolution: 'the supplier accepted the goods back',
        responsibility: 'SUPPLIER',
      }),
    );
    expect((await rowOf(orderId)).status).toBe('CANCELLING');

    // Used to be refused CANCELLING -> SETTLING, non-retryable, before the
    // saga ever reached the refund.
    await expect(saga.run(5, 2, (a) => a.markSettling(orderId))).resolves.toBe('DISPUTED');
    expect((await rowOf(orderId)).status).toBe('CANCELLING');
  });

  it('a later settlement attempt is a step of its own, not a replay of the first', async () => {
    const { orderId, saga } = await settling();
    await saga.run(6, 1, (a) => a.markSettlementFailed(orderId));

    // The workflow's next attempt schedules new activities (new ids): they act.
    await expect(saga.run(8, 1, (a) => a.markSettling(orderId))).resolves.toBe('SETTLING');
    expect(await eventsOf(orderId, 'ORDER_SETTLEMENT_STARTED')).toBe(2);
  });

  it('a settlement: recorded, retried after economic-service forgot it — not called again', async () => {
    // economic-service keeps its idempotent answer for a day. A retry that
    // comes after that is judged against a SETTLED transaction and refused;
    // the stub refuses every call after the first to stand for that.
    let settled = 0;
    const { calls, economic } = stubEconomic(async () => {
      settled += 1;
      if (settled > 1) throw RastaError.invalidStateTransition('Transaction', 'SETTLED', 'SETTLED');
      return SETTLED;
    });
    const { orderId, saga, transactionId } = await settling(economic);

    const first = await saga.run(7, 1, (a) => a.settle(orderId, transactionId));
    const retry = await saga.run(7, 2, (a) => a.settle(orderId, transactionId));

    expect(retry).toEqual(first);
    expect(calls.filter((c) => c === 'settle')).toHaveLength(1);

    // And it completes with the settlement the first attempt was given.
    await expect(saga.run(10, 1, (a) => a.markCompleted(orderId, retry))).resolves.toBe(
      'COMPLETED',
    );
    expect((await rowOf(orderId)).economicSettlementId).toBe(SETTLED.settlementId);
  });

  it('every economic step is asked once per scheduled activity', async () => {
    const { calls, economic } = stubEconomic();
    const { orderId, saga, transactionId } = await receiptConfirmed(economic);
    await asBuyer(() =>
      wiring.orders.raiseDispute(orderId, { reason: 'still not what we ordered' }),
    );
    const { dispute } = await saga.run(11, 1, (a) => a.readOrder(orderId));

    for (const attempt of [1, 2, 3]) {
      await saga.run(4, attempt, (a) => a.authoriseSettlement(orderId, transactionId));
      await saga.run(12, attempt, (a) =>
        a.disputeObligation(orderId, transactionId, dispute!.id, 'still not what we ordered'),
      );
      await saga.run(13, attempt, (a) =>
        a.resolveObligationDispute(orderId, transactionId, dispute!.id, 'refunded'),
      );
      await saga.run(14, attempt, (a) => a.compensate(orderId, transactionId, 'refunded'));
    }

    expect(calls).toEqual([
      'createObligation',
      'authoriseSettlement',
      'dispute',
      'resolveDispute',
      'refund',
    ]);
  });

  describe('reminders (Codex finding 2)', () => {
    it('counts a reminder once, however many attempts it took', async () => {
      const { orderId, saga } = await held();

      await saga.run(4, 1, (a) => a.recordReminder(orderId));
      await saga.run(4, 2, (a) => a.recordReminder(orderId));

      const row = await rowOf(orderId);
      expect(row.reminderCount).toBe(1);
      expect((await historyOf(orderId)).filter((h) => h.kind === 'REMINDER')).toHaveLength(1);
    });

    it('counts the next reminder: another scheduled activity', async () => {
      const { orderId, saga } = await held();

      await saga.run(4, 1, (a) => a.recordReminder(orderId));
      await saga.run(4, 2, (a) => a.recordReminder(orderId));
      // The next reminder is scheduled a reminder interval later: a day at least.
      saga.schedule(6, Date.now() + DAY_MS);
      await saga.run(6, 1, (a) => a.recordReminder(orderId));

      expect((await rowOf(orderId)).reminderCount).toBe(2);
      expect((await historyOf(orderId)).filter((h) => h.kind === 'REMINDER')).toHaveLength(2);
    });
  });

  it('keeps a run’s steps apart from another run’s, for the same order and activity id', async () => {
    // A reset starts a new run that schedules from activity 1 again; its
    // steps are its own decisions, not replays of the old run's.
    const { orderId } = await held();

    await sagaRun(orderId, stubEconomic().economic).run(4, 1, (a) => a.recordReminder(orderId));
    // The new run's reminder comes a window after it began waiting again.
    const reset = sagaRun(orderId, stubEconomic().economic);
    reset.schedule(4, Date.now() + DAY_MS);
    await reset.run(4, 1, (a) => a.recordReminder(orderId));

    expect((await rowOf(orderId)).reminderCount).toBe(2);
  });

  describe('an economic step retried after economic-service let its answer expire (Codex on #283, finding 1)', () => {
    it('authorisation: committed, answer lost, retried past the TTL — answered from the obligation', async () => {
      const econ = expiredEconomic();
      const { orderId, saga, transactionId } = await receiptConfirmed(econ.economic);

      // Attempt 1 commits HELD -> PENDING_SETTLEMENT, then dies before it can
      // record the answer.
      econ.loseNextAnswer();
      await expect(
        saga.run(4, 1, (a) => a.authoriseSettlement(orderId, transactionId)),
      ).rejects.toMatchObject({ type: 'UPSTREAM_UNAVAILABLE', nonRetryable: false });
      expect(econ.obligation.status).toBe('PENDING_SETTLEMENT');
      expect(await recordsOf(orderId)).not.toContainEqual({ activity: 'authoriseSettlement' });

      // Attempt 2 arrives after the TTL: refused PENDING_SETTLEMENT ->
      // PENDING_SETTLEMENT. It used to go on being refused until the attempts
      // ran out, and the workflow failed with the funds held.
      await expect(
        saga.run(4, 2, (a) => a.authoriseSettlement(orderId, transactionId)),
      ).resolves.toBeUndefined();
      expect(await recordsOf(orderId)).toContainEqual({ activity: 'authoriseSettlement' });

      // Recorded: a third attempt asks nobody.
      await saga.run(4, 3, (a) => a.authoriseSettlement(orderId, transactionId));
      expect(econ.calls.slice(1)).toEqual([
        'authoriseSettlement',
        'authoriseSettlement',
        'readObligation',
      ]);

      // And the saga carries on to settle.
      await expect(saga.run(5, 1, (a) => a.markSettling(orderId))).resolves.toBe('SETTLING');
      await expect(saga.run(6, 1, (a) => a.settle(orderId, transactionId))).resolves.toEqual(
        SETTLED,
      );
    });

    it('settlement: committed, answer lost, retried past the TTL — the settlement it made, and the order completes', async () => {
      const econ = expiredEconomic();
      const { orderId, saga, transactionId } = await settling(econ.economic);

      econ.loseNextAnswer();
      await expect(saga.run(6, 1, (a) => a.settle(orderId, transactionId))).rejects.toMatchObject({
        type: 'UPSTREAM_UNAVAILABLE',
      });
      expect(econ.obligation.status).toBe('SETTLED');

      // Refused SETTLED -> SETTLED, then read back: the one settlement this
      // transaction has, with its commission and net.
      const retried = await saga.run(6, 2, (a) => a.settle(orderId, transactionId));
      expect(retried).toEqual(SETTLED);
      await expect(saga.run(6, 3, (a) => a.settle(orderId, transactionId))).resolves.toEqual(
        SETTLED,
      );
      expect(econ.calls.filter((c) => c === 'settle')).toHaveLength(2);
      expect(econ.calls.filter((c) => c === 'readObligation')).toHaveLength(1);

      // Without it: SETTLEMENT_EXHAUSTED, "funds remain held", on a paid order.
      await expect(saga.run(7, 1, (a) => a.markCompleted(orderId, retried))).resolves.toBe(
        'COMPLETED',
      );
      expect((await rowOf(orderId)).economicSettlementId).toBe(SETTLED.settlementId);
    });

    it('a state refusal the command did not cause stays a refusal, and records nothing', async () => {
      const econ = expiredEconomic();
      const { orderId, saga, transactionId } = await receiptConfirmed(econ.economic);
      // Disputed directly in economic-service: authorisation is refused, and
      // DISPUTED is reachable from HELD without one.
      econ.obligation.status = 'DISPUTED';

      await expect(
        saga.run(4, 1, (a) => a.authoriseSettlement(orderId, transactionId)),
      ).rejects.toMatchObject({ type: 'INVALID_STATE_TRANSITION' });
      expect(econ.calls.slice(1)).toEqual(['authoriseSettlement', 'readObligation']);
      expect(await recordsOf(orderId)).not.toContainEqual({ activity: 'authoriseSettlement' });
    });

    it('a transaction that is not this order’s obligation proves nothing', async () => {
      const econ = expiredEconomic();
      const { orderId, saga } = await settling(econ.economic);
      econ.obligation.status = 'SETTLED';

      // The saga names a transaction economic-service does not hold for this
      // order: the read answers nothing, and the refusal stands.
      await expect(saga.run(6, 1, (a) => a.settle(orderId, `TXN_${ulid()}`))).rejects.toMatchObject(
        { type: 'INVALID_STATE_TRANSITION' },
      );
      expect(await recordsOf(orderId)).not.toContainEqual({ activity: 'settle' });
    });

    it('any other refusal is not read as "already done"', async () => {
      const { calls, economic } = stubEconomic(async () => {
        throw RastaError.businessRule('Commission exceeds the transaction amount');
      });
      const { orderId, saga, transactionId } = await settling(economic);

      await expect(saga.run(6, 1, (a) => a.settle(orderId, transactionId))).rejects.toMatchObject({
        type: 'BUSINESS_RULE_VIOLATION',
        nonRetryable: true,
      });
      expect(calls).not.toContain('readObligation');
    });
  });

  describe('a step applied by a worker older than its record (Codex on #283, finding 3)', () => {
    // An older worker wrote the step's effect — the order, its history row and
    // its event, in one transaction, exactly as now — and no record. Removing
    // the record after the first attempt leaves precisely that.

    it('a failed settlement attempt, the buyer disputes, then the new worker retries — the dispute stands', async () => {
      // Codex finding 3, step for step: the retry used to be refused
      // DISPUTED -> RECEIPT_CONFIRMED, non-retryable, with the funds held.
      const { orderId, saga } = await settling();
      await saga.run(6, 1, (a) => a.markSettlementFailed(orderId));
      await forgetRecords(orderId);
      await asBuyer(() =>
        wiring.orders.raiseDispute(orderId, { reason: 'the part arrived with a cracked housing' }),
      );

      await expect(saga.run(6, 2, (a) => a.markSettlementFailed(orderId))).resolves.toBe(
        'RECEIPT_CONFIRMED',
      );

      expect((await rowOf(orderId)).status).toBe('DISPUTED');
      expect(
        (await historyOf(orderId)).filter(
          (h) => h.fromStatus === 'SETTLING' && h.toStatus === 'RECEIPT_CONFIRMED',
        ),
      ).toHaveLength(1);
      expect(await eventsOf(orderId, 'ORDER_SETTLEMENT_FAILED')).toBe(1);
      // Recorded now, so the next attempt needs no history.
      expect(await recordsOf(orderId)).toContainEqual({ activity: 'markSettlementFailed' });
    });

    it('the same edge from an earlier step is not this step’s', async () => {
      // The row is older than this activity's scheduling by more than the
      // clock allowance — as an earlier settlement attempt's always is, by at
      // least the 30 s backoff. It proves nothing; the refusal stands.
      const { orderId, saga } = await settling();
      await saga.run(6, 1, (a) => a.markSettlementFailed(orderId));
      await forgetRecords(orderId);
      await asBuyer(() => wiring.orders.raiseDispute(orderId, { reason: 'wrong colour entirely' }));

      saga.schedule(9, Date.now() + 30_000);
      await expect(saga.run(9, 1, (a) => a.markSettlementFailed(orderId))).rejects.toMatchObject({
        type: 'BUSINESS_RULE_VIOLATION',
        nonRetryable: true,
      });
    });

    it('a settlement attempt that yielded to a dispute, refunded since: yields again', async () => {
      const { orderId, saga } = await receiptConfirmed();
      await asBuyer(() =>
        wiring.orders.raiseDispute(orderId, { reason: 'never delivered at all' }),
      );
      await expect(saga.run(5, 1, (a) => a.markSettling(orderId))).resolves.toBe('DISPUTED');
      await forgetRecords(orderId);
      await asOperator(() =>
        wiring.orders.resolveDispute(orderId, {
          outcome: 'REFUND',
          resolution: 'the supplier could not show a delivery',
          responsibility: 'SUPPLIER',
        }),
      );

      // The saga reads CANCELLING next and refunds.
      await expect(saga.run(5, 2, (a) => a.markSettling(orderId))).resolves.toBe('CANCELLING');
      expect(await eventsOf(orderId, 'ORDER_SETTLEMENT_STARTED')).toBe(0);
    });

    it('a reminder counted by an older worker is not counted again', async () => {
      const { orderId, saga } = await held();
      await saga.run(4, 1, (a) => a.recordReminder(orderId));
      await forgetRecords(orderId);

      await saga.run(4, 2, (a) => a.recordReminder(orderId));

      expect((await rowOf(orderId)).reminderCount).toBe(1);
      expect((await historyOf(orderId)).filter((h) => h.kind === 'REMINDER')).toHaveLength(1);
    });
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

const SETTLED = {
  settlementId: `STL_${ulid()}`,
  commissionAmountMinor: '12500',
  netAmountMinor: '487500',
};
