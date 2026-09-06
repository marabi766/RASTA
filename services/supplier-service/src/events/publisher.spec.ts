import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { EventPublisher, ID_PREFIX, newId } from './publisher';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type { SupplierEnv } from '../config/env';

/**
 * The single point every event in this service passes through.
 *
 * Everything here is decided once, so it is asserted once: the envelope, the
 * partition key, the tenant, the correlation id, and — since ADR-051 Phase B3 —
 * the stream position. A `tx` that records what it was asked to do is enough:
 * the row's shape and the order of the calls are the contract, and Prisma's job
 * of persisting the result is covered by the integration suites.
 *
 * The allocator itself is **not** re-tested here. `allocateStreamSeqSql` is the
 * landed shared implementation, and its SQL semantics — the upsert, the row
 * lock, rollback returning the number — belong to the shared B3 protocol suite
 * against a real PostgreSQL. Re-asserting them against a fake would only prove
 * the fake. What is this service's to prove is that it *calls* the shared
 * allocator, with the key its own routing policy chose, and carries the answer
 * through unchanged.
 *
 * Legacy optional-envelope compatibility — `streamSeq`/`streamKey` absent, which
 * `buildOutboxRow` still accepts for producers that have not been migrated — is
 * likewise owned by the shared tests. This service has exactly one producer path
 * and it is migrated, so there is nothing here to assert about the unmigrated
 * shape, and asserting it anyway would state a second, weaker contract beside
 * the real one.
 */

const ENV = { SERVICE_VERSION: '0.4.2' } as SupplierEnv;

/**
 * A transaction stand-in that records both the outbox rows it was handed and
 * the raw statements it was asked to run, in the order they arrived.
 *
 * The order matters as much as the arguments: B3 requires the sequence to be
 * allocated after routing is final and before the row is inserted, and a fake
 * that only collected rows could not tell a correct order from an inverted one.
 */
function recordingTx(options: { allocate?: () => bigint | number } = {}) {
  const rows: Record<string, unknown>[] = [];
  const queries: { sql: string; params: unknown[] }[] = [];
  const calls: string[] = [];
  const allocate = options.allocate ?? (() => 1n);

  const tx = {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      queries.push({ sql, params });
      calls.push('allocate');
      return [{ allocated: allocate() }];
    },
    outboxMessage: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push('insert');
        rows.push(data);
        return data;
      },
    },
  } as unknown as ExtendedPrismaClient;

  return { tx, rows, queries, calls };
}

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: 'req-1',
    correlationId: 'corr-abc',
    authType: 'USER',
    userId: 'USR_ACTOR',
    organizationId: 'ORG_1',
    roles: ['UNION_ADMIN'],
    startedAt: 0,
    ...overrides,
  } as RequestContext;
}

const QUALIFIED = {
  supplierId: 'SUP_1',
  organizationId: 'ORG_1',
  qualificationId: 'QLF_1',
  qualifiedFor: ['WORKSHOP_SERVICE'],
  decidedBy: 'USR_ACTOR',
  decidedAt: '2026-09-05T11:00:00.000Z',
};

/** Runs one enqueue and hands back everything the transaction saw. */
async function publish(
  payload: unknown,
  eventName: 'SUPPLIER_QUALIFIED' | 'SUPPLIER_SUSPENDED' = 'SUPPLIER_QUALIFIED',
  ctx: RequestContext = context(),
  options: { allocate?: () => bigint | number } = {},
) {
  const recorder = recordingTx(options);
  const publisher = new EventPublisher(ENV);

  await runWithContext(ctx, () =>
    publisher.enqueue(recorder.tx, {
      eventName,
      aggregateId: eventName === 'SUPPLIER_QUALIFIED' ? 'QLF_1' : 'SSP_1',
      organizationId: 'ORG_1',
      payload,
    }),
  );

  return recorder;
}

async function enqueue(
  payload: unknown,
  eventName: 'SUPPLIER_QUALIFIED' | 'SUPPLIER_SUSPENDED' = 'SUPPLIER_QUALIFIED',
  ctx: RequestContext = context(),
) {
  const { rows } = await publish(payload, eventName, ctx);

  return rows[0] as Record<string, unknown>;
}

