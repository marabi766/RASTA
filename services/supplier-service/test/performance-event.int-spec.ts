import { ulid } from 'ulid';
import type { PerformanceEventInput } from '../src/performance/performance-event';
import { PerformanceEventRepository } from '../src/performance/performance-event.repository';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asSupplier, newOrganizationId, newPrisma } from './helpers';
import { ownerPrisma, raw } from './performance-helpers';

/**
 * ADR-052 step 3 — the append-only performance-event store, against a real
 * PostgreSQL.
 *
 * Each rule is attacked with raw SQL first, so the refusal is the database's,
 * then exercised through the repository the step-5 consumers will use. Every
 * test writes under fresh organization and event ids: the rows cannot be
 * cleaned up, which is the point.
 */

const APPEND_ONLY = /performance_event is append-only/;

function rating(
  organizationId: string,
  overrides: Partial<PerformanceEventInput> = {},
): PerformanceEventInput {
  return {
    organizationId,
    sourceEventId: `EVT_${ulid()}`,
    sourceEventName: 'REVIEW_SUBMITTED',
    component: 'CUSTOMER_SATISFACTION',
    outcomeKind: 'ORDER',
    outcomeKey: `ORD_${ulid()}`,
    responsibility: null,
    rating: 4,
    promisedAt: null,
    deliveredAt: null,
    compensatesSourceEventId: null,
    occurredAt: new Date('2026-09-20T10:00:00.000Z'),
    correlationId: ulid(),
    ...overrides,
  };
}

function dispute(
  organizationId: string,
  overrides: Partial<PerformanceEventInput> = {},
): PerformanceEventInput {
  return rating(organizationId, {
    sourceEventName: 'ORDER_DISPUTE_RESOLVED',
    component: 'DISPUTE_ABSENCE',
    rating: null,
    responsibility: 'SUPPLIER',
    ...overrides,
  });
}

/** A raw INSERT with every column spelled out — bypassing every TypeScript check. */
function insertSql(columns: Record<string, string>): string {
  const row: Record<string, string> = {
    id: `'PEV_${ulid()}'`,
    organization_id: `'ORG_${ulid()}'`,
    source_event_id: `'EVT_${ulid()}'`,
    source_event_name: `'REVIEW_SUBMITTED'`,
    component: `'CUSTOMER_SATISFACTION'`,
    outcome_kind: `'ORDER'`,
    outcome_key: `'ORD_${ulid()}'`,
    responsibility: 'NULL',
    rating: '4',
    promised_at: 'NULL',
    delivered_at: 'NULL',
    compensates_source_event_id: 'NULL',
    occurred_at: 'now()',
    correlation_id: `'COR'`,
    ...columns,
  };
  return `INSERT INTO "performance_event" (${Object.keys(row)
    .map((c) => `"${c}"`)
    .join(', ')}) VALUES (${Object.values(row).join(', ')})`;
}

