import type { EventEnvelope } from '@rasta/contracts';
import { KeycloakProjectionConsumer, REPROJECTED_EVENTS } from './keycloak-projection.consumer';
import type { KeycloakProjector } from './keycloak.projector';

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
    expect(project).toHaveBeenCalledWith('USR_1', 'event');
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
    expect(project).toHaveBeenCalledWith('USR_1', 'event');
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
});
