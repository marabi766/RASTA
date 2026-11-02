import type { EventEnvelope } from '@rasta/contracts';
import { KeycloakProjectionConsumer, REPROJECTED_EVENTS } from './keycloak-projection.consumer';
import type { KeycloakProjector } from './keycloak.projector';
import type { EventConsumer, EventHandler } from '@rasta/nest-common';
import { COMMIT_RESERVE_MS, throwIfCancelled } from '../prisma/cancellation';
import { gate, modelledPool } from '../../test/modelled-engine';
import { onTheTestsClock, returnedBy, until } from '../../test/test-clock';

/**
 * The durable path of the Keycloak projection: each membership or role event
 * re-projects the user it names, so a write that failed after its change
 * committed still lands (ADR-060 § 5).
 */
describe('KeycloakProjectionConsumer', () => {
  const project = jest.fn(async () => 'projected' as const);
  const consumer = new KeycloakProjectionConsumer(null, {
    project,
  } as unknown as KeycloakProjector);

  const envelope = (eventName: string, payload: unknown): EventEnvelope =>
    ({
      eventId: 'EVT_1',
      eventName,
      eventVersion: 1,
      occurredAt: '2026-09-24T00:00:00.000Z',
      producer: 'identity-service',
      producerVersion: '0.1.0',
      aggregateType: 'Membership',
      aggregateId: 'MBR_1',
      tenantId: 'ORG-A',
      correlationId: 'COR_1',
      payload,
    }) as EventEnvelope;

  beforeEach(() => project.mockClear());

  it.each(REPROJECTED_EVENTS)('re-projects the user a %s names', async (eventName) => {
    await consumer.handle(envelope(eventName, { userId: 'USR_1', organizationId: 'ORG-A' }));
    expect(project).toHaveBeenCalledWith('USR_1', 'event', { signal: expect.any(AbortSignal) });
  });

  it.each(['USER_UPDATED', 'ACTIVE_ORGANIZATION_SWITCHED'])(
    'ignores %s, which changes no membership',
    async (eventName) => {
      // The switch projects synchronously and reports its own failure; its
      // event is the audit record, not a second, silent retry path.
      await expect(
        consumer.handle(envelope(eventName, { userId: 'USR_1', organizationId: 'ORG-A' })),
      ).resolves.toBe('SKIPPED');
      expect(project).not.toHaveBeenCalled();
    },
  );

  it('dead-letters at once, rather than skips or retries, an event that names no user (L7-26)', async () => {
    await expect(
      consumer.handle(envelope('ROLE_REVOKED', { membershipId: 'MBR_1', userId: 42 })),
    ).rejects.toMatchObject({
      name: 'UnprocessableEventError',
      reason: 'VALIDATION_FAILED',
      message: 'ROLE_REVOKED EVT_1 payload fails its schema: userId invalid_type',
    });
    expect(project).not.toHaveBeenCalled();
  });

  it('projects the user once the corrected event is replayed from the DLQ (L7-26)', async () => {
    await expect(
      consumer.handle(envelope('ROLE_REVOKED', { membershipId: 'MBR_1' })),
    ).rejects.toMatchObject({ reason: 'VALIDATION_FAILED' });
    // No ledger to consult: the projection rebuilds from the database, so a
    // second delivery writes the same truth (idempotent by construction).
    await consumer.handle(envelope('ROLE_REVOKED', { membershipId: 'MBR_1', userId: 'USR_1' }));
    expect(project).toHaveBeenCalledTimes(1);
    expect(project).toHaveBeenCalledWith('USR_1', 'event', { signal: expect.any(AbortSignal) });
  });

  it('lets a failed projection throw, so the consumer retries and then dead-letters it', async () => {
    project.mockRejectedValueOnce(new Error('keycloak unreachable'));
    await expect(consumer.handle(envelope('ROLE_REVOKED', { userId: 'USR_1' }))).rejects.toThrow(
      'keycloak unreachable',
    );
  });

  it('starts nothing when Keycloak sync is off', async () => {
    await expect(consumer.onModuleInit()).resolves.toBeUndefined();
  });

  describe('the bounded stop cancels the projection it abandons (#402 r2 F2)', () => {
    /** A consumer whose stop gives up on the handler in flight, as the real one does at its deadline. */
    function abandoningConsumer() {
      let handler!: EventHandler;
      const factory = (): EventConsumer =>
        ({
          start: jest.fn(async () => undefined),
          stop: jest.fn(async () => undefined),
        }) as unknown as EventConsumer;
      let resume!: () => void;
      const resumed = new Promise<void>((resolve) => (resume = resolve));
      /** The signal the projection got, and the operations of it that passed the boundary once resumed. */
      const seen: {
        signal?: AbortSignal;
        started: string[];
        flushedAfterAbort?: boolean | null;
      } = { started: [] };
      const projector = {
        project: jest.fn(
          async (_userId: string, _trigger: string, options: { signal?: AbortSignal }) => {
            seen.signal = options.signal;
            await resumed;
            // What the projection's next database operation runs first.
            for (const query of ['databaseNow', 'findUserById', 'fences.ofUser']) {
              try {
                throwIfCancelled();
                seen.started.push(query);
              } catch {
                // refused at the boundary: never started
              }
            }
            return 'projected' as const;
          },
        ),
        /** The late senders' owed fences (D-070 D): when the stop flushed them, against its signal. */
        recoverOwed: jest.fn(async () => {
          seen.flushedAfterAbort = seen.signal?.aborted ?? null;
          return 0;
        }),
      };
      const consumer = new KeycloakProjectionConsumer(
        (h) => {
          handler = h;
          return factory();
        },
        projector as unknown as KeycloakProjector,
      );
      return {
        consumer,
        projector,
        seen,
        resume,
        handle: (e: EventEnvelope) => handler(e, {} as never),
      };
    }

    it('a projection that resumes after the stop returned starts no database operation, and its Keycloak call is cancelled', async () => {
      const c = abandoningConsumer();
      await c.consumer.onModuleInit();
      const inFlight = c.handle(envelope('ROLE_REVOKED', { userId: 'USR_1' }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(c.seen.signal?.aborted).toBe(false);

      await c.consumer.stop({ deadlineAt: Date.now() });
      expect(c.seen.signal?.aborted).toBe(true);
      // Its owed late fences were written before the stop returned, once the
      // handler's scope was cancelled — the flush is not in that scope (D-070 D).
      expect(c.projector.recoverOwed).toHaveBeenCalledTimes(1);
      expect(c.seen.flushedAfterAbort).toBe(true);

      c.resume();
      await inFlight;
      expect(c.seen.started).toEqual([]);
    });

    it('control: without a stop, the same projection passes the boundary', async () => {
      const c = abandoningConsumer();
      await c.consumer.onModuleInit();
      const inFlight = c.handle(envelope('ROLE_REVOKED', { userId: 'USR_1' }));
      await new Promise((resolve) => setImmediate(resolve));
      c.resume();
      await inFlight;
      expect(c.seen.signal?.aborted).toBe(false);
      expect(c.seen.started).toEqual(['databaseNow', 'findUserById', 'fences.ofUser']);
    });
  });

  describe('#912: a stop waits for the COMMIT of a handler it abandoned', () => {
    onTheTestsClock();

    it('the Kafka stop abandoned the handler, its projection’s COMMIT still with the engine — the stop returns only after that COMMIT', async () => {
      const { pool, log, steps } = modelledPool();
      const answer = gate();
      steps.push({ commit: answer.opened });
      let handler!: EventHandler;
      // Kafka's stop returns at once, abandoning the handler in flight.
      const c = new KeycloakProjectionConsumer(
        (h) => {
          handler = h;
          return { start: async () => undefined, stop: async () => undefined } as never;
        },
        {
          project: () =>
            pool
              .transaction((tx) => tx.$executeRawUnsafe('SET LOCAL x = 1'))
              .then(() => 'projected'),
          recoverOwed: async () => 0,
        } as unknown as KeycloakProjector,
      );
      await c.onModuleInit();
      const handling = handler(envelope('ROLE_REVOKED', { userId: 'USR_1' }), {} as never);
      await until(() => log.includes('SET'));
      const startedAt = Date.now();
      setTimeout(answer.open, 100);

      const stopped = await returnedBy(
        c
          .stop({ deadlineAt: startedAt + COMMIT_RESERVE_MS + 100 })
          .then(() => void log.push('STOP RETURNED')),
        COMMIT_RESERVE_MS + 100,
      );

      // Not "BEGIN, SET, STOP RETURNED, COMMIT": the stop waited for it.
      expect(stopped).toMatchObject({ status: 'fulfilled', settledAt: startedAt + 100 });
      expect(log).toEqual(['BEGIN 1', 'SET', 'COMMIT 1', 'STOP RETURNED']);
      await handling;
    });
  });
});
