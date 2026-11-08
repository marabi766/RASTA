import { AsyncLocalStorage } from 'node:async_hooks';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import type { CallContext, Connection, WorkflowQueryInput } from '@temporalio/client';
import {
  boundedQueries,
  createTemporalTestEnvironment,
  QUERY_ATTEMPTS,
} from '../../test/temporal-environment';
import { eventually, signalling, stopQuietly } from '../../test/legacy-handoff';
import { runBounded, SETTLE_MS, startDeadline, type Deadline } from '../../test/worker-deadline';
import { orderSaga, retryDisputeRelease, type SagaStatus } from './workflows';
import { REFUSED_ON_FIRST_ATTEMPT } from './economic-refusal';
import type { OrderActivities } from './activities';

/**
 * The shared Temporal test environment answers a query that reaches a saga as it
 * continues as new. The time-skipping server leaves such a query unanswered; with no
 * deadline it hung the spec past its timeout in CI (#935, run 42391595495).
 */

jest.setTimeout(180_000);

const grpcError = (code: number) =>
  Object.assign(new Error(`${code} grpc`), { code, details: 'grpc', metadata: {} });
const INPUT = {} as WorkflowQueryInput;
/** The SDK's call context, as `Connection` keeps it: a deadline replaces, the rest stays. */
const callContextStorage = new AsyncLocalStorage<CallContext>();
const connection = {
  callContextStorage,
  withDeadline: (deadline: number | Date, fn: () => Promise<unknown>) =>
    callContextStorage.run({ ...callContextStorage.getStore(), deadline }, fn),
} as unknown as Connection;
const asCaller = <T>(context: CallContext, fn: () => Promise<T>) =>
  callContextStorage.run(context, fn);

