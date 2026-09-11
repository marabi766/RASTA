import type { EventPublisher, OutboxClaim, OutboxRow, OutboxStore } from '@rasta/nest-common';
import {
  securityEventAckFencedTotal,
  securityEventLeaseReclaimedTotal,
  securityEventPublishFailuresTotal,
  securityEventsPublishedTotal,
} from '../observability/security-event.metrics';
import {
  AuditTrailContractError,
  toSecurityEventOutboxRow,
  type SecurityEventDeliveryState,
  type SecurityEventRecord,
} from './audit-trail-envelope';
import { AuditTrailPublisher } from './audit-trail.publisher';
import { createSecurityEventRelay } from './security-event.relay';

/**
 * The refusal flusher's wiring: contract validation in front of the broker,
 * its own counters, and the shared relay's retry, fencing and shutdown
 * behaviour applied to this queue. The relay protocol itself is proven in
 * `@rasta/nest-common`'s `outbox.spec.ts`; this proves identity plugged into it
 * correctly.
 */

const SENTINEL = 'RELAY-SENTINEL-77aa';

function row(
  id: string,
  overrides: Partial<SecurityEventRecord & SecurityEventDeliveryState> = {},
) {
  return toSecurityEventOutboxRow({
    id,
    organizationId: 'ORG_A',
    actorType: 'USER',
    actorId: 'USR_A',
    actorRoles: ['FLEET_MANAGER'],
    action: 'identity.active_organization.switch',
    resourceType: 'User',
    resourceId: 'USR_A',
    errorCode: 'TENANT_MISMATCH',
    reason: null,
    sourceIp: null,
    sourceUserAgent: null,
    correlationId: 'COR_1',
    traceparent: null,
    producerVersion: '1.0.0',
    occurredAt: new Date('2026-09-11T10:00:00.000Z'),
    createdAt: new Date('2026-09-11T10:00:00.000Z'),
    publishedAt: null,
    attempts: 0,
    lastError: null,
    ...overrides,
  });
}

/** A row whose envelope no longer satisfies the contract. */
function invalidRow(id: string): OutboxRow {
  const valid = row(id);
  const envelope = JSON.parse(JSON.stringify(valid.payload)) as {
    payload: Record<string, unknown>;
  };
  envelope.payload.occurrenceCount = 2;
  envelope.payload.reason = SENTINEL;
  return { ...valid, payload: envelope };
}

function fakeStore(claim: OutboxClaim, overrides: Partial<OutboxStore> = {}) {
  return {
    claimPending: jest.fn(async () => claim),
    markPublished: jest.fn(async (ids: readonly string[]) => ids.length),
    markFailed: jest.fn(async () => 1),
    release: jest.fn(async (ids: readonly string[]) => ids.length),
    renew: jest.fn(async (ids: readonly string[]) => [...ids]),
    oldestPendingAgeSeconds: jest.fn(async () => 0),
    ...overrides,
  };
}

function silentLogger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

const relayOptions = {
  pollIntervalMs: 60_000,
  batchSize: 10,
  leaseSeconds: 60,
  backoff: { baseSeconds: 5, maxSeconds: 3600 },
  shutdownGraceSeconds: 0,
};

const valueOf = async (metric: {
  get(): Promise<{ values: { value: number; labels: object }[] }>;
}) => (await metric.get()).values.reduce((sum, v) => sum + v.value, 0);

describe('AuditTrailPublisher', () => {
  it('passes a valid batch to the broker unchanged', async () => {
    const delegate = { publish: jest.fn(async () => undefined) };
    const rows = [row('01J9ZC000000000000000000A1'), row('01J9ZC000000000000000000A2')];

    await new AuditTrailPublisher(delegate).publish(rows);

    expect(delegate.publish).toHaveBeenCalledWith(rows);
  });

  it('sends nothing from a batch that holds one invalid row, and says so without the value', async () => {
    const delegate = { publish: jest.fn(async () => undefined) };
    const failure = await new AuditTrailPublisher(delegate)
      .publish([row('01J9ZC000000000000000000A1'), invalidRow('01J9ZC000000000000000000A2')])
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(AuditTrailContractError);
    expect((failure as Error).message).not.toContain(SENTINEL);
    expect(delegate.publish).not.toHaveBeenCalled();
  });

  it('does nothing for an empty batch', async () => {
    const delegate = { publish: jest.fn(async () => undefined) };
    await new AuditTrailPublisher(delegate).publish([]);
    expect(delegate.publish).not.toHaveBeenCalled();
  });
});

