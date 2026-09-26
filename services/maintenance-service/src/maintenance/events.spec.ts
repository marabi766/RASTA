import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAINTENANCE_EVENTS,
  MAINTENANCE_EVENT_SCHEMAS,
  usageRecordedSchema,
  validateMaintenancePayload,
  type MaintenanceEventName,
} from './events';

/**
 * Contract tests.
 *
 * Two consumers were written before this service existed and cannot be
 * renegotiated by editing a payload here:
 *
 *   asset-service's `TimelineConsumer` attaches an entry by `assetId` and
 *   **silently skips** an event without one. It reads a repair's cost from a
 *   flat `totalCostMinor` string.
 *
 *   fleet-service's `AssetSyncConsumer` sets `asset_ref.inMaintenance` from
 *   MAINTENANCE_STARTED and clears it on MAINTENANCE_COMPLETED.
 *
 * The failure these tests exist to prevent is silent in every direction: a
 * missing `assetId` produces no error anywhere, just a machine stuck in
 * IN_MAINTENANCE with nothing in its file to explain why. fleet-service
 * shipped exactly that bug on `ASSIGNMENT_ENDED` and only a contract test
 * closed it.
 */
describe('maintenance event contracts', () => {
  const NAMES = Object.values(MAINTENANCE_EVENTS) as MaintenanceEventName[];

  it('every event this service publishes has a schema', () => {
    for (const name of NAMES) {
      expect(MAINTENANCE_EVENT_SCHEMAS[name]).toBeDefined();
    }
  });

  it('every event carries the asset, because that is what consumers attach to', () => {
    // Not one of these events is about a request in the abstract. Every
    // consumer — the dossier, the fleet replica, notification — reasons about
    // a machine, and `assetId` is also the partition key that keeps a
    // machine's events in order.
    for (const name of NAMES) {
      const shape = (MAINTENANCE_EVENT_SCHEMAS[name] as { shape: Record<string, unknown> }).shape;
      expect(Object.keys(shape)).toContain('assetId');
      expect(Object.keys(shape)).toContain('organizationId');
    }
  });

  it('refuses a payload that omits the asset', () => {
    expect(() =>
      validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_COMPLETED, {
        requestId: 'MNT_1',
        organizationId: 'ORG-DEH-0001',
        type: 'CORRECTIVE',
        scheduleId: null,
        completedAt: new Date().toISOString(),
        downtimeMinutes: 10,
        totalCostMinor: '1000',
        currency: 'IRR',
      }),
    ).toThrow();
  });

  it('carries a repair cost as a flat minor-unit string, which is what the dossier reads', () => {
    // asset-service reads `totalCostMinor` and requires a string of digits; it
    // returns null for anything else, so a nested `{ amountMinor, currency }`
    // would record every repair as costing nothing.
    const payload = validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_COMPLETED, {
      requestId: 'MNT_1',
      assetId: 'AST-SEED-0002',
      organizationId: 'ORG-DEH-0001',
      type: 'CORRECTIVE',
      scheduleId: null,
      completedAt: new Date().toISOString(),
      downtimeMinutes: 7200,
      totalCostMinor: '16150000',
      currency: 'IRR',
    }) as { totalCostMinor: string };

    expect(typeof payload.totalCostMinor).toBe('string');
    expect(payload.totalCostMinor).toMatch(/^\d+$/);
  });

  it('refuses a cost that is not an integer string of minor units', () => {
    const base = {
      repairOrderId: 'RPO_1',
      requestId: 'MNT_1',
      assetId: 'AST-SEED-0002',
      organizationId: 'ORG-DEH-0001',
      workshopOrganizationId: 'ORG-DEH-0002',
      completedAt: new Date().toISOString(),
      currency: 'IRR',
    };

    // A float is the failure mode this rejects: it is what a naive client
    // sends, and it is unrepresentable in the ledger it eventually reaches.
    expect(() =>
      validateMaintenancePayload(MAINTENANCE_EVENTS.REPAIR_COMPLETED, {
        ...base,
        totalCostMinor: '161500.50',
      }),
    ).toThrow();

    expect(() =>
      validateMaintenancePayload(MAINTENANCE_EVENTS.REPAIR_COMPLETED, {
        ...base,
        totalCostMinor: -1,
      }),
    ).toThrow();
  });

  it('lets MAINTENANCE_DUE say it has no calendar date', () => {
    // A usage-based schedule comes due at a meter reading. Inventing a date
    // for it would be inventing a fact, so `dueBy` is nullable and the meter
    // is carried instead.
    const payload = validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_DUE, {
      scheduleId: 'MSC-SEED-0001',
      assetId: 'AST-SEED-0001',
      organizationId: 'ORG-DEH-0001',
      title: 'تعویض روغن موتور',
      basis: 'HOURS',
      state: 'OVERDUE',
      dueBy: null,
      dueAtMeter: '4560.00',
    }) as { dueBy: string | null; dueAtMeter: string | null };

    expect(payload.dueBy).toBeNull();
    expect(payload.dueAtMeter).toBe('4560.00');
  });

  it('carries a per-category breakdown on the event that authorises settlement', () => {
    // A total on its own is a number economic-service has to trust. One that
    // decomposes is one it can audit (ADR-028).
    const payload = validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_APPROVED, {
      requestId: 'MNT-SEED-0001',
      assetId: 'AST-SEED-0002',
      organizationId: 'ORG-DEH-0001',
      approvedBy: 'USR-SEED-DEHYARI-ADMIN',
      approvedAt: new Date().toISOString(),
      workshopOrganizationId: 'ORG-DEH-0002',
      totalCostMinor: '16150000',
      currency: 'IRR',
      costBreakdown: [
        { category: 'PART', amountMinor: '9100000', currency: 'IRR' },
        { category: 'LABOUR', amountMinor: '5850000', currency: 'IRR' },
        { category: 'SERVICE', amountMinor: '1200000', currency: 'IRR' },
      ],
    }) as { costBreakdown: { amountMinor: string }[] };

    const sum = payload.costBreakdown.reduce((total, line) => total + BigInt(line.amountMinor), 0n);
    expect(sum).toBe(16_150_000n);
  });
});

