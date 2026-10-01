import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { cleanup, newOrganizationId, wire, type Wiring } from './helpers';

/**
 * CON-002 PR 5 (ADR-067 § 4): the contractor-standing read model, folded from
 * supplier-service's events in any order and any number of times. Against
 * PostgreSQL.
 */
describe('contractor standing follows supplier-service events', () => {
  let w: Wiring;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  function event(eventName: string, organizationId: string, payload: object): EventEnvelope {
    return eventEnvelopeSchema.parse({
      eventId: ulid(),
      eventName,
      occurredAt: new Date().toISOString(),
      producer: 'supplier-service',
      aggregateType: 'Supplier',
      aggregateId: ulid(),
      tenantId: organizationId,
      correlationId: ulid(),
      payload: { organizationId, ...payload },
    }) as EventEnvelope;
  }

  const qualified = (organizationId: string, decidedAt: string, qualifiedFor = ['CONTRACTING']) =>
    event('SUPPLIER_QUALIFIED', organizationId, { qualifiedFor, decidedAt });
  /**
   * An episode id is global (supplier-service's), so the suite namespaces its
   * labels by organization; a label starting `shared` is one id for every caller.
   */
  const RUN = ulid();
  const episode = (organizationId: string, label: string) =>
    label.startsWith('shared') ? `${RUN}-${label}` : `${organizationId}-${label}`;
  const suspended = (organizationId: string, label: string, suspendedAt: string) =>
    event('SUPPLIER_SUSPENDED', organizationId, {
      suspensionId: episode(organizationId, label),
      suspendedAt,
    });
  const reinstated = (organizationId: string, label: string, reinstatedAt: string) =>
    event('SUPPLIER_REINSTATED', organizationId, {
      suspensionId: episode(organizationId, label),
      reinstatedAt,
    });

  const handle = (e: EventEnvelope) => w.supplierEvents.handle(e);
  const eligible = (organizationId: string) => w.standing.isEligible(organizationId);

  beforeAll(() => {
    w = wire();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  it('knows nothing of an unheard-of organization: not eligible (fail closed)', async () => {
    expect(await eligible(org())).toBe(false);
  });

  it('makes a CONTRACTING-qualified organization eligible', async () => {
    const o = org();
    await handle(qualified(o, '2026-09-01T08:00:00.000Z'));
    expect(await eligible(o)).toBe(true);
  });

  it('ignores a qualification for another capability', async () => {
    const o = org();
    await handle(qualified(o, '2026-09-01T08:00:00.000Z', ['EQUIPMENT_RENTAL']));
    expect(await eligible(o)).toBe(false);
  });

  it('withholds eligibility while suspended and restores it on reinstatement', async () => {
    const o = org();
    await handle(qualified(o, '2026-09-01T08:00:00.000Z'));
    await handle(suspended(o, 's1', '2026-09-02T08:00:00.000Z'));
    expect(await eligible(o)).toBe(false);
    await handle(reinstated(o, 's1', '2026-09-03T08:00:00.000Z'));
    expect(await eligible(o)).toBe(true);
  });

  it('gives the same answer for a reinstatement that overtakes its suspension', async () => {
    const o = org();
    await handle(qualified(o, '2026-09-01T08:00:00.000Z'));
    await handle(reinstated(o, 's1', '2026-09-03T08:00:00.000Z'));
    await handle(suspended(o, 's1', '2026-09-02T08:00:00.000Z'));
    expect(await eligible(o)).toBe(true);
  });

  it('gives the same answer whatever the order of qualification and suspension', async () => {
    const o = org();
    await handle(suspended(o, 's1', '2026-09-02T08:00:00.000Z'));
    await handle(qualified(o, '2026-09-01T08:00:00.000Z'));
    expect(await eligible(o)).toBe(false);
  });

  it('converges under replay: the same events again change nothing', async () => {
    const o = org();
    const events = [
      qualified(o, '2026-09-01T08:00:00.000Z'),
      suspended(o, 's1', '2026-09-02T08:00:00.000Z'),
      reinstated(o, 's1', '2026-09-03T08:00:00.000Z'),
      suspended(o, 's2', '2026-09-04T08:00:00.000Z'),
    ];
    for (let round = 0; round < 3; round += 1) {
      for (const e of events) await handle(e);
    }
    expect(await eligible(o)).toBe(false);
    await handle(reinstated(o, 's2', '2026-09-05T08:00:00.000Z'));
    await handle(events[1]!);
    expect(await eligible(o)).toBe(true);
  });

  it('never moves a qualification back to an older decision', async () => {
    const o = org();
    await handle(qualified(o, '2026-09-10T08:00:00.000Z'));
    await handle(qualified(o, '2026-09-01T08:00:00.000Z'));
    const rows = await runUnscoped('the suite reads what it wrote', () =>
      w.prisma.client.contractorStanding.findMany({ where: { organizationId: o } }),
    );
    expect(rows.map((row) => row.contractingQualifiedAt?.toISOString())).toEqual([
      '2026-09-10T08:00:00.000Z',
    ]);
  });

  it('stays suspended while any one episode is open', async () => {
    const o = org();
    await handle(qualified(o, '2026-09-01T08:00:00.000Z'));
    await handle(suspended(o, 's1', '2026-09-02T08:00:00.000Z'));
    await handle(suspended(o, 's2', '2026-09-03T08:00:00.000Z'));
    await handle(reinstated(o, 's1', '2026-09-04T08:00:00.000Z'));
    expect(await eligible(o)).toBe(false);
  });

  it('refuses an episode id that belongs to another organization', async () => {
    const a = org();
    const b = org();
    await handle(suspended(a, 'shared-1', '2026-09-02T08:00:00.000Z'));
    await expect(
      handle(suspended(b, 'shared-1', '2026-09-02T08:00:00.000Z')),
    ).rejects.toBeInstanceOf(UnprocessableEventError);
    await expect(
      handle(reinstated(b, 'shared-1', '2026-09-03T08:00:00.000Z')),
    ).rejects.toBeInstanceOf(UnprocessableEventError);
  });

  it('refuses a lift dated before the start it closes', async () => {
    const o = org();
    await handle(suspended(o, 's1', '2026-09-05T08:00:00.000Z'));
    await expect(handle(reinstated(o, 's1', '2026-09-01T08:00:00.000Z'))).rejects.toBeInstanceOf(
      UnprocessableEventError,
    );
  });

  it('keeps one organization’s standing from another’s', async () => {
    const a = org();
    const b = org();
    await handle(qualified(a, '2026-09-01T08:00:00.000Z'));
    await handle(qualified(b, '2026-09-01T08:00:00.000Z'));
    await handle(suspended(a, 's-a', '2026-09-02T08:00:00.000Z'));
    expect(await eligible(a)).toBe(false);
    expect(await eligible(b)).toBe(true);
  });

  it('skips events it does not fold, and dead-letters unusable ones', async () => {
    const o = org();
    expect(await handle(event('SUPPLIER_REGISTERED', o, {}))).toBe('SKIPPED');
    await expect(
      handle(event('SUPPLIER_QUALIFIED', o, { qualifiedFor: ['CONTRACTING'] })),
    ).rejects.toBeInstanceOf(UnprocessableEventError);
    expect(await eligible(o)).toBe(false);
  });

  it('is refused by the database when the keys are blank', async () => {
    await expect(
      runUnscoped('the suite proves the constraint', () =>
        w.prisma.client.$executeRawUnsafe(
          `INSERT INTO contractor_standing (organization_id, updated_at) VALUES (' ', now())`,
        ),
      ),
    ).rejects.toThrow(/ck_standing_org_not_blank/);
  });
});
