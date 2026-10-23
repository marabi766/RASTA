import { eventEnvelopeSchema } from '@rasta/contracts';
import {
  activatePublicationPolicy,
  approvedProject,
  asAdmin,
  cleanup,
  newOrganizationId,
  outboxFor,
  publishApproved,
  wire,
  type Wiring,
} from './helpers';
import type { ThresholdPolicy } from '../src/tender/procurement-thresholds';

const DAY = 86_400_000;
const range = { minAmountMinor: '10', maxAmountMinor: '20', mode: 'REJECT' as const };
const policy: ThresholdPolicy = {
  id: 'POL-task801',
  value: {
    FORMAL_TENDER: range,
    INQUIRY: { ...range, mode: 'WARN' },
    RFP: range,
    MARKETPLACE_DEAL: range,
  },
};

describe('procurement amount thresholds at publication', () => {
  let w: Wiring;
  const organizations: string[] = [];
  beforeAll(() => {
    w = wire();
  });
  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  async function draft(
    amount: string | undefined = '21',
    nature: 'FORMAL_TENDER' | 'INQUIRY' = 'FORMAL_TENDER',
  ) {
    const organizationId = newOrganizationId();
    organizations.push(organizationId);
    const project = await approvedProject(w, organizationId);
    await activatePublicationPolicy(w, organizationId);
    const tender = await asAdmin(organizationId, () =>
      w.tenders.create(project.id, {
        title: 'Threshold test',
        scopeOfWork: 'Owner-entered manual procurement nature',
        procurementNature: nature,
        ...(amount === undefined ? {} : { estimatedCostMinor: amount }),
        visibility: 'PUBLIC',
        bidOpeningAt: new Date(Date.now() + DAY).toISOString(),
        bidClosingAt: new Date(Date.now() + 30 * DAY).toISOString(),
      }),
    );
    const criteria = await asAdmin(organizationId, () =>
      w.criteria.setCriteria(tender.id, {
        expectedVersion: tender.version,
        criteria: [
          {
            code: 'PRICE',
            label: 'Price',
            weightBp: 10000,
            scoringMethod: 'MANUAL_SCORE',
            maxScore: 100,
          },
        ],
      }),
    );
    return { organizationId, tender, version: criteria.version };
  }

  beforeEach(() => {
    w.thresholds.get = async () => policy;
  });

  it('rejects outside the range before opening an approval round and audits the closed reason', async () => {
    const { organizationId, tender, version } = await draft();
    await expect(
      asAdmin(organizationId, () => w.publication.publish(tender.id, { expectedVersion: version })),
    ).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
      details: [{ path: 'publication', code: 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE' }],
    });
    const read = await asAdmin(organizationId, () => w.tenders.get(tender.id));
    expect(read.status).toBe('DRAFT');
    expect(read.version).toBe(version);
    const events = await outboxFor(w.prisma, organizationId);
    expect(events.some((event) => event.eventName === 'TENDER_PUBLISHED')).toBe(false);
    expect(
      events
        .filter((event) => event.eventName === 'TENDER_APPROVAL_ACTION')
        .map((event) => eventEnvelopeSchema.parse(event.payload).payload),
    ).toContainEqual(
      expect.objectContaining({
        outcome: 'REFUSED',
        refusalCode: 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE',
      }),
    );
  });

  it('publishes WARN, returns and retains the warning, and audits the policy id and warning', async () => {
    const { organizationId, tender, version } = await draft('21', 'INQUIRY');
    const published = await asAdmin(organizationId, () =>
      publishApproved(w, tender.id, { expectedVersion: version }),
    );
    expect(published).toMatchObject({
      status: 'PUBLISHED',
      procurementNature: 'INQUIRY',
      estimatedCostMinor: '21',
      procurementThresholdWarning: 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE',
    });
    w.thresholds.get = async () => null;
    expect(await asAdmin(organizationId, () => w.tenders.get(tender.id))).toMatchObject({
      procurementThresholdWarning: 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE',
    });
    const event = (await outboxFor(w.prisma, organizationId)).find(
      (row) => row.eventName === 'TENDER_PUBLISHED',
    )!;
    expect(eventEnvelopeSchema.parse(event.payload).payload).toMatchObject({
      procurementThresholdPolicyId: policy.id,
      procurementThresholdWarning: 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE',
    });
  });

  it('preserves no-table publication, including an absent estimate', async () => {
    w.thresholds.get = async () => null;
    const { organizationId, tender, version } = await draft();
    const updated = await asAdmin(organizationId, () =>
      w.tenders.update(tender.id, { expectedVersion: version, estimatedCostMinor: null }),
    );
    const result = await asAdmin(organizationId, () =>
      publishApproved(w, tender.id, { expectedVersion: updated.version }),
    );
    expect(result.status).toBe('PUBLISHED');
    expect(result).not.toHaveProperty('procurementThresholdWarning');
  });

  it.each(['10', '20', '15'])('accepts inclusive boundary/interior %s', async (amount) => {
    const { organizationId, tender, version } = await draft(amount);
    const result = await asAdmin(organizationId, () =>
      publishApproved(w, tender.id, { expectedVersion: version }),
    );
    expect(result.status).toBe('PUBLISHED');
    expect(result).not.toHaveProperty('procurementThresholdWarning');
  });

  it('rejects missing estimates with a configured table', async () => {
    const { organizationId, tender, version } = await draft();
    const updated = await asAdmin(organizationId, () =>
      w.tenders.update(tender.id, { expectedVersion: version, estimatedCostMinor: null }),
    );
    await expect(
      asAdmin(organizationId, () =>
        w.publication.publish(tender.id, { expectedVersion: updated.version }),
      ),
    ).rejects.toMatchObject({ details: [{ code: 'PROCUREMENT_ESTIMATE_REQUIRED' }] });
  });

  it('rechecks a changed draft nature and refuses estimate/nature edits after publication', async () => {
    const { organizationId, tender, version } = await draft('21', 'INQUIRY');
    const changed = await asAdmin(organizationId, () =>
      w.tenders.update(tender.id, { expectedVersion: version, procurementNature: 'FORMAL_TENDER' }),
    );
    await expect(
      asAdmin(organizationId, () =>
        w.publication.publish(tender.id, { expectedVersion: changed.version }),
      ),
    ).rejects.toMatchObject({ details: [{ code: 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE' }] });
    const restored = await asAdmin(organizationId, () =>
      w.tenders.update(tender.id, {
        expectedVersion: changed.version,
        procurementNature: 'INQUIRY',
      }),
    );
    const result = await asAdmin(organizationId, () =>
      publishApproved(w, tender.id, { expectedVersion: restored.version }),
    );
    for (const update of [
      { procurementNature: 'FORMAL_TENDER' as const },
      { estimatedCostMinor: '10' },
    ]) {
      await expect(
        asAdmin(organizationId, () =>
          w.tenders.update(tender.id, { expectedVersion: result.version, ...update }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    }
    await expect(
      asAdmin(
        organizationId,
        async () =>
          await w.prisma.client.tender.updateMany({
            where: { organizationId, id: tender.id },
            data: { estimatedCostMinor: 10n },
          }),
      ),
    ).rejects.toThrow('ck_tender_procurement_frozen');
  });

  it('rechecks policy changes between approval request and execution', async () => {
    const { organizationId, tender, version } = await draft('20');
    // publishApproved obtains an approval, then invokes publication: switch the table before that execution.
    let reads = 0;
    w.thresholds.get = async () => {
      reads += 1;
      return reads === 1
        ? policy
        : {
            ...policy,
            value: { ...policy.value, FORMAL_TENDER: { ...range, maxAmountMinor: '19' } },
          };
    };
    await expect(
      asAdmin(organizationId, () => publishApproved(w, tender.id, { expectedVersion: version })),
    ).rejects.toMatchObject({ details: [{ code: 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE' }] });
    expect((await asAdmin(organizationId, () => w.tenders.get(tender.id))).status).toBe('DRAFT');
  });

  it('does not disclose or read policies for another tenant tender', async () => {
    const { tender, version } = await draft('20');
    const other = newOrganizationId();
    const get = jest.spyOn(w.thresholds, 'get');
    await expect(
      asAdmin(other, () => w.publication.publish(tender.id, { expectedVersion: version })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });
});
