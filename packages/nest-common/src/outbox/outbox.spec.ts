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

// ---------------------------------------------------------------------------
// ADR-051 Phase B3 — stream metadata on the envelope, the header and the row
//
// `buildOutboxRow` stays pure: it receives an already-allocated sequence and
// places it, and it never obtains one. These tests hold that contract and the
// two ways a caller can get it wrong.
// ---------------------------------------------------------------------------

describe('buildOutboxRow stream metadata', () => {
  const input = {
    aggregateType: 'Order',
    aggregateId: 'ORD_1',
    eventName: 'ORDER_CREATED',
    topic: 'rasta.marketplace.v1',
    partitionKey: 'ORD_1',
    payload: { orderId: 'ORD_1' },
  };
  const options = { producer: 'marketplace-service', producerVersion: '0.3.1' };

  it('places the sequence in the envelope, the header and the persisted column', () => {
    const row = buildOutboxRow({ ...input, streamSeq: 7, streamKey: 'ORD_1' }, options);
    const envelope = row.payload as Record<string, unknown>;

    // All three agree, because all three read the same input.
    expect(envelope.streamSeq).toBe(7);
    expect(envelope.streamKey).toBe('ORD_1');
    expect(row.headers['x-stream-seq']).toBe('7');
    expect(row.streamSeq).toBe(7);
  });

  it('writes the header as canonical decimal, not as a JavaScript number literal', () => {
    const row = buildOutboxRow({ ...input, streamSeq: 1234567, streamKey: 'ORD_1' }, options);
    expect(row.headers['x-stream-seq']).toBe('1234567');
    expect(typeof row.headers['x-stream-seq']).toBe('string');
  });

  it('emits neither field when no sequence was allocated — the legacy call site', () => {
    const row = buildOutboxRow(input, options);
    const envelope = row.payload as Record<string, unknown>;

    expect(Object.hasOwn(envelope, 'streamSeq')).toBe(false);
    expect(Object.hasOwn(envelope, 'streamKey')).toBe(false);
    expect(row.headers['x-stream-seq']).toBeUndefined();
    expect(row.streamSeq).toBeNull();
  });

  it('leaves every pre-existing header untouched either way', () => {
    const without = buildOutboxRow(input, options);
    const withStream = buildOutboxRow({ ...input, streamSeq: 2, streamKey: 'ORD_1' }, options);

    const { 'x-stream-seq': added, ...rest } = withStream.headers;
    expect(added).toBe('2');
    // Only `x-event-id` and `x-correlation-id` differ, and only because each
    // call mints a new ULID.
    expect(Object.keys(rest).sort()).toEqual(Object.keys(without.headers).sort());
  });

  it('adds no x-stream-key header', () => {
    const row = buildOutboxRow({ ...input, streamSeq: 3, streamKey: 'ORD_1' }, options);
    expect(row.headers['x-stream-key']).toBeUndefined();
  });

  it('refuses a sequence without its key, and a key without its sequence', () => {
    expect(() => buildOutboxRow({ ...input, streamSeq: 1 }, options)).toThrow(
      /must be supplied together/,
    );
    expect(() => buildOutboxRow({ ...input, streamKey: 'ORD_1' }, options)).toThrow(
      /must be supplied together/,
    );
  });

  it('refuses a streamKey that is not the partition key it was allocated against', () => {
    // The stream is `topic + partitionKey`. A mismatch here would put the
    // consumer's view of the stream out of step with the producer's.
    expect(() =>
      buildOutboxRow({ ...input, streamSeq: 1, streamKey: 'SOMETHING_ELSE' }, options),
    ).toThrow(/streamKey must equal the partition key/);
  });

  it('checks the streamKey against the defaulted partition key too', () => {
    const withoutExplicitKey = { ...input, partitionKey: undefined };
    // partitionKey defaults to aggregateId, so ORD_1 is right and DRV_1 is not.
    expect(() =>
      buildOutboxRow({ ...withoutExplicitKey, streamSeq: 1, streamKey: 'ORD_1' }, options),
    ).not.toThrow();
    expect(() =>
      buildOutboxRow({ ...withoutExplicitKey, streamSeq: 1, streamKey: 'DRV_1' }, options),
    ).toThrow(/streamKey must equal the partition key/);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 2.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 2],
  ])('refuses a %s sequence', (_label, streamSeq) => {
    expect(() => buildOutboxRow({ ...input, streamSeq, streamKey: 'ORD_1' }, options)).toThrow(
      /positive safe integer/,
    );
  });

  it('produces an envelope that survives JSON without a bigint', () => {
    const row = buildOutboxRow({ ...input, streamSeq: 5, streamKey: 'ORD_1' }, options);
    const revived = JSON.parse(JSON.stringify(row.payload)) as Record<string, unknown>;
    expect(revived.streamSeq).toBe(5);
    expect(typeof revived.streamSeq).toBe('number');
  });
});

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
