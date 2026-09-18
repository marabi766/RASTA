import { AUDIT_EVENT_RECORDED, AUDIT_TRAIL_TOPIC } from '@rasta/contracts';
import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import type { IdentityRepository } from '../identity/identity.repository';
import type { AuditLookupClient, AuditTarget } from './audit-lookup.client';
import type {
  AuditCorrectionCommandRecord,
  AuditCorrectionCommandRepository,
} from './audit-correction.repository';
import { AuditCorrectionService, type AuditCorrectionAccepted } from './audit-correction.service';
import { hashCorrectionCommand, type AuditCorrectionCommand } from './dto';

/**
 * The correction command's decisions, in the order they are made (AUD-003 correction):
 * authority, key, replay, target, payload, one atomic write.
 */

const TARGET_ID = '01JAUDIT0000000000000001';
const KEY = 'corr-key-0001';
const EVENT_ID = '01JEVENT00000000000000C11';

const COMMAND: AuditCorrectionCommand = {
  auditEventId: TARGET_ID,
  occurredAt: '2026-09-12T10:00:00.000Z',
  reason: 'Recorded as SUCCESS; the operation actually failed',
  changes: [
    { field: 'outcome', from: 'SUCCESS', to: 'FAILURE' },
    { field: 'credentials.password', from: 'hunter2', to: 'hunter3' },
  ],
};

const admin = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  correlationId: 'COR-C11-SVC',
  requestId: 'REQ-C11-SVC',
  // The administrator's own active tenant. It must never reach the event.
  organizationId: 'ORG-ADMIN-OWN',
  organizationIds: ['ORG-ADMIN-OWN'],
  userId: 'USR-PLATFORM-ADMIN',
  roles: ['SYSTEM_ADMIN'],
  authType: 'USER',
  ip: '203.0.113.9',
  userAgent: 'correction-spec',
  startedAt: 0,
  ...overrides,
});

interface Harness {
  service: AuditCorrectionService;
  enqueueEvent: jest.Mock;
  transaction: jest.Mock;
  find: jest.Mock;
  lockCommandKey: jest.Mock;
  create: jest.Mock;
  findTarget: jest.Mock;
  /** Every collaborator call, in order, marking reads made inside the transaction. */
  calls: string[];
}

const TX = { tag: 'tx' };

function harness(
  options: {
    target?: AuditTarget | null;
    /** The fast check before audit-service is asked anything. */
    existing?: AuditCorrectionCommandRecord | null;
    /** The re-read under the command lock, inside the transaction. */
    underLock?: AuditCorrectionCommandRecord | null;
    lock?: () => Promise<void>;
    reread?: () => Promise<AuditCorrectionCommandRecord | null>;
    enqueue?: () => Promise<string>;
    create?: () => Promise<void>;
    /** The read after a unique violation, outside the rolled-back transaction. */
    afterConflict?: AuditCorrectionCommandRecord | null;
  } = {},
): Harness {
  const calls: string[] = [];
  const enqueueEvent = jest.fn(async () => {
    calls.push('enqueueEvent');
    return (options.enqueue ?? (async () => EVENT_ID))();
  });
  const transaction = jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    calls.push('transaction');
    return fn(TX);
  });
  let outside = 0;
  const find = jest.fn(async (_actorId: string, _key: string, tx?: unknown) => {
    if (tx !== undefined) {
      calls.push('find:tx');
      return options.reread ? options.reread() : (options.underLock ?? null);
    }
    outside += 1;
    calls.push('find');
    return outside === 1 ? (options.existing ?? null) : (options.afterConflict ?? null);
  });
  const lockCommandKey = jest.fn(async () => {
    calls.push('lockCommandKey');
    return (options.lock ?? (async () => undefined))();
  });
  const create = jest.fn(async () => {
    calls.push('create');
    return (options.create ?? (async () => undefined))();
  });
  const findTarget = jest.fn(async () => {
    calls.push('findTarget');
    return options.target === undefined
      ? { id: TARGET_ID, organizationId: 'ORG-DEH-0001', occurredAt: new Date(COMMAND.occurredAt) }
      : options.target;
  });

  const service = new AuditCorrectionService(
    { enqueueEvent, transaction } as unknown as IdentityRepository,
    { find, lockCommandKey, create } as unknown as AuditCorrectionCommandRepository,
    { findTarget } as unknown as AuditLookupClient,
  );
  return { service, enqueueEvent, transaction, find, lockCommandKey, create, findTarget, calls };
}

