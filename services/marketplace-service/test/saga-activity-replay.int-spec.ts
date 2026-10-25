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
  settledResult,
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
    asActor({ organizationId: org.other, roles: ['SYSTEM_ADMIN'], userId: 'USR-RPL-OPS' }, fn);

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
      dispute: method('dispute', async () => ({ disputeId: 'TXD_STUB' })),
      resolveDispute: method('resolveDispute', async () => undefined),
      findObligations: method('findObligations', async () => []),
      // The obligation as economic-service has it now — this order's, HELD —
      // which `createObligation` reads before answering.
      readObligation: async (input: { orderId: string; transactionId: string }) => {
        expect(getContext().organizationId).toBe(org.buyer);
        calls.push('readObligation');
        return {
          id: input.transactionId,
          organizationId: org.buyer,
          transactionType: 'MARKETPLACE_ORDER',
          status: 'HELD',
          sourceReference: input.orderId,
        };
      },
      // JUSTIFIED-ANY: the activities call only these nine methods, and the
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
      // Kept by an economic-service that keeps the resolution apart; this
      // stand-in writes it over the reason, as one that does not.
      disputeResolution: undefined as string | null | undefined,
      // A new identity each time it is disputed, kept through the resolution.
      disputeId: null as string | null,
      settlement: null as { id: string; journalId: string; settledAt: string } | null,
      // What economic-service keeps of the command that authorised it.
      settlementAuthorisation: null as {
        authorisedAt: string;
        service: string | null;
        idempotencyKey: string | null;
      } | null,
    };
    let loseNext = false;
    let disputes = 0;
    const disputed = (reason: string) => {
      disputes += 1;
      obligation.disputedAt = new Date().toISOString();
      obligation.disputeReason = reason;
      obligation.disputeId = `TXD_${disputes}`;
    };

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
      authoriseSettlement: async (input: { orderId: string }) =>
        move('authoriseSettlement', ['HELD'], 'PENDING_SETTLEMENT', () => {
          // This service's signed token, and the client's own key for it.
          obligation.settlementAuthorisation = {
            authorisedAt: new Date().toISOString(),
            service: 'marketplace-service',
            idempotencyKey: `order:${input.orderId}:authorise`,
          };
        }),
      dispute: async (input: { reason: string }) => {
        move('dispute', ['HELD', 'PENDING_SETTLEMENT'], 'DISPUTED', () => disputed(input.reason));
        return { disputeId: obligation.disputeId };
      },
      resolveDispute: async (input: { resolution: string; economicDisputeId?: string }) => {
        // economic-service's check, under its row lock: the dispute named must
        // be the one it holds.
        const named = input.economicDisputeId;
        if (
          obligation.status === 'DISPUTED' &&
          named !== undefined &&
          named !== obligation.disputeId
        ) {
          calls.push('resolveDispute');
          throw RastaError.invalidStateTransition(
            'Transaction',
            'DISPUTED',
            'PENDING_SETTLEMENT',
            'The transaction no longer holds the dispute this decision is about',
          );
        }
        return move('resolveDispute', ['DISPUTED'], 'PENDING_SETTLEMENT', () => {
          obligation.disputeReason = input.resolution;
        });
      },
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
          ...(obligation.disputeResolution === undefined
            ? {}
            : { disputeResolution: obligation.disputeResolution }),
          disputeId: obligation.disputeId,
          settlement: obligation.settlement,
          settlementAuthorisation: obligation.settlementAuthorisation,
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
      /**
       * Someone with authority over the transaction disputes it in
       * economic-service directly — not through this service, and not a call
       * the saga sees.
       */
      disputeThere: (reason: string) => {
        expect(['HELD', 'PENDING_SETTLEMENT']).toContain(obligation.status);
        obligation.status = 'DISPUTED';
        disputed(reason);
      },
      /**
       * Someone resolves the dispute in economic-service directly: back in the
       * settlement queue, with their words — over the reason, or apart from
       * it with `kept`, as an economic-service that keeps the resolution.
       */
      resolveThere: (resolution: string, kept = false) => {
        expect(obligation.status).toBe('DISPUTED');
        obligation.status = 'PENDING_SETTLEMENT';
        if (kept) obligation.disputeResolution = resolution;
        else obligation.disputeReason = resolution;
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
    await expect(
      saga.run(10, 1, (a) => a.markCompleted(orderId, settledResult(retry))),
    ).resolves.toBe('COMPLETED');
    expect((await rowOf(orderId)).economicSettlementId).toBe(SETTLED.settlementId);
  });

  it('a retried hold whose funds were refunded since its first attempt is not adopted (#334 r3 F2)', async () => {
    // The first attempt committed the hold and recorded it; its completion
    // never reached Temporal; the supplier refunded before the retry. The
    // retry answers from the step's record (D-053) — and that record is
    // history: the funds are read again, and the hold is not adopted.
    const econ = expiredEconomic();
    const orderId = await placeOrder();
    const saga = sagaRun(orderId, econ.economic);
    await saga.run(2, 1, (a) => a.createObligation(orderId));
    econ.obligation.status = 'REFUNDED';

    await expect(saga.run(2, 2, (a) => a.createObligation(orderId))).rejects.toMatchObject({
      type: 'OBLIGATION_NOT_HELD',
      nonRetryable: true,
    });
    expect(econ.calls).toEqual(['createObligation', 'readObligation', 'readObligation']);
    expect((await rowOf(orderId)).status).toBe('PENDING');
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
      // economic-service's identity of the dispute it filed, answered by
      // every attempt from the record of the first.
      await expect(
        saga.run(12, attempt, (a) =>
          a.disputeObligation(orderId, transactionId, dispute!.id, 'still not what we ordered'),
        ),
      ).resolves.toBe('TXD_STUB');
      await saga.run(13, attempt, (a) =>
        a.resolveObligationDispute(orderId, transactionId, dispute!.id, 'refunded'),
      );
      await saga.run(14, attempt, (a) => a.compensate(orderId, transactionId, 'refunded'));
    }

    expect(calls).toEqual([
      'createObligation',
      'readObligation',
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
      expect(econ.calls.slice(2)).toEqual([
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
      // The hold's funding check, and the settlement's read back.
      expect(econ.calls.filter((c) => c === 'readObligation')).toHaveLength(2);

      // Without it: SETTLEMENT_EXHAUSTED, "funds remain held", on a paid order.
      await expect(
        saga.run(7, 1, (a) => a.markCompleted(orderId, settledResult(retried))),
      ).resolves.toBe('COMPLETED');
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
      expect(econ.calls.slice(2)).toEqual(['authoriseSettlement', 'readObligation']);
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
      // The one read is the hold's funding check; the refusal is not read back.
      expect(calls.slice(calls.indexOf('settle'))).not.toContain('readObligation');
    });
  });

  describe('authorised, then disputed in economic-service, retried past the TTL (Codex on #287 round 4, finding 2)', () => {
    async function disputesOf(orderId: string) {
      return runUnscoped('the suite reads the disputes on the order', () =>
        prisma.client.orderDispute.findMany({
          where: { orderId },
          select: { id: true, reason: true, status: true, raisedBy: true },
        }),
      );
    }

    const OBJECTION = 'the payer counted two pallets short on arrival';

    it('the exact trigger ends in the dispute path, and an operator’s SETTLE settles it', async () => {
      const econ = expiredEconomic();
      const { orderId, saga, transactionId } = await receiptConfirmed(econ.economic);

      // Attempt 1 commits HELD -> PENDING_SETTLEMENT; its answer and its
      // record are lost.
      econ.loseNextAnswer();
      await expect(
        saga.run(4, 1, (a) => a.authoriseSettlement(orderId, transactionId)),
      ).rejects.toMatchObject({ type: 'UPSTREAM_UNAVAILABLE', nonRetryable: false });
      // Someone with authority disputes the transaction in economic-service.
      econ.disputeThere(OBJECTION);

      // Attempt 2, after the TTL: refused DISPUTED, read back DISPUTED — which
      // used to be refused until the attempts ran out. economic-service's
      // record says this order's own command authorised it: the dispute is
      // the answer, and it is recorded.
      await expect(
        saga.run(4, 2, (a) => a.authoriseSettlement(orderId, transactionId)),
      ).resolves.toEqual({ disputed: true, reason: OBJECTION, economicDisputeId: 'TXD_1' });
      await expect(
        saga.run(4, 3, (a) => a.authoriseSettlement(orderId, transactionId)),
      ).resolves.toEqual({ disputed: true, reason: OBJECTION, economicDisputeId: 'TXD_1' });
      expect(econ.calls.slice(2)).toEqual([
        'authoriseSettlement',
        'authoriseSettlement',
        'readObligation',
      ]);

      // The order takes the dispute, with economic-service's words, and the
      // step names it; its retry names the same one.
      const taken = await saga.run(5, 1, (a) =>
        a.markObligationDisputed(orderId, OBJECTION, 'TXD_1'),
      );
      await expect(
        saga.run(5, 2, (a) => a.markObligationDisputed(orderId, OBJECTION, 'TXD_1')),
      ).resolves.toEqual(taken);
      const [dispute] = await disputesOf(orderId);
      expect(taken).toEqual({
        status: 'DISPUTED',
        disputeId: dispute!.id,
        economicDisputeId: 'TXD_1',
      });
      expect(await disputesOf(orderId)).toEqual([
        { id: dispute!.id, reason: OBJECTION, status: 'OPEN', raisedBy: 'economic-service' },
      ]);
      expect((await historyOf(orderId)).at(-1)).toEqual({
        kind: 'TRANSITION',
        fromStatus: 'RECEIPT_CONFIRMED',
        toStatus: 'DISPUTED',
      });
      expect(await eventsOf(orderId, 'ORDER_DISPUTED')).toBe(1);

      // The workflow's DISPUTED case: the dispute it reads is the one it
      // named, which economic-service holds already. Nothing to mirror.
      const view = await saga.run(6, 1, (a) => a.readOrder(orderId, taken.disputeId!));
      expect(view.status).toBe('DISPUTED');
      expect(view.dispute).toMatchObject({ id: taken.disputeId, reason: OBJECTION });
      expect(view.mirroredDispute).toEqual({ id: taken.disputeId, resolution: null });

      // An operator decides for the supplier; the saga mirrors it back, and
      // settles in a new attempt of its own.
      await asOperator(() =>
        wiring.orders.resolveDispute(orderId, {
          outcome: 'SETTLE',
          resolution: 'the supplier showed a signed delivery note',
          responsibility: 'BUYER',
        }),
      );
      await saga.run(8, 1, (a) =>
        a.resolveObligationDispute(
          orderId,
          transactionId,
          taken.disputeId!,
          'the supplier showed a signed delivery note',
          taken.economicDisputeId!,
        ),
      );
      expect(econ.obligation.status).toBe('PENDING_SETTLEMENT');
      await expect(
        saga.run(9, 1, (a) => a.authoriseSettlement(orderId, transactionId)),
      ).resolves.toBeUndefined();
      await expect(saga.run(10, 1, (a) => a.markSettling(orderId))).resolves.toBe('SETTLING');
      const settled = await saga.run(11, 1, (a) => a.settle(orderId, transactionId));
      await expect(
        saga.run(12, 1, (a) => a.markCompleted(orderId, settledResult(settled))),
      ).resolves.toBe('COMPLETED');
      expect(econ.obligation.status).toBe('SETTLED');
    });

    it('a dispute found by settlement, within the TTL: the attempt ends and the order takes the dispute', async () => {
      // The retry of the authorisation was answered by economic-service's
      // replay (or the first attempt's answer arrived), then the transaction
      // was disputed there: settlement is refused, and it is the dispute.
      const econ = expiredEconomic();
      const { orderId, saga, transactionId } = await settling(econ.economic);
      econ.disputeThere(OBJECTION);

      await expect(saga.run(6, 1, (a) => a.settle(orderId, transactionId))).resolves.toEqual({
        disputed: true,
        reason: OBJECTION,
        economicDisputeId: 'TXD_1',
      });
      await expect(saga.run(7, 1, (a) => a.markSettlementFailed(orderId))).resolves.toBe(
        'RECEIPT_CONFIRMED',
      );
      await expect(
        saga.run(8, 1, (a) => a.markObligationDisputed(orderId, OBJECTION, 'TXD_1')),
      ).resolves.toMatchObject({
        status: 'DISPUTED',
        disputeId: expect.any(String),
        economicDisputeId: 'TXD_1',
      });
      expect(await disputesOf(orderId)).toMatchObject([{ reason: OBJECTION, status: 'OPEN' }]);
    });

    it('an operator decides before the saga reads again: that dispute’s decision is mirrored, and no second dispute is filed (Codex on #318 round 1, finding 1)', async () => {
      const econ = expiredEconomic();
      const { orderId, saga, transactionId } = await receiptConfirmed(econ.economic);
      econ.loseNextAnswer();
      await expect(
        saga.run(4, 1, (a) => a.authoriseSettlement(orderId, transactionId)),
      ).rejects.toMatchObject({ type: 'UPSTREAM_UNAVAILABLE' });
      econ.disputeThere(OBJECTION);
      await expect(
        saga.run(4, 2, (a) => a.authoriseSettlement(orderId, transactionId)),
      ).resolves.toEqual({ disputed: true, reason: OBJECTION, economicDisputeId: 'TXD_1' });
      const taken = await saga.run(5, 1, (a) =>
        a.markObligationDisputed(orderId, OBJECTION, 'TXD_1'),
      );
      expect(taken.disputeId).toEqual(expect.any(String));

      // Decided before the saga's next read: it never sees the order DISPUTED.
      await asOperator(() =>
        wiring.orders.resolveDispute(orderId, {
          outcome: 'SETTLE',
          resolution: 'the supplier showed a signed delivery note',
          responsibility: 'BUYER',
        }),
      );

      // A worker restarted here replays `taken` from the workflow's history;
      // the step's own record answers a retry of it with the same dispute.
      await expect(
        saga.run(5, 2, (a) => a.markObligationDisputed(orderId, OBJECTION, 'TXD_1')),
      ).resolves.toEqual(taken);

      // The saga reads RECEIPT_CONFIRMED, and that dispute's decision.
      const view = await saga.run(6, 1, (a) => a.readOrder(orderId, taken.disputeId!));
      expect(view.status).toBe('RECEIPT_CONFIRMED');
      expect(view.mirroredDispute).toEqual({
        id: taken.disputeId,
        resolution: 'the supplier showed a signed delivery note',
      });
      // economic-service still has it DISPUTED: authorising now would answer
      // the dispute again, and the order would take a second one.
      expect(econ.obligation.status).toBe('DISPUTED');

      await saga.run(7, 1, (a) =>
        a.resolveObligationDispute(
          orderId,
          transactionId,
          taken.disputeId!,
          view.mirroredDispute!.resolution!,
          taken.economicDisputeId!,
        ),
      );
      expect(econ.obligation.status).toBe('PENDING_SETTLEMENT');
      await expect(
        saga.run(8, 1, (a) => a.authoriseSettlement(orderId, transactionId)),
      ).resolves.toBeUndefined();
      await expect(saga.run(9, 1, (a) => a.markSettling(orderId))).resolves.toBe('SETTLING');
      const settled = await saga.run(10, 1, (a) => a.settle(orderId, transactionId));
      await expect(
        saga.run(11, 1, (a) => a.markCompleted(orderId, settledResult(settled))),
      ).resolves.toBe('COMPLETED');
      expect(econ.obligation.status).toBe('SETTLED');
      expect(await disputesOf(orderId)).toEqual([
        {
          id: taken.disputeId,
          reason: OBJECTION,
          status: 'RESOLVED_SETTLE',
          raisedBy: 'economic-service',
        },
      ]);
    });

    it('reads the mirrored dispute by its id, not as the most recent one', async () => {
      const econ = expiredEconomic();
      const { orderId, saga } = await receiptConfirmed(econ.economic);
      const taken = await saga.run(5, 1, (a) => a.markObligationDisputed(orderId, OBJECTION));
      await asOperator(() =>
        wiring.orders.resolveDispute(orderId, {
          outcome: 'SETTLE',
          resolution: 'the supplier showed a signed delivery note',
          responsibility: 'BUYER',
        }),
      );
      await asBuyer(() =>
        wiring.orders.raiseDispute(orderId, { reason: 'the delivery note is for another order' }),
      );

      const view = await saga.run(6, 1, (a) => a.readOrder(orderId, taken.disputeId!));
      expect(view.status).toBe('DISPUTED');
      expect(view.dispute).toMatchObject({ reason: 'the delivery note is for another order' });
      expect(view.dispute!.id).not.toBe(taken.disputeId);
      expect(view.mirroredDispute).toEqual({
        id: taken.disputeId,
        resolution: 'the supplier showed a signed delivery note',
      });
      // Without an id, nothing about it; with another order's, nothing found.
      expect(await saga.run(7, 1, (a) => a.readOrder(orderId))).not.toHaveProperty(
        'mirroredDispute',
      );
      const other = await receiptConfirmed(expiredEconomic().economic);
      const elsewhere = await other.saga.run(5, 1, (a) =>
        a.markObligationDisputed(other.orderId, OBJECTION),
      );
      await expect(
        saga.run(8, 1, (a) => a.readOrder(orderId, elsewhere.disputeId!)),
      ).resolves.toMatchObject({ mirroredDispute: null });
    });

    it('yields to a dispute a party raised here meanwhile, and files no second one', async () => {
      const econ = expiredEconomic();
      const { orderId, saga } = await receiptConfirmed(econ.economic);
      await asBuyer(() =>
        wiring.orders.raiseDispute(orderId, { reason: 'the buyer disputes it here too' }),
      );

      // It files nothing, so it names nothing — not economic-service's dispute
      // either: the saga mirrors the party's.
      await expect(
        saga.run(5, 1, (a) => a.markObligationDisputed(orderId, OBJECTION, 'TXD_1')),
      ).resolves.toEqual({ status: 'DISPUTED', disputeId: null, economicDisputeId: null });
      expect(await disputesOf(orderId)).toMatchObject([
        { reason: 'the buyer disputes it here too' },
      ]);
    });

    it('yields to a refund an operator decided meanwhile: the saga refunds', async () => {
      const econ = expiredEconomic();
      const { orderId, saga } = await receiptConfirmed(econ.economic);
      await asBuyer(() =>
        wiring.orders.raiseDispute(orderId, { reason: 'the buyer disputes it here as well' }),
      );
      await asOperator(() =>
        wiring.orders.resolveDispute(orderId, {
          outcome: 'REFUND',
          resolution: 'the supplier took the goods back',
          responsibility: 'SUPPLIER',
        }),
      );

      await expect(
        saga.run(5, 1, (a) => a.markObligationDisputed(orderId, OBJECTION, 'TXD_1')),
      ).resolves.toEqual({ status: 'CANCELLING', disputeId: null, economicDisputeId: null });
      expect((await rowOf(orderId)).status).toBe('CANCELLING');
      expect(await disputesOf(orderId)).toMatchObject([{ status: 'RESOLVED_REFUND' }]);
    });

    // DISPUTED is reachable from HELD with no authorisation, and a record
    // that is not this order's own command proves nothing either.
    it.each([
      ['disputed from HELD: never authorised', null],
      ['authorised by a person', { service: null, idempotencyKey: null }],
      [
        'authorised by another service under this order’s key',
        { service: 'contract-service', idempotencyKey: 'ORDER_KEY' },
      ],
      [
        'authorised by this service under another order’s key',
        { service: 'marketplace-service', idempotencyKey: 'order:ORD_OTHER:authorise' },
      ],
    ])('%s, then disputed: still refused, and nothing recorded', async (_case, authorisation) => {
      const econ = expiredEconomic();
      const { orderId, saga, transactionId } = await receiptConfirmed(econ.economic);
      econ.disputeThere(OBJECTION);
      econ.obligation.settlementAuthorisation = authorisation && {
        authorisedAt: new Date().toISOString(),
        service: authorisation.service,
        idempotencyKey:
          authorisation.idempotencyKey === 'ORDER_KEY'
            ? `order:${orderId}:authorise`
            : authorisation.idempotencyKey,
      };

      await expect(
        saga.run(4, 1, (a) => a.authoriseSettlement(orderId, transactionId)),
      ).rejects.toMatchObject({ type: 'INVALID_STATE_TRANSITION' });
      expect(econ.calls.slice(2)).toEqual(['authoriseSettlement', 'readObligation']);
      expect(await recordsOf(orderId)).not.toContainEqual({ activity: 'authoriseSettlement' });
      expect((await rowOf(orderId)).status).toBe('RECEIPT_CONFIRMED');
    });
  });

  describe('a decision mirrored by economic-service’s identity of the dispute (Codex on #318 round 2, N1)', () => {
    const A = 'the payer counted two pallets short on arrival';
    const B = 'the invoice names another supplier';
    const DECIDED = 'the supplier showed a signed delivery note';

    /** Authorised, its answer lost, disputed there (A), and the retry's answer: A. */
    async function disputedAfterAuthorisation() {
      const econ = expiredEconomic();
      const run = await receiptConfirmed(econ.economic);
      econ.loseNextAnswer();
      await expect(
        run.saga.run(4, 1, (a) => a.authoriseSettlement(run.orderId, run.transactionId)),
      ).rejects.toMatchObject({ type: 'UPSTREAM_UNAVAILABLE' });
      econ.disputeThere(A);
      const answer = await run.saga.run(4, 2, (a) =>
        a.authoriseSettlement(run.orderId, run.transactionId),
      );
      expect(answer).toEqual({ disputed: true, reason: A, economicDisputeId: 'TXD_1' });
      return { econ, ...run, answer: answer! };
    }

    async function decide(orderId: string): Promise<void> {
      await asOperator(() =>
        wiring.orders.resolveDispute(orderId, {
          outcome: 'SETTLE',
          resolution: DECIDED,
          responsibility: 'BUYER',
        }),
      );
    }

    it('A resolved there and B raised before the order took A: the decision about A is refused, B stands, and nothing is recorded', async () => {
      const { econ, orderId, saga, transactionId, answer } = await disputedAfterAuthorisation();
      // Before the step that files A runs.
      econ.resolveThere('counted again: complete');
      econ.disputeThere(B);

      const taken = await saga.run(5, 1, (a) =>
        a.markObligationDisputed(orderId, answer.reason, answer.economicDisputeId),
      );
      // The order took A's words — stale — and A's identity with them.
      expect(taken).toMatchObject({ status: 'DISPUTED', economicDisputeId: 'TXD_1' });
      await decide(orderId);

      // Every attempt: economic-service holds B, and refuses a decision about A.
      for (const attempt of [1, 2, 3]) {
        await expect(
          saga.run(6, attempt, (a) =>
            a.resolveObligationDispute(
              orderId,
              transactionId,
              taken.disputeId!,
              DECIDED,
              taken.economicDisputeId!,
            ),
          ),
        ).rejects.toMatchObject({ type: 'INVALID_STATE_TRANSITION' });
      }
      expect(econ.obligation).toMatchObject({
        status: 'DISPUTED',
        disputeId: 'TXD_2',
        disputeReason: B,
      });
      expect(await recordsOf(orderId)).not.toContainEqual({
        activity: 'resolveObligationDispute',
      });
    });

    it('A resolved there before the decision is mirrored: A is out of the dispute, and the step is answered from the record', async () => {
      // D-053 (3), which a resolution's words could not reconcile: X there, the
      // operator's Y here. economic-service's resolution only releases the
      // transaction; the order's decision is what moves the money (Q-138).
      const { econ, orderId, saga, transactionId, answer } = await disputedAfterAuthorisation();
      const taken = await saga.run(5, 1, (a) =>
        a.markObligationDisputed(orderId, answer.reason, answer.economicDisputeId),
      );
      econ.resolveThere('counted again: complete');
      await decide(orderId);

      await saga.run(6, 1, (a) =>
        a.resolveObligationDispute(
          orderId,
          transactionId,
          taken.disputeId!,
          DECIDED,
          taken.economicDisputeId!,
        ),
      );
      expect(econ.calls.slice(-2)).toEqual(['resolveDispute', 'readObligation']);
      expect(await recordsOf(orderId)).toContainEqual({ activity: 'resolveObligationDispute' });
      await expect(
        saga.run(7, 1, (a) => a.authoriseSettlement(orderId, transactionId)),
      ).resolves.toBeUndefined();
    });

    it('A resolved there, then B raised and resolved there too: not A — refused', async () => {
      const { econ, orderId, saga, transactionId, answer } = await disputedAfterAuthorisation();
      const taken = await saga.run(5, 1, (a) =>
        a.markObligationDisputed(orderId, answer.reason, answer.economicDisputeId),
      );
      econ.resolveThere('counted again: complete');
      econ.disputeThere(B);
      econ.resolveThere('the invoice was reissued');
      await decide(orderId);

      await expect(
        saga.run(6, 1, (a) =>
          a.resolveObligationDispute(
            orderId,
            transactionId,
            taken.disputeId!,
            DECIDED,
            taken.economicDisputeId!,
          ),
        ),
      ).rejects.toMatchObject({ type: 'INVALID_STATE_TRANSITION' });
    });

    // A dispute mirrored before economic-service had identities, or by one
    // that has none: the words still decide, in the field economic-service
    // keeps them in.
    it.each([
      ['the same words, over the reason', false, DECIDED, true],
      ['the same words, kept apart from it', true, DECIDED, true],
      ['other words', false, 'counted again: complete', false],
    ])(
      'without an identity, resolved there with %s: answered only on the same words',
      async (_case, kept, words, answered) => {
        const { econ, orderId, saga, transactionId, answer } = await disputedAfterAuthorisation();
        const taken = await saga.run(5, 1, (a) => a.markObligationDisputed(orderId, answer.reason));
        expect(taken.economicDisputeId).toBeNull();
        econ.resolveThere(words, kept);
        await decide(orderId);

        const step = saga.run(6, 1, (a) =>
          a.resolveObligationDispute(orderId, transactionId, taken.disputeId!, DECIDED),
        );
        if (answered) await expect(step).resolves.toBeUndefined();
        else await expect(step).rejects.toMatchObject({ type: 'INVALID_STATE_TRANSITION' });
      },
    );

    it('a dispute the saga files: economic-service’s identity of it, also when read back after its answer was lost', async () => {
      const econ = expiredEconomic();
      const { orderId, saga, transactionId } = await receiptConfirmed(econ.economic);
      await asBuyer(() => wiring.orders.raiseDispute(orderId, { reason: A }));
      const { dispute } = await saga.run(5, 1, (a) => a.readOrder(orderId));

      econ.loseNextAnswer();
      await expect(
        saga.run(6, 1, (a) => a.disputeObligation(orderId, transactionId, dispute!.id, A)),
      ).rejects.toMatchObject({ type: 'UPSTREAM_UNAVAILABLE' });
      await expect(
        saga.run(6, 2, (a) => a.disputeObligation(orderId, transactionId, dispute!.id, A)),
      ).resolves.toBe('TXD_1');
      expect(econ.calls.slice(-2)).toEqual(['dispute', 'readObligation']);
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
