import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { EventPublisher, ID_PREFIX, newId } from './publisher';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type { SupplierEnv } from '../config/env';

/**
 * The single point every event in this service passes through.
 *
 * Everything here is decided once, so it is asserted once: the envelope, the
 * partition key, the tenant, the correlation id, and the two ADR-051 columns
 * this service must **not** write. A `tx` that records the row it was handed is
 * enough — the row's shape is the contract, and Prisma's job of persisting it is
 * covered by the integration suites.
 */

const ENV = { SERVICE_VERSION: '0.4.2' } as SupplierEnv;

function recordingTx() {
  const rows: Record<string, unknown>[] = [];
  const tx = {
    outboxMessage: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        rows.push(data);
        return data;
      },
    },
  } as unknown as ExtendedPrismaClient;

  return { tx, rows };
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

async function enqueue(
  payload: unknown,
  eventName: 'SUPPLIER_QUALIFIED' | 'SUPPLIER_SUSPENDED' = 'SUPPLIER_QUALIFIED',
  ctx: RequestContext = context(),
) {
  const { tx, rows } = recordingTx();
  const publisher = new EventPublisher(ENV);

  await runWithContext(ctx, () =>
    publisher.enqueue(tx, {
      eventName,
      aggregateId: eventName === 'SUPPLIER_QUALIFIED' ? 'QLF_1' : 'SSP_1',
      organizationId: 'ORG_1',
      payload,
    }),
  );

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

describe('ADR-051 B1 stays inert', () => {
  it('writes neither stream_seq nor is_stream_head', async () => {
    // B3 allocates the sequence and B4 maintains the head. Neither is merged,
    // and writing either here would fabricate an ordering guarantee that does
    // not exist (D-027).
    const row = await enqueue(QUALIFIED);

    expect(row).not.toHaveProperty('streamSeq');
    expect(row).not.toHaveProperty('isStreamHead');
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
