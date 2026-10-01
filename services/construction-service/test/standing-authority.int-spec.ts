import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { StandingAuthority, verdictOf } from '../src/tender/standing-authority';
import type {
  StandingOfOrganization,
  StandingOfSource,
} from '../src/tender/supplier-snapshot.client';
import {
  FakeSnapshot,
  bootstrapOf,
  cleanup,
  forgetBootstrap,
  loadStanding,
  newOrganizationId,
  wire,
  type Wiring,
} from './helpers';

/**
 * Eligibility to bid is decided from supplier-service's own record at the moment of
 * the bid, never from the read model (`StandingAuthority`, Codex on #170): the read
 * model is advisory because it is wrong in exactly the two ways below.
 */

const T = (iso: string) => iso;

/** What supplier-service would answer, set per organization by the test. */
class FakeOwner implements StandingOfSource {
  readonly asked: string[] = [];
  readonly standings = new Map<string, Omit<StandingOfOrganization, 'asOf' | 'organizationId'>>();
  failure: Error | undefined;
  /** Answers about this organization instead of the one asked (a broken source). */
  answersFor: string | undefined;

  async fetchStanding(organizationId: string): Promise<StandingOfOrganization> {
    this.asked.push(organizationId);
    if (this.failure) throw this.failure;
    const known = this.standings.get(organizationId);
    return {
      organizationId: this.answersFor ?? organizationId,
      contractingApprovedAt: known?.contractingApprovedAt ?? null,
      suspensions: known?.suspensions ?? [],
      asOf: T('2026-10-01T09:30:00.000Z'),
    };
  }
}

describe('verdictOf', () => {
  const approved = '2026-03-01T08:00:00.000Z';
  it.each([
    ['approved and no episode', approved, [], 'ELIGIBLE'],
    [
      'approved and every episode lifted',
      approved,
      [{ suspensionId: 's', suspendedAt: approved, reinstatedAt: approved }],
      'ELIGIBLE',
    ],
    [
      'approved with an open episode',
      approved,
      [{ suspensionId: 's', suspendedAt: approved, reinstatedAt: null }],
      'SUSPENDED',
    ],
    ['never approved', null, [], 'NOT_QUALIFIED'],
    [
      'never approved and suspended',
      null,
      [{ suspensionId: 's', suspendedAt: approved, reinstatedAt: null }],
      'SUSPENDED',
    ],
  ] as const)('%s → %s', (_label, contractingApprovedAt, suspensions, verdict) => {
    expect(verdictOf({ contractingApprovedAt, suspensions: [...suspensions] })).toBe(verdict);
  });
});

