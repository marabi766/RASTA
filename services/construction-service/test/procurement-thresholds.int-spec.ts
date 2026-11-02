import { RastaError } from '@rasta/nest-common';
import { eventEnvelopeSchema } from '@rasta/contracts';
import {
  activatePublicationPolicy,
  approvedProject,
  asAdmin,
  asApprover,
  grantRequest,
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

  it('fails closed before confirming approval policy when the threshold provider is unavailable', async () => {
    const { organizationId, tender, version } = await draft();
    const confirm = jest.spyOn(w.gate, 'confirmPolicy');
    w.thresholds.get = async () => {
      throw RastaError.upstreamUnavailable('organization-service');
    };
    try {
      await expect(
        asAdmin(organizationId, () =>
          w.publication.publish(tender.id, { expectedVersion: version }),
        ),
      ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', status: 503 });
      expect(confirm).not.toHaveBeenCalled();
      expect(await asAdmin(organizationId, () => w.tenders.get(tender.id))).toMatchObject({
        status: 'DRAFT',
        version,
      });
      expect(
        await asAdmin(
          organizationId,
          async () =>
            await w.prisma.client.tenderApprovalRequest.count({
              where: { organizationId, tenderId: tender.id },
            }),
        ),
      ).toBe(0);
      const events = await outboxFor(w.prisma, organizationId);
      expect(events.some((event) => event.eventName === 'TENDER_PUBLISHED')).toBe(false);
      expect(
        events
          .filter((event) => event.eventName === 'TENDER_APPROVAL_ACTION')
          .map((event) => eventEnvelopeSchema.parse(event.payload).payload),
      ).toContainEqual(
        expect.objectContaining({ outcome: 'REFUSED', refusalCode: 'UPSTREAM_UNAVAILABLE' }),
      );
    } finally {
      confirm.mockRestore();
    }
  });

  it('audits the threshold refusal first when other publication rules also fail', async () => {
    const { organizationId, tender, version } = await draft();
    const changed = await asAdmin(organizationId, () =>
      w.tenders.update(tender.id, {
        expectedVersion: version,
        bidOpeningAt: null,
        bidClosingAt: null,
      }),
    );
    await expect(
      asAdmin(organizationId, () =>
        w.publication.publish(tender.id, { expectedVersion: changed.version }),
      ),
    ).rejects.toMatchObject({
      details: [
        expect.objectContaining({ code: 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE' }),
        expect.anything(),
      ],
    });
    const events = await outboxFor(w.prisma, organizationId);
    expect(
      events
        .filter((event) => event.eventName === 'TENDER_APPROVAL_ACTION')
        .map((event) => eventEnvelopeSchema.parse(event.payload).payload),
    ).toContainEqual(expect.objectContaining({ refusalCode: 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE' }));
  });

  it('ends WARN approval as stale when execution becomes PASS, retaining the original snapshot', async () => {
    const { organizationId, tender, version } = await draft('21', 'INQUIRY');
    const asked = await asAdmin(
      organizationId,
      () => w.publication.publish(tender.id, { expectedVersion: version }, 'task804-warning'),
      'USR-task804-requester',
    );
    if (asked.executed) throw new Error('expected approval request');
    expect(asked.request).toMatchObject({
      procurementThresholdWarning: 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE',
      procurementThresholdPolicyId: policy.id,
    });
    const detail = await asApprover(organizationId, () =>
      w.approvals.get(asked.request.steps[0]!.approvalId),
    );
    expect(detail.request).toMatchObject({
      procurementThresholdWarning: 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE',
      procurementThresholdPolicyId: policy.id,
    });
    await expect(
      asAdmin(
        organizationId,
        async () =>
          await w.prisma.client.tenderApprovalRequest.updateMany({
            where: { organizationId, id: asked.request.id },
            data: { procurementThresholdWarning: null },
          }),
      ),
    ).rejects.toThrow('ck_tender_approval_threshold_snapshot_immutable');
    await asAdmin(organizationId, () => grantRequest(w, asked.request));
    const changedPolicy = {
      ...policy,
      id: 'POL-task804-pass',
      value: { ...policy.value, INQUIRY: { ...range, maxAmountMinor: '30' } },
    };
    w.thresholds.get = async () => changedPolicy;
    const retry = await asAdmin(
      organizationId,
      () => w.publication.publish(tender.id, { expectedVersion: version }, 'task804-warning'),
      'USR-task804-requester',
    );
    expect(retry).toEqual(asked);
    await expect(
      asAdmin(organizationId, () => w.publication.publish(tender.id, { expectedVersion: version })),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('APPROVAL_STALE') });
    await expectUnpublished(organizationId, tender.id, version, asked.request.id);
    const next = await asAdmin(organizationId, () =>
      w.publication.publish(tender.id, { expectedVersion: version }),
    );
    if (next.executed) throw new Error('expected new approval request');
    expect(next.request.id).not.toBe(asked.request.id);
    expect(next.request).not.toHaveProperty('procurementThresholdWarning');
    expect(next.request.procurementThresholdPolicyId).toBe(changedPolicy.id);
    expect(
      (await asApprover(organizationId, () => w.approvals.get(asked.request.steps[0]!.approvalId)))
        .request,
    ).toMatchObject({
      procurementThresholdWarning: 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE',
      procurementThresholdPolicyId: policy.id,
    });
    await asAdmin(organizationId, () => grantRequest(w, next.request));
    const executed = await asAdmin(organizationId, () =>
      w.publication.publish(tender.id, { expectedVersion: version }),
    );
    if (!executed.executed) throw new Error('expected publication after new approval');
    expect(executed.result).not.toHaveProperty('procurementThresholdWarning');
    const row = await asAdmin(
      organizationId,
      async () =>
        await w.prisma.client.tender.findFirstOrThrow({ where: { organizationId, id: tender.id } }),
    );
    expect(row.procurementThresholdWarning).toBeNull();
    expect(row.procurementThresholdPolicyId).toBe(changedPolicy.id);
    const event = (await outboxFor(w.prisma, organizationId)).find(
      (event) => event.eventName === 'TENDER_PUBLISHED',
    )!;
    expect(eventEnvelopeSchema.parse(event.payload).payload).toMatchObject({
      procurementThresholdPolicyId: changedPolicy.id,
    });
    expect(eventEnvelopeSchema.parse(event.payload).payload).not.toHaveProperty(
      'procurementThresholdWarning',
    );
  });

  async function expectUnpublished(
    organizationId: string,
    tenderId: string,
    version: number,
    staleRequestId: string,
  ) {
    expect(await asAdmin(organizationId, () => w.tenders.get(tenderId))).toMatchObject({
      status: 'DRAFT',
      version,
    });
    expect(
      await asAdmin(
        organizationId,
        async () =>
          await w.prisma.client.tenderApprovalRequest.findFirstOrThrow({
            where: { organizationId, id: staleRequestId },
          }),
      ),
    ).toMatchObject({ endedReason: 'STALE', consumedAt: null });
    expect(
      (await outboxFor(w.prisma, organizationId)).filter(
        (event) => event.eventName === 'TENDER_PUBLISHED',
      ),
    ).toHaveLength(0);
    expect(
      await asAdmin(
        organizationId,
        async () => await w.prisma.client.tenderKey.count({ where: { organizationId, tenderId } }),
      ),
    ).toBe(0);
  }

  const transitions = [
    {
      name: 'PASS to WARN under the same policy id',
      before: {
        ...policy,
        value: { ...policy.value, INQUIRY: { ...range, maxAmountMinor: '30' } },
      },
      after: policy,
      // Isolates warning equality even if a provider returns changed contents under the same id.
    },
    { name: 'WARN(A) to WARN(B)', before: policy, after: { ...policy, id: 'POL-task805-B' } },
    { name: 'table configured after approval', before: null, after: policy },
  ];

  describe.each(transitions)('$name', ({ before, after }) => {
    it.each(['APPROVED', 'PENDING'] as const)(
      'invalidates a %s round without publishing and exposes the new snapshot',
      async (status) => {
        const { organizationId, tender, version } = await draft('21', 'INQUIRY');
        w.thresholds.get = async () => before;
        const asked = await asAdmin(organizationId, () =>
          w.publication.publish(tender.id, { expectedVersion: version }),
        );
        if (asked.executed) throw new Error('expected approval request');
        if (status === 'APPROVED') {
          await asAdmin(organizationId, () => grantRequest(w, asked.request));
        }
        w.thresholds.get = async () => after;
        if (status === 'APPROVED') {
          await expect(
            asAdmin(organizationId, () =>
              w.publication.publish(tender.id, { expectedVersion: version }),
            ),
          ).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining('APPROVAL_STALE'),
          });
        }
        const next = await asAdmin(organizationId, () =>
          w.publication.publish(tender.id, { expectedVersion: version }),
        );
        if (next.executed) throw new Error('expected replacement approval request');
        expect(next.request).toMatchObject({
          round: asked.request.round + 1,
          status: 'PENDING',
          procurementThresholdWarning: 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE',
          procurementThresholdPolicyId: after.id,
        });
        expect(next.request.id).not.toBe(asked.request.id);
        await expectUnpublished(organizationId, tender.id, version, asked.request.id);
        const repeat = await asAdmin(organizationId, () =>
          w.publication.publish(tender.id, { expectedVersion: version }),
        );
        expect(repeat).toEqual(next);
        await asAdmin(organizationId, () => grantRequest(w, next.request));
        const executed = await asAdmin(organizationId, () =>
          w.publication.publish(tender.id, { expectedVersion: version }),
        );
        expect(executed.executed).toBe(true);
      },
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
