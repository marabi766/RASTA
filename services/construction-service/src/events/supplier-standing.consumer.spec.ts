import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError } from '@rasta/nest-common';
import type { ContractorStandingRepository } from '../tender/contractor-standing.repository';
import { SupplierStandingConsumer } from './supplier-standing.consumer';

/** What the consumer asks of the read model, recorded; the SQL is proven in the integration suite. */
function fakeStanding(refusal?: 'ORGANIZATION_MISMATCH' | 'EPISODE_OUT_OF_ORDER') {
  const calls: unknown[][] = [];
  const repository = {
    recordQualified: async (...args: unknown[]) => void calls.push(['qualified', ...args]),
    suspend: async (...args: unknown[]) => (calls.push(['suspend', ...args]), refusal),
    reinstate: async (...args: unknown[]) => (calls.push(['reinstate', ...args]), refusal),
  } as unknown as ContractorStandingRepository;
  return { repository, calls };
}

function envelope(eventName: string, payload: Record<string, unknown>): EventEnvelope {
  return eventEnvelopeSchema.parse({
    eventId: '01J0000000000000000000000A',
    eventName,
    occurredAt: '2026-09-30T10:00:00.000Z',
    producer: 'supplier-service',
    aggregateType: 'Supplier',
    aggregateId: 'supplier-1',
    tenantId: 'org-1',
    correlationId: '01J0000000000000000000000B',
    payload,
  }) as EventEnvelope;
}

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

function consumer(refusal?: 'ORGANIZATION_MISMATCH' | 'EPISODE_OUT_OF_ORDER') {
  const { repository, calls } = fakeStanding(refusal);
  return {
    calls,
    handle: (e: EventEnvelope) =>
      new SupplierStandingConsumer(
        () => {
          throw new Error('never subscribes');
        },
        repository,
        silent,
      ).handle(e),
  };
}

describe('SupplierStandingConsumer', () => {
  it('records a CONTRACTING qualification at its decision instant', async () => {
    const c = consumer();
    await c.handle(
      envelope('SUPPLIER_QUALIFIED', {
        organizationId: 'org-1',
        qualifiedFor: ['EQUIPMENT_RENTAL', 'CONTRACTING'],
        decidedAt: '2026-09-29T08:00:00.000Z',
        decidedBy: 'op-1',
      }),
    );
    expect(c.calls).toEqual([['qualified', 'org-1', new Date('2026-09-29T08:00:00.000Z')]]);
  });

  it('ignores a qualification for other capabilities', async () => {
    const c = consumer();
    const outcome = await c.handle(
      envelope('SUPPLIER_QUALIFIED', {
        organizationId: 'org-1',
        qualifiedFor: ['EQUIPMENT_RENTAL'],
        decidedAt: '2026-09-29T08:00:00.000Z',
      }),
    );
    expect(outcome).toBe('SKIPPED');
    expect(c.calls).toEqual([]);
  });

  it('folds a suspension and its lift by episode id', async () => {
    const c = consumer();
    await c.handle(
      envelope('SUPPLIER_SUSPENDED', {
        organizationId: 'org-1',
        suspensionId: 'sus-1',
        suspendedAt: '2026-09-29T09:00:00.000Z',
      }),
    );
    await c.handle(
      envelope('SUPPLIER_REINSTATED', {
        organizationId: 'org-1',
        suspensionId: 'sus-1',
        reinstatedAt: '2026-09-29T10:00:00.000Z',
      }),
    );
    expect(c.calls).toEqual([
      ['suspend', 'org-1', 'sus-1', new Date('2026-09-29T09:00:00.000Z')],
      ['reinstate', 'org-1', 'sus-1', new Date('2026-09-29T10:00:00.000Z')],
    ]);
  });

  it('skips events that are not about standing', async () => {
    const c = consumer();
    expect(await c.handle(envelope('SUPPLIER_REGISTERED', { organizationId: 'org-1' }))).toBe(
      'SKIPPED',
    );
    expect(c.calls).toEqual([]);
  });

  it.each([
    ['SUPPLIER_QUALIFIED', { organizationId: 'org-1', qualifiedFor: [], decidedAt: '2026-09-29' }],
    [
      'SUPPLIER_QUALIFIED',
      { organizationId: 'org-1', qualifiedFor: ['CONTRACTING'], decidedAt: 'yesterday' },
    ],
    ['SUPPLIER_SUSPENDED', { organizationId: 'org-1', suspendedAt: '2026-09-29T09:00:00Z' }],
    ['SUPPLIER_REINSTATED', { suspensionId: 'sus-1', reinstatedAt: '2026-09-29T09:00:00Z' }],
  ])('dead-letters a malformed %s rather than retrying it', async (name, payload) => {
    const c = consumer();
    await expect(c.handle(envelope(name, payload))).rejects.toBeInstanceOf(UnprocessableEventError);
    expect(c.calls).toEqual([]);
  });

  describe('a qualifiedFor longer than 50 (GHSA-mrhx-c7xc-m3w5)', () => {
    const qualified = (count: number) =>
      envelope('SUPPLIER_QUALIFIED', {
        organizationId: 'org-1',
        qualifiedFor: [
          'CONTRACTING',
          ...Array.from({ length: count - 1 }, () => 'EQUIPMENT_RENTAL'),
        ],
        decidedAt: '2026-09-29T08:00:00.000Z',
      });

    it('is dead-lettered as VALIDATION_FAILED, and nothing is recorded', async () => {
      const c = consumer();
      await expect(c.handle(qualified(51))).rejects.toMatchObject({
        name: 'UnprocessableEventError',
        reason: 'VALIDATION_FAILED',
      });
      expect(c.calls).toEqual([]);
    });

    it('at 50 it is still read', async () => {
      const c = consumer();
      await c.handle(qualified(50));
      expect(c.calls).toEqual([['qualified', 'org-1', new Date('2026-09-29T08:00:00.000Z')]]);
    });
  });

  it.each(['ORGANIZATION_MISMATCH', 'EPISODE_OUT_OF_ORDER'] as const)(
    'dead-letters an episode the read model refuses (%s)',
    async (refusal) => {
      const c = consumer(refusal);
      await expect(
        c.handle(
          envelope('SUPPLIER_SUSPENDED', {
            organizationId: 'org-1',
            suspensionId: 'sus-1',
            suspendedAt: '2026-09-29T09:00:00.000Z',
          }),
        ),
      ).rejects.toBeInstanceOf(UnprocessableEventError);
    },
  );
});
