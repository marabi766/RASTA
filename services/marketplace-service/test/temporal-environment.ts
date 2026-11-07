import { mkdir } from 'node:fs/promises';
import {
  isGrpcCancelledError,
  isGrpcDeadlineError,
  type Connection,
  type WorkflowClientInterceptor,
} from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';

/**
 * One query attempt's deadline. A live worker answers well inside it even replaying a
 * long history cacheless under coverage; only a query no task will answer reaches it.
 */
export const QUERY_ATTEMPT_MS = 30_000;
/** Attempts before a query fails the test: 90 s, inside a spec's 120 s timeout. */
export const QUERY_ATTEMPTS = 3;

/**
 * Every query through the environment's client has a deadline, and a query the run
 * under it closed on is asked again.
 *
 * The time-skipping test server does not answer a query that reaches a run in the
 * workflow task that continues it as new: the run runs no more tasks, so the query is
 * either cancelled (`CANCELLED`) or left waiting. With no deadline it waited until the
 * server dropped the connection for keepalive pings (~80 s, then longer, as gRPC
 * doubles the ping interval), past the test's timeout (#935, run 42391595495); still
 * waiting at teardown, its gRPC retry then fired into the next spec file of the same
 * in-band run ("Channel has been shut down"). Asked again, it reaches the new run
 * (`getHandle(id)` follows the chain); a query writes nothing, so asking twice changes
 * nothing.
 *
 * The caller's own bound stays the caller's (`test/worker-deadline.ts`, FU-192): an
 * attempt never outlives the caller's deadline, and once that deadline has passed or
 * the caller's abort signal fired, the failure is the caller's answer and is thrown
 * as it came, never asked again. So is any other failure (an unregistered query, a
 * missing workflow), and a saga that answers no attempt fails the test, named.
 */
export function boundedQueries(
  connection: () => Connection,
  attemptMs: number = QUERY_ATTEMPT_MS,
): WorkflowClientInterceptor {
  return {
    async query(input, next) {
      const conn = connection();
      const caller = conn.callContextStorage.getStore();
      const callerDeadline =
        caller?.deadline === undefined ? Infinity : new Date(caller.deadline).getTime();
      for (let attempt = 1; ; attempt += 1) {
        const deadline = Math.min(callerDeadline, Date.now() + attemptMs);
        try {
          return await conn.withDeadline(deadline, () => next(input));
        } catch (error) {
          if (caller?.abortSignal?.aborted || Date.now() >= callerDeadline) throw error;
          if (!isGrpcDeadlineError(error) && !isGrpcCancelledError(error)) throw error;
          if (attempt >= QUERY_ATTEMPTS) {
            throw new Error(
              `query ${input.queryType} on ${input.workflowExecution.workflowId} answered none of ${QUERY_ATTEMPTS} attempts of ${attemptMs} ms`,
              { cause: error },
            );
          }
        }
      }
    },
  };
}

/**
 * `queryAttemptMs` only for the spec that proves the bound: it waits out one attempt on
 * purpose, and the marketplace coverage gate's step budget is tight.
 */
export async function createTemporalTestEnvironment(
  options: { queryAttemptMs?: number } = {},
): Promise<TestWorkflowEnvironment> {
  const downloadDir = process.env.TEMPORAL_TEST_SERVER_DIR;
  if (process.env.CI && !downloadDir) {
    throw new Error('Temporal specs in CI require TEMPORAL_TEST_SERVER_DIR');
  }
  // cached-download fetches a missing executable; ensure a cold cache has a directory.
  if (downloadDir) await mkdir(downloadDir, { recursive: true });
  const env: TestWorkflowEnvironment = await TestWorkflowEnvironment.createTimeSkipping({
    server: { executable: { type: 'cached-download', downloadDir, ttl: '30 days' } },
    client: {
      interceptors: {
        workflow: [
          // Read at the first query, once `env` is set.
          boundedQueries(() => env.connection, options.queryAttemptMs),
        ],
      },
    },
  });
  return env;
}
