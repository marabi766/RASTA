import { Logger } from '@nestjs/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import { WorkflowFailedError } from '@temporalio/client';
import type { WorkflowHandle, WorkflowHandleWithFirstExecutionRunId } from '@temporalio/client';
import { RastaError } from '@rasta/nest-common';
import { createTemporalTestEnvironment } from '../../test/temporal-environment';
import { eventually as askUntil, signalling, stopQuietly } from '../../test/legacy-handoff';
import { currentDeadline, runBounded, SETTLE_MS } from '../../test/worker-deadline';
import { economicCallsUnconfirmedTotal } from '../observability/metrics';
import {
  disputeResolved,
  orderSaga,
  REFUSAL_RECONCILES_PATCH,
  retryDisputeRelease,
  type OrderSagaInput,
  type SagaStatus,
} from './workflows';
import { createActivities, type OrderActivities } from './activities';
import { REFUSED_ON_FIRST_ATTEMPT } from './economic-refusal';
import type { EconomicClient } from '../economic/economic.client';
import type { OrderService } from '../order/order.service';

/**
 * D-127 (FU-158): a refusal proven on its first attempt does not end the saga while the
 * money may be held. The refund, the filing and the authorisation each wait, alerted, until
 * the call is answered or the owner's terminal status decides; only an obligation back with
 * the buyer or never held lets the refusal end the saga as before.
 */

/**
 * What the worker runs of one test may take, all of them together (FU-214): every wait and
 * SDK call in a test ends with it, inside jest's timeout, with room to stop what it started.
 */
const TEST_BUDGET_MS = 90_000;
jest.setTimeout(TEST_BUDGET_MS + 60_000);
/** How long, at least, a saga is given to come quiet before it is terminated. */
const QUIET_FLOOR_MS = SETTLE_MS / 4;

const INPUT: OrderSagaInput = {
  orderId: 'ORD_REFUSED',
  fulfillmentWindowDays: 7,
  receiptWindowDays: 3,
  reminderIntervalDays: 3,
  recheckIntervalHours: 24 * 365,
};
const TXN = 'TXN_REFUSED';
const DISPUTE = { id: 'DSP_1', reason: 'it arrived broken', resolution: null };
const SETTLED = { settlementId: 'STL', commissionAmountMinor: '1', netAmountMinor: '2' };
const HELD = { transactionId: TXN };
const notHeld = (status: string, funds: string, transactionId = TXN) => ({
  notHeld: true,
  transactionId,
  status,
  funds,
});
const final = (status: string, funds: string) => ({ final: true, status, funds });
const down = () => ApplicationFailure.retryable('down', 'UPSTREAM_UNAVAILABLE');
const firstAttemptRefusal = (code: string) =>
  ApplicationFailure.create({
    message: 'refused',
    type: code,
    nonRetryable: true,
    details: [REFUSED_ON_FIRST_ATTEMPT],
  });
const CODES = ['FORBIDDEN', 'NOT_FOUND', 'BUSINESS_RULE_VIOLATION'];

interface State {
  status: string;
  economicTransactionId: string | null;
  cancellationReason: string | null;
  dispute: typeof DISPUTE | null;
}
const cancelling: Partial<State> = {
  status: 'CANCELLING',
  cancellationReason: 'changed their mind',
  economicTransactionId: TXN,
};
const receipt: Partial<State> = { status: 'RECEIPT_CONFIRMED', economicTransactionId: TXN };
const disputed: Partial<State> = {
  status: 'DISPUTED',
  economicTransactionId: TXN,
  dispute: DISPUTE,
};

function markersOf(history: Awaited<ReturnType<WorkflowHandle['fetchHistory']>>): string[] {
  return (history.events ?? []).flatMap((event) => {
    const payload = event.markerRecordedEventAttributes?.details?.['patch-data']?.payloads?.[0];
    if (!payload?.data) return [];
    return [(JSON.parse(Buffer.from(payload.data).toString()) as { id: string }).id];
  });
}

