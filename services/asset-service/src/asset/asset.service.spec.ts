import {
  RastaError,
  currentUnscopedReason,
  isUnscoped,
  runWithContext,
  type RequestContext,
} from '@rasta/nest-common';
import { AssetService } from './asset.service';
import type { AssetRepository } from './asset.repository';
import { ASSET_EVENTS } from './events';
import type { CreateAssetDto, TransferAssetDto } from './dto';

/**
 * Asset service behaviour, with the repository stubbed.
 *
 * The cases here are the ones where a mistake is a safety, security or
 * integrity defect rather than a cosmetic one: the invariant that an asset
 * cannot be commissioned without a complete dossier, the serial-number check
 * that must not leak another tenant's fleet, and the transfer that has to move
 * a machine's whole history with it.
 */

const DEH1 = 'ORG-DEH-0001';
const DEH2 = 'ORG-DEH-0002';
const ASSET_ID = 'AST_01JASSET0000000000000001';

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: 'CORR_1',
    requestId: 'REQ_1',
    organizationId: DEH1,
    userId: 'USR-SEED-DEHYARI-ADMIN',
    roles: ['FLEET_MANAGER'],
    authType: 'USER',
    startedAt: 0,
    ...overrides,
  };
}

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSET_ID,
    organizationId: DEH1,
    assetTag: 'D1-TRK-001',
    name: 'کامیون حمل زباله',
    type: 'GARBAGE_TRUCK',
    manufacturer: null,
    model: null,
    serialNumber: 'CHASSIS-1',
    manufactureYear: null,
    status: 'ACTIVE',
    commissionedAt: new Date(0),
    decommissionedAt: null,
    decommissionedReason: null,
    specifications: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    createdBy: 'SEED',
    updatedBy: 'SEED',
    version: 1,
    deletedAt: null,
    ...overrides,
  };
}

function policyRow(validTo: Date) {
  return {
    id: 'INS_1',
    policyNumber: 'POL-1',
    insurerName: 'بیمه نمونه',
    coverage: 'THIRD_PARTY',
    premiumMinor: 1000n,
    insuredValueMinor: null,
    validFrom: new Date(0),
    validTo,
    status: 'ACTIVE',
  };
}

interface Harness {
  service: AssetService;
  repository: jest.Mocked<AssetRepository>;
  enqueued: Array<{ eventName: string; payload: Record<string, unknown> }>;
  timeline: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
  tx: TxMock;
}

interface TxMock {
  assetTransfer: { create: jest.Mock };
  assetLocation: { updateMany: jest.Mock };
  assetDocumentRef: { updateMany: jest.Mock };
  assetTimelineEntry: { updateMany: jest.Mock };
}

function harness(overrides: Partial<Record<string, unknown>> = {}): Harness {
  const enqueued: Harness['enqueued'] = [];
  const timeline: Harness['timeline'] = [];
  const updates: Harness['updates'] = [];

  const tx = {
    asset: {
      create: jest.fn((args: { data: Record<string, unknown> }) => assetRow(args.data)),
      update: jest.fn((args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return assetRow(args.data);
      }),
    },
    assetTransfer: { create: jest.fn() },
    assetLocation: { create: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
    assetDocumentRef: { create: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
    assetTimelineEntry: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        timeline.push(args.data);
        return args.data;
      }),
      updateMany: jest.fn(),
    },
    processedEvent: { create: jest.fn() },
  };

  const repository = {
    client: {
      assetDocumentRef: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
      assetLocation: { findFirst: jest.fn(async () => null) },
    },
    transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    enqueueEvent: jest.fn(
      async (_tx: unknown, input: { eventName: string; payload: Record<string, unknown> }) => {
        enqueued.push({ eventName: input.eventName, payload: input.payload });
        return 'EVT_1';
      },
    ),
    findById: jest.fn(async () => assetRow()),
    findBySerialNumber: jest.fn(async () => null),
    findByAssetTag: jest.fn(async () => null),
    findActivePolicy: jest.fn(async () => null),
    findLatestInspection: jest.fn(async () => null),
    findOrganizationRef: jest.fn(async () => ({
      id: DEH2,
      name: 'دهیاری نمونه دو',
      status: 'ACTIVE',
    })),
    list: jest.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    listTimeline: jest.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    costSummary: jest.fn(async () => []),
    countTransfers: jest.fn(async () => 0),
    findNearby: jest.fn(async () => []),
    setLocationPoint: jest.fn(),
    readCoordinate: jest.fn(async () => null),
    ...overrides,
  } as unknown as jest.Mocked<AssetRepository>;

  return {
    service: new AssetService(repository),
    repository,
    enqueued,
    timeline,
    updates,
    tx: tx as unknown as TxMock,
  };
}