describe('createSecurityEventRelay', () => {
  beforeEach(() => {
    securityEventsPublishedTotal.reset();
    securityEventPublishFailuresTotal.reset();
    securityEventAckFencedTotal.reset();
    securityEventLeaseReclaimedTotal.reset();
  });

  it('publishes and acknowledges a claimed batch, fenced on its token', async () => {
    const rows = [row('01J9ZC000000000000000000B1')];
    const store = fakeStore({ token: 'tok-1', rows, reclaimed: 1 });
    const publisher: EventPublisher = { publish: jest.fn(async () => undefined) };

    const relay = createSecurityEventRelay({
      store,
      publisher,
      logger: silentLogger(),
      ...relayOptions,
    });
    await expect(relay.tick()).resolves.toBe(1);

    expect(publisher.publish).toHaveBeenCalledWith(rows);
    expect(store.markPublished).toHaveBeenCalledWith(['01J9ZC000000000000000000B1'], 'tok-1');
    expect(await valueOf(securityEventsPublishedTotal)).toBe(1);
    expect(await valueOf(securityEventLeaseReclaimedTotal)).toBe(1);
  });

  it('leaves a row retryable when the broker refuses it', async () => {
    const rows = [row('01J9ZC000000000000000000C1')];
    const store = fakeStore({ token: 'tok-2', rows, reclaimed: 0 });
    const publisher: EventPublisher = {
      publish: jest.fn(async () => {
        throw new Error('broker unavailable');
      }),
    };

    const relay = createSecurityEventRelay({
      store,
      publisher,
      logger: silentLogger(),
      ...relayOptions,
    });
    await expect(relay.tick()).resolves.toBe(0);

    expect(store.markPublished).not.toHaveBeenCalled();
    expect(store.markFailed).toHaveBeenCalledWith(
      '01J9ZC000000000000000000C1',
      'tok-2',
      expect.stringContaining('broker unavailable'),
      relayOptions.backoff,
    );
    const failures = await securityEventPublishFailuresTotal.get();
    expect(failures.values).toEqual([
      expect.objectContaining({ labels: { reason: 'publish_error' }, value: 1 }),
    ]);
  });

  it('publishes the valid rows of a mixed batch and schedules only the invalid one for retry', async () => {
    const good = row('01J9ZC000000000000000000D1');
    const bad = invalidRow('01J9ZC000000000000000000D2');
    const store = fakeStore({ token: 'tok-3', rows: [good, bad], reclaimed: 0 });
    const sent: OutboxRow[] = [];
    const publisher: EventPublisher = {
      publish: jest.fn(async (batch: readonly OutboxRow[]) => {
        sent.push(...batch);
      }),
    };

    const relay = createSecurityEventRelay({
      store,
      publisher,
      logger: silentLogger(),
      ...relayOptions,
    });
    await expect(relay.tick()).resolves.toBe(1);

    expect(sent.map((r) => r.id)).toEqual([good.id]);
    expect(store.markPublished).toHaveBeenCalledWith([good.id], 'tok-3');
    expect(store.markFailed).toHaveBeenCalledTimes(1);
    const [failedId, , lastError] = store.markFailed.mock.calls[0] as unknown as [
      string,
      string,
      string,
    ];
    expect(failedId).toBe(bad.id);
    expect(lastError).toContain('AuditTrailContractError');
    expect(lastError).not.toContain(SENTINEL);
    const failures = await securityEventPublishFailuresTotal.get();
    expect(failures.values).toEqual([
      expect.objectContaining({ labels: { reason: 'contract_violation' }, value: 1 }),
    ]);
  });

  it('counts an acknowledgement the database fenced because another worker took the row', async () => {
    const rows = [row('01J9ZC000000000000000000E1')];
    const store = fakeStore(
      { token: 'stale-token', rows, reclaimed: 0 },
      { markPublished: jest.fn(async () => 0) },
    );
    const publisher: EventPublisher = { publish: jest.fn(async () => undefined) };

    const relay = createSecurityEventRelay({
      store,
      publisher,
      logger: silentLogger(),
      ...relayOptions,
    });
    await expect(relay.tick()).resolves.toBe(0);

    expect(await valueOf(securityEventAckFencedTotal)).toBe(1);
    expect(await valueOf(securityEventsPublishedTotal)).toBe(0);
  });

  it('on shutdown abandons an in-flight publish rather than releasing it for a second worker', async () => {
    const rows = [row('01J9ZC000000000000000000F1')];
    const store = fakeStore({ token: 'tok-4', rows, reclaimed: 0 });
    let publishStarted = false;
    const publisher: EventPublisher = {
      publish: jest.fn(() => {
        publishStarted = true;
        return new Promise<void>(() => undefined);
      }),
    };
    const logger = silentLogger();

    const relay = createSecurityEventRelay({ store, publisher, logger, ...relayOptions });
    void relay.tick();
    while (!publishStarted) await new Promise((resolve) => setImmediate(resolve));

    await relay.stop();

    expect(store.release).not.toHaveBeenCalled();
    expect(store.markPublished).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1 }),
      expect.stringContaining('abandoned'),
    );
  });

  it('starts and stops its polling without claiming anything when stopped first', async () => {
    const store = fakeStore({ token: null, rows: [], reclaimed: 0 });
    const relay = createSecurityEventRelay({
      store,
      publisher: { publish: jest.fn() },
      logger: silentLogger(),
      ...relayOptions,
    });

    relay.start();
    await relay.stop();

    expect(store.claimPending).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
  });
});