describe('the usage event this service consumes', () => {
  it('accepts a reading with only kilometres', () => {
    // fleet-service requires *at least one* of hours or kilometres, so a
    // kilometres-only reading is valid input. Requiring both here would
    // dead-letter perfectly good events from a truck.
    const parsed = usageRecordedSchema.safeParse({
      usageRecordId: 'USG_1',
      assetId: 'AST-SEED-0001',
      organizationId: 'ORG-DEH-0001',
      hours: null,
      kilometres: '120.50',
      hourMeter: null,
      odometer: '18240.00',
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts a reading with no meter at all', () => {
    const parsed = usageRecordedSchema.safeParse({
      usageRecordId: 'USG_2',
      assetId: 'AST-SEED-0001',
      hours: '8.00',
    });

    expect(parsed.success).toBe(true);
  });

  it('refuses a reading that names no machine', () => {
    // There would be no meter to fold it into. Skipped rather than guessed.
    const parsed = usageRecordedSchema.safeParse({ usageRecordId: 'USG_3', hours: '8.00' });
    expect(parsed.success).toBe(false);
  });

  it('tolerates fields fleet-service adds later', () => {
    // `.passthrough()` is deliberate: a producer adding a field must not break
    // this consumer, and this service has no business asserting the full shape
    // of another service's event.
    const parsed = usageRecordedSchema.safeParse({
      usageRecordId: 'USG_4',
      assetId: 'AST-SEED-0001',
      hours: '8.00',
      somethingNew: 'from a future fleet-service',
    });

    expect(parsed.success).toBe(true);
  });
});

describe('the published catalogue', () => {
  it('documents every event this service publishes', () => {
    // The catalogue is the contract other teams read. CI checks the same
    // thing across the platform; this catches the drift before CI does, and
    // names the missing event rather than the file.
    const catalogue = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'docs', 'events', 'README.md'),
      'utf8',
    );

    for (const name of Object.values(MAINTENANCE_EVENTS)) {
      expect(catalogue).toContain(name);
    }
  });
});

/**
 * `MAINTENANCE_SCHEDULE_CHANGED` — the event that closes `D-011`.
 *
 * Its contract is different in kind from the other nine. Those exist because a
 * named consumer needs them; this one exists because `AGENTS.md` S-06 requires
 * every state-changing action to leave an audit record, and a service schedule
 * — the rule that decides how often a machine is serviced — could be created,
 * re-intervalled or switched off with nothing reaching the log at all.
 *
 * `audit-service` records every domain envelope it receives, including names it
 * does not recognise, so the guarantee holds the moment this is published. What
 * these tests defend is the *content*: an audit record that cannot answer who,
 * when and why is a record that satisfies the letter of the rule and none of
 * its purpose.
 */
