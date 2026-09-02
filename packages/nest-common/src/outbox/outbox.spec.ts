import {
  buildOutboxRow,
  OutboxRelay,
  type ClaimRequest,
  type OutboxClaim,
  type OutboxRow,
  type OutboxStore,
} from './outbox';
import { runWithContext, type RequestContext } from '../context/request-context';

const ORG_A = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA';

const context: RequestContext = {
  correlationId: 'CORR_1',
  requestId: 'REQ_1',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
  organizationId: ORG_A,
  userId: 'USR_1',
  roles: ['PROCUREMENT_USER'],
  authType: 'USER',
  startedAt: 0,
};

describe('buildOutboxRow', () => {
  const input = {
    aggregateType: 'Order',
    aggregateId: 'ORD_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
    eventName: 'ORDER_CREATED',
    topic: 'rasta.marketplace.v1',
    payload: { orderId: 'ORD_01JBQ8Z4K7M2N5P8R1T3V6X9Y2', totalMinor: '10000000' },
  };

  it('builds a complete envelope from the request context', () => {
    const row = runWithContext(context, () =>
      buildOutboxRow(input, { producer: 'marketplace-service', producerVersion: '0.3.1' }),
    );

    const envelope = row.payload as Record<string, unknown>;
    expect(envelope.eventName).toBe('ORDER_CREATED');
    expect(envelope.eventVersion).toBe(1);
    expect(envelope.producer).toBe('marketplace-service');
    expect(envelope.tenantId).toBe(ORG_A);
    expect(envelope.correlationId).toBe('CORR_1');
    expect(envelope.actor).toEqual({ type: 'USER', id: 'USR_1' });
    expect(envelope.traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  });

  it('defaults the partition key to the aggregate id', () => {
    // This is what gives ordering per aggregate — the property the wallet and
    // tender flows depend on.
    const row = runWithContext(context, () =>
      buildOutboxRow(input, { producer: 'marketplace-service' }),
    );
    expect(row.partitionKey).toBe(input.aggregateId);
  });

  it('uses the event id as the message id, so consumers can dedupe on it', () => {
    const row = runWithContext(context, () =>
      buildOutboxRow(input, { producer: 'marketplace-service' }),
    );
    expect(row.id).toBe((row.payload as { eventId: string }).eventId);
  });

  it('produces headers that mirror the envelope', () => {
    const row = runWithContext(context, () =>
      buildOutboxRow(input, { producer: 'marketplace-service' }),
    );
    expect(row.headers['x-event-name']).toBe('ORDER_CREATED');
    expect(row.headers['x-tenant-id']).toBe(ORG_A);
    expect(row.headers['x-correlation-id']).toBe('CORR_1');
  });

  it('works outside a request context, for background producers', () => {
    const row = buildOutboxRow(input, { producer: 'maintenance-service' });
    expect(row.correlationId).toBeTruthy();
    expect(row.organizationId).toBeNull();
  });
});

// ---------------------------------------------------------------------------

function makeRow(id: string): OutboxRow {
  return {
    id,
    aggregateType: 'Order',
    aggregateId: `ORD_${id}`,
    eventName: 'ORDER_CREATED',
    eventVersion: 1,
    topic: 'rasta.marketplace.v1',
    partitionKey: `ORD_${id}`,
    payload: {},
    headers: {},
    organizationId: ORG_A,
    correlationId: 'CORR_1',
    createdAt: new Date(0),
    publishedAt: null,
    attempts: 0,
    lastError: null,
  };
}

/**
 * An in-memory store that honours the fence.
 *
 * It is not a stand-in for the database tests — those must run against real
 * PostgreSQL, because the fencing lives in SQL. It exists so the relay's own
 * logic (which rows it acknowledges, when it stops, what it releases) can be
 * exercised deterministically, and it enforces the token so a relay bug that
 * mutates rows it no longer owns fails here rather than silently passing.
 */
class FakeStore implements OutboxStore {
  pending: OutboxRow[] = [];
  published: string[] = [];
  failed: Array<{ id: string; error: string }> = [];
  released: string[] = [];
  /** id -> the token that currently owns it. */
  tokens = new Map<string, string>();
  claims = 0;

  async claimPending(request: ClaimRequest): Promise<OutboxClaim> {
    this.claims += 1;
    const rows = this.pending.splice(0, request.limit);
    if (rows.length === 0) return { token: null, rows: [], reclaimed: 0 };
    const token = `token-${this.claims}`;
    for (const row of rows) this.tokens.set(row.id, token);
    return { token, rows, reclaimed: 0 };
  }

  async markPublished(ids: readonly string[], token: string): Promise<number> {
    const mine = ids.filter((id) => this.tokens.get(id) === token);
    this.published.push(...mine);
    for (const id of mine) this.tokens.delete(id);
    return mine.length;
  }

  async markFailed(id: string, token: string, error: string): Promise<number> {
    if (this.tokens.get(id) !== token) return 0;
    this.failed.push({ id, error });
    this.tokens.delete(id);
    return 1;
  }

  async release(ids: readonly string[], token: string): Promise<number> {
    const mine = ids.filter((id) => this.tokens.get(id) === token);
    this.released.push(...mine);
    for (const id of mine) this.tokens.delete(id);
    return mine.length;
  }

  async renew(ids: readonly string[], token: string): Promise<string[]> {
    return ids.filter((id) => this.tokens.get(id) === token);
  }

  async oldestPendingAgeSeconds(): Promise<number> {
    return this.pending.length === 0 ? 0 : 60;
  }

  /** Simulates another claimant taking rows back. */
  reclaim(ids: readonly string[], token = 'stolen'): void {
    for (const id of ids) this.tokens.set(id, token);
  }
}

describe('OutboxRelay', () => {
  it('publishes a batch and marks it published', async () => {
    const store = new FakeStore();
    store.pending = [makeRow('1'), makeRow('2')];
    const publish = jest.fn().mockResolvedValue(undefined);

    const relay = new OutboxRelay({ store, publisher: { publish } });
    const count = await relay.tick();

    expect(count).toBe(2);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(store.published).toEqual(['1', '2']);
  });

  it('does nothing when there is nothing pending', async () => {
    const publish = jest.fn();
    const relay = new OutboxRelay({ store: new FakeStore(), publisher: { publish } });

    expect(await relay.tick()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('falls back to per-row publishing so one bad message cannot block the queue', async () => {
    const store = new FakeStore();
    store.pending = [makeRow('good-1'), makeRow('poison'), makeRow('good-2')];

    const publish = jest.fn(async (rows: readonly OutboxRow[]) => {
      if (rows.length > 1) throw new Error('batch rejected');
      if (rows[0]?.id === 'poison') throw new Error('invalid payload');
    });

    const relay = new OutboxRelay({ store, publisher: { publish } });
    const count = await relay.tick();

    expect(count).toBe(2);
    expect(store.published).toEqual(['good-1', 'good-2']);
    expect(store.failed).toEqual([{ id: 'poison', error: 'Error: invalid payload' }]);
  });

  it('records the failure reason for a poisoned row', async () => {
    const store = new FakeStore();
    store.pending = [makeRow('poison')];
    const publish = jest.fn().mockRejectedValue(new Error('topic does not exist'));

    await new OutboxRelay({ store, publisher: { publish } }).tick();

    expect(store.failed[0]?.error).toContain('topic does not exist');
  });

  it('survives a store failure without crashing the relay loop', async () => {
    const store = new FakeStore();
    store.claimPending = jest.fn().mockRejectedValue(new Error('database unavailable'));

    const relay = new OutboxRelay({ store, publisher: { publish: jest.fn() } });

    await expect(relay.tick()).resolves.toBe(0);
  });

  it('does not run two ticks concurrently', async () => {
    // Overlapping ticks would claim and publish the same rows twice.
    const store = new FakeStore();
    store.pending = [makeRow('1')];

    let resolvePublish: (() => void) | undefined;
    const publish = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePublish = resolve;
        }),
    );

    const relay = new OutboxRelay({ store, publisher: { publish } });
    const first = relay.tick();
    const second = await relay.tick();

    expect(second).toBe(0);
    resolvePublish?.();
    await first;
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