describe('a first-attempt refusal with the money possibly held (D-127)', () => {
  let env: TestWorkflowEnvironment;
  let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
  let queues = 0;
  /** Set when a test may have stalled the server's clock: the next test gets a new one. */
  let stalled = false;
  let budgetEndsAt = 0;

  beforeAll(async () => {
    workflowBundle = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows') });
    env = await createTemporalTestEnvironment();
  }, 300_000);
  beforeEach(async () => {
    if (stalled) {
      // The new one first: `env` never names a server already torn down.
      const fresh = await createTemporalTestEnvironment();
      await env.teardown();
      env = fresh;
      stalled = false;
    }
    budgetEndsAt = Date.now() + TEST_BUDGET_MS;
  }, 300_000);
  afterAll(async () => {
    await env?.teardown();
  });

  type Fn = (...args: never[]) => unknown;
  function saga(start: Partial<State>, acts: (state: State) => Record<string, Fn> = () => ({})) {
    const state: State = {
      status: 'PENDING',
      economicTransactionId: null,
      cancellationReason: null,
      dispute: null,
      ...start,
    };
    const calls: string[] = [];
    const sent: Record<string, unknown[][]> = {};
    const rounds: string[] = [];
    const base: Record<string, Fn> = {
      readOrder: () => ({ ...state, dispute: state.status === 'DISPUTED' ? state.dispute : null }),
      findObligation: () => HELD,
      noHoldCanLand: () => true,
      authoriseSettlement: () => undefined,
      settle: () => SETTLED,
      disputeObligation: () => 'ECON_1',
      resolveObligationDispute: () => undefined,
      compensate: () => undefined,
      recordReminder: () => undefined,
      markSettling: () =>
        ['DISPUTED', 'CANCELLING'].includes(state.status)
          ? state.status
          : (state.status = 'SETTLING'),
      markSettlementFailed: () => (state.status = 'RECEIPT_CONFIRMED'),
      markObligationDisputed: () => ({
        status: 'DISPUTED',
        disputeId: null,
        economicDisputeId: null,
      }),
      markCompleted: () => (state.status = 'COMPLETED'),
      markCancelled: () => (state.status = 'CANCELLED'),
      markFundsHeld: () => state.status,
      markFailed: () => state.status,
      createObligation: () => ({ transactionId: TXN }),
      noteReleaseUnconfirmed: () => undefined,
      noteEconomicCallUnconfirmed: () => undefined,
      ...acts(state),
    };
    const activities = Object.fromEntries(
      Object.entries(base).map(([name, fn]) => [
        name,
        async (...args: never[]) => {
          calls.push(name);
          (sent[name] ??= []).push(args);
          if (name === 'noteEconomicCallUnconfirmed') {
            rounds.push(`${String(args[1])}: ${String(args[3])}`);
          }
          return fn(...args);
        },
      ]),
    ) as unknown as OrderActivities;
    return { state, calls, sent, rounds, activities };
  }
  type Saga = ReturnType<typeof saga>;

  async function drive<T>(
    { activities }: Saga,
    body: (handle: WorkflowHandleWithFirstExecutionRunId, taskQueue: string) => Promise<T>,
    input: Partial<OrderSagaInput> = {},
    worker?: (activities: OrderActivities) => OrderActivities,
  ): Promise<T> {
    const taskQueue = `refused-${(queues += 1)}`;
    const running = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: worker ? worker(activities) : activities,
    });
    // Under what is left of the test's budget (FU-214): every wait and SDK call in `body`
    // ends with it, and `body` is awaited before the worker stops.
    const ms = Math.max(budgetEndsAt - Date.now(), 0);
    return runBounded(
      running,
      { what: 'the test to drive the saga', ms, connection: env.connection },
      async (deadline) => {
        // Follows the chain: what is stopped is the run the saga is in at the end.
        const latest = env.client.workflow.getHandle(taskQueue);
        let result: T;
        try {
          const handle = signalling(
            env,
            await env.client.workflow.start(orderSaga, {
              taskQueue,
              workflowId: taskQueue,
              args: [{ ...INPUT, ...input }],
            }),
          );
          result = await body(handle, taskQueue);
        } catch (error) {
          // Cut off, an awaited result may have left the clock unlocked, and what follows
          // must fit in the settle window; otherwise the saga gets what is left of the
          // budget to come quiet, as on success.
          const cutOff = deadline.signal.aborted;
          if (cutOff) stalled = true;
          const window = cutOff
            ? QUIET_FLOOR_MS
            : Math.max(budgetEndsAt - Date.now(), QUIET_FLOOR_MS);
          if ((await stopQuietly(env.connection, latest, window, QUIET_FLOOR_MS)) !== undefined) {
            stalled = true;
          }
          throw error;
        }
        // Not with an activity running: the test server would not skip time again.
        const window = Math.max(budgetEndsAt - Date.now(), QUIET_FLOOR_MS);
        const loud = await stopQuietly(env.connection, latest, window, QUIET_FLOOR_MS);
        if (loud !== undefined) {
          stalled = true;
          throw new Error(`${loud}: stopped with an activity in flight`);
        }
        return result;
      },
    );
  }

  /** Asks until `predicate` holds, under the run's deadline; refused outside a run (FU-214). */
  const eventually = (predicate: () => boolean | Promise<boolean>, what: string): Promise<void> =>
    askUntil(currentDeadline(what), async () => predicate(), what);
  /**
   * `handle.result()`, under the run's deadline: a saga that never ends fails the test, and
   * the body is awaited before the worker stops (FU-214); outside a run it is refused.
   */
  const resultOf = <R>(handle: WorkflowHandle): Promise<R> =>
    currentDeadline('the saga to end').call(() => handle.result() as Promise<R>);
  const phase = async (handle: WorkflowHandle) =>
    (await handle.query<SagaStatus, []>('status')).phase;
  const phaseIs = (handle: WorkflowHandle, expected: string) =>
    eventually(async () => (await phase(handle)) === expected, `phase ${expected}`);
  async function atRest(handle: WorkflowHandle) {
    await eventually(async () => {
      if ((await handle.describe()).status.name !== 'RUNNING') return true;
      const last = (await handle.fetchHistory()).events?.at(-1);
      return Boolean(
        last?.timerStartedEventAttributes ??
        last?.timerCanceledEventAttributes ??
        last?.workflowTaskCompletedEventAttributes,
      );
    }, 'the saga to come to rest');
  }
  async function retry(handle: WorkflowHandle, change: () => void = () => undefined) {
    await atRest(handle);
    change();
    await handle.signal(retryDisputeRelease);
  }
  const reported = (s: Saga, count = 1) =>
    eventually(() => s.rounds.length >= count, `${count} reported round(s)`);
  const stays = async (s: Saga, handle: WorkflowHandle, count = 1) => {
    await reported(s, count);
    await phaseIs(handle, 'OBLIGATION_RECONCILIATION');
    expect((await handle.describe()).status.name).toBe('RUNNING');
  };
  /** The refusal the run ended on, as the caller of the workflow sees it. */
  async function endsOn(handle: WorkflowHandle): Promise<string | undefined> {
    const error: unknown = await resultOf(handle).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(WorkflowFailedError);
    const cause = (error as WorkflowFailedError).cause?.cause;
    return cause instanceof ApplicationFailure ? (cause.type ?? undefined) : undefined;
  }

  describe('the refund', () => {
    it.each(CODES)(
      'refused %s on its first attempt by the real activity, its obligation HELD: alerted, and cancelled only once refunded',
      async (code) => {
        // The real activity marks the first attempt; every round after it asks in doubt.
        let refusing = true;
        const real = createActivities({
          orders: {
            describe: async () => ({
              id: INPUT.orderId,
              buyerOrganizationId: 'ORG',
              correlationId: 'COR',
            }),
            onceForSaga: (_o: unknown, _s: unknown, _a: unknown, call: () => unknown) => call(),
            // The durable call record (#836, FU-145): opened before the call, confirmed after it.
            openSagaCall: async () => ({ generation: 1, started: true }),
            confirmSagaCall: async () => undefined,
            confirmSagaCallsOn: async () => undefined,
          } as unknown as OrderService,
          economic: {
            refund: async () => {
              if (refusing) throw new RastaError(code as never, 'refused');
            },
            readObligation: async () => ({ status: refusing ? 'HELD' : 'REFUNDED' }),
          } as unknown as EconomicClient,
          currentStep: () => ({ key: 'K', scheduledAt: new Date(0) }),
          currentAttempt: () => 1,
        });
        const count = async () =>
          (await economicCallsUnconfirmedTotal.get()).values.find(
            (value) => value.labels.operation === 'compensate',
          )?.value ?? 0;
        const before = await count();
        const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
        const s = saga(cancelling);
        try {
          const result = await drive(
            s,
            async (handle) => {
              await stays(s, handle);
              // The alert's series, from the real activity, names the refusal.
              expect(await count()).toBeGreaterThan(before);
              expect(logged.mock.calls.some(([line]) => String(line).includes(code))).toBe(true);
              expect(s.rounds[0]).toBe(`compensate: ${code}: refused`);
              expect(s.calls).not.toContain('markCancelled');
              await retry(handle, () => {
                refusing = false;
              });
              return resultOf<string>(handle);
            },
            {},
            (stubs) => ({
              ...stubs,
              compensate: real.compensate,
              noteEconomicCallUnconfirmed: async (
                ...args: Parameters<OrderActivities['noteEconomicCallUnconfirmed']>
              ) => {
                await stubs.noteEconomicCallUnconfirmed(...args);
                return real.noteEconomicCallUnconfirmed(...args);
              },
            }),
          );
          expect(result).toBe('CANCELLED');
          expect(s.state.status).toBe('CANCELLED');
          expect(s.calls.at(-1)).toBe('markCancelled');
        } finally {
          logged.mockRestore();
        }
      },
    );

    it.each([
      ['a lookup that fails', () => Promise.reject(down())],
      ['no obligation found', () => null],
      ['another transaction, refunded', () => notHeld('REFUNDED', 'RETURNED', 'TXN_OTHER')],
      ['CREATED, which can still be held', () => notHeld('CREATED', 'NEVER_HELD')],
      ['SETTLED', () => notHeld('SETTLED', 'PAID_OUT')],
      ['other terms', () => ({ mismatch: true, transactionIds: ['TXN_X'], differ: ['amount'] })],
    ])('with the obligation unknown (%s), it stays too', async (_what, lookup) => {
      const s = saga(cancelling, () => ({
        compensate: () => Promise.reject(firstAttemptRefusal('FORBIDDEN')),
        findObligation: lookup as Fn,
      }));
      await drive(s, async (handle) => {
        await stays(s, handle);
        await retry(handle);
        await stays(s, handle, 2);
      });
      expect(s.calls).not.toContain('markCancelled');
      // Every round after the first asks in doubt, so its refusal proves nothing.
      expect(s.sent.compensate?.[0]?.[3]).toBe(false);
      expect(s.sent.compensate?.slice(1).every((args) => args[3] === true)).toBe(true);
    });

    it.each([
      ['REFUNDED', 'RETURNED'],
      ['FAILED', 'NEVER_HELD'],
      ['CANCELLED', 'NEVER_HELD'],
    ])(
      'with the obligation %s (funds %s), the refusal ends the saga as before, unalerted',
      async (status, funds) => {
        const s = saga(cancelling, () => ({
          compensate: () => Promise.reject(firstAttemptRefusal('BUSINESS_RULE_VIOLATION')),
          findObligation: () => notHeld(status, funds),
        }));
        const code = await drive(s, (handle) => endsOn(handle));
        expect(code).toBe('BUSINESS_RULE_VIOLATION');
        expect(s.rounds).toEqual([]);
        expect(s.calls).not.toContain('markCancelled');
        expect(s.calls.filter((name) => name === 'compensate')).toHaveLength(1);
      },
    );

    it.each([
      ['funds never held', final('CANCELLED', 'NEVER_HELD'), 'CANCELLED'],
      ['a refund by hand', final('REFUNDED', 'RETURNED'), 'CANCELLED'],
    ])('in the wait, %s lets the order be cancelled', async (_what, answer, expected) => {
      let answered = false;
      const s = saga(cancelling, () => ({
        compensate: () => (answered ? answer : Promise.reject(firstAttemptRefusal('NOT_FOUND'))),
      }));
      const result = await drive(s, async (handle) => {
        await stays(s, handle);
        await retry(handle, () => {
          answered = true;
        });
        return resultOf<string>(handle);
      });
      expect(result).toBe(expected);
      expect(s.calls.at(-1)).toBe('markCancelled');
    });

    it('in the wait, an obligation paid out never cancels the order', async () => {
      let answered = false;
      const s = saga(cancelling, () => ({
        compensate: () =>
          answered
            ? final('SETTLED', 'PAID_OUT')
            : Promise.reject(firstAttemptRefusal('FORBIDDEN')),
      }));
      await drive(s, async (handle) => {
        await stays(s, handle);
        await retry(handle, () => {
          answered = true;
        });
        await eventually(() => s.rounds.some((round) => round.includes('SETTLED')), 'F3 round');
        await stays(s, handle, 2);
      });
      expect(s.calls).not.toContain('markCancelled');
    });

    it.each([
      ['compensate', cancelling, 3],
      ['disputeObligation', disputed, 4],
      ['authoriseSettlement', receipt, 2],
    ] as const)(
      '%s: the doubt and the phase go across a rollover, so a later code does not end it',
      async (call, start, inDoubtAt) => {
        const s = saga(start, () => ({
          [call]: () => Promise.reject(firstAttemptRefusal('FORBIDDEN')),
        }));
        await drive(
          s,
          async (handle, id) => {
            await stays(s, handle);
            // Its signals, too, never land on a timer about to fire (FU-214).
            const latest = signalling(env, env.client.workflow.getHandle(id));
            const deadline = currentDeadline('the saga to roll over');
            for (let i = 0; i < 40; i += 1) {
              if ((await latest.describe()).runId !== handle.firstExecutionRunId) break;
              await retry(latest);
              await deadline.sleep(100);
            }
            expect((await latest.describe()).runId).not.toBe(handle.firstExecutionRunId);
            const rounds = s.rounds.length;
            await retry(latest);
            await reported(s, rounds + 1);
            await phaseIs(latest, 'OBLIGATION_RECONCILIATION');
            expect((await latest.describe()).status.name).toBe('RUNNING');
          },
          { historyEventThreshold: 16 },
        );
        expect(s.calls).not.toContain('markCancelled');
        expect(s.calls).not.toContain('settle');
        expect(s.sent[call]?.length).toBeGreaterThan(2);
        expect(s.sent[call]?.slice(1).every((args) => args[inDoubtAt] === true)).toBe(true);
      },
    );

    it('records its marker only on such a refusal', async () => {
      const refused = saga(cancelling, () => ({
        compensate: () => Promise.reject(firstAttemptRefusal('FORBIDDEN')),
      }));
      const marked = await drive(refused, async (handle) => {
        await stays(refused, handle);
        return markersOf(await handle.fetchHistory());
      });
      expect(marked).toContain(REFUSAL_RECONCILES_PATCH);

      const answered = saga(cancelling);
      const unmarked = await drive(answered, async (handle) => {
        await resultOf(handle);
        return markersOf(await handle.fetchHistory());
      });
      expect(unmarked).not.toContain(REFUSAL_RECONCILES_PATCH);
    });
  });

  describe('the same exit at the filing and the authorisation (siblings)', () => {
    it('a filing refused on its first attempt, the obligation HELD, stays until filed', async () => {
      let refusing = true;
      const s = saga(disputed, () => ({
        disputeObligation: () =>
          refusing ? Promise.reject(firstAttemptRefusal('FORBIDDEN')) : 'ECON_1',
      }));
      await drive(s, async (handle) => {
        await stays(s, handle);
        expect(s.rounds[0]).toBe('disputeObligation: FORBIDDEN: refused');
        await retry(handle, () => {
          refusing = false;
        });
        await phaseIs(handle, 'DISPUTED');
      });
      expect(s.sent.disputeObligation?.at(-1)?.[4]).toBe(true);
    });

    it('a filing refused on its first attempt, the obligation REFUNDED, ends as before', async () => {
      const s = saga(disputed, () => ({
        disputeObligation: () => Promise.reject(firstAttemptRefusal('NOT_FOUND')),
        findObligation: () => notHeld('REFUNDED', 'RETURNED'),
      }));
      expect(await drive(s, (handle) => endsOn(handle))).toBe('NOT_FOUND');
      expect(s.rounds).toEqual([]);
    });

    it('an authorisation refused on its first attempt, the obligation HELD, stays until authorised', async () => {
      let refusing = true;
      const s = saga(receipt, () => ({
        authoriseSettlement: () =>
          refusing ? Promise.reject(firstAttemptRefusal('BUSINESS_RULE_VIOLATION')) : undefined,
      }));
      const result = await drive(s, async (handle) => {
        await stays(s, handle);
        expect(s.rounds[0]).toBe('authoriseSettlement: BUSINESS_RULE_VIOLATION: refused');
        expect(s.calls).not.toContain('settle');
        await retry(handle, () => {
          refusing = false;
        });
        return resultOf<string>(handle);
      });
      expect(result).toBe('COMPLETED');
      expect(s.sent.authoriseSettlement?.at(-1)?.[2]).toBe(true);
    });

    it('an authorisation refused and waiting, then disputed and decided REFUND: the refund goes in doubt, nothing settles', async () => {
      const s = saga(receipt, () => ({
        authoriseSettlement: () => Promise.reject(firstAttemptRefusal('BUSINESS_RULE_VIOLATION')),
      }));
      const result = await drive(s, async (handle) => {
        await stays(s, handle);
        await retry(handle, () => {
          s.state.status = 'DISPUTED';
          s.state.dispute = DISPUTE;
        });
        await phaseIs(handle, 'DISPUTED');
        await atRest(handle);
        s.state.status = 'CANCELLING';
        s.state.cancellationReason = 'decided for the buyer';
        await handle.signal(disputeResolved, 'REFUND');
        return resultOf<string>(handle);
      });
      expect(result).toBe('CANCELLED');
      expect(s.calls).not.toContain('settle');
      expect(s.calls).not.toContain('markSettling');
      // The authorisation left in doubt puts the filing and the refund after it in doubt too.
      expect(s.sent.disputeObligation?.[0]?.[4]).toBe(true);
      expect(s.sent.compensate?.[0]?.[3]).toBe(true);
      expect(s.calls.at(-1)).toBe('markCancelled');
    });

    it('an authorisation refused on its first attempt, never held, ends as before', async () => {
      const s = saga(receipt, () => ({
        authoriseSettlement: () => Promise.reject(firstAttemptRefusal('FORBIDDEN')),
        findObligation: () => notHeld('FAILED', 'NEVER_HELD'),
      }));
      expect(await drive(s, (handle) => endsOn(handle))).toBe('FORBIDDEN');
      expect(s.calls).not.toContain('settle');
    });
  });
});