describe('the outbox row', () => {
  it('goes to this service topic', async () => {
    expect((await enqueue(QUALIFIED)).topic).toBe('rasta.supplier.v1');
  });

  it('records the aggregate the event is about', async () => {
    const row = await enqueue(QUALIFIED);

    expect(row.aggregateType).toBe('Qualification');
    expect(row.aggregateId).toBe('QLF_1');
  });

  it('keys the stream by the supplier, not by the aggregate', async () => {
    // docs/07 § 7.7, ADR-051 § C-7 — the documented deviation.
    const row = await enqueue(QUALIFIED);

    expect(row.partitionKey).toBe('SUP_1');
    expect(row.partitionKey).not.toBe(row.aggregateId);
  });

  it('reads the key off the validated payload, not off the call site', async () => {
    // The Q-26 failure in the economic domain: a service passed one identifier
    // and published another, so the key and what the consumer saw disagreed.
    const row = await enqueue({ ...QUALIFIED, supplierId: 'SUP_OTHER' });

    expect(row.partitionKey).toBe('SUP_OTHER');
  });

  it('carries the tenant and the request correlation id', async () => {
    const row = await enqueue(QUALIFIED);

    expect(row.organizationId).toBe('ORG_1');
    expect(row.correlationId).toBe('corr-abc');
  });
});

describe('the envelope', () => {
  it('names this producer and its running version', async () => {
    const envelope = (await enqueue(QUALIFIED)).payload as Record<string, unknown>;

    expect(envelope.producer).toBe('supplier-service');
    expect(envelope.producerVersion).toBe('0.4.2');
    expect(envelope.eventVersion).toBe(1);
  });

  it('names the human who caused it', async () => {
    const envelope = (await enqueue(QUALIFIED)).payload as { actor?: { type: string; id: string } };

    expect(envelope.actor).toEqual({ type: 'USER', id: 'USR_ACTOR' });
  });

  it('carries the tenant so a consumer can enforce it', async () => {
    const envelope = (await enqueue(QUALIFIED)).payload as Record<string, unknown>;

    expect(envelope.tenantId).toBe('ORG_1');
  });
});

describe('publish-time validation (docs/07 § 7.8)', () => {
  it('refuses a payload that does not match the published contract', async () => {
    // Thrown inside the caller's transaction, so an invalid payload rolls back
    // the state change too rather than committing a fact nobody will hear about.
    await expect(enqueue({ supplierId: 'SUP_1' })).rejects.toThrow(
      /does not match its published contract/,
    );
  });

  it('refuses an unknown field rather than dropping it', async () => {
    await expect(enqueue({ ...QUALIFIED, score: 91 })).rejects.toThrow(
      /does not match its published contract/,
    );
  });

  it('writes nothing when validation fails', async () => {
    const { tx, rows } = recordingTx();
    const publisher = new EventPublisher(ENV);

    await expect(
      runWithContext(context(), () =>
        publisher.enqueue(tx, {
          eventName: 'SUPPLIER_QUALIFIED',
          aggregateId: 'QLF_1',
          organizationId: 'ORG_1',
          payload: { nonsense: true },
        }),
      ),
    ).rejects.toThrow();

    expect(rows).toEqual([]);
  });
});

