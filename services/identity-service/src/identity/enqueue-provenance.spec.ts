import {
  captureOutboxProvenance,
  runWithContext,
  type OutboxMessageInput,
  type RequestContext,
} from '@rasta/nest-common';
import { IdentityRepository } from './identity.repository';
import { IDENTITY_EVENTS } from './events';
import { IDENTITY_TOPIC } from '../config/env';

/**
 * PR #483 r3 F2, through this service's ordinary enqueue: an event is
 * attributed to the verified request context, and nothing a producer puts in
 * the input — a provenance, an actor, a correlation id, a tenant — replaces it
 * or strips it. (`buildOutboxRow` refuses `provenance`; the other keys are
 * never read.)
 */
describe('IdentityRepository.enqueueEvent: provenance is the verified context’s, never the input’s (PR #483 r3 F2)', () => {
  const ORG_A = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA';
  const ORG_B = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YB';
  const verified: RequestContext = {
    correlationId: 'COR_VERIFIED',
    requestId: 'REQ_1',
    organizationId: ORG_A,
    organizationIds: [ORG_A],
    userId: 'USR_VERIFIED',
    roles: ['ORGANIZATION_ADMIN'],
    authType: 'USER',
    startedAt: 0,
  };
  const chosen = { actor: { type: 'USER', id: 'USR_SOMEONE_ELSE' }, correlationId: 'COR_CHOSEN' };

  const inserted: Array<{
    payload: Record<string, unknown>;
    organizationId: string | null;
    correlationId: string;
  }> = [];
  // The transaction the enqueue writes through: the stream counter, and the outbox insert.
  const tx = {
    $queryRawUnsafe: async () => [{ allocated: 1n }],
    outboxMessage: {
      create: async ({ data }: { data: (typeof inserted)[number] }) => {
        inserted.push(data);
        return data;
      },
    },
  };
  const repository = new IdentityRepository({} as never);
  const input: OutboxMessageInput = {
    aggregateType: 'User',
    aggregateId: 'AGG_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
    eventName: IDENTITY_EVENTS.USER_ACTIVATED,
    topic: IDENTITY_TOPIC,
    payload: { userId: 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9Y2' },
  };
  const enqueue = (extra: Record<string, unknown>) =>
    runWithContext(verified, () =>
      repository.enqueueEvent(tx as never, { ...input, ...extra } as OutboxMessageInput),
    );

  beforeEach(() => {
    inserted.length = 0;
  });

  it('refuses a supplied provenance — a literal, a null actor, even an issued one — and inserts nothing', async () => {
    const issued = runWithContext({ ...verified, userId: 'USR_SOMEONE_ELSE' }, () =>
      captureOutboxProvenance(),
    );
    for (const provenance of [chosen, { actor: null, correlationId: 'COR_VERIFIED' }, issued]) {
      await expect(enqueue({ provenance })).rejects.toThrow(
        'takes its provenance from the request context',
      );
    }
    expect(inserted).toHaveLength(0);
  });

  it.each([
    ['another actor', { type: 'USER', id: 'USR_SOMEONE_ELSE' }],
    ['a null actor', null],
  ])(
    'ignores %s, an origin, a correlation and a tenant key: the row is the verified context’s, tenant kept',
    async (_label, actor) => {
      await enqueue({ actor, anonymous: true, correlationId: 'COR_CHOSEN', tenantId: ORG_B });

      expect(inserted).toHaveLength(1);
      const [row] = inserted;
      expect(row!.payload.actor).toEqual({ type: 'USER', id: 'USR_VERIFIED' });
      expect(row!.payload).not.toHaveProperty('anonymous');
      expect(row!.payload.correlationId).toBe('COR_VERIFIED');
      expect(row!.correlationId).toBe('COR_VERIFIED');
      // organizationId omitted: the verified context's tenant, never stripped.
      expect(row!.payload.tenantId).toBe(ORG_A);
      expect(row!.organizationId).toBe(ORG_A);
    },
  );

  it('the input type has no provenance (type-level)', () => {
    const literal: Parameters<IdentityRepository['enqueueEvent']>[1] = {
      ...input,
      // @ts-expect-error — an ordinary enqueue carries no provenance (PR #483 r3 F2).
      provenance: chosen,
    };
    expect(literal).toBeDefined();
  });
});

describe('IdentityRepository.enqueueRestoredEvent: only an issued provenance, the tenant stated (PR #483 r3 F2)', () => {
  const inserted: Array<{ payload: Record<string, unknown> }> = [];
  const tx = {
    $queryRawUnsafe: async () => [{ allocated: 1n }],
    outboxMessage: {
      create: async ({ data }: { data: (typeof inserted)[number] }) => {
        inserted.push(data);
        return data;
      },
    },
  };
  const repository = new IdentityRepository({} as never);
  const input = {
    aggregateType: 'RegistrationRequest',
    aggregateId: 'REG_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
    eventName: IDENTITY_EVENTS.REGISTRATION_SUBMITTED,
    topic: IDENTITY_TOPIC,
    organizationId: 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA',
    payload: { registrationId: 'REG_01JBQ8Z4K7M2N5P8R1T3V6X9Y2' },
  };
  const literal = { actor: { type: 'USER', id: 'USR_SOMEONE_ELSE' }, correlationId: 'COR_CHOSEN' };

  beforeEach(() => {
    inserted.length = 0;
  });

  it('refuses a literal provenance at runtime, and inserts nothing', async () => {
    await expect(
      repository.enqueueRestoredEvent(tx as never, input, literal as never),
    ).rejects.toThrow('not one the platform captured');
    expect(inserted).toHaveLength(0);
  });

  it('refuses a literal provenance at compile time (type-level)', async () => {
    await expect(
      // @ts-expect-error — an OutboxProvenance is issued, never written (PR #483 r3 F2).
      repository.enqueueRestoredEvent(tx as never, input, literal),
    ).rejects.toThrow('not one the platform captured');
  });

  it('cannot drop the tenant', async () => {
    const issued = captureOutboxProvenance();
    const { organizationId: _dropped, ...withoutTenant } = input;
    await expect(
      // @ts-expect-error — a restored event states its tenant.
      repository.enqueueRestoredEvent(tx as never, withoutTenant, issued),
    ).rejects.toThrow('states its tenant');
    expect(inserted).toHaveLength(0);
  });
});