describe('a query through the Temporal test environment', () => {
  describe('asks again only on a deadline or a cancelled call, never past the caller', () => {
    const query = boundedQueries(() => connection).query!;

    it('answers on a later attempt after a deadline and a cancelled call', async () => {
      const next = jest
        .fn()
        .mockRejectedValueOnce(grpcError(4))
        .mockRejectedValueOnce(grpcError(1))
        .mockResolvedValueOnce('answer');
      await expect(query(INPUT, next)).resolves.toBe('answer');
      expect(next).toHaveBeenCalledTimes(3);
    });

    it('throws any other failure at once', async () => {
      const next = jest.fn().mockRejectedValue(grpcError(5));
      await expect(query(INPUT, next)).rejects.toThrow('5 grpc');
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('fails, named, once no attempt is answered', async () => {
      const next = jest.fn().mockRejectedValue(grpcError(4));
      const input = { queryType: 'status', workflowExecution: { workflowId: 'W' } };
      await expect(query(input as WorkflowQueryInput, next)).rejects.toThrow(
        `query status on W answered none of ${QUERY_ATTEMPTS} attempts`,
      );
      expect(next).toHaveBeenCalledTimes(QUERY_ATTEMPTS);
    });

    it("throws the caller's abort as it came, never asked again", async () => {
      const abort = new AbortController();
      abort.abort();
      const next = jest.fn().mockRejectedValue(grpcError(1));
      await expect(
        asCaller({ abortSignal: abort.signal }, () => query(INPUT, next)),
      ).rejects.toThrow('1 grpc');
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("throws past the caller's deadline as it came, never asked again", async () => {
      const next = jest.fn().mockRejectedValue(grpcError(4));
      await expect(
        asCaller({ deadline: Date.now() - 1 }, () => query(INPUT, next)),
      ).rejects.toThrow('4 grpc');
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("never gives an attempt longer than the caller's deadline", async () => {
      const callerDeadline = Date.now() + 1_000;
      let seen: number | Date | undefined;
      const next = jest.fn(async () => {
        seen = callContextStorage.getStore()?.deadline;
        return 'answer';
      });
      await asCaller({ deadline: callerDeadline }, () => query(INPUT, next));
      expect(seen).toBe(callerDeadline);
      await query(INPUT, next);
      expect(Number(seen)).toBeGreaterThan(callerDeadline);
    });
  });

  describe('against the test server', () => {
    let env: TestWorkflowEnvironment;
    let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
    beforeAll(async () => {
      workflowBundle = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows') });
      // A 5 s attempt: the case waits one out on purpose.
      env = await createTemporalTestEnvironment({ queryAttemptMs: 5_000 });
    }, 300_000);
    afterAll(async () => {
      await env?.teardown();
    });

    it('is answered when it reaches a saga in the task that rolls it over', async () => {
      const id = 'query-across-rollover';
      const latest = () => env.client.workflow.getHandle(id);
      const queries: Promise<string>[] = [];
      /** Set once the run is under way: the deadline every query it sends is bounded by. */
      let run: Deadline | undefined;
      const order = { status: 'DISPUTED', economicTransactionId: 'TXN', cancellationReason: null };
      const dispute = { id: 'DSP_1', reason: 'it arrived broken', resolution: null };
      const refused = () =>
        // A refusal on the first attempt with the money held: the saga waits, and each
        // round it is nudged it calls, reports, and past 16 events rolls over.
        Promise.reject(
          ApplicationFailure.create({
            message: 'refused',
            type: 'FORBIDDEN',
            nonRetryable: true,
            details: [REFUSED_ON_FIRST_ATTEMPT],
          }),
        );
      const reported = () => {
        // The report is the last step before the rollover: a query sent just after it
        // reaches the task that continues the saga as new. Sent from the activity, it is
        // the run's all the same: its pause and its call end with the run's deadline, and
        // the worker stops only once the run has awaited it (FU-214).
        if (!run) throw new Error('a report outside the run');
        const bound = run;
        const phase = bound
          .sleep(2)
          .then(() => bound.call(() => latest().query<SagaStatus, []>('status')))
          .then((status) => status.phase);
        // Awaited below; one sent after that, ended with the run, is not an unhandled rejection.
        phase.catch(() => undefined);
        queries.push(phase);
      };
      const stub: Record<string, () => unknown> = {
        readOrder: () => ({ ...order, dispute }),
        findObligation: () => ({ transactionId: 'TXN' }),
        noHoldCanLand: () => true,
        disputeObligation: refused,
        noteEconomicCallUnconfirmed: reported,
        markObligationDisputed: () => ({
          status: 'DISPUTED',
          disputeId: null,
          economicDisputeId: null,
        }),
      };
      // Every other step is never reached on this path, and answers the order's status.
      const names = [
        'authoriseSettlement',
        'settle',
        'resolveObligationDispute',
        'compensate',
        'recordReminder',
        'markSettling',
        'markSettlementFailed',
        'markCompleted',
        'markCancelled',
        'markFundsHeld',
        'markFailed',
        'createObligation',
        'noteReleaseUnconfirmed',
      ];
      const activities = Object.fromEntries([
        ...names.map((name) => [name, async () => 'DISPUTED']),
        ...Object.entries(stub).map(([name, fn]) => [name, async () => fn()]),
      ]) as unknown as OrderActivities;
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: id,
        workflowBundle,
        activities,
      });
      const outcome = await runBounded(
        worker,
        // Room for 40 rollovers and the 30 s wait for the queries, inside jest's timeout.
        { what: 'the saga to roll over 40 times', ms: 150_000, connection: env.connection },
        async (deadline) => {
          run = deadline;
          const handle = await env.client.workflow.start(orderSaga, {
            taskQueue: id,
            workflowId: id,
            args: [
              {
                orderId: 'ORD_ROLL',
                fulfillmentWindowDays: 7,
                receiptWindowDays: 3,
                reminderIntervalDays: 3,
                recheckIntervalHours: 24 * 365,
                historyEventThreshold: 16,
              },
            ],
          });
          let result: { runs: number; phases: string[] };
          try {
            const runs = new Set<string>([handle.firstExecutionRunId]);
            // Nudged only at rest, as the specs do: the test server fails a workflow task a
            // signal reaches while it runs, so a faster nudge never lets one end.
            const atRest = () =>
              eventually(
                deadline,
                async () => {
                  const last = (await latest().fetchHistory()).events?.at(-1);
                  return Boolean(
                    last?.timerStartedEventAttributes ??
                    last?.timerCanceledEventAttributes ??
                    last?.workflowTaskCompletedEventAttributes,
                  );
                },
                'the saga to come to rest',
                10,
              );
            // Its signals never land on a timer about to fire either (FU-214).
            const current = signalling(env, latest());
            while (runs.size < 40) {
              await atRest();
              await current.signal(retryDisputeRelease);
              runs.add((await latest().describe()).runId);
            }
            await atRest();
            // One attempt (5 s here) answers a query the rollover dropped; the 30 s bound sits
            // below the ~80 s at which the server's keepalive GOAWAY would free an unbounded
            // one, so only the interceptor can make it. On expiry the run fails, and its end
            // aborts the queries still waiting.
            const answered = startDeadline('every query to be answered', 30_000);
            try {
              const phases = await answered.guard(Promise.all(queries));
              result = { runs: runs.size, phases };
            } finally {
              answered.stop();
            }
          } catch (error) {
            // However the run ends, the saga is stopped from a quiet history (FU-214); the
            // run's own failure says more than one about stopping.
            await stopQuietly(env.connection, latest(), SETTLE_MS / 4);
            throw error;
          }
          const loud = await stopQuietly(env.connection, latest(), SETTLE_MS / 4);
          if (loud !== undefined) throw new Error(`${loud}: stopped with an activity in flight`);
          return result;
        },
      );
      expect(outcome.runs).toBeGreaterThanOrEqual(40);
      expect(outcome.phases.length).toBeGreaterThanOrEqual(40);
      expect(new Set(outcome.phases)).toEqual(new Set(['OBLIGATION_RECONCILIATION']));
    });
  });
});