describe('ADR-051 Phase B3 — the stream position', () => {
  it('allocates against this service topic and the supplier that owns the stream', async () => {
    const { queries } = await publish(QUALIFIED);

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('outbox_stream_sequence');
    // Bound, not interpolated: the topic and the key arrive as parameters, and
    // they are exactly what this service's routing policy decided.
    expect(queries[0].params).toEqual(['rasta.supplier.v1', 'SUP_1']);
  });

  it('resolves routing before it allocates, so the number belongs to the right stream', async () => {
    // The call site says the aggregate is `QLF_1`; the validated payload says
    // the supplier is `SUP_OTHER`. The allocator must see the routed key.
    // Allocating before routing were settled would number this event against a
    // stream it is not part of, and the divergence would surface only at a
    // consumer — the Q-26 shape, one phase later.
    const { queries, rows } = await publish({ ...QUALIFIED, supplierId: 'SUP_OTHER' });

    expect(queries[0].params[1]).toBe('SUP_OTHER');
    expect(rows[0].partitionKey).toBe('SUP_OTHER');
  });

  it('allocates after routing and before the insert, never the other way round', async () => {
    const { calls } = await publish(QUALIFIED);

    expect(calls).toEqual(['allocate', 'insert']);
  });

  it('carries the allocated number into the row it builds', async () => {
    // A value the allocator could not have produced by accident, so a hard-coded
    // 1 or a locally re-derived counter would fail here rather than coincide.
    const { rows } = await publish(QUALIFIED, 'SUPPLIER_QUALIFIED', context(), {
      allocate: () => 4711n,
    });

    expect(rows[0].streamSeq).toBe(4711);
  });

  it('agrees across the column, the envelope and the header', async () => {
    // The places a sequence appears. If they could disagree, a consumer reading
    // the header would build a different picture of the stream than one reading
    // the envelope, and neither would match the table.
    const { rows } = await publish(QUALIFIED, 'SUPPLIER_QUALIFIED', context(), {
      allocate: () => 9n,
    });
    const row = rows[0];
    const envelope = row.payload as { streamSeq?: number; streamKey?: string };
    const headers = row.headers as Record<string, string>;

    expect(row.streamSeq).toBe(9);
    expect(envelope.streamSeq).toBe(9);
    expect(envelope.streamKey).toBe('SUP_1');
    expect(envelope.streamKey).toBe(row.partitionKey);
    expect(headers['x-stream-seq']).toBe('9');
  });

  it('keys the envelope stream by the supplier, not by the aggregate', async () => {
    // docs/07 § 7.7, ADR-051 § C-7 again, now on the wire: the sequence counts
    // within the supplier's stream, and the envelope says which stream that is.
    const { rows } = await publish(QUALIFIED);
    const envelope = rows[0].payload as { streamKey?: string };

    expect(envelope.streamKey).toBe('SUP_1');
    expect(envelope.streamKey).not.toBe(rows[0].aggregateId);
  });

  it('writes no row and propagates the failure when allocation fails', async () => {
    // There is no unsequenced fallback. The throw leaves `enqueue`, which rolls
    // back the caller's transaction with it — so a decision whose event could
    // not be numbered does not commit either (AGENTS.md A-08).
    const recorder = recordingTx({
      allocate: () => {
        throw new Error('counter unavailable');
      },
    });
    const publisher = new EventPublisher(ENV);

    await expect(
      runWithContext(context(), () =>
        publisher.enqueue(recorder.tx, {
          eventName: 'SUPPLIER_QUALIFIED',
          aggregateId: 'QLF_1',
          organizationId: 'ORG_1',
          payload: QUALIFIED,
        }),
      ),
    ).rejects.toThrow('counter unavailable');

    expect(recorder.rows).toEqual([]);
    expect(recorder.calls).toEqual(['allocate']);
  });

  it('refuses to write an unsequenced row when the allocator returns nothing', async () => {
    const recorder = recordingTx();
    // An upsert with RETURNING always yields a row; an empty result means the
    // statement did not do what it says. The shared allocator refuses rather
    // than continuing, and this service must not paper over that by falling
    // back to a row with no position in its stream.
    (recorder.tx as unknown as { $queryRawUnsafe: () => Promise<unknown[]> }).$queryRawUnsafe =
      async () => [];
    const publisher = new EventPublisher(ENV);

    await expect(
      runWithContext(context(), () =>
        publisher.enqueue(recorder.tx, {
          eventName: 'SUPPLIER_QUALIFIED',
          aggregateId: 'QLF_1',
          organizationId: 'ORG_1',
          payload: QUALIFIED,
        }),
      ),
    ).rejects.toThrow(/Refusing to write an unsequenced event/);

    expect(recorder.rows).toEqual([]);
  });

  it('allocates nothing when the payload does not validate', async () => {
    // Validation is first for a reason: a payload that never becomes an event
    // must not consume a number, or the stream would carry a gap on behalf of
    // an event that was never written.
    const recorder = recordingTx();
    const publisher = new EventPublisher(ENV);

    await expect(
      runWithContext(context(), () =>
        publisher.enqueue(recorder.tx, {
          eventName: 'SUPPLIER_QUALIFIED',
          aggregateId: 'QLF_1',
          organizationId: 'ORG_1',
          payload: { nonsense: true },
        }),
      ),
    ).rejects.toThrow();

    expect(recorder.calls).toEqual([]);
  });

  it('still leaves the B4 head flag alone', async () => {
    // B3 allocates; B4 maintains the head. B4 is not merged, and setting the
    // flag here would claim a head-of-line guarantee no relay enforces.
    const { rows } = await publish(QUALIFIED);

    expect(rows[0]).not.toHaveProperty('isStreamHead');
  });
});

describe('identifiers are organization-agnostic (AGENTS.md A-05)', () => {
  it('prefixes by type and carries a ULID, nothing else', () => {
    const id = newId(ID_PREFIX.supplier);

    expect(id).toMatch(/^SUP_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('gives every aggregate its own prefix', () => {
    expect(new Set(Object.values(ID_PREFIX)).size).toBe(Object.values(ID_PREFIX).length);
  });

  it('encodes no province, organization type or tenant', () => {
    // An id naming "Yazd" or a dehyari would make a structural assumption the
    // platform explicitly refuses, and would leak a tenant into every log line
    // that carried it.
    const ids = Object.values(ID_PREFIX).map((prefix) => newId(prefix));

    for (const id of ids) {
      expect(id).not.toMatch(/yazd|dehyari|municipal/i);
    }
  });
});