describe('MAINTENANCE_SCHEDULE_CHANGED', () => {
  const valid = {
    scheduleId: 'MSC_01ABC',
    assetId: 'AST-0001',
    organizationId: 'ORG-1',
    change: 'STATUS_CHANGED' as const,
    status: 'PAUSED',
    previousStatus: 'ACTIVE',
    reason: 'دستگاه تا پایان فصل خارج از ناوگان است',
    changedFields: ['status'],
    changedAt: '2026-09-19T06:00:00.000Z',
    changedBy: 'USR-7',
  };

  it('accepts a status change with its reason', () => {
    expect(
      validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_SCHEDULE_CHANGED, valid),
    ).toMatchObject({ change: 'STATUS_CHANGED', previousStatus: 'ACTIVE', status: 'PAUSED' });
  });

  it('accepts a creation, which has no previous status and no reason', () => {
    expect(
      validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_SCHEDULE_CHANGED, {
        ...valid,
        change: 'CREATED',
        status: 'ACTIVE',
        previousStatus: null,
        reason: null,
        changedFields: [],
      }),
    ).toMatchObject({ change: 'CREATED', previousStatus: null });
  });

  it('accepts an edit, which names the fields that moved', () => {
    expect(
      validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_SCHEDULE_CHANGED, {
        ...valid,
        change: 'UPDATED',
        status: 'ACTIVE',
        previousStatus: 'ACTIVE',
        reason: null,
        changedFields: ['intervalHours', 'leadHours'],
      }),
    ).toMatchObject({ changedFields: ['intervalHours', 'leadHours'] });
  });

  // The whole point of the event. A record that cannot name the actor answers
  // "something changed" and nothing an auditor asked.
  it.each([
    'scheduleId',
    'assetId',
    'organizationId',
    'change',
    'status',
    'changedAt',
    'changedBy',
  ])('refuses a payload without %s', (field) => {
    const { [field]: _removed, ...rest } = valid as Record<string, unknown>;
    expect(() =>
      validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_SCHEDULE_CHANGED, rest),
    ).toThrow();
  });

  it('refuses a change kind it does not know', () => {
    expect(() =>
      validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_SCHEDULE_CHANGED, {
        ...valid,
        change: 'DELETED',
      }),
    ).toThrow();
  });

  // `previousStatus` and `reason` are nullable, not optional. A publisher that
  // simply omitted them would produce a record whose silence is ambiguous:
  // "there was no reason" and "nobody recorded one" are different facts.
  it.each(['previousStatus', 'reason'])('requires %s to be present, even as null', (field) => {
    const { [field]: _removed, ...rest } = valid as Record<string, unknown>;
    expect(() =>
      validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_SCHEDULE_CHANGED, rest),
    ).toThrow();
  });
});

/**
 * The cost-line events (L7-14): money as minor-unit strings, and no free text
 * in a durable log that every service reads.
 */
describe('cost-line event contracts', () => {
  const base = {
    repairOrderId: 'RPO_1',
    requestId: 'MNT_1',
    assetId: 'AST-SEED-0002',
    organizationId: 'ORG-DEH-0001',
    workshopOrganizationId: 'ORG-WORKSHOP-1',
    costId: 'MCS_1',
    currency: 'IRR',
    recordedAt: '2026-09-25T10:00:00.000Z',
    recordedBy: 'USR-1',
    orderTotalCostMinor: '500000',
    requestTotalCostMinor: '500000',
  };
  const part = {
    ...base,
    partUsageId: 'PRT_1',
    source: 'MARKETPLACE',
    quantity: '2',
    unitCostMinor: '250000',
    totalCostMinor: '500000',
  };

  it('accepts a part line with every amount as a minor-unit string', () => {
    expect(() =>
      validateMaintenancePayload(MAINTENANCE_EVENTS.REPAIR_PART_RECORDED, part),
    ).not.toThrow();
  });

  it.each(['totalCostMinor', 'unitCostMinor', 'orderTotalCostMinor', 'requestTotalCostMinor'])(
    'refuses %s as a JSON number, which would drift',
    (field) => {
      expect(() =>
        validateMaintenancePayload(MAINTENANCE_EVENTS.REPAIR_PART_RECORDED, {
          ...part,
          [field]: 500000,
        }),
      ).toThrow();
    },
  );

  it('refuses a negative or fractional amount on a cost line', () => {
    for (const amountMinor of ['-1', '1.5']) {
      expect(() =>
        validateMaintenancePayload(MAINTENANCE_EVENTS.REPAIR_COST_RECORDED, {
          ...base,
          category: 'SERVICE',
          amountMinor,
        }),
      ).toThrow();
    }
  });

  it('drops free text a caller might pass along — a technician is a person', () => {
    const payload = validateMaintenancePayload(MAINTENANCE_EVENTS.REPAIR_LABOUR_RECORDED, {
      ...base,
      laborEntryId: 'LBR_1',
      hours: '1.50',
      hourlyRateMinor: '900000',
      totalCostMinor: '1350000',
      performedAt: '2026-09-25T09:00:00.000Z',
      technician: 'نام تکنسین',
      description: 'شرح کار',
    }) as Record<string, unknown>;

    expect(payload).not.toHaveProperty('technician');
    expect(payload).not.toHaveProperty('description');
  });

  it.each(['REPAIR_PART_RECORDED', 'REPAIR_LABOUR_RECORDED', 'REPAIR_COST_RECORDED'] as const)(
    '%s names the actor and the totals after the line',
    (name) => {
      const shape = (MAINTENANCE_EVENT_SCHEMAS[name] as { shape: Record<string, unknown> }).shape;
      for (const field of [
        'recordedBy',
        'costId',
        'orderTotalCostMinor',
        'requestTotalCostMinor',
      ]) {
        expect(Object.keys(shape)).toContain(field);
      }
    },
  );
});