describe('performance-event store (ADR-052 step 3)', () => {
  let prisma: PrismaService;
  /** The schema owner — the trigger attacks run as it (see `ownerPrisma`). */
  let owner: PrismaService;
  let events: PerformanceEventRepository;

  beforeAll(() => {
    prisma = newPrisma();
    owner = ownerPrisma();
    events = new PerformanceEventRepository(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await owner.onModuleDestroy();
  });

  function exec(sql: string): Promise<number> {
    return raw(() => owner.client.$executeRawUnsafe(sql));
  }

  function record(input: PerformanceEventInput) {
    return asSupplier(input.organizationId, () =>
      prisma.transaction((tx) => events.record(tx, input)),
    );
  }

  async function seeded(): Promise<{ organizationId: string; sourceEventId: string }> {
    const organizationId = newOrganizationId();
    const input = dispute(organizationId);
    await record(input);
    return { organizationId, sourceEventId: input.sourceEventId };
  }

  describe('append-only, enforced by the database', () => {
    it('refuses UPDATE — even of a column nothing reads', async () => {
      const { sourceEventId } = await seeded();

      await expect(
        exec(
          `UPDATE "performance_event" SET "correlation_id" = 'X' WHERE "source_event_id" = '${sourceEventId}'`,
        ),
      ).rejects.toThrow(APPEND_ONLY);
    });

    it('refuses rewriting an attribution in place — correction is a new row', async () => {
      const { sourceEventId } = await seeded();

      await expect(
        exec(
          `UPDATE "performance_event" SET "responsibility" = 'BUYER' WHERE "source_event_id" = '${sourceEventId}'`,
        ),
      ).rejects.toThrow(APPEND_ONLY);
    });

    it('refuses DELETE', async () => {
      const { sourceEventId } = await seeded();

      await expect(
        exec(`DELETE FROM "performance_event" WHERE "source_event_id" = '${sourceEventId}'`),
      ).rejects.toThrow(APPEND_ONLY);
    });

    it('refuses TRUNCATE', async () => {
      await seeded();

      await expect(exec('TRUNCATE "performance_event" CASCADE')).rejects.toThrow(APPEND_ONLY);
    });
  });

  describe('idempotency on the source event id (rule 8)', () => {
    it('refuses a second raw row for one source event, even under another tenant', async () => {
      const { sourceEventId } = await seeded();

      await expect(exec(insertSql({ source_event_id: `'${sourceEventId}'` }))).rejects.toThrow(
        /Key \(source_event_id\)=.* already exists/,
      );
    });

    it('records a fact once and answers DUPLICATE on redelivery, changing nothing', async () => {
      const input = dispute(newOrganizationId());

      expect(await record(input)).toBe('RECORDED');
      const first = await asSupplier(input.organizationId, () =>
        events.findBySourceEventId(input.sourceEventId),
      );
      expect(await record(input)).toBe('DUPLICATE');
      expect(await record({ ...input, correlationId: ulid() })).toBe('DUPLICATE');

      const all = await asSupplier(input.organizationId, () =>
        events.listInWindow(new Date('2026-01-01'), new Date('2027-01-01')),
      );
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(first);
    });

    it('refuses a redelivery that claims a different fact under the same event id', async () => {
      const input = dispute(newOrganizationId());
      await record(input);

      await expect(record({ ...input, outcomeKey: `ORD_${ulid()}` })).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      await expect(record({ ...input, organizationId: newOrganizationId() })).rejects.toMatchObject(
        {
          code: 'BUSINESS_RULE_VIOLATION',
        },
      );
    });

    it('is separate from processed_event — counting writes nothing there', async () => {
      const input = rating(newOrganizationId());
      await record(input);

      const seen = await raw(() =>
        prisma.client.processedEvent.count({ where: { eventId: input.sourceEventId } }),
      );
      expect(seen).toBe(0);
    });
  });

  describe('responsibility is a closed enum; UNDETERMINED is a stored value', () => {
    it('refuses an unlisted responsibility', async () => {
      await expect(
        exec(
          insertSql({ component: `'DISPUTE_ABSENCE'`, rating: 'NULL', responsibility: `'VENDOR'` }),
        ),
      ).rejects.toThrow(/invalid input value for enum/);
    });

    it('refuses an attributed component with no responsibility', async () => {
      await expect(
        exec(insertSql({ component: `'CANCELLATION_ABSENCE'`, rating: 'NULL' })),
      ).rejects.toThrow(/ck_performance_event_responsibility/);
    });

    it('refuses a responsibility on a component that is not about fault', async () => {
      await expect(exec(insertSql({ responsibility: `'SUPPLIER'` }))).rejects.toThrow(
        /ck_performance_event_responsibility/,
      );
    });

    it('stores UNDETERMINED as itself, never as a missing value', async () => {
      const input = dispute(newOrganizationId(), {
        component: 'CANCELLATION_ABSENCE',
        responsibility: 'UNDETERMINED',
      });
      await record(input);

      const stored = await asSupplier(input.organizationId, () =>
        events.findBySourceEventId(input.sourceEventId),
      );
      expect(stored?.responsibility).toBe('UNDETERMINED');
    });
  });

  describe('the measurement fits the component', () => {
    it.each(['0', '6'])('refuses a rating of %s', async (value) => {
      await expect(exec(insertSql({ rating: value }))).rejects.toThrow(
        /ck_performance_event_rating/,
      );
    });

    it('refuses a satisfaction row with no rating', async () => {
      await expect(exec(insertSql({ rating: 'NULL' }))).rejects.toThrow(
        /ck_performance_event_rating/,
      );
    });

    it('refuses an ON_TIME row with both sides, or neither', async () => {
      const onTime = { component: `'ON_TIME'`, rating: 'NULL' };

      await expect(
        exec(insertSql({ ...onTime, promised_at: 'now()', delivered_at: 'now()' })),
      ).rejects.toThrow(/ck_performance_event_timeliness/);
      await expect(exec(insertSql(onTime))).rejects.toThrow(/ck_performance_event_timeliness/);
    });

    it('refuses QUALITY until docs/24 Q-56 is answered', async () => {
      await expect(exec(insertSql({ component: `'QUALITY'`, rating: 'NULL' }))).rejects.toThrow(
        /ck_performance_event_quality_unmeasured/,
      );
    });

    it('refuses a blank outcome key — the sample unit of ADR-052 § 6', async () => {
      await expect(exec(insertSql({ outcome_key: `E'\\t'` }))).rejects.toThrow(
        /ck_performance_event_text_not_blank/,
      );
    });

    it('refuses an outcome kind outside ORDER / REPAIR_ORDER', async () => {
      await expect(exec(insertSql({ outcome_kind: `'PROJECT'` }))).rejects.toThrow(
        /invalid input value for enum/,
      );
    });
  });

  describe('correction by compensating event (ADR-052 § 14)', () => {
    it('records a correction beside the original, which stays untouched', async () => {
      const { organizationId, sourceEventId } = await seeded();
      const correction = dispute(organizationId, {
        responsibility: 'BUYER',
        compensatesSourceEventId: sourceEventId,
      });

      expect(await record(correction)).toBe('RECORDED');
      const original = await asSupplier(organizationId, () =>
        events.findBySourceEventId(sourceEventId),
      );
      expect(original?.responsibility).toBe('SUPPLIER');
    });

    it('refuses a correction of a fact that does not exist', async () => {
      const organizationId = newOrganizationId();

      await expect(
        record(dispute(organizationId, { compensatesSourceEventId: `EVT_${ulid()}` })),
      ).rejects.toThrow(/performance_event_compensates_fkey/);
    });

    it('refuses a correction across components or across suppliers', async () => {
      const { organizationId, sourceEventId } = await seeded();

      await expect(
        record(
          dispute(organizationId, {
            component: 'CANCELLATION_ABSENCE',
            compensatesSourceEventId: sourceEventId,
          }),
        ),
      ).rejects.toThrow(/performance_event_compensates_fkey/);
      await expect(
        record(dispute(newOrganizationId(), { compensatesSourceEventId: sourceEventId })),
      ).rejects.toThrow(/performance_event_compensates_fkey/);
    });

    it('refuses a row that compensates itself', async () => {
      const id = `EVT_${ulid()}`;

      await expect(
        exec(
          insertSql({
            source_event_id: `'${id}'`,
            compensates_source_event_id: `'${id}'`,
          }),
        ),
      ).rejects.toThrow(/ck_performance_event_not_self_compensating|compensates_fkey/);
    });
  });

  describe('reading, in the calculation’s total order', () => {
    it('returns the half-open window [from, to) ordered by (occurredAt, sourceEventId)', async () => {
      const organizationId = newOrganizationId();
      const at = (iso: string) => new Date(iso);
      const inputs = [
        rating(organizationId, {
          sourceEventId: `EVT_B_${ulid()}`,
          occurredAt: at('2026-09-10T00:00:00Z'),
        }),
        rating(organizationId, {
          sourceEventId: `EVT_A_${ulid()}`,
          occurredAt: at('2026-09-10T00:00:00Z'),
        }),
        rating(organizationId, { occurredAt: at('2026-09-01T00:00:00Z') }),
        rating(organizationId, { occurredAt: at('2026-10-01T00:00:00Z') }),
      ];
      for (const input of [...inputs].reverse()) await record(input);

      const window = await asSupplier(organizationId, () =>
        events.listInWindow(at('2026-09-01T00:00:00Z'), at('2026-10-01T00:00:00Z')),
      );

      expect(window.map((row) => row.sourceEventId)).toEqual([
        inputs[2]?.sourceEventId,
        inputs[1]?.sourceEventId,
        inputs[0]?.sourceEventId,
      ]);
    });
  });

  describe('tenant isolation', () => {
    it('never shows one supplier the facts of another', async () => {
      const a = await seeded();
      const b = await seeded();

      const seenByA = await asSupplier(a.organizationId, () =>
        events.listInWindow(new Date('2026-01-01'), new Date('2027-01-01')),
      );
      expect(seenByA.map((row) => row.organizationId)).toEqual([a.organizationId]);
      expect(
        await asSupplier(a.organizationId, () => events.findBySourceEventId(b.sourceEventId)),
      ).toBeNull();
    });

    it('refuses writing a fact for another tenant from this tenant’s context', async () => {
      const a = newOrganizationId();
      const b = newOrganizationId();

      await expect(
        asSupplier(a, () => prisma.transaction((tx) => events.record(tx, rating(b)))),
      ).rejects.toThrow(/Cross-tenant writes are never implicit/);
      expect(
        await asSupplier(b, () => events.listInWindow(new Date(0), new Date('2100-01-01'))),
      ).toEqual([]);
    });
  });
});