describe('a bid is decided from supplier-service, not from the read model', () => {
  let w: Wiring;
  const owner = new FakeOwner();
  const authority = new StandingAuthority(owner);
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  const live = (eventName: string, organizationId: string, payload: object): EventEnvelope =>
    eventEnvelopeSchema.parse({
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

  beforeAll(async () => {
    w = wire();
    await forgetBootstrap();
  });

  beforeEach(() => {
    owner.asked.length = 0;
    owner.standings.clear();
    owner.failure = undefined;
    owner.answersFor = undefined;
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await loadStanding(w);
    await w.close();
  });

  it('refuses a contractor the read model calls eligible when the owner says it is suspended: an outage longer than the log keeps', async () => {
    const o = org();
    // The read model was loaded long ago and the suspension happened while this
    // service was down for more than seven days: its event expired and was never seen.
    await bootstrapOf(
      w,
      new FakeSnapshot([
        {
          items: [
            {
              organizationId: o,
              contractingApprovedAt: '2026-01-01T00:00:00.000Z',
              suspensions: [],
            },
          ],
          snapshotAt: '2026-01-02T00:00:00.000Z',
        },
      ]),
    ).runOnce();
    expect(await w.standing.eligibility(o)).toBe('ELIGIBLE');

    owner.standings.set(o, {
      contractingApprovedAt: '2026-01-01T00:00:00.000Z',
      suspensions: [
        {
          suspensionId: 'SUS-EXPIRED',
          suspendedAt: '2026-02-01T00:00:00.000Z',
          reinstatedAt: null,
        },
      ],
    });

    // The advisory model still says eligible; the decision does not.
    expect(await w.standing.eligibility(o)).toBe('ELIGIBLE');
    expect(await authority.verdictFor(o)).toBe('SUSPENDED');
  });

  it('refuses a suspension committed in supplier-service but not yet relayed when the last page completed', async () => {
    const o = org();
    await forgetBootstrap();
    await bootstrapOf(
      w,
      new FakeSnapshot([
        {
          items: [
            {
              organizationId: o,
              contractingApprovedAt: '2026-01-01T00:00:00.000Z',
              suspensions: [],
            },
          ],
          snapshotAt: '2026-10-01T09:00:00.000Z',
        },
      ]),
    ).runOnce();

    // Committed after the page was read; the outbox has not delivered it yet.
    owner.standings.set(o, {
      contractingApprovedAt: '2026-01-01T00:00:00.000Z',
      suspensions: [
        {
          suspensionId: 'SUS-IN-FLIGHT',
          suspendedAt: '2026-10-01T09:00:05.000Z',
          reinstatedAt: null,
        },
      ],
    });
    expect(await w.standing.eligibility(o)).toBe('ELIGIBLE');
    expect(await authority.verdictFor(o)).toBe('SUSPENDED');

    // When the event finally arrives the advisory model catches up — and agrees.
    await w.supplierEvents.handle(
      live('SUPPLIER_SUSPENDED', o, {
        suspensionId: 'SUS-IN-FLIGHT',
        suspendedAt: '2026-10-01T09:00:05.000Z',
      }),
    );
    expect(await w.standing.eligibility(o)).toBe('SUSPENDED');
  });

  it('refuses everybody, with a 503, when supplier-service cannot say (fail closed)', async () => {
    const o = org();
    owner.failure = RastaError.upstreamUnavailable('supplier-service');
    await expect(authority.verdictFor(o)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });

    owner.failure = RastaError.upstreamTimeout('supplier-service', 5000);
    await expect(authority.verdictFor(o)).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });

  it('does not take an answer about another organization for this one', async () => {
    owner.answersFor = 'ORG-SOMEBODY-ELSE';
    await expect(authority.verdictFor(org())).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('does not consult the read model at all: an empty or unloaded one changes nothing', async () => {
    const eligible = org();
    const unknown = org();
    owner.standings.set(eligible, {
      contractingApprovedAt: '2026-01-01T00:00:00.000Z',
      suspensions: [],
    });
    await forgetBootstrap();

    // The read model is not loaded and has never heard of either organization…
    expect(await w.standing.eligibility(eligible)).toBe('STANDING_NOT_LOADED');
    // …and the decision is made all the same, from the owner.
    expect(await authority.verdictFor(eligible)).toBe('ELIGIBLE');
    expect(await authority.verdictFor(unknown)).toBe('NOT_QUALIFIED');
    expect(owner.asked).toEqual([eligible, unknown]);
  });

  it('is eligible again after a lift, and asks each time rather than remembering', async () => {
    const o = org();
    owner.standings.set(o, {
      contractingApprovedAt: '2026-01-01T00:00:00.000Z',
      suspensions: [
        { suspensionId: 'S1', suspendedAt: '2026-05-01T00:00:00.000Z', reinstatedAt: null },
      ],
    });
    expect(await authority.verdictFor(o)).toBe('SUSPENDED');

    owner.standings.set(o, {
      contractingApprovedAt: '2026-01-01T00:00:00.000Z',
      suspensions: [
        {
          suspensionId: 'S1',
          suspendedAt: '2026-05-01T00:00:00.000Z',
          reinstatedAt: '2026-05-02T00:00:00.000Z',
        },
      ],
    });
    expect(await authority.verdictFor(o)).toBe('ELIGIBLE');
    expect(owner.asked).toEqual([o, o]);
  });
});
