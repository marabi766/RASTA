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
  create: jest.Mock;
  findTarget: jest.Mock;
}

function harness(
  options: {
    target?: AuditTarget | null;
    existing?: AuditCorrectionCommandRecord | null;
    enqueue?: () => Promise<string>;
    create?: () => Promise<void>;
    afterConflict?: AuditCorrectionCommandRecord | null;
  } = {},
): Harness {
  const enqueueEvent = jest.fn(options.enqueue ?? (async () => EVENT_ID));
  const tx = { tag: 'tx' };
  const transaction = jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx));
  let finds = 0;
  const find = jest.fn(async () => {
    finds += 1;
    return finds === 1 ? (options.existing ?? null) : (options.afterConflict ?? null);
  });
  const create = jest.fn(options.create ?? (async () => undefined));
  const findTarget = jest.fn(async () =>
    options.target === undefined
      ? { id: TARGET_ID, organizationId: 'ORG-DEH-0001', occurredAt: new Date(COMMAND.occurredAt) }
      : options.target,
  );

  const service = new AuditCorrectionService(
    { enqueueEvent, transaction } as unknown as IdentityRepository,
    { find, create } as unknown as AuditCorrectionCommandRepository,
    { findTarget } as unknown as AuditLookupClient,
  );
  return { service, enqueueEvent, transaction, find, create, findTarget };
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
    expect(tx).toEqual({ tag: 'tx' });
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
      for (const effect of [h.find, h.findTarget, h.transaction, h.enqueueEvent, h.create]) {
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
    expect(h.find).toHaveBeenCalledTimes(2);
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