const run = <T>(fn: () => Promise<T>, ctx: Partial<RequestContext> = {}): Promise<T> =>
  runWithContext(context(ctx), fn);

const CREATE: CreateAssetDto = {
  name: 'لودر',
  type: 'LOADER',
  specifications: {},
};

describe('AssetService', () => {
  describe('registration', () => {
    it('registers an asset as REGISTERED, not ACTIVE', async () => {
      const h = harness();
      const created = await run(() => h.service.create(CREATE));

      // Registration is paperwork, not commissioning. An asset that went
      // straight to ACTIVE would be dispatchable before anyone checked whether
      // it is insured.
      expect(created.status).toBe('REGISTERED');
      expect(h.enqueued.map((e) => e.eventName)).toEqual([ASSET_EVENTS.ASSET_CREATED]);
    });

    it('scopes the new asset to the caller organization, not to a body field', async () => {
      const h = harness();
      await run(() => h.service.create(CREATE), { organizationId: DEH2 });

      expect(h.enqueued[0]?.payload.organizationId).toBe(DEH2);
    });

    it('refuses a serial number already registered anywhere on the platform', async () => {
      const h = harness({
        findBySerialNumber: jest.fn(async () => assetRow({ organizationId: DEH2 })),
      });

      await expect(
        run(() => h.service.create({ ...CREATE, serialNumber: 'CHASSIS-1' })),
      ).rejects.toThrow(RastaError);
    });

    it('does not disclose which organization holds a clashing serial number', async () => {
      // A check that named the other tenant would let anyone enumerate another
      // dehyari's fleet by guessing chassis numbers.
      const h = harness({
        findBySerialNumber: jest.fn(async () => assetRow({ organizationId: DEH2 })),
      });

      const error = await run(() =>
        h.service.create({ ...CREATE, serialNumber: 'CHASSIS-1' }).catch((e: RastaError) => e),
      );

      expect(JSON.stringify(error)).not.toContain(DEH2);
    });

    it('allows two organizations to use the same asset tag', async () => {
      // Tags are what humans call a machine — "۱۲" in two villages is not a
      // clash, and treating it as one would make the field unusable.
      const h = harness({ findByAssetTag: jest.fn(async () => null) });
      await expect(
        run(() => h.service.create({ ...CREATE, assetTag: '12' })),
      ).resolves.toBeTruthy();
      expect(h.repository.findByAssetTag).toHaveBeenCalledWith(DEH1, '12');
    });
  });

  describe('activation — the dossier invariant', () => {
    const registered = () => assetRow({ status: 'REGISTERED' });

    it('refuses to activate an asset with no insurance', async () => {
      const h = harness({ findById: jest.fn(async () => registered()) });

      await expect(run(() => h.service.activate(ASSET_ID, {}))).rejects.toThrow(
        /insurance policy currently in force/,
      );
    });

    it('names everything that is missing, not just the first thing', async () => {
      const h = harness({ findById: jest.fn(async () => registered()) });

      const error = (await run(() =>
        h.service.activate(ASSET_ID, {}).catch((e: RastaError) => e),
      )) as RastaError;

      // An operator who fixes one blocker should not have to retry to discover
      // the next.
      expect(error.message).toContain('insurance');
      expect(error.message).toContain('ownership title');
    });

    it('activates once insurance and an ownership document are on file', async () => {
      const h = harness({
        findById: jest.fn(async () => registered()),
        findActivePolicy: jest.fn(async () => policyRow(new Date(Date.now() + 86_400_000))),
      });
      (h.repository.client.assetDocumentRef.findFirst as jest.Mock).mockResolvedValue({
        id: 'DOC_1',
        kind: 'OWNERSHIP_TITLE',
      });

      const result = await run(() => h.service.activate(ASSET_ID, {}));

      expect(result.status).toBe('ACTIVE');
      expect(h.enqueued.map((e) => e.eventName)).toContain(ASSET_EVENTS.ASSET_ACTIVATED);
    });

    it('refuses to activate an asset that is already active', async () => {
      const h = harness({ findById: jest.fn(async () => assetRow({ status: 'ACTIVE' })) });
      await expect(run(() => h.service.activate(ASSET_ID, {}))).rejects.toThrow(RastaError);
    });
  });

  describe('status changes', () => {
    it('refuses a transition a user does not own', async () => {
      const h = harness();
      await expect(
        run(() => h.service.changeStatus(ASSET_ID, { status: 'ASSIGNED', reason: 'دستی' })),
      ).rejects.toThrow(/not done directly/);
    });

    it('accepts the same transition when it arrives as an event', async () => {
      const h = harness();
      await run(() => h.service.applyEventStatusChange(ASSET_ID, 'ASSIGNED', 'from fleet'));

      expect(h.enqueued.map((e) => e.eventName)).toContain(ASSET_EVENTS.ASSET_STATUS_CHANGED);
    });

    it('ignores an event proposing an illegal transition rather than failing', async () => {
      // A dead-lettered message over a race that resolves itself would create
      // triage work for no benefit.
      const h = harness({ findById: jest.fn(async () => assetRow({ status: 'DECOMMISSIONED' })) });

      await expect(
        run(() => h.service.applyEventStatusChange(ASSET_ID, 'ACTIVE', 'from maintenance')),
      ).resolves.toBeUndefined();
      expect(h.enqueued).toHaveLength(0);
    });

    it('ignores an event about an asset it has never seen', async () => {
      const h = harness({ findById: jest.fn(async () => null) });

      await expect(
        run(() => h.service.applyEventStatusChange('AST_UNKNOWN', 'ASSIGNED', 'x')),
      ).resolves.toBeUndefined();
    });

    it('records every status change on the timeline', async () => {
      const h = harness();
      await run(() => h.service.changeStatus(ASSET_ID, { status: 'IDLE', reason: 'فصل غیرکاری' }));

      expect(h.timeline.map((t) => t.category)).toContain('LIFECYCLE');
      expect(h.timeline.at(-1)?.description).toBe('فصل غیرکاری');
    });
  });

  describe('transfer of ownership', () => {
    const dto: TransferAssetDto = {
      toOrganizationId: DEH2,
      reason: 'واگذاری به دهیاری همجوار',
    };

    it('moves the tenant column without changing the identity', async () => {
      const h = harness();
      await run(() => h.service.transfer(ASSET_ID, dto));

      const update = h.updates.at(-1);
      expect(update?.organizationId).toBe(DEH2);
      // Same id, same row. A transfer that created a new asset would orphan
      // every maintenance and ledger record pointing at the old one.
      expect(update).not.toHaveProperty('id');
    });

    it('resets the asset to REGISTERED so the new owner re-commissions it', async () => {
      const h = harness();
      await run(() => h.service.transfer(ASSET_ID, dto));

      // The previous owner's insurance does not cover the new owner.
      expect(h.updates.at(-1)?.status).toBe('REGISTERED');
    });

    it('moves the whole history to the new owner', async () => {
      const h = harness();
      await run(() => h.service.transfer(ASSET_ID, dto));

      // Timeline, locations and documents all follow the asset — otherwise the
      // new owner sees a machine with no past, and the old owner keeps rows
      // for a machine they no longer hold.
      const moved = { organizationId: DEH2 };
      expect(h.tx.assetTimelineEntry.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: moved }),
      );
      expect(h.tx.assetLocation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: moved }),
      );
      expect(h.tx.assetDocumentRef.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: moved }),
      );

      // All of it in one transaction: a partial move would split a machine's
      // history across two tenants.
      expect(h.repository.transaction).toHaveBeenCalledTimes(1);
      expect(h.enqueued.map((e) => e.eventName)).toContain(ASSET_EVENTS.ASSET_TRANSFERRED);
      expect(h.enqueued.at(-1)?.payload).toMatchObject({
        fromOrganizationId: DEH1,
        toOrganizationId: DEH2,
      });
    });

    it('declares the cross-tenant write instead of relying on implicit scoping', async () => {
      // The transfer writes rows owned by the *receiving* organization while
      // the caller acts for the sending one. The tenant guard refuses that by
      // default — correctly — so the crossing has to be declared, with a
      // reason, rather than worked around.
      const h = harness();
      let reasonInside: string | undefined;
      let unscopedInside = false;

      (h.repository.transaction as jest.Mock).mockImplementation(
        async (fn: (t: unknown) => Promise<unknown>) => {
          unscopedInside = isUnscoped();
          reasonInside = currentUnscopedReason();
          return fn(h.tx);
        },
      );

      await run(() => h.service.transfer(ASSET_ID, dto));

      expect(unscopedInside).toBe(true);
      expect(reasonInside).toContain(DEH1);
      expect(reasonInside).toContain(DEH2);
    });

    it('proves ownership under scoping before lifting it', async () => {
      // The order is what makes the escape hatch safe: the asset is fetched
      // scoped — so the caller has provably got it — and only then is scoping
      // lifted for the write.
      const h = harness();
      let scopedAtLookup = true;
      (h.repository.findById as jest.Mock).mockImplementation(async () => {
        scopedAtLookup = !isUnscoped();
        return assetRow();
      });

      await run(() => h.service.transfer(ASSET_ID, dto));

      expect(scopedAtLookup).toBe(true);
    });

    it('refuses a transfer to an organization that does not exist', async () => {
      const h = harness({ findOrganizationRef: jest.fn(async () => null) });
      await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toThrow(RastaError);
    });

    it('refuses a transfer to a suspended organization', async () => {
      const h = harness({
        findOrganizationRef: jest.fn(async () => ({ id: DEH2, name: 'x', status: 'SUSPENDED' })),
      });
      await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toThrow(/not active/);
    });

    it('refuses to transfer a decommissioned asset', async () => {
      const h = harness({ findById: jest.fn(async () => assetRow({ status: 'DECOMMISSIONED' })) });
      await expect(run(() => h.service.transfer(ASSET_ID, dto))).rejects.toThrow(RastaError);
    });

    it('refuses a transfer to the organization that already owns it', async () => {
      const h = harness();
      await expect(
        run(() => h.service.transfer(ASSET_ID, { ...dto, toOrganizationId: DEH1 })),
      ).rejects.toThrow(/already belongs/);
    });
  });

  describe('dossier compliance', () => {
    it('reports an asset with no insurance and no inspection as inoperable', async () => {
      const h = harness();
      const dossier = await run(() => h.service.dossier(ASSET_ID));

      expect(dossier.compliance.operable).toBe(false);
      expect(dossier.compliance.blockers).toEqual([
        'No insurance policy is currently in force',
        'No technical inspection on record',
      ]);
    });

    it('reports every blocker at once', async () => {
      const h = harness({ findById: jest.fn(async () => assetRow({ status: 'OUT_OF_SERVICE' })) });
      const dossier = await run(() => h.service.dossier(ASSET_ID));

      expect(dossier.compliance.blockers).toHaveLength(3);
    });

    it('treats a failed inspection as a blocker even when it has not expired', async () => {
      const h = harness({
        findActivePolicy: jest.fn(async () => policyRow(new Date(Date.now() + 86_400_000))),
        findLatestInspection: jest.fn(async () => ({
          id: 'INP_1',
          certificateNo: 'C-1',
          centerName: null,
          inspectedAt: new Date(0),
          validTo: new Date(Date.now() + 86_400_000),
          result: 'FAILED',
          notes: null,
        })),
      });

      const dossier = await run(() => h.service.dossier(ASSET_ID));
      expect(dossier.compliance.operable).toBe(false);
      expect(dossier.compliance.blockers).toContain('The most recent technical inspection failed');
    });

    it('reports a fully compliant asset as operable', async () => {
      const soon = new Date(Date.now() + 30 * 86_400_000);
      const h = harness({
        findActivePolicy: jest.fn(async () => policyRow(soon)),
        findLatestInspection: jest.fn(async () => ({
          id: 'INP_1',
          certificateNo: 'C-1',
          centerName: null,
          inspectedAt: new Date(0),
          validTo: soon,
          result: 'PASSED',
          notes: null,
        })),
      });

      const dossier = await run(() => h.service.dossier(ASSET_ID));
      expect(dossier.compliance.operable).toBe(true);
      expect(dossier.compliance.blockers).toEqual([]);
    });

    it('puts money on the wire as a string, never a number', async () => {
      const h = harness({
        findActivePolicy: jest.fn(async () => policyRow(new Date(Date.now() + 86_400_000))),
        costSummary: jest.fn(async () => [
          { category: 'MAINTENANCE', total_minor: '12500000', entry_count: 3 },
        ]),
      });

      const dossier = await run(() => h.service.dossier(ASSET_ID));

      // A rial amount past 2^53 silently loses precision as a JSON number
      // (ADR-022), so this is a correctness property, not a style preference.
      expect(typeof dossier.compliance.activeInsurance?.premiumMinor).toBe('string');
      expect(typeof dossier.costs.totalMinor).toBe('string');
      expect(dossier.costs.totalMinor).toBe('12500000');
    });

    it('raises 404 for an asset the caller cannot see', async () => {
      // The tenant guard turns a cross-tenant read into "not found" upstream of
      // this; the service must not soften it into a 403 that confirms the
      // asset exists somewhere.
      const h = harness({ findById: jest.fn(async () => null) });
      await expect(run(() => h.service.dossier(ASSET_ID))).rejects.toThrow(RastaError);
    });
  });

  describe('location', () => {
    it('passes the caller organization to the radius search explicitly', async () => {
      // Raw SQL is outside the Prisma tenant extension, so the scoping has to
      // be passed by hand — and omitting it would expose a neighbouring
      // dehyari's fleet.
      const h = harness();
      await run(() =>
        h.service.nearby({
          latitude: 31.85,
          longitude: 54.29,
          radiusMeters: 5000,
          limit: 20,
          availableOnly: true,
        }),
      );

      expect(h.repository.findNearby).toHaveBeenCalledWith(DEH1, expect.anything());
    });
  });
});
