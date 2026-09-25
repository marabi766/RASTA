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

  it('ignores the events that change no membership', async () => {
    await expect(consumer.handle(envelope('USER_UPDATED', { userId: 'USR_1' }))).resolves.toBe(
      'SKIPPED',
    );
    expect(project).not.toHaveBeenCalled();
  });

  it('skips, rather than retries, an event that names no user', async () => {
    await expect(
      consumer.handle(envelope('ROLE_REVOKED', { membershipId: 'MBR_1' })),
    ).resolves.toBe('SKIPPED');
    expect(project).not.toHaveBeenCalled();
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