/**
 * Submits as `context` with `KEY`, or with an explicit key — including an
 * explicit `undefined`, which a default parameter would silently replace.
 */
const submit = (h: Harness, context: RequestContext = admin(), ...key: [unknown?]) =>
  runWithContext(context, () => h.service.submit(COMMAND, key.length > 0 ? key[0] : KEY));

async function refusal(promise: Promise<unknown>): Promise<RastaError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RastaError);
    return error as RastaError;
  }
  throw new Error('expected a refusal');
}

const record = (
  overrides: Partial<AuditCorrectionCommandRecord> = {},
): AuditCorrectionCommandRecord => ({
  actorId: 'USR-PLATFORM-ADMIN',
  idempotencyKey: KEY,
  requestHash: hashCorrectionCommand(COMMAND),
  targetId: TARGET_ID,
  eventId: EVENT_ID,
  responseBody: {
    status: 'ACCEPTED',
    eventId: EVENT_ID,
    correctionOf: TARGET_ID,
    acceptedAt: '2026-09-12T11:00:00.000Z',
  },
  ...overrides,
});

describe('AuditCorrectionService', () => {
  it('enqueues exactly one correction on the trail topic, keyed and tenanted by the trusted target', async () => {
    const h = harness();

    const accepted = await submit(h);

    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.enqueueEvent).toHaveBeenCalledTimes(1);
    const [tx, message] = h.enqueueEvent.mock.calls[0]!;
    expect(tx).toBe(TX);
    expect(message).toEqual({
      aggregateType: 'AuditEvent',
      aggregateId: TARGET_ID,
      eventName: AUDIT_EVENT_RECORDED,
      eventVersion: 1,
      topic: AUDIT_TRAIL_TOPIC,
      organizationId: 'ORG-DEH-0001',
      payload: {
        actor: { type: 'USER', id: 'USR-PLATFORM-ADMIN', roles: ['SYSTEM_ADMIN'] },
        organizationId: 'ORG-DEH-0001',
        action: 'audit.correction',
        resourceType: 'AuditEvent',
        resourceId: TARGET_ID,
        outcome: 'SUCCESS',
        reason: COMMAND.reason,
        changes: [
          { field: 'outcome', from: 'SUCCESS', to: 'FAILURE' },
          { field: 'credentials.password', from: { redacted: true }, to: { redacted: true } },
        ],
        occurrenceCount: 1,
        source: { ip: '203.0.113.9', userAgent: 'correction-spec' },
        correctionOf: TARGET_ID,
      },
    });

    expect(accepted).toEqual({
      status: 'ACCEPTED',
      eventId: EVENT_ID,
      correctionOf: TARGET_ID,
      acceptedAt: expect.any(String),
    });
    expect(h.create).toHaveBeenCalledWith(
      { tag: 'tx' },
      {
        actorId: 'USR-PLATFORM-ADMIN',
        idempotencyKey: KEY,
        requestHash: hashCorrectionCommand(COMMAND),
        targetId: TARGET_ID,
        eventId: EVENT_ID,
        responseBody: accepted,
      },
    );
  });

  it('never lets the administrator’s own tenant, or anything request-supplied, into the event', async () => {
    const h = harness();

    await submit(h);

    const serialised = JSON.stringify(h.enqueueEvent.mock.calls[0]![1]);
    expect(serialised).not.toContain('ORG-ADMIN-OWN');
    expect(serialised).not.toMatch(/hunter/);
  });

  it('writes a platform-scoped correction with an explicit null tenant and no payload organization', async () => {
    const h = harness({
      target: { id: TARGET_ID, organizationId: null, occurredAt: new Date(COMMAND.occurredAt) },
    });

    await submit(h);

    const message = h.enqueueEvent.mock.calls[0]![1] as {
      organizationId: unknown;
      payload: object;
    };
    expect(message.organizationId).toBeNull();
    expect(message.payload).not.toHaveProperty('organizationId');
  });

  it('looks the target up exactly as the command named it', async () => {
    const h = harness();

    await submit(h);

    expect(h.findTarget).toHaveBeenCalledWith(TARGET_ID, new Date(COMMAND.occurredAt));
  });

  describe('authority comes from the verified token only', () => {
    it.each<[string, Partial<RequestContext>]>([
      ['a UNION_ADMIN', { roles: ['UNION_ADMIN'] }],
      ['an ORGANIZATION_ADMIN', { roles: ['ORGANIZATION_ADMIN'] }],
      ['an AUDITOR', { roles: ['AUDITOR'] }],
      ['an ordinary user', { roles: ['FLEET_MANAGER'] }],
      ['a user with no roles', { roles: [] }],
      [
        'a service token',
        {
          authType: 'SERVICE',
          userId: undefined,
          roles: ['SERVICE'],
          callerService: 'fleet-service',
        },
      ],
      [
        'a service token claiming SYSTEM_ADMIN',
        { authType: 'SERVICE', userId: undefined, roles: ['SYSTEM_ADMIN'] },
      ],
      ['an anonymous caller', { authType: 'ANONYMOUS', userId: undefined, roles: [] }],
      ['a SYSTEM_ADMIN token with no user id', { userId: '   ' }],
    ])('refuses %s, and touches nothing', async (_label, overrides) => {
      const h = harness();

      const error = await refusal(submit(h, admin(overrides)));

      expect(error.code).toBe('FORBIDDEN');
      for (const effect of [
        h.find,
        h.findTarget,
        h.transaction,
        h.lockCommandKey,
        h.enqueueEvent,
        h.create,
      ]) {
        expect(effect).not.toHaveBeenCalled();
      }
    });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['containing a space', 'a key'],
    ['over 255 characters', 'k'.repeat(256)],
    ['not a string', 42],
  ])('refuses an Idempotency-Key that is %s before doing anything', async (_label, key) => {
    const h = harness();

    const error = await refusal(submit(h, admin(), key));

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(h.findTarget).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('replays the stored response for the same key and request, without asking audit-service again', async () => {
    const existing = record();
    const h = harness({ existing });

    await expect(submit(h)).resolves.toEqual(existing.responseBody);
    expect(h.findTarget).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('refuses the same key with a different request as IDEMPOTENCY_KEY_REUSED', async () => {
    const h = harness({ existing: record({ requestHash: 'f'.repeat(64) }) });

    const error = await refusal(submit(h));

    expect(error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(error.status).toBe(409);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('answers a missing or mismatched target with a 404 and writes nothing', async () => {
    const h = harness({ target: null });

    const error = await refusal(submit(h));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.status).toBe(404);
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('propagates a bounded upstream failure and writes nothing', async () => {
    const h = harness();
    h.findTarget.mockRejectedValueOnce(RastaError.upstreamUnavailable('audit-service'));

    const error = await refusal(submit(h));

    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('answers a concurrent duplicate that lost the race with the winner’s response', async () => {
    const winner = record();
    const h = harness({
      create: async () => {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      },
      afterConflict: winner,
    });

    await expect(submit(h)).resolves.toEqual(winner.responseBody);
    // Before the lookup, under the lock, and once more after the rollback —
    // outside the transaction that failed.
    expect(h.find.mock.calls.map((call) => call.length > 2 && call[2] !== undefined)).toEqual([
      false,
      true,
      false,
    ]);
    expect(h.calls).toEqual([
      'find',
      'findTarget',
      'transaction',
      'lockCommandKey',
      'find:tx',
      'enqueueEvent',
      'create',
      'find',
    ]);
  });

  it('refuses a concurrent duplicate carrying a different request', async () => {
    const h = harness({
      create: async () => {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      },
      afterConflict: record({ requestHash: '0'.repeat(64) }),
    });

    expect((await refusal(submit(h))).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  describe('the command lock decides before anything is allocated', () => {
    it('locks the (actor, key) command and re-reads it inside the transaction before the outbox write', async () => {
      const h = harness();

      await submit(h);

      expect(h.calls).toEqual([
        'find',
        'findTarget',
        'transaction',
        'lockCommandKey',
        'find:tx',
        'enqueueEvent',
        'create',
      ]);
      expect(h.lockCommandKey).toHaveBeenCalledWith(TX, 'USR-PLATFORM-ADMIN', KEY);
      expect(h.find).toHaveBeenLastCalledWith('USR-PLATFORM-ADMIN', KEY, TX);
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.create.mock.calls[0]![0]).toBe(TX);
    });

    it('never holds the transaction open across the audit-service lookup', async () => {
      const h = harness();

      await submit(h);

      expect(h.calls.indexOf('findTarget')).toBeLessThan(h.calls.indexOf('transaction'));
      expect(h.calls.indexOf('transaction')).toBeLessThan(h.calls.indexOf('lockCommandKey'));
    });

    it('replays a winner found under the lock byte-for-byte, allocating and inserting nothing', async () => {
      const winner = record({
        // JSONB hands the stored body back in its own key order.
        responseBody: JSON.parse(
          '{"eventId":"01JEVENT00000000000000C11","acceptedAt":"2026-09-12T11:00:00.000Z",' +
            '"correctionOf":"01JAUDIT0000000000000001","status":"ACCEPTED"}',
        ) as AuditCorrectionAccepted,
      });
      const h = harness({ underLock: winner });

      const replayed = await submit(h);

      expect(JSON.stringify(replayed)).toBe(
        '{"status":"ACCEPTED","eventId":"01JEVENT00000000000000C11",' +
          '"correctionOf":"01JAUDIT0000000000000001","acceptedAt":"2026-09-12T11:00:00.000Z"}',
      );
      expect(h.calls).toEqual(['find', 'findTarget', 'transaction', 'lockCommandKey', 'find:tx']);
      expect(h.enqueueEvent).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
    });

    it('refuses a different request found under the lock with 409, writing nothing', async () => {
      const h = harness({ underLock: record({ requestHash: 'e'.repeat(64) }) });

      const error = await refusal(submit(h));

      expect(error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(error.status).toBe(409);
      expect(h.enqueueEvent).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
      // Refused as it was found: no second look outside the transaction.
      expect(h.find).toHaveBeenCalledTimes(2);
    });

    it.each<[string, Parameters<typeof harness>[0]]>([
      [
        'the lock',
        {
          lock: async () => {
            throw Object.assign(new Error('canceling statement due to lock timeout on 42'), {
              code: 'P2010',
              meta: { code: '55P03' },
            });
          },
        },
      ],
      [
        'the re-read',
        {
          reread: async () => {
            throw Object.assign(new Error('Transaction API error: Unable to start a transaction'), {
              code: 'P2028',
            });
          },
        },
      ],
    ])(
      'turns a failure of %s into the bounded INTERNAL_ERROR, writing nothing',
      async (_label, options) => {
        const h = harness(options);

        const error = await refusal(submit(h));

        expect(error.code).toBe('INTERNAL_ERROR');
        expect(error.message).toBe(
          'The correction could not be recorded; nothing was changed and it is safe to retry',
        );
        expect(JSON.stringify(error)).not.toMatch(/P20|55P03|lock timeout|Transaction API/);
        expect(h.enqueueEvent).not.toHaveBeenCalled();
        expect(h.create).not.toHaveBeenCalled();
      },
    );
  });

  it('turns an outbox failure into an explicit error, recording no command', async () => {
    const h = harness({
      enqueue: async () => {
        throw new Error('insert into outbox_message failed: connection reset');
      },
    });

    const error = await refusal(submit(h));

    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toBe(
      'The correction could not be recorded; nothing was changed and it is safe to retry',
    );
    expect(error.message).not.toContain('outbox_message');
    expect(h.create).not.toHaveBeenCalled();
  });

  it('keeps the accepted response free of the target tenant', async () => {
    const h = harness();

    const accepted: AuditCorrectionAccepted = await submit(h);

    expect(Object.keys(accepted).sort()).toEqual([
      'acceptedAt',
      'correctionOf',
      'eventId',
      'status',
    ]);
    expect(JSON.stringify(accepted)).not.toContain('ORG-DEH-0001');
  });
});
